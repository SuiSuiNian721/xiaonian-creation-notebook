import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createConnection,createServer} from 'node:net';
import {existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {WorkbenchError} from './contracts.mjs';

const fail=message=>new WorkbenchError(409,message);
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const alive=pid=>{if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const endpoint=slot=>{
  const id=createHash('sha256').update(resolve(slot).toLowerCase()).digest('hex').slice(0,40);
  return process.platform==='win32'?'\\\\.\\pipe\\ai-future-qq-'+id:join(tmpdir(),'ai-future-qq-'+id+'.sock');
};
const readRecord=file=>{
  try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw fail('QQ 后台归属记录无法读取，已保留原文件。');}
};
function validate(record,slot){
  if(record?.version!==1||record.slot!==resolve(slot)||typeof record.id!=='string'||!/^[a-f0-9]{64}$/.test(record.token)||
    !['webPort','onebotPort'].every(key=>Number.isInteger(record[key])&&record[key]>0&&record[key]<65536))throw fail('QQ 后台归属记录无效，未接管或停止任何进程。');
}
export async function saveQQProcessRecord(file,record,{renameImpl=rename}={}){
  const temporary=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(record),{encoding:'utf8',flag:'wx',mode:0o600});
  try{
    for(let attempt=0;;attempt++){
      try{await renameImpl(temporary,file);return;}
      catch(error){if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await pause(Math.min(20*2**attempt,160));}
    }
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function removeRecord(file,id){if(readRecord(file)?.id===id)unlinkSync(file);}
function rpc(slot,record,action,timeout=2500){
  return new Promise((done,reject)=>{
    const socket=createConnection(endpoint(slot));let buffer='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):done(value);};
    socket.setTimeout(timeout,()=>finish(fail('QQ 后台未响应，请保留现有进程后稍后重试。')));
    socket.once('error',error=>finish(error));
    socket.once('connect',()=>socket.write(JSON.stringify({id:record.id,token:record.token,action})+'\n'));
    socket.on('data',bytes=>{
      buffer+=bytes.toString('utf8');if(buffer.length>8192){finish(fail('QQ 后台响应无效。'));return;}
      if(!buffer.includes('\n'))return;
      try{const reply=JSON.parse(buffer.split('\n')[0]);if(!reply.ok||reply.id!==record.id)throw fail('QQ 后台密钥或进程归属验证失败。');finish(null,reply.state);}catch(error){finish(error);}
    });
    socket.once('close',()=>finish(fail('QQ 后台未返回可验证的响应。')));
  });
}

/** 独立进程持有 QQ 的原始句柄；窗口只能经已验证的本机 IPC 控制它。 */
export class QQProcessHost {
  constructor({slot,spawnImpl=spawn,nodeExecutable=process.execPath,startupTimeoutMs=10000}){
    this.slot=resolve(slot);this.file=join(this.slot,'process.json');this.spawn=spawnImpl;this.node=nodeExecutable;this.timeout=startupTimeoutMs;
  }
  async recover(){
    const record=readRecord(this.file);if(!record)return null;validate(record,this.slot);
    try{return await rpc(this.slot,record,'status');}
    catch(error){
      // PID 只用于判定记录是否仍可能有效，绝不用于重新接管或终止进程。
      if(!alive(record.pid)&&!alive(record.childPid)&&(record.pid||!alive(record.launcherPid)||Date.now()-record.createdAt>this.timeout)){
        removeRecord(this.file,record.id);return null;
      }
      throw fail(error instanceof WorkbenchError?error.message:'QQ 后台暂时不可达，未启动第二份 QQ。');
    }
  }
  async start(input){
    if(this.starting)return this.starting;
    this.starting=this.launch(input);try{return await this.starting;}finally{this.starting=null;}
  }
  async launch(input){
    if(existsSync(this.file)){
      try{const state=await this.recover();if(state)return state;}catch(error){
        const record=readRecord(this.file);if(!record||Date.now()-record.createdAt>this.timeout)throw error;
        return this.wait(record);
      }
    }
    const record={version:1,id:randomUUID(),token:randomBytes(32).toString('hex'),slot:this.slot,launcherPid:process.pid,pid:null,childPid:null,createdAt:Date.now(),...input};
    validate(record,this.slot);
    try{writeFileSync(this.file,JSON.stringify(record),{encoding:'utf8',mode:0o600,flag:'wx'});}
    catch(error){if(error.code==='EEXIST')return this.wait(readRecord(this.file));throw error;}
    let daemon;
    try{
      daemon=this.spawn(this.node,[fileURLToPath(new URL('./qq-daemon.mjs',import.meta.url)),this.file],{
        detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},
      });
      daemon.on('error',()=>{removeRecord(this.file,record.id);});daemon.unref();
    }catch(error){removeRecord(this.file,record.id);throw fail('无法启动 QQ 后台托管进程。');}
    return this.wait(record);
  }
  async wait(record){
    const deadline=Date.now()+this.timeout;
    while(Date.now()<deadline){
      if(!readRecord(this.file))throw fail('QQ 后台启动失败，请检查运行组件。');
      try{const state=await rpc(this.slot,record,'status');if(state.status==='running')return state;}catch{}
      await pause(60);
    }
    throw fail('QQ 后台启动超时，未重复创建进程；可稍后重接或停止 QQ。');
  }
  async stop(){
    if(this.starting)await this.starting.catch(()=>{});
    const state=await this.recover();if(!state)return;
    const record=readRecord(this.file);if(!record)return;
    await rpc(this.slot,record,'stop',12000);
  }
  async close(){} // 关闭窗口不影响后台 QQ。
}

async function terminateOwned(child){
  if(!child?.pid||child.exitCode!==null)return;
  let timer;
  const exited=new Promise(done=>child.once('exit',done));
  if(process.platform==='win32'){
    await new Promise((done,reject)=>{
      const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      killer.once('error',reject);killer.once('close',done);
    });
  }else child.kill();
  try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('尚未确认 QQ 进程退出，请稍后重试。')),10000);})]);}finally{clearTimeout(timer);}
}

