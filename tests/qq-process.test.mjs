import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,rename,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const {QQProcessHost,saveQQProcessRecord,runQQDaemon}=await import('../framework/qq-process.mjs').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const child=fileURLToPath(new URL('./fixtures/qq-daemon-child.mjs',import.meta.url));
const parent=fileURLToPath(new URL('./fixtures/qq-daemon-parent.mjs',import.meta.url));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function waitFor(check){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,40));}throw new Error('等待测试进程超时');}
async function fixture(t){
  assert.equal(typeof QQProcessHost,'function','需要独立常驻的 QQ 托管进程');
  const directory=await mkdtemp(join(tmpdir(),'qq-daemon-')),slot=join(directory,'slot');await mkdir(slot);
  const host=new QQProcessHost({slot});
  t.after(async()=>{await host.stop();assert.ok(resolve(directory).startsWith(resolve(tmpdir())));await rm(directory,{recursive:true,force:true});});
  return {directory,slot,host,input:{command:process.execPath,args:[child],options:{cwd:slot,env:{...process.env,QQ_TEST_MARKER:join(directory,'child.pid')}},webPort:31001,onebotPort:31002}};
}
test('原工作台进程退出后 QQ 子进程存活，重接保留 PID/端口，重复启动复用原进程',async t=>{
  const f=await fixture(t),receipt=join(f.directory,'receipt.json');
  const code=await new Promise((done,reject)=>{const proc=spawn(process.execPath,[parent,f.slot,child,join(f.directory,'child.pid'),receipt],{windowsHide:true,stdio:'ignore'});proc.once('error',reject);proc.once('exit',done);});
  assert.equal(code,0);const started=JSON.parse(await readFile(receipt,'utf8'));assert.ok(alive(started.childPid));
  const restored=await f.host.recover();assert.equal(restored.childPid,started.childPid);assert.equal(restored.webPort,31001);
  assert.equal((await f.host.start(f.input)).childPid,started.childPid);await f.host.close();assert.ok(alive(started.childPid));
  await f.host.stop();await waitFor(()=>!alive(started.childPid));assert.equal(await f.host.recover(),null);
});
test('不同槽位进程隔离，不能用错误控制密钥停止其他实例',async t=>{
  const a=await fixture(t),b=await fixture(t);const first=await a.host.start(a.input),second=await b.host.start(b.input);
  const file=join(a.slot,'process.json'),saved=await readFile(file,'utf8'),record=JSON.parse(saved);
  await writeFile(file,JSON.stringify({...record,token:'0'.repeat(64)}),'utf8');
  await assert.rejects(new QQProcessHost({slot:a.slot}).stop(),/验证|归属|响应|密钥/);
  assert.ok(alive(first.childPid));await writeFile(file,saved,'utf8');
  await a.host.stop();assert.ok(alive(second.childPid));
});
test('已退出托管记录可以清理，不会向无关 PID 发送终止信号',async t=>{
  const f=await fixture(t);await f.host.start(f.input);const file=join(f.slot,'process.json'),record=JSON.parse(await readFile(file,'utf8'));
  await f.host.stop();await writeFile(file,JSON.stringify({...record,pid:2147483647}),'utf8');
  assert.equal(await f.host.recover(),null);assert.equal((await f.host.start(f.input)).status,'running');
});

test('两个工作台同时启动同一槽位仍只有一个 QQ 进程，子进程退出后释放记录',async t=>{
  const f=await fixture(t),other=new QQProcessHost({slot:f.slot});
  const [a,b]=await Promise.all([f.host.start(f.input),other.start(f.input)]);assert.equal(a.childPid,b.childPid);
  const record=JSON.parse(await readFile(join(f.slot,'process.json'),'utf8'));assert.equal(JSON.stringify(a).includes(record.token),false);
  process.kill(a.childPid);await waitFor(async()=>await f.host.recover()===null);
});

test('无响应的存活归属记录阻止重复启动，不会按保存 PID 杀进程',async t=>{
  const f=await fixture(t);await f.host.start(f.input);const file=join(f.slot,'process.json'),record=JSON.parse(await readFile(file,'utf8'));await f.host.stop();
  await writeFile(file,JSON.stringify({...record,pid:process.pid,childPid:null,createdAt:0}),'utf8');
  await assert.rejects(f.host.start(f.input),/不可达|未响应|归属/);assert.ok(alive(process.pid));
  await rm(file);
});

