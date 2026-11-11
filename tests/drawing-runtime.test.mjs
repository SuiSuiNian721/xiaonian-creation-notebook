import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkbenchStore } from '../framework/store.mjs';
import { ComfyDrawing } from '../framework/drawing.mjs';
import { createWorkbench } from '../framework/server.mjs';

const base = '/api/modules/drawing';
const schema = {
  Loader: { input: { required: { ckpt_name: [['real.safetensors']], strength: ['FLOAT', { min: 0, max: 1 }] } } },
  Save: { output_node: true, input: { required: { images: ['IMAGE'], count: ['INT', { min: 1, max: 8 }] } } },
};
const graph = { '1': { class_type: 'Loader', inputs: { ckpt_name: 'lost.safetensors', strength: 3 } }, '2': { class_type: 'Save', inputs: { images: ['1', 0], count: 2.5 } }, '3': { class_type: 'Unknown', inputs: {} } };
async function directoryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-runtime-'));
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const comfy = join(directory, 'ComfyUI'); await mkdir(join(comfy, 'comfy'), { recursive: true });
  for (const name of ['main.py', 'nodes.py', 'server.py']) await writeFile(join(comfy, name), '# fixture\n');
  return { directory, comfy, closers };
}
async function runtimeFixture(t, options = {}) {
  const { directory, comfy, closers } = await directoryFixture(t);
  const { DrawingRuntime } = await import('../framework/drawing-runtime.mjs');
  const store = new WorkbenchStore(directory);
  store.saveConfig('drawing', { comfyPath: comfy, serviceUrl: 'http://127.0.0.1:8188', outputPath: join(directory, 'output') });
  const runtime = new DrawingRuntime({ store, directory: join(directory, 'drawing'), ...options });
  runtime.saveSettings({ pythonPath: process.execPath });
  closers.push(async () => { await runtime.close(); store.close(); });
  return { directory, comfy, runtime, store };
}
async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await delay(20); } assert.fail('等待进程状态超时'); }

