import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexInputTransport } from '../framework/ai-vision.mjs';

const {runWorkbenchCodex}=await import('../framework/codex-bridge.mjs').catch(error=>{
  if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};
});
const run=options=>{assert.equal(typeof runWorkbenchCodex,'function','工作台需要隔离无关工具的 Codex 调用入口');return runWorkbenchCodex(options);};
async function fixture(t,{servers={},mode='normal'}={}){
  const directory=await mkdtemp(join(tmpdir(),'workbench-codex-config-'));const calls=[];
  const log=join(directory,'messages.jsonl');
  const spawnProcess=(cli,args,options)=>{
    assert.ok(calls.every(call=>call.closed),'读取配置的进程应先退出，再启动生成进程');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/codex-config-cli.mjs',import.meta.url)),...args],{...options,env:{...options.env,CODEX_FIXTURE_SERVERS:JSON.stringify(servers),CODEX_FIXTURE_MODE:mode,CODEX_FIXTURE_LOG:log}});
    const call={cli,args,options,child,closed:false};calls.push(call);child.once('close',()=>{call.closed=true;});return child;
  };
  t.after(async()=>{
    for(const call of calls)if(!call.closed){call.child.kill();await new Promise(done=>call.child.once('close',done));}
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});
  });
  return {directory,calls,spawnProcess,async messages(){return (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}};
}
const options=f=>({cli:'fixture-codex',cwd:f.directory,prompt:'仅回复 OK',model:'retained-model',reasoningEffort:'xhigh',allowWrite:false,ephemeral:true,spawnProcess:f.spawnProcess,configTimeoutMs:2000,timeoutMs:5000});

test('真实 stdio 预检仅读取配置，生成进程单独关闭已配置 MCP 并保留模型档位',async t=>{
  const f=await fixture(t,{servers:{node_repl:{command:'unused'},comfy:{url:'http://unused'}}});const spawned=[];
  const result=await run({...options(f),onSpawn:child=>spawned.push(child)});
  assert.equal(result.text,'OK');assert.equal(f.calls.length,2);assert.equal(spawned.length,1);assert.equal(spawned[0],f.calls[1].child);
  assert.ok(f.calls.every(call=>call.closed));assert.ok(f.calls.every(call=>call.cli==='fixture-codex'&&call.options.cwd===f.directory));
  assert.equal(f.calls[0].args.includes('mcp_servers."node_repl".enabled=false'),false);
  assert.ok(f.calls[1].args.includes('mcp_servers={"node_repl"={enabled=false},"comfy"={enabled=false}}'));
  const messages=await f.messages();const configPid=messages.find(message=>message.args)?.pid;const split=messages.findIndex(message=>message.args&&message.pid!==configPid);
  assert.deepEqual(messages.slice(0,split).filter(message=>message.method).map(message=>message.method),['initialize','initialized','config/read']);
  assert.equal(messages.find(message=>message.method==='config/read').params.includeLayers,false);
  const thread=messages.find(message=>message.method==='thread/start').params,turn=messages.find(message=>message.method==='turn/start').params;
  assert.equal(thread.model,'retained-model');assert.equal(thread.sandbox,'read-only');assert.equal(thread.ephemeral,true);assert.equal(turn.effort,'xhigh');
  assert.equal(messages.some(message=>/config\/(?:value|batchWrite)/.test(message.method||'')),false);
});

test('未配置 MCP 的电脑不注入不存在的服务配置',async t=>{
  const f=await fixture(t);assert.equal((await run(options(f))).text,'OK');
  assert.equal(f.calls[1].args.some(arg=>arg.startsWith('mcp_servers')),false);
});

test('带点、引号与反斜杠的服务名作为完整 TOML 键处理',async t=>{
  const names=['one.two','a"b','c\\d','中文服务'];const f=await fixture(t,{servers:Object.fromEntries(names.map(name=>[name,{}]))});
  await run(options(f));const flag=f.calls[1].args.find(arg=>arg.startsWith('mcp_servers='));
  for(const name of names)assert.ok(flag.includes(`${JSON.stringify(name)}={enabled=false}`));
  assert.equal(f.calls[1].args.some(arg=>arg.startsWith('mcp_servers.')),false,'CLI 按点拆配置路径，不识别路径中的引号；必须使用完整内联表');
});

test('隔离工具后仍传递技能、图片与结构化输出约束',async t=>{
  const f=await fixture(t,{servers:{unrelated:{}}});const input=[{type:'skill',name:'pixel',path:'C:/skill/SKILL.md'},{type:'localImage',path:'C:/reference.png'}];const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok']};
  await run({...options(f),spawnProcess:codexInputTransport(input,{spawnProcess:f.spawnProcess,outputSchema:schema})});
  const turn=(await f.messages()).find(message=>message.method==='turn/start').params;
  assert.deepEqual(turn.input.slice(1),input);assert.deepEqual(turn.outputSchema,schema);
});

for(const mode of ['malformed','invalid-config','rpc-error','oversized'])test(`配置预检 ${mode} 时关闭进程，不调用模型或暴露配置内容`,async t=>{
  const f=await fixture(t,{mode});await assert.rejects(run(options(f)),error=>/Codex.*配置/.test(error.message)&&!error.message.includes('fixture-secret-token'));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].closed,true);
});

test('配置预检超时后确认退出，不继续请求模型',async t=>{
  const f=await fixture(t,{mode:'timeout'});await assert.rejects(run({...options(f),configTimeoutMs:150}),/配置.*超时/);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].closed,true);
});

test('取消配置预检会回收进程，预先取消不启动进程',async t=>{
  const f=await fixture(t,{mode:'timeout'}),controller=new AbortController();const request=run({...options(f),signal:controller.signal});
  setTimeout(()=>controller.abort(),100);await assert.rejects(request,/取消/);assert.equal(f.calls[0].closed,true);
  const before=f.calls.length;await assert.rejects(run({...options(f),signal:controller.signal}),/取消/);assert.equal(f.calls.length,before);
});
