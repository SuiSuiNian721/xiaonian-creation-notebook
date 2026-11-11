import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createWorkbench} from '../framework/server.mjs';
import {QQStore} from '../framework/qq-store.mjs';
import {parseQQCharacter} from '../framework/qq-character.mjs';
import {scopeInstanceLinks} from '../framework/module-instances.mjs';
import {InstanceCoordination} from '../framework/instance-coordination.mjs';

async function until(predicate){const deadline=Date.now()+3000;while(!await predicate()){if(Date.now()>deadline)throw new Error('模拟任务等待超时');await new Promise(resolve=>setTimeout(resolve,5));}}

async function fixture(t,options={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'workbench-instances-'));
  const app=await createWorkbench({dataDir,...options});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+path,{method,headers:value===undefined?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
    return {status:response.status,...await response.json()};
  };
  return {app,api,dataDir};
}

test('实例明确沿用工作台 AI 时读取根配置，自定义覆盖和更新互不串用',async t=>{
  const {api}=await fixture(t);
  await api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'root-model',apiKey:'fixture-secret'},'PUT');
  const a=(await api('/api/instances',{moduleId:'qq'})).instance,b=(await api('/api/instances',{moduleId:'qq'})).instance;
  const path=id=>'/instances/'+id+'/api/ai/modules/qq/config';
  const inherited=await api(path(a.id),{mode:'global'},'PUT');assert.equal(inherited.effective.model,'root-model');assert.equal(inherited.effective.hasKey,true);
  await api(path(b.id),{mode:'module',connection:{model:'b-model'}},'PUT');
  await api('/api/ai/config',{model:'root-new'},'PUT');
  assert.equal((await api(path(a.id))).effective.model,'root-new');assert.equal((await api(path(b.id))).effective.model,'b-model');
  assert.equal((await api('/instances/'+a.id+'/api/ai/config',{model:'illegal-root-change'},'PUT')).status,409);
  assert.equal((await api('/api/ai/config')).model,'root-new');
});

