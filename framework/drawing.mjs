import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { WorkbenchError, fields, identifier, text } from './contracts.mjs';
import { applyWorkflowValues, convertWorkflow, inspectWorkflow, isComfyDirectory, unverifiedWidgetNodes, validatePrompt, workflowFields } from './drawing-workflows.mjs';
import { applyDrawingAdjustments, drawingControls } from './drawing-adjustments.mjs';
import { DrawingRuntime } from './drawing-runtime.mjs';
import { DrawingPreviews } from './drawing-preview.mjs';
import { inspectPreviewModels } from './drawing-preview-models.mjs';
import { comboChoices } from './drawing-schema.mjs';
import { archiveDrawingResult, drawingOutputs, drawingOutputSource, drawingResultId } from './drawing-results.mjs';
import { insideDirectory } from './drawing-files.mjs';
import {drawingPreferences,saveDrawingPreferences,drawingJobOutputDirectory} from './drawing-preferences.mjs';

const ACTIVE = new Set(['submitting', 'queued', 'running', 'unknown']);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function serviceAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new WorkbenchError(400, '请在接入配置填写 ComfyUI 服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new WorkbenchError(400, 'ComfyUI 地址应为 HTTP/HTTPS，且不包含账户、查询或锚点。');
  return url.href.replace(/\/$/, '');
}
async function localPath(value) {
  if (!isAbsolute(value) || /^[\\/]{2}/.test(value) || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value)) throw new WorkbenchError(400, '请使用普通本地磁盘的绝对路径。');
  const target = resolve(value); let current = parse(target).root;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new WorkbenchError(400, '绘图资料目录不能使用符号链接或目录联接。'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}
function imageKind(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', ext: '.png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', ext: '.jpg' };
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  throw new WorkbenchError(400, '只支持有效的 PNG、JPEG 或 WebP 图片。');
}
function upstreamMessage(value) {
  const parts = [typeof value?.error === 'string' ? value.error : value?.error?.message, value?.error?.details];
  for (const [id, node] of Object.entries(value?.node_errors || {})) for (const error of node.errors || []) parts.push(`节点 ${id}：${error.message || ''} ${error.details || ''}`);
  return parts.filter(Boolean).join('\n').slice(0, 4000) || 'ComfyUI 拒绝了请求，请检查工作流与模型。';
}

function isWorkflowExport(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  if (Array.isArray(document.nodes)) return document.nodes.length > 0 && document.nodes.length <= 2000 &&
    document.nodes.every(node => node && typeof node.type === 'string' && ['number', 'string'].includes(typeof node.id));
  const prompt = document.prompt || document;
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return false;
  const nodes = Object.values(prompt);
  return nodes.length > 0 && nodes.length <= 2000 && nodes.every(node => node && typeof node.class_type === 'string' &&
    node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs));
}

