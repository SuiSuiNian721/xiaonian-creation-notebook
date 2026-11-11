import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WorkbenchError } from './contracts.mjs';
import { trainingEngineDirectories } from './training-engine-layout.mjs';
import { TrainingStartupLock } from './training-startup-lock.mjs';

export const trainingIntegrationDir = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
// Adapt the pinned engine's public recovery text without rewriting user paths.
export const trainingDisplayMessage = value => String(value).replaceAll('兼容 Next Trainer 安装', '兼容训练环境');
const processorFiles = ['workbench_preprocess.py', 'workbench_vision.py', 'workbench_caption.py'];
// Closed modules may leave a busy detached sidecar alive. Keep its leases until
// a confirmed process exit, including leases held by other module instances.
const processComponentLeases = new Set();
const samePath = (first, second) => first && second && (process.platform === 'win32' ? resolve(first).toLowerCase() === resolve(second).toLowerCase() : resolve(first) === resolve(second));
const missingTrainingComponent = () => new WorkbenchError(503, '训练组件尚未准备，请先在组件管理中安装或选择已有训练组件。');
async function releaseComponentLease(holder) {
  if (!holder || holder.released) return;
  if (!holder.releasing) holder.releasing = Promise.resolve().then(() => holder.lease.release()).then(() => {
    holder.released = true; clearInterval(holder.monitor); processComponentLeases.delete(holder);
  }).finally(() => { holder.releasing = null; });
  return holder.releasing;
}
function watchComponentProcess(holder, pid) {
  if (!holder || !Number.isInteger(pid) || pid <= 0) return;
  holder.pid = pid; processComponentLeases.add(holder);
  if (!holder.monitor) {
    holder.monitor = setInterval(() => {
      if (!trainingProcessExists(holder.pid)) releaseComponentLease(holder).catch(() => {});
    }, 500);
    holder.monitor.unref();
  }
}
async function releaseStoppedComponentLeases(recordPath) {
  await Promise.all([...processComponentLeases].filter(holder => samePath(holder.recordPath, recordPath) && !trainingProcessExists(holder.pid)).map(releaseComponentLease));
}
export async function trainingAdapterRevision(integrationDir = trainingIntegrationDir) {
  const names = ['runner.py', 'prepare_service.py', 'catalog.json', ...processorFiles];
  const parts = await Promise.all(names.map(async name => [name, digest(await readFile(join(integrationDir, name)))]));
  return digest(JSON.stringify(parts));
}
export const activeTrainingStatuses = new Set(['CREATED', 'RUNNING', 'QUEUED']);
export function trainingProcessExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
const boundedJson = async (path, limit = 8 * 1024 * 1024) => {
  const info = await stat(path); if (!info.isFile() || info.size > limit) throw new WorkbenchError(400, '训练记录不是文件或超过读取限制。');
  return JSON.parse(await readFile(path, 'utf8'));
};
const writeJson = async (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0;; attempt++) {
      try { await rename(temporary, path); return; }
      catch (error) {
        // Windows readers can briefly block replacement; keep the old record
        // intact while retrying instead of deleting it before publication.
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(Math.min(20 * 2 ** attempt, 160));
      }
    }
  } finally { await rm(temporary, { force: true }); }
};

export function trainingPath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f]/.test(value) || /^[\\/]{2}/.test(value)) throw new WorkbenchError(400, `${label}须为本地绝对路径。`);
  return resolve(value);
}

export async function verifyKernel(integrationDir = trainingIntegrationDir, {signal} = {}) {
  signal?.throwIfAborted();
  let manifest;
  try { manifest = await boundedJson(join(integrationDir, 'source-manifest.json')); }
  catch (error) { throw new WorkbenchError(503, `内置训练源码清单读取失败：${error.message}`); }
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || !manifest.kernelRevision) throw new WorkbenchError(503, '内置训练源码清单校验失败。');
  const seen = new Set();
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    if (!file.path || file.path.includes('\\') || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new WorkbenchError(503, '内置训练源码路径或哈希校验失败。');
    seen.add(file.path);
    const path = join(integrationDir, 'source', file.path);
    let info;
    try { info = await lstat(path); } catch { throw new WorkbenchError(503, `内置训练源码缺失：${file.path}`); }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || digest(await readFile(path)) !== file.sha256) throw new WorkbenchError(503, `内置训练源码哈希校验失败：${file.path}`);
  }
  return manifest;
}

