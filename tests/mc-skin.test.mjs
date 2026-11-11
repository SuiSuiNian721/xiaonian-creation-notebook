import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createWorkbench } from '../framework/server.mjs';
import { WorkbenchStore } from '../framework/store.mjs';
import { MinecraftSkin } from '../framework/mc-skin.mjs';
import { SkinRuntime } from '../framework/mc-skin-runtime.mjs';

function pixelPlan(model='slim') {
  const parts = {head:[8,8,8],body:[8,4,12],rightArm:[model==='slim'?3:4,4,12],leftArm:[model==='slim'?3:4,4,12],rightLeg:[4,4,12],leftLeg:[4,4,12]};
  return {palette:{S:[255,239,229,255],H:[65,50,86,255],C:[136,111,170,255]},surfaces:Object.entries(parts).flatMap(([part,[w,d,h]])=>Object.entries({top:[w,d],bottom:[w,d],right:[d,h],front:[w,h],left:[d,h],back:[w,h]}).map(([side,[width,height]])=>({face:part+'.'+side,base:Array(height).fill((part==='head'?'S':'C').repeat(width)),outer:Array(height).fill('-'.repeat(width))}))),eyePalette:{S:[255,239,229,255],T:[230,217,215,255],W:[255,255,255,255],I:[117,80,160,255],J:[185,151,224,255],L:[58,39,69,255],U:[86,55,95,255],V:[149,93,131,255]}};
}

async function fixture(t,{complete=async()=>({text:JSON.stringify(pixelPlan())})}={}) {
  const directory=await mkdtemp(join(tmpdir(),'ai-future-mc-skin-'));
  const app=await createWorkbench({dataDir:directory,skinOptions:{complete}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  async function api(path,value,method=value===undefined?'GET':'POST') {
    const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});
    return {status:response.status,...await response.json(),httpStatus:response.status};
  }
  const skin=(path,value)=>api('/api/modules/mc-skin/'+path,value);
  const enable=()=>api('/api/modules/mc-skin/enable',{});
  return {...app,directory,api,skin,enable};
}
const request=(extra={})=>({requestId:randomUUID(),name:'像素验收',instruction:'紫色衣装与紫瞳，制作一份像素候选。',model:'slim',eyeTemplate:'eye_A',referenceIds:[],...extra});

test('额外归档目录失败仍发布已校验的本地皮肤，可下载与确认',async t=>{
  const app=await fixture(t);await app.enable();
  const output=join(app.directory,'external');await mkdir(output);
  await writeFile(join(output,'AI未来皮肤'),'archive blocker','utf8');
  await app.api('/api/modules/mc-skin/config',{values:{workspacePath:output}},'PUT');
  const job=await finished(app,(await app.skin('jobs',request())).id);
  assert.equal(job.status,'completed',job.error);assert.equal(job.validation.passed,true);
  assert.match(job.warning,/归档|作品目录/);
  assert.equal((await fetch(app.url+job.files['skin.png'])).status,200);
  assert.equal((await app.skin('jobs/'+job.id+'/approve',{})).approved,true);
});

test('环境检查期间关闭皮肤模块不会迟到入队或启动制作',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'skin-close-race-'));const store=new WorkbenchStore(directory);
  const skin=new MinecraftSkin({store,dataDir:directory,sharedAI:{complete:async()=>({text:'unused'})}});
  t.after(async()=>{await skin.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  let release,started=0;skin.runtime.check=()=>new Promise(done=>{release=done;});skin.make=async()=>{started++;};
  const pending=skin.submit(request());const outcome=pending.then(value=>({value}),error=>({error}));
  await skin.close();release({available:true,templates:[]});
  const result=await outcome;assert.equal(result.error?.status,409);assert.equal(started,0);assert.equal(skin.jobs().length,0);
  await assert.rejects(skin.submit(request()),/关闭/);
});

test('关闭后的皮肤运行端不再返回可用缓存或启动 Python',async()=>{
  const runtime=new SkinRuntime({directory:tmpdir()});runtime.cached={available:true,command:process.execPath};runtime.close();
  await assert.rejects(runtime.check(),/关闭/);
  await assert.rejects(runtime.run(['environment']),/关闭/);
});
async function finished(app,id) {
  for(let i=0;i<150;i++){const job=await app.skin('jobs/'+id);if(!['queued','designing','rendering'].includes(job.status))return job;await new Promise(done=>setTimeout(done,100));}
  throw new Error('皮肤任务未在测试时限完成');
}

test('MC 皮肤接口按模块启用隔离，真实 Python 检查返回两种冻结模板和 UV',async t=>{
  const app=await fixture(t);
  assert.equal((await app.skin('state')).status,409);
  await app.enable();
  const state=await app.skin('state');assert.equal(state.status,200);assert.equal(state.runtime.available,true);
  assert.deepEqual(state.templates.map(template=>template.id),['eye_A','eye_B']);
  assert.ok(state.templates.every(template=>template.version==='1.0.0'));
  assert.equal(state.jobs.length,0);
});

