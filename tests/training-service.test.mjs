import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

async function fixture(t) {
  const { LoraTraining } = await import('../framework/training.mjs');
  const { TrainingHttpClient } = await import('../framework/training-runtime.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'training-service-'));
  await mkdir(join(directory, 'dataset', '10_character'), { recursive: true });
  const tasks = []; const requests = []; let runs = 0; let starts = 0; let stops = 0;
  const controls = { validation: 'ok', preflight: true, run: 'ok' };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, method: req.method, body });
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let data = {};
    if (req.url === '/api/config/validate-import') data = { result: controls.validation, config: body.config };
    else if (/^\/api\/engines\/[a-z-]+\/status$/.test(req.url)) data = { state: 'ready' };
    else if (/^\/api\/engines\/[a-z-]+\/preflight$/.test(req.url)) { if (controls.waitPreflight) await controls.waitPreflight; data = { ok: controls.preflight, errors: controls.preflight ? [] : controls.preflightErrors || ['fixture rejected'] }; }
    else if (req.url === '/api/run') {
      runs++;
      if (controls.run === 'timeout') { req.socket.destroy(); return; }
      if (controls.run === 'server-error') { res.statusCode = 500; res.end(JSON.stringify({ detail: 'unexpected server error' })); return; }
      if (controls.run === 'reject') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'fail', message: 'run rejected', data: {} })); return; }
      const id = `task-${runs}`;
      tasks.push({ id, status: 'RUNNING', lane: 'compute', metadata: { workbench_owner: req.headers['x-workbench-owner'], workbench_request: req.headers['x-workbench-request'], train_type: body.model_train_type, created_at: Date.now() / 1000, access_token: 'hidden' } });
      if (controls.run === 'timeout-after-accept') { req.socket.destroy(); return; }
      data = { task_id: id, queued: false };
    } else if (req.url === '/api/tasks') data = { tasks };
    else if (req.url?.startsWith('/api/tasks/terminate/')) { const task = tasks.find(item => item.id === req.url.split('/').at(-1)); task.status = 'TERMINATED'; }
    else if (req.url?.endsWith('/metrics')) data = { progress: { step: 2, total: 10 }, timing: { eta_seconds: 4 }, tags: [] };
    else if (req.url?.includes('/train/log/tail/')) data = { lines: ['fixture training log'] };
    else if (req.url?.endsWith('/previews')) data = { images: [] };
    else if (req.url?.endsWith('/config')) data = { config: controls.taskConfig || {} };
    else if (req.url === '/api/hardware/status') data = { gpus: [] };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'success', data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new TrainingHttpClient({ url: `http://127.0.0.1:${server.address().port}`, token: 'test-token', timeoutMs: 1000 });
  const runtime = {
    request: (...args) => client.request(...args), image: (...args) => client.image(...args),
    async start() { starts++; return this.state(); },
    async state() { return { status: 'running', version: 'fixture', kernelRevision: 'fixture', environmentRoot: directory }; },
    async stop() { if(tasks.some(task=>['CREATED','RUNNING','QUEUED'].includes(task.status)))throw new Error('仍有训练任务');stops++; }, async close() { stops++; },
  };
  const config = { model_train_type: 'moss-image-lora', train_data_dir: join(directory, 'dataset'), output_name: 'fixture' };
  const store = { module: () => ({ config: { trainerPath: directory, outputPath: join(directory, 'output') } }) };
  const service = new LoraTraining({ store, dataDir: directory, runtime, instanceId: 'first' });
  const services = [service];
  t.after(async () => {
    for (const item of services) await item.close();
    server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  });
  return { directory, service, services, store, runtime, config, tasks, controls, requests, get runs() { return runs; }, get starts() { return starts; }, get stops() { return stops; } };
}

test('preflight validates result semantics and never submits a training job', async t => {
  const f = await fixture(t);
  f.controls.validation = 'mismatch'; await assert.rejects(f.service.preflight(f.config), /校验/);
  f.controls.validation = 'ok'; f.controls.preflight = false; await assert.rejects(f.service.preflight(f.config), /预检/);
  f.controls.preflight = true; assert.equal((await f.service.preflight(f.config)).training_started, false);
  assert.equal(f.runs, 0);
});

test('embedded engine preflight errors use product wording while keeping actual file paths',async t=>{
  const f=await fixture(t);f.controls.preflight=false;
  f.controls.preflightErrors=['Kohya 环境未就绪，请核对兼容 Next Trainer 安装和 Kohya Python：E:\\Next-Trainer\\python.exe'];
  await assert.rejects(f.service.preflight(f.config),error=>{
    assert.ok(error.message.includes('兼容训练环境'));
    assert.ok(error.message.includes('E:\\Next-Trainer\\python.exe'));
    assert.ok(!error.message.includes('兼容 Next Trainer 安装'));
    return true;
  });assert.equal(f.runs,0);
});

