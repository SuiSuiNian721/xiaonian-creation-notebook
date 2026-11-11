import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {QQRuntime} from '../framework/qq-runtime.mjs';
import {QQProcessHost} from '../framework/qq-process.mjs';
import {createHash} from 'node:crypto';

test('真实后台进程承载 QQ 管理接口，重建运行端保持 PID、端口、账号目录和连接配置',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-persistent-')),bytes=Buffer.from('fixture package');
  const packageSpec={version:'fixture',url:'https://example.test/qq.zip',sha256:createHash('sha256').update(bytes).digest('hex'),downloadBytes:bytes.length};
  const first=new QQRuntime({dataDir:directory,packageSpec,fetchImpl:async(url,options)=>String(url)===packageSpec.url?new Response(bytes):fetch(url,options),extractImpl:async(_archive,dest)=>{
    await mkdir(join(dest,'napcat'),{recursive:true});for(const name of ['node.exe','index.js','wrapper.node','QQNT.dll','napcat/napcat.mjs'])await writeFile(join(dest,name),'fixture content');
  }});
  const manager=first.processHost,start=manager.start.bind(manager);
  manager.start=input=>start({...input,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/qq-http-child.mjs',import.meta.url))]});
  let second;
  t.after(async()=>{await first.close();await second?.close();await manager.stop();await rm(directory,{recursive:true,force:true});});
  await first.install({directory:join(directory,'install')});
  assert.equal((await first.startLogin()).login.status,'online');
  const a=await manager.recover(),connection=first.connection();
  const files=['config/webui.json','config/onebot11_70001.json'];
  const before=await Promise.all(files.map(async file=>({bytes:await readFile(join(first.slot,'napcat',file),'utf8'),mtime:(await stat(join(first.slot,'napcat',file))).mtimeMs})));
  await first.close();
  second=new QQRuntime({dataDir:directory,packageSpec});await second.ready;
  assert.equal(second.state().login.status,'online');assert.equal(second.login.accountId,'70001');assert.deepEqual(second.connection(),connection);
  const b=await second.processHost.recover();assert.equal(b.childPid,a.childPid);assert.equal(b.pid,a.pid);
  assert.equal(second.slot,first.slot);await second.startLogin();assert.equal((await manager.recover()).childPid,a.childPid);
  const after=await Promise.all(files.map(async file=>({bytes:await readFile(join(first.slot,'napcat',file),'utf8'),mtime:(await stat(join(first.slot,'napcat',file))).mtimeMs})));
  assert.deepEqual(after,before,'恢复不能重写管理或 OneBot 配置');
  const calls=await readFile(join(first.slot,'napcat/calls.txt'),'utf8');
  assert.equal(calls.includes('RefreshQRcode'),false);assert.equal(calls.split('SetConfig').length-1,1);
  const control=new QQProcessHost({slot:first.slot});await control.stop();await second.sync();assert.equal(second.state().running,false);
});