export async function materializeKernel({ integrationDir = trainingIntegrationDir, directory, environmentRoot, engineTargets = {}, signal }) {
  const manifest = await verifyKernel(integrationDir,{signal});
  const adapter = await readFile(join(integrationDir, 'runner.py'));
  const adapterRevision = await trainingAdapterRevision(integrationDir);
  const binding = digest(JSON.stringify([resolve(environmentRoot).toLowerCase(),engineTargets,trainingEngineDirectories])).slice(0, 12);
  const root = join(directory, 'kernel', `${manifest.kernelRevision.slice(0, 20)}-${adapterRevision.slice(0, 12)}-${binding}`);
  await mkdir(root, { recursive: true });
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const target = join(root, file.path);
    let matches = false;
    try { const info = await lstat(target); if (info.isSymbolicLink() || !info.isFile()) throw new WorkbenchError(409, `训练副本路径不是普通文件：${file.path}`); matches = info.size === file.size && digest(await readFile(target)) === file.sha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!matches) { await mkdir(dirname(target), { recursive: true }); await copyFile(join(integrationDir, 'source', file.path), target); }
  }
  // Controller modules always come from the verified app snapshot. Kohya reuses
  // its existing venv; other engine roots are isolated until explicitly selected.
  await mkdir(join(root, 'extensions'), { recursive: true });
  const engineRoots={};
  for(const [id,nativeDirectory] of Object.entries(trainingEngineDirectories)){
    signal?.throwIfAborted();
    const mode=engineTargets[id]||(id==='kohya'?'original':'isolated');
    const target=join(root,'extensions',nativeDirectory),original=mode==='original'?join(environmentRoot,'extensions',nativeDirectory):join(directory,'engine-environments',nativeDirectory);
    await mkdir(original,{recursive:true});
    try{const info=await lstat(target);if(!info.isSymbolicLink()||(await realpath(target)).toLowerCase()!==(await realpath(original)).toLowerCase())throw new WorkbenchError(409,`训练引擎 ${id} 环境联接不一致。`);}
    catch(error){if(error.code!=='ENOENT')throw error;await symlink(original,target,process.platform==='win32'?'junction':'dir');}
    engineRoots[id]={directory:nativeDirectory,root:await realpath(original)};
  }
  await writeJson(join(root,'workbench_engine_roots.json'),{format:1,engines:engineRoots});
  await mkdir(join(root,'config'),{recursive:true});
  for(const [id,name] of [['anima-fast','anima_fast'],['musubi','musubi'],['ai-toolkit','ai_toolkit']]){
    signal?.throwIfAborted();
    const extension=join(root,'extensions',trainingEngineDirectories[id]),python=join(extension,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    await writeFile(join(root,'config',`${name}_backend.toml`),`[backend]\nsource_dir = ${JSON.stringify(join(extension,'source'))}\nvenv_python = ${JSON.stringify(python)}\n`,'utf8');
  }
  await writeFile(join(root, 'workbench_runner.py'), adapter);
  for (const file of processorFiles) await copyFile(join(integrationDir, file), join(root, file));
  await copyFile(join(integrationDir, 'catalog.json'), join(root, 'workbench_catalog.json'));
  return { root, manifest, adapterRevision };
}