test('HTTP 运行设置独立保存与恢复，不连接、不启动，并遵循模块启用检查', async t => {
  const { directory, closers } = await directoryFixture(t); let network = 0; let spawned = 0;
  const options = { dataDir: directory, drawingOptions: { WebSocketImpl: null, fetchImpl: async () => { network++; throw new Error('offline'); }, runtimeOptions: { spawnImpl: () => { spawned++; throw new Error('unexpected spawn'); } } } };
  let app = await createWorkbench(options); closers.push(() => app.close());
  const api = async (path, body) => { const response = await fetch(app.url + base + path, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  assert.equal((await api('/runtime')).status, 409); await api('/enable', {});
  const saved = await api('/runtime/settings', { vramMode: 'lowvram', reserveVram: 1.25 });
  assert.equal(saved.status, 200); assert.equal(saved.data.settings.vramMode, 'lowvram'); assert.equal(saved.data.command.available, false);
  assert.equal((await api('/runtime/settings', { vramMode: 'shell' })).status, 400);
  assert.equal((await api('/runtime/logs')).data.text, '');
  await app.close(); app = await createWorkbench(options);
  assert.equal((await api('/runtime')).data.settings.reserveVram, 1.25); assert.equal(network, 0); assert.equal(spawned, 0);
});

test('运行参数严格校验并按数组构建，路径带空格无需 shell', async t => {
  const { runtime, comfy, store } = await runtimeFixture(t);
  const before = store.module('drawing').config;
  runtime.saveSettings({ vramMode: 'cpu', previewMethod: 'taesd', reserveVram: 0, cpuVae: true, disableCustomNodes: true });
  const command = await runtime.command();
  assert.equal(command.executable, process.execPath); assert.equal(command.cwd, comfy);
  assert.deepEqual(command.args.slice(0, 8), ['-s', join(comfy, 'main.py'), '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch', '--output-directory']);
  for (const flag of ['--cpu', '--cpu-vae', '--disable-all-custom-nodes', '--preview-method', '--reserve-vram']) assert.ok(command.args.includes(flag));
  assert.equal(command.args[command.args.indexOf('--reserve-vram') + 1], '0'); assert.deepEqual(store.module('drawing').config, before);
  for (const bad of [{ pythonPath: 'python --evil' }, { pythonPath: '\\\\server\\python.exe' }, { reserveVram: -1 }, { reserveVram: 65 }, { reserveVram: '2' }, { previewMethod: 'bad' }, { cpuVae: 1 }, { disableCustomNodes: 'false' }, { extra: true }]) assert.throws(() => runtime.saveSettings(bad));
});

test('真实子进程启动/退出、日志尾部与并发启动去重', async t => {
  let calls = 0; let spawnOptions;
  const f = await runtimeFixture(t, { spawnImpl: (executable, args, options) => { calls++; spawnOptions = options; return spawn(process.execPath, ['-e', "console.log('x'.repeat(150000)); console.error('结尾'); setTimeout(() => process.exit(7), 100)"], options); } });
  const [first, second] = await Promise.all([f.runtime.launch(), f.runtime.launch()]);
  assert.equal(calls, 1); assert.equal(first.pid, second.pid); assert.ok(first.pid > 0); assert.equal(spawnOptions.shell, false); assert.equal(typeof spawnOptions.stdio[1], 'number'); assert.equal(spawnOptions.detached, true);
  await until(() => f.runtime.launchRecord?.status === 'exited');
  const log = await f.runtime.logs(); assert.ok(log.truncated); assert.ok(Buffer.byteLength(log.text) <= 128 * 1024); assert.match(log.text, /结尾/);
  assert.equal(log.launch.exitCode, 7); assert.ok(log.launch.exitedAt); assert.ok(log.launch.startedAt); assert.equal(log.launch.executable, process.execPath);
});

test('异步 spawn error 返回失败而非虚假 pid，运行记录保留明确错误', async t => {
  const f = await runtimeFixture(t, { spawnImpl: (_executable, _args, options) => spawn(join(tmpdir(), 'nonexistent-drawing-python.exe'), [], options) });
  await assert.rejects(f.runtime.launch(), /启动.*失败/);
  assert.equal(f.runtime.launchRecord.status, 'failed'); assert.equal(f.runtime.launchRecord.pid, null); assert.match(f.runtime.launchRecord.error, /ENOENT/);
});

test('启动日志不可写时记录明确失败，不能遗留 starting 状态', async t => {
  let spawns = 0; const f = await runtimeFixture(t, { spawnImpl: () => { spawns++; throw new Error('unexpected'); } });
  await mkdir(join(f.directory, 'drawing/comfy-startup.log'), { recursive: true });
  await assert.rejects(f.runtime.launch(), /日志.*失败/); assert.equal(spawns, 0); assert.equal(f.runtime.launchRecord.status, 'failed'); assert.ok(f.runtime.launchRecord.error);
});

test('关闭运行组件不杀启动服务，之后的退出事件不再写 store', async t => {
  let child, closed;
  const f = await runtimeFixture(t, { spawnImpl: (_executable, _args, options) => {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => { console.log("survived"); }, 180)'], options);
    closed = once(child, 'close');
    return child;
  } });
  await f.runtime.launch(); child.ref(); await f.runtime.close(); f.store.close();
  // Windows keeps the fixture working directory locked until the detached child exits.
  await closed;
  assert.match(await readFile(join(f.directory, 'drawing/comfy-startup.log'), 'utf8'), /survived/);
});

test('探针超时与关闭取消会结束临时子进程', async () => {
  const { runProbe } = await import('../framework/drawing-runtime.mjs');
  const timed = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 50 });
  assert.equal(timed.timedOut, true); assert.match(timed.error, /超时/);
  const controller = new AbortController();
  const pending = runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 10000, signal: controller.signal }); controller.abort();
  assert.equal((await pending).cancelled, true);
});

test('诊断聚合实际探针信息与 pip 故障，超时明确，不写设置', async t => {
  const calls = [];
  const f = await runtimeFixture(t, { probeRunner: async (executable, args, options) => { calls.push({ executable, args, options }); return args.includes('pip') ? { code: 1, stdout: 'broken-package requires missing-dependency', stderr: '' } : { code: 0, stdout: JSON.stringify({ python: { version: '3.test' }, comfy: { version: '0.test' }, torch: { version: '2.test', cudaAvailable: false, devices: [] }, disks: [{ path: 'fixture', free: 2000, total: 4000 }] }), stderr: '' }; } });
  const before = f.store.getSetting('drawing.runtime'); const result = await f.runtime.diagnose();
  assert.equal(result.probe.python.version, '3.test'); assert.equal(result.checks.find(c => c.id === 'pip').status, 'error'); assert.equal(result.checks.find(c => c.id === 'device').status, 'warning'); assert.equal(calls.length, 2); assert.deepEqual(f.store.getSetting('drawing.runtime'), before);
  f.runtime.probeRunner = async () => ({ code: null, timedOut: true, error: '探针超时。', stdout: '', stderr: '' });
  assert.match((await f.runtime.diagnose()).checks.find(c => c.id === 'python').detail, /超时/);
});

