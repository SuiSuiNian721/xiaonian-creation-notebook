import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
test('检索 GET 只读，跨重启缓存共享且手动刷新才能再次检索',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'resource-http-'));let scans=0,app;
  const options={dataDir,instances:false,environmentOptions:{roots:[],scanLocal:async()=>{scans++;return{candidates:[],partial:false,warnings:[]};}}};
  const start=async()=>app=await createWorkbench(options);
  t.after(async()=>{await app?.close();await rm(dataDir,{recursive:true,force:true});});await start();
  const request=async(path,body)=>{const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  await request('/api/modules/drawing/enable',{});await request('/api/modules/comfyui/enable',{});
  assert.equal((await request('/api/environment/state?moduleId=drawing')).attempted,false);assert.equal(scans,0);
  await request('/api/environment/scan',{moduleId:'drawing'});assert.equal(scans,1);
  await app.close();await start();
  assert.equal((await request('/api/environment/state?moduleId=comfyui')).attempted,true);
  await request('/api/environment/scan',{moduleId:'comfyui'});assert.equal(scans,1);
  await request('/api/environment/scan',{moduleId:'comfyui',refresh:true});assert.equal(scans,2);
});
test('角色 LoRA 关联通过 HTTP 往返可下载，角色包不携带外部绝对路径',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'role-reference-http-')),app=await createWorkbench({dataDir,instances:false});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const api=async(path,body)=>{const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const {character}=await api('/api/characters',{name:'念念'}),path=join(dataDir,'character.safetensors'),bytes=Buffer.alloc(4096,42);await writeFile(path,bytes);
  const {resource}=await api('/api/characters/'+character.id+'/resource-references',{kind:'lora',name:'共享LoRA',path,baseFamily:'sdxl'});
  const download=await fetch(app.url+resource.url);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const exported=await api('/api/characters/'+character.id+'/export');assert.equal(JSON.stringify(exported).includes('safetensors'),false);assert.equal(JSON.stringify(exported).includes(path),false);
});
