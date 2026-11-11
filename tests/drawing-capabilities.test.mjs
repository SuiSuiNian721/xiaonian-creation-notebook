import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchStore } from '../framework/store.mjs';
import * as runtimeModule from '../framework/drawing-runtime.mjs';

const probeScript = fileURLToPath(new URL('../integrations/comfy/runtime_probe.py', import.meta.url));
const python = process.env.AI_FUTURE_TEST_PYTHON;
const cliSource = 'parser.add_argument("--preview-method")\n';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-capabilities-'));
  const closers = [];
  const comfy = join(directory, 'Comfy UI');
  await mkdir(join(comfy, 'comfy'), { recursive: true });
  for (const name of ['main.py', 'nodes.py', 'server.py']) await writeFile(join(comfy, name), '# fixture\n');
  await writeFile(join(comfy, 'comfy', 'cli_args.py'), cliSource);
  await writeFile(join(comfy, 'comfyui_version.py'), '__version__ = "0.fixture"\n');
  t.after(async () => {
    for (const close of closers) await close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, comfy, closers };
}

async function controlledProbe(t, scenario) {
  const { comfy } = await fixture(t);
  const code = `import importlib.metadata, importlib.util, json, runpy, sys, types
scenario = json.loads(sys.argv[3])
def unavailable():
    return False
def fail_count():
    raise RuntimeError("device enumeration failed")
def fail_available():
    raise RuntimeError("driver query failed")
def adapter(name):
    available = scenario.get(name, False)
    value = types.SimpleNamespace(is_available=(fail_available if scenario.get(name + "QueryError") else lambda: available), device_count=lambda: 1, get_device_name=lambda index: name.upper() + " fixture GPU", get_device_properties=lambda index: types.SimpleNamespace(total_memory=8192))
    if scenario.get(name + "EnumerationError"):
        value.device_count = fail_count
    if name == "cuda":
        value.mem_get_info = lambda index: (4096, 8192)
    return value
torch = types.ModuleType("torch")
torch.__version__ = "2.fixture"
torch.version = types.SimpleNamespace(cuda="12.fixture", xpu="2026.fixture")
torch.cuda = adapter("cuda")
torch.xpu = adapter("xpu")
torch.backends = types.SimpleNamespace(mps=adapter("mps"))
sys.modules["torch"] = torch
importlib.util.find_spec = lambda name: None
importlib.metadata.version = lambda name: "1.fixture" if name == "comfyui-frontend-package" else None
script, directory = sys.argv[1:3]
sys.argv = [script, directory, directory]
runpy.run_path(script, run_name="__main__")
`;
  const result = await runtimeModule.runProbe(python, ['-s', '-c', code, probeScript, comfy, JSON.stringify(scenario)], { cwd: comfy });
  assert.equal(result.code, 0, result.stderr || result.error);
  return JSON.parse(result.stdout);
}

test('受控探针在 CUDA 不可用时识别 Intel XPU，并保留 CUDA 旧字段', { skip: !python }, async t => {
  const result = await controlledProbe(t, { xpu: true });
  assert.equal(result.torch.backend, 'xpu');
  assert.equal(result.torch.backendStatus, 'verified');
  assert.equal(result.torch.cudaAvailable, false);
  assert.equal(result.torch.cudaVersion, '12.fixture');
  assert.deepEqual(result.torch.devices, []);
  assert.equal(result.torch.backends.xpu.devices[0].name, 'XPU fixture GPU');
  assert.equal(result.torch.backends.xpu.devices[0].vramTotal, 8192);
  assert.equal(result.frontend.version, '1.fixture');
  assert.equal(result.frontend.source, 'comfyui-frontend-package');
});

test('受控探针识别 CUDA、MPS 和 CPU 回退且不把枚举失败当作缺设备', { skip: !python }, async t => {
  const cuda = await controlledProbe(t, { cuda: true });
  assert.equal(cuda.torch.backend, 'cuda');
  assert.equal(cuda.torch.devices[0].vramFree, 4096);
  const mps = await controlledProbe(t, { mps: true });
  assert.equal(mps.torch.backend, 'mps');
  const cpu = await controlledProbe(t, {});
  assert.equal(cpu.torch.backend, 'cpu');
  assert.equal(cpu.torch.cpuAvailable, true);
  const failed = await controlledProbe(t, { xpu: true, xpuEnumerationError: true });
  assert.equal(failed.torch.backend, 'xpu');
  assert.equal(failed.torch.backendStatus, 'unverified');
  assert.equal(failed.torch.backends.xpu.available, true);
  assert.match(failed.torch.backends.xpu.error, /device enumeration failed/);
  const unknown = await controlledProbe(t, { cudaQueryError: true });
  assert.equal(unknown.torch.backendStatus, 'unverified');
  assert.equal(unknown.torch.backends.cuda.available, null);
});

