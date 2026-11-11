import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const componentIds = ['training', 'mc-play'];
const terminalTasks = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const forbiddenAction = pathname => /\/api\/modules\/mc-play\/connect$/.test(pathname)
  || /\/api\/training\/(?:start|runtime\/prepare|tasks|quick-start|workflows)$/.test(pathname);
const visible = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].some(node=>!node.closest('[hidden]')&&node.getClientRects().length>0)`;

function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

async function ordinaryPath(path, { allowMissing = false } = {}) {
  let current = resolve(path);
  assert.ok(!/^[\\/]{2}/.test(current), '验收目录必须位于本机磁盘');
  while (true) {
    try { assert.equal((await lstat(current)).isSymbolicLink(), false, '验收路径不允许链接或 junction：' + current); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return resolve(path);
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const { port } = server.address();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

async function closeNativeWindow(pid, executable) {
  assert.ok(Number.isInteger(pid) && pid > 0, '只能关闭本次验收启动的进程');
  const command = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ThinWorkbenchWindow { [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam); }'
$target=Get-Process -Id ([int]$env:THIN_WORKBENCH_WINDOW_PID)
if(![System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($target.Path),[System.IO.Path]::GetFullPath($env:THIN_WORKBENCH_WINDOW_EXE))){throw '验收进程与待关闭 EXE 不符'}
$target.Refresh()
if($target.MainWindowHandle -eq [IntPtr]::Zero){throw '没有找到本次验收的主窗口'}
if(![ThinWorkbenchWindow]::PostMessage($target.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw '发送原生窗口关闭请求失败'}
[pscustomobject]@{pid=$target.Id;windowHandle=$target.MainWindowHandle.ToInt64();method='WM_CLOSE'} | ConvertTo-Json -Compress
`;
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    env: { ...process.env, THIN_WORKBENCH_WINDOW_PID: String(pid), THIN_WORKBENCH_WINDOW_EXE: executable },
    windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done() : reject(new Error('原生窗口关闭请求失败：' + (stderr || signal || code))));
  });
  return JSON.parse(stdout.trim());
}

export class ChromeProtocol {
  constructor(socket, onEvent) {
    this.socket = socket; this.onEvent = onEvent; this.sequence = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(pending.method + ': ' + message.error.message));
        else pending.resolve(message.result);
      } else this.onEvent?.(message.method, message.params || {});
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP 连接已关闭：' + pending.method)); }
      this.pending.clear();
    });
  }
  static async connect(url, onEvent) {
    const target = new URL(url);
    assert.ok(target.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'CDP 必须连接本机地址');
    const socket = new WebSocket(url), client = new ChromeProtocol(socket, onEvent);
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('连接 CDP 超时')); }, 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 CDP')); }, { once: true });
    });
    return client;
  }
  send(method, params = {}, timeoutMs = 30000) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP 尚未连接：' + method));
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 请求超时：' + method)); }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveResult, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression, timeoutMs = 30000) {
    const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || '页面执行失败');
    return reply.result?.value;
  }
  close() { this.socket.close(); }
}

