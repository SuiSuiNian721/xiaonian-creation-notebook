import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(options={}) {
  const {DrawingStartup}=await import('../framework/drawing-startup.mjs');
  let revision=1,ready=false,connections=0;
  const opened=[];
  const drawing={closed:false,store:{module:()=>({configRevision:revision})},config:()=>({serviceUrl:'http://127.0.0.1:8188'}),runtime:{launchRecord:{status:'running',pid:123,startedAt:'one'}},connect:async()=>{connections++;if(!ready)throw new Error('not ready');return {};}};
  const startup=new DrawingStartup({drawing,openBrowser:async url=>{opened.push(url);},pollMs:10,timeoutMs:100,...options});
  return {startup,drawing,opened,ready:()=>{ready=true;},change:()=>{revision++;},connections:()=>connections};
}

test('服务确认就绪才打开浏览器，同一轮启动和重复请求只打开一次',async()=>{
  const f=await fixture();const first=f.startup.start();const second=f.startup.start();
  await delay(15);assert.equal(f.opened.length,0);assert.equal(f.startup.state().status,'waiting');
  f.ready();await Promise.all([first,second]);await f.startup.start();assert.deepEqual(f.opened,['http://127.0.0.1:8188']);assert.equal(f.startup.state().status,'opened');f.startup.close();
});

test('不打开浏览器也等待就绪并连接，之后可主动启用浏览器',async()=>{
  const f=await fixture();const pending=f.startup.start({openBrowser:false});await delay(15);
  assert.equal(f.startup.state().status,'waiting');f.ready();await pending;
  assert.equal(f.startup.state().status,'ready');assert.equal(f.opened.length,0);assert.ok(f.connections()>0);
  await f.startup.start({openBrowser:false});assert.equal(f.opened.length,0);
  await f.startup.start({openBrowser:true});assert.equal(f.opened.length,1);f.startup.close();
});

test('配置改变、停止或关闭后不打开过期地址',async()=>{
  for(const action of ['change','cancel','close']){
    const f=await fixture();const pending=f.startup.start();
    if(action==='change')f.change();else f.startup[action]();
    f.ready();await pending;assert.equal(f.opened.length,0);f.startup.close();
  }
});

test('启动进程提前退出或等待超时保留明确错误，不打开浏览器',async()=>{
  const exited=await fixture();exited.drawing.runtime.launchRecord.status='exited';await exited.startup.start();assert.equal(exited.startup.state().status,'failed');assert.match(exited.startup.state().error,/退出/);assert.equal(exited.opened.length,0);exited.startup.close();
  const timed=await fixture({timeoutMs:25});await timed.startup.start();assert.equal(timed.startup.state().status,'failed');assert.match(timed.startup.state().error,/超时/);assert.equal(timed.opened.length,0);timed.startup.close();
});

test('握手期间进程退出或被另一轮启动替换，不能打开浏览器',async()=>{
  for(const change of [record=>{record.status='exited';},record=>{record.pid=456;record.startedAt='two';}]){
    const f=await fixture();f.ready();const connect=f.drawing.connect;
    f.drawing.connect=async()=>{await connect();change(f.drawing.runtime.launchRecord);};
    await f.startup.start();assert.equal(f.opened.length,0);assert.equal(f.startup.state().status,'failed');f.startup.close();
  }
});
