import { createReadStream, closeSync, openSync, readSync, statSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultAsarPath = 'E:\\AI-未来\\AIRI\\resources\\app.asar';
const supportedVersion = '0.12.0-beta.5';
const runtimeFiles = [
  'assets/runtime-dom.esm-bundler-Kyeu1UP2.js',
  'assets/runtime-core.esm-bundler-XE5LTC0D.js',
  'assets/pinia-DoBKppw5.js',
  'assets/tres-BCDDYdGG.js',
  'assets/src-Dvya5YcL.js',
  'assets/environment-DvA308NR.js',
  'assets/src-ByvEVacJ.css',
  'assets/main-D-kUkR_k.css',
  'assets/AvatarSample_A-BNRNjuVT.vrm',
  'assets/AvatarSample_B-Cgr_Y5fe.vrm',
  'assets/idle_loop-Cs1QaHgK.vrma',
];
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.hdr': 'application/octet-stream',
};
const airiLicense = `MIT License

Copyright (c) 2024-PRESENT Neko Ayaka

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function safeAssetPath(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (!decoded || /[\\\0:%]/.test(decoded)) return null;
  const parts = decoded.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return decoded;
}

function openArchive(asarPath) {
  const fileSize = statSync(asarPath).size;
  const fd = openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) throw new Error('AIRI ASAR 头不完整');
    const headerSize = prefix.readUInt32LE(12);
    const dataOffset = 8 + prefix.readUInt32LE(4);
    if (headerSize < 2 || headerSize > 32 * 1024 * 1024 || dataOffset < 16 + headerSize || dataOffset > fileSize) {
      throw new Error('AIRI ASAR 头无效');
    }
    const header = Buffer.alloc(headerSize);
    if (readSync(fd, header, 0, headerSize, 16) !== headerSize) throw new Error('AIRI ASAR 头不完整');
    const tree = JSON.parse(header.toString('utf8'));
    function entry(path) {
      let item = tree;
      for (const part of path.split('/')) item = Object.hasOwn(item?.files ?? {}, part) ? item.files[part] : null;
      if (!item || item.files || item.link || item.unpacked || !Number.isSafeInteger(item.size) || item.size < 0) return null;
      const start = dataOffset + Number(item.offset);
      if (!Number.isSafeInteger(start) || start < dataOffset || start + item.size > fileSize) return null;
      return { size: item.size, start };
    }
    function readEntry(path) {
      const item = entry(path);
      if (!item) throw new Error(`AIRI 资源缺失：${path}`);
      const data = Buffer.alloc(item.size);
      const sourceFd = openSync(asarPath, 'r');
      try {
        if (readSync(sourceFd, data, 0, data.length, item.start) !== data.length) throw new Error('AIRI 资源读取不完整');
      } finally { closeSync(sourceFd); }
      return data;
    }
    const packageInfo = JSON.parse(readEntry('package.json').toString('utf8'));
    return {
      version: packageInfo.version,
      get(path) { return entry('out/renderer/' + path); },
      read(path) { return readEntry('out/renderer/' + path); },
      stream(path, start, end) {
        const item = entry('out/renderer/' + path);
        return createReadStream(asarPath, { start: item.start + start, end: item.start + end });
      },
    };
  } finally { closeSync(fd); }
}

function openBundle(bundleDir) {
  const root = realpathSync(bundleDir);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('AIRI 舞台资源清单无效');
  const files = new Set(manifest.files);
  function location(path) {
    if (!files.has(path) || !safeAssetPath(path)) return null;
    try {
      const target = realpathSync(join(root, ...path.split('/')));
      const child = relative(root, target);
      if (child.startsWith('..') || isAbsolute(child)) return null;
      return target;
    } catch { return null; }
  }
  return {
    version: manifest.version,
    get(path) { const target = location(path); return target ? { size: statSync(target).size } : null; },
    read(path) { const target = location(path); if (!target) throw new Error('AIRI 资源缺失'); return readFileSync(target); },
    stream(path, start, end) { return createReadStream(location(path), { start, end }); },
  };
}

function transformAsset(path, data) {
  if (path !== 'assets/environment-DvA308NR.js') return data;
  return Buffer.from(data.toString('utf8')
    .replace('function isStageWeb() {\n\treturn false;', 'function isStageWeb() {\n\treturn true;')
    .replace('function isStageTamagotchi() {\n\treturn true;', 'function isStageTamagotchi() {\n\treturn false;'));
}

function stageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIRI ThreeScene · AI-未来</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="./assets/src-ByvEVacJ.css"><link rel="stylesheet" href="./assets/main-D-kUkR_k.css">
<style>html,body,#stage{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}#stage>div{width:100%;height:100%}#status{position:fixed;bottom:14px;left:16px;right:16px;font:12px/1.6 system-ui;color:#71716e;pointer-events:none}#status[data-state=error]{color:#b45309}canvas{display:block}body{background:radial-gradient(ellipse at 48% 85%,#e8e4f6 0,transparent 66%)}</style>
</head><body><div id="stage"></div><div id="status" role="status">正在载入 AIRI 原生 ThreeScene…</div><script type="module" src="./stage.mjs"></script></body></html>`;
}