test('API 预检同时报告节点、模型和参数问题，普通工作流不猜控件顺序', async () => {
  const { inspectWorkflow, validatePrompt } = await import('../framework/drawing-workflows.mjs');
  const report = inspectWorkflow(graph, schema);
  assert.equal(report.available, true); assert.equal(report.valid, false); assert.equal(report.nodeCount, 3);
  assert.equal(report.missingNodes[0].classType, 'Unknown');
  assert.deepEqual(report.missingModels[0], { nodeId: '1', classType: 'Loader', input: 'ckpt_name', value: 'lost.safetensors', options: ['real.safetensors'], detail: '模型不在当前 ComfyUI 的可选列表中。' });
  assert.equal(report.invalidValues.length, 2); assert.throws(() => validatePrompt({ '1': graph['1'], '2': graph['2'] }, schema));
  const ui = inspectWorkflow({ nodes: [{ id: 1, type: 'Loader', widgets_values: ['missing.safetensors', 4] }, { id: 2, type: 'Unknown' }] }, schema);
  assert.equal(ui.missingNodes.length, 1); assert.equal(ui.missingModels.length, 0); assert.ok(ui.warnings.some(item => /未核实/.test(item.detail)));
});

test('API 预检拒绝已知接口的错误连接类型与非连接值', async () => {
  const { inspectWorkflow, validatePrompt } = await import('../framework/drawing-workflows.mjs');
  const info = { Source: { input: { required: {} }, output: ['MODEL'] }, Save: schema.Save };
  const prompt = { '1': { class_type: 'Source', inputs: {} }, '2': { class_type: 'Save', inputs: { images: ['1', 0], count: 1 } } };
  let report = inspectWorkflow(prompt, info); assert.equal(report.valid, false); assert.match(report.invalidValues[0].detail, /类型/); assert.throws(() => validatePrompt(prompt, info));
  prompt['2'].inputs.images = 42; report = inspectWorkflow(prompt, info); assert.equal(report.valid, false); assert.match(report.invalidValues[0].detail, /连接/);
  prompt['2'].inputs.images = ['1', 9]; assert.equal(inspectWorkflow(prompt, info).valid, false);
});

test('前端 forceInput/defaultInput 不会拒绝合法 API 标量和枚举字面量', async () => {
  const { inspectWorkflow, validatePrompt } = await import('../framework/drawing-workflows.mjs');
  const info = { Save: { output_node: true, input: { required: { strength: ['FLOAT', { defaultInput: true, min: 0, max: 1 }], mode: [['normal'], { forceInput: true }] } } } };
  const prompt = { '1': { class_type: 'Save', inputs: { strength: 0.5, mode: 'normal' } } };
  assert.equal(inspectWorkflow(prompt, info).valid, true); assert.doesNotThrow(() => validatePrompt(prompt, info));
});

test('节点定义必须是 schema 自有项，原型同名类型不能绕过严格导入校验', async () => {
  const { inspectWorkflow, validatePrompt } = await import('../framework/drawing-workflows.mjs');
  const info = { Save: { output_node: true, input: { required: {} } } };
  for (const classType of ['constructor', 'toString', '__proto__']) {
    const prompt = { '1': { class_type: classType, inputs: {} }, '2': { class_type: 'Save', inputs: {} } };
    assert.equal(inspectWorkflow(prompt, info).missingNodes.length, 1); assert.throws(() => validatePrompt(prompt, info), /缺少节点/);
  }
});

