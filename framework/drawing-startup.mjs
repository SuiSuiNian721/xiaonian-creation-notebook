import { setTimeout as delay } from 'node:timers/promises';

// Browser readiness follows the ComfyUI handshake, independently of the log window.
export class DrawingStartup {
  constructor({drawing, openBrowser, pollMs=1000, timeoutMs=5*60*1000}) {
    this.drawing=drawing;this.openBrowser=openBrowser;this.pollMs=pollMs;this.timeoutMs=timeoutMs;
    this.value={status:'idle',error:null};this.closed=false;
  }
  state(){return {...this.value};}
  start({owned=true,openBrowser=true}={}) {
    if(this.closed)return Promise.resolve(this.state());
    const revision=this.drawing.store.module('drawing').configRevision;
    const launch=this.drawing.runtime.launchRecord;
    const key=JSON.stringify([revision,launch?.pid,launch?.startedAt,openBrowser]);
    if(this.key===key){if(this.pending)return this.pending;if(['opened','ready'].includes(this.value.status))return Promise.resolve(this.state());}
    this.cancel();this.key=key;
    const controller=new AbortController();this.controller=controller;
    const url=this.drawing.config().serviceUrl;
    this.value={status:'waiting',error:null,url,openBrowser,startedAt:new Date().toISOString()};
    const current=()=>!this.closed&&!controller.signal.aborted&&!this.drawing.closed&&revision===this.drawing.store.module('drawing').configRevision;
    const job=this.run({controller,current,url,owned,openBrowser,launch:{pid:launch?.pid,startedAt:launch?.startedAt}}).finally(()=>{if(this.controller===controller)this.pending=null;});
    this.pending=job;return job;
  }
  async run({controller,current,url,owned,openBrowser,launch}) {
    const deadline=Date.now()+this.timeoutMs;
    const checkProcess=()=>{const record=this.drawing.runtime.launchRecord;if(owned&&(!['starting','running'].includes(record?.status)||record.pid!==launch.pid||record.startedAt!==launch.startedAt))throw new Error('ComfyUI 进程已退出、正在停止或已被另一轮启动替换，请查看日志。');};
    try {
      while(current()) {
        checkProcess();
        let ready=false;
        try{await this.drawing.connect();ready=true;}catch{if(!current())break;}
        if(!current())break;
        if(ready) {
          checkProcess();
          const opens=openBrowser&&typeof this.openBrowser==='function';
          try{if(opens)await this.openBrowser(url);}catch(error){throw new Error(`无法自动打开浏览器：${error.message} 请点击“打开 ComfyUI”重试。`);}
          if(current())this.value={...this.value,status:opens?'opened':'ready',readyAt:new Date().toISOString(),...(opens?{openedAt:new Date().toISOString()}:{})};
          return this.state();
        }
        if(Date.now()>=deadline)throw new Error('等待 ComfyUI 启动超时，请查看日志或稍后点击“打开 ComfyUI”。');
        await delay(this.pollMs,null,{signal:controller.signal});
      }
      if(this.controller===controller&&this.value.status==='waiting')this.value={...this.value,status:'cancelled'};
    } catch(error) {
      if(current())this.value={...this.value,status:'failed',error:error.message};
    }
    return this.state();
  }
  cancel(){this.controller?.abort();if(this.value.status==='waiting')this.value={...this.value,status:'cancelled'};}
  close(){this.closed=true;this.cancel();}
}
