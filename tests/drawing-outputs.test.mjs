import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../framework/server.mjs';
import { archiveDrawingResult, MAX_DRAWING_RESULT_BYTES } from '../framework/drawing-results.mjs';
import { ComfyDrawing } from '../framework/drawing.mjs';

const path = '/api/modules/drawing';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=', 'base64');
const videoHeader = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-outputs-'));
  const histories = {}, files = new Map(), received = [], failures = new Set();
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(url);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/system_stats') return res.end(JSON.stringify({ system: { comfyui_version: '0.42.0' } }));
    if (url.pathname === '/object_info') return res.end(JSON.stringify({ SaveText: { input: { required: { text: ['STRING'] } }, output_node: true } }));
    if (url.pathname === '/prompt') return res.end(JSON.stringify({ prompt_id: JSON.parse(Buffer.concat(chunks)).prompt_id }));
    if (url.pathname === '/queue') return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (url.pathname.startsWith('/history/')) return res.end(JSON.stringify(histories));
    if (url.pathname === '/view') {
      const name = url.searchParams.get('filename'), value = files.get(name);
      if (!value || failures.has(name)) { res.statusCode = 503; return res.end('{}'); }
      res.setHeader('content-type', 'application/octet-stream');
      if (typeof value === 'number') {
        res.setHeader('content-length', value);
        res.write(videoHeader); let remaining = value - videoHeader.length; const chunk = Buffer.alloc(1024 * 1024, 7);
        while (remaining > 0 && !res.destroyed) { const part = chunk.subarray(0, Math.min(chunk.length, remaining)); remaining -= part.length; if (!res.write(part)) await once(res, 'drain'); }
        return res.end();
      }
      return res.end(value);
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  let app = await createWorkbench({ dataDir: join(directory, 'data'), drawingOptions: { installationDirectory:directory, WebSocketImpl: null } });
  const api = async (suffix, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url + suffix, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  await api(path + '/enable', {});
  await api(path + '/config', { values: { serviceUrl: `http://127.0.0.1:${upstream.address().port}`, outputPath: join(directory, 'export') } }, 'PUT');
  await api(path + '/connect', {});
  const workflow = await api(path + '/workflows/import', { name: '多类输出测试', document: { '1': { class_type: 'SaveText', inputs: { text: 'hello' } } } });
  t.after(async () => { await app.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return { directory, histories, files, received, failures, api, base: () => app.url,
    async submit(characterId = null) { return api(path + '/jobs', { requestId: randomUUID(), workflowId: workflow.id, values: {}, characterId }); },
    async complete(job, outputs) { histories[job.promptId] = { status: { completed: true, status_str: 'success' }, outputs }; return api(path + `/jobs/${job.id}/refresh`, {}); },
    async restartOffline() { await app.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); app = await createWorkbench({ dataDir: join(directory, 'data'), drawingOptions: { WebSocketImpl: null } }); },
  };
}

test('纯文本工作流完成，列表摘要有界且完整文本可离线下载', async t => {
  const f = await fixture(t), job = await f.submit();
  const full = '<script>globalThis.bad=true</script>\n' + '文本结果'.repeat(12000);
  const completed = await f.complete(job, { '1': { text: [full, '第二段'] } });
  assert.equal(completed.status, 'completed'); assert.equal(completed.images.length, 0);
  const text = completed.results.find(item => item.kind === 'text'); assert.ok(text);
  assert.ok(text.text.length <= 4096); assert.equal(text.truncated, true);
  assert.ok(JSON.stringify(completed).length < 15000);
  assert.equal(await readFile(text.archived, 'utf8'), full + '\n第二段');
  await f.restartOffline();
  const response = await fetch(f.base() + text.url + '?download=1');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.equal(await response.text(), full + '\n第二段');
  assert.equal((await f.api(path + '/state')).jobs[0].status, 'completed');
});

test('官方视频 images、VHS gifs、音频、图片、文本和未知数据混合归档，只有静态图片关联角色', async t => {
  const f = await fixture(t); const character = (await f.api('/api/characters', { name: '多媒体测试' })).character;
  const job = await f.submit(character.id);
  f.files.set('picture.png', png); f.files.set('电影.mp4', videoHeader); f.files.set('animation.webm', Buffer.from('1a45dfa301020304', 'hex'));
  f.files.set('voice.wav', Buffer.from('524946461000000057415645666d7420', 'hex')); f.files.set('loop.gif', Buffer.from('GIF89a', 'ascii')); f.files.set('mesh.glb', Buffer.from('glTFdata'));
  const outputs = {
    image: { images: [{ filename: 'picture.png', type: 'output' }] },
    video: { images: [{ filename: '电影.mp4', subfolder: 'video/november', type: 'output' }], animated: [true] },
    vhs: { gifs: [{ filename: 'animation.webm', subfolder: '', type: 'temp', format: 'video/webm' }, { filename: 'loop.gif', type: 'output', format: 'image/gif' }] },
    sound: { audio: [{ filename: 'voice.wav', type: 'output' }] },
    text: { string: ['保留的文本'] },
    custom: { mesh: [{ filename: 'mesh.glb', type: 'output' }], metrics: { score: 0.75, nested: [true, null] }, url: 'http://do-not-request.invalid/private' },
  };
  const completed = await f.complete(job, outputs); assert.equal(completed.status, 'completed');
  assert.equal(completed.images.length, 1);
  assert.deepEqual(completed.results.map(item => item.kind).sort(), ['animation', 'audio', 'data', 'data', 'file', 'text', 'video', 'video']);
  const data = completed.results.find(item => item.sourceName === '节点 custom 数据.json');
  assert.deepEqual(JSON.parse(await (await fetch(f.base() + data.url)).text()).metrics, outputs.custom.metrics);
  const state = await f.api('/api/state'); assert.equal(state.characters.find(item => item.id === character.id).assets.length, 1);
  const video = completed.results.find(item => item.sourceName === '电影.mp4'); assert.equal(video.mime, 'video/mp4'); assert.equal(video.source.type, 'output');
  const request = f.received.find(url => url.pathname === '/view' && url.searchParams.get('filename') === '电影.mp4');
  assert.equal(request.searchParams.get('subfolder'), 'video/november');
  const again = await f.api(path + `/jobs/${job.id}/refresh`, {}); assert.deepEqual(again.results.map(item => item.id), completed.results.map(item => item.id));
  assert.equal(f.received.filter(url => url.pathname === '/view').length, 6);
});

test('大于 64 MiB 的视频流式归档，离线 Range、suffix、HEAD 和越界请求正确', async t => {
  const f = await fixture(t), job = await f.submit(), size = 65 * 1024 * 1024;
  f.files.set('large.mp4', size);
  const completed = await f.complete(job, { '1': { images: [{ filename: 'large.mp4', type: 'output' }], animated: [true] } });
  assert.equal(completed.status, 'completed', completed.error); assert.equal(completed.images.length, 0);
  const result = completed.results[0]; assert.equal(result.bytes, size); assert.equal((await stat(result.archived)).size, size);
  await f.restartOffline();
  const range = await fetch(f.base() + result.url, { headers: { Range: 'bytes=0-23' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-23/${size}`); assert.deepEqual(Buffer.from(await range.arrayBuffer()), videoHeader);
  const suffix = await fetch(f.base() + result.url, { headers: { Range: 'bytes=-4' } }); assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.alloc(4, 7));
  const head = await fetch(f.base() + result.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(size)); assert.equal(await head.text(), '');
  for (const Range of [`bytes=${size}-`, 'bytes=5-2', 'bytes=0-1,4-5', 'bytes=-0']) { const response = await fetch(f.base() + result.url, { headers: { Range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${size}`); }
});

test('部分文件归档失败后重试不会复制已完成结果', async t => {
  const f = await fixture(t), job = await f.submit(); f.files.set('first.mp4', videoHeader); f.files.set('second.mp4', videoHeader); f.failures.add('second.mp4');
  const outputs = { '1': { videos: [{ filename: 'first.mp4' }, { filename: 'second.mp4' }] } };
  const first = await f.complete(job, outputs); assert.notEqual(first.status, 'completed'); assert.match(first.error, /归档待重试/); assert.equal(first.results.length, 1);
  f.failures.clear(); const completed = await f.complete(job, outputs); assert.equal(completed.status, 'completed'); assert.equal(completed.results.length, 2); assert.equal(completed.results[0].id, first.results[0].id);
  assert.equal(f.received.filter(url => url.pathname === '/view' && url.searchParams.get('filename') === 'first.mp4').length, 1);
  assert.equal((await readdir(join(f.directory, 'data/drawing/results'))).filter(name => !name.endsWith('.part')).length, 2);
});

test('空输出明确失败；有非文件未知结构时完整保留，不主动请求返回的 URL', async t => {
  const f = await fixture(t); const empty = await f.complete(await f.submit(), {}); assert.equal(empty.status, 'failed');
  const value = { arbitrary: { list: [1, 2], html: '<img onerror=alert(1)>', url: 'https://do-not-request.invalid/' } };
  const completed = await f.complete(await f.submit(), { '1': value }); assert.equal(completed.status, 'completed'); assert.equal(completed.results[0].kind, 'data');
  assert.deepEqual(JSON.parse(await (await fetch(f.base() + completed.results[0].url)).text()), value);
  assert.equal(f.received.filter(url => url.pathname === '/view').length, 0);
});

test('归档拒绝绝对路径、目录穿越、URL 与 input 文件索引，且不调用上游 view', async t => {
  const f = await fixture(t);
  for (const source of [{ filename: '../private.mp4' }, { filename: 'C:\\private.mp4' }, { filename: 'https://example.com/a.mp4' }, { filename: 'a.mp4', subfolder: '../private' }, { filename: 'a.mp4', subfolder: '/private' }, { filename: 'a.mp4', type: 'input' }, { filename: 'a.mp4', subfolder: 'safe/../../private' }]) {
    const result = await f.complete(await f.submit(), { '1': { images: [source] } }); assert.notEqual(result.status, 'completed'); assert.match(result.error, /索引|路径/);
  }
  assert.equal(f.received.filter(url => url.pathname === '/view').length, 0);
});

test('文件后缀不能把上游 HTML 错当视频，失败不留下临时文件', async t => {
  const f = await fixture(t), job = await f.submit(); f.files.set('broken.mp4', Buffer.from('<html>server error</html>'));
  const result = await f.complete(job, { '1': { images: [{ filename: 'broken.mp4' }], animated: [true] } });
  assert.notEqual(result.status, 'completed'); assert.match(result.error, /格式|视频/);
  assert.deepEqual(await readdir(join(f.directory, 'data/drawing/results')), []);
});

test('超出流式文件限额时拒绝正文、清理临时文件并结束请求', async t => {
  const f = await fixture(t), requests = new Set(); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(MAX_DRAWING_RESULT_BYTES + 1) } });
  await assert.rejects(archiveDrawingResult({ job: { id: randomUUID(), serviceUrl: 'http://127.0.0.1:8188' }, output: { key: 'test', source: { filename: 'huge.mp4', type: 'output', subfolder: '' }, extension: '.mp4', kind: 'video', mime: 'video/mp4' }, directory: join(f.directory, 'limits'), fetchImpl: async () => response, requests, closed: () => false, db: { prepare: () => ({ get: () => undefined }) } }), /4 GiB/);
  assert.equal(cancelled, true); assert.equal(requests.size, 0); assert.deepEqual(await readdir(join(f.directory, 'limits/results')), []);
});

