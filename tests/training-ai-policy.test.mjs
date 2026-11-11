import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {SharedAI} from '../framework/shared-ai.mjs';
import {WorkbenchStore} from '../framework/store.mjs';

test('训练视觉沿用受限策略及模块模型，不能附加技能或借用其他模块',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'training-ai-policy-')),store=new WorkbenchStore(directory),calls=[];
  const ai=new SharedAI({store,dataDir:directory,codexRunner:async value=>{calls.push(value);return{text:'caption'};}});await ai.initialize();
  t.after(async()=>{ai.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  ai.save({provider:'codex',enabled:true,model:'global'});ai.saveModule('training',{mode:'module',connection:{model:'training-vision'}});
  const images=[{path:join(directory,'prepared.png'),mime:'image/png'}];
  await ai.complete([{role:'user',content:'描述训练图片'}],{moduleId:'training',policy:'chat-only-vision',images});
  assert.equal(calls[0].model,'training-vision');assert.equal(calls[0].policy,'chat-only-vision');assert.deepEqual(calls[0].images,images);
  assert.equal(calls[0].allowWrite,false);assert.ok(calls[0].cwd.endsWith(join('training','ai-workspace')));
  await assert.rejects(ai.complete([{role:'user',content:'x'}],{moduleId:'training',policy:'chat-only-vision',images,skill:{name:'x',path:'x'}}),/策略/);
  await assert.rejects(ai.complete([{role:'user',content:'x'}],{moduleId:'drawing',policy:'chat-only-vision',images}),/策略/);
});

test('兼容接口的训练视觉请求包含实际图片数据',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'training-ai-api-')),store=new WorkbenchStore(directory),calls=[];
  const ai=new SharedAI({store,dataDir:directory,fetchImpl:async(_url,options)=>{calls.push(JSON.parse(options.body));return Response.json({choices:[{message:{content:'red coat, standing, outdoors'}}]});}});await ai.initialize();
  t.after(async()=>{ai.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  ai.save({provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:12345/v1',model:'vision-fixture'});
  const path=join(directory,'prepared.png');await writeFile(path,Buffer.from('prepared-image'));
  await ai.complete([{role:'user',content:'描述图片'}],{moduleId:'training',policy:'chat-only-vision',images:[{path,mime:'image/png'}]});
  assert.equal(calls[0].messages[0].content[1].image_url.url,'data:image/png;base64,cHJlcGFyZWQtaW1hZ2U=');
});
