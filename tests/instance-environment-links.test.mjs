import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'environment-links-'));
  const app=await createWorkbench({dataDir});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true,maxRetries:3});});
  const api=async(path,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    return {status:response.status,...await response.json()};
  };
  const create=async(moduleId,config)=>{
    const {instance}=await api('/api/instances',{moduleId});
    if(config)assert.equal((await api(`/instances/${instance.id}/api/modules/${moduleId}/config`,{values:config},'PUT')).status,200);
    return instance;
  };
  const config=async instance=>(await api(`/instances/${instance.id}/api/state`)).modules.find(item=>item.id==='drawing').config;
  const related=(instance,moduleId)=>api(`/api/instances/${instance.id}/related`,{moduleId});
  return {app,api,create,config,related};
}

test('跨模块资源跳转新建同环境实例，保留其他实例并能返回原绘图实例',async t=>{
  const {api,create,config,related}=await fixture(t);
  const values={comfyPath:'C:\\Comfy A',serviceUrl:'http://127.0.0.1:8191',workflowPath:'C:\\Workflows A',outputPath:'C:\\Outputs A'};
  const source=await create('drawing',values),unrelated=await create('comfyui',{comfyPath:'C:\\Comfy B',serviceUrl:'http://127.0.0.1:8192'});
  const before=await config(unrelated),result=await related(source,'comfyui');
  assert.equal(result.status,200);assert.notEqual(result.instance.id,unrelated.id);assert.equal(result.created,true);
  await api(`/api/instances/${result.instance.id}/start`,{});
  assert.deepEqual(await config(result.instance),values);assert.deepEqual(await config(unrelated),before);
  const returned=await related(result.instance,'drawing');assert.equal(returned.instance.id,source.id);
  const repeated=await related(source,'comfyui');assert.equal(repeated.instance.id,result.instance.id);assert.equal(repeated.created,false);
  assert.equal((await api('/api/instances')).instances.length,3);
});

test('同目录但不同服务不能混用；已有同环境优先采用且不改写其其他设置',async t=>{
  const {create,config,related}=await fixture(t);
  const source=await create('drawing',{comfyPath:'C:\\Comfy',serviceUrl:'http://127.0.0.1:8193',outputPath:'C:\\source-output'});
  await create('comfyui',{comfyPath:'C:\\Comfy',serviceUrl:'http://127.0.0.1:8194'});
  const match=await create('comfyui',{comfyPath:'C:\\Comfy',serviceUrl:'http://localhost:8193/',outputPath:'C:\\launcher-output'});
  const before=await config(match),result=await related(source,'comfyui');
  assert.equal(result.status,200);assert.equal(result.instance.id,match.id);assert.equal(result.created,false);
  assert.deepEqual(await config(match),before);
});

test('环境改动后重新匹配，不覆盖上次关联实例；并发跳转只创建一次',async t=>{
  const {api,create,config,related}=await fixture(t);
  const source=await create('drawing',{comfyPath:'C:\\Comfy A',serviceUrl:'http://127.0.0.1:8195'});
  const first=await related(source,'comfyui');assert.equal(first.status,200);
  await api(`/api/instances/${first.instance.id}/start`,{});const before=await config(first.instance);
  await api(`/instances/${source.id}/api/modules/drawing/config`,{values:{comfyPath:'C:\\Comfy B'}},'PUT');
  const [a,b]=await Promise.all([related(source,'comfyui'),related(source,'comfyui')]);
  assert.equal(a.instance.id,b.instance.id);assert.notEqual(a.instance.id,first.instance.id);
  assert.deepEqual(await config(first.instance),before);assert.equal((await api('/api/instances')).instances.length,3);
});

test('关联入口只允许绘图与启动器互通，实例内部不能创建或修改其他实例',async t=>{
  const {api,create,related}=await fixture(t),drawing=await create('drawing'),qq=await create('qq');
  assert.equal((await related(drawing,'qq')).status,400);assert.equal((await related(qq,'comfyui')).status,400);
  assert.equal((await api(`/instances/${drawing.id}/api/instances/${drawing.id}/related`,{moduleId:'comfyui'})).status,404);
  assert.equal((await api('/api/instances')).instances.length,2);
});