test('已连服务不重复启动，预检遇到断线或配置变化不用旧 schema', async t => {
  const { directory, closers } = await directoryFixture(t); const store = new WorkbenchStore(directory); let online = true; let spawns = 0;
  store.saveConfig('drawing', { serviceUrl: 'http://127.0.0.1:8188' });
  const drawing = new ComfyDrawing({ store, dataDir: directory, WebSocketImpl: null, runtimeOptions: { spawnImpl: () => { spawns++; throw new Error('unexpected'); } }, fetchImpl: async url => { if (!online) throw new Error('offline'); return new Response(JSON.stringify(url.endsWith('system_stats') ? { system: { comfyui_version: 'test' } } : schema)); } });
  closers.push(async () => { await drawing.close(); store.close(); });
  await drawing.launch(); assert.equal(spawns, 0);
  assert.equal((await drawing.inspectWorkflow({ document: graph })).missingModels.length, 1);
  online = false; const offline = await drawing.inspectWorkflow({ document: graph }); assert.equal(offline.available, false); assert.equal(offline.missingModels.length, 0);
  online = true; await drawing.connect(); store.saveConfig('drawing', { comfyPath: join(directory, 'other') });
  assert.equal((await drawing.inspectWorkflow({ document: graph })).available, false);
});

test('服务状态已成功但节点定义失败时不再次启动 ComfyUI', async t => {
  const { directory, closers } = await directoryFixture(t); const store = new WorkbenchStore(directory); let spawns = 0;
  store.saveConfig('drawing', { serviceUrl: 'http://127.0.0.1:8188' });
  const drawing = new ComfyDrawing({ store, dataDir: directory, WebSocketImpl: null, fetchImpl: async url => { if (url.endsWith('system_stats')) return new Response(JSON.stringify({ system: { comfyui_version: 'running-service' } })); throw new Error('schema offline'); } });
  drawing.runtime.launch = async () => { spawns++; return { starting: true }; }; closers.push(async () => { await drawing.close(); store.close(); });
  await assert.rejects(drawing.launch(), /无法连接/); assert.equal(spawns, 0);
});

test('启动判断聚合两个端点的 HTTP 响应和超时，不能只看第一个错误', async t => {
  const { directory, closers } = await directoryFixture(t); const store = new WorkbenchStore(directory); let spawns = 0;
  store.saveConfig('drawing', { serviceUrl: 'http://127.0.0.1:8188' });
  const drawing = new ComfyDrawing({ store, dataDir: directory, WebSocketImpl: null, fetchImpl: async url => { if (url.endsWith('object_info')) return new Response('{}', { status: 500 }); throw new Error('connection reset'); } });
  drawing.runtime.launch = async () => { spawns++; return { starting: true }; }; closers.push(async () => { await drawing.close(); store.close(); });
  await assert.rejects(drawing.launch()); assert.equal(spawns, 0);
  drawing.request = async (_base, path) => { throw Object.assign(new Error('timeout'), { status: 503, timedOut: path.endsWith('object_info') }); };
  await assert.rejects(drawing.launch()); assert.equal(spawns, 0);
});

test('普通控件只将明确顺序、可解释数量当作模型核实依据', async () => {
  const { unverifiedWidgetNodes } = await import('../framework/drawing-workflows.mjs');
  const document = { nodes: [{ id: 1, type: 'Loader', widgets_values: ['lost.safetensors', 0.5] }] };
  assert.deepEqual(unverifiedWidgetNodes(document, schema), ['1']);
  const ordered = structuredClone(schema); ordered.Loader.input_order = { required: ['ckpt_name', 'strength'] };
  assert.deepEqual(unverifiedWidgetNodes(document, ordered), []);
  document.nodes[0].widgets_values.unshift('custom-frontend-widget');
  assert.deepEqual(unverifiedWidgetNodes(document, ordered), ['1']);
  document.nodes[0].widgets_values = []; assert.deepEqual(unverifiedWidgetNodes(document, ordered), ['1']);
  delete document.nodes[0].widgets_values; assert.deepEqual(unverifiedWidgetNodes(document, ordered), ['1']);
});

test('诊断关闭取消全部探针，返回后不写已关闭数据库', async t => {
  let running = 0; let aborted = 0;
  const f = await runtimeFixture(t, { probeRunner: (_executable, _args, { signal }) => new Promise(resolveProbe => { running++; signal.addEventListener('abort', () => { aborted++; resolveProbe({ code: null, cancelled: true, error: '已取消' }); }, { once: true }); }) });
  const result = f.runtime.diagnose(); const rejected = assert.rejects(result, /取消/);
  await until(() => running === 2); await f.runtime.close(); f.store.close(); await rejected; assert.equal(aborted, 2);
});

