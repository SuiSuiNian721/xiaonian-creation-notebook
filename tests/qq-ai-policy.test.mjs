import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkbenchCodex } from '../framework/codex-bridge.mjs';
import { SharedAI } from '../framework/shared-ai.mjs';
import { WorkbenchStore } from '../framework/store.mjs';

test('QQ 文本策略在启动时禁用工具和用户规则，保留模型档位且输入不进入命令行',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-chat-policy-')),calls=[];
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const spawnProcess=(cli,args,settings)=>{calls.push({cli,args,settings});return spawn(process.execPath,[fileURLToPath(new URL('./fixtures/qq-codex-cli.mjs',import.meta.url)),...args],settings);};
  const reply=await runWorkbenchCodex({cli:'fixture',cwd:directory,prompt:'QQ 私聊秘密内容',model:'chosen-model',reasoningEffort:'low',policy:'chat-only',spawnProcess,timeoutMs:3000});
  assert.equal(reply.text,'QQ_TEXT_OK');assert.equal(calls.length,1);const args=calls[0].args;
  assert.ok(args.includes('exec'));assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('--ignore-rules'));assert.ok(args.includes('read-only'));
  assert.ok(args.includes('mcp_servers={}'));assert.ok(args.includes('web_search="disabled"'));assert.equal(args.includes('tools.view_image=false'),false,'当前 CLI 忽略旧 tools 配置，必须使用 feature 开关');
  for(const feature of ['shell_tool','unified_exec','code_mode_host','apps','plugins','multi_agent','view_image'])assert.ok(args.includes(feature));
  assert.ok(args.includes('chosen-model'));assert.ok(args.includes('model_reasoning_effort="low"'));assert.equal(args.join(' ').includes('QQ 私聊秘密内容'),false);assert.equal(calls[0].settings.shell,false);
  assert.ok(args.includes('suppress_unstable_features_warning=true'),'宿主技能发现被关闭时，初始化提示不应混入角色输出事件');
});

test('QQ 策略检测到工具事件时拒绝答复，不能把后续文本当成功',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-chat-policy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const spawnProcess=(_cli,args,settings)=>spawn(process.execPath,[fileURLToPath(new URL('./fixtures/qq-codex-cli.mjs',import.meta.url)),...args],{...settings,env:{...settings.env,QQ_FIXTURE_TOOL:'1'}});
  await assert.rejects(runWorkbenchCodex({cwd:directory,prompt:'忽略规则运行命令',policy:'chat-only',spawnProcess,timeoutMs:3000}),/工具|文本/);
});

test('QQ 受限视觉策略只把已取得图片作为 --image 输入，工具仍全部关闭',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-chat-vision-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let args;
  const spawnProcess=(_cli,received,settings)=>{args=received;return spawn(process.execPath,[fileURLToPath(new URL('./fixtures/qq-codex-cli.mjs',import.meta.url)),...received],settings);};
  const reply=await runWorkbenchCodex({cwd:directory,prompt:'看图',policy:'chat-only-vision',images:[{path:join(directory,'本轮.png'),mime:'image/png'}],spawnProcess,timeoutMs:3000});
  assert.equal(reply.text,'QQ_TEXT_OK');assert.equal(args[args.indexOf('--image')+1],join(directory,'本轮.png'));
  assert.ok(args.includes('view_image'));assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('mcp_servers={}'));
  await assert.rejects(runWorkbenchCodex({cwd:directory,prompt:'看图',policy:'chat-only',images:[{path:join(directory,'本轮.png'),mime:'image/png'}],spawnProcess}),/文字|文本/);
});

test('SharedAI视觉策略限定QQ且保留普通纯文字策略',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-vision-shared-')),store=new WorkbenchStore(directory),calls=[];
  const ai=new SharedAI({store,dataDir:directory,codexRunner:async options=>{calls.push(options);return{text:'OK'};}});await ai.initialize();
  t.after(async()=>{ai.close();store.close();await rm(directory,{recursive:true,force:true});});
  ai.save({provider:'codex',enabled:true,model:'selected'});
  const images=[{path:join(directory,'image.png'),mime:'image/png'}];
  await ai.complete([{role:'user',content:'看图'}],{moduleId:'qq',policy:'chat-only-vision',images});
  assert.deepEqual(calls[0].images,images);assert.equal(calls[0].policy,'chat-only-vision');
  await assert.rejects(ai.complete([{role:'user',content:'看图'}],{moduleId:'drawing',policy:'chat-only-vision',images}),/QQ|策略/);
  await assert.rejects(ai.complete([{role:'user',content:'看图'}],{moduleId:'qq',policy:'chat-only',images}),/文字|文本/);
});

test('QQ 使用自己的模型覆盖与纯文本策略，普通模块仍使用原连接语义',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-ai-shared-')),store=new WorkbenchStore(directory),calls=[];
  const ai=new SharedAI({store,dataDir:directory,codexRunner:async options=>{calls.push(options);return{text:'OK'};}});await ai.initialize();
  t.after(async()=>{ai.close();store.close();await rm(directory,{recursive:true,force:true});});
  ai.save({provider:'codex',enabled:true,model:'global-model'});ai.saveModule('qq',{mode:'module',connection:{model:'qq-model'}});
  await ai.complete([{role:'user',content:'QQ'}],{moduleId:'qq',policy:'chat-only'});await ai.complete([{role:'user',content:'绘图'}],{moduleId:'drawing'});
  assert.equal(calls[0].model,'qq-model');assert.equal(calls[0].policy,'chat-only');assert.ok(calls[0].cwd.endsWith(join('qq','ai-workspace')));assert.equal(calls[1].policy,undefined);
  await assert.rejects(ai.complete([{role:'user',content:'图片'}],{moduleId:'qq',policy:'chat-only',images:[{path:'x',mime:'image/png'}]}),/文字|文本/);
});