test('all six snapshot engines reach their own preflight and only explicit submission dispatches a task',async t=>{
  const f=await fixture(t);
  for(const [engine,type] of [['kohya','moss-image-lora'],['anima-fast','anima-lora-fast'],['musubi','krea2-lora'],['ai-toolkit','ai-toolkit-sdxl-lora'],['diffsynth','qwen-image-21-lora'],['moss','moss-image-anima-lora']]){
    const config={...f.config,model_train_type:type,output_name:engine};
    if(engine==='moss'){config.src=config.train_data_dir;delete config.train_data_dir;}
    const before=f.runs;
    assert.equal((await f.service.preflight(config)).engine,engine);assert.equal(f.runs,before);
    assert.ok(f.requests.some(item=>item.path===`/api/engines/${engine}/preflight`));
    const request={requestId:`six-${engine}`,config},first=await f.service.submit(request),again=await f.service.submit(request);
    assert.equal(first.task_id,again.task_id);assert.equal(again.reused,true);assert.equal(f.runs,before+1);
  }
});

test('durable request reservation prevents duplicates, persists replay, and rejects changed payloads', async t => {
  const f = await fixture(t); const input = { requestId: 'request-1', config: f.config };
  const [first, again] = await Promise.all([f.service.submit(input), f.service.submit(input)]);
  assert.equal(first.task_id, again.task_id); assert.equal(f.runs, 1); assert.equal(again.reused, true);
  await assert.rejects(f.service.submit({ ...input, config: { ...f.config, output_name: 'different' } }), /编号|冲突/);
  const { LoraTraining } = await import('../framework/training.mjs');
  const reopened = new LoraTraining({ store: f.store, dataDir: f.directory, runtime: f.runtime, instanceId: 'first' }); f.services.push(reopened);
  assert.equal((await reopened.submit(input)).reused, true); assert.equal(f.runs, 1);
  const record = await reopened.submission('request-1'); assert.equal(record.state, 'submitted');
});

test('ambiguous submission is persisted and never auto-retried', async t => {
  const f = await fixture(t); f.controls.run = 'timeout';
  const input = { requestId: 'uncertain', config: f.config };
  await assert.rejects(f.service.submit(input));
  assert.equal((await f.service.submission('uncertain')).state, 'uncertain');
  f.controls.run = 'ok'; await assert.rejects(f.service.submit(input), /不确定|核对/);
  await assert.rejects(f.service.submit({ ...input, requestId: 'new-id-same-config' }), /不确定|核对/);
  assert.equal(f.runs, 1);
});

test('request is durably reserved before asynchronous preflight and a rejected check can be reconciled', async t => {
  const f = await fixture(t); let release;
  f.controls.waitPreflight = new Promise(done => { release = done; });
  const pending = f.service.submit({ requestId: 'slow-check', config: f.config });
  try {
    assert.equal((await f.service.submission('slow-check')).state, 'checking');
    const state = await f.service.state(); assert.ok(state.unresolvedSubmissions.some(record => record.requestId === 'slow-check'));
    await assert.rejects(f.service.stop(), /检查|提交/);
  } finally { f.controls.preflight = false; release(); }
  await assert.rejects(pending, /预检/);
  assert.equal((await f.service.submission('slow-check')).state, 'failed');
  assert.equal((await f.service.submission('missing')).state, 'not_found');
  assert.equal(f.runs, 0);
});

test('server exception remains uncertain and owner/request tags reconcile an accepted response loss', async t => {
  const f = await fixture(t); f.controls.run = 'server-error';
  await assert.rejects(f.service.submit({ requestId: 'server-error', config: f.config }));
  assert.equal((await f.service.submission('server-error')).state, 'uncertain');
  f.controls.run = 'timeout-after-accept';
  await assert.rejects(f.service.submit({ requestId: 'accepted', config: { ...f.config, output_name: 'accepted' } }));
  const reconciled = await f.service.submission('accepted');
  assert.equal(reconciled.state, 'submitted'); assert.ok(reconciled.result.task_id);
  assert.equal(f.runs, 2);
});

test('a checking record can be failed only after its owning workbench process has exited', async t => {
  const f = await fixture(t);
  assert.ok(f.service.db.prepare('PRAGMA table_info(submissions)').all().some(column => column.name === 'checker_pid'));
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true }); const pid = child.pid;
  await once(child, 'close');
  const insert = f.service.db.prepare("INSERT INTO submissions(owner,request_id,config_sha256,state,created_at,updated_at,checker_pid) VALUES (?,?,'fixture','checking',?,?,?)");
  const now = new Date().toISOString();
  insert.run(f.service.owner, 'interrupted-check', now, now, pid);
  insert.run(f.service.owner, 'live-check', now, now, process.pid);
  assert.equal((await f.service.submission('interrupted-check')).state, 'failed');
  assert.equal((await f.service.submission('live-check')).state, 'checking');
  assert.equal(f.runs, 0);
});

