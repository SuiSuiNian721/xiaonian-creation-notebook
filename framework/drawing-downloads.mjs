import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, rm, statfs } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fields, identifier, text, WorkbenchError } from './contracts.mjs';
import { isComfyDirectory } from './drawing-workflows.mjs';
import { checkedLocalPath, insideDirectory, fileName, fileHash } from './drawing-files.mjs';

const SETTING = 'drawing.downloads';
const ACTIVE = new Set(['queued', 'downloading', 'verifying']);
const EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.sft', '.onnx']);
const now = () => new Date().toISOString();
const requestHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const absent = async path => { try { return !(await lstat(path)); } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };

function downloadInput(value) {
  fields(value, ['requestId', 'url', 'category', 'filename', 'sha256']);
  identifier(value.requestId, '下载请求标识');
  let url;
  try { url = new URL(text(value.url, '下载地址', 8192)); } catch { throw new WorkbenchError(400, '请填写有效的 HTTP/HTTPS 模型直链。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new WorkbenchError(400, '下载地址仅支持不含账号、密码或锚点的 HTTP/HTTPS 直链。');
  if (typeof value.category !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.category)) throw new WorkbenchError(400, '模型类别无效。');
  const filename = fileName(value.filename);
  if (!EXTENSIONS.has(extname(filename).toLowerCase())) throw new WorkbenchError(400, '只支持 safetensors、ckpt、pt、pth、bin、gguf、sft、onnx 模型文件。');
  const sha256 = text(value.sha256 ?? '', 'SHA256', 64, {empty:true}).toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new WorkbenchError(400, 'SHA256 应为 64 位十六进制。');
  return {requestId:value.requestId, url:url.href, category:value.category, filename, sha256};
}

export class DrawingDownloads {
  constructor({store, directory, config, fetchImpl = fetch, statfsImpl = statfs, idleTimeout = 30000, onCompleted}) {
    this.store = store; this.directory = join(directory, 'downloads'); this.config = config; this.fetch = fetchImpl; this.statfs = statfsImpl; this.idleTimeout = idleTimeout;
    this.onCompleted = onCompleted;
    this.records = new Map((store.getSetting(SETTING) || []).map(task => [task.id, task])); this.active = new Map(); this.creating = new Map(); this.closed = false;
    let changed = false;
    for (const task of this.records.values()) if (ACTIVE.has(task.status)) { task.status = 'interrupted'; task.error = '上次下载已中断，可继续下载。'; task.updatedAt = now(); changed = true; }
    if (changed) this.persist();
    this.cleaning = Promise.allSettled([...this.records.values()].filter(task => task.status === 'completed').map(task => this.cleanupCompleted(task)));
  }
  persist() { this.store.setSetting(SETTING, [...this.records.values()]); }
  public(task) { const {url, fingerprint, etag, lastModified, downloadComplete, ...value} = task; return structuredClone(value); }
  list() { return [...this.records.values()].reverse().map(task => this.public(task)); }
  record(id) { const task = this.records.get(identifier(id)); if (!task) throw new WorkbenchError(404, '找不到下载任务。'); return task; }
  get(id) { return this.public(this.record(id)); }
  update(task, values, persist = true) { Object.assign(task, values, {updatedAt:now()}); if (persist) this.persist(); if (values.status === 'completed') this.onCompleted?.(this.public(task)); }
  open() { if (this.closed) throw new WorkbenchError(409, '下载服务已关闭。'); }
  async start(value, {queue = false} = {}) {
    this.open(); const input = downloadInput(value); const fingerprint = requestHash(input);
    const existing = [...this.records.values()].find(task => task.requestId === input.requestId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new WorkbenchError(409, '下载请求标识已用于其他内容。'); return this.public(existing); }
    if (this.creating.has(input.requestId)) {
      const pending = this.creating.get(input.requestId);
      if (pending.fingerprint !== fingerprint) throw new WorkbenchError(409, '下载请求标识已用于其他内容。');
      return pending.promise;
    }
    const promise = this.create(input, fingerprint, queue).finally(() => this.creating.delete(input.requestId));
    this.creating.set(input.requestId, {fingerprint, promise}); return promise;
  }
  async create(input, fingerprint, queue = false) {
    if (this.records.size >= 200) throw new WorkbenchError(409, '下载记录已达 200 项，请先导出记录并联系维护者整理。');
    const comfyPath = await checkedLocalPath(this.config().comfyPath);
    if (!isComfyDirectory(comfyPath)) throw new WorkbenchError(400, '请先配置有效的 ComfyUI 本体目录。');
    const target = await insideDirectory(comfyPath, 'models', input.category, input.filename);
    if (!await absent(target)) throw new WorkbenchError(409, '模型目录中已有同名文件，请使用其他文件名。');
    this.open();
    if ([...this.records.values()].some(task => task.target.toLowerCase() === target.toLowerCase() && task.status !== 'completed')) throw new WorkbenchError(409, '此目标已有下载记录，请继续原任务或使用其他文件名。');
    if (this.active.size >= 2 && !queue) throw new WorkbenchError(409, '已有两个下载任务，请等待完成或暂停后再添加。');
    const source = new URL(input.url);
    const task = {id:randomUUID(), requestId:input.requestId, fingerprint, url:input.url, source:source.origin + source.pathname,
      comfyPath, category:input.category, filename:input.filename, target, expectedSha256:input.sha256, actualSha256:null, verification:null,
      status:'queued', downloadedBytes:0, totalBytes:null, downloadComplete:false, createdAt:now(), updatedAt:now(), error:null, requiresRestart:false};
    this.records.set(task.id, task);
    try { this.persist(); } catch { this.records.delete(task.id); throw new WorkbenchError(500, '无法保存下载记录，请检查工作台资料目录后重试。'); }
    if (this.active.size < 2) this.begin(task); return this.public(task);
  }
  begin(task) {
    const job = {controller:new AbortController(), intent:null, promise:null}; this.active.set(task.id, job);
    job.promise = Promise.resolve().then(() => this.transfer(task, job)).catch(() => {
      // 存储故障不能通过再次写入同一故障存储来报告，也不能升级为未处理拒绝。
      Object.assign(task, {status:'failed', error:'无法保存下载记录，任务已停止。请检查工作台资料目录后重试。', updatedAt:now()});
      job.controller.abort();
    }).finally(() => { this.active.delete(task.id); this.pump(); });
  }
  pump() { if (this.closed) return; for (const task of this.records.values()) { if (this.active.size >= 2) break; if (task.status === 'queued' && !this.active.has(task.id)) this.begin(task); } }
  async pause(id) {
    const task = this.record(id); const job = this.active.get(id);
    if (!job) { if (task.status === 'queued') this.update(task, {status:'paused', error:null}); return this.public(task); }
    job.intent = 'paused'; job.controller.abort(); await job.promise; return this.public(task);
  }
  async resume(id, value = {}) {
    fields(value, ['restart']); if (value.restart !== undefined && typeof value.restart !== 'boolean') throw new WorkbenchError(400, '重新下载选项必须为布尔值。');
    this.open(); const task = this.record(id);
    if (this.active.has(id) || task.status === 'completed') return this.public(task);
    if (this.active.size >= 2) throw new WorkbenchError(409, '已有两个下载任务，请等待完成或暂停。');
    if (value.restart) task.requiresRestart = true;
    // 在任何异步路径检查之前占用任务，重复点击或网络重试不能建立第二个写入者。
    this.update(task, {status:'queued', error:null}); this.begin(task); return this.public(task);
  }
  async space(path, needed) {
    const info = await this.statfs(path); const available = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(available) || available < needed + 8 * 1024 * 1024) throw new WorkbenchError(409, '磁盘可用空间不足，下载已保留，可释放空间后继续。');
  }
  async paths(task) {
    await checkedLocalPath(task.comfyPath);
    if (!isComfyDirectory(task.comfyPath)) throw new WorkbenchError(400, '此下载原先使用的 ComfyUI 本体已不可用，请核对记录中的目录。');
    const directory = await checkedLocalPath(this.directory); await mkdir(directory, {recursive:true});
    const partial = await insideDirectory(directory, task.id + '.part');
    const target = await insideDirectory(task.comfyPath, 'models', task.category, task.filename);
    if (target !== task.target) throw new WorkbenchError(409, '下载目标与记录不一致。');
    return {directory, partial, target};
  }
  async transfer(task, job) {
    const {signal} = job.controller; let timeout; let handle;
    const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => job.controller.abort(new Error('下载响应超时')), this.idleTimeout); };
    try {
      const {directory, partial, target} = await this.paths(task); signal.throwIfAborted();
      await this.cleanupStage(task); signal.throwIfAborted();
      if (!await absent(target)) {
        if (task.actualSha256 && await fileHash(target, signal) === task.actualSha256) { this.update(task, {status:'completed', error:null}); await rm(partial, {force:true}); return; }
        throw new WorkbenchError(409, '模型目录中已存在同名文件，原文件保持不变。');
      }
      let offset = (await lstat(partial).catch(error => { if (error.code === 'ENOENT') return {size:0}; throw error; })).size;
      if (task.downloadComplete && !task.requiresRestart && offset > 0 && task.totalBytes === offset) {
        this.update(task, {downloadedBytes:offset}); await this.verifyAndPublish(task, partial, target, signal); return;
      }
      const validator = task.etag && !task.etag.startsWith('W/') ? task.etag : task.lastModified;
      if (task.requiresRestart || offset && !validator || offset > 0 && task.totalBytes !== null && offset >= task.totalBytes) {
        const reset = await open(partial, 'w'); await reset.close(); offset = 0;
      }
      this.update(task, {status:'downloading', downloadedBytes:offset, downloadComplete:false, error:null, requiresRestart:false});
      await this.space(directory, 0); signal.throwIfAborted(); touch();
      const response = await this.fetch(task.url, {signal, headers:{'accept-encoding':'identity', ...(offset ? {Range:`bytes=${offset}-`, 'If-Range':validator} : {})}});
      if (![200,206].includes(response.status)) throw new WorkbenchError(502, `下载服务器返回 HTTP ${response.status}，请核对直链。`);
      if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw new WorkbenchError(502, '下载地址返回网页或 JSON，请使用模型文件直链。');
      if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new WorkbenchError(502, '下载服务器返回压缩传输，无法可靠续传，请更换直链。');
      const lengthHeader = response.headers.get('content-length'); const length = lengthHeader === null ? null : Number(lengthHeader);
      let total = length;
      if (length !== null && (!Number.isSafeInteger(length) || length < 0)) throw new WorkbenchError(502, '下载服务器返回无效文件长度。');
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= Number(range[3])
          || !Number.isSafeInteger(Number(range[3])) || length !== null && length !== Number(range[2]) - offset + 1) {
          task.requiresRestart = true; throw new WorkbenchError(502, '下载续传范围不匹配，请重新下载。');
        }
        if (offset && (task.etag && response.headers.get('etag') && task.etag !== response.headers.get('etag')
          || !task.etag && task.lastModified && response.headers.get('last-modified') && task.lastModified !== response.headers.get('last-modified'))) {
          task.requiresRestart = true; throw new WorkbenchError(502, '续传内容已变化，请重新下载。');
        }
        total = Number(range[3]);
      } else offset = 0;
      await this.space(directory, total === null ? 0 : Math.max(0,total-offset)); signal.throwIfAborted();
      handle = await open(partial, offset ? 'a' : 'w');
      this.update(task, {downloadedBytes:offset, totalBytes:total, etag:response.headers.get('etag'), lastModified:response.headers.get('last-modified')});
      let persisted = 0; let checked = offset;
      for await (const chunk of response.body || []) {
        signal.throwIfAborted(); touch();
        if (total !== null && task.downloadedBytes + chunk.length > total) { task.requiresRestart = true; throw new WorkbenchError(502, '下载内容超过声明长度，已停止。'); }
        if (task.downloadedBytes - checked >= 16 * 1024 * 1024) { await this.space(directory, chunk.length); checked = task.downloadedBytes; }
        await handle.writeFile(chunk); task.downloadedBytes += chunk.length;
        const time = Date.now(); this.update(task, {}, time - persisted > 250); if (time - persisted > 250) persisted = time;
      }
      clearTimeout(timeout); await handle.close(); handle = null; signal.throwIfAborted();
      if (total !== null && task.downloadedBytes !== total || task.downloadedBytes === 0) throw new WorkbenchError(502, '模型文件未下载完整，可继续下载。');
      this.update(task, {downloadComplete:true, totalBytes:task.downloadedBytes});
      await this.verifyAndPublish(task, partial, target, signal);
    } catch (error) {
      this.update(task, {status:job.intent || 'failed', error:job.intent === 'paused' ? null : job.intent === 'interrupted' ? '工作台已关闭，下载保留，可继续。'
        : error instanceof WorkbenchError ? error.message : signal.aborted ? '下载响应超时，可继续下载。' : error.code === 'ENOSPC' ? '磁盘空间不足，可释放空间后继续。' : '下载未完成，请检查网络、目标路径和磁盘权限后继续。'});
    } finally { clearTimeout(timeout); job.controller.abort(); if (handle) await handle.close().catch(() => {}); }
  }
  async verifyAndPublish(task, partial, target, signal) {
    this.update(task, {status:'verifying', totalBytes:task.downloadedBytes});
    const actualSha256 = await fileHash(partial, signal);
    if (task.expectedSha256 && actualSha256 !== task.expectedSha256) { task.requiresRestart = true; throw new WorkbenchError(400, 'SHA256 校验不一致，文件未发布；请核对来源后重新下载。'); }
    this.update(task, {actualSha256, verification:task.expectedSha256 ? 'sha256' : 'calculated'});
    await this.publish(task, partial, target, signal);
  }
  async cleanupStage(task) {
    const staged = await insideDirectory(task.comfyPath, 'temp', 'ai-future-downloads', task.id + '.part');
    await rm(staged, {force:true});
  }
  async cleanupCompleted(task) {
    try {
      await checkedLocalPath(task.target);
      if (!await absent(task.target)) {
        const partial = await insideDirectory(this.directory, task.id + '.part');
        await rm(partial, {force:true}); await this.cleanupStage(task);
      }
    } catch { task.cleanupWarning = '部分临时文件尚未清理，请检查记录中的磁盘是否可用。'; }
  }
  async publish(task, partial, target, signal) {
    await checkedLocalPath(target); await mkdir(dirname(target), {recursive:true}); signal.throwIfAborted();
    let staged;
    try {
      try { await link(partial, target); }
      catch (error) {
        if (error.code === 'EEXIST') throw new WorkbenchError(409, '模型目录中已存在同名文件，原文件保持不变。');
        if (error.code !== 'EXDEV') throw error;
        const stageRoot = await insideDirectory(task.comfyPath, 'temp', 'ai-future-downloads'); await mkdir(stageRoot, {recursive:true});
        staged = await insideDirectory(stageRoot, task.id + '.part');
        await this.space(stageRoot, task.downloadedBytes); signal.throwIfAborted();
        await copyFile(partial, staged, constants.COPYFILE_EXCL); signal.throwIfAborted();
        await checkedLocalPath(target);
        try { await link(staged, target); } catch (error) { if (error.code === 'EEXIST') throw new WorkbenchError(409, '模型目录中已存在同名文件，原文件保持不变。'); throw error; }
      }
      // 发布采用同卷硬链接的“目标不存在”语义，完成状态在链接成功后立即持久化。
      this.update(task, {status:'completed', error:null, completedAt:now()});
      await rm(partial, {force:true}).catch(() => {});
    } finally { if (staged) await rm(staged, {force:true}).catch(() => {}); }
  }
  async close() {
    this.closed = true;
    for (const job of this.active.values()) { job.intent = 'interrupted'; job.controller.abort(); }
    await Promise.allSettled([...this.creating.values()].map(item => item.promise));
    await Promise.allSettled([...this.active.values()].map(job => job.promise));
    await this.cleaning;
  }
}
