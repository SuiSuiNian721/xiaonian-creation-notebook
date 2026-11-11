import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DrawingManager } from '../framework/drawing-manager.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'drawing-index-refresh-'));
  const comfyPath = join(root, 'ComfyUI');
  await mkdir(join(comfyPath, 'comfy'), {recursive:true});
  for (const file of ['main.py', 'server.py', 'nodes.py']) await writeFile(join(comfyPath, file), '# fixture');
  const settings = new Map();
  const store = {getSetting:key => structuredClone(settings.get(key)), setSetting:(key,value) => settings.set(key,structuredClone(value))};
  const config = {comfyPath};
  let inspections = 0;
  const options = {store, drawing:{config:()=>config}, dataDir:join(root,'data'), fetchImpl:async()=>new Response('model bytes')};
  const manager = new DrawingManager(options);
  manager.repositories.inspect = async()=>{inspections++; return null;};
  t.after(async()=>{await manager.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)); await rm(root,{recursive:true,force:true});});
  return {root,comfyPath,config,manager,options,get inspections(){return inspections;}};
}
async function download(f,filename='新增模型.safetensors') {
  const task = await f.manager.downloads.start({requestId:randomUUID(),url:'https://example.invalid/model',category:'loras',filename});
  await f.manager.downloads.active.get(task.id)?.promise;
  const done = f.manager.downloads.get(task.id);
  assert.equal(done.status,'completed',done.error);
  assert.equal(await readFile(done.target,'utf8'),'model bytes');
  return done;
}

test('下载发布后定点更新模型索引，状态轮询不扫描，重启保留更新',async t=>{
  const f=await fixture(t);await f.manager.inventory();const inspections=f.inspections;
  const done=await download(f);const inventory=f.manager.state().inventory;
  assert.equal(inventory.models.length,1);
  assert.equal(inventory.models[0].path,done.target);
  assert.equal(inventory.models[0].sha256,done.actualSha256);
  assert.equal(inventory.models[0].size,11);
  assert.equal(f.inspections,inspections);
  const restarted=new DrawingManager(f.options);
  try {assert.deepEqual(restarted.state().inventory,inventory);} finally {await restarted.close();}
  await rm(done.target);assert.equal((await f.manager.inventory()).models.length,0,'手工重扫后不能复活已删除的下载模型');
});

test('首次下载无需先扫描，建立明确的部分索引并累计后续下载',async t=>{
  const f=await fixture(t);assert.equal(f.manager.state().inventory,null);
  await mkdir(join(f.comfyPath,'models','loras'),{recursive:true});
  await writeFile(join(f.comfyPath,'models','loras','existing.safetensors'),'existing');
  const first=await download(f),second=await download(f,'second.safetensors');
  const inventory=f.manager.state().inventory;
  assert.ok(inventory,'首次下载后必须立即可见');assert.equal(inventory.partial,true);
  assert.deepEqual(inventory.models.map(model=>model.path),[first.target,second.target]);
  assert.deepEqual(inventory.repositories,[]);assert.match(inventory.warnings.join(''),/尚未.*索引/);
  assert.equal(f.inspections,0,'下载完成不能自动扫描环境');
  const restarted=new DrawingManager(f.options);
  try{assert.deepEqual(restarted.state().inventory,inventory);}finally{await restarted.close();}
  const full=await f.manager.inventory();assert.notEqual(full.partial,true);assert.equal(full.models.length,3);assert.equal(full.repositories.length,1);
});

test('切换环境后的首次下载建立当前环境部分索引，不能沿用旧环境模型',async t=>{
  const f=await fixture(t);await f.manager.inventory();await download(f);
  const other=join(f.root,'OtherComfy');await mkdir(join(other,'comfy'),{recursive:true});
  for(const file of ['main.py','server.py','nodes.py'])await writeFile(join(other,file),'# fixture');
  f.config.comfyPath=other;const inspections=f.inspections;const done=await download(f);
  const inventory=f.manager.state().inventory;
  assert.ok(inventory,'当前环境首次下载后必须立即可见');assert.equal(inventory.partial,true);
  assert.equal(inventory.comfyPath,other);assert.deepEqual(inventory.models.map(model=>model.path),[done.target]);
  assert.equal(f.inspections,inspections);
});

test('无索引时旧环境后台下载完成不能创建当前环境的索引',async t=>{
  const f=await fixture(t);let release;
  f.manager.downloads.fetch=()=>new Promise(done=>{release=()=>done(new Response('model bytes'));});
  const pending=download(f);while(!release)await new Promise(done=>setTimeout(done,5));
  f.config.comfyPath=join(f.root,'OtherComfy');release();await pending;
  assert.equal(f.manager.state().inventory,null);assert.equal(f.inspections,0);
  f.config.comfyPath=f.comfyPath;assert.equal(f.manager.state().inventory,null,'不得由后台旧环境任务建立新索引');
});

test('切换或清空 ComfyUI 路径不会展示旧环境索引，状态不扫描',async t=>{
  const f=await fixture(t);await f.manager.inventory();const inspections=f.inspections;
  f.config.comfyPath=join(f.root,'other');assert.equal(f.manager.state().inventory,null);
  f.config.comfyPath='';assert.equal(f.manager.state().inventory,null);
  assert.equal(f.inspections,inspections);
  f.config.comfyPath=f.comfyPath;assert.equal(f.manager.state().inventory.comfyPath,f.comfyPath);
});

test('扫描与下载同时完成时，扫描结果不能覆盖刚发布的模型',async t=>{
  const f=await fixture(t);await f.manager.inventory();
  const root=f.manager.root.bind(f.manager);let calls=0;
  f.manager.root=async()=>{const value=await root();if(++calls===2)await download(f);return value;};
  const inventory=await f.manager.inventory();
  assert.equal(inventory.models.length,1);
  assert.equal(f.manager.state().inventory.models.length,1);
});

test('原环境的后台下载不会混入切换后的环境索引',async t=>{
  const f=await fixture(t);await f.manager.inventory();
  let release;
  f.manager.downloads.fetch=()=>new Promise(done=>{release=()=>done(new Response('model bytes'));});
  const pending=download(f);
  while(!release)await new Promise(done=>setTimeout(done,5));
  const other=join(f.root,'OtherComfy');await mkdir(join(other,'comfy'),{recursive:true});
  for(const file of ['main.py','server.py','nodes.py'])await writeFile(join(other,file),'# fixture');
  f.config.comfyPath=other;await f.manager.inventory();release();await pending;
  assert.equal(f.manager.state().inventory.comfyPath,other);
  assert.deepEqual(f.manager.state().inventory.models,[]);
});
