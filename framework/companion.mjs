import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {WorkbenchError,fields} from './contracts.mjs';
import {inspectAiriInstall} from './companion-source.mjs';
import {completeAiriChat} from './companion-ai.mjs';
import {characterAvatar} from './user-profile.mjs';

const settingsRoutes=new Set(['/settings','/settings/airi-card','/settings/models','/settings/scene','/settings/memory','/settings/providers','/settings/connection','/settings/system','/settings/modules','/settings/modules/mcp','/settings/modules/vision','/settings/modules/hearing','/settings/modules/speech','/settings/modules/gaming-minecraft','/settings/modules/gaming-factorio','/settings/modules/artistry']);

export class Companion {
  constructor({store,dataDir,host,sharedAI,life,userProfile=()=>({}),packages=null,inspect=inspectAiriInstall}={}) {
    this.store=store;this.host=host;this.sharedAI=sharedAI;this.life=life;this.inspect=inspect;this.packages=packages;this.userProfile=userProfile;
    this.dataDir=join(resolve(dataDir),'companion');this.status='idle';this.error='';this.pending=null;this.closed=false;this.closing=null;
    this.token=randomBytes(32).toString('hex');this.requests=new Set();
    this.characterRevision=0;this.userProfileRevision=0;
    this.unregisterMemoryHistory=this.life?.registerMemoryHistory?.('companion',{sessions:(id,route)=>this.memoryHistorySessions(id,route)});
  }
  memoryHistorySessions(id,route={}){
    if(this.closed||this.status!=='running'||this.character()?.id!==id)return [];
    const scopes=[...new Set(this.life.data.list(id,'companion-chat').map(m=>m.scope))],revision=this.characterRevision;
    return scopes.filter(scope=>!route.conversationId||scope===`companion:${route.conversationId}`).map(scope=>{
      const args={moduleId:'companion',conversationId:scope.slice('companion:'.length),userId:'owner',userName:this.userProfile().displayName||'本机对话者'};
      return {args,valid:()=>!this.closed&&this.status==='running'&&this.characterRevision===revision&&this.character()?.id===id&&(!this.packages||this.packages.ready('companion')),read:()=>this.life.data.list(id,'companion-chat').filter(m=>m.scope===scope).sort((a,b)=>a.sequence-b.sequence).map(m=>({sourceId:m.sourceId,sequence:m.sequence,scope,input:m.input,reply:m.reply,createdAt:m.sourceCreatedAt??m.createdAt,args}))};
    });
  }
  state() {
    const install=this.source();
    const runtime=this.host?.state?.();
    if(runtime?.restartRequired&&this.status==='running'){this.status='stopped';this.error='陪伴运行端已退出，请关闭并重新打开工作台。';}
    const state=this.store.state();const character=state.characters.find(item=>item.id===state.selectedCharacterId);
    return {status:this.status,error:this.error,packagesReady:this.packages?.ready('companion')??true,desktopAvailable:!!this.host,source:{available:install.available,version:install.version,reason:install.reason||'',installPath:install.installPath||''},profilePath:this.dataDir,character:character?{id:character.id,name:character.name}:null,...(runtime?{runtime}: {})};
  }
  source(refresh=false){
    const path=this.store.module('companion')?.config?.airiPath||undefined;
    if(refresh||!this.install||this.installKey!==path){this.installKey=path;this.install=this.inspect(path);}
    return this.install;
  }
  character(){
    const state=this.store.state(),character=structuredClone(state.characters.find(item=>item.id===state.selectedCharacterId)||null);
    return character?{...character,avatar:characterAvatar(character)}:null;
  }
  async start(baseUrl) {
    this.packages?.require('companion');
    if(this.closed)throw new WorkbenchError(503,'虚拟陪伴运行端已关闭。');
    if(!this.host)throw new WorkbenchError(503,'请在桌面工作台中打开完整虚拟陪伴。');
    if(this.host.state?.().restartRequired)throw new WorkbenchError(409,'陪伴运行端已结束，请关闭并重新打开工作台。');
    if(this.status==='running')return this.state();
    if(this.pending)return this.pending;
    const install=this.source(true);
    if(!install.available)throw new WorkbenchError(503,install.reason);
    this.status='starting';this.error='';
    this.pending=(async()=>{
      try {
        await mkdir(this.dataDir,{recursive:true});
        await this.host.start({install,dataDir:this.dataDir,bootstrap:{baseUrl:baseUrl+'/internal/companion/ai/v1',token:this.token,model:'workbench-shared',theme:this.store.getSetting('preferences')?.theme||'light',character:this.character(),userProfile:this.userProfile()}});
        if(this.host.syncCharacter||this.host.syncUserProfile){
          let characterSynchronized,userProfileSynchronized;
          do{
            characterSynchronized=this.characterRevision;userProfileSynchronized=this.userProfileRevision;
            await this.host.syncCharacter?.(this.character());
            await this.host.syncUserProfile?.(this.userProfile());
          }while((characterSynchronized!==this.characterRevision||userProfileSynchronized!==this.userProfileRevision)&&!this.closed);
        }
        if(this.closed){await this.host.close();throw new WorkbenchError(503,'虚拟陪伴正在关闭。');}
        this.packages?.require('companion');
        this.status='running';this.store.event({moduleId:'companion',kind:'companion.started',message:'完整陪伴运行端已接入。'});
        const character=this.character();if(character)this.life?.organizeMemoryHistory?.(character.id,{moduleId:'companion'});
        return this.state();
      } catch(error){this.status='error';this.error=String(error.message).slice(0,500);throw new WorkbenchError(502,'陪伴启动失败：'+this.error);}
      finally{this.pending=null;}
    })();
    return this.pending;
  }
  viewport(value) {
    fields(value,['visible','x','y','width','height','theme']);
    if(typeof value.visible!=='boolean'||(value.theme!==undefined&&!['light','dark'].includes(value.theme))||(value.visible&&['x','y','width','height'].some(key=>!Number.isFinite(value[key])||value[key]<0||value[key]>10000)))throw new WorkbenchError(400,'陪伴视图的位置或大小无效。');
    this.host?.viewport?.(value);return {ok:true};
  }
  async open(value) {
    this.packages?.require('companion');
    fields(value,['view','route']);if(!['stage','chat','settings','editor','desktop'].includes(value.view))throw new WorkbenchError(400,'请选择有效的陪伴页面。');
    if(value.route!==undefined&&(value.view!=='settings'||!settingsRoutes.has(value.route)))throw new WorkbenchError(400,'请选择有效的陪伴设置页面。');
    if(this.status!=='running')throw new WorkbenchError(409,'请先启动虚拟陪伴。');
    await this.host.open(value.view,value.route);return this.state();
  }
  authorize(token) {
    const actual=Buffer.from(typeof token==='string'?token:'');const expected=Buffer.from(this.token);
    if(!this.store.module('companion').enabled||this.status!=='running'||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new WorkbenchError(403,'虚拟陪伴连接已关闭或令牌无效。');
    this.packages?.require('companion');
  }
  async request(token,callback,signal) {
    this.authorize(token);
    const controller=new AbortController();this.requests.add(controller);
    const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
    const timer=setTimeout(cancel,900000);
    try{
      await this.characterPending;
      if(controller.signal.aborted)throw new WorkbenchError(409,'当前对话已取消或角色已切换。');
      return await callback(controller.signal);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.requests.delete(controller);}
  }
  async complete(value,signal){
    this.packages?.require('companion');
    let character=this.character();
    const native=await this.host?.characterContext?.();
    if(native)character=native.managed?structuredClone(this.store.state().characters.find(item=>item.id===native.id)||null):null;
    const revision=this.characterRevision;
    const conversationId=native?.conversationId||'native:'+character?.id;
    const current=async()=>{
      if(this.packages&&!this.packages.ready('companion'))return false;
      if(signal?.aborted||this.closed||revision!==this.characterRevision)return false;
      const next=await this.host?.characterContext?.();
      return !native||!!next&&native.id===next.id&&native.conversationId===next.conversationId&&native.generation===next.generation&&native.sourceId===next.sourceId;
    };
    return completeAiriChat({sharedAI:this.sharedAI,value,character,userProfile:this.userProfile(),signal,dataDir:this.dataDir,life:this.life,conversationId,
      runtimePolicy:this.packages?.policy('companion-full')?.prompt,ensureRuntime:()=>this.packages?.require('companion'),
      sourceId:native?.sourceId?`${conversationId}:${native.sourceId}`:undefined,canObserve:current,
      confirmDelivery:this.host?.confirmReply?text=>this.host.confirmReply({characterId:character.id,conversationId,sourceId:native?.sourceId,generation:native?.generation,text}):undefined,
      onActions:(actions,guard)=>this.performActions({characterId:character.id,conversationId,sourceId:native?.sourceId,userSourceId:native?.sourceId,generation:native?.generation,actions,...guard}),
      onObservationError:()=>{this.error='回复已完成，角色整理或动作执行未完成。';}});
  }
  async performActions(value){
    const configRevision=value.configRevision??this.life?.configRevision?.(value.characterId),characterRevision=this.characterRevision,results=[];
    const canAct=action=>!this.closed&&characterRevision===this.characterRevision&&(!value.canAct||value.canAct())&&(!this.packages||this.packages.ready('companion'))&&(!this.life?.full||this.life.full(value.characterId,configRevision,{moduleId:'companion'})||(action?.type==='record'&&action.voiceId&&this.life.configRevision(value.characterId)===configRevision));
    for(const [index,action] of (value.actions||[]).entries()){
      if(!canAct(action))break;
      if(action.type==='help')this.life?.action?.(value.characterId,{kind:'help',moduleId:'companion',conversationId:value.conversationId,text:action.text,ownerId:action.ownerId,status:'pending'});
      else results.push(...(await this.host?.actions?.({...value,sourceId:`${value.sourceId}:action:${index}`,actions:[action]})??[]));
    }
    if(results?.some(result=>['failed','unavailable','unsupported'].includes(result.status)))this.error='回复已完成，部分媒体或形象动作当前不可用。';
    return results;
  }
  async deliver(value){
    const configRevision=this.life?.configRevision?.(value.characterId);
    const configurationCurrent=()=>!this.life?.configRevision||this.life.configRevision(value.characterId)===configRevision;
    const canAct=()=>!value.signal?.aborted&&configurationCurrent()&&(!this.life?.full||this.life.full(value.characterId,configRevision,{moduleId:'companion'}));
    if(this.packages&&!this.packages.ready('companion'))return {delivered:false,status:'skipped',reason:'companion-packages-unavailable'};
    if(this.closed||this.status!=='running'||!this.store.module('companion')?.enabled||value.signal?.aborted)return {delivered:false,status:'skipped',reason:'companion-inactive'};
    const native=await this.host?.characterContext?.();
    if(!native?.managed||native.id!==value.characterId||native.conversationId!==value.conversationId)return {delivered:false,status:'skipped',reason:'native-context-changed'};
    const character=this.store.state().characters.find(item=>item.id===native.id);
    if(value.characterRevision!==undefined&&value.characterRevision!==character?.revision)return {delivered:false,status:'skipped',reason:'character-version-changed'};
    if(!character||typeof value.sourceId!=='string'||!value.sourceId)return {delivered:false,status:'skipped',reason:'missing-character-or-source'};
    const input={character,moduleId:'companion',conversationId:value.conversationId,userId:'owner',sourceId:value.sourceId,signal:value.signal};
    const output=this.life?await this.life.processOutput({...input,text:value.text}):{text:value.text,actions:[]};
    if(value.signal?.aborted||value.canSend&&!value.canSend())return {delivered:false,status:'skipped',reason:'cancelled'};
    const result=await this.host.deliver({...value,signal:undefined,text:output.text});
    if(result.delivered){
      try{if(configurationCurrent())await this.life?.observe({...input,input:'',reply:output.text,synthetic:true,state:output.state,pending:output.pending,turnId:output.turnId});}catch{this.error='主动消息已送达，角色记忆整理未完成。';}
      const actions=[...(output.actions||[]),...(value.actions||[])];
      if(actions.length&&canAct()){try{await this.performActions({...value,signal:undefined,actions,configRevision,canAct});}catch{this.error='主动消息已送达，形象动作执行未完成。';}}
    }
    return result;
  }
  async syncCharacter(){
    this.characterRevision++;
    this.life?.cancelMemoryHistory?.({moduleId:'companion'});
    for(const controller of this.requests)controller.abort();
    if(this.status!=='running'||!this.host?.syncCharacter)return;
    const character=this.character();
    this.characterPending=(this.characterPending||Promise.resolve()).catch(()=>{}).then(()=>this.host.syncCharacter(character));
    await this.characterPending;
  }
  async syncUserProfile(){
    this.userProfileRevision++;
    if(this.status!=='running'||!this.host?.syncUserProfile)return;
    const profile=this.userProfile();
    this.userProfilePending=(this.userProfilePending||Promise.resolve()).catch(()=>{}).then(()=>this.host.syncUserProfile(profile));
    await this.userProfilePending;
  }
  hide() {
    this.host?.hideAll?.();
    this.host?.viewport?.({visible:false});for(const controller of this.requests)controller.abort();
  }
  close() {
    if(!this.closing)this.closing=(async()=>{this.closed=true;this.unregisterMemoryHistory?.();this.hide();await this.pending?.catch(()=>{});await this.host?.close();this.status='closed';})();
    return this.closing;
  }
}