test('迁移等待在途旧保存完成，迁移后旧写卡器不能自动启动或写入',async t=>{
  const {app,api}=await fixture(t);await api('/api/modules/voice/enable',{});await api('/api/modules/cards/enable',{});
  const payload=JSON.stringify({values:{serviceUrl:'http://127.0.0.1:8999'}});
  let finish;
  const pending=new Promise((resolve,reject)=>{const req=httpRequest(app.url+'/api/modules/voice/config',{method:'PUT',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(payload.slice(0,10));finish=()=>req.end(payload.slice(10));});
  await new Promise(resolve=>setTimeout(resolve,30));
  try{assert.equal((await api('/api/instances/migrate-legacy',{})).status,409);}finally{finish();}
  assert.equal(await pending,200);
  const migration=await api('/api/instances/migrate-legacy',{});assert.equal(migration.status,200);
  assert.equal((await api('/card-studio/api/new',{name:'must-not-write'})).status,409);
  assert.equal((await api('/card-studio/api/cards')).status,409);
  const voice=migration.instances.find(item=>item.moduleId==='voice');await api('/api/instances/'+voice.id+'/start',{});
  assert.equal((await api('/instances/'+voice.id+'/api/state')).modules.find(item=>item.id==='voice').config.serviceUrl,'http://127.0.0.1:8999');
});

test('旧写卡器 GET 冷启动期间不能迁移，避免启动后的迟到初始化写入',async t=>{
  const {api,dataDir}=await fixture(t);await api('/api/modules/cards/enable',{});
  const starting=api('/card-studio/api/cards');await until(()=>existsSync(join(dataDir,'card-studio')));
  const migration=await api('/api/instances/migrate-legacy',{});assert.equal(migration.status,409);
  assert.equal((await starting).status,200);
});

test('实例通过固定 HTTP 路由隔离配置、人设与事件，关闭标签不停止后台',async t=>{
  const {api}=await fixture(t);
  assert.deepEqual((await api('/api/instances')).instances,[]);
  const a=(await api('/api/instances',{moduleId:'qq',name:'QQ A'})).instance;
  const b=(await api('/api/instances',{moduleId:'qq',name:'QQ B'})).instance;
  assert.ok(a?.id&&b?.id&&a.id!==b.id);
  const scope=id=>'/instances/'+id;
  assert.equal((await api(scope(a.id)+'/api/modules/qq/config',{values:{accountId:'123456'}},'PUT')).status,200);
  const sa=await api(scope(a.id)+'/api/state'),sb=await api(scope(b.id)+'/api/state');
  assert.equal(sa.modules.find(x=>x.id==='qq').config.accountId,'123456');
  assert.equal(sb.modules.find(x=>x.id==='qq').config.accountId,'');
  assert.deepEqual(sa.modules.filter(x=>x.enabled).map(x=>x.id),['qq']);
  const original=(await api('/api/characters',{name:'资料库角色',raw:{name:'原卡'}})).character;
  const copied=await api('/api/instances/'+a.id+'/persona',{source:'library',characterId:original.id});
  assert.equal(copied.status,200);assert.notEqual(copied.character.id,original.id);
  assert.equal((await api(scope(b.id)+'/api/state')).characters.length,0);
  assert.equal((await api('/api/state')).selectedCharacterId,null);
  await api('/api/instances/'+a.id,{tabOpen:false},'PATCH');
  assert.equal((await api('/api/instances')).instances.find(x=>x.id===a.id).status,'running');
  await api('/api/instances/'+a.id+'/stop',{});
  assert.equal((await api('/api/instances')).instances.find(x=>x.id===a.id).status,'stopped');
  assert.equal((await api('/api/instances')).instances.find(x=>x.id===b.id).status,'running');
  assert.equal((await api(scope(a.id)+'/api/state')).status,409);
  await api('/api/instances/'+a.id+'/start',{});
  assert.equal((await api(scope(a.id)+'/api/state')).selectedCharacterId,copied.character.id);
  assert.equal((await api(scope(a.id)+'/api/modules/mc-play/enable',{})).status,409);
});

test('删除实例保留归档，重启注册表保留实例 ID 和关闭标签状态',async t=>{
  const {app,api,dataDir}=await fixture(t);
  const a=(await api('/api/instances',{moduleId:'voice'})).instance;
  const b=(await api('/api/instances',{moduleId:'training'})).instance;
  await api('/api/instances/'+b.id,{tabOpen:false},'PATCH');
  assert.equal((await api('/api/instances/'+a.id,undefined,'DELETE')).status,200);
  assert.equal((await api('/instances/'+a.id+'/api/state')).status,404);
  await app.close();
  const reopened=await createWorkbench({dataDir});
  const response=await fetch(reopened.url+'/api/instances');const state=await response.json();
  assert.equal(state.instances.length,1);assert.equal(state.instances[0].id,b.id);assert.equal(state.instances[0].tabOpen,false);
  await reopened.close();
});

test('旧数据迁移只映射对应模块记忆与 QQ 绑定，备份完整且重复请求幂等',async t=>{
  const {api,app,dataDir}=await fixture(t);
  await api('/api/modules/qq/enable',{});await api('/api/modules/companion-lite/enable',{});
  const selected=(await api('/api/characters',{name:'全局旧角色'})).character;
  const qqCharacter=(await api('/api/characters',{name:'QQ 已绑定角色'})).character;
  app.context.store.selectCharacter(selected.id);
  const qq=new QQStore(dataDir);qq.saveBinding(parseQQCharacter(qqCharacter));qq.close();
  app.context.life.data.put(qqCharacter.id,'memory',{id:'qq-only',scope:'qq:conversation-a',content:'QQ 记忆'});
  app.context.life.data.put(selected.id,'memory',{id:'lite-only',scope:'companion-lite:default',content:'精简版记忆'});
  app.context.life.data.put(selected.id,'state',{id:'shared',scope:'shared',value:{energy:99}});
  const migrated=await api('/api/instances/migrate-legacy',{});
  assert.equal(migrated.status,200);assert.equal(migrated.instances.length,2);assert.equal(migrated.archivedSharedRecords,1);
  const manifest=JSON.parse(await readFile(migrated.manifestPath,'utf8'));assert.equal(manifest.status,'complete');assert.ok(manifest.files.some(x=>x.path.endsWith('qq.sqlite')&&x.sha256.length===64));
  const q=migrated.instances.find(x=>x.moduleId==='qq'),l=migrated.instances.find(x=>x.moduleId==='companion-lite');
  await api('/api/instances/'+q.id+'/start',{});await api('/api/instances/'+l.id+'/start',{});
  assert.equal((await api('/instances/'+q.id+'/api/state')).selectedCharacterId,qqCharacter.id);
  const qlife=app.context.instanceManager.context(q.id).life;
  assert.equal(qlife.data.list(qqCharacter.id,'memory')[0].content,'QQ 记忆');assert.equal(qlife.data.list(selected.id,'memory').length,0);
  const llife=app.context.instanceManager.context(l.id).life;
  assert.equal(llife.data.list(selected.id,'memory')[0].content,'精简版记忆');assert.equal(llife.data.list(selected.id,'state').length,0);
  assert.equal((await api('/api/instances/migrate-legacy',{})).alreadyMigrated,true);
  assert.equal(app.context.store.state().characters.length,2);
  assert.equal(app.context.life.timer,null);
  assert.equal((await api('/api/characters/select',{id:selected.id})).status,409);
  assert.equal((await api('/api/modules/qq/connect',{})).status,409);
});

test('复制停止实例的人设保留声明初值与规则，不复制秘密、记忆或当前状态；文件导入直接绑定新副本',async t=>{
  const {api,app}=await fixture(t);
  const a=(await api('/api/instances',{moduleId:'qq'})).instance,b=(await api('/api/instances',{moduleId:'qq'})).instance;
  const imported=await api('/api/instances/'+a.id+'/persona',{source:'file',name:'角色.json',base64:Buffer.from(JSON.stringify({name:'测试角色',extensions:{stat_data:{relationship:99},api_key:'raw-secret',initial:{relationship:2}}})).toString('base64')});
  assert.equal(imported.status,200);const id=imported.character.id,context=app.context.instanceManager.context(a.id);
  context.life.data.put(id,'settings',{id:'settings',value:{variableUpdates:{enabled:true,rules:[{id:'rule',initial:2}]},memory:{embedding:{apiKey:'embedding-secret'}},tools:[{headers:{Authorization:'secret'},url:'https://example.test/tool?token=secret'}]}});
  context.life.data.put(id,'memory',{content:'不要复制记忆'});context.life.data.put(id,'state',{id:'shared',variables:{relationship:99}});
  const memoryRuntimeKinds=['memory-subject','memory-summary','memory-job','memory-covered','memory-clock','memory-tombstone','companion-chat'];
  for(const kind of memoryRuntimeKinds)context.life.data.put(id,kind,{id:'runtime-'+kind,content:'不随人设复制的记忆进展'});
  context.life.data.put(id,'tool',{id:'tool-example',url:'https://example.test/tool?token=secret',headers:{Authorization:'tool-secret'},enabled:true});
  await api('/api/instances/'+a.id+'/stop',{});
  assert.equal((await api('/api/instances/'+a.id)).instance.personaId,id);
  const copied=await api('/api/instances/'+b.id+'/persona',{source:'instance',sourceInstanceId:a.id});
  assert.equal(copied.status,200);assert.notEqual(copied.character.id,id);
  const target=app.context.instanceManager.context(b.id),settings=target.life.data.list(copied.character.id,'settings')[0];
  assert.equal(settings.value.variableUpdates.rules[0].initial,2);assert.ok(!JSON.stringify(settings).includes('secret'));assert.equal(copied.character.raw.extensions.stat_data,undefined);
  const tool=target.life.data.list(copied.character.id,'tool')[0];assert.equal(tool.id,'tool-example');assert.equal(tool.headers,undefined);assert.ok(!tool.url.includes('secret'));
  assert.equal(target.life.data.list(copied.character.id,'memory').length,0);assert.equal(target.life.data.list(copied.character.id,'state').length,0);
  for(const kind of memoryRuntimeKinds)assert.equal(target.life.data.list(copied.character.id,kind).length,0);
  const exported=await api('/api/instances/'+a.id+'/export-persona',{characterId:id});
  for(const kind of ['memory',...memoryRuntimeKinds])assert.equal(app.context.life.data.list(exported.character.id,kind).length,0);
  assert.equal(target.ensureQQ().binding.characterId,copied.character.id);
  assert.equal((await api('/api/instances/'+a.id)).instance.status,'stopped');
});

test('视觉密钥不随实例复制或导出再导入，服务地址和模型声明保留',async t=>{
  const {api,app}=await fixture(t);
  const a=(await api('/api/instances',{moduleId:'qq'})).instance,b=(await api('/api/instances',{moduleId:'qq'})).instance;
  const imported=await api('/api/instances/'+a.id+'/persona',{source:'import',bundle:{name:'视觉角色'}});
  assert.equal(imported.status,200);const source=app.context.instanceManager.context(a.id),id=imported.character.id;
  const declaration={localVisionEnabled:true,localVisionBaseUrl:'http://127.0.0.1:50708/v1',localVisionModel:'local-vision',localVisionKey:'fixture-private-key'};
  source.life.configure(id,{media:declaration});
  const check=(life,characterId)=>{
    const media=life.data.list(characterId,'settings')[0].value.media;
    assert.equal(Object.hasOwn(media,'localVisionKey'),false);
    assert.equal(media.localVisionBaseUrl,declaration.localVisionBaseUrl);assert.equal(media.localVisionModel,declaration.localVisionModel);
    assert.equal(life.config(characterId).media.localVisionKey,'');
  };
  await api('/api/instances/'+a.id+'/stop',{});
  const copied=await api('/api/instances/'+b.id+'/persona',{source:'instance',sourceInstanceId:a.id});
  assert.equal(copied.status,200);check(app.context.instanceManager.context(b.id).life,copied.character.id);
  const exported=await api('/api/instances/'+a.id+'/export-persona',{characterId:id});
  assert.equal(exported.status,200);check(app.context.life,exported.character.id);
  const reimported=await api('/api/instances/'+b.id+'/persona',{source:'library',characterId:exported.character.id});
  assert.equal(reimported.status,200);check(app.context.instanceManager.context(b.id).life,reimported.character.id);
});

test('旧实例迁移同样剔除视觉密钥，保留声明配置和源资料',async t=>{
  const {api,app,dataDir}=await fixture(t);await api('/api/modules/qq/enable',{});
  const character=(await api('/api/characters',{name:'旧视觉角色'})).character;
  const qq=new QQStore(dataDir);qq.saveBinding(parseQQCharacter(character));qq.close();
  const declaration={localVisionEnabled:true,localVisionBaseUrl:'http://127.0.0.1:50708/v1',localVisionModel:'local-vision',localVisionKey:'fixture-private-key'};
  app.context.life.configure(character.id,{media:declaration});
  const migrated=await api('/api/instances/migrate-legacy',{});assert.equal(migrated.status,200);
  const instance=migrated.instances.find(item=>item.moduleId==='qq');await api('/api/instances/'+instance.id+'/start',{});
  const life=app.context.instanceManager.context(instance.id).life,media=life.data.list(character.id,'settings')[0].value.media;
  assert.equal(Object.hasOwn(media,'localVisionKey'),false);assert.equal(life.config(character.id).media.localVisionKey,'');
  assert.equal(media.localVisionBaseUrl,declaration.localVisionBaseUrl);assert.equal(media.localVisionModel,declaration.localVisionModel);
  assert.equal(app.context.life.config(character.id).media.localVisionKey,declaration.localVisionKey);
});

test('共享安装只写入一次且文件损坏使所有实例失效',async t=>{
  let installs=0;const resource={id:'fixture',name:'共享资源',required:true,version:'1',status:'available',sourceLabel:'本机测试',adapterId:'fixture',downloadBytes:2,installedBytes:2};
  const {api}=await fixture(t,{resourceCatalog:{voice:{revision:'1',resources:[resource]}},installationAdapters:{fixture:{async install({directory}){installs++;await writeFile(join(directory,'shared.txt'),'ok');},verify:async({directory})=>(await readFile(join(directory,'shared.txt'),'utf8'))==='ok',verifySync:({directory})=>{try{return readFileSync(join(directory,'shared.txt'),'utf8')==='ok';}catch{return false;}}}}});
  const a=(await api('/api/instances',{moduleId:'voice'})).instance,b=(await api('/api/instances',{moduleId:'voice'})).instance;
  const path=id=>'/instances/'+id+'/api/modules/voice/resources';
  const plan=await api(path(a.id)+'/plan',{optionalIds:[]});
  assert.equal((await api(path(a.id)+'/install',{planId:plan.planId,optionalIds:[]})).status,200);
  await until(async()=>(await api(path(a.id))).prerequisitesReady);
  const shared=await api(path(b.id));assert.equal(shared.prerequisitesReady,true);assert.equal(installs,1);
  await writeFile(join(shared.directory,'shared.txt'),'bad');assert.equal((await api(path(a.id))).prerequisitesReady,false);assert.equal((await api(path(b.id))).prerequisitesReady,false);
});

test('媒体与文件链接进入固定实例范围，卡片文字保持原样',()=>{
  const prefix='/instances/one',result=scopeInstanceLinks({images:[{url:'/api/modules/drawing/images/a'}],files:{'skin.png':'/api/modules/mc-skin/files/job/skin.png'},raw:{text:'/api/user-story'},content:'/api/story'},prefix);
  assert.equal(result.images[0].url,prefix+'/api/modules/drawing/images/a');assert.equal(result.files['skin.png'],prefix+'/api/modules/mc-skin/files/job/skin.png');assert.equal(result.raw.text,'/api/user-story');assert.equal(result.content,'/api/story');
});

test('真实 HTTP 图片只可从所属实例读取，绘图与维护互斥也覆盖入口路由',async t=>{
  const {api,app}=await fixture(t);
  const a=(await api('/api/instances',{moduleId:'drawing'})).instance,b=(await api('/api/instances',{moduleId:'drawing'})).instance;
  for(const item of [a,b])await api('/instances/'+item.id+'/api/modules/drawing/config',{values:{serviceUrl:'http://127.0.0.1:8188'}},'PUT');
  const context=app.context.instanceManager.context(a.id),imageId=randomUUID(),jobId=randomUUID(),bytes=Buffer.from('isolated-image-bytes');
  await mkdir(join(context.drawing.directory,'images'),{recursive:true});await writeFile(join(context.drawing.directory,'images',imageId+'.png'),bytes);
  const image={id:imageId,filename:imageId+'.png',mime:'image/png',url:'/api/modules/drawing/images/'+imageId};
  context.store.db.prepare('INSERT INTO drawing_images VALUES(?,?)').run(imageId,JSON.stringify(image));
  context.store.db.prepare('INSERT INTO drawing_jobs VALUES(?,?,?)').run(jobId,randomUUID(),JSON.stringify({id:jobId,status:'queued',images:[image]}));
  const state=await api('/instances/'+a.id+'/api/modules/drawing/state'),imageUrl=state.jobs[0].images[0].url;
  assert.equal(imageUrl,'/instances/'+a.id+'/api/modules/drawing/images/'+imageId);
  assert.deepEqual(Buffer.from(await (await fetch(app.url+imageUrl)).arrayBuffer()),bytes);
  assert.equal((await api('/instances/'+b.id+'/api/modules/drawing/images/'+imageId)).status,404);
  const blocked=await api('/instances/'+b.id+'/api/modules/drawing/manager/apply',{planId:randomUUID()});assert.equal(blocked.status,409);assert.match(blocked.error,/另一个实例/);
  context.store.db.prepare('DELETE FROM drawing_jobs').run();context.drawingManager.active='fixture-maintenance';
  const submission=await api('/instances/'+b.id+'/api/modules/drawing/jobs',{});assert.equal(submission.status,409);assert.match(submission.error,/维护/);context.drawingManager.active=null;
});

test('两个卡编辑器真实子服务保留独立作品、编码路径与固定 iframe 前缀',async t=>{
  const {api,app}=await fixture(t);
  const a=(await api('/api/instances',{moduleId:'cards'})).instance,b=(await api('/api/instances',{moduleId:'cards'})).instance;
  for(const item of [a,b]){const started=await api('/instances/'+item.id+'/api/modules/cards/studio',{});assert.equal(started.status,200);assert.equal(started.url,'/instances/'+item.id+'/card-studio/');}
  assert.equal((await api('/instances/'+a.id+'/card-studio/api/new',{name:'中文作品'})).status,200);
  assert.equal((await api('/instances/'+a.id+'/card-studio/api/save/'+encodeURIComponent('中文作品'),{kind:'text',key:'description',content:'仅 A 保留'})).status,200);
  assert.deepEqual(await (await fetch(app.url+'/instances/'+b.id+'/card-studio/api/cards')).json(),[]);
  const response=await fetch(app.url+'/instances/'+a.id+'/card-studio/'),html=await response.text();assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');assert.ok(html.includes('/instances/'+a.id+'/card-studio/api/'));assert.match(html,/frame:window.frameElement/);
  await api('/api/instances/'+a.id+'/stop',{});assert.equal((await fetch(app.url+'/instances/'+b.id+'/card-studio/api/cards')).status,200);
});

test('共享 ComfyUI 在提交期间阻止维护，同一 QQ 账号/端口不能重复占用',async()=>{
  const context=()=>({drawing:{config:()=>({serviceUrl:'http://127.0.0.1:8188'}),jobs:()=>[],runtime:{}},drawingManager:{active:null,applying:new Map()}});
  const runtimes=new Map([['a',{context:context()}],['b',{context:context()}]]),coordination=new InstanceCoordination(runtimes);
  let release;const drawing=coordination.run('a','drawing',()=>new Promise(resolve=>{release=resolve;}));
  await assert.rejects(coordination.run('b','maintenance',async()=>{}),/仍在使用/);release();await drawing;
  await coordination.run('b','maintenance',async()=>{});
  coordination.claimQQ('a',{mode:'external',accountId:'10001',wsUrl:'ws://localhost:3001'});
  assert.throws(()=>coordination.claimQQ('b',{mode:'external',accountId:'10001',wsUrl:'ws://localhost:3002'}),/账号或网关/);
  assert.throws(()=>coordination.claimQQ('b',{mode:'external',accountId:'10002',wsUrl:'ws://127.0.0.1:3001'}),/账号或网关/);
  coordination.releaseQQ('a');coordination.claimQQ('b',{mode:'external',accountId:'10001',wsUrl:'ws://localhost:3001'});
  assert.equal(await coordination.allocatePort('a',async()=>31000),31000);await assert.rejects(coordination.allocatePort('b',async()=>31000),/独立端口/);
});

test('共享 ComfyUI 停止期间阻止本实例和其他实例重新提交或启动',async()=>{
  const context=url=>({drawing:{config:()=>({serviceUrl:url}),jobs:()=>[],runtime:{}},drawingManager:{active:null,applying:new Map()}});
  const coordination=new InstanceCoordination(new Map([['a',{context:context('http://127.0.0.1:8188')}],['b',{context:context('http://localhost:8188')}],['c',{context:context('http://127.0.0.1:8288')}]]));
  let release;const stopping=coordination.run('a','stop',()=>new Promise(done=>{release=done;}));
  try{for(const id of ['a','b'])for(const mode of ['drawing','launch','maintenance'])await assert.rejects(coordination.run(id,mode,async()=>{}),/正在停止/);await coordination.run('c','drawing',async()=>{});}
  finally{release();await stopping;}
  await coordination.run('b','drawing',async()=>{});
});

test('两个 HTTP QQ 实例并行使用模拟网关，A 停止后迟到生成不会写入 B 或外发',async t=>{
  const gateways=new Map();let index=0;
  const {api,app}=await fixture(t,{instanceOptionsFactory:({instanceId})=>{
    const number=++index,gateway={accountId:String(10000+number),sockets:[],sends:[],closed:0};gateways.set(instanceId,gateway);
    class Socket extends EventTarget {
      constructor(){super();this.readyState=0;gateway.sockets.push(this);queueMicrotask(()=>{if(this.readyState===3)return;this.readyState=1;this.dispatchEvent(new Event('open'));});}
      send(payload){const request=JSON.parse(payload);let data;if(request.action==='get_login_info')data={user_id:gateway.accountId,nickname:'模拟账号'};else if(request.action==='get_status')data={online:true,good:true};else{gateway.sends.push(request);data={message_id:String(90000+gateway.sends.length)};}queueMicrotask(()=>this.receive({echo:request.echo,status:'ok',retcode:0,data}));}
      receive(value){if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
      close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
    }
    const runtime={config:{mode:'external',accountId:gateway.accountId,wsUrl:'ws://127.0.0.1:'+String(31000+number)},state:()=>({mode:'external',running:false,installation:{status:'missing'},login:{status:'logged_out'},external:{...runtime.config}}),connection:async()=>({wsUrl:runtime.config.wsUrl,token:'mock-token',expectedAccountId:runtime.config.accountId}),configure:async value=>{Object.assign(runtime.config,value);return runtime.state();},stop:async()=>{},close:async()=>{gateway.closed++;}};
    return {qqOptions:{runtime,onebotOptions:{WebSocketImpl:Socket,heartbeatIntervalMs:0,requestTimeoutMs:200,connectTimeoutMs:200,minSendIntervalMs:0}}};
  }});
  const a=(await api('/api/instances',{moduleId:'qq'})).instance,b=(await api('/api/instances',{moduleId:'qq'})).instance;
  let releaseA,callsA=0;
  await api('/api/modules/character-lite/enable',{});
  const plan=await api('/api/modules/character-lite/resources/plan',{optionalIds:[]});
  await api('/api/modules/character-lite/resources/install',{planId:plan.planId,optionalIds:[]});
  await until(async()=>(await api('/api/modules/character-lite/resources')).prerequisitesReady);
  for(const item of [a,b]){
    assert.equal((await api('/api/instances/'+item.id+'/persona',{source:'import',bundle:{name:item.id===a.id?'角色 A':'角色 B',description:'独立实例测试'}})).status,200);
    const controller=app.context.instanceManager.context(item.id).ensureQQ();
    controller.sharedAI={config:()=>({enabled:true}),complete:async()=>item.id===a.id?(callsA++,await new Promise(resolve=>{releaseA=resolve;})):{text:'B 的回复'}};
    assert.equal((await api('/instances/'+item.id+'/api/modules/qq/rules',{privateAllow:['20001'],groupAllow:[],requireMention:true},'PUT')).status,200);
    assert.equal((await api('/instances/'+item.id+'/api/modules/qq/connect',{})).status,200);
    assert.equal((await api('/instances/'+item.id+'/api/modules/qq/replies/start',{})).status,200);
  }
  const emit=(id,content)=>{const gateway=gateways.get(id);gateway.sockets.at(-1).receive({post_type:'message',self_id:gateway.accountId,message_type:'private',user_id:'20001',message_id:'12345',message:[{type:'text',data:{text:content}}]});};
  emit(a.id,'A 的输入');await until(()=>callsA===1);emit(b.id,'B 的输入');await until(()=>gateways.get(b.id).sends.length===1);
  await api('/api/instances/'+a.id+'/stop',{});releaseA({text:'A 的迟到回复'});await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(gateways.get(a.id).sends.length,0);assert.equal(gateways.get(a.id).closed,1);assert.equal(gateways.get(b.id).closed,0);
  const conversations=await api('/instances/'+b.id+'/api/modules/qq/conversations');assert.equal(conversations.conversations.length,1);
  const messages=await api('/instances/'+b.id+'/api/modules/qq/conversations/'+conversations.conversations[0].id+'/messages');
  assert.deepEqual(messages.messages.map(x=>x.content),['B 的输入','B 的回复']);
  assert.equal((await api('/instances/'+b.id+'/api/modules/qq/state')).transport.status,'verified');
});

test('停止 QQ 后台暂时失败时实例仍可管理，第二次停止会重新尝试',async t=>{
  let stops=0,closes=0;
  const runtime={state:()=>({mode:'managed',running:true,installation:{status:'ready'},login:{status:'online',accountId:'70001'},external:{}}),stop:async()=>{if(++stops===1)throw new Error('fixture transient IPC timeout');},close:async()=>{closes++;}};
  const {api}=await fixture(t,{instanceOptionsFactory:()=>({qqOptions:{runtime}})});
  const instance=(await api('/api/instances',{moduleId:'qq'})).instance;
  assert.equal((await api('/api/instances/'+instance.id+'/stop',{})).status,500);
  assert.equal((await api('/instances/'+instance.id+'/api/modules/qq/state')).status,200,'失败后仍能管理原实例');
  assert.equal((await api('/api/instances/'+instance.id+'/stop',{})).status,200);
  assert.equal(stops,2);assert.equal(closes,1);
});

test('迁移提交失败回滚注册表与候选目录，原始数据库仍可读取和重试',async t=>{
  const {api,app}=await fixture(t);
  await api('/api/modules/voice/enable',{});
  const manager=app.context.instanceManager;
  assert.throws(()=>manager.migrate({fault:stage=>{if(stage==='before-commit')throw new Error('模拟磁盘提交失败');}}),/模拟磁盘/);
  assert.deepEqual(manager.list(),[]);assert.equal(app.context.store.module('voice').enabled,true);
  const result=manager.migrate();assert.equal(result.instances.length,1);
});

test('未绑定的旧 QQ 不从全局选择补入人设，迁移后仍保持未绑定',async t=>{
  const {api,app}=await fixture(t);await api('/api/modules/qq/enable',{});
  const character=(await api('/api/characters',{name:'仅属于旧全局选择'})).character;
  app.context.store.selectCharacter(character.id);
  const migrated=await api('/api/instances/migrate-legacy',{}),instance=migrated.instances[0];
  assert.equal(instance.personaId,null);await api('/api/instances/'+instance.id+'/start',{});
  assert.equal((await api('/instances/'+instance.id+'/api/state')).selectedCharacterId,null);
  assert.equal((await api('/instances/'+instance.id+'/api/modules/qq/state')).binding,null);
});

test('迁移后目录仍能添加模块和创建实例，旧模块运行配置继续被阻止',async t=>{
  const {api}=await fixture(t);assert.equal((await api('/api/instances/migrate-legacy',{})).status,200);
  assert.equal((await api('/api/modules/voice/enable',{})).status,200);
  const created=await api('/api/instances',{moduleId:'voice'});assert.equal(created.status,201);
  assert.equal((await api('/api/modules/voice/config',{values:{serviceUrl:'http://127.0.0.1:8000'}},'PUT')).status,409);
  assert.equal((await api('/instances/'+created.instance.id+'/api/modules/voice/config',{values:{serviceUrl:'http://127.0.0.1:8000'}},'PUT')).status,200);
});

test('原生陪伴 scoped 内部入口仅允许受限 null origin 例外，普通 API 仍拒绝',async t=>{
  const {api,app}=await fixture(t);const instance=(await api('/api/instances',{moduleId:'companion'})).instance;
  const internal='/instances/'+instance.id+'/internal/companion/ai/v1/chat/completions';
  const options=await fetch(app.url+internal,{method:'OPTIONS',headers:{origin:'null'}});assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-origin'),'null');
  assert.equal((await fetch(app.url+'/instances/'+instance.id+'/api/state',{headers:{origin:'null'}})).status,403);
  assert.equal((await fetch(app.url+'/instances/'+randomUUID()+'/internal/companion/ai/v1/chat/completions',{method:'OPTIONS',headers:{origin:'null'}})).status,404);
  assert.equal((await fetch(app.url+internal,{method:'POST',headers:{origin:'null','content-type':'application/json',authorization:'Bearer wrong'},body:'{}'})).status,403);
});
