import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TrainingRuntime, trainingProcessExists } from '../framework/training-runtime.mjs';
import { LoraTraining } from '../framework/training.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sidecarCode = `
const fs=require('node:fs'),http=require('node:http');
const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const identity={...b,token:undefined,pid:process.pid};
const server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+b.token){res.writeHead(401);res.end();return;}
  let data={};
  if(req.url==='/__workbench/identity')data=identity;
  else if(req.url==='/api/tasks'){try{data={tasks:JSON.parse(fs.readFileSync(b.root+'/fixture-tasks.json','utf8'))}}catch{data={tasks:[]}}}
  else if(req.url==='/__workbench/shutdown')setTimeout(()=>server.close(()=>process.exit(0)),50);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'success',data}));
});
server.listen(0,'127.0.0.1',()=>{identity.url='http://127.0.0.1:'+server.address().port;fs.writeFileSync(b.readyPath,JSON.stringify(identity));});`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'training-component-'));
  const children = [], runtimes = [], services = [], leases = new Set(), acquired = [];
  let current = null;
  const provider = {
    resolve(id) { assert.equal(id, 'training'); return current && { path: current, origin: 'managed', version: 'fixture' }; },
    async acquire(id, owner) {
      assert.equal(id, 'training'); assert.equal(typeof owner, 'string'); assert.ok(owner);
      if (!current) throw Object.assign(new Error('训练组件未准备'), { status: 503 });
      const lease = { path: current, owner }; leases.add(lease); acquired.push(lease);
      return { path: current, retain(pid) { assert.ok(Number.isInteger(pid) && pid > 0); lease.pid = pid; }, release: async () => { leases.delete(lease); } };
    },
  };
  const config = { pythonPath: process.execPath };
  const store = { module: () => ({ config }) };
  const spawnImpl = (_executable, args, settings) => {
    const child = spawn(process.execPath, ['-e', sidecarCode, args.at(-1)], settings);
    children.push(child); return child;
  };
  async function component(name) {
    const root = join(directory, name), files = [];
    const sources = { VERSION: name, 'mikazuki/schema/fixture.ts': `Schema.object({ value: Schema.string().default('${name}') })`, 'mikazuki/schema/shared.ts': '(function () { return { RAW: {} }; })()' };
    for (const [path, content] of Object.entries(sources)) {
      await mkdir(join(root, 'source', ...path.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(root, 'source', path), content, 'utf8');
      files.push({ path, size: Buffer.byteLength(content), sha256: hash(content) });
    }
    await writeFile(join(root, 'source-manifest.json'), JSON.stringify({ format: 1, version: name, kernelRevision: hash(name), source: { commit: hash(name) }, files }), 'utf8');
    const catalog = { version: name, engines: [{ id: 'kohya' }], training_types: [{ train_type: 'fixture', schema_name: 'fixture', engine: 'kohya', control_supported: true }] };
    await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog), 'utf8');
    for (const file of ['runner.py', 'prepare_service.py', 'read_configs.py', 'workbench_preprocess.py', 'workbench_vision.py', 'workbench_caption.py']) await writeFile(join(root, file), `${name}:${file}`, 'utf8');
    return root;
  }
  function runtime(options = {}) {
    const value = new TrainingRuntime({ dataDir: directory, store, componentProvider: provider, spawnImpl, ...options });
    runtimes.push(value); return value;
  }
  function service(options = {}) {
    const value = new LoraTraining({ dataDir: directory, store, componentProvider: provider, ...options });
    services.push(value); return value;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close').catch(() => {}); }
    for (const value of services) await value.close();
    for (const value of runtimes) await value.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, children, leases, acquired, provider, config, store, component, runtime, service, select(path) { current = path; } };
}

test('missing training component keeps state and presets available while catalog and start return 503', async t => {
  const f = await fixture(t), runtime = f.runtime(), service = f.service({ runtime });
  const state = await service.state();
  assert.equal(state.runtime.status, 'unconfigured'); assert.match(state.runtime.reason, /训练组件.*未准备/);
  assert.ok(service.listPresets());
  await assert.rejects(service.catalog(), error => error.status === 503 && /训练组件.*未准备/.test(error.message));
  await assert.rejects(runtime.start(), error => error.status === 503 && /训练组件.*未准备/.test(error.message));
  assert.equal(f.children.length, 0); assert.equal(f.leases.size, 0);
});

test('catalog, schema and injected runtime adopt the component selected after construction', async t => {
  const f = await fixture(t), runtime = f.runtime(), service = f.service({ runtime });
  for (const name of ['first', 'second']) {
    const path = await f.component(name); f.select(path);
    assert.equal(runtime.integrationDir, path); assert.equal(service.integrationDir, path);
    assert.equal((await service.catalog()).version, name);
    const schema = await service.schema('fixture'); assert.ok(schema.schema.includes(name));
    assert.equal(schema.form.sections.flatMap(section => section.fields).find(field => field.key === 'value').defaultValue, name);
  }
  assert.equal(f.children.length, 0);
});

test('explicit integration directory remains usable without a provider or with a separately injected runtime', async t => {
  const f = await fixture(t), path = await f.component('explicit');
  const runtime = f.runtime({ componentProvider: undefined, integrationDir: path });
  const service = f.service({ componentProvider: undefined, runtime });
  assert.equal(service.integrationDir, path); assert.equal((await service.catalog()).version, 'explicit');
  assert.equal((await runtime.state()).version, 'explicit');
});

test('sidecar materialization uses the leased component and releases only after confirmed shutdown', async t => {
  const f = await fixture(t), path = await f.component('installed'); f.select(path);
  const runtime = f.runtime(), state = await runtime.start();
  assert.equal(f.leases.size, 1); assert.equal(await readFile(join(state.root, 'VERSION'), 'utf8'), 'installed');
  assert.equal(f.acquired[0].pid, state.pid);
  assert.equal(await readFile(join(state.root, 'workbench_runner.py'), 'utf8'), 'installed:runner.py');
  for (const file of ['workbench_preprocess.py', 'workbench_vision.py', 'workbench_caption.py']) assert.equal(await readFile(join(state.root, file), 'utf8'), `installed:${file}`);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'training', 'runtime.json'), 'utf8')).integrationDir, path);
  await runtime.stop(); assert.equal(trainingProcessExists(state.pid), false); assert.equal(f.leases.size, 0);
});

test('shared sidecar leases survive active close and every holder releases after another instance stops it', async t => {
  const f = await fixture(t); f.select(await f.component('shared'));
  const first = f.runtime(), state = await first.start(), second = f.runtime();
  assert.equal((await second.start()).pid, state.pid); assert.equal(f.children.length, 1);
  await writeFile(join(state.root, 'fixture-tasks.json'), JSON.stringify([{ id: 'active', status: 'RUNNING' }]), 'utf8');
  await first.close(); assert.ok(f.leases.size > 0);
  await assert.rejects(second.stop(), /任务/); assert.ok(f.leases.size > 0);
  await writeFile(join(state.root, 'fixture-tasks.json'), '[]', 'utf8');
  await second.stop(); assert.equal(f.leases.size, 0);
});

test('a different selected component cannot be rebound to an existing sidecar from another source', async t => {
  const f = await fixture(t); const original = await f.component('original'); f.select(original);
  const first = f.runtime(), state = await first.start();
  f.select(await f.component('replacement'));
  const second = f.runtime();
  await assert.rejects(second.start(), error => error.status === 409);
  assert.equal(f.children.length, 1); assert.equal(f.leases.size, 1); assert.equal([...f.leases][0].path, original);
  await first.stop(); assert.equal(trainingProcessExists(state.pid), false); assert.equal(f.leases.size, 0);
});

test('unexpected sidecar exit releases component leases belonging to every attached runtime', async t => {
  const f = await fixture(t); f.select(await f.component('exiting'));
  const first = f.runtime(); await first.start();
  const second = f.runtime(); await second.start(); assert.equal(f.leases.size, 2);
  const child = f.children[0], closed = once(child, 'close'); child.kill(); await closed;
  for (let i = 0; i < 30 && f.leases.size; i++) await delay(20);
  assert.equal(f.leases.size, 0);
});

test('launch failure releases a component acquired before materialization', async t => {
  const f = await fixture(t); f.select(await f.component('failure'));
  const runtime = f.runtime({ spawnImpl() { throw new Error('fixture launch failure'); } });
  await assert.rejects(runtime.start(), /fixture launch failure/);
  assert.equal(f.acquired.length, 1); assert.equal(f.leases.size, 0);
});

test('asynchronous controller spawn failure releases the component and reports its startup failure', async t => {
  const f = await fixture(t); f.select(await f.component('controller-spawn-error'));
  const runtime = f.runtime({ spawnImpl(_executable, args, settings) {
    const child = spawn(join(f.directory, 'missing-python.exe'), args, settings); child.on('error', () => {}); f.children.push(child); return child;
  } });
  await assert.rejects(runtime.start(), error => error.status === 503 && /启动失败.*ENOENT/.test(error.message));
  assert.equal(f.acquired.length, 1); assert.equal(f.leases.size, 0);
});

test('startup timeout confirms child exit before releasing its component', async t => {
  const f = await fixture(t); f.select(await f.component('timeout'));
  const runtime = f.runtime({ startupTimeoutMs: 200, spawnImpl(_executable, _args, options) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options); f.children.push(child); return child;
  } });
  await assert.rejects(runtime.start(), /启动超时/);
  assert.equal(f.acquired.length, 1);
  assert.equal(trainingProcessExists(f.children[0].pid), false); assert.equal(f.leases.size, 0);
});

test('closing during cancellable materialization releases its leased component and startup lock without spawning', async t => {
  const f = await fixture(t), path = await f.component('closing'); f.select(path);
  let enter; const entered = new Promise(done => { enter = done; });
  const runtime = f.runtime({ materializeImpl: async ({ integrationDir, signal }) => {
    assert.equal(integrationDir, path); assert.equal(f.leases.size, 1); enter();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const starting = runtime.start().then(() => null, error => error); await entered; await runtime.close();
  assert.match((await starting).message, /取消/); assert.equal(f.acquired.length, 1);
  assert.equal(f.leases.size, 0); assert.equal(f.children.length, 0); assert.equal(runtime.startupLock.lease, null);
  await assert.rejects(readFile(join(runtime.directory, 'startup.lock')), { code: 'ENOENT' });
  await assert.rejects(runtime.start(), /已关闭/);
});

test('a published sidecar retains its component by worker PID even if its launcher never verifies readiness', async t => {
  const f = await fixture(t); f.select(await f.component('published'));
  const owner = f.runtime({ fetchImpl: async () => { throw new Error('owner probe failed'); }, startupTimeoutMs: 5000 });
  let failure; const pending = owner.start().then(() => null, error => { failure = error; return error; });
  const deadline = Date.now() + 4000;
  while (!f.children.length && !failure && Date.now() < deadline) await delay(10);
  assert.ok(f.children.length, failure?.message);
  const record = JSON.parse(await readFile(f.children[0].spawnargs.at(-1), 'utf8'));record.pid=f.children[0].pid;
  while (!await readFile(record.readyPath).catch(() => null) && !failure && Date.now() < deadline) await delay(20);
  assert.ok(await readFile(record.readyPath).catch(() => null), failure?.message || await readFile(owner.logPath, 'utf8'));
  assert.equal(f.acquired[0].pid, f.children[0].pid, '租约必须在首次身份探测之前转交给后台 PID');
  await writeFile(join(record.root, 'fixture-tasks.json'), JSON.stringify([{ id: 'active', status: 'RUNNING' }]), 'utf8');
  await assert.rejects(owner.stop(), /进程|身份|核实/); assert.match((await pending).message, /取消/);
  assert.equal(trainingProcessExists(record.pid), true); assert.equal(f.leases.size, 1); assert.equal(owner.startupLock.lease, null);
  const peer = f.runtime(); assert.equal((await peer.start()).pid, record.pid); await assert.rejects(peer.stop(), /任务/);
  await owner.close(); assert.equal(f.leases.size, 2);
  await writeFile(join(record.root, 'fixture-tasks.json'), '[]', 'utf8'); await peer.stop();
  assert.equal(f.leases.size, 0); assert.equal(trainingProcessExists(record.pid), false);
});

test('historical configuration reader takes a short lease from the dynamically installed component', async t => {
  const f = await fixture(t), path = await f.component('reader'); f.select(path);
  let selectedScript;
  const runtime = f.runtime({ spawnImpl(_executable, args, settings) {
    selectedScript = args[2]; assert.equal(f.leases.size, 1);
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({configs:[]}))'], settings); f.children.push(child); return child;
  } });
  await mkdir(join(f.directory, 'training'), { recursive: true });
  assert.deepEqual(await runtime.readSavedConfigs(f.directory, process.execPath), { configs: [] });
  assert.equal(selectedScript, join(path, 'read_configs.py')); assert.equal(f.leases.size, 0);
});

test('concurrent historical readers use separate lease owners until both processes stop', async t => {
  const f = await fixture(t); f.select(await f.component('parallel-readers'));
  const runtime = f.runtime({ spawnImpl(_executable, _args, settings) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write(JSON.stringify({configs:[]})),100)'], settings); f.children.push(child); return child;
  } });
  await mkdir(join(f.directory, 'training'), { recursive: true });
  await Promise.all([runtime.readSavedConfigs(f.directory, process.execPath), runtime.readSavedConfigs(f.directory, process.execPath)]);
  assert.equal(new Set(f.acquired.map(lease => lease.owner)).size, 2); assert.equal(f.leases.size, 0);
});

test('service preparation retains its component while the detached preparation worker runs', async t => {
  const f = await fixture(t), path = await f.component('preparation'); f.select(path);
  let selectedScript;
  const runtime = f.runtime({ spawnImpl(_executable, args, settings) {
    selectedScript = args[2]; assert.equal(f.leases.size, 1);
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)'], settings); f.children.push(child); return child;
  } });
  const prepared = await runtime.prepareService({ pythonPath: process.execPath, confirmed: true });
  assert.equal(selectedScript, join(path, 'prepare_service.py')); assert.equal(f.leases.size, 1);
  await once(f.children[0], 'close');
  for (let i = 0; i < 30 && f.leases.size; i++) await delay(20);
  assert.equal(f.leases.size, 0); assert.equal(prepared.training_started, false);
});

test('a missing service-preparation executable records its failure and releases the component without retaining an invalid PID', async t => {
  const f = await fixture(t); f.select(await f.component('missing-python'));
  const runtime = f.runtime({ spawnImpl(_executable, args, settings) {
    const child = spawn(join(f.directory, 'missing-python.exe'), args, settings); child.on('error', () => {}); f.children.push(child); return child;
  } });
  await runtime.prepareService({ pythonPath: process.execPath, confirmed: true });
  if (f.children[0].exitCode === null && f.children[0].signalCode === null) await once(f.children[0], 'close').catch(() => {});
  for (let i = 0; i < 30 && (await runtime.servicePreparationState()).status !== 'failed'; i++) await delay(20);
  const state = await runtime.servicePreparationState(); assert.equal(state.status, 'failed'); assert.match(state.reason, /ENOENT/);
  assert.equal(f.leases.size, 0); assert.equal(f.acquired[0].pid, undefined);
});

test('a missing historical-reader executable reports the spawn error and releases its short lease', async t => {
  const f = await fixture(t); f.select(await f.component('missing-reader'));
  const runtime = f.runtime({ spawnImpl(_executable, args, settings) {
    const child = spawn(join(f.directory, 'missing-python.exe'), args, settings); child.on('error', () => {}); f.children.push(child); return child;
  } });
  await mkdir(join(f.directory, 'training'), { recursive: true });
  await assert.rejects(runtime.readSavedConfigs(f.directory, process.execPath), /ENOENT/);
  assert.equal(f.leases.size, 0);
});
