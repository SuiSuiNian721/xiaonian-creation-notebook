import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {WorkbenchError} from './contracts.mjs';
import {MinecraftBotCoordination} from './mc-bot-coordination.mjs';

const conflict=message=>new WorkbenchError(409,message);
const pathKey=value=>{if(!value)return '';try{return realpathSync.native(value).toLowerCase();}catch{return resolve(value).toLowerCase();}};
const serviceKey=value=>{try{const url=new URL(value);return url.protocol+'//'+(['localhost','127.0.0.1','[::1]'].includes(url.hostname)?'loopback':url.hostname)+':'+(url.port||({'http:':'80','https:':'443','ws:':'80','wss:':'443'}[url.protocol]))+url.pathname.replace(/\/$/,'');}catch{return '';}};
const activeJobs=drawing=>drawing.jobs().some(job=>['submitting','queued','running','unknown'].includes(job.status));
const sameEnvironment=(a,b)=>{const ac=a.drawing.config(),bc=b.drawing.config();return ac.comfyPath&&bc.comfyPath&&pathKey(ac.comfyPath)===pathKey(bc.comfyPath)||ac.serviceUrl&&bc.serviceUrl&&serviceKey(ac.serviceUrl)===serviceKey(bc.serviceUrl);};

/** Shared binaries may be reused; accounts, ports and destructive maintenance have explicit owners. */
export class InstanceCoordination {
  constructor(runtimes){this.runtimes=runtimes;this.pending=new Map();this.qqClaims=new Map();this.ports=new Map();this.minecraft=new MinecraftBotCoordination();}
  forInstance(id){return {run:(mode,work)=>this.run(id,mode,work),claimQQ:config=>this.claimQQ(id,config),releaseQQ:()=>this.releaseQQ(id),allocatePort:allocator=>this.allocatePort(id,allocator),claimMinecraft:(settings,sessionId)=>this.minecraft.claim(id,settings,sessionId)};}
  assertDrawing(id,mode){
    const own=this.runtimes.get(id)?.context;if(!own)return;
    if(mode!=='stop'&&(this.pending.get(id)||[]).includes('stop'))throw conflict('当前实例正在停止 ComfyUI，请等待服务退出。');
    for(const [otherId,runtime] of this.runtimes){if(otherId===id||!sameEnvironment(own,runtime.context))continue;const other=runtime.context,active=this.pending.get(otherId)||[];
      if(active.includes('stop'))throw conflict('另一个实例正在停止共享 ComfyUI，请等待服务退出。');
      const maintaining=active.includes('maintenance')||other.drawingManager.active||other.drawingManager.applying.size;
      if(maintaining)throw conflict('另一个实例正在维护同一 ComfyUI 环境，请等待维护完成。');
      if(mode==='maintenance'&&(active.length||activeJobs(other.drawing)||other.drawing.runtime.child||other.drawing.runtime.launchPromise))throw conflict('另一个实例仍在使用这个 ComfyUI 环境，无法同时维护。');
      if(mode==='stop'&&(active.includes('drawing')||activeJobs(other.drawing)))throw conflict('另一个实例正在绘图，请等待任务结束后停止共享服务。');
      if(mode==='launch'&&(active.includes('launch')||other.drawing.runtime.child||other.drawing.runtime.launchPromise))throw conflict('另一个实例已启动这个 ComfyUI 环境，请连接已有服务。');
    }
  }
  async run(id,mode,work){this.assertDrawing(id,mode);const pending=this.pending.get(id)||[];pending.push(mode);this.pending.set(id,pending);try{return await work();}finally{pending.splice(pending.indexOf(mode),1);if(!pending.length)this.pending.delete(id);}}
  claimQQ(id,config={}){
    const account=config.accountId||'',endpoint=config.mode==='external'?serviceKey(config.wsUrl):'';
    for(const [owner,claim] of this.qqClaims)if(owner!==id&&(account&&claim.account===account||endpoint&&claim.endpoint===endpoint))throw conflict('这个 QQ 账号或网关端口已被另一个实例使用，请先断开该实例。');
    this.qqClaims.set(id,{account,endpoint});
  }
  releaseQQ(id){this.qqClaims.delete(id);for(const [port,owner] of this.ports)if(owner===id)this.ports.delete(port);}
  async allocatePort(id,allocator){for(let attempt=0;attempt<20;attempt++){const port=await allocator();if(!this.ports.has(port)){this.ports.set(port,id);return port;}}throw conflict('无法为 QQ 实例分配独立端口，请稍后重试。');}
}