test('无效图像与原皮肤尺寸在进入制作前拒绝',async t=>{
  const app=await fixture(t);await app.enable();
  for(const input of [{fileName:'bad.png',kind:'skin',base64:Buffer.from('not png').toString('base64')},{fileName:'bad.png',kind:'reference',base64:'@@@'},{fileName:'file.exe',kind:'reference',base64:'AA=='}])assert.equal((await app.skin('uploads',input)).status,400);
  assert.equal((await app.skin('jobs',request({model:'unknown'}))).status,400);
  assert.equal((await app.skin('jobs',request({eyeTemplate:'eye_C'}))).status,400);
  assert.equal((await app.skin('state')).jobs.length,0);
});

test('真实 skill 制作 PNG、分层图和清单，重复请求幂等，导出可回读',async t=>{
  const calls=[];const app=await fixture(t,{complete:async(messages,options)=>{calls.push({messages,options});return{text:JSON.stringify(pixelPlan())};}});await app.enable();
  const character=await app.api('/api/characters',{name:'皮肤验收角色',description:'紫色衣装、柔和的紫瞳。'});
  const payload=request({characterId:character.character.id});
  const first=await app.skin('jobs',payload);assert.equal(first.httpStatus,200);assert.ok(first.id);
  assert.equal((await app.skin('jobs',payload)).id,first.id);
  assert.equal((await app.skin('jobs',{...payload,instruction:'另一个请求'})).status,409);
  const job=await finished(app,first.id);assert.equal(job.status,'completed',job.error);assert.equal(job.validation.passed,true);assert.equal(job.validation.game_runtime_verified,false);
  assert.equal(calls.length,1);assert.equal(calls[0].options.skill.name,'minecraft-pixel-skin');
  const skin=await fetch(app.url+job.files['skin.png']);assert.equal(skin.headers.get('content-type'),'image/png');const bytes=Buffer.from(await skin.arrayBuffer());assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(bytes.readUInt32BE(16),64);assert.equal(bytes.readUInt32BE(20),64);
  const manifest=await fetch(app.url+job.files['manifest.json']).then(response=>response.json());assert.equal(manifest.png_readback_verified,true);assert.equal(manifest.game_runtime_verified,false);
  const snapshot=JSON.parse(calls[0].messages.at(-1).content).character;
  assert.equal(snapshot.description,'紫色衣装、柔和的紫瞳。');
  assert.deepEqual(job.characterSnapshot,snapshot);
  assert.deepEqual(manifest.provenance.characterSnapshot,snapshot);
  assert.equal(manifest.output_sha256,createHash('sha256').update(bytes).digest('hex'));
  const download=await fetch(app.url+job.files['skin.png']+'?download=1');assert.match(download.headers.get('content-disposition'),/attachment/);
  const state=await app.api('/api/state');assert.ok(state.characters[0].assets.some(asset=>asset.moduleId==='mc-skin'&&asset.kind==='skin'));
  assert.equal((await app.skin('jobs/'+job.id+'/approve',{})).approved,true);
  assert.equal((await app.skin('files/'+job.id+'/%2e%2e%2fworkbench.sqlite')).status,400);
});

test('继续修改保存新版本，旧 PNG 与源上传保持原样',async t=>{
  let count=0;const app=await fixture(t,{complete:async()=>({text:JSON.stringify(count++?{palette:{X:[20,180,150,255]},surfaces:[{face:'body.front',base:['X.......','........','........','........','........','........','........','........','........','........','........','........']}],eyePalette:{}}:pixelPlan())})});await app.enable();
  const first=await finished(app,(await app.skin('jobs',request())).id);assert.equal(first.status,'completed',first.error);
  const before=Buffer.from(await fetch(app.url+first.files['skin.png']).then(response=>response.arrayBuffer()));
  const upload=await app.skin('uploads',{fileName:'original.png',kind:'skin',model:'slim',base64:before.toString('base64')});assert.equal(upload.status,200);assert.equal(upload.validation.passed,true);
  const second=await finished(app,(await app.skin('jobs',request({parentId:first.id,eyeTemplate:null,instruction:'只修改身体正面左上角一格为绿色，其余不变。'}))).id);
  assert.equal(second.status,'completed',second.error);assert.equal(second.parentId,first.id);assert.equal(second.version,2);
  const manifest=await fetch(app.url+second.files['manifest.json']).then(response=>response.json());assert.equal(manifest.changed_pixels.length,1);
  assert.deepEqual(Buffer.from(await fetch(app.url+first.files['skin.png']).then(response=>response.arrayBuffer())),before);
  assert.deepEqual(Buffer.from(await fetch(app.url+upload.url).then(response=>response.arrayBuffer())),before);
});

