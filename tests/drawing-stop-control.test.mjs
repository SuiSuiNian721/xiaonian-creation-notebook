import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../framework/server.mjs';
import { WorkbenchError } from '../framework/contracts.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'drawing-stop-')),comfy=join(directory,'ComfyUI');
  await mkdir(join(comfy,'comfy'),{recursive:true});for(const name of ['main.py','server.py','nodes.py'])await writeFile(join(comfy,name),'# fixture\n');
  const control={inspections:0,stops:0,changed:false,children:[]};
  const app=await createWorkbench({dataDir:directory,instances:false,drawingOptions:{WebSocketImpl:null,fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/system_stats')?{system:{comfyui_version:'fixture'}}:{Save:{input:{required:{text:['STRING']}},output_node:true}})),runtimeOptions:{processControl:{async inspect(options){control.inspections++;control.options=options;return {pid:12345,startedAt:'2026-11-08T00:00:00.0000000Z',executable:options.executable,commandHash:'a'.repeat(64)};},async stop(options){if(control.changed)throw new WorkbenchError(409,'进程已变化，请重新核对。');control.stops++;control.stopped=options;return {stopped:true,pid:options.pid};}},spawnImpl:(_exe,_args,options)=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);control.children.push(child);return child;}}}});
  t.after(async()=>{for(const child of control.children)if(child.exitCode===null&&child.signalCode===null)child.kill();await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  app.context.store.setEnabled('drawing',true);app.context.store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});app.context.drawing.runtime.saveSettings({pythonPath:process.execPath});
  const api=async(path,body)=>{const response=await fetch(app.url+'/api/modules/drawing/'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  return {app,control,api};
}

test('已连接的本机外部 ComfyUI 先核验并确认，再停止同一进程；重复确认不重复结束',async t=>{
  const {app,control,api}=await fixture(t);await api('connect',{});
  assert.equal((await api('runtime')).data.canStop,false);
  const preview=await api('runtime/stop-preview',{});assert.equal(preview.status,200);assert.equal(preview.data.target.scope,'external');assert.equal(preview.data.target.pid,12345);assert.equal(control.stops,0);
  assert.equal(control.options.port,8188);assert.equal(control.options.executable,process.execPath);
  assert.equal(JSON.stringify(preview.data).includes('commandHash'),false);
  const confirmed=await api('runtime/stop-confirm',{token:preview.data.target.token});assert.equal(confirmed.status,200);assert.equal(confirmed.data.stopped,true);assert.equal(control.stops,1);assert.equal(app.context.drawing.currentConnection(),false);
  assert.equal((await api('runtime/stop-confirm',{token:preview.data.target.token})).data.stopped,true);assert.equal(control.stops,1);
});

test('配置变化、进程替换与未知确认编号均不能误停',async t=>{
  const {app,control,api}=await fixture(t);await api('connect',{});
  assert.equal((await api('runtime/stop-confirm',{token:'unknown'})).status,409);
  const first=(await api('runtime/stop-preview',{})).data.target;
  app.context.store.saveConfig('drawing',{serviceUrl:'http://127.0.0.1:8288'});
  assert.equal((await api('runtime/stop-confirm',{token:first.token})).status,409);assert.equal(control.stops,0);
  await api('connect',{});const second=(await api('runtime/stop-preview',{})).data.target;control.changed=true;
  assert.equal((await api('runtime/stop-confirm',{token:second.token})).status,409);assert.equal(control.stops,0);assert.equal(app.context.drawing.currentConnection(),true);
  app.context.store.saveConfig('drawing',{serviceUrl:'https://remote.example:8188'});await api('connect',{});
  const before=control.inspections;assert.equal((await api('runtime/stop-preview',{})).status,409);assert.equal(control.inspections,before);
});

test('本工作台持有的进程同样绑定确认快照，日志即时返回真实 canStop',async t=>{
  const {app,control,api}=await fixture(t);await app.context.drawing.runtime.launch();
  assert.equal((await api('runtime/logs')).data.canStop,true);
  const target=(await api('runtime/stop-preview',{})).data.target;assert.equal(target.scope,'managed');assert.equal(control.inspections,0);
  assert.equal((await api('runtime/stop-confirm',{token:target.token})).data.stopped,true);
  assert.equal((await api('runtime/logs')).data.canStop,false);assert.equal(control.children[0].exitCode!==null||control.children[0].signalCode!==null,true);
});
