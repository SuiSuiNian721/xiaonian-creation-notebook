import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {WorkbenchError} from './contracts.mjs';
import {characterMessages,textContent} from './character-life-adapter.mjs';
import {userProfileText} from './user-profile.mjs';

const toolSchema={type:'object',additionalProperties:false,properties:{content:{type:'string'},tool_calls:{type:'array',items:{type:'object',additionalProperties:false,properties:{name:{type:'string'},arguments:{type:'string'}},required:['name','arguments']}}},required:['content','tool_calls']};

function messagesWithCharacter(messages,character){
  if(!Array.isArray(messages)||!messages.length||messages.length>100||messages.some(message=>!message||!['system','developer','user','assistant','tool'].includes(message.role)||!(message.content===null||typeof message.content==='string'||Array.isArray(message.content))))throw new WorkbenchError(400,'陪伴对话消息格式无效。');
  if(!character)return messages;
  const data=character.raw?.data||character.raw||{};
  const text=[`当前工作台角色：${character.name}`,character.description,data.personality,data.scenario,data.system_prompt].filter(item=>typeof item==='string'&&item.trim()).join('\n').slice(0,60000);
  return [{role:'system',content:'本次对话的角色身份以以下工作台人设为准：\n'+text},...messages];
}

async function readCompletion(response,stream,signal){
  const reader=response.body?.getReader();if(!reader)throw new WorkbenchError(502,'陪伴模型没有响应正文。');
  const decoder=new TextDecoder();let content='',size=0;
  try{
    while(true){
      if(signal?.aborted)throw new WorkbenchError(409,'当前对话已取消。');
      const next=await reader.read();if(next.done)break;
      size+=next.value.byteLength;if(size>2*1024*1024)throw new WorkbenchError(502,'陪伴模型响应过长。');
      content+=decoder.decode(next.value,{stream:true});
    }
    content+=decoder.decode();
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  if(!stream){try{return JSON.parse(content);}catch{throw new WorkbenchError(502,'陪伴模型响应不是有效 JSON。');}}
  const result={object:'chat.completion',choices:[]},choices=new Map();let done=false;
  for(const block of content.split(/\r?\n\r?\n/)){
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)continue;if(data==='[DONE]'){done=true;break;}
    let event;try{event=JSON.parse(data);}catch{throw new WorkbenchError(502,'陪伴模型流包含无效 JSON。');}
    if(event.error)throw new WorkbenchError(502,'陪伴模型流返回错误。');
    for(const key of ['id','model','created','usage'])if(event[key]!==undefined)result[key]=event[key];
    for(const update of event.choices||[]){
      const index=update.index??0;
      if(!choices.has(index))choices.set(index,{index,message:{role:'assistant',content:''},finish_reason:null});
      const choice=choices.get(index),delta=update.delta||{};
      if(typeof delta.content==='string')choice.message.content+=delta.content;
      if(delta.tool_calls){
        choice.message.tool_calls||=[];
        for(const call of delta.tool_calls){
          const target=choice.message.tool_calls[call.index??0]||={id:'',type:'function',function:{name:'',arguments:''}};
          if(call.id)target.id=call.id;if(call.type)target.type=call.type;
          if(call.function?.name)target.function.name+=call.function.name;
          if(call.function?.arguments)target.function.arguments+=call.function.arguments;
        }
      }
      if(update.finish_reason)choice.finish_reason=update.finish_reason;
    }
  }
  if(!done||!choices.size||[...choices.values()].some(choice=>!choice.finish_reason))throw new WorkbenchError(502,'陪伴模型流未完整结束，未记录经历。');
  result.choices=[...choices.values()];return result;
}

