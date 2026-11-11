import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import * as diagnostics from '../framework/codex-diagnostics.mjs';
import {SharedVoice} from '../framework/voice.mjs';
import {createWorkbench} from '../framework/server.mjs';

test('Codex diagnostics distinguish absent CLI, login, auth method and command failure without returning raw secrets',async()=>{
  const inspect=diagnostics.inspectCodexCli;
  assert.equal(typeof inspect,'function');
  const missing=await inspect({cli:'missing-cli',run:async()=>{throw Object.assign(new Error('secret'),{code:'ENOENT'});}});
  assert.equal(missing.status,'not-installed');assert.match(missing.detail,/安装/);
  const run=login=>async(_cli,args)=>args[0]==='--version'?{stdout:'codex-cli 0.1.2'}:login();
  const notLogged=await inspect({cli:'fixture',run:run(()=>{throw {stderr:'Not logged in token=secret'};})});
  assert.equal(notLogged.status,'not-logged-in');assert.match(notLogged.detail,/登录/);assert.doesNotMatch(JSON.stringify(notLogged),/token=secret/);
  const ready=await inspect({cli:'fixture',run:run(()=>({stdout:'Logged in using ChatGPT'}))});
  assert.equal(ready.status,'ready');assert.equal(ready.version,'codex-cli 0.1.2');
  const wrong=await inspect({cli:'fixture',run:run(()=>({stderr:'Logged in using an API key: sk-secret'}))});
  assert.equal(wrong.status,'unsupported-auth');assert.doesNotMatch(JSON.stringify(wrong),/sk-secret/);
  const broken=await inspect({cli:'fixture',run:async()=>{throw {code:'ETIMEDOUT',stderr:'private'};}});
  assert.equal(broken.status,'unverified');assert.doesNotMatch(JSON.stringify(broken),/private/);
});

test('workbench diagnostics routes expose read-only CLI status and voice logs with normal method and origin checks',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'workbench-diagnostics-'));
  const app=await createWorkbench({dataDir:directory,instances:false,aiOptions:{codexDiagnostics:async()=>({status:'not-installed',cli:'fixture',detail:'未安装'})}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const cli=await fetch(app.url+'/api/ai/codex/status');assert.equal(cli.status,200);assert.equal((await cli.json()).status,'not-installed');
  const logs=await fetch(app.url+'/api/voice/logs');assert.equal(logs.status,200);assert.deepEqual((await logs.json()).entries,[]);
  assert.equal((await fetch(app.url+'/api/voice/logs',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,405);
  assert.equal((await fetch(app.url+'/api/ai/codex/status',{headers:{origin:'https://example.com'}})).status,403);
});

test('voice logs are bounded, newest first, redact credentials and do not include unrelated files',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-diagnostics-'));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const voice=new SharedVoice({store:{},dataDir:directory});t.after(()=>voice.close());
  assert.equal(typeof voice.logs,'function');
  assert.deepEqual((await voice.logs()).entries,[]);
  const logs=join(directory,'shared-voice','logs');await mkdir(logs,{recursive:true});
  await writeFile(join(logs,'100-a.stderr.log'),'old');
  await writeFile(join(logs,'200-a.stderr.log'),'x'.repeat(30000)+'\nAuthorization: Bearer private-token\napi_key="private-key"\n缺少模型文件');
  await writeFile(join(logs,'private.json'),'do not read');
  const result=await voice.logs();
  assert.equal(result.entries[0].name,'200-a.stderr.log');assert.ok(result.entries[0].truncated);
  assert.match(result.entries[0].text,/缺少模型文件/);assert.doesNotMatch(JSON.stringify(result),/private-token|private-key|do not read/);
  assert.ok(result.entries[0].text.length<17000);
});