test('停止期间并发状态查询不能提前删除仍存活的 QQ 归属记录',async t=>{
  const f=await fixture(t),state=await f.host.start(f.input);
  const stopped=f.host.stop();
  await new Promise(done=>setTimeout(done,30));
  try{
    const status=await f.host.recover();
    if(!status)assert.equal(alive(state.childPid),false,'QQ 仍存活时必须保留归属记录');
    const record=await readFile(join(f.slot,'process.json'),'utf8').catch(()=>null);
    if(alive(state.childPid))assert.ok(record,'状态查询不能提前删除归属记录');
  }finally{await stopped;}
});

const electron=process.env.AI_FUTURE_ELECTRON||'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
test('桌面 Electron 的 Node 模式可托管后台 QQ，无需常驻工作台窗口',{skip:!existsSync(electron)},async t=>{
  const f=await fixture(t),desktopHost=new QQProcessHost({slot:f.slot,nodeExecutable:electron});
  const started=await desktopHost.start(f.input);assert.equal(started.status,'running');assert.ok(alive(started.childPid));
  await desktopHost.close();assert.equal((await f.host.recover()).childPid,started.childPid);
});

test('Windows 状态文件被短暂占用时有限重试，永久失败保留原记录并清理暂存文件',async t=>{
  const f=await fixture(t),file=join(f.directory,'record.json');await writeFile(file,'{"revision":0}','utf8');
  assert.equal(typeof saveQQProcessRecord,'function','状态文件替换需要可控的短暂占用恢复');let attempts=0;
  await saveQQProcessRecord(file,{revision:1},{renameImpl:async(from,to)=>{
    if(++attempts<3){assert.equal(JSON.parse(await readFile(file,'utf8')).revision,0);throw Object.assign(new Error('fixture busy'),{code:'EPERM'});}return rename(from,to);
  }});
  assert.equal(attempts,3);assert.equal(JSON.parse(await readFile(file,'utf8')).revision,1);
  await assert.rejects(saveQQProcessRecord(file,{revision:2},{renameImpl:async()=>{throw Object.assign(new Error('fixture denied'),{code:'EACCES'});}}),/fixture denied/);
  assert.equal(JSON.parse(await readFile(file,'utf8')).revision,1);
  assert.equal((await readdir(f.directory)).some(name=>name.endsWith('.tmp')),false);
});

async function daemonRecord(f){
  const file=join(f.slot,'process.json'),record={...f.input,version:1,id:randomUUID(),token:randomBytes(32).toString('hex'),slot:f.slot,launcherPid:process.pid,pid:null,childPid:null,createdAt:Date.now()};
  await writeFile(file,JSON.stringify(record),'utf8');return file;
}
test('启动记录写入期间明确停止，不得由迟到写入重新创建 QQ 或复活记录',async t=>{
  const f=await fixture(t),file=await daemonRecord(f);let release,childPid=null;const gate=new Promise(done=>{release=done;});
  const running=runQQDaemon(file,{saveRecord:async(path,record)=>{childPid=record.childPid;if(!childPid)await gate;return saveQQProcessRecord(path,record);}});
  try{
    await waitFor(async()=>!!await f.host.recover().catch(()=>null));await f.host.stop();release();await running;
    assert.equal(childPid,null,'停止后不能迟到启动 QQ');assert.equal(await f.host.recover(),null);
  }finally{release();await running;if(alive(childPid))process.kill(childPid);}
});
test('QQ 已启动后归属落盘永久失败，用原始句柄清理子进程且不留孤儿',async t=>{
  const f=await fixture(t),file=await daemonRecord(f);let childPid;
  await runQQDaemon(file,{saveRecord:async(path,record)=>{
    if(record.childPid){childPid=record.childPid;throw Object.assign(new Error('fixture persistent write denial'),{code:'EACCES'});}return saveQQProcessRecord(path,record);
  }});
  assert.ok(childPid);assert.equal(alive(childPid),false);assert.equal(await f.host.recover(),null);
});