export async function verifyThinWorkbench({ packageDirectory, output, timeoutMs = 20 * 60 * 1000, onProgress = message => console.error(message) }) {
  assert.equal(process.platform, 'win32', '本脚本用于 Windows 打包 EXE 验收');
  assert.equal(typeof WebSocket, 'function', '需要支持内置 WebSocket 的 Node.js');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60 * 60 * 1000, '安装超时参数无效');
  packageDirectory = await ordinaryPath(packageDirectory);
  output = await ordinaryPath(output, { allowMissing: true });
  assert.ok(packageDirectory !== output && !inside(packageDirectory, output), '验收输出必须位于基础包目录之外');
  await mkdir(output, { recursive: true });
  const runDirectory = await mkdtemp(join(output, 'thin-exe-'));
  const profile = join(runDirectory, 'profile'), dataDir = join(profile, 'data');
  await mkdir(profile);
  const reportPath = join(runDirectory, 'report.json'), screenshots = join(runDirectory, 'screenshots');
  await mkdir(screenshots);
  const report = {
    format: 1, runId: randomUUID(), status: 'running', startedAt: new Date().toISOString(),
    packageDirectory, runDirectory, profile, dataDir, reportPath, nodeVersion: process.versions.node,
    scope: { packagedExecutable: true, isolatedProfile: true, trainingKernelStarted: false, minecraftConnected: false, sourceRuntimeImported: false },
    steps: [], screenshots: [], apiCalls: [], rendererExceptions: [], consoleErrors: [], networkFailures: [], blockedActions: [], exitHooks: [], cleanupErrors: [],
  };
  let child, exitResult, cdp, appUrl, phase = 'preflight', completedCleanup = false, closing = false;
  let sentinel, profileSentinel, executable, stderrTail = '', stdoutTail = '', exitPromise, stdoutLog, stderrLog;
  const isAlive = () => child && !exitResult;
  const progress = message => onProgress(`[${new Date().toISOString()}] ${message}`);
  async function saveReport() {
    const contents = JSON.stringify(report, null, 2) + '\n';
    await writeFile(reportPath, contents, 'utf8');
    const temporary = join(output, `thin-report-${report.runId}.tmp`);
    await writeFile(temporary, contents, 'utf8'); await rename(temporary, join(output, 'report.json'));
  }
  async function step(name, run) {
    phase = name; progress(name);
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' }; report.steps.push(entry); await saveReport();
    try { entry.result = await run(); entry.status = 'passed'; return entry.result; }
    catch (error) { entry.status = 'failed'; entry.error = error.stack || error.message; throw error; }
    finally { entry.finishedAt = new Date().toISOString(); await saveReport(); }
  }
  async function waitFor(label, predicate, limit = 60000, interval = 150) {
    const deadline = Date.now() + limit; let lastError;
    while (Date.now() < deadline) {
      if (exitResult && !closing) throw new Error(`EXE 提前退出 ${JSON.stringify(exitResult)}；${stderrTail.slice(-2000)}`);
      try { const value = await predicate(); if (value) return value; } catch (error) { if (error.terminal) throw error; lastError = error; }
      await delay(interval);
    }
    throw new Error(`等待超时：${label}${lastError ? '；' + lastError.message : ''}`);
  }
  async function api(path, { method = 'GET', body, expected = [200], requestTimeout = 120000 } = {}) {
    assert.ok(appUrl, '尚未取得实际桌面服务地址');
    assert.ok(path.startsWith('/api/') || /^\/instances\/[a-f0-9-]+\/api\//.test(path), '验收仅调用工作台 API');
    assert.ok(method !== 'POST' || !forbiddenAction(path), '验收禁止连接游戏或启动训练：' + path);
    const startedAt = Date.now();
    const response = await fetch(new URL(path, appUrl), { method, signal: AbortSignal.timeout(requestTimeout), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { throw new Error(`${method} ${path} 返回了非 JSON：${text.slice(0,300)}`); }
    report.apiCalls.push({ phase, path, method, status: response.status, durationMs: Date.now() - startedAt });
    assert.ok(expected.includes(response.status), `${method} ${path} HTTP ${response.status}: ${value.error || text.slice(0,500)}`);
    return value;
  }
  async function navigate(route) {
    await cdp.evaluate(`(()=>{const hash=${JSON.stringify('#/' + route)};if(location.hash===hash)window.dispatchEvent(new HashChangeEvent('hashchange'));else location.hash=hash;return true})()`);
    await waitFor('页面 ' + route, () => cdp.evaluate(`location.hash===${JSON.stringify('#/' + route)}&&document.querySelector('#main-content')?.getAttribute('aria-busy')==='false'`), 120000);
    await assertViewHealthy();
  }
  async function waitVisible(selector, limit = 60000) { await waitFor(selector, () => cdp.evaluate(visible(selector)), limit); }
  async function click(selector) {
    await waitVisible(selector);
    await cdp.evaluate(`(()=>{const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>!item.closest('[hidden]')&&item.getClientRects().length);if(!node||node.disabled)throw new Error('操作不可用：'+${JSON.stringify(selector)});node.click();return true})()`);
  }
  async function fill(selector, value) {
    await waitVisible(selector);
    await cdp.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  }
  async function dismissModuleTour() {
    if (await cdp.evaluate(visible('[data-tour-skip]'))) await click('[data-tour-skip]');
    await waitFor('关闭首次使用引导', () => cdp.evaluate(`![...document.querySelectorAll('.module-tour')].some(node=>node.matches(':popover-open'))`));
  }
  async function waitStoragePanel() {
    await click('[data-settings-tab="storage"]');
    await waitVisible('.component-storage');
    await waitVisible('[data-component-action="cleanup"][data-component-id="cache"]', 120000);
  }
  async function assertViewHealthy() {
    const failures = await cdp.evaluate(`[...document.querySelectorAll('.module-failure')].filter(node=>!node.closest('[hidden]')&&node.getClientRects().length).map(node=>node.innerText)`);
    assert.deepEqual(failures, [], '真实模块页面出现失败面板：' + failures.join('\n'));
    assert.equal(report.rendererExceptions.length, 0, '出现未捕获的页面异常：' + JSON.stringify(report.rendererExceptions));
    const programmingErrors = report.consoleErrors.filter(entry => /(?:TypeError|ReferenceError|ctx\.|ctx is|Cannot read propert)/i.test(entry.text));
    assert.deepEqual(programmingErrors, [], '页面存在上下文或 JavaScript 错误');
    assert.deepEqual(report.blockedActions, [], '页面尝试了禁止的启动动作');
  }
  async function screenshot(name, selector) {
    if (selector) await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'});true`);
    await cdp.evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const path = join(screenshots, name + '.png'); await writeFile(path, Buffer.from(result.data, 'base64'));
    const dom = await cdp.evaluate(`({title:document.title,hash:location.hash,text:document.body.innerText.slice(0,16000)})`);
    await writeFile(join(screenshots, name + '.json'), JSON.stringify(dom, null, 2) + '\n', 'utf8');
    report.screenshots.push({ name, path, phase }); return path;
  }
  async function addModule(id) {
    await navigate('catalog'); await click(`[data-add="${id}"]`);
    await waitFor(id + ' 入口启用', async () => (await api('/api/state')).modules.find(item => item.id === id)?.enabled);
    await waitVisible(`[data-module-nav="${id}"]`);
    await navigate('module/' + id);
    await waitVisible(`.instance-panel [data-component-row="${id}"]`);
    const instanceId = await cdp.evaluate(`document.querySelector('.instance-panel:not([hidden])')?.dataset.instanceId`);
    assert.match(instanceId || '', /^[a-f0-9-]{36}$/);
    return instanceId;
  }
  async function waitInstalled(id) {
    let lastStage, lastProgress = 0;
    return waitFor(id + ' 安装完成', async () => {
      const state = await api('/api/component-packages'), component = state.components.find(item => item.id === id), task = component?.task;
      if (task?.stage !== lastStage || Date.now() - lastProgress > 15000) {
        lastStage = task?.stage; lastProgress = Date.now();
        progress(`${id}: ${task?.stage || '等待任务'} ${task?.completedBytes || 0}/${task?.totalBytes || 0}`);
      }
      if (terminalTasks.has(task?.status)) {
        if (task.status !== 'completed') throw Object.assign(new Error(`${id} 安装失败：${task.error || task.status}`), { terminal: true });
        assert.equal(component.origin, 'managed'); assert.equal(component.ready, true);
        assert.ok(inside(dataDir, component.path), '组件必须安装到隔离 profile 内');
        return component;
      }
      return false;
    }, timeoutMs, 600);
  }
  async function preserveSentinels() {
    if (sentinel) {
      const state = await api('/api/state'), saved = state.characters.find(item => item.id === sentinel.id);
      assert.equal(saved?.name, sentinel.name); assert.equal(saved?.description, sentinel.description);
      assert.equal(await readFile(join(dataDir, 'thin-personal-sentinel.txt'), 'utf8'), sentinel.description);
    }
    if (profileSentinel) assert.equal((await api('/api/user-profile')).profile.identity, profileSentinel);
    return { characterId: sentinel?.id, characterPreserved: !!sentinel, personalFilePreserved: !!sentinel, userProfilePreserved: !!profileSentinel };
  }
  async function cleanupResources() {
    assert.ok(inside(runDirectory, profile) && inside(profile, dataDir), '拒绝回收非隔离资料目录');
    let state = await api('/api/component-packages');
    for (const item of state.components) if (item.task?.status === 'running') await api(`/api/component-packages/${item.id}/cancel`, { method: 'POST', body: {}, requestTimeout: timeoutMs });
    state = await api('/api/component-packages'); const removed = [];
    for (const id of componentIds) {
      const item = state.components.find(component => component.id === id);
      if (!item?.managed) continue;
      assert.ok(inside(dataDir, item.path), '拒绝卸载隔离 profile 之外的组件');
      const plan = await api('/api/component-packages/plan', { method: 'POST', body: { id, action: 'uninstall' }, requestTimeout: timeoutMs });
      const result = await api('/api/component-packages/execute', { method: 'POST', body: { planId: plan.planId, confirmed: true }, requestTimeout: timeoutMs });
      assert.equal(result.completed, true); removed.push({ id, bytes: result.reclaimedBytes, consequence: plan.consequence });
    }
    const plan = await api('/api/component-packages/plan', { method: 'POST', body: { id: 'cache', action: 'cleanup' }, requestTimeout: timeoutMs });
    const cache = await api('/api/component-packages/execute', { method: 'POST', body: { planId: plan.planId, confirmed: true }, requestTimeout: timeoutMs });
    state = await api('/api/component-packages'); assert.ok(state.components.every(item => !item.ready && !item.managed));
    const storage = await api('/api/component-packages/storage'); assert.equal(storage.cacheBytes, 0);
    completedCleanup = true;
    return { removed, cache, storage, sentinels: await preserveSentinels() };
  }
  async function normalClose() {
    if (!isAlive()) return exitResult;
    closing = true;
    await cdp.send('Runtime.addBinding', { name: '__thinExitObserved' });
    await cdp.evaluate(`window.__thinExitObserved(JSON.stringify({stage:'probe',at:Date.now()}));true`);
    await waitFor('退出观察通道可用', () => report.exitHooks.some(item => item.stage === 'probe'), 5000);
    await cdp.evaluate(`(()=>{const original=window.__workbenchPrepareExit;if(typeof original!=='function')throw new Error('桌面退出草稿钩子不存在');window.__workbenchPrepareExit=async function(...args){window.__thinExitObserved(JSON.stringify({stage:'invoked',at:Date.now()}));try{const result=await original.apply(this,args);window.__thinExitObserved(JSON.stringify({stage:'completed',at:Date.now()}));return result}catch(error){window.__thinExitObserved(JSON.stringify({stage:'failed',error:String(error)}));throw error}};return true})()`);
    // Renderer window.close() bypasses the native close handler in this Electron build.
    // WM_CLOSE exercises the same BrowserWindow close event as the title-bar button.
    const closeRequest = await closeNativeWindow(child.pid, executable);
    await waitFor('实际桌面正常退出', () => exitResult, 60000, 200);
    assert.equal(exitResult.code, 0, '桌面未正常退出');
    assert.ok(report.exitHooks.some(item => item.stage === 'invoked'), '未观察到窗口关闭触发草稿钩子');
    assert.ok(report.exitHooks.some(item => item.stage === 'completed'), '草稿钩子未完成');
    assert.ok(!report.exitHooks.some(item => item.stage === 'failed'), '草稿钩子失败');
    return { ...exitResult, closeRequest, nativeWindowClose: true, draftHookCompleted: true };
  }
  try {
    await step('检查实际基础包与同级组件包', async () => {
      const entries = await readdir(packageDirectory, { withFileTypes: true });
      const executables = entries.filter(item => item.isFile() && /\.exe$/i.test(item.name) && !/(?:crashpad|elevate|unins|setup)/i.test(item.name));
      assert.equal(executables.length, 1, '基础包根目录必须能唯一确定桌面 EXE'); executable = join(packageDirectory, executables[0].name);
      const metadata = JSON.parse(await readFile(join(packageDirectory, 'resources/app/package.json'), 'utf8'));
      assert.equal(metadata.main, 'desktop/workbench.cjs');
      const catalog = JSON.parse(await readFile(join(packageDirectory, 'resources/component-catalog.json'), 'utf8'));
      const componentsDirectory = join(dirname(packageDirectory), 'components'), components = [];
      for (const id of componentIds) {
        const descriptor = catalog.components[id]; assert.ok(descriptor, '发布目录缺少 ' + id);
        assert.match(descriptor.file, /^[A-Za-z0-9._-]+\.afcomponent$/);
        const archive = await ordinaryPath(join(componentsDirectory, descriptor.file));
        assert.equal((await stat(archive)).size, descriptor.bytes); components.push({ id, archive, bytes: descriptor.bytes, sha256: descriptor.sha256 });
      }
      for (const path of ['resources/airi-minecraft', 'resources/next-trainer', 'resources/app/integrations/airi-minecraft', 'resources/app/integrations/next-trainer', 'resources/node.exe']) assert.equal(await exists(join(packageDirectory, path)), false, '基础包混入可选运行组件：' + path);
      report.executable = executable; report.componentsDirectory = componentsDirectory;
      return { executable, version: metadata.version, componentsDirectory, components };
    });
    await step('启动真实 EXE 并连接本机 CDP', async () => {
      const port = await availablePort(), env = { ...process.env };
      const removedEnvironmentKeys = Object.keys(env).filter(key => /^AI_FUTURE_/i.test(key) || /^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key));
      for (const key of removedEnvironmentKeys) delete env[key];
      env.AI_FUTURE_WORKBENCH_PROFILE_DIR = profile;
      const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
      stdoutLog = createWriteStream(join(runDirectory, 'exe-stdout.log')); stderrLog = createWriteStream(join(runDirectory, 'exe-stderr.log'));
      for (const stream of [stdoutLog, stderrLog]) stream.on('error', error => report.cleanupErrors.push('写入 EXE 日志失败：' + error.message));
      child = spawn(executable, args, { cwd: packageDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      exitPromise = new Promise(done => {
        child.once('error', error => { report.spawnError = error.message; });
        child.once('close', (code, signal) => { exitResult = { code, signal, at: new Date().toISOString() }; report.processExit = exitResult; done(exitResult); });
      });
      child.stdout.on('data', chunk => { stdoutTail = (stdoutTail + chunk).slice(-16000); stdoutLog.write(chunk); });
      child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-24000); stderrLog.write(chunk); });
      report.pid = child.pid; report.launch = { executable, args, removedEnvironmentKeys, profile, debugPort: port };
      const target = await waitFor('实际桌面页面', async () => {
        if (report.spawnError) throw new Error(report.spawnError);
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        return (await response.json()).find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url) && item.webSocketDebuggerUrl);
      }, 120000, 300);
      appUrl = new URL(target.url).origin; report.appUrl = appUrl;
      cdp = await ChromeProtocol.connect(target.webSocketDebuggerUrl, (method, params) => {
        if (method === 'Runtime.exceptionThrown') report.rendererExceptions.push({ phase, at: new Date().toISOString(), ...params.exceptionDetails });
        if (method === 'Runtime.consoleAPICalled' && params.type === 'error') report.consoleErrors.push({ phase, text: params.args.map(arg => arg.description || String(arg.value ?? '')).join(' ') });
        if (method === 'Network.loadingFailed' && !params.canceled) report.networkFailures.push({ phase, errorText: params.errorText, type: params.type });
        if (method === 'Runtime.bindingCalled' && params.name === '__thinExitObserved') { try { report.exitHooks.push(JSON.parse(params.payload)); } catch {} }
        if (method === 'Fetch.requestPaused') {
          const blocked = params.request.method === 'POST' && forbiddenAction(new URL(params.request.url).pathname);
          if (blocked) report.blockedActions.push({ phase, url: params.request.url, method: params.request.method });
          void cdp.send(blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: params.requestId, ...(blocked ? { errorReason: 'Aborted' } : {}) }).catch(error => { if (!closing) report.consoleErrors.push({ phase, text: '请求保护失败：' + error.message }); });
        }
      });
      for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await cdp.send(method);
      await cdp.send('Fetch.enable', { patterns: ['*api/modules/mc-play/connect*', '*api/training/start*', '*api/training/runtime/prepare*', '*api/training/tasks*', '*api/training/quick-start*', '*api/training/workflows*'].map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
      await waitFor('基础页面加载完成', () => cdp.evaluate(`document.querySelector('#app-shell')?.getAttribute('aria-busy')==='false'&&document.querySelector('#main-content')?.getAttribute('aria-busy')==='false'`), 120000);
      const startup = JSON.parse(await readFile(join(profile, 'last-start.json'), 'utf8'));
      assert.equal(new URL(startup.url).origin, appUrl); assert.equal(startup.pid, child.pid);
      await assertViewHealthy(); return { pid: child.pid, appUrl, startup };
    });
    await step('验证空基础包和 13 个模块目录', async () => {
      const state = await api('/api/state'), components = await api('/api/component-packages');
      assert.equal(state.modules.length, 13); assert.equal(state.characters.length, 0); assert.equal(state.tasks.length, 0);
      assert.equal(state.modules.filter(item => item.enabled).length, 0);
      assert.equal(components.components.length, 2); assert.ok(components.components.every(item => !item.ready && !item.managed && !item.task));
      assert.ok(inside(dataDir, components.directory));
      assert.equal(await exists(join(components.directory, 'packages')), false, '基础启动不应安装运行组件');
      await screenshot('00-empty-workbench');
      return { modules: state.modules.map(({ id, name, enabled }) => ({ id, name, enabled })), components };
    });
    await step('通过真实角色页面保存隔离测试资料', async () => {
      await navigate('characters');
      const name = '组件验收角色 ' + report.runId.slice(0,8), description = 'thin-package-sentinel:' + report.runId;
      await fill('#new-character-name', name); await fill('#new-character-description', description);
      await cdp.evaluate(`document.querySelector('#create-character-form').requestSubmit();true`);
      sentinel = await waitFor('角色保存', async () => (await api('/api/state')).characters.find(item => item.name === name));
      assert.equal(sentinel.description, description); await writeFile(join(dataDir, 'thin-personal-sentinel.txt'), description, 'utf8');
      await screenshot('01-character-sentinel'); return { id: sentinel.id, name, description };
    });
    report.instances = {};
    for (const id of ['mc-play', 'training']) await step('打开未安装组件入口 ' + id, async () => {
      report.instances[id] = await addModule(id);
      await waitFor('空组件面板 ' + id, () => cdp.evaluate(`[...document.querySelectorAll('[data-component-row="${id}"]')].some(node=>!node.closest('[hidden]')&&node.innerText.includes('尚未安装'))`));
      assert.equal(await cdp.evaluate(visible(id === 'mc-play' ? '#mc-connection-form' : '#training-start-kernel')), false);
      await screenshot(id === 'mc-play' ? '02-mc-empty' : '03-training-empty'); await assertViewHealthy();
      return { instanceId: report.instances[id], ready: false };
    });
    await step('打开设置中的组件与存储管理', async () => {
      await navigate('settings'); await click('[data-settings-tab="user"]'); await waitVisible('[data-user-profile-form]');
      profileSentinel = 'thin-profile-sentinel:' + report.runId;
      await fill('#profile-display-name', '隔离验收'); await fill('#profile-identity', profileSentinel);
      await cdp.evaluate(`document.querySelector('[data-user-profile-form]').requestSubmit();true`);
      await waitFor('用户资料保存', async () => (await api('/api/user-profile')).profile.identity === profileSentinel);
      await waitStoragePanel();
      await screenshot('04-settings-empty', '.component-storage'); return { storage: await api('/api/component-packages/storage') };
    });
    report.installed = {};
    for (const id of componentIds) await step('通过实际打包服务安装组件 ' + id, async () => {
      const started = await api(`/api/component-packages/${id}/install`, { method: 'POST', body: {}, expected: [202] });
      assert.ok(started.task?.id, '隔离资料不应复用外部组件');
      const installed = await waitInstalled(id); report.installed[id] = installed; return installed;
    });
    await step('验证安装后的真实 MC 页面与环境发现', async () => {
      await navigate('module/mc-play'); await waitVisible('#mc-connection-form', 120000); await waitVisible('[data-environment-discovery]', 120000);
      await dismissModuleTour();
      const state = await api(`/instances/${report.instances['mc-play']}/api/modules/mc-play/state`);
      assert.equal(state.runtime.available, true); assert.equal(state.connection.status, 'disconnected');
      assert.equal(await cdp.evaluate(`document.querySelector('.instance-panel:not([hidden]) #mc-connect')?.disabled`), false);
      await assertViewHealthy(); await screenshot('05-mc-installed', '.instance-panel:not([hidden]) [data-environment-discovery]');
      return { runtime: state.runtime, connectionStatus: state.connection.status, environmentDiscoveryVisible: true };
    });
    await step('验证安装后的真实训练页面与目录读取', async () => {
      await navigate('module/training'); await waitVisible('#training-start-kernel', 120000);
      await dismissModuleTour();
      const prefix = `/instances/${report.instances.training}/api/training/`, catalog = await api(prefix + 'catalog');
      assert.ok(catalog.training_types?.length > 0, '训练组件目录没有训练类型');
      await waitFor('训练页面采用组件目录', () => cdp.evaluate(`document.querySelector('.instance-panel:not([hidden]) [data-training-type]')?.options.length>1`), 120000);
      const state = await api(prefix + 'state'); assert.notEqual(state.runtime?.status, 'running'); assert.equal(state.tasks?.length || 0, 0);
      await click('.instance-panel:not([hidden]) #tab-overview'); await waitVisible('.instance-panel:not([hidden]) [data-training-type]');
      await assertViewHealthy(); await screenshot('06-training-installed', '.instance-panel:not([hidden]) .training-runtime-bar');
      return { trainingTypeCount: catalog.training_types.length, runtimeStatus: state.runtime?.status, tasks: state.tasks?.length || 0 };
    });
    await step('检查安装后的共享组件管理界面', async () => {
      await navigate('settings'); await waitStoragePanel(); await waitVisible('[data-component-action="uninstall"][data-component-id="training"]'); await waitVisible('[data-component-action="uninstall"][data-component-id="mc-play"]');
      await screenshot('07-settings-installed', '.component-storage'); await assertViewHealthy(); return await preserveSentinels();
    });
    await step('经实际 API 卸载组件并回收缓存，保留角色哨兵', cleanupResources);
    await step('核对回收后的真实界面', async () => {
      await navigate('home'); await navigate('settings'); await waitStoragePanel();
      await waitFor('设置显示组件未安装', () => cdp.evaluate(`[...document.querySelectorAll('[data-component-row]')].filter(node=>!node.closest('[hidden]')).length===2&&[...document.querySelectorAll('[data-component-row]')].filter(node=>!node.closest('[hidden]')).every(node=>node.innerText.includes('尚未安装'))`));
      await screenshot('08-settings-cleaned', '.component-storage');
      await navigate('characters'); await waitFor('角色界面仍保留哨兵', () => cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(sentinel.name)})`));
      await screenshot('09-character-preserved'); await assertViewHealthy(); return await preserveSentinels();
    });
    await step('通过原生窗口关闭执行草稿钩子并正常退出', normalClose);
    await step('退出后从实际隔离资料核对角色落盘', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(dataDir, 'workbench.sqlite'), { readOnly: true });
      try {
        const character = database.prepare('SELECT id,name,description FROM characters WHERE id=?').get(sentinel.id);
        assert.equal(character?.description, sentinel.description);
        assert.equal(await readFile(join(dataDir, 'thin-personal-sentinel.txt'), 'utf8'), sentinel.description);
        return { character, persistedAfterExit: true };
      } finally { database.close(); }
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = error.stack || String(error); progress('验收失败：' + error.message);
    if (cdp && isAlive()) try { await screenshot('failure'); } catch (captureError) { report.failureScreenshotError = captureError.message; }
  } finally {
    if (isAlive() && appUrl && !completedCleanup) {
      try { phase = 'failure-cleanup'; report.failureCleanup = await cleanupResources(); }
      catch (error) { report.cleanupErrors.push(error.message); }
    }
    if (isAlive() && cdp) {
      try { phase = 'final-close'; report.finalClose = await normalClose(); }
      catch (error) { report.cleanupErrors.push(error.message); }
    }
    if (isAlive()) {
      report.forcedTermination = true; report.status = 'failed'; child.kill();
      await Promise.race([exitPromise, delay(10000)]);
    }
    cdp?.close();
    for (const stream of [stdoutLog, stderrLog]) if (stream) await new Promise(done => stream.end(done));
    if (report.cleanupErrors.length) report.status = 'failed';
    report.stdoutTail = stdoutTail; report.stderrTail = stderrTail; report.finishedAt = new Date().toISOString(); await saveReport();
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { package: { type: 'string' }, output: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log("node tools/verify-thin-workbench.mjs --package '<win-unpacked>' --output '<artifact-directory>' [--timeout-ms 1200000]\n使用全新隔离 profile 启动真实 EXE，经本机 CDP 验收、截图和关闭；不会连接游戏或启动训练内核。");
  } else {
    assert.ok(values.package && values.output, '必须提供 --package 和 --output；可用 --help 查看说明');
    const result = await verifyThinWorkbench({ packageDirectory: values.package, output: values.output, ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}) });
    console.log(JSON.stringify({ status: result.status, reportPath: result.reportPath, profile: result.profile, screenshots: result.screenshots.map(item => item.path) }, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  }
}
