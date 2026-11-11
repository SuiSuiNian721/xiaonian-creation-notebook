import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { embedStudioHtml } from './card-studio-embed.mjs';
import { WorkbenchError } from './contracts.mjs';
import { findCodexCli } from './codex-cli.mjs';

const RESOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../integrations/xiaoxi');
const MAX_BODY = 40 * 1024 * 1024;
const MAX_HTML = 4 * 1024 * 1024;
const PREFIX = '/card-studio/';
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function safePath(base, name = '') {
  const target = resolve(base, name);
  const rel = relative(resolve(base), target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new WorkbenchError(400, '创作区路径超出工作区。');
  let current = parse(target).root;
  for (const segment of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new WorkbenchError(400, '创作区路径不允许符号链接或 junction。');
      if (current !== target && !stat.isDirectory()) throw new WorkbenchError(400, '创作区路径包含非目录项目。');
    } catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}

async function readOptional(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

function allowedResource(file) {
  return file === 'AGENTS.md' || file === 'docs/角色卡制作流程.md'
    || /^(tools\/[^\0]+\.mjs|(?:workflow|personas|templates|docs\/写作参考)\/[^\0]+\.md|assets\/avatars\/[^\0]+\.png|assets\/fonts\/[^\0]+\.(?:woff2|txt|md))$/.test(file);
}

function filteredHeaders(headers) {
  const blocked = new Set([...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function respondError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status || error.statusCode || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: error.message || '角色卡创作区暂时不可用。' }));
}

function contentPolicy(html) {
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
  return `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`;
}

export class CardStudio {
  #child = null;
  #token = '';
  #lock = null;
  #starting = null;
  #closing = null;
  #requests = new Set();
  #upstream = '';
  #profileSnapshot = '';
  #profileSync = Promise.resolve();

  constructor({ dataDir, onOpenArtifacts, codexCli = findCodexCli(), sharedConfig, userProfile, publicPrefix='/card-studio' } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('CardStudio 需要 dataDir。');
    this.workspacePath = join(resolve(dataDir), 'card-studio');
    this.version = '';
    this.onOpenArtifacts = onOpenArtifacts;
    this.codexCli = codexCli;
    this.sharedConfig = sharedConfig;
    this.userProfile = userProfile;
    this.publicPrefix = publicPrefix;
  }

  get upstreamUrl() { return this.#upstream; }

  start() {
    if (this.#starting) return this.#starting;
    const closing = this.#closing;
    this.#starting = (async () => {
      if (closing) await closing;
      if (this.#child && this.#upstream) return this.#info();
      try {
        await safePath(this.workspacePath);
        await mkdir(this.workspacePath, { recursive: true });
        if (!this.#lock) await this.#acquireLock();
        await this.#seedResources();
        await this.#launch();
        await this.syncUserProfile();
        await this.syncSharedAI();
        return this.#info();
      } catch (error) {
        await this.#stopChild();
        await this.#releaseLock();
        throw error;
      }
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  #info() { return { url: this.publicPrefix+'/', workspacePath: this.workspacePath, version: this.version }; }

  syncUserProfile() {
    this.#profileSync = this.#profileSync.catch(() => {}).then(async () => {
      const child = this.#child;
      if (!child?.connected) return;
      const source = this.userProfile?.() || {};
      const profile = Object.fromEntries(['displayName', 'avatar', 'identity', 'preferences'].map(key => [key, typeof source[key] === 'string' ? source[key] : '']));
      const snapshot = JSON.stringify(profile);
      if (snapshot === this.#profileSnapshot) return;
      await new Promise((resolveSync, reject) => {
        const requestId = randomUUID();
        const finish = error => {
          clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
          if (error) reject(error); else resolveSync();
        };
        const onMessage = message => {
          if (message?.type === 'xiaoxi-user-profile-synced' && message.requestId === requestId) finish();
        };
        const onExit = () => finish(new WorkbenchError(502, '角色卡服务已退出，用户资料未同步。'));
        const timer = setTimeout(() => finish(new WorkbenchError(504, '角色卡用户资料同步超时。')), 10000);
        child.on('message', onMessage); child.once('exit', onExit);
        child.send({ type: 'xiaoxi-user-profile', requestId, profile }, error => { if (error) finish(error); });
      });
      this.#profileSnapshot = snapshot;
    });
    return this.#profileSync;
  }

  async syncSharedAI() {
    const config=this.sharedConfig?.();
    if(!config || !this.#upstream)return;
    const response=await fetch(this.#upstream+'/api/bridge/llm-config',{method:'POST',headers:{'content-type':'application/json','x-xiaoxi-token':this.#token,origin:this.#upstream},body:JSON.stringify(config),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new WorkbenchError(502,'角色卡模块未能接入共用 AI 连接。');
  }

  async #acquireLock() {
    const canonical = await realpath(this.workspacePath);
    const id = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
    // Named pipes/abstract sockets are released by the OS even if the host crashes.
    const address = process.platform === 'win32' ? '\\\\.\\pipe\\ai-future-card-studio-' + id
      : process.platform === 'linux' ? '\0ai-future-card-studio-' + id
        : join(tmpdir(), 'ai-future-card-' + id.slice(0, 24) + '.sock');
    const lock = createServer(socket => socket.destroy());
    await new Promise((resolveLock, reject) => {
      lock.once('error', error => reject(new WorkbenchError(409, ['EADDRINUSE', 'EACCES'].includes(error.code)
        ? '此角色卡工作区正在使用，请先关闭另一个窗口。' : '无法锁定角色卡工作区：' + error.message)));
      lock.listen(address, resolveLock);
    });
    this.#lock = lock;
  }

  async #releaseLock() {
    const lock = this.#lock;
    this.#lock = null;
    if (lock) await new Promise(resolveClose => lock.close(resolveClose));
  }

  async #seedResources() {
    const manifest = JSON.parse(await readFile(join(RESOURCE_ROOT, 'source-manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.source?.version) throw new WorkbenchError(500, '内置创作区资源清单无效。');
    this.version = manifest.source.version;
    const stateFile = await safePath(this.workspacePath, 'work/.bundled-files.json');
    const state = await readOptional(stateFile);
    let previous = {};
    if (state) {
      try { previous = JSON.parse(state.toString('utf8')); }
      catch { throw new WorkbenchError(500, '资源跟踪清单损坏，已保留工作区，请先修复 .bundled-files.json。'); }
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new WorkbenchError(500, '资源跟踪清单格式无效，已保留工作区。');
    }
    const next = {};
    for (const file of manifest.files) {
      if (typeof file.path !== 'string' || !allowedResource(file.path) || file.path.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..')
        || Object.hasOwn(next, file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new WorkbenchError(500, '内置创作区资源路径无效。');
      const source = await safePath(RESOURCE_ROOT, file.path);
      const bytes = await readFile(source);
      if (hash(bytes) !== file.sha256 || bytes.length !== file.size) throw new WorkbenchError(500, '内置创作区资源校验失败：' + file.path);
      const target = await safePath(this.workspacePath, file.path);
      const current = await readOptional(target);
      const previousHash = Object.hasOwn(previous, file.path) && /^[a-f0-9]{64}$/.test(previous[file.path]) ? previous[file.path] : null;
      const currentHash = current && hash(current);
      if (!current || currentHash === file.sha256 || previousHash && currentHash === previousHash) {
        if (currentHash !== file.sha256) await atomicWrite(target, bytes);
        next[file.path] = file.sha256;
      } else next[file.path] = previousHash;
    }
    await atomicWrite(stateFile, JSON.stringify(next, null, 2) + '\n');
    for (const directory of ['cards', 'presets', 'worldbooks', 'imports', 'dist']) await mkdir(await safePath(this.workspacePath, directory), { recursive: true });
  }

  async #launch() {
    this.#token = randomBytes(32).toString('hex');
    this.#profileSnapshot = '';
    const child = spawn(process.execPath, [join(this.workspacePath, 'tools/studio.mjs')], {
      cwd: this.workspacePath, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0', XIAOXI_NO_OPEN: '1',
        XIAOXI_API_TOKEN: this.#token, XIAOXI_WORKSPACE_ROOT: this.workspacePath, XIAOXI_APP_VERSION: this.version, XIAOXI_WORKBENCH: '1',
        CODEX_CLI_PATH: this.codexCli },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.#child = child;
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('exit', () => { if (this.#child === child) { this.#child = null; this.#upstream = ''; this.#token = ''; } });
    child.on('message', message => {
      if (message?.type === 'xiaoxi-open-artifacts') void this.#openArtifacts(child, message);
    });
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => finish(new WorkbenchError(504, '角色卡创作区启动超时。')), 20000);
      const onError = error => finish(new WorkbenchError(502, '角色卡子服务启动失败：' + error.message));
      const onExit = () => finish(new WorkbenchError(502, '角色卡子服务提前退出。' + (stderr ? '\n' + stderr : '')));
      const onMessage = message => {
        if (message?.type !== 'xiaoxi-ready') return;
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) { finish(new WorkbenchError(502, '角色卡子服务端口无效。')); return; }
        this.#upstream = 'http://127.0.0.1:' + message.port;
        finish();
      };
      const finish = error => {
        clearTimeout(timer);
        child.off('error', onError); child.off('exit', onExit); child.off('message', onMessage);
        if (error) reject(error); else resolveReady();
      };
      child.once('error', onError); child.once('exit', onExit); child.on('message', onMessage);
    });
  }

  async #openArtifacts(child, message) {
    let error;
    try {
      if (typeof this.onOpenArtifacts !== 'function') throw new Error('当前宿主不支持打开文件夹，请使用下载成品。');
      const { name, targetType } = message;
      if (!['card', 'preset', 'book'].includes(targetType) || typeof name !== 'string' || !name || name === '.' || name === '..'
        || /[\\/\0-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) throw new Error('成品目录参数无效。');
      const directory = await safePath(this.workspacePath, join('dist', targetType === 'card' ? name : targetType === 'preset' ? 'presets' : 'worldbooks'));
      if (!(await lstat(directory)).isDirectory()) throw new Error('成品目录不存在。');
      await this.onOpenArtifacts(directory);
    } catch (cause) { error = cause.message || '打开成品目录失败。'; }
    if (child.connected) child.send({ type: 'xiaoxi-artifacts-opened', requestId: message.requestId, ...(error ? { error } : {}) }, () => {});
  }

  async proxy(req, res) {
    try {
      if (!req.url?.startsWith(PREFIX)) throw new WorkbenchError(404, '创作区路径不存在。');
      const route = req.url.slice(PREFIX.length - 1);
      const pathname = route.split('?')[0];
      for (const part of pathname.split('/').filter(Boolean)) {
        let decoded;
        try { decoded = decodeURIComponent(part); } catch { throw new WorkbenchError(400, '创作区路径编码无效。'); }
        if (decoded === '.' || decoded === '..' || /[\\/\0-\x1f]/.test(decoded)) throw new WorkbenchError(400, '创作区路径无效。');
      }
      if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(req.method)) throw new WorkbenchError(405, '创作区不支持此请求方法。');
      let incoming;
      try { incoming = new URL('http://' + req.headers.host); } catch { throw new WorkbenchError(403, '无效的本机 Host。'); }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(incoming.hostname)
        || req.headers['sec-fetch-site'] === 'cross-site'
        || req.headers.origin && req.headers.origin !== incoming.origin) throw new WorkbenchError(403, '拒绝跨站访问角色卡创作区。');
      if (Number(req.headers['content-length']) > MAX_BODY) throw new WorkbenchError(413, '创作区请求正文超过 40 MiB。');
      if (this.#closing) throw new WorkbenchError(503, '角色卡创作区正在关闭。');
      await this.start();
      await this.syncUserProfile();
      if (res.destroyed || req.aborted) return;
      await this.#forward(req, res, route);
    } catch (error) { req.resume(); respondError(res, error); }
  }

  #forward(req, res, route) {
    return new Promise(resolveForward => {
      const headers = filteredHeaders(req.headers);
      for (const key of ['authorization', 'cookie', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) delete headers[key];
      Object.assign(headers, { host: new URL(this.#upstream).host, origin: this.#upstream, 'x-xiaoxi-token': this.#token, 'accept-encoding': 'identity' });
      let upstreamResponse;
      let finished = false;
      let bytes = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_BODY ? new WorkbenchError(413, '创作区请求正文超过 40 MiB。') : null, bytes > MAX_BODY ? undefined : chunk);
      } });
      const upstream = request(this.#upstream + route, { method: req.method, headers, agent: false });
      const finish = error => {
        if (finished) return;
        finished = true;
        this.#requests.delete(cancel);
        req.off('aborted', cancel); res.off('close', cancel); res.off('finish', onFinish);
        req.unpipe(limiter); limiter.unpipe(upstream);
        if (error) { upstream.destroy(); upstreamResponse?.destroy(); req.resume(); respondError(res, error); }
        resolveForward();
      };
      const cancel = () => finish(new WorkbenchError(503, '创作区连接已关闭。'));
      const onFinish = () => finish();
      this.#requests.add(cancel);
      req.once('aborted', cancel); res.once('close', cancel); res.once('finish', onFinish);
      upstream.on('error', () => finish(new WorkbenchError(502, '无法连接角色卡子服务。')));
      limiter.on('error', finish);
      upstream.setTimeout(60000, () => finish(new WorkbenchError(504, '角色卡子服务响应超时。')));
      upstream.on('response', response => {
        upstreamResponse = response;
        const responseHeaders = filteredHeaders(response.headers);
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['content-security-policy'];
        responseHeaders['x-frame-options'] = 'SAMEORIGIN';
        responseHeaders['x-content-type-options'] = 'nosniff';
        res.removeHeader('x-frame-options');
        res.removeHeader('content-security-policy');
        response.on('error', () => finish(new WorkbenchError(502, '角色卡子服务响应中断。')));
        if (route.split('?')[0] === '/' && req.method === 'GET' && response.statusCode === 200) {
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_HTML) { finish(new WorkbenchError(502, '角色卡首页超过允许大小。')); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (finished) return;
            try {
              let html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
              html = html.replace(/var API_TOKEN = [^;]*;/, 'var API_TOKEN = "";');
              if (this.#token && html.includes(this.#token)) throw new Error('角色卡首页令牌隔离失败。');
              html = embedStudioHtml(html,this.publicPrefix);
              delete responseHeaders['content-length']; delete responseHeaders['content-encoding'];
              responseHeaders['content-security-policy'] = contentPolicy(html);
              responseHeaders['cache-control'] = 'no-store';
              res.writeHead(response.statusCode, responseHeaders); res.end(html);
            } catch (error) { finish(error); }
          });
        } else {
          res.writeHead(response.statusCode, responseHeaders);
          res.flushHeaders();
          response.pipe(res);
        }
      });
      req.pipe(limiter).pipe(upstream);
    });
  }

  async #stopChild() {
    for (const cancel of [...this.#requests]) cancel();
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) { this.#child = null; this.#upstream = ''; this.#token = ''; return; }
    await new Promise((resolveExit, reject) => {
      const kill = setTimeout(() => child.kill(), 3500);
      const timeout = setTimeout(() => { clean(); reject(new WorkbenchError(503, '角色卡子服务未能退出，工作区锁仍保留。')); }, 6500);
      const clean = () => { clearTimeout(kill); clearTimeout(timeout); child.off('exit', onExit); };
      const onExit = () => { clean(); resolveExit(); };
      child.once('exit', onExit);
      if (child.connected) child.send({ type: 'xiaoxi-shutdown' }, error => { if (error) child.kill(); });
      else child.kill();
    });
  }

  close() {
    if (this.#closing) return this.#closing;
    const starting = this.#starting;
    this.#closing = (async () => {
      if (starting) await starting.catch(() => {});
      await this.#stopChild();
      await this.#releaseLock();
    })().finally(() => { this.#closing = null; });
    return this.#closing;
  }
}
