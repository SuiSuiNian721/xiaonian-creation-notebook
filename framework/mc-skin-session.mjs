import { randomUUID } from 'node:crypto';
import { WorkbenchError } from './contracts.mjs';
import { MinecraftBotSkin } from './mc-bot-skin.mjs';

const AUTO='mc-play.skin.autoApply';
const matches=(actual,expected)=>!!actual&&actual.hash===expected.hash&&(expected.hash===null||actual.model===expected.model&&actual.signed===true);

/** Owns one instance's skin operation and rejects results from a previous game session. */
export class MinecraftSkinSession {
  constructor({store,dataDir,connection,session,send,record,fetchImpl,timeoutMs=100000}) {
    this.store=store;this.connection=connection;this.session=session;this.send=send;this.record=record;this.timeoutMs=timeoutMs;
    this.resource=new MinecraftBotSkin({store,dataDir,fetchImpl});this.job=null;this.pending=null;
    this.application={status:'idle',message:''};this.observed=null;this.closed=false;
  }
  state(){return {...this.resource.state(),application:{...this.application},busy:!!this.job,autoApply:this.store.getSetting(AUTO)===true};}
  editable(){if(this.job)throw new WorkbenchError(409,'正在应用皮肤，请等待完成或断开世界后再修改。');}
  save(value){this.editable();this.resource.save(value);this.store.setSetting(AUTO,false);this.application={status:'idle',message:'皮肤已保存，尚未应用到世界。'};return this.state();}
  configure(value){
    this.editable();const before=this.resource.record()?.id;this.resource.configure(value);
    if(before!==this.resource.record()?.id){this.store.setSetting(AUTO,false);this.application={status:'idle',message:'体型已修改，需要重新应用。'};}
    return this.state();
  }
  valid(job){return !this.closed&&this.job===job&&!job.controller.signal.aborted&&this.session()?.id===job.sessionId&&this.connection().status==='connected'&&this.resource.record()?.id===job.imageId;}
  assertValid(job){if(!this.valid(job))throw new WorkbenchError(409,'皮肤或游戏连接已改变，旧操作已取消。');}
  startApply(){return this.start(false);}
  startReset(){return this.start(true);}
  start(reset) {
    this.editable();
    if(this.closed||this.connection().status!=='connected'||!this.session()?.id)throw new WorkbenchError(409,'请先连接 Minecraft 世界。');
    if(this.connection().skinProtocol!==1)throw new WorkbenchError(409,'当前 MC 运行端不支持皮肤应用，请更新 MC 陪玩组件并重新连接。');
    const image=this.resource.record();if(!reset&&!image)throw new WorkbenchError(409,'请先导入 Bot 的 PNG 皮肤。');
    const job={id:randomUUID(),sessionId:this.session().id,imageId:image?.id,controller:new AbortController(),reset};
    this.job=job;this.application={status:reset||image.texture?'applying':'generating',message:reset?'正在恢复默认皮肤…':'正在准备并应用皮肤…',mode:reset?'default':'custom'};
    job.promise=this.run(job).catch(error=>{
      if(this.job!==job)return;
      const message=error instanceof Error?error.message:'皮肤应用失败，请重试。';
      this.application={status:'error',message,mode:reset?'default':'custom'};this.record?.('error',message);
    }).finally(()=>{if(this.job===job)this.job=null;});
    return this.state();
  }
  async run(job) {
    const texture=job.reset?null:await this.resource.prepare({signal:job.controller.signal});this.assertValid(job);
    const expected=job.reset?{hash:null,model:'classic'}:{hash:texture.hash,model:texture.model};
    this.application={status:'applying',message:job.reset?'正在等待世界恢复默认皮肤…':'正在等待世界确认皮肤…',mode:job.reset?'default':'custom'};
    await new Promise((resolve,reject)=>{
      let timer;const abort=()=>finish(new WorkbenchError(409,'皮肤应用已取消。'));
      const finish=(error)=>{
        if(this.pending?.job!==job)return;
        this.pending=null;clearTimeout(timer);job.controller.signal.removeEventListener('abort',abort);if(error)reject(error);else resolve();
      };
      this.pending={job,expected,finish};job.controller.signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>finish(new WorkbenchError(504,'运行端尚未确认皮肤，请检查世界端 SkinRestorer 和网络后重试。')),this.timeoutMs);
      try {
        this.send({type:'skin',sessionId:job.sessionId,requestId:job.id,...(job.reset?{reset:true}:{texture:{url:texture.url,hash:texture.hash,model:texture.model}})},error=>{if(error)finish(new WorkbenchError(503,'无法发送皮肤应用请求，请重新连接世界。'));});
      }catch{finish(new WorkbenchError(503,'无法发送皮肤应用请求，请重新连接世界。'));}
    });
    this.assertValid(job);
    if(this.observed&&!matches(this.observed,expected))throw new WorkbenchError(409,'世界中的皮肤在确认期间发生变化，请重新应用。');
    this.store.setSetting(AUTO,!job.reset);
    this.application={status:'applied',message:job.reset?'世界已确认恢复默认皮肤。':'世界已同步这套皮肤。',mode:job.reset?'default':'custom',...expected,appliedAt:new Date().toISOString()};
    this.record?.('notice',this.application.message);
  }
  receive(message) {
    if(!['skin-result','skin-observed'].includes(message.type))return false;
    if(message.sessionId!==this.session()?.id||this.connection().status!=='connected')return true;
    if(message.type==='skin-result') {
      const pending=this.pending;if(!pending||pending.job.id!==message.requestId)return true;
      if(!message.ok)pending.finish(new WorkbenchError(409,String(message.error||'世界未能应用皮肤。').slice(0,1000)));
      else if(!matches(message.profile,pending.expected))pending.finish(new WorkbenchError(409,'世界返回的皮肤与当前选择不一致，请重新应用。'));
      else if(this.observed&&!matches(this.observed,pending.expected))pending.finish(new WorkbenchError(409,'世界中的皮肤在确认期间发生变化，请重新应用。'));
      else pending.finish();
    } else {
      this.observed=message.profile?{...message.profile}:null;
      if(['applied','changed'].includes(this.application.status)) {
        if(matches(message.profile,this.application))this.application={...this.application,status:'applied',message:this.application.mode==='default'?'世界已确认恢复默认皮肤。':'世界已同步这套皮肤。'};
        else this.application={...this.application,status:'changed',message:'游戏中的皮肤已改变，可重新应用当前选择。'};
      }
    }
    return true;
  }
  connected() {
    if(this.store.getSetting(AUTO)===true&&this.resource.record()?.texture) {
      try{this.startApply();}catch(error){this.application={status:'error',message:error.message};}
    }
  }
  disconnect() {
    const job=this.job;
    if(job){job.controller.abort();try{this.send({type:'skin-cancel',sessionId:job.sessionId,requestId:job.id},()=>{});}catch{}}
    this.job=null;this.observed=null;this.resource.invalidate();this.application={status:'idle',message:this.resource.record()?'皮肤已保存，连接世界后可应用。':''};
  }
  close(){this.disconnect();this.closed=true;this.resource.close();}
}
