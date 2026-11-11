import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError, text } from './contracts.mjs';
import { isComfyDirectory, pythonForComfy } from './drawing-workflows.mjs';
import { launchOptionArguments, runtimeDefaults, runtimeFields, validateLaunchSettings } from './drawing-launch-options.mjs';
import { inspectPreviewModels } from './drawing-preview-models.mjs';

const probeScript = fileURLToPath(new URL('../integrations/comfy/runtime_probe.py', import.meta.url));
const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));
const LOG_LIMIT = 128 * 1024;
const SNAPSHOT_MAX_AGE = 24 * 60 * 60 * 1000;

export async function inspectWorkbenchVersion(root = workbenchRoot) {
  const base = { id: 'workbench', label: '工作台', version: null, status: 'unverified', source: null, detail: '未找到工作台构建或源码版本。' };
  const versionText = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,100}$/.test(value) ? value : null;
  const boundedRead = async path => { const info = await lstat(path); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('版本文件不是普通文件或超过大小限制。'); return readFile(path, 'utf8'); };
  try {
    const record = JSON.parse(await boundedRead(join(root, 'build-record.json')));
    const version = versionText(record.workbenchVersion);
    if (version) return { ...base, version, status: 'current', source: 'build-record.json', detail: '当前工作台构建记录。' };
  } catch { /* A source checkout normally has no build record. */ }
  try {
    const html = await boundedRead(join(root, 'public-workbench', 'index.html'));
    const version = versionText(html.match(/<span\b[^>]*class=["'][^"']*\bversion\b[^"']*["'][^>]*>\s*v?([^<\s]+)\s*<\/span>/i)?.[1]);
    if (version) return { ...base, version, status: 'current', source: 'public-workbench/index.html', detail: '当前源码页面版本；未读取发布构建记录。' };
  } catch { /* Keep missing source versions explicitly unverified. */ }
  return base;
}

function snapshotStatus(capabilities) {
  if (capabilities.status === 'stale') return 'stale';
  const at = Date.parse(capabilities.at);
  if (!Number.isFinite(at)) return 'unverified';
  return Date.now() - at > SNAPSHOT_MAX_AGE ? 'stale' : 'current';
}

function backendState(capabilities) {
  const torch = capabilities.torch || {};
  const name = ['cuda', 'xpu', 'mps', 'cpu'].includes(torch.backend) ? torch.backend : torch.cudaAvailable === true ? 'cuda' : null;
  const backends = torch.backends || {};
  const sourceStatus = snapshotStatus(capabilities);
  const verified = torch.backendStatus === 'verified' && name;
  const status = sourceStatus === 'stale' ? 'stale' : sourceStatus === 'current' && verified ? 'current' : 'unverified';
  const errors = Object.values(backends).map(value => value?.error).filter(Boolean);
  const reason = status === 'stale' ? capabilities.reason || '设备诊断已超过 24 小时，请重新诊断。' : torch.error || errors.join('；') || (status === 'unverified' ? '计算后端尚未核实，请执行环境诊断。' : null);
  return { name, status, devices: backends[name]?.devices || (name === 'cuda' ? torch.devices || [] : []), backends, cpuAvailable: torch.cpuAvailable ?? null, reason, at: capabilities.at || null };
}

function deviceDetail(backend) {
  const names = { cuda: 'CUDA', xpu: 'Intel XPU', mps: 'Apple MPS', cpu: 'CPU 回退' };
  const label = names[backend.name] || '计算设备';
  const devices = backend.devices.map(device => device.name).filter(Boolean).join('、');
  return `${label}${devices ? ` · ${devices}` : ''}${backend.reason ? ` · 未核实：${backend.reason}` : ''}`;
}

function environmentVersions(capabilities) {
  const status = snapshotStatus(capabilities);
  const data = [
    ['comfyui', 'ComfyUI', capabilities.comfy?.version, capabilities.comfy?.source || 'ComfyUI 静态版本文件', capabilities.comfy?.error],
    ['frontend', '网页前端', capabilities.frontend?.version, capabilities.frontend?.source || 'comfyui-frontend-package', capabilities.frontend?.error || '所选 Python 已安装的前端包版本；自定义网页前端未核实。'],
    ['python', 'Python', capabilities.python?.version, capabilities.binding?.pythonPath || '运行环境探针', null],
    ['torch', 'PyTorch', capabilities.torch?.version, '所选 Python 的 torch.__version__', capabilities.torch?.error],
    ['cuda', 'CUDA', capabilities.torch?.cudaVersion, 'PyTorch 编译信息', 'PyTorch 报告的 CUDA 构建版本。'],
  ];
  if (capabilities.torch?.xpuVersion || capabilities.torch?.backend === 'xpu') data.push(['xpu', 'XPU', capabilities.torch?.xpuVersion, 'PyTorch 编译信息', 'PyTorch 报告的 XPU 构建版本。']);
  return data.map(([id, label, rawVersion, source, detail]) => {
    const version = typeof rawVersion === 'string' && rawVersion.length <= 256 ? rawVersion : null;
    return { id, label, version, status: status === 'stale' ? 'stale' : version ? status : 'unverified', source, detail: status === 'stale' ? capabilities.reason || '环境诊断已超过 24 小时，请重新诊断。' : detail || (version ? '最近一次环境诊断；更新依赖后需重新诊断。' : '当前环境版本未核实。'), at: capabilities.at || null };
  });
}

function previewCompatibility(models) {
  return { status: 'unverified', families: [...new Set(models.decoders.map(item => item.family).filter(family => family !== 'unknown'))], detail: '库存按文件名识别，当前工作流的模型架构、解码器权重内容和实际兼容性未核实。' };
}

function pathText(value, label) {
  const result = text(value, label, 4096);
  if (!isAbsolute(result) || /^[\\/]{2}/.test(result) || /[\u0000-\u001f\u007f]/.test(result) || process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(result) || result.slice(2).includes(':'))) throw new WorkbenchError(400, `${label}须为普通本地磁盘的绝对路径。`);
  return resolve(result);
}

export async function runtimeLocalPath(value, label = '路径') {
  const target = pathText(value, label); let current = parse(target).root;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new WorkbenchError(400, `${label}不能使用符号链接或目录联接。`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}

export function validateRuntimeSettings(value, previous = runtimeDefaults(), capabilities) {
  return validateLaunchSettings(value, previous, { validatePath: pathText, capabilities });
}

async function runtimeBinding(cwd, executable) {
  const pythonStat = await lstat(executable);
  const binding = { comfyPath: cwd, pythonPath: executable, pythonSize: pythonStat.size, pythonModifiedAt: pythonStat.mtimeMs, cliPath: join(cwd, 'comfy', 'cli_args.py'), cliSha256: null };
  try {
    await runtimeLocalPath(binding.cliPath, 'ComfyUI CLI');
    const info = await lstat(binding.cliPath);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('CLI 文件不存在、不是普通文件或超过 2 MiB。');
    binding.cliSha256 = createHash('sha256').update(await readFile(binding.cliPath)).digest('hex');
  } catch (error) { binding.cliError = error.message; }
  return binding;
}

// Only diagnostic subprocesses use pipes. The long-lived ComfyUI process writes directly to a file.
export function runProbe(executable, args, { cwd, timeoutMs = 20000, signal, maxBytes = LOG_LIMIT } = {}) {
  return new Promise(resolveResult => {
    let child; let timer; let settled = false; let size = 0; const output = []; const errors = [];
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      resolveResult({ code: null, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), ...result });
    };
    const stop = result => { child?.kill(); finish(result); };
    const cancel = () => stop({ cancelled: true, error: '诊断已取消。' });
    if (signal?.aborted) { cancel(); return; }
    try { child = spawn(executable, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } }); }
    catch (error) { finish({ error: error.message }); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => stop({ timedOut: true, error: `诊断超时（${timeoutMs / 1000} 秒），已终止。` }), timeoutMs);
    const collect = target => bytes => { if (settled) return; size += bytes.length; if (size > maxBytes) { stop({ truncated: true, error: '诊断输出超过限制，已终止。' }); return; } target.push(bytes); };
    child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors));
    child.once('error', error => finish({ error: error.message }));
    child.once('close', (code, exitSignal) => finish({ code, signal: exitSignal }));
  });
}

