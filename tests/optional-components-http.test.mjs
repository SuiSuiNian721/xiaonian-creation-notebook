import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
test('薄工作台缺少可选组件仍能启动，资源接口拒绝注入本地路径',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'optional-http-'));const app=await createWorkbench({dataDir,componentOptions:{catalog:{format:1,components:{}},candidates:{}}});
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 const get=async path=>{const res=await fetch(app.url+path);assert.equal(res.status,200,path);return res.json();};
 assert.equal((await get('/api/state')).modules.length,13);
 const state=await get('/api/component-packages');assert.equal(state.components.length,2);assert.ok(state.components.every(item=>!item.ready));
 const res=await fetch(app.url+'/api/component-packages/training/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file:'C:\\secret'})});assert.equal(res.status,400);
 assert.equal((await get('/api/storage')).resources instanceof Array,true);
});
