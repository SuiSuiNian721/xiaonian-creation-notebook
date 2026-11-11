import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterLife} from '../framework/character-life/service.mjs';
import {createDrawingTool} from '../framework/character-life/drawing-tool.mjs';
import {LiteCompanion} from '../framework/companion-lite.mjs';

const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
async function fixture(t,answer='完成'){
  const directory=await mkdtemp(join(tmpdir(),'character-audit-regression-')),store=new WorkbenchStore(directory);
  const character=store.saveCharacter(newCharacter({name:'回归角色'}));store.selectCharacter(character.id);
  const life=new CharacterLife({store,dataDir:directory,sharedAI:{complete:async()=>({text:answer})}});
  life.configure(character.id,{memory:{autoExtract:false}});
  t.after(async()=>{await life.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {store,character,life};
}

for(const kind of ['tool_calls','actions'])test('同轮两次绘图有不同 ID，重试保持每次调用 ID：'+kind,async t=>{
  const f=await fixture(t),requests=[];
  const drawing={workflow:()=>({fields:[{key:'6:text',type:'text',input:'text',group:'正向'}]}),async submit(value){requests.push(value);const id='job-'+requests.length;return {id,...value,status:'completed',images:[{id:'image-'+requests.length,jobId:id,url:'/api/modules/drawing/images/image-'+requests.length,mime:'image/png'}]};}};
  f.life.builtinTools.drawing=createDrawingTool({drawing,store:{module:()=>({enabled:true}),getSetting:key=>f.store.getSetting(key),setSetting:(key,value)=>f.store.setSetting(key,value)},baseUrl:()=> 'http://127.0.0.1:19876'});
  const tool=f.life.saveTool(f.character.id,{name:'绘图',kind:'drawing',workflowId:'workflow-1',promptField:'6:text',enabled:true,inputSchema:{type:'object'}});
  f.life.configure(f.character.id,{mode:'full',media:{imageGenerationTool:tool.id}});
  const envelope={reply:'完成',[kind]:['红花','蓝花'].map(prompt=>kind==='tool_calls'?{id:tool.id,arguments:{prompt}}:{type:'image-generate',query:prompt})};
  const args={character:f.character,moduleId:'companion',conversationId:'story',sourceId:'same-turn',text:JSON.stringify(envelope)};
  for(let attempt=0;attempt<2;attempt++)assert.equal((await f.life.processOutput(args)).actions.filter(action=>action.type==='image').length,2);
  assert.equal(requests.length,4);
  assert.notEqual(requests[0].requestId,requests[1].requestId);
  assert.equal(requests[0].requestId,requests[2].requestId);assert.equal(requests[1].requestId,requests[3].requestId);
  assert.deepEqual(requests.map(item=>item.values['6:text']),['红花','蓝花','红花','蓝花']);
});

async function liteFixture(t,answer='[sticker:wave]'){
  const f=await fixture(t,answer),requests=[];
  f.life.configure(f.character.id,{mode:'lite',media:{memes:[{id:'wave',name:'挥手',url:'https://example.invalid/wave.gif',tags:[]}]}});
  const lite=new LiteCompanion({store:f.store,life:f.life,sharedAI:f.life.ai,baseUrl:()=> 'http://127.0.0.1:19876',fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(gif,{headers:{'content-type':'image/gif'}});},packages:{ready:()=>true,require:()=>{},policy:()=>({forcedMode:'lite',prompt:'精简陪伴'})}});
  t.after(()=>lite.close());return {...f,lite,requests};
}

test('纯贴纸回复保存为一轮对话，并可通过同源图片地址回放',async t=>{
  const {lite,life,character,requests}=await liteFixture(t);
  const result=await lite.chat({text:'挥手'});
  assert.equal(result.reply,'');assert.equal(result.messages.length,2);
  const reply=result.messages.find(item=>item.role==='assistant');
  assert.match(reply.actions[0].url,/^\/api\/modules\/companion-lite\/images\//);
  assert.deepEqual(result.actions,reply.actions);
  assert.equal(life.data.get(character.id,'lite-chat',reply.id).actions[0].url,'https://example.invalid/wave.gif');
  const image=await lite.image(character.id,reply.id.slice(0,-6),0);
  assert.equal(image.mime,'image/gif');assert.deepEqual(image.bytes,gif);
  assert.equal(requests[0].options.redirect,'error');
  assert.deepEqual(lite.state().messages.at(-1).actions,reply.actions);
});

test('无正文且没有有效媒体的回复仍拒绝，历史不增加',async t=>{
  const {lite}=await liteFixture(t,'[sticker:unknown]');
  await assert.rejects(lite.chat({text:'挥手'}),/角色回复/);assert.deepEqual(lite.state().messages,[]);
});

test('历史图片只能读取所选角色已保存且仍在允许目录的素材',async t=>{
  const {lite,life,character,requests}=await liteFixture(t,'你好[sticker:wave]');
  const reply=(await lite.chat({text:'挥手'})).messages.at(-1),source=reply.id.slice(0,-6);
  await assert.rejects(lite.image('other-character',source,0));
  await assert.rejects(lite.image(character.id,'not-a-message',0));
  await assert.rejects(lite.image(character.id,source,8));
  const record=life.data.get(character.id,'lite-chat',reply.id);
  life.data.put(character.id,'lite-chat',{...record,actions:[{...record.actions[0],url:'https://attacker.invalid/a.gif'}]});
  await assert.rejects(lite.image(character.id,source,0));
  assert.deepEqual(lite.state().messages.at(-1).actions,[]);assert.equal(requests.length,0);
});

test('图片代理拒绝重定向、非图片与超大内容，并传递取消',async t=>{
  const {lite,character}=await liteFixture(t,'你好[sticker:wave]');
  const reply=(await lite.chat({text:'挥手'})).messages.at(-1),source=reply.id.slice(0,-6);
  for(const response of [new Response('',{status:302,headers:{location:'http://localhost/private'}}),new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}),new Response('not a gif',{headers:{'content-type':'image/gif'}}),new Response(gif,{headers:{'content-type':'image/gif','content-length':String(9*1024*1024)}})]){
    lite.fetch=async()=>response;await assert.rejects(lite.image(character.id,source,0));
  }
  let requested=false;lite.fetch=async()=>{requested=true;return new Response(gif,{headers:{'content-type':'image/gif'}});};
  const controller=new AbortController();controller.abort();await assert.rejects(lite.image(character.id,source,0,controller.signal));assert.equal(requested,false);
});