test('预检 HTTP 与扫描文件使用同一校验，原文件不改写且失效 key 拒绝', async t => {
  const { directory, comfy, closers } = await directoryFixture(t); let online = true;
  const workflowDir = join(directory, 'workflows'); await mkdir(workflowDir); const file = join(workflowDir, '原始.json'); const original = JSON.stringify(graph); await writeFile(file, original);
  const app = await createWorkbench({ dataDir: directory, drawingOptions: { WebSocketImpl: null, fetchImpl: async url => { if (!online) throw new Error('offline'); return new Response(JSON.stringify(url.endsWith('system_stats') ? { system: { comfyui_version: 'test' } } : schema)); } } }); closers.push(() => app.close());
  const api = async (path, body, method = body ? 'POST' : 'GET') => { const response = await fetch(app.url + base + path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  await api('/enable', {}); await api('/config', { values: { serviceUrl: 'http://127.0.0.1:8188', comfyPath: comfy, workflowPath: workflowDir } }, 'PUT'); await api('/connect', {});
  const inspected = await api('/workflows/inspect', { document: graph }); assert.equal(inspected.status, 200); assert.equal(inspected.data.missingModels.length, 1);
  const catalog = await api('/workflows/scan', {}); const key = catalog.data.files[0].key;
  assert.deepEqual((await api('/workflows/inspect-file', { key })).data, inspected.data); assert.equal((await api('/workflows/inspect-file', { key: '../evil' })).status, 409);
  assert.equal((await api('/workflows')).data.workflows.length, 0); assert.equal(await readFile(file, 'utf8'), original);
  online = false;
  const clean = { '1': { class_type: 'Loader', inputs: { ckpt_name: 'real.safetensors', strength: 0.5 } }, '2': { class_type: 'Save', inputs: { images: ['1', 0], count: 1 } } };
  assert.equal((await api('/workflows/import', { name: '离线导入', document: clean })).status, 409);
});

test('正在运行时配置改变不能把旧 PID 冒充新命令的启动结果', async t => {
  const f = await runtimeFixture(t, { spawnImpl: (_executable, _args, options) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], options) });
  await f.runtime.launch(); f.runtime.saveSettings({ vramMode: 'cpu' });
  await assert.rejects(f.runtime.launch(), /已有.*进程/);
  await until(() => f.runtime.launchRecord?.status === 'exited');
});

test('真实 Python 转换普通工作流核实模型，前端备注不误报缺节点，歧义控件保留未核实', { skip: !process.env.AI_FUTURE_TEST_PYTHON }, async t => {
  const { directory, comfy, closers } = await directoryFixture(t); const store = new WorkbenchStore(directory);
  const info = { Loader: { ...schema.Loader, input_order: { required: ['ckpt_name', 'strength'] } }, Save: schema.Save };
  store.saveConfig('drawing', { comfyPath: comfy, serviceUrl: 'http://127.0.0.1:8188' });
  const drawing = new ComfyDrawing({ store, dataDir: directory, WebSocketImpl: null, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('system_stats') ? { system: { comfyui_version: 'test' } } : info)) });
  closers.push(async () => { await drawing.close(); store.close(); }); drawing.runtime.saveSettings({ pythonPath: process.env.AI_FUTURE_TEST_PYTHON }); await drawing.connect();
  const document = { nodes: [{ id: 1, type: 'Loader', widgets_values: ['lost.safetensors', 0.5], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }] }, { id: 2, type: 'Save', inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], widgets_values: [1] }, { id: 3, type: 'Note', widgets_values: ['备注'] }], links: [[1, 1, 0, 2, 0, 'IMAGE']] };
  const result = await drawing.inspectWorkflow({ document });
  assert.equal(result.converted, true); assert.equal(result.missingNodes.length, 0); assert.equal(result.missingModels.length, 1);
  document.nodes[0].widgets_values.unshift('front-end-only');
  const uncertain = await drawing.inspectWorkflow({ document }); assert.equal(uncertain.missingModels.length, 0); assert.ok(uncertain.warnings.some(w => w.nodeId === '1' && /未核实/.test(w.detail)));
  assert.equal(document.nodes[0].widgets_values[0], 'front-end-only');
  document.nodes[0].widgets_values = [];
  const defaults = await drawing.inspectWorkflow({ document }); assert.equal(defaults.valid, false); assert.equal(defaults.missingModels.length, 0); assert.ok(defaults.warnings.some(w => w.nodeId === '1'));
  document.nodes[0].widgets_values = ['real.safetensors', 0.5];
  const convert = drawing.convert.bind(drawing); drawing.convert = async (...args) => { const prompt = await convert(...args); drawing.connection = null; return prompt; };
  const disconnected = await drawing.inspectWorkflow({ document }); assert.equal(disconnected.available, false); assert.equal(disconnected.valid, false);
  await drawing.connect(); drawing.convert = async () => { drawing.connection = null; throw new Error('conversion failed'); };
  const failedAfterDisconnect = await drawing.inspectWorkflow({ document }); assert.equal(failedAfterDisconnect.available, false); assert.deepEqual(failedAfterDisconnect.missingModels, []);
});