export async function runQQDaemon(file,{saveRecord=saveQQProcessRecord}={}){
  const record=readRecord(file);if(!record)throw fail('缺少 QQ 后台启动记录。');validate(record,record.slot);
  const address=endpoint(record.slot);let child,status='starting',stopping=false,stopPromise,ended=false;
  const signalHandlers=[];
  const snapshot=()=>({id:record.id,pid:process.pid,childPid:child?.pid??null,status,webPort:record.webPort,onebotPort:record.onebotPort});
  const sameToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(record.token));
  const server=createServer(socket=>{
    let buffer='',received=false;socket.setTimeout(5000,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('data',bytes=>{
      if(received)return;buffer+=bytes.toString('utf8');if(buffer.length>8192){socket.destroy();return;}if(!buffer.includes('\n'))return;received=true;
      void (async()=>{
        let value;try{value=JSON.parse(buffer.split('\n')[0]);}catch{socket.end('{"ok":false}\n');return;}
        if(value.id!==record.id||!sameToken(value.token)||!['status','stop'].includes(value.action)){socket.end('{"ok":false}\n');return;}
        if(value.action==='stop'){
          socket.setTimeout(12000,()=>socket.destroy());
          stopping=true;status='stopping';stopPromise??=terminateOwned(child);try{await stopPromise;status='stopped';}catch{stopping=false;status='running';stopPromise=null;socket.end(JSON.stringify({ok:false})+'\n');return;}
        }
        if(value.action==='stop')cleanup();
        socket.end(JSON.stringify({ok:true,id:record.id,state:snapshot()})+'\n');
      })().catch(()=>socket.destroy());
    });
  });
  let cleaned=false;
  const cleanup=()=>{
    if(cleaned)return;cleaned=true;removeRecord(file,record.id);server.close();
    for(const [signal,handler] of signalHandlers)process.removeListener(signal,handler);
  };
  // 只有持有归属记录且成功监听此槽位 IPC 的进程才能启动 QQ。
  if(process.platform!=='win32'&&existsSync(address))unlinkSync(address);
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(address,done);});
  if(readRecord(file)?.id!==record.id){server.close();return;}
  record.pid=process.pid;
  try{await saveRecord(file,record);}catch{cleanup();return;}
  if(cleaned){removeRecord(file,record.id);return;}
  for(const signal of ['SIGINT','SIGTERM']){const handler=()=>{stopping=true;void terminateOwned(child).then(cleanup,()=>{stopping=false;status='error';});};signalHandlers.push([signal,handler]);process.once(signal,handler);}
  try{
    child=spawn(record.command,record.args,{...record.options,windowsHide:true,stdio:'ignore'});
    child.once('exit',()=>{ended=true;status='stopped';if(!stopping)cleanup();});
    await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});
    record.childPid=child.pid;if(ended)return;
    await saveRecord(file,record);
    if(ended){removeRecord(file,record.id);return;}status='running';
  }catch{
    // 记录写入失败也必须保留原句柄：先停止刚创建的 QQ，失败则保留 IPC 供明确重试。
    status='error';stopping=true;
    try{await terminateOwned(child);cleanup();}catch{stopping=false;}
  }
}