async function inspectModels(comfy) {
  const module = await import('../framework/drawing-preview-models.mjs').catch(() => ({}));
  assert.equal(typeof module.inspectPreviewModels, 'function', '应提供独立的预览解码器库存检查');
  return module.inspectPreviewModels(comfy);
}

test('预览库存只识别顶层普通 decoder 文件并标记模型家族', async t => {
  const { comfy } = await fixture(t);
  const directory = join(comfy, 'models', 'vae_approx');
  await mkdir(join(directory, 'nested'), { recursive: true });
  const decoders = [
    ['taesd_decoder.pth', 'SD1.5'], ['taesdxl_decoder.safetensors', 'SDXL'],
    ['taef1_decoder.pth', 'Flux'], ['taesd3_decoder.safetensors', 'SD3'],
    ['taehv.safetensors', 'HunyuanVideo'], ['lighttaew2_1.pth', 'Wan2.1'],
    ['taeh3.safetensors', 'MiniMaxH3Video'], ['taeltx_2.safetensors', 'LTX2'],
    ['mystery_decoder.safetensors', 'unknown'],
  ];
  for (const [name] of decoders) await writeFile(join(directory, name), 'fixture');
  for (const name of ['taesd_encoder.pth', 'taesd_decoder.txt', 'model.safetensors', 'taehv_encoder.pth']) await writeFile(join(directory, name), 'fixture');
  await writeFile(join(directory, 'nested', 'taef2_decoder.pth'), 'fixture');
  await mkdir(join(directory, 'taef2_decoder.safetensors'));
  const result = await inspectModels(comfy);
  assert.equal(result.status, 'available');
  assert.equal(result.scope, 'local');
  assert.equal(result.directory, directory);
  assert.deepEqual(result.decoders.map(item => [item.name, item.family]).sort(), decoders.sort());
  assert.match(result.detail, /兼容性|架构/);
  assert.match(result.detail, /extra_model_paths|外部/);
});

test('无本地预览模型时限定缺失范围，目录联接与无效路径返回未核实', async t => {
  const { comfy, directory } = await fixture(t);
  const missing = await inspectModels(comfy);
  assert.equal(missing.status, 'missing');
  assert.match(missing.detail, /本地/);
  assert.match(missing.detail, /extra_model_paths|外部/);
  assert.equal((await inspectModels('')).status, 'unverified');
  assert.equal((await inspectModels('relative/ComfyUI')).status, 'unverified');
  const outside = join(directory, 'outside');
  await mkdir(join(outside, 'vae_approx'), { recursive: true });
  await writeFile(join(outside, 'vae_approx', 'taesd_decoder.pth'), 'fixture');
  await symlink(outside, join(comfy, 'models'), 'junction');
  const linked = await inspectModels(comfy);
  assert.equal(linked.status, 'unverified');
  assert.deepEqual(linked.decoders, []);
  assert.match(linked.detail, /联接|链接/);
});

test('预览目录中仅有空解码器或超过扫描上限时不宣称全部缺失', async t => {
  const { comfy } = await fixture(t);
  const directory = join(comfy, 'models', 'vae_approx');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'taesd_decoder.pth'), '');
  const empty = await inspectModels(comfy);
  assert.equal(empty.status, 'unverified');
  assert.deepEqual(empty.decoders, []);
  assert.match(empty.detail, /空文件/);
  await rm(join(directory, 'taesd_decoder.pth'));
  for (let batch = 0; batch < 21; batch++) await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(directory, `ignored-${batch}-${index}.txt`), 'fixture')));
  const bounded = await inspectModels(comfy);
  assert.equal(bounded.status, 'unverified');
  assert.match(bounded.detail, /上限/);
});