test('制作失败不发布成功产物，取消中的 AI 返回不能改写取消状态',async t=>{
  let release;const wait=new Promise(done=>{release=done;});
  const app=await fixture(t,{complete:async()=>{await wait;return{text:JSON.stringify(pixelPlan())};}});await app.enable();
  const job=await app.skin('jobs',request());assert.ok(job.id);
  const cancelled=await app.skin('jobs/'+job.id+'/cancel',{});assert.equal(cancelled.status,'cancelled');release();
  await new Promise(done=>setTimeout(done,150));assert.equal((await app.skin('jobs/'+job.id)).status,'cancelled');
  assert.deepEqual((await app.skin('jobs/'+job.id)).files,{});
});

test('非法像素方案失败后仍可发起有效制作',async t=>{
  let count=0;const app=await fixture(t,{complete:async()=>({text:count++?JSON.stringify(pixelPlan()):'{bad json'})});await app.enable();
  const failed=await finished(app,(await app.skin('jobs',request())).id);assert.equal(failed.status,'failed');assert.deepEqual(failed.files,{});
  const next=await finished(app,(await app.skin('jobs',request())).id);assert.equal(next.status,'completed',next.error);
});

test('皮肤上传作为真实视觉输入传给 AI，不接受其他任务的来源身份',async t=>{
  let captured;const app=await fixture(t,{complete:async(_messages,options)=>{captured=options;return{text:JSON.stringify(pixelPlan())};}});await app.enable();
  const first=await finished(app,(await app.skin('jobs',request())).id);const png=Buffer.from(await fetch(app.url+first.files['skin.png']).then(response=>response.arrayBuffer()));
  const upload=await app.skin('uploads',{fileName:'reference.png',kind:'reference',base64:png.toString('base64')});assert.equal(upload.status,200);
  const next=await finished(app,(await app.skin('jobs',request({referenceIds:[upload.id]}))).id);assert.equal(next.status,'completed',next.error);assert.equal(captured.images.length,1);assert.ok(captured.images[0].path.endsWith('.png'));
  assert.equal((await app.skin('jobs',request({sourceId:randomUUID()}))).status,404);
});

test('冷启动同时提交同一请求只调用一次 AI，不同请求保持互斥',async t=>{
  let calls=0,release;const waiting=new Promise(done=>{release=done;});
  const app=await fixture(t,{complete:async()=>{calls++;await waiting;return{text:JSON.stringify(pixelPlan())};}});await app.enable();t.after(()=>release());
  const payload=request();let first,second;
  try{[first,second]=await Promise.all([app.skin('jobs',payload),app.skin('jobs',Object.fromEntries(Object.entries(payload).reverse()))]);
    assert.equal(first.httpStatus,200);assert.equal(second.httpStatus,200);assert.equal(first.id,second.id);
    assert.equal((await app.skin('jobs',request())).httpStatus,409);
  }finally{release();}
  assert.equal((await finished(app,first.id)).status,'completed');assert.equal(calls,1);assert.equal((await app.skin('state')).jobs.length,1);
});

test('配置中的原皮肤导入实际解码检查，保留本地源文件',async t=>{
  const app=await fixture(t);await app.enable();assert.equal((await app.skin('import-configured',{model:'slim'})).httpStatus,400);
  const job=await finished(app,(await app.skin('jobs',request())).id);assert.equal(job.status,'completed',job.error);
  const path=join(app.directory,'mc-skin','jobs',job.id,'output','skin.png'),before=await readFile(path);
  assert.equal((await app.api('/api/modules/mc-skin/config',{values:{skinPath:path}},'PUT')).httpStatus,200);
  const imported=await app.skin('import-configured',{model:'slim'});assert.equal(imported.httpStatus,200);assert.equal(imported.validation.passed,true);
  assert.deepEqual(await readFile(path),before);assert.deepEqual(Buffer.from(await fetch(app.url+imported.url).then(response=>response.arrayBuffer())),before);
  assert.equal((await app.skin('state')).jobs.length,1);
});

test('启动恢复未完成记录为 interrupted，保留历史且不重新调用 AI',async t=>{
  const app=await fixture(t);await app.enable();const original=await finished(app,(await app.skin('jobs',request())).id);assert.equal(original.status,'completed',original.error);
  await app.close();const db=new DatabaseSync(join(app.directory,'workbench.sqlite'));
  const pending={...original,id:randomUUID(),requestId:randomUUID(),status:'designing',files:{}};
  db.prepare('INSERT INTO mc_skin_jobs VALUES(?,?,?)').run(pending.id,pending.requestId,JSON.stringify(pending));db.close();
  let calls=0;const restarted=await createWorkbench({dataDir:app.directory,skinOptions:{complete:async()=>{calls++;throw new Error('禁止自动重提');}}});
  try{const state=await fetch(restarted.url+'/api/modules/mc-skin/state').then(response=>response.json());assert.equal(state.jobs.find(job=>job.id===pending.id).status,'interrupted');assert.equal(state.jobs.find(job=>job.id===original.id).status,'completed');assert.equal(calls,0);}
  finally{await restarted.close();}
});