export class TrainingHttpClient {
  constructor({ url, token, fetchImpl = fetch, timeoutMs = 15000 }) {
    const address = new URL(url);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new WorkbenchError(400, '训练内核只允许本机回环 HTTP 地址。');
    this.url = address.origin; this.token = token; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async response(method, path, { body, owner, requestId, timeoutMs = this.timeoutMs } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new WorkbenchError(400, '训练接口路径无效。');
    try {
      const response = await this.fetch(this.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(owner ? { 'x-workbench-owner': owner } : {}), ...(requestId ? { 'x-workbench-request': requestId } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        let message = `训练内核返回 HTTP ${response.status}`;
        try { const value = await response.json(); message = value.detail || value.message || message; } catch { /* Use HTTP status when the body is not JSON. */ }
        const error = new WorkbenchError(response.status === 409 ? 409 : 502, trainingDisplayMessage(message)); error.code = response.status >= 500 ? 'BACKEND_UNCERTAIN' : 'BACKEND_REJECTED'; throw error;
      }
      return response;
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      const wrapped = new WorkbenchError(503, `无法连接内置训练内核：${error.message}`); wrapped.code = 'BACKEND_UNAVAILABLE'; throw wrapped;
    }
  }
  async request(method, path, options) {
    const response = await this.response(method, path, options);
    let result;
    try { result = await response.json(); } catch { throw new WorkbenchError(502, '训练内核返回无效 JSON。'); }
    if (result?.status !== 'success') { const error = new WorkbenchError(422, trainingDisplayMessage(result?.message || '训练内核未确认操作成功。')); error.code = result?.status === 'fail' ? 'BACKEND_REJECTED' : 'BACKEND_UNCERTAIN'; error.detail = result?.data; throw error; }
    return result.data ?? {};
  }
  async image(path, options) {
    const response = await this.response('GET', path, options);
    const mime = (response.headers.get('content-type') || '').split(';')[0];
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].includes(mime)) throw new WorkbenchError(502, '训练预览不是支持的图片。');
    const parts = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 12 * 1024 * 1024) throw new WorkbenchError(413, '训练预览图超过 12 MiB。'); parts.push(part); }
    return { bytes: Buffer.concat(parts), mime };
  }
}