test('工作台版本优先构建记录，源码版本取自当前页面，不使用 package 版本', async t => {
  const { directory } = await fixture(t);
  assert.equal(typeof runtimeModule.inspectWorkbenchVersion, 'function');
  await mkdir(join(directory, 'public-workbench'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await writeFile(join(directory, 'public-workbench', 'index.html'), '<span class="version">v0.10.fixture</span>');
  const source = await runtimeModule.inspectWorkbenchVersion(directory);
  assert.equal(source.version, '0.10.fixture');
  assert.equal(source.source, 'public-workbench/index.html');
  await writeFile(join(directory, 'build-record.json'), JSON.stringify({ workbenchVersion: '0.11.fixture' }));
  const built = await runtimeModule.inspectWorkbenchVersion(directory);
  assert.equal(built.version, '0.11.fixture');
  assert.equal(built.source, 'build-record.json');
  await rm(join(directory, 'build-record.json'));
  await rm(join(directory, 'public-workbench', 'index.html'));
  assert.equal((await runtimeModule.inspectWorkbenchVersion(directory)).status, 'unverified');
});

test('Python 路径无效时诊断仍返回有来源的版本与未核实设备，不启动探针', async t => {
  const { directory, comfy, closers } = await fixture(t);
  const store = new WorkbenchStore(directory);
  store.saveConfig('drawing', { comfyPath: comfy, serviceUrl: 'http://127.0.0.1:8188' });
  let calls = 0;
  const runtime = new runtimeModule.DrawingRuntime({ store, directory: join(directory, 'drawing'), probeRunner: async () => { calls++; throw new Error('unexpected probe'); } });
  runtime.saveSettings({ pythonPath: join(directory, 'missing-python.exe') });
  closers.push(async () => { await runtime.close(); store.close(); });
  const result = await runtime.diagnose();
  assert.equal(result.checks.find(item => item.id === 'installation').status, 'error');
  assert.equal(result.backend?.status, 'unverified');
  assert.equal(result.versions.find(item => item.id === 'workbench').status, 'current');
  assert.equal(result.versions.find(item => item.id === 'python').status, 'unverified');
  assert.equal(result.previewModels.status, 'missing');
  assert.equal(result.previewCompatibility.status, 'unverified');
  assert.equal(calls, 0);
});

test('运行状态提供分层版本、XPU 与库存，环境变化后诊断数据标记过期', async t => {
  const { directory, comfy, closers } = await fixture(t);
  const store = new WorkbenchStore(directory);
  store.saveConfig('drawing', { comfyPath: comfy, serviceUrl: 'http://127.0.0.1:8188' });
  const runtime = new runtimeModule.DrawingRuntime({ store, directory: join(directory, 'drawing'), probeRunner: async (_executable, args) => {
    if (args.includes('pip')) return { code: 0, stdout: 'No broken requirements found.', stderr: '' };
    return { code: 0, stderr: '', stdout: JSON.stringify({
      python: { version: '3.fixture' }, comfy: { version: '0.fixture' }, frontend: { version: '1.fixture', source: 'comfyui-frontend-package' },
      cli: { flags: ['--preview-method'], fastFeatures: [], sha256: createHash('sha256').update(await readFile(join(comfy, 'comfy', 'cli_args.py'))).digest('hex') },
      torch: { version: '2.fixture', cudaAvailable: false, devices: [], cpuAvailable: true, backend: 'xpu', backendStatus: 'verified', backends: { xpu: { available: true, status: 'available', devices: [{ index: 0, name: 'Intel fixture' }] } } },
    }) };
  } });
  runtime.saveSettings({ pythonPath: process.execPath });
  closers.push(async () => { await runtime.close(); store.close(); });
  const before = await runtime.state();
  assert.equal(before.backend?.status, 'unverified');
  assert.equal(before.versions.find(item => item.id === 'python').status, 'unverified');
  const diagnosis = await runtime.diagnose();
  assert.equal(diagnosis.checks.find(item => item.id === 'device').status, 'ok');
  assert.match(diagnosis.checks.find(item => item.id === 'device').detail, /XPU/);
  assert.equal(diagnosis.previewModels.status, 'missing');
  assert.ok(diagnosis.checks.some(item => item.id === 'preview-models'));
  const state = await runtime.state();
  assert.equal(state.backend.name, 'xpu');
  assert.equal(state.backend.status, 'current');
  for (const [id, version] of [['python', '3.fixture'], ['comfyui', '0.fixture'], ['frontend', '1.fixture'], ['torch', '2.fixture']]) {
    const entry = state.versions.find(item => item.id === id);
    assert.equal(entry.version, version); assert.equal(entry.status, 'current'); assert.ok(entry.source);
  }
  assert.equal(state.previewModels.status, 'missing');
  assert.equal(state.previewCompatibility.status, 'unverified');
  await writeFile(join(comfy, 'comfy', 'cli_args.py'), cliSource + '# changed');
  const stale = await runtime.state();
  assert.equal(stale.backend.status, 'stale');
  assert.equal(stale.versions.find(item => item.id === 'python').status, 'stale');
  assert.equal(stale.versions.find(item => item.id === 'workbench').status, 'current');
});