function stageScript() {
  return `import { i as createApp } from './assets/runtime-dom.esm-bundler-Kyeu1UP2.js';
import { D as createVNode, vn as ref } from './assets/runtime-core.esm-bundler-XE5LTC0D.js';
import { t as createPinia } from './assets/pinia-DoBKppw5.js';
import { r as TresPlugin } from './assets/tres-BCDDYdGG.js';
import { t as ThreeScene } from './assets/src-Dvya5YcL.js';

const status = document.getElementById('status');
window.__airiStage = { source: '@proj-airi/stage-ui-three', version: '${supportedVersion}', state: 'loading', error: null };
function report(state, message) {
  window.__airiStage.state = state;
  if (state === 'error') window.__airiStage.error = message;
  status.dataset.state = state;
  status.textContent = message || (state === 'mounted' ? 'AIRI 原生舞台 · 示例形象 · 可拖动旋转、滚轮缩放' : '正在载入 AIRI 原生 ThreeScene…');
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'airi-stage-status', state, message }, location.origin);
    if (state === 'mounted') window.parent.postMessage({ type: 'ai-future:airi-ready' }, location.origin);
    if (state === 'error') window.parent.postMessage({ type: 'ai-future:airi-error', message }, location.origin);
  }
}
window.addEventListener('error', event => report('error', event.message || '舞台加载失败'));
window.addEventListener('unhandledrejection', event => report('error', String(event.reason?.message || event.reason)));
const cursor = ref({ x: innerWidth / 2, y: innerHeight / 2 });
window.addEventListener('pointermove', event => { cursor.value = { x: event.clientX, y: event.clientY }; });
const avatar = ref(new URL('./assets/AvatarSample_A-BNRNjuVT.vrm', import.meta.url).href);
const paused = ref(false);
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'airi-stage-pause') paused.value = !!event.data.paused;
  if (event.data?.type === 'airi-stage-avatar' && ['A', 'B'].includes(event.data.avatar)) {
    avatar.value = new URL(event.data.avatar === 'B' ? './assets/AvatarSample_B-Cgr_Y5fe.vrm' : './assets/AvatarSample_A-BNRNjuVT.vrm', import.meta.url).href;
  }
});
const App = { setup() { return () => createVNode(ThreeScene, {
  modelSrc: avatar.value, cursorPosition: cursor.value, paused: paused.value, enableOrbitControls: true,
  'onUpdate:state': value => report(value === 'mounted' ? 'mounted' : 'loading'),
  onError: error => report('error', String(error?.message || error)),
}); } };
const app = createApp(App);
app.config.errorHandler = error => report('error', String(error?.message || error));
app.use(createPinia()).use(TresPlugin).mount('#stage');
`;
}