test('未知的空数组、布尔值和 animated 单独输出也可查看数据', async t => {
  const f = await fixture(t), outputs = { '1': { custom: [], animated: [true], enabled: false } };
  const result = await f.complete(await f.submit(), outputs); assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(await (await fetch(f.base() + result.results[0].url)).text()), outputs['1']);
});

test('未知对象中的 filename 元数据不冒充文件，原型键也完整保留', async t => {
  const f = await fixture(t), value = JSON.parse('{"details":{"filename":"report.json","count":3},"__proto__":{"value":"原样保留"}}');
  const result = await f.complete(await f.submit(), { '1': value }); assert.equal(result.status, 'completed');
  assert.deepEqual(JSON.parse(await (await fetch(f.base() + result.results[0].url)).text()), value);
  assert.equal(f.received.filter(url => url.pathname === '/view').length, 0);
});

test('文件描述中的额外数据完整保留为可下载结果', async t => {
  const f = await fixture(t); f.files.set('details.mp4', videoHeader);
  const value = { videos: [{ filename: 'details.mp4', type: 'output', captions: ['字幕'], metadata: { fps: 24, score: 0.9 } }] };
  const result = await f.complete(await f.submit(), { '1': value }); assert.equal(result.status, 'completed');
  const data = result.results.find(item => item.kind === 'data'); assert.ok(data, '描述中的未知元数据也必须能导出');
  assert.deepEqual(JSON.parse(await (await fetch(f.base() + data.url)).text()), value);
});

test('图片写盘后数据库中断，确定性编号仍可恢复归档且不残留孤儿文件', async t => {
  const f = await fixture(t); let failed = false, stored;
  const drawing = Object.create(ComfyDrawing.prototype);
  Object.assign(drawing, { directory: join(f.directory, 'image-retry'), request: async () => png, row: () => stored,
    db: { prepare: () => ({ run: (_id, data) => { if (!failed) { failed = true; throw new Error('临时数据库中断'); } stored = JSON.parse(data); } }) } });
  const job = { id: randomUUID(), serviceUrl: 'http://127.0.0.1:8188' }, source = { filename: 'retry.png', subfolder: '', type: 'output' };
  await assert.rejects(drawing.archive(job, source, 'image:retry'), /数据库中断/);
  const result = await drawing.archive(job, source, 'image:retry'); assert.equal(result.mime, 'image/png'); assert.equal((await drawing.archive(job, source, 'image:retry')).id, result.id);
  assert.equal((await readdir(join(drawing.directory, 'images'))).length, 1);
});
