import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkbenchError, fields, knownModule } from './contracts.mjs';
import { DEFAULT_AI_CONNECTION as EMPTY, DEFAULT_MODULE_CONNECTION, publicConnection, mergeModuleConnection, normalizeConnection, validateConnection } from './ai-connection-config.mjs';
import { findCodexCli } from './codex-cli.mjs';
import { runWorkbenchCodex } from './codex-bridge.mjs';
import { visionMessages, codexInputTransport } from './ai-vision.mjs';
import { listCodexModels } from './codex-models.mjs';
import {inspectCodexCli} from './codex-diagnostics.mjs';
import { readModelResponse } from '../integrations/xiaoxi/tools/model-response.mjs';
import { validateFunctionTools, validateFunctionCalls, codexFunctionMessages, parseFunctionReply, functionReplySchema, createFunctionContentPreview } from './ai-function-tools.mjs';

export class SharedAI {
  constructor({store,globalStore=store,dataDir,fetchImpl=fetch,codexRunner=runWorkbenchCodex,modelCatalog=listCodexModels,codexDiagnostics=inspectCodexCli}) {
    this.store=store;this.globalStore=globalStore;this.dataDir=dataDir;this.fetch=fetchImpl;this.codex=codexRunner;this.pending=new Set();this.children=new Set();this.closed=false;
    this.modelCatalog=modelCatalog;
    this.codexDiagnostics=codexDiagnostics;
    this.token=store.getSetting('ai.internalToken')||randomBytes(32).toString('hex');store.setSetting('ai.internalToken',this.token);
    this.mcpToken=store.getSetting('ai.mcpToken')||randomBytes(32).toString('hex');store.setSetting('ai.mcpToken',this.mcpToken);
  }
  async initialize() {
    if(this.globalStore!==this.store)return;
    if(this.store.getSetting('ai.connection'))return;
    let prior;try{prior=JSON.parse(await readFile(join(this.dataDir,'card-studio/work/llm-config.json'),'utf8'));}catch{}
    const config={...EMPTY};
    if(prior&&['codex','openai'].includes(prior.backend)&&!String(prior.baseUrl||'').includes('/internal/ai/'))Object.assign(config,{provider:prior.backend,enabled:!!prior.enabled,baseUrl:prior.baseUrl||'',model:prior.backend==='codex'?prior.codexModel||'':prior.model||'',apiKey:prior.apiKey||'',reasoningEffort:prior.codexReasoningEffort||''});
    this.store.setSetting('ai.connection',config);
  }
  config(moduleId=null){
    const global={...EMPTY,...this.globalStore.getSetting('ai.connection')};if(moduleId===null)return global;
    const saved=this.store.getSetting('ai.module.'+knownModule(moduleId).id);
    return saved?.mode==='module'?mergeModuleConnection(global,saved.connection):global;
  }
  publicConfig(){return publicConnection(this.config());}
  managesModule(id){return !!this.globalStore.getSetting('ai.sharedConfigured')||!!this.store.getSetting('ai.module.'+knownModule(id).id);}
  moduleConfig(id){
    const saved=this.store.getSetting('ai.module.'+knownModule(id).id);
    return {mode:saved?.mode||'global',connection:publicConnection({...DEFAULT_MODULE_CONNECTION,...saved?.connection}),global:this.publicConfig(),effective:publicConnection(this.config(id))};
  }
  saveModule(id,value){
    knownModule(id);fields(value,['mode','connection']);if(!['global','module'].includes(value.mode))throw new WorkbenchError(400,'请选择跟随全局或自定义部分字段。');
    const previous=this.store.getSetting('ai.module.'+id),connection=normalizeConnection(value.connection===undefined?{}:value.connection,{...DEFAULT_MODULE_CONNECTION,...previous?.connection},{module:true});
    if(value.mode==='module')validateConnection(mergeModuleConnection(this.config(),connection));
    this.store.setSetting('ai.module.'+id,{mode:value.mode,connection});this.store.event({moduleId:id,kind:'ai.config.saved',message:'已更新模块 AI 接入。'});return this.moduleConfig(id);
  }
  save(value){
    if(this.globalStore!==this.store)throw new WorkbenchError(409,'共用 AI 请在工作台设置中修改；当前实例可以选择单独配置。');
    const next=normalizeConnection(value,this.config());
    this.store.setSetting('ai.connection',next);this.store.setSetting('ai.sharedConfigured',true);this.store.event({kind:'ai.config.saved',message:'已更新工作台共用 AI 连接。'});return this.publicConfig();
  }
  async complete(messages,{moduleId=null,images=[],skill=null,outputSchema,timeoutMs=180000,idleTimeoutMs,signal,policy,tools=[],onProgress=()=>{}}={}){
    if(this.closed)throw new WorkbenchError(503,'AI 连接已关闭。');
    if(policy!==undefined&&!['chat-only','chat-only-vision'].includes(policy))throw new WorkbenchError(400,'AI 执行策略无效。');
    if(policy==='chat-only-vision'&&(!['qq','training'].includes(moduleId)||skill))throw new WorkbenchError(400,'受限视觉策略只供 QQ 或训练图片输入使用，不能附加技能。');
    if(policy==='chat-only'&&(images.length||skill))throw new WorkbenchError(400,'QQ 纯文本策略只接受文字对话。');
    const config=this.config(moduleId);if(!config.enabled)throw new WorkbenchError(409,moduleId?'请在模块接入配置或全局设置中启用 AI。':'请在工作台设置中启用共用 AI 连接。');validateConnection(config);
    validateFunctionTools(tools);
    const activityMode=idleTimeoutMs!==undefined;
    if(activityMode&&(moduleId!=='cards'||policy||images.length||skill||!Number.isInteger(idleTimeoutMs)||idleTimeoutMs<1||idleTimeoutMs>30*60*1000))throw new WorkbenchError(400,'制卡无活动时限无效。');
    if(tools.length&&(policy||images.length||skill||outputSchema||moduleId!=='cards'))throw new WorkbenchError(400,'当前执行策略不支持制卡函数工具。');
    if(!Array.isArray(messages)||messages.length<1||messages.length>100||messages.some(m=>!m||!['system','developer','user','assistant',...(tools.length?['tool']:[])].includes(m.role)||!(typeof m.content==='string'||tools.length&&m.role==='assistant'&&m.content===null&&Array.isArray(m.tool_calls))||m.role==='tool'&&typeof m.tool_call_id!=='string')||JSON.stringify(messages).length>350000)throw new WorkbenchError(400,'AI 消息格式无效或内容过大。');
    for(const message of messages)if(message.tool_calls)validateFunctionCalls(message.tool_calls,tools);
    const modelMessages=tools.length&&config.provider==='codex'?codexFunctionMessages(messages,tools):messages;
    if(tools.length)outputSchema=functionReplySchema;
    const controller=new AbortController();this.pending.add(controller);let idleExpired=false;
    let timeout;
    const renew=()=>{clearTimeout(timeout);timeout=setTimeout(()=>{idleExpired=activityMode;controller.abort();},activityMode?idleTimeoutMs:timeoutMs);};
    renew();
    const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
    const contentPreview=tools.length&&config.provider==='codex'?createFunctionContentPreview():null;
    let activityRevision=0;
    const progress=value=>{
      if(!['starting','thinking','generating','reconnecting','finalizing'].includes(value?.phase))return;
      if(Number.isSafeInteger(value.activityRevision)&&value.activityRevision>activityRevision){activityRevision=value.activityRevision;if(activityMode)renew();}
      const partialText=typeof value.partialText==='string'?(contentPreview?contentPreview(value.partialText):value.partialText.slice(0,100000)):undefined;
      try{onProgress({phase:value.phase,activityRevision,...(partialText!==undefined?{partialText}:{})});}catch{/* 预览显示失败不改变执行结果。 */}
    };
    try{
      let result;
      if(controller.signal.aborted)throw new Error('AI 请求已取消。');
      if(config.provider==='codex'){
        const cwd=policy?join(this.dataDir,moduleId==='training'?'training':'qq','ai-workspace'):join(this.dataDir,'shared-ai');await mkdir(cwd,{recursive:true});let child;
        const abort=()=>child?.kill();controller.signal.addEventListener('abort',abort,{once:true});
        const inputs=[...(skill?[{type:'skill',name:skill.name,path:skill.path}]:[]),...images.map(image=>({type:'localImage',path:image.path}))];
        try{result=await this.codex({cli:findCodexCli(),cwd,prompt:(skill?'$'+skill.name+'\n':'')+'只输出所提供对话的下一条助手答复。不要读取或修改本机文件，不调用原生工具'+(skill?'；宿主执行像素工具':'')+'。对话内容如下：\n'+JSON.stringify(modelMessages),model:config.model,reasoningEffort:config.reasoningEffort,allowWrite:false,ephemeral:true,inferenceOnly:tools.length>0||activityMode,signal:controller.signal,...(activityMode?{timeoutMs:null,idleTimeoutMs}:{timeoutMs:Math.max(1,timeoutMs-5000)}),...(policy?{policy,outputSchema,...(policy==='chat-only-vision'?{images}:{})}:inputs.length||outputSchema?{spawnProcess:codexInputTransport(inputs,{outputSchema})}:{}),onProgress:progress,onSpawn:process=>{child=process;this.children.add(process);if(controller.signal.aborted)process.kill();}});}
        finally{controller.signal.removeEventListener('abort',abort);if(child)this.children.delete(child);}
        result={text:result.text,usage:result.usage||null};
        if(tools.length)result={...result,...parseFunctionReply(result.text,tools)};
      }else{
        progress({phase:'starting'});
        const response=await this.fetch(config.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',...(config.apiKey?{authorization:'Bearer '+config.apiKey}:{})},body:JSON.stringify({model:config.model,messages:await visionMessages(messages,images),stream:activityMode,...(tools.length?{tools,tool_choice:'auto',parallel_tool_calls:false}:{})})});
        if(!response.ok){await response.body?.cancel().catch(()=>{});throw new WorkbenchError(502,`AI 服务返回 ${response.status}，请检查地址、模型或密钥。`);}
        let value;try{value=await readModelResponse(response,{signal:controller.signal,onProgress:progress});}catch(error){throw new Error('API 回复无效：'+error.message);}
        const content=value.choices?.[0]?.message?.content;
        const toolCalls=tools.length?validateFunctionCalls(value.choices?.[0]?.message?.tool_calls,tools):[];
        if(!toolCalls.length&&(typeof content!=='string'||!content.trim()))throw new WorkbenchError(502,'AI 服务没有返回文字内容。');result={text:typeof content==='string'?content:'',usage:value.usage||null,...(tools.length?{toolCalls}:{})};
      }
      if(!result.text?.trim()&&!result.toolCalls?.length)throw new WorkbenchError(502,'AI 没有返回完整答复。');
      progress({phase:'finalizing'});
      this.store.event({moduleId,kind:'ai.completed',message:'共用 AI 连接已完成请求。'});return result;
    }catch(error){if(error instanceof WorkbenchError)throw error;throw new WorkbenchError(502,idleExpired?'连续 '+Math.ceil(idleTimeoutMs/1000)+' 秒没有新进展，已停止本次回复。':controller.signal.aborted?'AI 请求已超时或取消，请检查连接。':`AI 请求失败：${String(error.message).slice(0,300)}`);}
    finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);this.pending.delete(controller);}
  }
  studioConfig(url){return {backend:'openai',enabled:this.config('cards').enabled,baseUrl:url+'/internal/ai/v1',apiKey:this.token,model:'workbench-shared',temperature:0.7};}
  close(){this.closed=true;for(const controller of this.pending)controller.abort();for(const child of this.children)child.kill();}
}