export class TrainingRuntime {
  constructor({ store, dataDir, directory = join(dataDir, 'training'), integrationDir = trainingIntegrationDir, componentProvider, fetchImpl = fetch, spawnImpl = spawn, materializeImpl = materializeKernel, startupTimeoutMs = 45000 }) {
    this.store = store; this.directory = directory; this.fallbackIntegrationDir = integrationDir; this.componentProvider = componentProvider; this.fetch = fetchImpl; this.spawn = spawnImpl; this.materialize = materializeImpl; this.startupTimeoutMs = startupTimeoutMs;
    this.componentOwner = `training:${process.pid}:${randomUUID()}`; this.componentLease = null; this.componentLeasePromise = null;
    this.startupLock = new TrainingStartupLock({directory,isProcessAlive:trainingProcessExists});this.startController=null;this.stopPromise=null;this.closePromise=null;
    this.recordPath = join(directory, 'runtime.json'); this.logPath = join(directory, 'sidecar.log'); this.client = null; this.record = null; this.startPromise = null; this.closed = false; this.pendingSubmissions = 0;
  }
  get integrationDir() {
    if (!this.componentProvider) return this.fallbackIntegrationDir;
    const component = this.componentProvider.resolve('training');
    if (!component?.path) throw missingTrainingComponent();
    return component.path;
  }
  async acquireComponent(owner) {
    return this.componentProvider ? this.componentProvider.acquire('training', `${this.componentOwner}:${owner}:${randomUUID()}`) : { path: this.integrationDir, release() {} };
  }
  async holdSidecarComponent(record) {
    if (!this.componentProvider) return null;
    if (this.componentLease?.released) this.componentLease = null;
    if (!this.componentLease && !this.componentLeasePromise) {
      this.componentLeasePromise = this.acquireComponent('sidecar').then(lease => {
        this.componentLease = { lease, path: lease.path, recordPath: this.recordPath, pid: null, released: false };
        return this.componentLease;
      }).finally(() => { this.componentLeasePromise = null; });
    }
    const holder = this.componentLease || await this.componentLeasePromise;
    if (record?.integrationDir && !samePath(record.integrationDir, holder.path)) {
      if (!holder.pid) await releaseComponentLease(holder);
      throw new WorkbenchError(409, '运行中的训练内核来自先前组件；请先结束任务并停止内核，再使用当前训练组件。');
    }
    if (record?.pid) { watchComponentProcess(holder, record.pid); holder.lease.retain?.(record.pid); }
    return holder;
  }
  async configuration(config = this.store?.module('training')?.config || {}) {
    const environmentRoot = config.trainerPath ? trainingPath(config.trainerPath, '已有训练环境目录') : join(this.directory,'environment');
    const servicePython=join(this.directory,'service-env','.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const candidates = config.pythonPath ? [trainingPath(config.pythonPath, 'Python 路径')] : [servicePython,join(dirname(environmentRoot), 'python_embeded', 'python.exe'), join(environmentRoot, 'python_embeded', 'python.exe'), join(environmentRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')];
    let pythonPath;
    for (const candidate of candidates) { try { if ((await stat(candidate)).isFile()) { pythonPath = candidate; break; } } catch { /* Try the next known environment path. */ } }
    if (!pythonPath) {
      const reason = config.pythonPath
        ? `配置的服务 Python 不存在或无法读取：${candidates[0]}。请重新选择 Python 文件。`
        : config.trainerPath
          ? `所选训练环境目录未找到配套的服务 Python：${environmentRoot}。请指定已有 Python，或准备工作台服务环境。`
          : '尚未选择服务 Python。请采用已检索到的训练环境，或在“训练环境与本地资源”中选择已有 Python／准备服务环境。';
      throw new WorkbenchError(400, reason);
    }
    const info = await stat(pythonPath);
    const engineTargets={...(!config.trainerPath?{kohya:'isolated'}:{}),...(this.store?.getSetting?.('training.engineTargets')||{})};
    return { environmentRoot, pythonPath, engineTargets, binding: digest(JSON.stringify([environmentRoot.toLowerCase(), pythonPath.toLowerCase(), info.size, info.mtimeMs,engineTargets,trainingEngineDirectories])) };
  }
  async identity(record) {
    if (!record) return null;
    let ready = record;
    if (!ready.url && ready.readyPath) { try { ready = { ...record, ...(await boundedJson(ready.readyPath)) }; } catch { return null; } }
    if (!ready.url) return null;
    const client = new TrainingHttpClient({ url: ready.url, token: record.token, fetchImpl: this.fetch });
    try {
      const identity = await client.request('GET', '/__workbench/identity', { timeoutMs: 2500 });
      if (identity.launchId !== record.launchId || identity.kernelRevision !== record.kernelRevision || identity.adapterRevision !== record.adapterRevision || identity.environmentRoot?.toLowerCase() !== record.environmentRoot?.toLowerCase() || identity.root?.toLowerCase() !== record.root?.toLowerCase() || !Number.isInteger(identity.pid)) return null;
      await this.holdSidecarComponent({ ...record, pid: identity.pid });
      this.client = client; this.record = { ...record, ...identity, url: ready.url }; return identity;
    } catch { return null; }
  }
  async state(config,{ownerProbe=false}={}) {
    await releaseStoppedComponentLeases(this.recordPath);
    let manifest, integrationDir, componentError;
    try { integrationDir = this.integrationDir; manifest = await boundedJson(join(integrationDir, 'source-manifest.json')); }
    catch (error) { if (this.componentProvider) componentError = error; }
    const base = { status: 'stopped', version: manifest?.version || null, kernelRevision: manifest?.kernelRevision || null, sourceRevision: manifest?.source?.commit || null, pythonPath: null, environmentRoot: null, servicePreparation:await this.servicePreparationState() };
    if (componentError) { base.status = 'unconfigured'; base.reason = componentError.status === 503 ? componentError.message : '训练组件尚未准备，无法读取训练源码清单。'; }
    let selected;
    try { selected = await this.configuration(config); Object.assign(base, { pythonPath: selected.pythonPath, environmentRoot: selected.environmentRoot }); }
    catch (error) { base.status = 'unconfigured'; if (!componentError) base.reason = error.message; }
    let record;
    try { record = await boundedJson(this.recordPath); } catch { record = this.record; }
    const identity = await this.identity(record);
    const startup = await this.startupLock.inspect({workerPid:record?.pid,ready:Boolean(identity)});
    if(startup.locked&&startup.processHeld&&!(ownerProbe&&this.startupLock.lease)){this.client=null;return {...base,status:'starting',reason:startup.reason};}
    if (!identity) {
      this.client = null;
      if (record && trainingProcessExists(record.pid)) return { ...base, status: 'unresponsive', pid: record.pid, reason: `记录的训练进程 ${record.pid} 仍存在，但身份接口暂时无法核实；请稍后刷新并确认既有训练状态，工作台不会另起队列。` };
      if (startup.locked) return {...base,status:'starting',reason:startup.reason};
      if (record && base.status !== 'unconfigured') { base.status = 'offline'; base.reason = '内置训练后台当前离线。'; }
      if(startup.recovered&&base.status!=='unconfigured')base.reason='上次启动已结束，残留启动锁已自动释放。';
      return base;
    }
    let adapterRevision;
    try { if (integrationDir) adapterRevision = await trainingAdapterRevision(integrationDir); } catch { /* A missing adapter invalidates readiness. */ }
    const changed = !selected || record.binding !== selected.binding || record.kernelRevision !== manifest?.kernelRevision || record.adapterRevision !== adapterRevision || record.integrationDir && !samePath(record.integrationDir, integrationDir);
    return { ...base, ...identity, status: changed ? 'configuration_changed' : 'running', url: this.record.url, ...(changed ? { reason: '运行中的内核使用先前环境；已有任务结束后停止内核，再按新配置启动。' } : {}) };
  }
  async start(config) {
    if (this.closed) throw new WorkbenchError(503, '训练运行管理已关闭。');
    if(this.stopPromise)throw new WorkbenchError(409,'训练后台正在停止，请等待结束后再启动。');
    if (!this.startPromise) {this.startController=new AbortController();this.startPromise=this.launch(config,this.startController.signal).finally(()=>{this.startPromise=null;this.startController=null;});}
    await this.startPromise;
    // The shared process may have been started by a different module instance.
    // Every waiter must verify its own environment binding after the launch.
    const state = await this.state(config);
    if (state.status !== 'running') throw new WorkbenchError(409, state.reason || '训练内核当前未就绪，请刷新状态。');
    return state;
  }
  async servicePreparationState() {
    try{const record=await boundedJson(join(this.directory,'service-preparation.json'));if(['starting','running'].includes(record.status)&&record.pid&&!trainingProcessExists(record.pid))return {...record,status:'interrupted',reason:'服务环境准备已中断，可手动重试。'};return record;}
    catch{return {status:'idle'};}
  }
  async prepareService({pythonPath,confirmed}={}) {
    if(confirmed!==true)throw new WorkbenchError(400,'请确认准备工作台服务环境；将下载轻量服务依赖。');
    if(this.closed)throw new WorkbenchError(503,'训练运行管理已关闭。');
    this.integrationDir;
    const basePython=trainingPath(pythonPath,'基础 Python');
    try{if(!(await stat(basePython)).isFile())throw new Error();}catch{throw new WorkbenchError(400,'基础 Python 不存在或不是文件。');}
    await this.stop();await mkdir(this.directory,{recursive:true});
    const lockPath=join(this.directory,'service-preparation.lock');let lock;
    try{lock=await open(lockPath,'wx');}catch(error){if(error.code!=='EEXIST')throw error;const previous=await this.servicePreparationState();if(['failed','completed','interrupted'].includes(previous.status)){await rm(lockPath);return this.prepareService({pythonPath,confirmed});}throw new WorkbenchError(409,'服务环境正在准备，请等待完成后刷新。');}
    let componentHolder;
    try{
      const lease = await this.acquireComponent('service-preparation');
      if (this.componentProvider) componentHolder = { lease, path: lease.path, recordPath: join(this.directory, 'service-preparation.json'), released: false };
      const launchId=randomUUID(),root=join(this.directory,'service-env'),statePath=join(this.directory,'service-preparation.json'),logPath=join(this.directory,'service-preparation.log');
      await lock.writeFile(JSON.stringify({launchId,pid:process.pid}),'utf8');
      const record={launchId,status:'starting',pid:process.pid,basePython,root,statePath,lockPath,logPath,startedAt:new Date().toISOString()};
      await writeJson(statePath,record);const requestPath=join(this.directory,`service-prepare-${launchId}.json`);await writeJson(requestPath,record);
      const descriptor=openSync(logPath,'a');let child;
      try{child=this.spawn(basePython,['-I','-B',join(lease.path,'prepare_service.py'),requestPath],{cwd:this.directory,windowsHide:true,detached:true,shell:false,stdio:['ignore',descriptor,descriptor]});}finally{closeSync(descriptor);}
      watchComponentProcess(componentHolder, child.pid); if (child.pid) componentHolder?.lease.retain?.(child.pid);
      child.once('close', () => { if (!trainingProcessExists(child.pid)) releaseComponentLease(componentHolder).catch(() => {}); });
      const spawnFailure = new Promise(resolveFailure => child.once('error', async error => {
        const failed = { ...record, status: 'failed', reason: error.message };
        await writeJson(statePath, failed).catch(() => {}); await rm(lockPath, { force: true }).catch(() => {}); resolveFailure(failed);
      }));
      if(child.pid){record.pid=child.pid;await writeJson(statePath,record);}else Object.assign(record,await spawnFailure);
      child.unref();
      return {...record,training_started:false};
    }catch(error){await rm(lockPath,{force:true});throw error;}finally{await lock.close();if(componentHolder&&!trainingProcessExists(componentHolder.pid))await releaseComponentLease(componentHolder);}
  }
  async selectEngineTarget(engine,target,config) {
    if(!['kohya','anima-fast','musubi','ai-toolkit','diffsynth','moss'].includes(engine)||!['original','isolated'].includes(target))throw new WorkbenchError(400,'训练环境选择无效。');
    if(typeof this.store?.setSetting!=='function')throw new WorkbenchError(503,'无法持久保存训练环境选择。');
    if(this.pendingSubmissions>0)throw new WorkbenchError(409,'仍有参数检查或训练提交，不能切换环境。');
    const current=await this.configuration(config);
    if((current.engineTargets[engine]||(engine==='kohya'?'original':'isolated'))===target)return;
    await this.stop();
    this.store.setSetting('training.engineTargets',{...current.engineTargets,[engine]:target});
  }
  async launch(config,signal) {
    signal?.throwIfAborted();
    this.integrationDir;
    const selected = await this.configuration(config);
    const state = await this.state(config);
    if (state.status === 'running') return state;
    if (['configuration_changed', 'unresponsive'].includes(state.status)) throw new WorkbenchError(409, state.reason);
    signal?.throwIfAborted();
    const lock = await this.startupLock.acquire();
    let child,launchRecord,componentHolder;
    try {
      signal?.throwIfAborted();
      // Another app may have finished launching between the first probe and
      // acquiring this filesystem lock. Re-read its authenticated record.
      const latest = await this.state(config,{ownerProbe:true});
      if (latest.status === 'running') return latest;
      if (['configuration_changed', 'unresponsive'].includes(latest.status)) throw new WorkbenchError(409, latest.reason);
      componentHolder = await this.holdSidecarComponent();
      const integrationDir = componentHolder?.path || this.integrationDir;
      signal?.throwIfAborted();
      const prepared = await this.materialize({ integrationDir, directory: this.directory, environmentRoot: selected.environmentRoot, engineTargets:selected.engineTargets,signal });
      signal?.throwIfAborted();
      const launchId = randomUUID(); const readyPath = join(this.directory, `ready-${launchId}.json`);
      const record = { ...selected, integrationDir, root: prepared.root, kernelRevision: prepared.manifest.kernelRevision, sourceRevision: prepared.manifest.source.commit, version: prepared.manifest.version, adapterRevision: prepared.adapterRevision, launchId, readyPath, token: randomBytes(32).toString('hex'), startedAt: new Date().toISOString() };
      launchRecord=record;
      const bootstrapPath = join(this.directory, `launch-${launchId}.json`);
      await writeJson(bootstrapPath, record); await writeJson(this.recordPath, record); this.record = record;
      signal?.throwIfAborted();
      const descriptor = openSync(this.logPath, 'a');
      try {
        const environment={...process.env};
        for(const key of ['PYTHONPATH','ANIMA_LORA_ROOT','ANIMA_LORA_PYTHON','MUSUBI_ROOT','MUSUBI_PYTHON','AI_TOOLKIT_ROOT','AI_TOOLKIT_PYTHON','NEXT_TRAINER_PROJECT_ROOT'])delete environment[key];
        child = this.spawn(selected.pythonPath, ['-s', '-B', join(prepared.root, 'workbench_runner.py'), '--bootstrap', bootstrapPath], { cwd: prepared.root, windowsHide: true, detached: true, shell: false, stdio: ['ignore', descriptor, descriptor], env: { ...environment, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', MIKAZUKI_OPEN_BROWSER: '0', MIKAZUKI_TRAIN_LOG_AUTO_OPEN: '0', TRAIN_MONITOR_ENABLED: '0', MIKAZUKI_TASK_QUEUE_FILE: join(this.directory, 'task_queue.json') } });
      } finally { closeSync(descriptor); }
      let spawnError; child.once('error', error => { spawnError = error; }); child.unref();
      record.pid = child.pid;
      watchComponentProcess(componentHolder, child.pid);
      child.once('close', () => releaseStoppedComponentLeases(this.recordPath).catch(() => {}));
      // Readiness probes may fail after publication; the detached process must
      // already own a durable component reference before the launcher can exit.
      if (child.pid && trainingProcessExists(child.pid)) componentHolder?.lease.retain?.(child.pid);
      await writeJson(this.recordPath, record);
      const deadline = Date.now() + this.startupTimeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (spawnError || child.exitCode !== null || child.signalCode) throw new WorkbenchError(503, `内置训练内核启动失败：${spawnError?.message || `进程退出 ${child.signalCode||child.exitCode}`}。日志：${this.logPath}`);
        if (await this.identity(record)) { await writeJson(this.recordPath, this.record); return this.state(config,{ownerProbe:true}); }
        await delay(150,undefined,{signal});
      }
      throw new WorkbenchError(503, `内置训练内核启动超时。日志：${this.logPath}`);
    } catch (error) {
      // Once a backend has advertised readiness, another authenticated client
      // may be using it. Preserve it if this launcher's probe could not verify
      // its state; ordinary stop() must apply the global active-task checks.
      const published=launchRecord&&await lstat(launchRecord.readyPath).then(()=>true,error=>error.code!=='ENOENT');
      if(child?.pid&&child.exitCode===null&&!child.signalCode&&!published){const exited=once(child,'exit',{signal:AbortSignal.timeout(1500)}).catch(()=>{});child.kill();await exited;}
      if (!child || !trainingProcessExists(child.pid)) await releaseComponentLease(componentHolder);
      this.client = null; throw signal?.aborted?signal.reason:error;
    }
    finally { await lock.release(); }
  }
  async request(method, path, options) {
    if(this.startPromise||this.startupLock.lease)throw new WorkbenchError(409,'训练后台正在启动，请等待就绪后再操作。');
    if (!this.client) { await this.state(); if (!this.client) throw new WorkbenchError(409, '请先启动内置训练内核。'); }
    return this.client.request(method, path, options);
  }
  async image(path, options) { if(this.startPromise||this.startupLock.lease)throw new WorkbenchError(409,'训练后台正在启动，请等待就绪后再操作。');if (!this.client) await this.state(); if (!this.client) throw new WorkbenchError(409, '内置训练内核当前离线。'); return this.client.image(path, options); }
  async stop() {
    if(!this.stopPromise)this.stopPromise=this.stopRuntime().finally(()=>{this.stopPromise=null;});
    return this.stopPromise;
  }
  async stopRuntime() {
    if (this.pendingSubmissions > 0) throw new WorkbenchError(409, '仍有训练参数检查或提交正在进行，不能停止内核。');
    if (this.startPromise) {this.startController?.abort(new WorkbenchError(409,'训练后台启动已取消。'));await this.startPromise.catch(()=>{});}
    const state = await this.state();
    if (state.status === 'unresponsive') throw new WorkbenchError(409, state.reason);
    if (state.status === 'starting') throw new WorkbenchError(409,'另一个启动任务仍在进行，请在发起启动的工作台取消。');
    if (!this.client) return { stopped: true };
    const tasks = await this.request('GET', '/api/tasks');
    if ((tasks.tasks || []).some(task => activeTrainingStatuses.has(task.status))) throw new WorkbenchError(409, '仍有训练或排队任务，不能停止内核。');
    const record = this.record;
    await this.request('POST', '/__workbench/shutdown', { body: {} });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && trainingProcessExists(record.pid)) await delay(100);
    if (trainingProcessExists(record.pid)) throw new WorkbenchError(503, '内核已收到停止请求，但尚未确认进程退出。');
    await releaseStoppedComponentLeases(this.recordPath);
    this.client = null; this.record = null;
    try { if ((await boundedJson(this.recordPath)).launchId === record.launchId) await rm(this.recordPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { stopped: true };
  }
  async close() {
    if(this.closePromise)return this.closePromise;
    this.closed=true;
    this.closePromise=(async()=>{try{await this.stop();}catch{/* Active or unreachable jobs stay with the detached, authenticated sidecar. */}})();
    return this.closePromise;
  }
  async readSavedConfigs(environmentRoot, pythonPath) {
    const lease = await this.acquireComponent('saved-configs'), script = join(lease.path, 'read_configs.py');
    const holder = this.componentProvider ? { lease, path: lease.path, recordPath: this.recordPath, released: false } : null;
    try { return await new Promise((resolveResult, reject) => {
      const child = this.spawn(pythonPath, ['-s', '-B', script, environmentRoot], { cwd: this.directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
      watchComponentProcess(holder, child.pid); if (child.pid) holder?.lease.retain?.(child.pid);
      const output = []; let errors = ''; let size = 0;
      const timeout = setTimeout(() => { child.kill(); reject(new WorkbenchError(504, '读取历史训练配置超时。')); }, 15000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { child.kill(); reject(new WorkbenchError(413, '历史训练配置过大。')); } else output.push(chunk); });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
      child.once('error', error => { clearTimeout(timeout); reject(new WorkbenchError(503, error.message)); });
      child.once('close', async code => {
        clearTimeout(timeout);
        try {
          await releaseComponentLease(holder);
          if (code !== 0) reject(new WorkbenchError(503, `读取历史训练配置失败：${errors}`));
          else { try { resolveResult(JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { reject(new WorkbenchError(502, '历史训练配置结果无效。')); } }
        } catch (error) { reject(error); }
      });
    }); } finally { if (holder && !trainingProcessExists(holder.pid)) await releaseComponentLease(holder); }
  }
}
