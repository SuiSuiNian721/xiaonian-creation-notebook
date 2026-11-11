import test from 'node:test';
import assert from 'node:assert/strict';
const {CachedDiscovery}=await import('../framework/resource-discovery.mjs').catch(()=>({}));
const memory=()=>{const values=new Map();return {getSetting:key=>values.get(key),setSetting:(key,value)=>values.set(key,structuredClone(value))};};
import {EnvironmentDiscovery} from '../framework/environment.mjs';

test('发现尝试在工作开始时持久保存，重建控制器只读缓存并合并并发',async()=>{
  assert.equal(typeof CachedDiscovery,'function');
  const store=memory(),first=new CachedDiscovery({store,key:'test'}),second=new CachedDiscovery({store,key:'test'});
  let calls=0,release;const blocked=new Promise(resolve=>release=resolve);
  const a=first.run(async()=>{calls++;await blocked;return {candidates:['model']};});
  assert.equal(second.read().attempted,true);
  const b=second.run(()=>{throw new Error('不应重复扫描');});
  release();assert.deepEqual((await a).result,{candidates:['model']});await b;assert.equal(calls,1);
  const restarted=new CachedDiscovery({store,key:'test'});
  assert.deepEqual((await restarted.run(()=>{throw new Error('重启不应扫描');})).result,{candidates:['model']});
});

test('绘图和 ComfyUI 共用持久结果，重启和失败后不隐式重扫',async()=>{
  const store=memory();let calls=0;
  const options={store,roots:[],scanLocal:async()=>{calls++;return {candidates:[],partial:true,warnings:['范围受限']};}};
  const first=new EnvironmentDiscovery(options);
  await first.scan({moduleId:'drawing'});first.close();
  const next=new EnvironmentDiscovery(options);
  assert.equal((await next.scan({moduleId:'comfyui'})).partial,true);
  assert.equal(calls,1);
  await next.scan({moduleId:'drawing',refresh:true});assert.equal(calls,2);next.close();
});

test('失败与中断不会反复自动尝试，手动失败保留上次结果',async()=>{
  assert.equal(typeof CachedDiscovery,'function');
  const store=memory(),cache=new CachedDiscovery({store,key:'failure'});
  assert.equal((await cache.run(async()=>{throw new Error('文件夹无权限');})).status,'failed');
  assert.equal((await cache.run(()=>{throw new Error('不应再次执行');})).error,'文件夹无权限');
  await cache.run(async()=>({candidates:['old'],partial:true}),{refresh:true,fingerprint:'a'});
  assert.equal((await cache.run(async()=>{throw new Error('取消检索');},{refresh:true})).result.candidates[0],'old');
  assert.equal(cache.read({fingerprint:'b'}).stale,true);
  store.setSetting('resource.discovery.interrupted',{attempted:true,status:'running',result:null});
  assert.equal(new CachedDiscovery({store,key:'interrupted'}).read().status,'interrupted');
});

for(const moduleId of ['qq','mc-skin','mc-play'])test(`${moduleId} 重建发现器后复用上次结果，只有手动刷新才重新检索`,async()=>{
  const store=memory();let calls=0;
  const scan=async()=>{calls++;return {candidates:[{id:'cached',path:'fixture',values:{}}],warnings:[]};};
  const options={store,roots:[],env:{},scanLocal:scan,discoverLan:scan};
  const first=new EnvironmentDiscovery(options);
  await first.scan({moduleId});await first.close();
  const reopened=new EnvironmentDiscovery(options);
  assert.equal(reopened.state({moduleId}).attempted,true);
  assert.equal((await reopened.scan({moduleId})).candidates[0].id,'cached');assert.equal(calls,1);
  await reopened.scan({moduleId,refresh:true});assert.equal(calls,2);await reopened.close();
});