test('backend fail envelope is a rejection even when HTTP status is 200', async t => {
  const f = await fixture(t); f.controls.run = 'reject';
  await assert.rejects(f.service.submit({ requestId: 'rejected', config: f.config }), /run rejected/);
  assert.equal((await f.service.submission('rejected')).state, 'failed');
});

test('shared queue does not grant another instance task control or reveal credentials', async t => {
  const f = await fixture(t);
  const first = await f.service.submit({ requestId: 'same-id', config: f.config });
  const { LoraTraining } = await import('../framework/training.mjs');
  const other = new LoraTraining({ store: f.store, dataDir: f.directory, runtime: f.runtime, instanceId: 'second' }); f.services.push(other);
  assert.deepEqual((await other.tasks()).tasks, []);
  await assert.rejects(other.stopTask(first.task_id), /任务|归属|权限/);
  const second = await other.submit({ requestId: 'same-id', config: f.config });
  assert.notEqual(second.task_id, first.task_id);
  const detail = await f.service.task(first.task_id);
  assert.equal(detail.metrics.progress.step, 2); assert.equal(detail.logs.lines[0], 'fixture training log');
  assert.ok(!JSON.stringify(detail).includes('hidden'));
  await other.close(); assert.equal(f.stops, 0);
  await f.service.stopTask(first.task_id);
  assert.equal(f.tasks.find(task => task.id === second.task_id).status, 'RUNNING');
});

test('stop removes queued stages before stopping the active stage and refuses to stop a busy backend', async t => {
  const f = await fixture(t);
  const result = await f.service.submit({ requestId: 'group', config: f.config });
  f.tasks[0].metadata.train_task_id = result.task_id;
  f.tasks.push({ id: 'stage-next', status: 'QUEUED', metadata: { ...f.tasks[0].metadata, train_task_id: result.task_id } });
  await assert.rejects(f.service.stop(), /任务|训练/);
  await f.service.stopTask(result.task_id);
  assert.deepEqual(f.requests.filter(item => item.path.includes('/terminate/')).map(item => item.path.split('/').at(-1)), ['stage-next', result.task_id]);
  assert.equal(f.tasks.every(task => task.status === 'TERMINATED'), true);
});

test('task outputs match checkpoint naming rules without including a different run with the same prefix', async t => {
  const f = await fixture(t); const output = join(f.directory, 'output'); await mkdir(output);
  const expected = ['xiaoli.safetensors', 'xiaoli-000001.safetensors', 'xiaoli-step000020.safetensors', 'xiaoli.json'];
  for (const name of [...expected, 'xiaoli-v2.safetensors', 'xiaoli2.safetensors', 'xiaoli.png']) await writeFile(join(output, name), 'fixture');
  f.controls.taskConfig = { output_dir: output, output_name: 'xiaoli' };
  const result = await f.service.submit({ requestId: 'outputs', config: f.config });
  const task = await f.service.task(result.task_id);
  assert.deepEqual(task.outputs.map(item => item.name).sort(), expected.sort());
});

test('removing an instance rejects its active or uncertain work but ignores another owner tasks', async t => {
  const f = await fixture(t);
  const first = await f.service.submit({ requestId: 'active-removal', config: f.config });
  await assert.rejects(f.service.prepareRemoval(), /任务|训练/);
  assert.equal((await f.service.tasks()).tasks[0].id, first.task_id);
  const { LoraTraining } = await import('../framework/training.mjs');
  const idle = new LoraTraining({ store: f.store, dataDir: f.directory, runtime: f.runtime, instanceId: 'idle' }); f.services.push(idle);
  const release = await idle.prepareRemoval();
  await assert.rejects(idle.submit({ requestId: 'during-removal', config: f.config }), /移除|删除/);
  release(); assert.deepEqual((await idle.tasks()).tasks, []);
  await f.service.stopTask(first.task_id);
  f.controls.run = 'timeout'; await assert.rejects(f.service.submit({ requestId: 'uncertain-removal', config: f.config }));
  await assert.rejects(f.service.prepareRemoval(), /核对|未确定|不确定/);
  assert.equal((await f.service.submission('uncertain-removal')).state, 'uncertain');
});

test('removal gate closes before its first await and never starts Python to inspect offline ownership', async t => {
  const f = await fixture(t); let resolveState;
  f.runtime.state = () => new Promise(done => { resolveState = done; });
  const pending = f.service.prepareRemoval();
  await assert.rejects(f.service.submit({ requestId: 'racing-removal', config: f.config }), /移除|删除/);
  resolveState({ status: 'stopped' }); const release = await pending; release();
  for (const status of ['offline', 'unresponsive']) {
    f.runtime.state = async () => ({ status });
    await assert.rejects(f.service.prepareRemoval(), /核实|离线|失联/);
  }
  f.runtime.state = async () => ({ status: 'unconfigured' });
  const releaseUnconfigured = await f.service.prepareRemoval(); releaseUnconfigured();
  assert.equal(f.starts, 0); assert.equal(f.runs, 0);
});
