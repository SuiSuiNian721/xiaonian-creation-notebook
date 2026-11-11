import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';

test('重复打开被资料锁拒绝时，不修改活动视觉安装记录',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vision-lock-'));
  const app=await createWorkbench({dataDir:directory});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const saved=app.context.store.getSetting('vision.extension');
  const active={...saved,task:{id:'active-install',status:'running',stage:'downloading',completedBytes:120,totalBytes:300}};
  app.context.store.setSetting('vision.extension',active);
  await assert.rejects(createWorkbench({dataDir:directory}));
  assert.deepEqual(app.context.store.getSetting('vision.extension'),active,'未取得资料锁的窗口不能将活动安装标记为中断');
});

test('视觉停止失败保留可操作的工作台，后续关闭可以重试',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vision-close-'));let attempts=0;
  const controller={initialized:Promise.resolve(),state:()=>({runtime:{status:'failed'}}),close:async()=>{if(++attempts===1)throw new Error('暂时无法停止测试进程');}};
  const app=await createWorkbench({dataDir:directory,visionOptions:{controller}});
  t.after(async()=>{await app.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  await assert.rejects(app.close(),/暂时无法停止/);
  assert.equal((await fetch(app.url+'/api/health')).status,200);
  assert.equal((await fetch(app.url+'/api/instances')).status,200,'停止失败不能提前关闭实例管理器');
  assert.equal((await fetch(app.url+'/api/storage')).status,200,'停止失败不能提前关闭存储管理器');
  await app.close();assert.equal(attempts,2);
  await assert.rejects(fetch(app.url+'/api/health'));
});

test('视觉扩展包跨实例共用控制器，填入连接不保存角色，关闭只释放一次',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vision-http-')),calls=[];
  const state={installed:true,runtime:{status:'stopped'},package:{name:'视觉测试包'}};
  const controller={ready:Promise.resolve(),state:()=>structuredClone(state),
    start:input=>{calls.push(['start',input]);state.runtime.status='running';return structuredClone(state);},
    stop:()=>{calls.push(['stop']);state.runtime.status='stopped';return structuredClone(state);},
    connection:()=>({media:{localVisionEnabled:true,localVisionBaseUrl:'http://127.0.0.1:54321/v1',localVisionModel:'workbench-qwen-vision',localVisionKey:'fixture-secret'}}),
    install:()=>{calls.push(['install']);return structuredClone(state);},cancel:()=>structuredClone(state),chooseDirectory:()=>structuredClone(state),close:async()=>calls.push(['close'])};
  const app=await createWorkbench({dataDir:directory,visionOptions:{controller}});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const api=async(path,body,method=body===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(app.url+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const base='/api/vision-extension';
  assert.equal((await api(base)).status,200);
  assert.equal(JSON.stringify((await api(base)).body).includes('fixture-secret'),false);
  const first=(await api('/api/instances',{moduleId:'qq'})).body.instance;
  const second=(await api('/api/instances',{moduleId:'qq'})).body.instance;
  const path=id=>'/instances/'+id+base;
  assert.equal((await api(path(first.id)+'/start',{device:'cpu'})).status,200);
  assert.deepEqual(calls,[['start',{device:'cpu'}]]);
  assert.equal((await api(path(second.id))).body.runtime.status,'running');
  const character=(await api('/api/characters',{name:'扩展包测试角色'})).body.character;
  const connection=await api(base+'/connection',{});
  assert.equal(connection.status,200);assert.equal(connection.body.media.localVisionKey,'fixture-secret');
  assert.equal((await api('/api/characters/'+character.id+'/life')).body.settings.media.localVisionEnabled,false);
  assert.equal((await api(base+'/connection')).status,405);
  assert.equal((await api(base,{})).status,405);
  assert.equal((await api(base+'/install',{url:'https://invalid.example/payload'})).status,400);
  assert.equal((await api(base+'/start',{device:'wrong'})).status,400);
  assert.equal((await api(base+'/start',{command:'whoami'})).status,400);
  assert.equal((await api(base+'/stop',{},'POST',{origin:'https://invalid.example'})).status,403);
  assert.equal((await api(path(second.id)+'/stop',{})).status,200);
  assert.equal((await api(base)).body.runtime.status,'stopped');
  await app.close();assert.equal(calls.filter(([name])=>name==='close').length,1);
});