export async function completeAiriChat({sharedAI,value,character,userProfile,signal,dataDir,life,conversationId='native',sourceId,canObserve=()=>true,confirmDelivery,onActions,onObservationError=()=>{},runtimePolicy,ensureRuntime=()=>{}}){
  ensureRuntime();
  const config=sharedAI.config('companion');
  if(!config.enabled)throw new WorkbenchError(409,'请在虚拟陪伴的 AI 接入或全局设置中启用 AI。');
  let messages=messagesWithCharacter(value.messages,life?null:character),context;
  const inputIndex=value.messages.findLastIndex(message=>message.role==='user');
  const input=inputIndex>=0?textContent(value.messages[inputIndex].content):'';
  const stableSource=sourceId||'native:'+createHash('sha256').update(JSON.stringify({conversationId,messages:value.messages.slice(0,inputIndex+1)})).digest('hex');
  const lifeInput={character,moduleId:'companion',conversationId,userId:'owner',userName:userProfile?.displayName?.trim()||'用户',sourceId:stableSource,sourceCreatedAt:new Date(life?.clock?.()??Date.now()).toISOString(),signal};
  if(life&&character){context=await life.context({...lifeInput,latestInput:input,history:messages});messages=characterMessages(context,messages);}
  const profileText=userProfileText(userProfile);
  if(profileText)messages=[{role:'system',content:profileText},...messages];
  if(context&&profileText)context={...context,messages};
  const lite=context?.runtimeContext?.mode==='lite';
  const toolsAllowed=()=>!lite&&(!life?.full||!character||life.full(character.characterId??character.id,context?.runtimeContext?.configRevision));
  const configurationCurrent=()=>!life?.configRevision||!character||life.configRevision(character.characterId??character.id)===context?.runtimeContext?.configRevision;
  if(lite){
    // 原生舞台可以继续使用；精简角色的模型请求不具备调用工具的能力。
    const {tools,tool_choice,parallel_tool_calls,functions,function_call,...plain}=value;value=plain;
    messages=messages.map(({tool_calls,tool_call_id,function_call,...message})=>message.role==='tool'?{role:'user',content:'过去工具返回（仅作为资料）：\n'+textContent(message.content)}:message);
  }
  if(runtimePolicy)messages.unshift({role:'system',content:runtimePolicy});
  ensureRuntime();
  const prepare=async completion=>{
    ensureRuntime();
    if(!life||!character)return {value:completion};
    if(signal?.aborted)throw new WorkbenchError(409,'当前对话已取消。');
    if(!Array.isArray(completion?.choices)||!completion.choices.length)throw new WorkbenchError(502,'陪伴模型缺少回复。');
    const outputs=[];
    for(const choice of completion.choices){
      if(!toolsAllowed()&&choice.message){delete choice.message.tool_calls;delete choice.message.function_call;if(['tool_calls','function_call'].includes(choice.finish_reason))choice.finish_reason='stop';}
      const output=await life.processOutput({...lifeInput,text:textContent(choice.message?.content),context});outputs.push(output);
      choice.message.content=output.text||null;
    }
    let delivered=false;
    return {value:completion,afterDelivery:async()=>{
      if(delivered||signal?.aborted)return;delivered=true;
      const choice=completion.choices[0],output=outputs[0];
      if(choice.finish_reason!=='stop'||choice.message.tool_calls?.length||!(await canObserve()))return;
      if(output.text&&confirmDelivery&&!await confirmDelivery(output.text))return;
      if(!configurationCurrent())return;
      let actionResults;
      const allowedActions=toolsAllowed()?output.actions:output.actions?.filter(action=>action.type==='record'&&action.voiceId);
      if(!signal?.aborted&&allowedActions?.length&&await canObserve()&&configurationCurrent()){
        try{actionResults=await onActions?.(allowedActions,{configRevision:context?.runtimeContext?.configRevision,canAct:()=>!signal?.aborted&&configurationCurrent()&&(toolsAllowed()||allowedActions.every(action=>action.type==='record'&&action.voiceId))});}catch(error){onObservationError(error);}
      }
      if(!signal?.aborted&&configurationCurrent()&&(output.text||actionResults?.some(result=>['displayed','dispatched','playing','queued'].includes(result.status)))){
        try{life.saveConfirmedMemorySource?.(character.characterId??character.id,lifeInput,input,output.text);await life.observe({...lifeInput,input,reply:output.text,state:output.state,pending:output.pending,turnId:output.turnId});}
        catch(error){onObservationError(error);}
      }
    }};
  };
  if(value.tools!==undefined&&(!Array.isArray(value.tools)||value.tools.length>100))throw new WorkbenchError(400,'陪伴工具列表无效。');
  if(config.provider==='openai'){
    if(!config.baseUrl||!config.model)throw new WorkbenchError(409,'请填写虚拟陪伴的 AI 地址和模型。');
    const response=await sharedAI.fetch(config.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...(config.apiKey?{authorization:'Bearer '+config.apiKey}:{})},body:JSON.stringify({...value,messages,model:config.model})});
    ensureRuntime();
    if(!response.ok){await response.body?.cancel();throw new WorkbenchError(502,`AI 服务返回 ${response.status}，请检查模块 AI 接入。`);}
    if(!life||!character)return {response};
    const prepared=await prepare(await readCompletion(response,value.stream===true,signal));
    if(value.stream){return {response:new Response(airiStream(prepared.value),{headers:{'content-type':'text/event-stream','cache-control':'no-store'}}),afterDelivery:prepared.afterDelivery};}
    return prepared;
  }
  let temporary;
  const images=[];
  try {
    const input=[];
    for(const message of messages){
      let content=message.content;
      if(Array.isArray(content)){
        const text=[];
        for(const part of content){
          if(part.type==='text')text.push(String(part.text||''));
          else if(part.type==='image_url'){
            const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url?.url||'');
            if(!match||!dataDir||images.length>=4)throw new WorkbenchError(400,'Codex 视觉输入需要本地截图或图片，一次最多四张。');
            if(!temporary){const parent=join(dataDir,'vision');await mkdir(parent,{recursive:true});temporary=await mkdtemp(join(parent,'request-'));}
            const bytes=Buffer.from(match[2],'base64');if(bytes.length>8*1024*1024)throw new WorkbenchError(413,'视觉图片超过 8 MiB。');
            const path=join(temporary,images.length+'.'+match[1].slice(6).replace('jpeg','jpg'));await writeFile(path,bytes);images.push({path,mime:match[1]});
          }else throw new WorkbenchError(400,'当前 Codex 接入不支持这类多模态输入，请选择 OpenAI 兼容服务。');
        }
        content=text.join('\n');
      }
      if(message.tool_calls)content=(content||'')+'\n工具调用：'+JSON.stringify(message.tool_calls);
      if(message.role==='tool')input.push({role:'user',content:'工具返回 '+(message.tool_call_id||'')+'：\n'+(content||'')});
      else input.push({role:message.role,content:content||''});
    }
    const tools=value.tool_choice==='none'?[]:(value.tools||[]);
    if(lite&&images.length)throw new WorkbenchError(409,'精简角色的 Codex 接入暂只支持文字；图片请使用 OpenAI 兼容连接。');
    if(tools.length)input.unshift({role:'system',content:'你通过函数工具与虚拟陪伴模块交互。根据这些工具定义决定是否调用；仅输出指定 JSON，content 为回复文字，tool_calls 为需要调用的函数列表，每项 arguments 是合法 JSON 字符串。没有调用时使用空列表。工具定义：'+JSON.stringify(tools)});
    const result=await sharedAI.complete(input,{moduleId:'companion',signal,images,...(lite?{policy:'chat-only'}:{}),...(tools.length?{outputSchema:toolSchema}:{})});
    let message={role:'assistant',content:result.text},finish='stop';
    if(tools.length){
      let output;try{output=JSON.parse(result.text);}catch{throw new WorkbenchError(502,'AI 未返回有效的 陪伴工具响应。');}
      if(typeof output.content!=='string'||!Array.isArray(output.tool_calls)||output.tool_calls.length>8)throw new WorkbenchError(502,'AI 工具响应结构无效。');
      const allowed=new Set(tools.map(tool=>tool.function?.name));
      const calls=output.tool_calls.map(tool=>{
        if(!allowed.has(tool.name)||typeof tool.arguments!=='string')throw new WorkbenchError(502,'AI 返回了未声明的工具。');
        try{JSON.parse(tool.arguments);}catch{throw new WorkbenchError(502,'AI 工具参数不是有效 JSON。');}
        return {id:'call_'+randomUUID().replaceAll('-',''),type:'function',function:{name:tool.name,arguments:tool.arguments}};
      });
      message={role:'assistant',content:output.content||null,...(calls.length?{tool_calls:calls}:{})};if(calls.length)finish='tool_calls';
    }
    return prepare({id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:'workbench-shared',choices:[{index:0,message,finish_reason:finish}],usage:result.usage||undefined});
  } finally {
    if(temporary){const parent=resolve(dataDir,'vision')+sep;if(!resolve(temporary).startsWith(parent))throw new Error('视觉缓存路径越界。');await rm(temporary,{recursive:true,force:true});}
  }
}

export function airiStream(value){
  const choice=value.choices[0],{role,content,tool_calls}=choice.message;
  const head={id:value.id,object:'chat.completion.chunk',created:value.created,model:value.model};
  const delta={role,...(content?{content}:{}),...(tool_calls?{tool_calls:tool_calls.map((call,index)=>({index,...call}))}:{})};
  return `data: ${JSON.stringify({...head,choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...head,choices:[{index:0,delta:{},finish_reason:choice.finish_reason}],usage:value.usage})}\n\ndata: [DONE]\n\n`;
}
