import { randomUUID } from 'node:crypto';
import { WorkbenchError, fields, text } from './contracts.mjs';
import {characterAvatar,userProfileText} from './user-profile.mjs';

const maxImageBytes=8*1024*1024;
function imageMime(bytes){
  if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR')return 'image/png';
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16)))return 'image/webp';
  if(bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
  return '';
}

export class LiteCompanion {
  constructor({store,sharedAI,life,packages,userProfile=()=>({}),baseUrl=()=>'',fetchImpl=fetch}){this.store=store;this.ai=sharedAI;this.life=life;this.packages=packages;this.userProfile=userProfile;this.baseUrl=baseUrl;this.fetch=fetchImpl;this.active=new Map();this.imageRequests=new Set();this.closed=false;this.unregisterMemoryHistory=this.life?.registerMemoryHistory?.('companion-lite',{sessions:(id,route)=>this.memoryHistorySessions(id,route)});}
  character(){const state=this.store.state();return state.characters.find(c=>c.id===state.selectedCharacterId)??null;}
  conversation(value='default'){return text(value,'会话标识',240);}
  voiceActions(actions,history=false){
    let base;try{base=new URL(this.baseUrl());}catch{}
    const prefix=base?.pathname.replace(/\/$/,'')??'';
    return (Array.isArray(actions)?actions:[]).flatMap(action=>{
      if(action?.type!=='record')return [action];
      if(!base||typeof action.url!=='string')return [];
      let url;try{url=new URL(action.url,base);}catch{return [];}
      const relative=action.url===url.pathname;
      const current=url.origin===base.origin;
      // Only old persisted records may reuse the same loopback host after its port changes.
      const previous=history&&base.protocol==='http:'&&url.protocol===base.protocol&&['127.0.0.1','[::1]'].includes(base.hostname)&&url.hostname===base.hostname;
      if((!relative&&action.url!==url.origin+url.pathname)||(!current&&!previous)||!url.pathname.startsWith(prefix+'/')||!/^\/internal\/voice-audio\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(url.pathname.slice(prefix.length)))return [];
      return [{...action,url:url.pathname}];
    });
  }
  imageSource(id,action){
    if(action?.type!=='image'||action.builtinMeme!==true||typeof action.memeId!=='string'||typeof action.url!=='string')return '';
    const known=action.memeId.startsWith('custom:')?this.life.config?.(id).media.memes.find(item=>'custom:'+item.id===action.memeId):this.life.memes?.resolve(action.memeId);
    if(!known||known.url!==action.url)return '';
    try{const url=new URL(action.url);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash?url.href:'';}catch{return '';}
  }
  displayActions(id,message){
    let prefix='';try{prefix=new URL(this.baseUrl()).pathname.replace(/\/$/,'');}catch{}
    return (Array.isArray(message.actions)?message.actions:[]).slice(0,8).flatMap((action,index)=>{
      if(action?.type==='record')return this.voiceActions([action],true);
      if(!this.imageSource(id,action)||!/^([a-f0-9-]{36}):reply$/.test(message.id??''))return [];
      return [{...action,url:`${prefix}/api/modules/companion-lite/images/${id}/${message.id.slice(0,-6)}/${index}`}];
    });
  }
  history(id,conversationId){return this.life.data.list(id,'lite-chat').filter(m=>m.scope===`companion-lite:${conversationId}`).reverse().slice(-100).map(message=>({...message,...(message.actions?{actions:this.displayActions(id,message)}:{})}));}
  async image(id,sourceId,index,signal){
    const source=()=>{
      this.packages.require('companion-lite');
      if(this.closed||this.character()?.id!==id||!Number.isInteger(index)||index<0||index>7||!/^[a-f0-9-]{36}$/.test(sourceId))throw new WorkbenchError(404,'找不到这张聊天图片。');
      const message=this.life.data.get(id,'lite-chat',sourceId+':reply');
      const url=message?.role==='assistant'&&message.scope?.startsWith('companion-lite:')?this.imageSource(id,message.actions?.[index]):'';
      if(!url)throw new WorkbenchError(404,'这张聊天图片已不可用。');return url;
    };
    const url=source(),controller=new AbortController(),combined=AbortSignal.any([controller.signal,AbortSignal.timeout(15000),...(signal?[signal]:[])]);
    combined.throwIfAborted();this.imageRequests.add(controller);
    try{
      const response=await this.fetch(url,{redirect:'error',signal:combined,headers:{accept:'image/png,image/jpeg,image/webp,image/gif'}});
      const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if(!response.ok||response.redirected||response.url&&response.url!==url||!['image/png','image/jpeg','image/webp','image/gif'].includes(mime)||Number(response.headers.get('content-length'))>maxImageBytes){await response.body?.cancel().catch(()=>{});throw new WorkbenchError(502,'图片服务未返回有效图片，或图片超过 8 MiB。');}
      const chunks=[];let length=0;
      for await(const chunk of response.body??[]){combined.throwIfAborted();length+=chunk.length;if(length>maxImageBytes)throw new WorkbenchError(502,'图片超过 8 MiB。');chunks.push(Buffer.from(chunk));}
      const bytes=Buffer.concat(chunks,length);combined.throwIfAborted();
      if(source()!==url||imageMime(bytes)!==mime)throw new WorkbenchError(502,'图片内容或来源已改变，请重新加载。');
      return {bytes,mime};
    }finally{controller.abort();this.imageRequests.delete(controller);}
  }
  memoryHistorySessions(id,route={}){
    if(this.closed||this.character()?.id!==id||!this.packages.ready('companion-lite'))return [];
    const messages=this.life.data.list(id,'lite-chat').reverse(),scopes=[...new Set(messages.map(m=>m.scope))];
    return scopes.filter(scope=>scope.startsWith('companion-lite:')&&(!route.conversationId||scope===`companion-lite:${route.conversationId}`)).map(scope=>{
      const conversationId=scope.slice('companion-lite:'.length),args={moduleId:'companion-lite',conversationId,userId:'owner',userName:this.userProfile().displayName||'本机对话者'};
      return {args,valid:()=>!this.closed&&this.character()?.id===id&&this.packages.ready('companion-lite'),read:()=>{
        const history=this.life.data.list(id,'lite-chat').filter(m=>m.scope===scope).reverse(),replies=new Map(history.filter(m=>m.role==='assistant').map(m=>[m.id,m]));
        return history.flatMap((message,index)=>message.role==='user'&&replies.has(message.id+':reply')?[{sourceId:message.id,sequence:index+1,scope,input:message.content,reply:replies.get(message.id+':reply').content,createdAt:message.sourceCreatedAt??message.createdAt,args}]:[]);
      }};
    });
  }
  state(conversation='default'){
    const conversationId=this.conversation(conversation),character=this.character();
    return {character:character?{id:character.id,name:character.name,avatar:characterAvatar(character)}:null,userProfile:this.userProfile(),conversationId,ready:!this.closed&&this.packages.ready('companion-lite'),effectiveMode:'lite',messages:character?this.history(character.id,conversationId):[]};
  }
  check(character,revision,signal){
    if(this.closed||signal?.aborted)throw new WorkbenchError(409,'精简陪伴请求已取消。');
    this.packages.require('companion-lite');
    const current=this.character();
    if(current?.id!==character.id||current.revision!==character.revision||this.life.configRevision(character.id)!==revision)throw new WorkbenchError(409,'角色或设置已改变，请重新发送。');
  }
  async chat(value,signal){
    fields(value,['text','conversationId']);this.packages.require('companion-lite');
    const input=text(value.text,'聊天内容',16000),conversationId=this.conversation(value.conversationId),character=this.character();
    if(!character)throw new WorkbenchError(409,'请先选择一个角色。');
    const key=character.id+':'+conversationId;if(this.active.has(key))throw new WorkbenchError(409,'请等待当前回复完成。');
    const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    this.active.set(key,controller);
    const revision=this.life.configRevision(character.id),sourceId=randomUUID(),scope=`companion-lite:${conversationId}`;
    const profile=this.userProfile(),profileText=userProfileText(profile);
    const args={character,moduleId:'companion-lite',conversationId,sourceId,sourceCreatedAt:new Date(this.life.clock?.()??Date.now()).toISOString(),userId:'owner',userName:profile.displayName?.trim()||'对话者',signal:controller.signal};
    try{
      this.check(character,revision,controller.signal);
      const history=this.history(character.id,conversationId).slice(-40).map(({role,content})=>({role,content}));history.push({role:'user',content:input});
      const context=await this.life.context({...args,latestInput:input,history});
      this.check(character,revision,controller.signal);
      const policy=this.packages.policy('companion-lite');
      if(policy?.forcedMode!=='lite')throw new WorkbenchError(409,'精简陪伴策略未通过校验。');
      const result=await this.ai.complete([{role:'system',content:policy.prompt},...(profileText?[{role:'system',content:profileText}]:[]),...context.messages],{moduleId:'companion-lite',policy:'chat-only',signal:controller.signal});
      this.check(character,revision,controller.signal);
      const output=await this.life.processOutput({...args,context,text:typeof result==='string'?result:result.text});
      this.check(character,revision,controller.signal);
      const actions=this.voiceActions(output.actions).filter(action=>action?.type==='record'||this.imageSource(character.id,action));
      const reply=text(output.text,'角色回复',100000,{empty:actions.length>0});
      this.life.data.transaction(()=>{
        this.life.data.put(character.id,'lite-chat',{id:sourceId,scope,role:'user',content:input,sourceCreatedAt:args.sourceCreatedAt});
        this.life.data.put(character.id,'lite-chat',{id:sourceId+':reply',scope,role:'assistant',content:reply,actions});
      });
      let observationError;
      try{await this.life.observe({...args,input,reply,turnId:output.turnId});}catch{observationError='回复已保存，记忆整理未完成。';}
      return {...this.state(conversationId),reply,actions:this.displayActions(character.id,{id:sourceId+':reply',actions}),...(observationError?{observationError}:{})};
    }finally{signal?.removeEventListener('abort',cancel);this.active.delete(key);}
  }
  cancel(){for(const controller of this.active.values())controller.abort();for(const controller of this.imageRequests)controller.abort();}
  close(){this.closed=true;this.cancel();this.unregisterMemoryHistory?.();}
}