test('服务探测期间配置变化不会启动未经探测的新地址',async t=>{
  const {directory,comfy,closers}=await directoryFixture(t);const store=new WorkbenchStore(directory);let release;let probes=0;let starts=0;
  const gate=new Promise(resolve=>{release=resolve;});store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});
  const drawing=new ComfyDrawing({store,dataDir:directory,WebSocketImpl:null,fetchImpl:async()=>{probes++;await gate;throw new Error('offline');}});closers.push(async()=>{await drawing.close();store.close();});
  drawing.runtime.launch=async()=>{starts++;return{starting:true};};const pending=drawing.launch();const rejection=assert.rejects(pending,/配置.*变化/);
  await until(()=>probes===2);store.saveConfig('drawing',{serviceUrl:'http://127.0.0.1:8288'});release();await rejection;assert.equal(starts,0);
});

test('命令准备期间配置变化不能启动旧命令',async t=>{
  let starts=0;const f=await runtimeFixture(t,{spawnImpl:()=>{starts++;throw new Error('unexpected');}});let release;let prepared=false;
  const gate=new Promise(resolve=>{release=resolve;});const command=f.runtime.command.bind(f.runtime);
  f.runtime.command=async()=>{const result=await command();prepared=true;await gate;return result;};
  const pending=f.runtime.launch();const rejection=assert.rejects(pending,/配置.*变化/);await until(()=>prepared);f.store.saveConfig('drawing',{serviceUrl:'http://127.0.0.1:8288'});release();await rejection;assert.equal(starts,0);
});

for(const fail of [false,true])test(`过期导入${fail?'失败':'成功响应'}不覆盖或断开新的服务连接`,async t=>{
  const {directory,comfy,closers}=await directoryFixture(t);const store=new WorkbenchStore(directory);let hold=false,waiting=false,release;
  const gate=new Promise(resolve=>{release=resolve;});const info=label=>({Save:{output_node:true,input:{required:{text:[[label]]}}}});
  store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});
  const drawing=new ComfyDrawing({store,dataDir:directory,WebSocketImpl:null,fetchImpl:async url=>{
    if(url.endsWith('/system_stats'))return new Response(JSON.stringify({system:{comfyui_version:'fixture'}}));
    if(url.includes(':8188')&&hold){waiting=true;await gate;if(fail)throw new Error('old endpoint failed');}
    return new Response(JSON.stringify(info(url.includes(':8188')?'A':'B')));
  }});closers.push(async()=>{await drawing.close();store.close();});await drawing.connect();hold=true;
  const pending=drawing.importWorkflow({name:'过期',document:{'1':{class_type:'Save',inputs:{text:'A'}}}});const rejection=assert.rejects(pending,/配置|核实|连接/);await until(()=>waiting);
  store.saveConfig('drawing',{serviceUrl:'http://127.0.0.1:8288'});await drawing.connect();release();await rejection;
  assert.equal(drawing.currentConnection(),true);assert.equal(drawing.connection.url,'http://127.0.0.1:8288');assert.deepEqual(drawing.schema,info('B'));assert.equal(drawing.workflows().length,0);
});