export function createAiriAssets(options = {}) {
  let source;
  let note;
  try {
    const bundleDir = options.bundleDir ?? join(projectRoot, 'resources', 'airi');
    source = (!options.asarPath || options.bundleDir) && existsSync(join(bundleDir, 'manifest.json'))
      ? openBundle(bundleDir) : openArchive(options.asarPath ?? defaultAsarPath);
    if (source.version !== supportedVersion) throw new Error(`当前兼容舞台适配 ${supportedVersion}，检测到 ${source.version}`);
    for (const path of runtimeFiles) if (!source.get(path)) throw new Error(`舞台资源缺失：${path}`);
    note = '复用 AIRI 原生 ThreeScene 与自带 VRM 示例形象；独立于原应用。自定义形象、语音口型和会话状态同步尚未接入。';
  } catch (error) {
    source = null;
    note = `AIRI 舞台暂不可用：${error.message}。请安装兼容版本或在 Demo 内准备 resources/airi 资源。`;
  }

  const available = !!source;
  return {
    available,
    version: source?.version ?? null,
    url: '/airi/',
    note,
    async handle(req, res) {
      const rawPath = (req.url ?? '').split('?')[0];
      if (rawPath !== '/airi' && !rawPath.startsWith('/airi/')) return false;
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return true; }
      if (rawPath === '/airi') { res.writeHead(302, { Location: '/airi/' }).end(); return true; }
      if (!available) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end(note); return true; }
      const path = rawPath === '/airi/' ? 'index.html' : safeAssetPath(rawPath.slice('/airi/'.length));
      if (!path) { res.writeHead(400).end('无效的资源路径'); return true; }
      let data;
      let size;
      if (path === 'index.html') data = Buffer.from(stageHtml());
      else if (path === 'stage.mjs') data = Buffer.from(stageScript());
      else {
        if (!path.startsWith('assets/')) { res.writeHead(404).end(); return true; }
        const item = source.get(path);
        if (!item) { res.writeHead(404).end(); return true; }
        size = item.size;
        if (path === 'assets/environment-DvA308NR.js') data = transformAsset(path, source.read(path));
      }
      size = data?.length ?? size;
      const headers = {
        'Content-Type': mimeTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };
      // The scene uses packaged models and textures only; it never contacts the running AIRI server.
      if (path === 'index.html') headers['Content-Security-Policy'] = "default-src 'self' blob: data:; script-src 'self' data: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:; media-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!match || Number(match[1]) >= size || (match[2] && Number(match[2]) < Number(match[1]))) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return true;
        }
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || size === 0) res.end();
      else if (data) res.end(data.subarray(start, end + 1));
      else try { await pipeline(source.stream(path, start, end), res); }
      catch (error) { if (!res.destroyed) res.destroy(error); }
      return true;
    },
    async materialize(outDir) {
      if (!source) throw new Error(note);
      const target = resolve(outDir);
      const child = relative(projectRoot, target);
      if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('AIRI 资源只能导出到 Demo 目录内');
      let ancestor = target;
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      const realChild = relative(realpathSync(projectRoot), realpathSync(ancestor));
      if (realChild.startsWith('..') || isAbsolute(realChild)) throw new Error('AIRI 导出目标不能通过链接离开 Demo 目录');
      const pending = [...runtimeFiles];
      const files = new Set();
      let totalBytes = 0;
      while (pending.length) {
        const path = pending.pop();
        if (files.has(path)) continue;
        const item = source.get(path);
        if (!item) throw new Error(`AIRI 依赖缺失：${path}`);
        files.add(path);
        totalBytes += item.size;
        if (totalBytes > 240 * 1024 * 1024) throw new Error('AIRI 舞台依赖超过 240 MiB，请检查资源范围');
        if (!/\.(?:js|css|mjs)$/.test(path)) continue;
        const text = source.read(path).toString('utf8');
        for (const match of text.matchAll(/["']((?:\.\.?\/)[^"'\s]+)["']|new URL\(["']([^"'\s]+)["']\s*,\s*import\.meta\.url\)|url\(["']?([^\s"')]+)["']?\)/g)) {
          const value = (match[1] ?? match[2] ?? match[3]).split(/[?#]/)[0];
          if (/^(?:data:|blob:|https?:|\/)/.test(value)) continue;
          const next = posix.normalize(posix.join(posix.dirname(path), value));
          if (next.startsWith('assets/') && safeAssetPath(next) && source.get(next)) pending.push(next);
        }
      }
      await mkdir(target, { recursive: true });
      const realOutputRoot = realpathSync(target);
      function checkOutput(path) {
        let parent = path;
        while (!existsSync(parent)) parent = dirname(parent);
        const child = relative(realOutputRoot, realpathSync(parent));
        if (child.startsWith('..') || isAbsolute(child)) throw new Error('AIRI 导出目录不能包含指向外部的链接');
      }
      for (const path of files) {
        const file = join(target, ...path.split('/'));
        checkOutput(file);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, source.read(path));
      }
      const manifest = { version: source.version, component: '@proj-airi/stage-ui-three', files: [...files].sort(), totalBytes };
      for (const name of ['manifest.json', 'NOTICE.txt', 'AIRI-LICENSE.txt']) checkOutput(join(target, name));
      await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8' });
      await writeFile(join(target, 'AIRI-LICENSE.txt'), airiLicense, { encoding: 'utf8' });
      await writeFile(join(target, 'NOTICE.txt'), '本地 Demo 复用 moeru-ai/airi 0.12.0-beta.5 中的 ThreeScene 组件与示例资源。\nAIRI 项目使用 MIT License：https://github.com/moeru-ai/airi\n各第三方代码、字体与 VRM 示例资源仍适用其随附授权与模型元数据；本资源包用于本地验证，不表示全部素材可独立再分发。\n此 Demo 为兼容层，非完整上游源码 fork。\n', { encoding: 'utf8' });
      return manifest;
    },
  };
}
