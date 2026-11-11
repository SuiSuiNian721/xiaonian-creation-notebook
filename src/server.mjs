import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Domain, object } from './domain.mjs';
import { AppError } from './providers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function json(res, status, value) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AppError(415, '请使用 application/json 请求。');
  if (Number(req.headers['content-length']) > 64 * 1024) { req.resume(); throw new AppError(413, '请求正文超过 64 KiB。'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AppError(413, '请求正文超过 64 KiB。');
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, '请求正文不是有效 JSON。'); }
}

async function sendFile(req, res, filename, mime) {
  let bytes;
  try { bytes = await readFile(filename); }
  catch { throw new AppError(404, '找不到这个文件。'); }
  res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length, 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

async function staticFile(req, res, pathname, staticDir) {
  const candidate = resolve(staticDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  let directory;
  let actual;
  try { [directory, actual] = await Promise.all([realpath(staticDir), realpath(candidate)]); }
  catch { throw new AppError(404, '找不到这个页面。'); }
  if (!actual.startsWith(`${directory}${sep}`) || !(await stat(actual)).isFile()) throw new AppError(404, '找不到这个页面。');
  await sendFile(req, res, actual, mimeTypes[extname(actual).toLowerCase()] ?? 'application/octet-stream');
}

async function defaultAiri() {
  try { const { createAiriAssets } = await import('./airi-assets.mjs'); return createAiriAssets(); }
  catch { return { available: false, note: 'AIRI 舞台资源未安装或无法读取。' }; }
}

export async function createApp({ dataDir = join(root, 'data'), port = 17880, host = '127.0.0.1', staticDir = join(root, 'public'), airiAssets } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new AppError(400, '工作台仅允许绑定本机回环地址。');
  const airi = typeof airiAssets === 'function' ? await airiAssets() : airiAssets ?? await defaultAiri();
  const domain = new Domain({ dataDir: resolve(dataDir), airi });
  let expectedHost;
  let appUrl;
  let closed;
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    try {
      if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== appUrl) || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, '只允许工作台的本机同源访问。');
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, appUrl).pathname); } catch { throw new AppError(400, '请求路径无效。'); }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) throw new AppError(400, '请求路径无效。');
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, domain.state());
      if (req.method === 'POST' && pathname === '/v1/chat/completions') return json(res, 200, await domain.compatibleCompletion(await body(req)));
      if (req.method === 'DELETE' && pathname.startsWith('/api/memories/')) return json(res, 200, domain.forgetMemory(pathname.slice('/api/memories/'.length)));
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        const value = await body(req);
        let result;
        switch (pathname) {
          case '/api/conversations': result = domain.createConversation(value); break;
          case '/api/chat': result = await domain.chat(value); break;
          case '/api/character': result = domain.updateCharacter(value); break;
          case '/api/config': result = domain.updateConfig(value); break;
          case '/api/preferences': result = domain.updatePreferences(value); break;
          case '/api/memories': result = domain.addMemory(value); break;
          case '/api/qq/simulate': result = await domain.simulate(value); break;
          case '/api/qq/connect': await domain.qq.connect(domain.store.getSetting('config').qq); result = { ok: true, qq: domain.qq.status }; break;
          case '/api/qq/disconnect': domain.qq.disconnect(); result = { ok: true, qq: domain.qq.status }; break;
          case '/api/speech': result = await domain.speech(value); break;
          default: throw new AppError(404, '找不到这个接口。');
        }
        return json(res, 200, result);
      }
      if (pathname.startsWith('/api/')) throw new AppError(404, '找不到这个接口。');
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, '此路径不支持这个请求方法。');
      if (pathname.startsWith('/media/')) {
        const media = domain.store.media(pathname.slice('/media/'.length));
        if (!media) throw new AppError(404, '找不到这个音频。');
        return await sendFile(req, res, join(dataDir, 'media', media.filename), media.mime);
      }
      if (airi?.handle && await airi.handle(req, res)) return;
      if (pathname.startsWith('/airi/')) throw new AppError(404, 'AIRI 舞台资源当前不可用。');
      await staticFile(req, res, pathname, staticDir);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '本地服务处理失败，请检查运行记录或重试。' });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen); });
  } catch (error) { await domain.close(); throw error; }
  expectedHost = `${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  appUrl = `http://${expectedHost}`;
  return {
    url: appUrl,
    close() {
      if (!closed) closed = (async () => {
        const stopped = new Promise(resolveClose => server.close(resolveClose));
        await domain.close();
        server.closeAllConnections();
        await stopped;
      })();
      return closed;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createApp({ dataDir: process.env.AI_FUTURE_DATA_DIR || join(root, 'data'), port: Number(process.env.PORT || 17880) });
  console.log(`AI-未来 工作台：${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