test('转换完成前连接失效时拒绝导入，不写入工作流记录',async t=>{
  const {directory,comfy,closers}=await directoryFixture(t);const store=new WorkbenchStore(directory);store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});
  const info={Save:{output_node:true,input:{required:{text:['STRING']}}}};
  const drawing=new ComfyDrawing({store,dataDir:directory,WebSocketImpl:null,fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('system_stats')?{system:{}}:info))});closers.push(async()=>{await drawing.close();store.close();});await drawing.connect();
  const convert=drawing.convert.bind(drawing);drawing.convert=async(...args)=>{const prompt=await convert(...args);drawing.connection=null;drawing.schema={};return prompt;};
  await assert.rejects(drawing.importWorkflow({name:'过期',document:{'1':{class_type:'Save',inputs:{text:'内容'}}}}),/配置|连接/);assert.equal(drawing.workflows().length,0);
});

test('普通工作流子图容器不被当成缺失节点，展开后真实缺项仍报告', {skip:!process.env.AI_FUTURE_TEST_PYTHON}, async t=>{
  const {directory,comfy,closers}=await directoryFixture(t);const store=new WorkbenchStore(directory);store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});
  const info={Save:{output_node:true,input:{required:{text:['STRING']}}}};
  const drawing=new ComfyDrawing({store,dataDir:directory,WebSocketImpl:null,fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('system_stats')?{system:{}}:info))});closers.push(async()=>{await drawing.close();store.close();});drawing.runtime.saveSettings({pythonPath:process.env.AI_FUTURE_TEST_PYTHON});await drawing.connect();
  const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const document={nodes:[{id:10,type:id,inputs:[],outputs:[]}],links:[],definitions:{subgraphs:[{id,nodes:[{id:1,type:'Save',inputs:[],widgets_values:['valid text']}],links:[],inputs:[],outputs:[]}]}};
  const result=await drawing.inspectWorkflow({document});assert.equal(result.valid,true,JSON.stringify(result));assert.equal(result.missingNodes.length,0);
  document.definitions.subgraphs[0].nodes.push({id:2,type:'MissingInside',inputs:[],widgets_values:[]});const missing=await drawing.inspectWorkflow({document});assert.ok(missing.missingNodes.some(item=>item.classType==='MissingInside'));assert.ok(!missing.missingNodes.some(item=>item.classType===id));
});

function branchingEmptyWorkflow() {
  const ids = Array.from({ length: 20 }, (_, index) => `aaaaaaaa-bbbb-cccc-dddd-${String(index).padStart(12, '0')}`);
  const subgraphs = ids.map((id, index) => ({ id, nodes: index === ids.length - 1 ? [] : [{ id: 1, type: ids[index + 1] }, { id: 2, type: ids[index + 1] }] }));
  return { nodes: [{ id: 1, type: ids[0] }], definitions: { subgraphs } };
}

test('子图展开访问预算包含空容器，紧凑分支图不能指数遍历', async () => {
  const { inspectWorkflow } = await import('../framework/drawing-workflows.mjs');
  const document = branchingEmptyWorkflow(); assert.ok(Buffer.byteLength(JSON.stringify(document)) < 4096);
  const report = inspectWorkflow(document, {});
  assert.equal(report.valid, false); assert.match(report.errors[0].detail, /访问.*2000/);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
  const bounded = { nodes: [{ id: 1, type: id }], definitions: { subgraphs: [{ id, nodes: Array.from({ length: 1999 }, (_, index) => ({ id: index, type: 'Note' })) }] } };
  assert.equal(inspectWorkflow(bounded, schema).errors.length, 0);
  bounded.definitions.subgraphs[0].nodes.push({ id: 1999, type: 'Note' });
  assert.match(inspectWorkflow(bounded, schema).errors[0].detail, /访问.*2000/);
});

test('预检发现子图访问超限后直接返回，不调用工作流转换', async t => {
  const { directory, closers } = await directoryFixture(t); const store = new WorkbenchStore(directory); let conversions = 0;
  store.saveConfig('drawing', { serviceUrl: 'http://127.0.0.1:8188' });
  const drawing = new ComfyDrawing({ store, dataDir: directory, WebSocketImpl: null, fetchImpl: async url => new Response(JSON.stringify(url.endsWith('system_stats') ? { system: {} } : schema)) });
  closers.push(async () => { await drawing.close(); store.close(); }); await drawing.connect();
  drawing.convert = async () => { conversions++; return {}; };
  const report = await drawing.inspectWorkflow({ document: branchingEmptyWorkflow() });
  assert.equal(conversions, 0); assert.equal(report.valid, false); assert.match(report.errors[0].detail, /访问.*2000/);
});
