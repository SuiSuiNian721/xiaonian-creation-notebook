import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createWorkbench } from '../framework/server.mjs';
import { invokeTool } from '../framework/character-life/tools.mjs';
import { installCharacterPackages } from './helpers/character-packages.mjs';

test('分层记忆 HTTP 概览只读不启动AI，摘要修正有版本保护，来源只能由宿主排队',async t=>{
  const path=await mkdtemp(join(tmpdir(),'life-memory-http-'));let calls=0;
  const app=await createWorkbench({dataDir:path,lifeOptions:{sharedAI:{complete:async()=>{calls++;return {text:'{"summary":"自动摘要"}'};}}}});
  t.after(async()=>{await app.close();await rm(path,{recursive:true,force:true});});
  const request=async(route,value)=>{const response=await fetch(app.url+route,{method:value===undefined?'GET':'POST',headers:value===undefined?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:response.status,value:await response.json()};};
  const {value:{character}}=await request('/api/characters',{name:'分层记忆'}),base=`/api/characters/${character.id}/life`;
  const overview=await request(base+'/memory/overview?moduleId=qq&conversationId=one');
  assert.equal(overview.status,200);assert.equal(overview.value.summary,null);assert.deepEqual(overview.value.subjects,[]);assert.equal(calls,0);
  assert.equal((await request(base+'/memory/overview?subjectKey=someone-else')).status,404);
  const summary=await request(base+'/memory/summary',{moduleId:'qq',conversationId:'one',content:'手动摘要',revision:0});
  assert.equal(summary.status,200);assert.equal(summary.value.summary.revision,1);
  assert.equal((await request(base+'/memory/summary',{moduleId:'qq',conversationId:'one',content:'旧版修改',revision:0})).status,409);
  assert.equal((await request(base+'/memory/organize',{moduleId:'qq',conversationId:'one',sources:[{input:'伪造历史'}]})).status,400);
  assert.equal((await request(base+'/memory/organize',{moduleId:'qq',conversationId:'one'})).status,200);assert.equal(calls,0);
  assert.equal((await request(base+'/memory/organize',{moduleId:'qq',retry:true})).status,200);
  assert.equal((await request(base+'/memory/organize',{moduleId:'qq',retry:'yes'})).status,400);
  const view=await request(base+'?moduleId=qq&conversationId=one');assert.equal(view.value.memoryOverview.summary.content,'手动摘要');
});

test('视觉与公开表情HTTP状态支持精简模式，临时测试不保存或泄漏密钥',async t=>{
  const path=await mkdtemp(join(tmpdir(),'life-media-http-'));
  const app=await createWorkbench({dataDir:path,lifeOptions:{fetchImpl:async()=>Response.json({data:[{id:'local',input_modalities:['text','image']}]})}});
  t.after(async()=>{await app.close();await rm(path,{recursive:true,force:true});});
  const request=async(route,value)=>{const response=await fetch(app.url+route,{method:value===undefined?'GET':'POST',headers:value===undefined?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:response.status,value:await response.json()};};
  const {value:{character}}=await request('/api/characters',{name:'媒体角色',raw:{name:'媒体角色'}});
  const base=`/api/characters/${character.id}/life`;
  const state=await request(base+'/vision/status?moduleId=qq');assert.equal(state.status,200);assert.equal(state.value.native.status,'unknown');assert.equal(state.value.local.status,'disabled');
  const catalog=await request(base+'/memes/catalog');assert.equal(catalog.status,200);assert.equal(catalog.value.count,322);assert.equal(catalog.value.stickers,undefined);
  const tested=await request(base+'/vision/test',{media:{localVisionEnabled:true,localVisionBaseUrl:'http://localhost:50708/v1',localVisionModel:'local',localVisionKey:'private-key'}});
  assert.equal(tested.status,200);assert.equal(tested.value.local.status,'available');assert.equal(tested.value.local.evidence,'metadata');assert.equal(JSON.stringify(tested.value).includes('private-key'),false);
  assert.equal((await request(base)).value.settings.media.localVisionEnabled,false);
});

test('角色系统 HTTP：版本冲突、隔离文档、持久化及同源保护',async t=>{
  const path=await mkdtemp(join(tmpdir(),'life-http-'));let app=await createWorkbench({dataDir:path});
  t.after(async()=>{await app.close();await rm(path,{recursive:true,force:true});});
  await installCharacterPackages(app.url);
  const request=async(route,value,method=value===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+route,{method,headers:value===undefined?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
    return {status:response.status,value:await response.json()};
  };
  const {value:{character}}=await request('/api/characters',{name:'小杏',description:'喜欢花园',raw:{data:{name:'小杏',description:'喜欢花园',unknown:{preserve:1}}}});
  const base=`/api/characters/${character.id}/life`;
  assert.equal((await request(base)).value.settings.enabled,true);
  const sharedView=await request(base+'?moduleId=companion&conversationId=');
  assert.equal(sharedView.status,200);assert.equal(sharedView.value.state.scope,'shared');assert.equal(sharedView.value.decision.environment,'private');
  assert.equal((await request(base+'/state',{state:{mood:'期待',variables:{好感:20}}})).status,200);
  assert.equal((await request(base+'/profile',{revision:character.revision,name:'小杏',description:'喜欢花园',raw:character.raw})).value.character.revision,2);
  assert.equal((await request(base+'/profile',{revision:1,raw:character.raw})).status,409);
  assert.equal((await request(base+'/memories',{content:'约好去花园',kind:'plan',pinned:true})).status,200);
  assert.equal((await request(base+'/preview',{text:'花园'})).status,200);
  assert.equal((await request(base+'/settings',{mode:'full',runtime:{scriptsEnabled:true}})).status,200);
  const frame=await request(base+'/frame',{html:'<p>状态栏</p><script>window.test=1</script>'});
  const response=await fetch(app.url+frame.value.url);
  assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);
  const preview=await request(base+'/scripts/preview',{code:'const v = getVariables(); v.好感 += 1; replaceVariables(v); return v.好感;'});
  assert.equal(preview.status,200);assert.equal(preview.value.variables.好感,21);
  assert.equal((await request(base)).value.state.variables.好感,20);
  assert.equal((await request(base+'/settings',undefined)).status,405);
  // 原生渲染器来自 file:；只有带图片签名的只读地址允许跨源读取。
  const fixtureDb=new DatabaseSync(join(path,'workbench.sqlite'));
  const imageId='fixture-image',imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKK0AAAAASUVORK5CYII=','base64');
  const key=JSON.parse(fixtureDb.prepare('SELECT value FROM settings WHERE name=?').get('ai.internalToken').value);
  fixtureDb.prepare('INSERT INTO drawing_images VALUES(?,?)').run(imageId,JSON.stringify({id:imageId,filename:'fixture.png',mime:'image/png'}));fixtureDb.close();
  await mkdir(join(path,'drawing','images'),{recursive:true});await writeFile(join(path,'drawing','images','fixture.png'),imageBytes);
  const signature=createHmac('sha256',key).update('character-image:'+imageId).digest('hex');
  const media=await fetch(app.url+`/internal/character-media/${imageId}/${signature}`,{headers:{Origin:'null','Sec-Fetch-Site':'cross-site'}});
  assert.equal(media.status,200);assert.equal(media.headers.get('cross-origin-resource-policy'),'cross-origin');assert.deepEqual(Buffer.from(await media.arrayBuffer()),imageBytes);
  assert.equal((await fetch(app.url+`/internal/character-media/${imageId}/${'0'.repeat(64)}`)).status,403);
  const cross=await fetch(app.url+base+'/state',{method:'POST',headers:{origin:'https://unrelated.example','content-type':'application/json'},body:JSON.stringify({state:{mood:'不该保存'}})});
  assert.equal(cross.status,403);
  await app.close();app=await createWorkbench({dataDir:path});
  const reopened=(await request(base)).value;
  assert.equal(reopened.state.mood,'期待');assert.equal(reopened.memories.length,1);assert.equal(reopened.character.raw.data.unknown.preserve,1);
});

test('HTTP 工具真实请求保留凭证在服务端，参数校验和重定向限制生效',async t=>{
  let received;
  const server=createServer(async(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/tool'});res.end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    received={authorization:req.headers.authorization,body:JSON.parse(body)};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({url:'https://media.example/result.png'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const tool={enabled:true,url:`http://127.0.0.1:${server.address().port}/tool`,method:'POST',headers:{Authorization:'Bearer private'},inputSchema:{type:'object',required:['query'],properties:{query:{type:'string'}},additionalProperties:false}};
  assert.equal((await invokeTool(tool,{query:'杏花'})).url,'https://media.example/result.png');
  assert.deepEqual(received,{authorization:'Bearer private',body:{query:'杏花'}});
  await assert.rejects(invokeTool(tool,{wrong:'field'}),/缺少/);
  await assert.rejects(invokeTool({...tool,url:tool.url.replace('/tool','/redirect')},{query:'x'}),/调用失败/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(invokeTool(tool,{query:'x'},{signal:controller.signal}),/取消/);
});
