import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkbenchStore } from '../framework/store.mjs';
import { DrawingRuntime, runProbe, validateRuntimeSettings } from '../framework/drawing-runtime.mjs';

const flags = ['--listen', '--port', '--disable-auto-launch', '--output-directory', '--cpu', '--cuda-device', '--gpu-only', '--highvram', '--lowvram', '--novram', '--preview-method', '--preview-size', '--reserve-vram', '--cpu-vae', '--disable-all-custom-nodes', '--disable-xformers', '--use-pytorch-cross-attention', '--use-split-cross-attention', '--use-quad-cross-attention', '--use-sage-attention', '--use-flash-attention', '--use-ck-attention', '--force-upcast-attention', '--dont-upcast-attention', '--enable-dynamic-vram', '--disable-dynamic-vram', '--disable-smart-memory', '--cache-classic', '--cache-lru', '--cache-none', '--cache-ram', '--high-ram', '--async-offload', '--disable-async-offload', '--cuda-malloc', '--disable-cuda-malloc', '--fast', '--force-channels-last', '--deterministic', '--disable-pinned-memory', '--mmap-torch-files', '--disable-mmap', ...['fp32', 'fp64', 'fp16', 'bf16', 'fp8_e4m3fn', 'fp8_e5m2', 'fp8_e8m0fnu'].map(value => `--${value}-unet`), ...['fp32', 'fp16', 'bf16'].map(value => `--${value}-vae`), ...['fp32', 'fp16', 'bf16', 'fp8_e4m3fn', 'fp8_e5m2'].map(value => `--${value}-text-enc`)];
const fastFeatures = ['fp16_accumulation', 'fp8_matrix_mult', 'cublas_ops', 'autotune'];
const source = `${flags.map(flag => `parser.add_argument(${JSON.stringify(flag)})`).join('\n')}\nclass PerformanceFeature(enum.Enum):\n${fastFeatures.map((value, index) => `    Feature${index} = ${JSON.stringify(value)}`).join('\n')}\n`;
const probeScript = fileURLToPath(new URL('../integrations/comfy/runtime_probe.py', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-options-'));
  const comfy = join(directory, 'Comfy UI'); await mkdir(join(comfy, 'comfy'), { recursive: true });
  for (const name of ['main.py', 'server.py', 'nodes.py']) await writeFile(join(comfy, name), '# fixture\n');
  await writeFile(join(comfy, 'comfy/cli_args.py'), source);
  const store = new WorkbenchStore(directory);
  store.saveConfig('drawing', { comfyPath: comfy, serviceUrl: 'http://127.0.0.1:8188', outputPath: join(directory, 'output') });
  let probeCalls = 0; let spawnCalls = 0;
  const probeRunner = async (_executable, args) => {
    probeCalls++;
    if (args.includes('pip')) return { code: 0, stdout: 'No broken requirements found.', stderr: '' };
    const cliSource = await readFile(join(comfy, 'comfy/cli_args.py'));
    return { code: 0, stdout: JSON.stringify({ python: { version: '3.fixture', executable: process.execPath }, cli: { path: join(comfy, 'comfy/cli_args.py'), sha256: sha256(cliSource), flags, fastFeatures }, optionalModules: Object.fromEntries(['xformers', 'sageattention', 'flash_attn', 'comfy_kitchen'].map(name => [name, { present: true }])), torch: { version: '2.fixture', cudaAvailable: true, devices: [{ index: 0, name: 'fixture GPU' }] } }), stderr: '' };
  };
  const runtime = new DrawingRuntime({ store, directory: join(directory, 'drawing'), probeRunner, spawnImpl: () => { spawnCalls++; throw new Error('unexpected spawn'); }, ...options });
  runtime.saveSettings({ pythonPath: process.execPath });
  t.after(async () => { if (runtime.child) { if (typeof runtime.stop === 'function') await runtime.stop(); else runtime.child.kill(); } await runtime.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return { directory, comfy, store, runtime, counts: () => ({ probeCalls, spawnCalls }), probeRunner };
}
async function until(predicate) { for (let n = 0; n < 150; n++) { if (await predicate()) return; await delay(10); } assert.fail('等待超时'); }
function argument(args, flag) { const index = args.indexOf(flag); assert.ok(index >= 0, `缺少 ${flag}`); return args[index + 1]; }

test('旧设置补齐所有默认项，schema、默认值和设置只有一套字段来源', async t => {
  const f = await fixture(t); f.store.setSetting('drawing.runtime', { pythonPath: process.execPath, vramMode: 'lowvram', previewMethod: 'taesd', reserveVram: 1, cpuVae: true, disableCustomNodes: true });
  const state = await f.runtime.state();
  assert.ok(Array.isArray(state.fields));
  assert.deepEqual(Object.keys(state.settings).sort(), Object.keys(state.defaults).sort());
  assert.deepEqual(state.fields.map(field => field.key).sort(), Object.keys(state.defaults).sort());
  assert.equal(new Set(state.fields.map(field => field.key)).size, state.fields.length);
  assert.equal(state.settings.device, 'auto'); assert.equal(state.settings.fastMode, 'off'); assert.equal(state.settings.smartMemory, true); assert.equal(state.settings.vramMode, 'lowvram');
  assert.equal(state.canStop, false); assert.equal(state.capabilities.status, 'unverified');
  assert.equal(state.command.available, true); assert.deepEqual(f.counts(), { probeCalls: 0, spawnCalls: 0 });
  for (const field of state.fields) { assert.ok(field.label); assert.ok(field.group); assert.ok(['text', 'select', 'number', 'boolean', 'multiselect'].includes(field.type)); }
});

test('新的运行设置默认快速预览，旧设置明确关闭时保持关闭', async t => {
  const {runtime,store}=await fixture(t);assert.equal(runtime.settings().previewMethod,'auto');
  store.setSetting('drawing.runtime',{previewMethod:'none'});assert.equal(runtime.settings().previewMethod,'none');
});

test('未知字段、错误类型、范围、重复枚举和互斥设置均拒绝保存', async t => {
  const { runtime } = await fixture(t);
  for (const bad of [{ device: 'metal' }, { device: true }, { cudaDevice: -1 }, { cudaDevice: 0.5 }, { attention: 'shell' }, { unetPrecision: 'fp7' }, { vaePrecision: 'fp8_e4m3fn' }, { textEncoderPrecision: 'fp64' }, { previewSize: 0 }, { previewSize: '512' }, { cacheLruCount: 0 }, { cacheRamActive: -1 }, { cacheRamInactive: '1' }, { asyncOffloadStreams: 0 }, { fastMode: 'yes' }, { fastFeatures: 'autotune' }, { fastFeatures: ['unknown'] }, { fastFeatures: ['autotune', 'autotune'] }, { smartMemory: 1 }, { dynamicVram: true }, { device: 'cuda', vramMode: 'cpu' }, { device: 'cpu', vramMode: 'gpu-only' }, { vramMode: 'gpu-only', cpuVae: true }, { fastMode: 'custom', fastFeatures: [] }, { cacheMode: 'ram', cacheRamActive: 8, cacheRamInactive: 2 }, { cacheMode: 'ram', cacheRamInactive: 2 }, { freeArgs: '--listen 0.0.0.0' }]) assert.throws(() => runtime.saveSettings(bad), undefined, JSON.stringify(bad));
  assert.doesNotThrow(() => validateRuntimeSettings({ mmapTorchFiles: true, disableMmap: true }));
});

test('未诊断的非默认高级参数明确阻止命令和 spawn，默认参数不产生额外 flag', async t => {
  const { runtime, counts } = await fixture(t);
  const baseline = await runtime.command();
  for (const flag of ['--cuda-device', '--cache-ram', '--fast', '--preview-size', '--enable-dynamic-vram', '--disable-smart-memory']) assert.ok(!baseline.args.includes(flag));
  runtime.saveSettings({ attention: 'pytorch' });
  await assert.rejects(runtime.command(), /诊断|核实/); await assert.rejects(runtime.launch(), /诊断|核实/);
  const state = await runtime.state(); assert.equal(state.command.available, false); assert.equal(state.fields.find(field => field.key === 'attention').choices.find(choice => choice.value === 'pytorch').available, false);
  assert.deepEqual(counts(), { probeCalls: 0, spawnCalls: 0 });
});

test('诊断后按数组构建设备、精度、注意力、显存与优化参数', async t => {
  const { runtime } = await fixture(t);
  runtime.saveSettings({ device: 'cuda', cudaDevice: 0, vramMode: 'gpu-only', attention: 'split', unetPrecision: 'fp8_e8m0fnu', vaePrecision: 'bf16', textEncoderPrecision: 'fp8_e4m3fn', attentionUpcast: 'off', dynamicVram: 'off', smartMemory: false, cacheMode: 'lru', cacheLruCount: 17, asyncOffload: 'on', asyncOffloadStreams: 3, cudaMalloc: 'off', fastMode: 'custom', fastFeatures: ['fp16_accumulation', 'cublas_ops'], channelsLast: true, deterministic: true, disablePinnedMemory: true, mmapTorchFiles: true, disableMmap: true, previewSize: 768 });
  const result = await runtime.diagnose(); assert.equal(result.capabilities.status, 'current');
  const { args } = await runtime.command();
  for (const flag of ['--gpu-only', '--use-split-cross-attention', '--disable-xformers', '--fp8_e8m0fnu-unet', '--bf16-vae', '--fp8_e4m3fn-text-enc', '--dont-upcast-attention', '--disable-dynamic-vram', '--disable-smart-memory', '--disable-cuda-malloc', '--force-channels-last', '--deterministic', '--disable-pinned-memory', '--mmap-torch-files', '--disable-mmap']) assert.ok(args.includes(flag), flag);
  assert.equal(argument(args, '--cuda-device'), '0'); assert.equal(argument(args, '--cache-lru'), '17'); assert.equal(argument(args, '--async-offload'), '3'); assert.equal(argument(args, '--preview-size'), '768');
  assert.deepEqual(args.slice(args.indexOf('--fast') + 1, args.indexOf('--fast') + 3), ['fp16_accumulation', 'cublas_ops']);
  assert.ok(!args.includes('--cpu')); assert.ok(!args.includes('--cache-ram')); assert.ok(!args.includes('--enable-dynamic-vram'));
  const state = await runtime.state(); assert.equal(state.fields.find(field => field.key === 'cudaDevice').enabled, true);
});

test('每个枚举映射正确 flag，RAM 双阈值、fast 全部与三态都保持原生语义', async t => {
  const { runtime } = await fixture(t); await runtime.diagnose();
  const reset = async values => { runtime.saveSettings({ ...(await runtime.state()).defaults, pythonPath: process.execPath, ...values }); return (await runtime.command()).args; };
  for (const [attention, flag] of Object.entries({ pytorch: '--use-pytorch-cross-attention', quad: '--use-quad-cross-attention', sage: '--use-sage-attention', flash: '--use-flash-attention', ck: '--use-ck-attention' })) assert.ok((await reset({ attention })).includes(flag));
  const xformers = await reset({ attention: 'xformers' }); assert.ok(!xformers.includes('--disable-xformers')); assert.ok(!xformers.some(flag => flag.startsWith('--use-')));
  for (const [cacheMode, flag] of Object.entries({ classic: '--cache-classic', none: '--cache-none', 'high-ram': '--high-ram' })) assert.ok((await reset({ cacheMode })).includes(flag));
  const ram = await reset({ cacheMode: 'ram', cacheRamActive: 2, cacheRamInactive: 8 }); assert.deepEqual(ram.slice(ram.indexOf('--cache-ram') + 1, ram.indexOf('--cache-ram') + 3), ['2', '8']);
  const all = await reset({ fastMode: 'all' }); assert.equal(all.at(-1), '--fast');
  const on = await reset({ device: 'cpu', attentionUpcast: 'on', dynamicVram: 'off', asyncOffload: 'off', cudaMalloc: 'on' });
  for (const flag of ['--cpu', '--force-upcast-attention', '--disable-dynamic-vram', '--disable-async-offload', '--cuda-malloc']) assert.equal(on.filter(value => value === flag).length, 1);
  const dynamic = await reset({ dynamicVram: 'on' }); assert.ok(dynamic.includes('--enable-dynamic-vram'));
});

test('显式诊断保留原设置但缓存能力，state/command 被动核验且不运行探针', async t => {
  const { runtime, store, counts } = await fixture(t); const before = store.getSetting('drawing.runtime');
  await runtime.diagnose(); assert.deepEqual(store.getSetting('drawing.runtime'), before); assert.ok(store.getSetting('drawing.capabilities'));
  const after = counts(); await runtime.state(); await runtime.command(); assert.deepEqual(counts(), after);
});

test('字段依赖使用 when 表达，草稿切换主选项无需先保存', async t => {
  const { runtime } = await fixture(t); await runtime.diagnose();
  const state = await runtime.state();
  for (const [key, parent, value] of [['cudaDevice', 'device', 'cuda'], ['cacheLruCount', 'cacheMode', 'lru'], ['cacheRamActive', 'cacheMode', 'ram'], ['cacheRamInactive', 'cacheMode', 'ram'], ['asyncOffloadStreams', 'asyncOffload', 'on'], ['fastFeatures', 'fastMode', 'custom']]) {
    const field = state.fields.find(item => item.key === key); assert.deepEqual(field.when, { key: parent, values: [value] }); assert.equal(field.enabled, true);
  }
});

for (const change of ['cli', 'python', 'directory', 'python-file']) test(`能力绑定的 ${change} 改变后拒绝过期高级参数`, async t => {
  const { runtime, comfy, directory, store } = await fixture(t); await runtime.diagnose(); runtime.saveSettings({ deterministic: true });
  if (change === 'cli') await writeFile(join(comfy, 'comfy/cli_args.py'), source + '# changed\n');
  if (change === 'python') { const alternate = join(directory, 'alternate-python.exe'); await writeFile(alternate, 'fixture'); runtime.saveSettings({ pythonPath: alternate }); }
  if (change === 'directory') { const other = join(directory, 'other'); await mkdir(join(other, 'comfy'), { recursive: true }); for (const name of ['main.py', 'server.py', 'nodes.py']) await writeFile(join(other, name), '# fixture'); await writeFile(join(other, 'comfy/cli_args.py'), source); store.saveConfig('drawing', { comfyPath: other }); }
  if (change === 'python-file') { const fake = join(directory, 'python.exe'); await writeFile(fake, 'first'); runtime.saveSettings({ pythonPath: fake }); await runtime.diagnose(); await writeFile(fake, 'second version'); }
  await assert.rejects(runtime.command(), /过期|变化|诊断/); assert.equal((await runtime.state()).capabilities.status, 'stale');
});

test('缺少 CLI flag、fast 枚举或可选依赖时不悄悄忽略设置', async t => {
  const f = await fixture(t); const normal = f.runtime.probeRunner;
  f.runtime.probeRunner = async (...args) => { const result = await normal(...args); if (args[1].includes('pip')) return result; const value = JSON.parse(result.stdout); value.cli.flags = value.cli.flags.filter(flag => flag !== '--deterministic'); value.cli.fastFeatures = ['autotune']; value.optionalModules.sageattention.present = false; return { ...result, stdout: JSON.stringify(value) }; };
  await f.runtime.diagnose();
  for (const [settings, pattern] of [[{ deterministic: true }, /deterministic|确定性/], [{ attention: 'sage' }, /sageattention|依赖/], [{ fastMode: 'custom', fastFeatures: ['fp8_matrix_mult'] }, /fp8_matrix_mult|优化/]]) {
    f.runtime.saveSettings({ ...(await f.runtime.state()).defaults, pythonPath: process.execPath, ...settings }); await assert.rejects(f.runtime.command(), pattern);
  }
  const state = await f.runtime.state(); const sage = state.fields.find(field => field.key === 'attention').choices.find(choice => choice.value === 'sage'); assert.equal(sage.available, false); assert.match(sage.reason, /sageattention/);
});

async function removedFastFeatureFixture(t) {
  const f = await fixture(t); const normal = f.runtime.probeRunner; let features = ['autotune', 'future_feature'];
  f.runtime.probeRunner = async (...args) => { const result = await normal(...args); if (args[1].includes('pip')) return result; const value = JSON.parse(result.stdout); value.cli.fastFeatures = features; return { ...result, stdout: JSON.stringify(value) }; };
  await f.runtime.diagnose(); f.runtime.saveSettings({ fastMode: 'custom', fastFeatures: ['future_feature'] });
  assert.equal(argument((await f.runtime.command()).args, '--fast'), 'future_feature');
  features = ['autotune']; await writeFile(join(f.comfy, 'comfy/cli_args.py'), source + '# future_feature removed\n');
  assert.equal((await f.runtime.diagnose()).capabilities.status, 'current');
  return f;
}

test('重新诊断移除动态 fast 枚举后，历史值仍可查看并标为不可用，不能启动', async t => {
  const f = await removedFastFeatureFixture(t); const state = await f.runtime.state();
  assert.deepEqual(state.settings.fastFeatures, ['future_feature']); assert.equal(state.command.available, false); assert.match(state.command.error, /future_feature/);
  const removed = state.fields.find(field => field.key === 'fastFeatures').choices.find(option => option.value === 'future_feature');
  assert.ok(removed); assert.equal(removed.available, false); assert.match(removed.reason, /PerformanceFeature|future_feature/);
  await assert.rejects(f.runtime.command(), /future_feature/); await assert.rejects(f.runtime.launch(), /future_feature/); assert.equal(f.counts().spawnCalls, 0);
});

test('已移除的保存值允许局部修改、关闭实验优化或恢复默认，但不接受未核实的新值', async t => {
  const f = await removedFastFeatureFixture(t);
  assert.throws(() => f.runtime.saveSettings({ fastFeatures: ['never_verified'] }), /提速项目/);
  assert.equal(f.runtime.saveSettings({ previewMethod: 'taesd' }).previewMethod, 'taesd');
  assert.deepEqual(f.runtime.settings().fastFeatures, ['future_feature']); await assert.rejects(f.runtime.command(), /future_feature/);
  const closed = f.runtime.saveSettings({ fastMode: 'off', fastFeatures: [] }); assert.equal(closed.fastMode, 'off'); assert.deepEqual(closed.fastFeatures, []); assert.equal((await f.runtime.command()).available, true);
  assert.throws(() => f.runtime.saveSettings({ fastMode: 'custom', fastFeatures: ['never_verified'] }), /提速项目/);
  f.store.setSetting('drawing.runtime', { ...closed, fastMode: 'custom', fastFeatures: ['future_feature'] });
  const state = await f.runtime.state(); const reset = f.runtime.saveSettings({ ...state.defaults, pythonPath: process.execPath });
  assert.deepEqual(reset.fastFeatures, []); assert.equal(reset.fastMode, 'off'); assert.equal((await f.runtime.command()).available, true);
});

test('重建运行器仍能读取已移除的历史优化项并保存修正', async t => {
  const f = await removedFastFeatureFixture(t); await f.runtime.close();
  const restored = new DrawingRuntime({ store: f.store, directory: join(f.directory, 'drawing') }); t.after(() => restored.close());
  const state = await restored.state(); assert.deepEqual(state.settings.fastFeatures, ['future_feature']); assert.equal(state.command.available, false);
  restored.saveSettings({ fastMode: 'off', fastFeatures: [] }); assert.equal((await restored.command()).available, true);
});

test('诊断明确报告 Torch 故障或没有 fast 枚举时阻止相应高级启动', async t => {
  const f = await fixture(t); const normal = f.runtime.probeRunner;
  f.runtime.probeRunner = async (...args) => { const result = await normal(...args); if (args[1].includes('pip')) return result; const value = JSON.parse(result.stdout); value.torch = { error: 'No module named torch' }; return { ...result, stdout: JSON.stringify(value) }; };
  await f.runtime.diagnose(); f.runtime.saveSettings({ attention: 'pytorch' }); await assert.rejects(f.runtime.command(), /Torch|torch/);
  f.runtime.probeRunner = async (...args) => { const result = await normal(...args); if (args[1].includes('pip')) return result; const value = JSON.parse(result.stdout); value.cli.fastFeatures = []; return { ...result, stdout: JSON.stringify(value) }; };
  await f.runtime.diagnose(); f.runtime.saveSettings({ attention: 'auto', fastMode: 'all' }); await assert.rejects(f.runtime.command(), /PerformanceFeature|优化/);
});

test('启动前 CLI 已变化时重新核验高级参数，拒绝使用先前预览命令', async t => {
  const f = await fixture(t); await f.runtime.diagnose(); f.runtime.saveSettings({ deterministic: true });
  const original = f.runtime.command.bind(f.runtime); let prepared = false; let release; const gate = new Promise(done => { release = done; });
  f.runtime.command = async () => { const command = await original(); prepared = true; await gate; return command; };
  const pending = f.runtime.launch(); const rejection = assert.rejects(pending, /变化|过期|诊断/); await until(() => prepared); await writeFile(join(f.comfy, 'comfy/cli_args.py'), source + '# changed after preview\n'); release(); await rejection; assert.equal(f.counts().spawnCalls, 0);
});

for (const change of ['config', 'settings', 'cli']) test(`诊断期间 ${change} 改变时丢弃旧结果`, async t => {
  const f = await fixture(t); let release; let entered = false; const gate = new Promise(done => { release = done; }); const normal = f.runtime.probeRunner;
  f.runtime.probeRunner = async (...args) => { const result = await normal(...args); entered = true; await gate; return result; };
  const pending = f.runtime.diagnose(); const rejection = assert.rejects(pending, /配置.*变化|环境.*变化/); await until(() => entered);
  if (change === 'config') f.store.saveConfig('drawing', { serviceUrl: 'http://127.0.0.1:8288' });
  if (change === 'settings') f.runtime.saveSettings({ previewMethod: 'taesd' });
  if (change === 'cli') await writeFile(join(f.comfy, 'comfy/cli_args.py'), source + '# edit during probe\n');
  release(); await rejection; assert.equal(f.store.getSetting('drawing.capabilities') ?? null, null);
});

test('只停止当前持有的真实子进程，等退出后返回且停止请求去重', async t => {
  let child;
  const f = await fixture(t, { spawnImpl: (_executable, _args, options) => { child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options); return child; } });
  await f.runtime.launch(); assert.equal((await f.runtime.state()).canStop, true);
  const [first, second] = await Promise.all([f.runtime.stop(), f.runtime.stop()]);
  assert.equal(first.stopped, true); assert.deepEqual(first, second); assert.equal(child.exitCode !== null || child.signalCode !== null, true); assert.equal(f.runtime.child, null);
  const state = await f.runtime.state(); assert.equal(state.canStop, false); assert.equal(state.launch.status, 'exited'); assert.ok(state.launch.exitedAt); assert.equal(state.launch.stoppedByWorkbench, true); assert.equal(state.launch.error, null);
});

test('历史 PID 与外部进程不能被停止', async t => {
  const f = await fixture(t); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  await new Promise(done => child.once('spawn', done)); t.after(() => { child.kill(); });
  f.runtime.record({ status: 'running', pid: child.pid });
  assert.equal((await f.runtime.state()).canStop, false); await assert.rejects(f.runtime.stop(), /当前.*进程|持有/); assert.equal(child.killed, false);
});

test('命令准备期间运行设置变化也拒绝启动', async t => {
  const f = await fixture(t); const original = f.runtime.command.bind(f.runtime); let prepared = false; let release; const gate = new Promise(done => { release = done; });
  f.runtime.command = async () => { const command = await original(); prepared = true; await gate; return command; };
  const pending = f.runtime.launch(); const rejection = assert.rejects(pending, /设置.*变化|配置.*变化/); await until(() => prepared); f.runtime.saveSettings({ previewMethod: 'taesd' }); release(); await rejection; assert.equal(f.counts().spawnCalls, 0);
});

test('真实 Python 只用 AST 读取恶意 CLI，不执行顶层代码或枚举表达式', { skip: !process.env.AI_FUTURE_TEST_PYTHON }, async t => {
  const { comfy, directory } = await fixture(t); const marker = join(directory, 'must-not-exist.txt');
  const malicious = `import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text('EXECUTED')\nraise RuntimeError('must not run')\nparser.add_argument('--safe', '--alias')\nparser.add_argument(make_flag())\nclass PerformanceFeature(enum.Enum):\n    Safe = 'autotune'\n    Evil = pathlib.Path(${JSON.stringify(marker)}).write_text('EXECUTED')\n`;
  await writeFile(join(comfy, 'comfy/cli_args.py'), malicious);
  const result = await runProbe(process.env.AI_FUTURE_TEST_PYTHON, ['-s', probeScript, '--cli-only', comfy], { cwd: directory, timeoutMs: 20000 });
  assert.equal(result.code, 0, result.stderr); const value = JSON.parse(result.stdout); assert.deepEqual(value.cli.flags, ['--alias', '--safe']); assert.deepEqual(value.cli.fastFeatures, ['autotune']); assert.equal(value.cli.sha256, sha256(malicious)); await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('真实 Python 对语法错误 CLI 返回明确能力错误', { skip: !process.env.AI_FUTURE_TEST_PYTHON }, async t => {
  const { comfy, directory } = await fixture(t); await writeFile(join(comfy, 'comfy/cli_args.py'), 'parser.add_argument(\n');
  const result = await runProbe(process.env.AI_FUTURE_TEST_PYTHON, ['-s', probeScript, '--cli-only', comfy], { cwd: directory });
  assert.equal(result.code, 0); const value = JSON.parse(result.stdout); assert.match(value.cli.error, /syntax|closed|EOF/i); assert.deepEqual(value.cli.flags, []);
});
