import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = await import('../framework/card-studio.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../integrations/xiaoxi');

async function fixture(t, options = {}) {
  assert.equal(typeof backend.CardStudio, 'function', '创作区必须提供可独立启停的 CardStudio');
  const root = await mkdtemp(join(tmpdir(), 'ai-future-card-studio-'));
  const studio = new backend.CardStudio({ dataDir: root, ...options });
  const server = createServer((req, res) => void studio.proxy(req, res));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await studio.close();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const api = async (path, value, headers = {}) => {
    const response = await fetch(url + '/card-studio' + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { origin: url, ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: response.status, data: await response.json() };
  };
  return { root, studio, server, url, api };
}

test('接入默认 Codex，停用的配置不能保存消息，也不接受已移除的后端', async t => {
  const app = await fixture(t);
  const info = await app.studio.start();
  let status = (await app.api('/api/bridge/llm-status')).data;
  assert.equal(status.backend, 'codex');
  assert.equal(status.enabled, false);
  assert.equal(Object.hasOwn(status, 'qoderModel'), false);
  await app.api('/api/new', { name: '接入检查' });
  const name = encodeURIComponent('接入检查');
  const conversationId = (await app.api('/api/conversations/' + name)).data.activeId;
  const sent = await app.api('/api/chat/' + name, { text: '不应发送', targetType: 'card', conversationId });
  assert.equal(sent.status, 400);
  assert.equal(sent.data.requestAccepted, false);
  assert.equal((await app.api('/api/chat/' + name + '?conversationId=' + conversationId)).data.some(item => item.text === '不应发送'), false);
  assert.equal((await app.api('/api/bridge/llm-config', { backend: 'qoder', enabled: true })).status, 400);
  await writeFile(join(info.workspacePath, 'work/llm-config.json'), JSON.stringify({ backend: 'qoder', enabled: true, qoderModel: 'legacy' }));
  status = (await app.api('/api/bridge/llm-status')).data;
  assert.equal(status.backend, 'codex');
  assert.equal(status.enabled, false, '旧后端不能静默切换成已启用的 Codex');
  const html = await (await fetch(app.url + '/card-studio/')).text();
  assert.doesNotMatch(html, /Qoder|qoderModel|value="qoder"/);
});

test('Codex 启停会持久保存，重新启动仍可用，未登录时启用不改写配置', async t => {
  const app = await fixture(t, { codexCli: process.execPath });
  const info = await app.studio.start();
  await writeFile(join(info.workspacePath, 'login'), "console.log('Logged in using ChatGPT');\n");
  assert.equal((await app.api('/api/bridge/llm-config', { backend: 'codex', enabled: true })).status, 200);
  assert.equal((await app.api('/api/bridge/llm-status')).data.codex.enabled, true);
  await app.studio.close(); await app.studio.start();
  assert.equal((await app.api('/api/bridge/llm-status')).data.codex.enabled, true);
  await app.api('/api/bridge/bridge-stop', {});
  assert.equal((await app.api('/api/bridge/llm-status')).data.enabled, false);
  await app.studio.close(); await app.studio.start();
  assert.equal((await app.api('/api/bridge/llm-status')).data.codex.enabled, false);
  await app.api('/api/bridge/bridge-start', {});
  assert.equal((await app.api('/api/bridge/llm-status')).data.enabled, true);
  await app.api('/api/bridge/bridge-stop', {});
  const before = await readFile(join(info.workspacePath, 'work/llm-config.json'), 'utf8');
  await writeFile(join(info.workspacePath, 'login'), "console.error('Not logged in'); process.exitCode = 1;\n");
  assert.equal((await app.api('/api/bridge/bridge-start', {})).status, 400);
  assert.equal(await readFile(join(info.workspacePath, 'work/llm-config.json'), 'utf8'), before);
});

test('资源快照只包含发布清单中的代码和默认资源，并记录原始 SHA256', async () => {
  const manifest = JSON.parse(await readFile(join(resources, 'source-manifest.json'), 'utf8'));
  assert.equal(manifest.source.version, '0.1.29');
  assert.equal(manifest.files.length, 116);
  assert.ok(manifest.files.some(file => file.path === 'tools/model-response.mjs'));
  for (const file of manifest.files) {
    assert.ok(!/^(cards|work|imports|dist|presets|worldbooks|node_modules|release)\//.test(file.path));
    const bytes = await readFile(join(resources, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    assert.equal(bytes.length, file.size, file.path);
  }
});

test('工作台创作助手默认小汐，移除两个内置选择并支持多项保存切换和删除回退', async t => {
  const app = await fixture(t);
  await app.studio.start();
  const initial = (await app.api('/api/persona')).data;
  assert.equal(initial.activeId, 'xiaoxi');
  assert.deepEqual(initial.personas.map(item => item.id), ['xiaoxi']);
  const create = await app.api('/api/personas', { name: '顾问甲', prompt: '交流简洁，先说明理由。' });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const one = create.data.persona;
  const two = (await app.api('/api/personas', { name: '编辑乙', prompt: '关注叙事细节。' })).data.persona;
  assert.notEqual(one.id, two.id);
  assert.equal((await app.api('/api/persona', { id: one.id })).data.activeId, one.id);
  assert.equal((await app.api('/api/personas', { id: one.id, name: '顾问甲新版', prompt: '保留用户原意。' })).status, 200);
  await app.studio.close();
  await app.studio.start();
  const saved = (await app.api('/api/persona')).data;
  assert.equal(saved.activeId, one.id);
  assert.equal(saved.personas.find(item => item.id === one.id).name, '顾问甲新版');
  assert.equal(saved.personas.find(item => item.id === two.id).prompt, '关注叙事细节。');
  const response = await fetch(app.url + '/card-studio/api/personas', { method: 'DELETE', headers: { origin: app.url, 'content-type': 'application/json' }, body: JSON.stringify({ id: one.id }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).activeId, 'xiaoxi');
  assert.equal((await app.api('/api/persona', { id: 'momo' })).status, 400);
  assert.equal((await app.api('/api/persona', { id: 'xiaoxi' })).data.activeId, 'xiaoxi');
  assert.equal((await app.api('/api/personas', { id: 'neutral', name: '改内置', prompt: '禁止修改内置。' })).status, 400);
});

test('生成中的人设禁止变更，改名和删除后仍保留历史署名', async t => {
  const app = await fixture(t);
  const info = await app.studio.start();
  const item = (await app.api('/api/personas', { name: '历史原名', prompt: '认真讨论创作。' })).data.persona;
  await app.api('/api/persona', { id: item.id });
  await app.api('/api/new', { name: '历史身份' });
  const name = encodeURIComponent('历史身份');
  const conversationId = (await app.api('/api/conversations/' + name)).data.activeId;
  const question = { role: 'user', at: '2026-11-05T00:00:00.000Z', text: '讨论一个故事。', cardName: '历史身份', conversationId, personaId: item.id, personaName: '历史原名' };
  const chatFile = join(info.workspacePath, 'work/agent-chat.jsonl');
  await writeFile(chatFile, JSON.stringify(question) + '\n', 'utf8');
  assert.equal((await app.api('/api/persona', { id: 'neutral' })).status, 409);
  assert.equal((await app.api('/api/personas', { id: item.id, name: '修改失败', prompt: '等待完成。' })).status, 409);
  const remove = (origin = app.url) => fetch(app.url + '/card-studio/api/personas', { method: 'DELETE', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
  assert.equal((await remove()).status, 409);
  assert.equal((await remove('https://example.invalid')).status, 403);
  const direct = await fetch(app.studio.upstreamUrl + '/api/personas', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
  assert.equal(direct.status, 403);
  const answer = { ...question, role: 'agent', at: '2026-11-05T00:00:01.000Z', replyToAt: question.at, text: '这里是历史回复。' };
  await writeFile(chatFile, [question, answer].map(value => JSON.stringify(value)).join('\n') + '\n', 'utf8');
  assert.equal((await app.api('/api/personas', { id: item.id, name: '当前新名', prompt: '已经完成。' })).status, 200);
  const historyPath = '/api/chat/' + name + '?conversationId=' + encodeURIComponent(conversationId);
  assert.equal((await app.api(historyPath)).data.find(value => value.at === answer.at).personaName, '历史原名');
  assert.equal((await remove()).status, 200);
  assert.equal((await app.api(historyPath)).data.find(value => value.at === answer.at).personaName, '历史原名');
});

test('并发启动只产生一个空工作区，首页嵌入宿主且不暴露写入令牌', async t => {
  const app = await fixture(t);
  const starts = await Promise.all([app.studio.start(), app.studio.start()]);
  assert.deepEqual(starts[0], starts[1]);
  assert.deepEqual(starts[0], { url: '/card-studio/', workspacePath: join(app.root, 'card-studio'), version: '0.1.29' });
  assert.deepEqual((await app.api('/api/cards')).data, []);
  assert.deepEqual((await app.api('/api/presets')).data, []);
  assert.deepEqual((await app.api('/api/worldbooks')).data, []);
  assert.equal((await app.api('/api/app-info')).data.version, '0.1.29');
  const response = await fetch(app.url + '/card-studio/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /var API_TOKEN = ["']{2};/);
  assert.match(html, /card-studio/);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(response.headers.get('content-security-policy'), /script-src[^;]*'sha256-/);
  assert.equal((await readFile(join(starts[0].workspacePath, 'tools/card.mjs'), 'utf8')).includes('cmdBuild'), true);
  const config = await app.api('/api/bridge/llm-status');
  assert.equal(config.status, 200);
  assert.equal(config.data.enabled, false);
});

test('真实新建、编辑、世界书检查、生成 PNG/JSON、导入和重启保留正文与草稿', async t => {
  const app = await fixture(t);
  const info = await app.studio.start();
  const name = encodeURIComponent('整合测试');
  assert.equal((await app.api('/api/new', { name: '整合测试' })).status, 200);
  for (const [key, content] of [['description', '她记录日常的星光。'], ['first_mes', '今天也一起写下新的故事吧。']]) {
    assert.equal((await app.api('/api/save/' + name, { kind: 'text', key, content })).status, 200);
  }
  const entry = await app.api('/api/save/' + name, { kind: 'entry-new', book: '世界', content: '天文台在山顶。' });
  assert.equal(entry.status, 200);
  assert.equal((await app.api('/api/save/' + name, {
    kind: 'entry-side', book: '世界', base: entry.data.base, content: 'keys: ["天文台"]\nconstant: false\ninsertion_order: 100\nenabled: true\n',
  })).status, 200);
  const check = await app.api('/api/check/' + name, {});
  assert.deepEqual(check.data.errors, []);
  const built = await app.api('/api/build/' + name, {});
  assert.equal(built.status, 200, JSON.stringify(built.data));
  assert.equal(built.data.artifacts.files.length, 2);
  const jsonResponse = await fetch(app.url + '/card-studio/api/artifact-file/' + name + '?targetType=card&file=json');
  const card = await jsonResponse.json();
  assert.equal(card.data.description, '她记录日常的星光。');
  const pngResponse = await fetch(app.url + '/card-studio/api/artifact-file/' + name + '?targetType=card&file=png');
  const png = Buffer.from(await pngResponse.arrayBuffer());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(pngResponse.headers.get('content-disposition'), /attachment/);
  assert.equal((await app.api('/api/import', { name: '导入副本', fileName: '角色卡.png', base64: png.toString('base64') })).status, 200);
  const key = JSON.stringify(['chat', 'card', '整合测试', '测试对话']);
  assert.equal((await app.api('/api/ui-drafts', { expectedRevision: 0, changes: [{ key, value: { text: '尚未发送的文字' } }] })).status, 200);
  await app.studio.close();
  await app.studio.start();
  assert.equal((await app.api('/api/card/' + name)).data.texts.description, '她记录日常的星光。');
  assert.equal((await app.api('/api/card/' + encodeURIComponent('导入副本'))).data.texts.first_mes, card.data.first_mes + '\n');
  assert.equal((await app.api('/api/ui-drafts')).data.entries[key].value.text, '尚未发送的文字');
  assert.equal(await readFile(join(info.workspacePath, 'cards/整合测试/src/text/description.md'), 'utf8'), card.data.description);
});

test('工作区独占，关闭后可再次取得；自改资源不会被覆盖', async t => {
  const app = await fixture(t);
  const info = await app.studio.start();
  const other = new backend.CardStudio({ dataDir: app.root });
  t.after(() => other.close());
  await assert.rejects(other.start(), /正在使用|已被占用/);
  await app.studio.close();
  const file = join(info.workspacePath, 'templates', 'MVU-schema.md');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original + '\n用户自改参考\n', 'utf8');
  await other.start();
  assert.equal(await readFile(file, 'utf8'), original + '\n用户自改参考\n');
  await other.close();
  await app.studio.start();
  assert.equal((await app.api('/api/cards')).status, 200);
});

test('拒绝跨站、越界路径与超限请求，内部写入令牌由宿主提供', async t => {
  const app = await fixture(t);
  await app.studio.start();
  assert.equal((await app.api('/api/new', { name: '跨站写入' }, { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await app.api('/api/cards', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await app.api('/api/new', { name: '../越界' })).status, 400);
  assert.equal((await app.api('/api/new', { name: '令牌测试' }, { 'x-xiaoxi-token': 'untrusted-client-token' })).status, 200);
  const direct = await fetch(app.studio.upstreamUrl + '/api/new', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '无令牌写入' }),
  });
  assert.equal(direct.status, 403);
  const excessive = await new Promise((resolveRequest, reject) => {
    const req = request(app.url + '/card-studio/api/import', { method: 'POST', headers: { 'content-length': 40 * 1024 * 1024 + 1 } }, response => {
      response.resume(); response.on('end', () => resolveRequest(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(excessive, 413);
  assert.deepEqual((await app.api('/api/cards')).data.map(item => item.name), ['令牌测试']);
});

test('二进制资源完整转发，SSE 立即送达且关闭会结束连接及子服务', async t => {
  const app = await fixture(t);
  await app.studio.start();
  const font = await fetch(app.url + '/card-studio/api/ui-font/regular');
  assert.deepEqual(Buffer.from(await font.arrayBuffer()), await readFile(join(resources, 'assets/fonts/NotoSans-Regular.woff2')));
  await app.api('/api/new', { name: '事件测试' });
  const conversations = (await app.api('/api/conversations/' + encodeURIComponent('事件测试'))).data;
  const abort = new AbortController();
  const stream = await fetch(app.url + '/card-studio/api/chat-events/' + encodeURIComponent('事件测试') + '?conversationId=' + encodeURIComponent(conversations.activeId), { signal: abort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event:/);
  const upstream = app.studio.upstreamUrl;
  abort.abort();
  await app.studio.close();
  await assert.rejects(fetch(upstream + '/api/cards'));
});

test('打开成品目录只交给宿主已验证的工作区内目录', async t => {
  const opened = [];
  const app = await fixture(t, { onOpenArtifacts: directory => { opened.push(directory); } });
  const info = await app.studio.start();
  await app.api('/api/new', { name: '成品目录' });
  for (const key of ['description', 'first_mes']) await app.api('/api/save/' + encodeURIComponent('成品目录'), { kind: 'text', key, content: '测试正文' });
  await app.api('/api/build/' + encodeURIComponent('成品目录'), {});
  assert.equal((await app.api('/api/artifacts-open/' + encodeURIComponent('成品目录'), { targetType: 'card' })).status, 200);
  assert.deepEqual(opened, [join(info.workspacePath, 'dist', '成品目录')]);
});

test('拒绝以 junction 冒充新工作区，外部目录保持为空', async t => {
  const app = await fixture(t);
  const outside = join(app.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(app.root, 'card-studio'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(app.studio.start(), /链接|junction/);
  assert.deepEqual(await readdir(outside), []);
});

test('分块上传仍受大小限制，中断连接不影响后续请求', async t => {
  const app = await fixture(t);
  await app.studio.start();
  const status = await new Promise((resolveRequest, reject) => {
    const req = request(app.url + '/card-studio/api/import', { method: 'POST' }, response => {
      response.resume(); response.once('end', () => resolveRequest(response.statusCode));
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(1024 * 1024, 32);
    let sent = 0;
    const pump = () => {
      while (sent < 41) { sent++; if (!req.write(chunk)) { req.once('drain', pump); return; } }
      req.end();
    };
    pump();
  });
  assert.equal(status, 413);
  await new Promise(resolveAbort => {
    const req = request(app.url + '/card-studio/api/import', { method: 'POST' });
    req.on('error', () => {});
    req.once('close', resolveAbort);
    req.write('{"unfinished":');
    setTimeout(() => req.destroy(), 25);
  });
  assert.equal((await app.api('/api/cards')).status, 200);
});

test('子服务启动失败保留错误并释放锁，恢复资源后可重新启动', async t => {
  const app = await fixture(t);
  const info = await app.studio.start();
  await app.studio.close();
  const runtime = join(info.workspacePath, 'tools/studio.mjs');
  const original = await readFile(runtime);
  await writeFile(runtime, 'throw new Error("隔离启动失败测试");\n', 'utf8');
  await assert.rejects(app.studio.start(), /隔离启动失败测试/);
  await writeFile(runtime, original);
  const other = new backend.CardStudio({ dataDir: app.root });
  t.after(() => other.close());
  await other.start();
  await other.close();
  await Promise.all([app.studio.start(), app.studio.close()]);
  assert.equal(app.studio.upstreamUrl, '');
  await app.studio.start();
  assert.equal((await app.api('/api/cards')).status, 200);
});