export class ComfyDrawing {
  constructor({ store, dataDir, fetchImpl = fetch, WebSocketImpl = WebSocket, runtimeOptions = {}, coordination, installationDirectory, downloadsDirectory = join(homedir(), 'Downloads') }) {
    this.store = store; this.db = store.db; this.directory = join(dataDir, 'drawing'); this.fetch = fetchImpl;
    this.coordination=coordination;
    this.installationDirectory=installationDirectory;
    this.downloadsDirectory=downloadsDirectory;
    this.connection = null; this.schema = {}; this.sockets = new Map(); this.requests = new Set(); this.catalog = new Map(); this.syncing = new Map(); this.closed = false;
    this.WebSocket = WebSocketImpl;
    this.runtime = new DrawingRuntime({ store, directory: this.directory, ...runtimeOptions }); this.conversions = new Set();
    this.processControl = runtimeOptions.processControl || {
      inspect: options => import('./comfy-process-control.mjs').then(module => module.inspectLocalComfyProcess(options)),
      stop: options => import('./comfy-process-control.mjs').then(module => module.stopLocalComfyProcess(options)),
    };
    this.clientId = store.getSetting('drawing.clientId') || randomUUID(); store.setSetting('drawing.clientId', this.clientId);
    this.db.exec(`CREATE TABLE IF NOT EXISTS drawing_workflows(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drawing_jobs(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drawing_hidden_jobs(job_id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drawing_images(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drawing_results(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    this.previews = new DrawingPreviews({ lookup: (url, promptId) => this.rows('drawing_jobs').find(job => job.serviceUrl === url && job.promptId === promptId && job.previewMethod !== 'none') });
    this.timer = setInterval(() => { if (this.currentConnection()) { this.watch(this.connection.url); void this.refreshActive().catch(() => {}); } }, 1600); this.timer.unref();
  }
  config() { return this.store.module('drawing').config; }
  preferences() { return drawingPreferences(this.store,this.installationDirectory); }
  savePreferences(value) { return saveDrawingPreferences(this.store,value,this.installationDirectory); }
  event(kind, message, characterId = null, level = 'info') { this.store.event({ moduleId: 'drawing', characterId, kind: `drawing.${kind}`, message, level }); }
  rows(table) { return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all().map(row => JSON.parse(row.data)); }
  row(table, id) { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.data) : null; }
  job(id) { const job = this.row('drawing_jobs', identifier(id)); if (!job) throw new WorkbenchError(404, '找不到此绘图任务。'); return job; }
  saveJob(job) { if (!ACTIVE.has(job.status)) this.previews.dropJob(job.id); this.db.prepare('UPDATE drawing_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id); }
  publicJob(job) {
    const { prompt, serviceUrl, outputPath, ...visible } = job;
    let remaining = 16384;
    if (job.results) visible.results = job.results.map(({ sourceKey, ...result }) => {
      if (result.text !== undefined) { const text = result.text.slice(0, remaining); remaining -= text.length; return { ...result, text, truncated: result.truncated || text.length < result.text.length }; }
      return result;
    });
    const frame = this.currentConnection() && serviceUrl === this.connection.url ? this.previews.get(job) : null;
    if (frame) visible.preview = { url: `/api/modules/drawing/jobs/${job.id}/preview?v=${frame.version}`, version: frame.version, updatedAt: frame.updatedAt };
    return visible;
  }
  preview(id) {
    const job = this.job(id);
    const frame = this.currentConnection() && job.serviceUrl === this.connection.url ? this.previews.get(job) : null;
    if (!frame) throw new WorkbenchError(404, '此任务暂时没有过程预览。');
    return frame;
  }
  taskPreviewSupported() {
    const version = /^(\d+)\.(\d+)\./.exec(this.connection?.version || '');
    return this.currentConnection() && !!version && (Number(version[1]) > 0 || Number(version[2]) >= 42);
  }
  async previewOptions() {
    const url = new URL(serviceAddress(this.config().serviceUrl));
    const models = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? await inspectPreviewModels(this.config().comfyPath) : { status: 'unverified', decoders: [], scope: 'remote', detail: '远程服务的预览解码器尚未核实。' };
    return { perPrompt: this.currentConnection() ? this.taskPreviewSupported() : null, models };
  }
  jobs() { return this.db.prepare('SELECT jobs.data FROM drawing_jobs AS jobs LEFT JOIN drawing_hidden_jobs AS hidden ON hidden.job_id=jobs.id WHERE hidden.job_id IS NULL ORDER BY jobs.rowid DESC LIMIT 100').all().map(row => this.publicJob(JSON.parse(row.data))); }
  setJobHidden(id, hidden) {
    const job=this.job(id);
    if(hidden&&!['completed','failed','cancelled'].includes(job.status))throw new WorkbenchError(409,'任务尚未结束，请先取消或核实状态后再移除记录。');
    if(hidden)this.db.prepare('INSERT INTO drawing_hidden_jobs(job_id,hidden_at) VALUES(?,?) ON CONFLICT(job_id) DO NOTHING').run(job.id,new Date().toISOString());
    else this.db.prepare('DELETE FROM drawing_hidden_jobs WHERE job_id=?').run(job.id);
    return {id:job.id,hidden};
  }
  workflows() { return this.rows('drawing_workflows').map(({ id, name, createdAt, nodeCount }) => ({ id, name, createdAt, nodeCount })); }
  connectionKey() { const config = this.config(); return JSON.stringify([config.serviceUrl?.replace(/\/$/, ''), config.comfyPath]); }
  currentConnection() { return Boolean(this.connection && this.connection.key === this.connectionKey()); }
  state() { return { connection: this.connection ? { ...this.connection, connected: this.currentConnection() } : { connected: false }, preferences:this.preferences(), defaultPreviewMethod: this.runtime.settings().previewMethod, workflows: this.workflows(), jobs: this.jobs() }; }
  async request(base, path, { method = 'GET', body, binary = false, form, timeout = 12000 } = {}) {
    if (this.closed) throw new WorkbenchError(503, '绘图服务已关闭。');
    const controller = new AbortController(); this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    let receivedResponse = false;
    try {
      const response = await this.fetch(base + path, { method, redirect: 'error', signal: controller.signal,
        ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      receivedResponse = true;
      const chunks = []; let length = 0;
      for await (const chunk of response.body || []) { length += chunk.length; if (length > 64 * 1024 * 1024) { controller.abort(); throw new WorkbenchError(413, 'ComfyUI 返回内容超过 64 MiB。'); } chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      if (binary && response.ok) return bytes;
      let value; try { value = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; } catch { if(response.ok)throw new WorkbenchError(502, '服务没有返回 ComfyUI JSON，请检查服务地址。');value={}; }
      if (!response.ok) { const error=new WorkbenchError(response.status === 400 ? 400 : 502, upstreamMessage(value));error.upstreamStatus=response.status;throw error; }
      return value;
    } catch (error) {
      if (error instanceof WorkbenchError) { error.upstreamReachable ||= receivedResponse; throw error; }
      const failure = new WorkbenchError(503, controller.signal.aborted ? 'ComfyUI 响应超时。已提交任务需核实状态，请勿重复提交。' : '无法连接 ComfyUI，请启动服务后重新连接。');
      failure.timedOut = controller.signal.aborted; failure.upstreamReachable = receivedResponse; throw failure;
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  async connect() {
    const revision = this.store.module('drawing').configRevision;
    const priorConnection = this.connection;
    const url = serviceAddress(this.config().serviceUrl);
    let stats,schema;
    try {
      const results = await Promise.allSettled([this.request(url,'/system_stats'),this.request(url,'/object_info')]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) {
        failed.reason.upstreamReachable = results.some(result => result.status === 'fulfilled' || result.reason?.upstreamReachable || result.reason?.upstreamStatus !== undefined);
        failed.reason.timedOut = results.some(result => result.reason?.timedOut);
        throw failed.reason;
      }
      [stats, schema] = results.map(result => result.value);
    }
    catch(error){if(this.connection===priorConnection&&this.connection?.url===url){this.connection=null;this.schema={};}throw error;}
    if (this.closed || revision !== this.store.module('drawing').configRevision) throw new WorkbenchError(409, 'ComfyUI 配置已变化，请重新连接。');
    if (!stats.system || !schema || !Object.keys(schema).length) throw new WorkbenchError(502, '目标服务未返回有效 ComfyUI 状态或节点定义。');
    this.schema = schema; this.connection = { connected: true, url, key: this.connectionKey(), configRevision: revision, checkedAt: new Date().toISOString(), version: stats.system.comfyui_version || '', devices: (stats.devices || []).map(device => ({ name: device.name, vramTotal: device.vram_total, vramFree: device.vram_free })) };
    this.watch(url); await this.refreshActive(); this.event('connected', '已连接 ComfyUI，读取实际节点定义。');
    return this.state();
  }
  connected() { const url = serviceAddress(this.config().serviceUrl); if (!this.currentConnection()) throw new WorkbenchError(409, '请先连接当前配置的 ComfyUI。'); return url; }
  watch(url) {
    if (!this.WebSocket) return;
    const old = this.sockets.get(url); if (old && old.readyState < 2) return old;
    for (const [source, previous] of this.sockets) if (source !== url) { this.sockets.delete(source); previous.close(); }
    const address = new URL(url + '/ws'); address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:'; address.searchParams.set('clientId', this.clientId);
    const socket = new this.WebSocket(address); this.sockets.set(url, socket); socket.binaryType = 'arraybuffer';
    const session = this.previews.open(url);
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => { this.previews.disconnect(session); if (this.sockets.get(url) === socket) this.sockets.delete(url); });
    socket.addEventListener('message', event => {
      if (this.closed || this.sockets.get(url) !== socket) return;
      if (!this.currentConnection() || this.connection.url !== url) { this.previews.disconnect(session); socket.close(); return; }
      if (typeof event.data !== 'string') { void this.previews.receive(session, event.data); return; }
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      this.previews.note(session, message);
      const data = message.data || {};
      const job = this.rows('drawing_jobs').find(job => ACTIVE.has(job.status) && job.serviceUrl === url && job.promptId === data.prompt_id);
      if (!job) return;
      if (message.type === 'progress') job.progress = { value: data.value, max: data.max };
      if (['execution_start', 'executing', 'progress'].includes(message.type)) job.status = 'running';
      if (data.node !== undefined) job.currentNode = data.node;
      this.saveJob(job);
      if (['execution_success', 'execution_error', 'execution_interrupted'].includes(message.type) || message.type === 'executing' && data.node === null) void this.syncJob(job.id).catch(() => {});
    });
    return socket;
  }
  async waitForPreviewSocket(url) {
    const socket = this.watch(url);
    if (!socket || socket.readyState !== 0) return socket?.readyState === 1;
    return new Promise(resolveReady => {
      const finish = () => { clearTimeout(timer); for (const event of ['open', 'close', 'error']) socket.removeEventListener(event, finish); resolveReady(socket.readyState === 1); };
      const timer = setTimeout(finish, 1500);
      for (const event of ['open', 'close', 'error']) socket.addEventListener(event, finish);
    });
  }
  launch() {return this.coordination?this.coordination.run('launch',()=>this.launchInternal()):this.launchInternal();}
  launchInternal() {
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.launchOnce().finally(() => { this.launchPromise = null; });
    return this.launchPromise;
  }
  async launchOnce() {
    const config = this.config(); const url = new URL(serviceAddress(config.serviceUrl));
    const revision = this.store.module('drawing').configRevision;
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/') throw new WorkbenchError(400, '启动仅支持本机 HTTP 服务。');
    try { return await this.connect(); } catch (error) { if (error.status !== 503 || error.upstreamReachable || error.timedOut) throw error; }
    if (this.closed || revision !== this.store.module('drawing').configRevision) throw new WorkbenchError(409, 'ComfyUI 配置已变化，请按当前配置重新启动。');
    const result = await this.runtime.launch(revision);
    if (this.closed) return result;
    this.event('launch', '已请求启动现有 ComfyUI，请稍后连接。');
    return result;
  }
  async prepareStop() {
    if (this.closed) throw new WorkbenchError(503, '绘图服务已关闭。');
    if (this.confirmingStop) throw new WorkbenchError(409, 'ComfyUI 正在停止，请等待退出。');
    const revision = this.store.module('drawing').configRevision, settingsRevision = this.runtime.settingsRevision;
    const current = () => {
      if (this.closed || revision !== this.store.module('drawing').configRevision || settingsRevision !== this.runtime.settingsRevision) throw new WorkbenchError(409, '核对期间配置已变化，请重新点击停止。');
    };
    let identity, scope, child;
    if (this.runtime.controlState().canStop) {
      child = this.runtime.child; scope = 'managed';
      identity = { pid: child.pid, startedAt: this.runtime.launchRecord?.startedAt, executable: this.runtime.launchRecord?.executable };
    } else {
      const url = new URL(serviceAddress(this.config().serviceUrl));
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/') throw new WorkbenchError(409, '远程 ComfyUI 请在其所在电脑停止；工作台只停止已核实的本机服务。');
      await this.connect(); current();
      const command = await this.runtime.baseCommand(); current();
      const port = Number(url.port || 80);
      identity = { ...await this.processControl.inspect({ port, executable: command.executable }), port }; current(); scope = 'external';
    }
    const token = randomUUID();
    this.stopPreview = { token, scope, identity, child, revision, settingsRevision, expiresAt: Date.now() + 120000 };
    return { target: { token, scope, pid: identity.pid, startedAt: identity.startedAt, executable: identity.executable, serviceUrl: this.config().serviceUrl } };
  }
  confirmStop(value) {
    fields(value, ['token']); const token = identifier(value.token, '停止确认编号');
    if (this.stopResult?.token === token) return Promise.resolve(this.stopResult.result);
    if (this.confirmingStop) {
      if (this.confirmingStop.token === token) return this.confirmingStop.promise;
      throw new WorkbenchError(409, 'ComfyUI 正在停止，请等待退出。');
    }
    const target = this.stopPreview;
    if (this.closed || !target || token !== target.token || Date.now() > target.expiresAt || target.revision !== this.store.module('drawing').configRevision || target.settingsRevision !== this.runtime.settingsRevision) throw new WorkbenchError(409, '停止目标已变化或确认已过期，请重新点击停止。');
    const promise = this.stopConfirmedTarget(target).finally(() => { this.confirmingStop = null; });
    this.confirmingStop = { token, promise }; return promise;
  }
  async stopConfirmedTarget(target) {
    let result;
    if (target.scope === 'managed') {
      if (this.runtime.child !== target.child || !this.runtime.controlState().canStop) throw new WorkbenchError(409, 'ComfyUI 进程已变化，请重新核对。');
      result = await this.runtime.stop();
    } else {
      result = await this.processControl.stop(Object.fromEntries(['port', 'executable', 'pid', 'startedAt', 'commandHash'].map(key => [key, target.identity[key]])));
      if (!this.closed) this.runtime.record({ status: 'exited', ...Object.fromEntries(['pid', 'startedAt', 'executable'].map(key => [key, target.identity[key]])), scope: 'external', exitedAt: new Date().toISOString(), stoppedByWorkbench: true, error: null });
    }
    this.connection = null; this.schema = {};
    for (const socket of this.sockets.values()) socket.close(); this.sockets.clear();
    this.stopPreview = null; this.stopResult = { token: target.token, result };
    if (!this.closed) this.event('stopped', `已停止核实的本机 ComfyUI（PID ${target.identity.pid}）。`);
    return result;
  }
  async discover(directory = '') {
    const requested=text(directory,'ComfyUI 目录',2048,{empty:true});const config=this.config();
    const candidates=requested?[requested]:[config.comfyPath,process.env.AI_FUTURE_COMFY_PATH,
      join(homedir(),'ComfyUI'),join(homedir(),'Documents/ComfyUI'),
      ...['C:','D:','E:'].flatMap(drive=>[drive+'\\ComfyUI',drive+'\\ComfyUI_windows_portable']),
      'E:\\ai draw\\ComfyUI-aki-v2\\ComfyUI'].filter(Boolean);
    let comfyPath;
    for(const candidate of new Set(candidates)){
      for(const entry of [candidate,join(candidate,'ComfyUI')]){
        try{const local=await localPath(entry);if(isComfyDirectory(local)){comfyPath=local;break;}}catch{}
      }
      if(comfyPath)break;
    }
    if(!comfyPath)throw new WorkbenchError(requested?400:404,'未找到 ComfyUI 本体，请填写其安装目录或便携包目录后重试。');
    return {comfyPath,serviceUrl:config.serviceUrl||'http://127.0.0.1:8188',outputPath:config.outputPath||join(comfyPath,'output'),workflowPath:config.workflowPath||join(comfyPath,'user/default/workflows')};
  }
  async scan() {
    const config = this.config();
    const directories = [config.workflowPath, config.comfyPath && join(config.comfyPath, 'user/default/workflows')].filter(Boolean);
    const roots = new Map(directories.map(directory => [resolve(directory), false]));
    if (this.downloadsDirectory && !roots.has(resolve(this.downloadsDirectory))) roots.set(resolve(this.downloadsDirectory), true);
    const result = [], scanned = [], catalog = new Map();
    for (const [directory, downloads] of roots) {
      const root = await localPath(directory); let names;
      try { names = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      scanned.push(root);
      for (const entry of names.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))) {
        const file = join(root, entry.name); let stat;
        try {
          stat = await lstat(file);
          if (!stat.isFile()) continue;
          if (downloads && (stat.size > 2 * 1024 * 1024 || !isWorkflowExport(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))))) continue;
        } catch (error) { if (error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) continue; throw error; }
        const key = createHash('sha256').update(file).digest('hex'); catalog.set(key, file);
        result.push({ key, name: entry.name, directory: root, modifiedAt: stat.mtimeMs });
      }
    }
    result.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
    this.catalog = catalog;
    return { files: result, directories: scanned };
  }
  async workflowFile(key) {
    const file = this.catalog.get(key); if (!file) throw new WorkbenchError(409, '请重新扫描并选择工作流。');
    await localPath(file); const entry = await lstat(file); if (entry.size > 2 * 1024 * 1024) throw new WorkbenchError(413, '工作流超过 2 MiB。');
    let document; try { document = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/,'')); } catch { throw new WorkbenchError(400, '工作流不是有效 JSON。'); }
    return { name: basename(file, '.json'), document };
  }
  async importFile(key) { return this.importWorkflow(await this.workflowFile(key)); }
  async inspectFile(key) { const value = await this.workflowFile(key); return this.inspectWorkflow({ document: value.document }); }
  async convert(document, { validate = true, schema = this.schema } = {}) {
    const controller = new AbortController(); this.conversions.add(controller);
    try { return await convertWorkflow(document, schema, this.config().comfyPath, { validate, signal: controller.signal, pythonPath: this.runtime.settings().pythonPath || undefined }); }
    finally { this.conversions.delete(controller); }
  }
  async inspectWorkflow(value) {
    fields(value, ['document']); const offline = () => inspectWorkflow(value.document);
    if (!this.currentConnection()) return offline();
    const url = this.connected(); const revision = this.store.module('drawing').configRevision;
    const connection = this.connection;
    const current = () => !this.closed && revision === this.store.module('drawing').configRevision && this.connection === connection && this.currentConnection();
    let schema;
    try { schema = await this.request(url, '/object_info'); }
    catch (error) { if (this.connection === connection) { this.connection = null; this.schema = {}; } const report = offline(); report.warnings.push({ detail: error.message }); return report; }
    if (!current()) return offline();
    if (!schema || !Object.keys(schema).length) return offline();
    this.schema = schema;
    const preliminary = inspectWorkflow(value.document, schema);
    if (preliminary.errors.length || !Array.isArray(value.document?.nodes)) return preliminary;
    try {
      const prompt = await this.convert(value.document, { validate: false, schema });
      if (!current()) return offline();
      const report = inspectWorkflow(prompt, schema); const unverified = new Set(unverifiedWidgetNodes(value.document, schema));
      report.nodeCount = preliminary.nodeCount;
      report.missingNodes = [...new Map([...preliminary.missingNodes, ...report.missingNodes].map(item => [item.nodeId + ':' + item.classType, item])).values()];
      report.missingModels = report.missingModels.filter(item => !unverified.has(item.nodeId));
      report.invalidValues = report.invalidValues.filter(item => !unverified.has(item.nodeId));
      report.warnings.push(...preliminary.warnings.filter(item => unverified.has(item.nodeId)));
      report.valid = report.available && ['missingNodes', 'missingModels', 'invalidValues', 'errors', 'warnings'].every(key => !report[key].length);
      return { ...report, converted: true };
    } catch (error) {
      if (!current()) return offline();
      preliminary.warnings.push({ detail: `控件参数未核实：${error.message}` }); return preliminary;
    }
  }
  async importWorkflow(value) {
    fields(value, ['name', 'document']); this.connected();
    const revision = this.store.module('drawing').configRevision;
    const url = this.connected();
    const connection = this.connection; let schema;
    const current = () => !this.closed && revision === this.store.module('drawing').configRevision && this.connection === connection && this.currentConnection();
    try { schema = await this.request(url, '/object_info'); if (!schema || !Object.keys(schema).length) throw new Error('empty schema'); }
    catch { if (this.connection === connection) { this.connection = null; this.schema = {}; } throw new WorkbenchError(409, '无法核实当前 ComfyUI 节点，请重新连接后导入。'); }
    if (!current()) throw new WorkbenchError(409, 'ComfyUI 配置或连接已变化，请重新连接后导入。');
    this.schema = schema;
    const name = text(value.name, '工作流名称', 150); const prompt = await this.convert(value.document, { schema });
    if (!current()) throw new WorkbenchError(409, 'ComfyUI 配置或连接已变化，请重新连接后导入。');
    const workflow = { id: randomUUID(), name, prompt, document: value.document, nodeCount: Object.keys(prompt).length, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO drawing_workflows VALUES(?,?)').run(workflow.id, JSON.stringify(workflow)); this.event('workflow.imported', `已导入工作流“${name}”。`);
    return this.workflow(workflow.id);
  }
  workflow(id) { const workflow = this.row('drawing_workflows', identifier(id)); if (!workflow) throw new WorkbenchError(404, '工作流不存在。'); const schema = this.currentConnection() ? this.schema : {}; return { ...workflow, fields: workflowFields(workflow.prompt, schema), controls: drawingControls(workflow.prompt, schema) }; }
  async inputPreview(value) {
    fields(value, ['image']); const base = this.connected(); const image = text(value.image, '图片名称', 2048);
    const spec = this.schema.LoadImage?.input?.required?.image;
    const parts = image.replaceAll('\\', '/').split('/');
    if (!comboChoices(spec)?.includes(image) || parts.some(part => !part || part === '.' || part === '..' || /[:\0]/.test(part))) throw new WorkbenchError(400, '请选择当前服务图片列表中的输入图片。');
    const filename = parts.pop();
    const query = new URLSearchParams({ filename, subfolder: parts.join('/'), type: 'input', preview: 'webp;70' });
    const bytes = await this.request(base, '/view?' + query, { binary: true });
    if (this.connected() !== base) throw new WorkbenchError(409, '绘图服务已变化，请重新选择图片。');
    const kind = imageKind(bytes);
    return { src: `data:${kind.mime};base64,${bytes.toString('base64')}` };
  }
  async upload(value) {
    fields(value, ['name', 'data']); const base = this.connected();
    const name = text(value.name, '文件名称', 200);
    if (typeof value.data !== 'string' || value.data.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new WorkbenchError(400, '图片文件无效或超过 18 MiB。');
    const bytes = Buffer.from(value.data, 'base64'); const kind = imageKind(bytes);
    const form = new FormData(); form.append('image', new Blob([bytes], { type: kind.mime }), `workbench-${randomUUID()}${kind.ext}`); form.append('type', 'input'); form.append('overwrite', 'false');
    const result = await this.request(base, '/upload/image', { method: 'POST', form });
    if(typeof result.name!=='string'||!result.name)throw new WorkbenchError(502,'ComfyUI 没有返回上传图片名称。');
    const schema=await this.request(base,'/object_info');
    if(this.connected()!==base)throw new WorkbenchError(409,'ComfyUI 配置已变化，请在当前服务重新上传。');
    if(!schema||!Object.keys(schema).length)throw new WorkbenchError(502,'上传后无法刷新图片列表，请重新连接。');
    this.schema=schema;
    return { name, image: (result.subfolder ? result.subfolder + '/' : '') + result.name };
  }
  submit(value){return this.coordination?this.coordination.run('drawing',()=>this.submitInternal(value)):this.submitInternal(value);}
  async submitInternal(value) {
    fields(value, ['requestId', 'workflowId', 'values', 'characterId', 'previewMethod', 'adjustments']);
    if (value.previewMethod !== undefined && !['auto', 'latent2rgb', 'taesd', 'none'].includes(value.previewMethod)) throw new WorkbenchError(400, '请选择有效的过程预览方式。');
    if (!uuid(value.requestId)) throw new WorkbenchError(400, '生成请求标识无效。');
    const requestFingerprint = createHash('sha256').update(canonical({ workflowId: value.workflowId, characterId: value.characterId || null, values: value.values || {}, previewMethod: value.previewMethod ?? null, ...(value.adjustments === undefined ? {} : { adjustments: value.adjustments }) })).digest('hex');
    const priorRequest = () => {
      const existing = this.db.prepare('SELECT data FROM drawing_jobs WHERE request_id=?').get(value.requestId);
      if (!existing) return null;
      const prior=JSON.parse(existing.data);
      if(prior.workflowId!==value.workflowId||prior.characterId!==(value.characterId||null))throw new WorkbenchError(409,'此请求标识已用于其他绘图，请先核实原任务。');
      const matches = prior.requestFingerprint ? prior.requestFingerprint === requestFingerprint :
        canonical(applyDrawingAdjustments(applyWorkflowValues(this.workflow(value.workflowId).prompt, value.values || {}, this.schema), value.adjustments, this.schema)) === canonical(prior.prompt) && (value.previewMethod === undefined || value.previewMethod === prior.previewMethod);
      if (!matches) throw new WorkbenchError(409, '此请求标识的绘图参数已变化，请核对原任务，或明确新建一张图片。');
      return this.publicJob(prior);
    };
    const prior = priorRequest(); if (prior) return prior;
    const url = this.connected(); const workflow = this.workflow(value.workflowId);
    const connection = this.connection, revision = this.store.module('drawing').configRevision;
    let previewMethod = value.previewMethod ?? this.runtime.settings().previewMethod, previewNotice;
    if (previewMethod === 'taesd') {
      const { models } = await this.previewOptions();
      if (models.status === 'missing') previewNotice = '本地目录未找到预览解码器；若服务也未配置匹配的外部解码器，将由 ComfyUI 回退快速预览。';
      else previewNotice = '清晰预览还需匹配当前模型；不匹配时由 ComfyUI 尝试快速预览。';
    }
    if (!this.taskPreviewSupported()) previewNotice = '当前服务未核实按任务设置预览的能力；请在启动器设置预览方式后重启 ComfyUI。';
    if (previewMethod !== 'none' && this.WebSocket && !await this.waitForPreviewSocket(url)) previewNotice = [previewNotice, '预览连接尚未就绪；生成继续，连接恢复后显示后续预览。'].filter(Boolean).join(' ');
    if (this.connected() !== url || this.connection !== connection || revision !== this.store.module('drawing').configRevision) throw new WorkbenchError(409, 'ComfyUI 配置已变化，请重新提交。');
    const repeated = priorRequest(); if (repeated) return repeated;
    if (value.characterId !== null && value.characterId !== undefined) this.store.requireCharacter(value.characterId);
    const prompt = validatePrompt(applyDrawingAdjustments(applyWorkflowValues(workflow.prompt, value.values || {}, this.schema), value.adjustments, this.schema), this.schema);
    const finalFields = workflowFields(prompt, this.schema);
    const finalValues = new Map(finalFields.map(field => [field.key, field.value]));
    const seeds = finalFields.filter(field => (field.presentation?.seed ?? (field.type === 'number' && /^(?:seed|noise_seed|random_seed)$/.test(field.input)))
      && (field.presentation?.enabledWhen || []).every(condition => finalValues.get(condition.key) === condition.equals))
      .map(field => ({ key: field.key, label: field.presentation?.label || '种子', value: field.value }));
    const character = value.characterId ? this.store.requireCharacter(value.characterId) : null;
    const job = { id: randomUUID(), requestId: value.requestId, requestFingerprint, promptId: value.requestId, clientId: this.clientId, workflowId: workflow.id, workflowName: workflow.name,
      serviceUrl: url, outputPath: this.preferences().outputPath, outputLayout:'task', characterId: character?.id || null, characterName: character?.name || '', prompt, seeds, previewMethod, ...(previewNotice ? { previewNotice } : {}), status: 'submitting', progress: null, images: [], results: [], createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO drawing_jobs VALUES(?,?,?)').run(job.id, job.requestId, JSON.stringify(job));
    try {
      const response = await this.request(url, '/prompt', { method: 'POST', body: { prompt, client_id: this.clientId, prompt_id: job.promptId, extra_data: { ...(this.taskPreviewSupported() ? { preview_method: previewMethod } : {}), extra_pnginfo: { workflow: { ...workflow.document, extra: { ...workflow.document.extra, workbench: { jobId: job.id, characterId: job.characterId } } } } } } });
      if (!uuid(response.prompt_id)) throw new WorkbenchError(502, 'ComfyUI 未返回有效任务标识，需核实队列。');
      job.promptId = response.prompt_id; job.status = 'queued';
    } catch (error) { job.status = error.status === 400 ? 'failed' : 'unknown'; job.error = error.message; }
    const latest=this.job(job.id);
    if(['submitting','unknown'].includes(latest.status)){this.saveJob(job);}else{job.status=latest.status;job.progress=latest.progress;job.images=latest.images;job.results=latest.results;this.saveJob(job);}
    this.event('submitted', job.status === 'failed' ? 'ComfyUI 拒绝绘图任务。' : '绘图任务已提交，等待执行状态。', job.characterId, job.status === 'failed' ? 'error' : 'info');
    return this.publicJob(this.job(job.id));
  }
  async refreshActive() { return Promise.allSettled(this.rows('drawing_jobs').filter(job => ACTIVE.has(job.status) && job.serviceUrl === this.connection?.url).map(job => this.syncJob(job.id))); }
  async syncJob(id) {
    if (this.syncing.has(id)) return this.syncing.get(id);
    const promise = this.syncOne(id).finally(() => this.syncing.delete(id)); this.syncing.set(id, promise); return promise;
  }
  async syncOne(id) {
    let job = this.job(id); if (!ACTIVE.has(job.status)) return this.publicJob(job);
    const history = await this.request(job.serviceUrl, '/history/' + job.promptId);
    if (this.closed) return;
    let completed = history[job.promptId];let queue;
    if(!completed){
      queue=await this.request(job.serviceUrl,'/queue');job=this.job(id);
      if(job.cancelRequestedAt && !(queue.queue_running||[]).some(item=>item[1]===job.promptId) && !(queue.queue_pending||[]).some(item=>item[1]===job.promptId)) {
        // A task may finish between the first history snapshot and queue read.
        completed=(await this.request(job.serviceUrl,'/history/'+job.promptId))[job.promptId];
      }
    }
    job=this.job(id);if(!ACTIVE.has(job.status))return this.publicJob(job);
    if (completed) {
      const failed = completed.status?.status_str === 'error';
      if (failed) { const messages = completed.status.messages || []; const detail = messages.find(([type]) => type === 'execution_error' || type === 'execution_interrupted'); job.status = detail?.[0] === 'execution_interrupted' ? 'cancelled' : 'failed'; job.error = detail?.[1]?.exception_message || 'ComfyUI 执行失败，请检查节点和模型。'; }
      else if (completed.status?.completed === false) return this.publicJob(job);
      else {
        try {
          const outputs = drawingOutputs(completed.outputs);
          if (!outputs.length) { job.status='failed';job.error='任务已执行，但没有返回图片、视频、音频或文本，请检查工作流的输出节点。';job.finishedAt=new Date().toISOString();this.saveJob(job);this.event('failed',job.error,job.characterId,'error');return this.publicJob(job); }
          job.results ||= [];
          let imageIndex = 0;
          for (const output of outputs) {
            if (output.kind === 'image') {
              const legacy = job.images[imageIndex++];
              if (job.images.some(image => image.sourceKey === output.key) || legacy && !legacy.sourceKey) continue;
              job.images.push(await this.archive(job, output.source, output.key));
            } else {
              if (job.results.some(result => result.sourceKey === output.key)) continue;
              job.results.push(await archiveDrawingResult({ job, output, directory: this.directory, fetchImpl: this.fetch, requests: this.requests, closed: () => this.closed, db: this.db }));
            }
            this.saveJob(job);
          }
          job.status = 'completed'; delete job.error;
          if ([...job.images, ...job.results].some(result => result.archiveError)) job.warning = '结果已保存到工作台，但额外作品目录复制失败，请使用保存或下载导出。';
        }
        catch (error) { job.error = `生成已结束，归档待重试：${error.message}`; this.saveJob(job); return this.publicJob(job); }
      }
      job.finishedAt = new Date().toISOString(); this.saveJob(job); this.event(job.status, job.status === 'completed' ? '绘图已完成，作品已保存。' : job.error || '绘图任务已取消。', job.characterId, job.status === 'failed' ? 'error' : 'info');
    } else {
      const running = (queue.queue_running || []).some(item => item[1] === job.promptId); const waiting = (queue.queue_pending || []).some(item => item[1] === job.promptId);
      job = this.job(id); if (!ACTIVE.has(job.status)) return this.publicJob(job);
      if (running || waiting) { job.status = running ? 'running' : 'queued'; delete job.error; }
      else if(job.cancelRequestedAt){job.status='cancelled';job.finishedAt=new Date().toISOString();delete job.error;}
      else if (job.status === 'submitting') return this.publicJob(job);
      else { job.status = 'unknown'; job.error = '队列与历史暂未找到此任务，请刷新核实；不会自动重复提交。'; }
      this.saveJob(job);
    }
    return this.publicJob(job);
  }
  async archive(job, source, sourceKey) {
    source = drawingOutputSource(source);
    const id = sourceKey ? drawingResultId(job, sourceKey) : randomUUID();
    const prior = this.row('drawing_images', id); if (prior) return prior;
    const query = new URLSearchParams({ filename: source.filename, subfolder: source.subfolder || '', type: source.type || 'output' });
    const bytes = await this.request(job.serviceUrl, '/view?' + query, { binary: true }); const kind = imageKind(bytes);
    const directory = await localPath(join(this.directory, 'images')); await mkdir(directory, { recursive: true });
    const filename = id + kind.ext, target = await insideDirectory(directory, filename), temporary = target + '.part';
    try {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    let archived = '';
    let archiveError = '';
    if (job.outputPath) {
      try {
        const output = await localPath(drawingJobOutputDirectory(job)); await mkdir(output, { recursive: true });
        archived = await insideDirectory(output, filename); await copyFile(target, archived);
      } catch(error) { archived='';archiveError=`作品目录复制失败：${error.code||error.message}`; }
    }
    const image = { id, jobId: job.id, filename, sourceName: source.filename, ...(sourceKey ? { sourceKey, source } : {}), mime: kind.mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: `/api/modules/drawing/images/${id}`, archived, ...(archiveError?{archiveError}:{}) };
    this.db.prepare('INSERT INTO drawing_images VALUES(?,?)').run(id, JSON.stringify(image));
    if (job.characterId) this.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?)').run(id, 'image', source.filename, 'drawing', job.characterId, `drawing/images/${filename}`);
    return image;
  }
  async image(id) { const image = this.row('drawing_images', identifier(id)); if (!image) throw new WorkbenchError(404, '图片不存在。'); return { ...image, bytes: await readFile(await localPath(join(this.directory, 'images', image.filename))) }; }
  async result(id) { const result = this.row('drawing_results', identifier(id)); if (!result) throw new WorkbenchError(404, '结果文件不存在。'); return { ...result, path: await insideDirectory(join(this.directory, 'results'), result.filename) }; }
  async cancel(id) {
    let job = this.job(id); if (!ACTIVE.has(job.status)) return this.publicJob(job);
    let result;
    try{result=await this.request(job.serviceUrl,`/api/jobs/${job.promptId}/cancel`,{method:'POST',body:{}});}
    catch(error){if([404,405].includes(error.upstreamStatus))throw new WorkbenchError(409,'当前 ComfyUI 不支持按任务取消，请在原生 ComfyUI 中操作；工作台会继续跟踪结果。');throw error;}
    job=this.job(id);
    if(result.cancelled===true&&ACTIVE.has(job.status)){job.cancelRequestedAt=new Date().toISOString();this.saveJob(job);this.event('cancel.requested','已请求取消选中的任务，等待实际状态。',job.characterId);}
    return this.syncJob(id);
  }
  async close() { this.closed = true; clearInterval(this.timer); this.previews.close(); for (const controller of this.requests) controller.abort(); for (const controller of this.conversions) controller.abort(); for (const socket of this.sockets.values()) socket.close(); await Promise.allSettled([this.confirmingStop?.promise]); await this.runtime.close(); await Promise.allSettled(this.syncing.values()); }
}