export class DrawingRuntime {
  constructor({ store, directory, spawnImpl = spawn, probeRunner = runProbe, probeTimeoutMs = 20000 }) {
    this.store = store; this.directory = directory; this.logFile = join(directory, 'comfy-startup.log');
    this.spawn = spawnImpl; this.probeRunner = probeRunner; this.probeTimeoutMs = probeTimeoutMs;
    this.settingsRevision = 0;
    this.closed = false; this.controllers = new Set(); this.pending = new Set(); this.launchRecord = store.getSetting('drawing.launch') || null;
    // A persisted PID is historical evidence, not proof that the same process is still alive.
    if (this.launchRecord && ['starting', 'running', 'stopping'].includes(this.launchRecord.status)) this.launchRecord = { ...this.launchRecord, status: 'unknown' };
  }
  ensureOpen() { if (this.closed) throw new WorkbenchError(503, '绘图运行管理已关闭。'); }
  settings() { return validateRuntimeSettings({}, this.store.getSetting('drawing.runtime') || runtimeDefaults(), this.store.getSetting('drawing.capabilities')); }
  saveSettings(value) { this.ensureOpen(); const settings = validateRuntimeSettings(value, this.settings(), this.store.getSetting('drawing.capabilities')); this.store.setSetting('drawing.runtime', settings); this.settingsRevision++; return settings; }
  async baseCommand(settings = this.settings()) {
    this.ensureOpen(); const config = this.store.module('drawing').config;
    let url; try { url = new URL(config.serviceUrl); } catch { throw new WorkbenchError(400, '请填写 ComfyUI 服务地址。'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new WorkbenchError(400, '启动仅支持本机 HTTP 服务。');
    const cwd = await runtimeLocalPath(config.comfyPath, 'ComfyUI 目录');
    if (!isComfyDirectory(cwd)) throw new WorkbenchError(400, '未找到 ComfyUI 本体，请选择包含 main.py、server.py、nodes.py 和 comfy 文件夹的目录。');
    const executable = await runtimeLocalPath(settings.pythonPath || pythonForComfy(cwd), 'Python 路径');
    try { if (!(await lstat(executable)).isFile()) throw new Error('not file'); } catch { throw new WorkbenchError(400, 'Python 路径不存在或不是文件。'); }
    const args = ['-s', join(cwd, 'main.py'), '--listen', url.hostname === 'localhost' ? '127.0.0.1' : url.hostname.replace(/[\[\]]/g, ''), '--port', url.port || '80', '--disable-auto-launch'];
    if (config.outputPath) args.push('--output-directory', await runtimeLocalPath(config.outputPath, '输出目录'));
    return { available: true, executable, args, cwd };
  }
  async capabilities(command) {
    const record = this.store.getSetting('drawing.capabilities');
    const unverified = { status: 'unverified', reason: '请先执行环境诊断，核实当前 ComfyUI 的启动参数。', cli: { flags: [], fastFeatures: [] } };
    if (!record) return unverified;
    let binding;
    try { const base = command || await this.baseCommand(); binding = await runtimeBinding(base.cwd, base.executable); }
    catch (error) { return { ...record, status: 'stale', reason: `运行环境已变化：${error.message} 请重新诊断。` }; }
    if (JSON.stringify(record.binding) !== JSON.stringify(binding)) return { ...record, status: 'stale', reason: 'ComfyUI 目录、Python 或 CLI 文件已变化，能力记录已过期，请重新诊断。' };
    if (record.cli?.error || !Array.isArray(record.cli?.flags) || !Array.isArray(record.cli?.fastFeatures) || !record.cli?.sha256) return { ...record, status: 'error', reason: record.cli?.error || 'CLI 能力未核实，请重新诊断。' };
    return { ...record, status: 'current', reason: null };
  }
  async command() {
    const settings = this.settings(); const command = await this.baseCommand(settings);
    command.args.push(...launchOptionArguments(settings, await this.capabilities(command)));
    return command;
  }
  async state() {
    this.ensureOpen(); const settings = this.settings(); let command;
    try { command = await this.command(); } catch (error) { command = { available: false, error: error.message }; }
    const [capabilities, previewModels, workbenchVersion] = await Promise.all([this.capabilities(), inspectPreviewModels(this.store.module('drawing').config.comfyPath), inspectWorkbenchVersion()]);
    return { settings, defaults: runtimeDefaults(), fields: runtimeFields(settings, capabilities), capabilities, versions: [workbenchVersion, ...environmentVersions(capabilities)], backend: backendState(capabilities), previewModels, previewCompatibility: previewCompatibility(previewModels), ...this.controlState(), command };
  }
  controlState() { return { canStop: Boolean(this.child && this.child.exitCode == null && this.child.signalCode == null), launch: this.launchRecord }; }
  record(value) { this.launchRecord = value; if (!this.closed) this.store.setSetting('drawing.launch', value); }
  launch(configRevision = this.store.module('drawing').configRevision) {
    this.ensureOpen();
    if (this.stopPromise) throw new WorkbenchError(409, 'ComfyUI 正在停止，请等待退出后再启动。');
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.startProcess(configRevision).finally(() => { this.launchPromise = null; });
    return this.launchPromise;
  }
  async startProcess(configRevision) {
    const settingsRevision = this.settingsRevision;
    const current = () => { this.ensureOpen(); if (configRevision !== this.store.module('drawing').configRevision || settingsRevision !== this.settingsRevision) throw new WorkbenchError(409, 'ComfyUI 配置或运行设置已变化，请按当前配置重新启动。'); };
    const command = await this.command(); current();
    if (this.child && this.launchRecord?.status === 'running') {
      if (command.executable !== this.launchRecord.executable || command.cwd !== this.launchRecord.cwd || JSON.stringify(command.args) !== JSON.stringify(this.launchRecord.args)) throw new WorkbenchError(409, '已有 ComfyUI 进程使用先前参数运行，请在 ComfyUI 中退出后再按新参数启动。');
      return { starting: true, pid: this.child.pid, launch: this.launchRecord };
    }
    const { executable, args, cwd } = command;
    this.record({ status: 'starting', pid: null, startedAt: null, exitedAt: null, exitCode: null, error: null, executable, args, cwd });
    let log;
    try {
      await mkdir(this.directory, { recursive: true }); current();
      // A preview can become stale while preparing the log directory.
      launchOptionArguments(this.settings(), await this.capabilities(command)); current();
      log = openSync(this.logFile, 'a'); if (!fstatSync(log).isFile()) throw new Error('日志路径不是文件。');
    } catch (error) {
      if (log !== undefined) closeSync(log);
      this.record({ ...this.launchRecord, status: 'failed', exitedAt: new Date().toISOString(), error: error.message });
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError(503, `ComfyUI 日志打开失败：${error.message}`);
    }
    try {
      return await new Promise((resolveStart, reject) => {
        let child;
        let spawned = false;
        const failed = error => {
          if (spawned) { if (this.child === child) this.record({ ...this.launchRecord, error: error.message }); return; }
          this.child = null; this.record({ ...this.launchRecord, status: 'failed', exitedAt: new Date().toISOString(), error: error.message }); reject(new WorkbenchError(503, `ComfyUI 启动失败：${error.message}`));
        };
        try { child = this.spawn(executable, args, { cwd, windowsHide: true, detached: true, shell: false, stdio: ['ignore', log, log], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } }); }
        catch (error) { failed(error); return; }
        this.child = child;
        child.on('error', failed);
        child.once('exit', (exitCode, signal) => {
          if (this.child !== child) return;
          const stoppedByWorkbench = this.stopRequestedChild === child;
          this.child = null; this.stopRequestedChild = null;
          this.record({ ...this.launchRecord, status: 'exited', exitedAt: new Date().toISOString(), exitCode, signal: signal || null, ...(stoppedByWorkbench ? { stoppedByWorkbench: true } : {}), error: stoppedByWorkbench || exitCode === 0 ? null : `ComfyUI 进程已退出（${signal || exitCode}）。` });
        });
        child.once('spawn', () => { spawned = true; this.record({ ...this.launchRecord, status: 'running', pid: child.pid, startedAt: new Date().toISOString() }); child.unref(); resolveStart({ starting: true, pid: child.pid, launch: this.launchRecord }); });
      });
    } finally { closeSync(log); }
  }
  stop() {
    this.ensureOpen();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopProcess().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
  async stopProcess() {
    if (this.launchPromise) await this.launchPromise;
    this.ensureOpen(); const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) throw new WorkbenchError(409, '没有当前工作台持有的 ComfyUI 子进程可停止；历史 PID 或外部服务不能用于停止操作。');
    return new Promise((resolveStop, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed); };
      const exited = () => { cleanup(); resolveStop({ stopped: true, launch: this.launchRecord }); };
      const failed = error => { cleanup(); if (this.child === child) this.record({ ...this.launchRecord, status: 'running', error: `停止失败：${error.message}` }); reject(new WorkbenchError(503, `ComfyUI 停止失败：${error.message}`)); };
      child.once('exit', exited); child.once('error', failed);
      this.stopRequestedChild = child;
      this.record({ ...this.launchRecord, status: 'stopping', stopRequestedAt: new Date().toISOString(), error: null });
      timer = setTimeout(() => failed(new Error('等待进程退出超时，尚未确认停止。')), 10000);
      try { if (!child.kill()) failed(new Error('子进程未接受停止请求。')); } catch (error) { failed(error); }
    });
  }
  async logs() {
    this.ensureOpen(); let file;
    try {
      file = await open(this.logFile, 'r'); const { size } = await file.stat();
      const bytes = Buffer.alloc(Math.min(size, LOG_LIMIT)); const result = await file.read(bytes, 0, bytes.length, Math.max(0, size - LOG_LIMIT));
      let content = bytes.subarray(0, result.bytesRead);
      // A byte-limited tail can start in the middle of a UTF-8 character.
      if (size > LOG_LIMIT) { let offset = 0; while (offset < 3 && (content[offset] & 0xc0) === 0x80) offset++; content = content.subarray(offset); }
      return { text: content.toString('utf8'), truncated: size > LOG_LIMIT, ...this.controlState() };
    } catch (error) { if (error.code === 'ENOENT') return { text: '', truncated: false, ...this.controlState() }; throw error; }
    finally { await file?.close(); }
  }
  diagnose() {
    this.ensureOpen(); const controller = new AbortController(); this.controllers.add(controller);
    const task = this.diagnoseEnvironment(controller.signal).finally(() => { this.controllers.delete(controller); this.pending.delete(task); });
    this.pending.add(task); return task;
  }
  async diagnoseEnvironment(signal) {
    const at = new Date().toISOString(); const checks = []; const check = (id, label, status, detail) => checks.push({ id, label, status, detail });
    const revision = this.store.module('drawing').configRevision; const settingsRevision = this.settingsRevision; const settings = this.settings(); const serializedSettings = JSON.stringify(settings);
    const current = () => {
      if (signal.aborted || this.closed) throw new WorkbenchError(503, '诊断已取消。');
      if (revision !== this.store.module('drawing').configRevision || settingsRevision !== this.settingsRevision || serializedSettings !== JSON.stringify(this.settings())) throw new WorkbenchError(409, '诊断期间配置或运行设置已变化，请按当前配置重新诊断。');
    };
    const [previewModels, workbenchVersion] = await Promise.all([inspectPreviewModels(this.store.module('drawing').config.comfyPath), inspectWorkbenchVersion()]); current();
    check('preview-models', '预览解码器', previewModels.status === 'available' ? 'ok' : 'warning', previewModels.detail);
    let command; let binding;
    try { command = await this.baseCommand(settings); binding = await runtimeBinding(command.cwd, command.executable); check('installation', 'ComfyUI 本体', 'ok', command.cwd); }
    catch (error) {
      current(); check('installation', '运行路径', 'error', error.message);
      const capabilities = await this.capabilities(); current();
      return { at, checks, probe: null, pip: null, capabilities, versions: [workbenchVersion, ...environmentVersions(capabilities)], backend: backendState(capabilities), previewModels, previewCompatibility: previewCompatibility(previewModels) };
    }
    current();
    if (signal.aborted) throw new WorkbenchError(503, '诊断已取消。');
    const output = this.store.module('drawing').config.outputPath || command.cwd;
    const options = { cwd: command.cwd, signal, timeoutMs: this.probeTimeoutMs };
    const safely = async args => { try { return await this.probeRunner(command.executable, args, options); } catch (error) { return { code: null, error: error.message, stdout: '', stderr: '' }; } };
    const [environment, pip] = await Promise.all([safely(['-s', probeScript, command.cwd, output]), safely(['-s', '-m', 'pip', 'check'])]);
    current();
    const latestBinding = await runtimeBinding(command.cwd, command.executable); current();
    if (JSON.stringify(binding) !== JSON.stringify(latestBinding)) throw new WorkbenchError(409, '诊断期间运行环境已变化，请重新诊断。');
    const failure = result => result.error || result.stderr?.trim() || `探针退出码 ${result.code}`;
    let probe = null;
    try { if (environment.code !== 0 || environment.error) throw new Error(failure(environment)); probe = JSON.parse(environment.stdout); if (!probe.python?.version) throw new Error('探针未返回有效的 Python 信息。'); }
    catch (error) { check('python', 'Python / Torch', 'error', error.message); }
    if (probe) {
      check('python', 'Python', 'ok', `${probe.python.version} · ${command.executable}`);
      check('comfy', 'ComfyUI 版本', probe.comfy?.version ? 'ok' : 'warning', probe.comfy?.version || probe.comfy?.error || '未找到静态版本信息。');
      check('frontend', '网页前端版本', probe.frontend?.version ? 'ok' : 'warning', probe.frontend?.version ? `${probe.frontend.version} · 已安装 comfyui-frontend-package；自定义网页前端未核实。` : probe.frontend?.error || '未核实已安装的网页前端版本。');
      check('torch', 'PyTorch', probe.torch?.version ? 'ok' : 'error', probe.torch?.error || probe.torch?.version || '无法读取 PyTorch。');
      const backend = backendState({ at, status: 'current', torch: probe.torch });
      check('device', '计算设备', backend.status === 'current' && backend.name !== 'cpu' ? 'ok' : 'warning', deviceDetail(backend));
      check('cli', '启动参数（静态 AST）', probe.cli?.error || !probe.cli?.sha256 ? 'error' : 'ok', probe.cli?.error || (probe.cli?.sha256 ? `${probe.cli.flags?.length || 0} 个参数 · SHA256 ${probe.cli.sha256}` : '未返回 CLI 能力信息。'));
      for (const name of ['xformers', 'sageattention', 'flash_attn', 'comfy_kitchen']) {
        const module = probe.optionalModules?.[name];
        check(`module-${name}`, name, module?.present ? 'ok' : 'warning', module?.present ? '顶层模块可发现；尚未验证导入、GPU、Torch 或模型兼容性。' : module?.error || '当前 Python 未发现该可选模块。');
      }
      for (const [index, disk] of (probe.disks || []).entries()) check(`disk-${index}`, '磁盘空间', disk.error ? 'error' : disk.free < 1024 ** 3 ? 'warning' : 'ok', disk.error || `${disk.path} · 可用 ${(disk.free / 1024 ** 3).toFixed(2)} GiB`);
    }
    check('pip', 'Python 依赖', pip.code === 0 && !pip.error ? 'ok' : 'error', pip.error || [pip.stdout, pip.stderr].filter(Boolean).join('\n').trim() || `pip check 退出码 ${pip.code}`);
    let cli = probe?.cli;
    if (cli?.sha256 && cli.sha256 !== binding.cliSha256) throw new WorkbenchError(409, '诊断期间 CLI 环境已变化，请重新诊断。');
    if (!cli || !Array.isArray(cli.flags) || cli.flags.length > 2000 || cli.flags.some(flag => typeof flag !== 'string' || !/^--[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(flag)) || !Array.isArray(cli.fastFeatures) || cli.fastFeatures.length > 200 || cli.fastFeatures.some(value => typeof value !== 'string' || !/^[a-z0-9_]{1,80}$/.test(value))) cli = { path: binding.cliPath, sha256: binding.cliSha256, flags: [], fastFeatures: [], error: probe?.cli?.error || '探针未返回有效的 CLI 能力信息，请重新诊断。' };
    current();
    const record = { at, binding, cli, python: probe?.python || null, comfy: probe?.comfy || null, frontend: probe?.frontend || null, torch: probe?.torch || null, optionalModules: probe?.optionalModules || {} };
    this.store.setSetting('drawing.capabilities', record);
    const capabilities = { ...record, status: cli.error || !cli.sha256 ? 'error' : 'current', reason: cli.error || (!cli.sha256 ? 'CLI 能力未核实，请重新诊断。' : null) };
    return { at, checks, probe, pip, environment, executable: command.executable, capabilities, versions: [workbenchVersion, ...environmentVersions(capabilities)], backend: backendState(capabilities), previewModels, previewCompatibility: previewCompatibility(previewModels) };
  }
  async close() { this.closed = true; for (const controller of this.controllers) controller.abort(); await Promise.allSettled(this.pending); }
}
