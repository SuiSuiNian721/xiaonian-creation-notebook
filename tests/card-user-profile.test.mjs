import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { CardStudio } from '../framework/card-studio.mjs';
import * as profiles from '../integrations/xiaoxi/tools/user-profile.mjs';
import { readPersonaPrompt } from '../integrations/xiaoxi/tools/personas.mjs';
import { createCodexBridge } from '../integrations/xiaoxi/tools/codex-bridge.mjs';
import { embedStudioHtml } from '../framework/card-studio-embed.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWl8AAAAASUVORK5CYII=';
const profile = { displayName: '念念', avatar: PNG, identity: '独立故事创作者', preferences: '用具体例子回答' };

function temporary(t, registerCleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-user-profile-'));
  if (registerCleanup) t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('工作台资料覆盖只在内存生效，明确清空后不恢复旧姓名，也不从聊天猜写用户设置', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'work'));
  const file = path.join(root, 'work', 'user-profile.json');
  fs.writeFileSync(file, JSON.stringify({ displayName: '原应用姓名', confirmed: true }));
  const original = fs.readFileSync(file);
  assert.equal(typeof profiles.setWorkbenchUserProfile, 'function');
  profiles.setWorkbenchUserProfile(root, profile);
  assert.equal(profiles.readUserProfile(root).displayName, '念念');
  assert.equal(profiles.rememberDisplayName(root, '我叫另一位').displayName, '念念');
  profiles.setWorkbenchUserProfile(root, {});
  assert.equal(profiles.readUserProfile(root).displayName, '');
  assert.deepEqual(fs.readFileSync(file), original);
});

test('统一文字资料进入 Codex 完整及续接提示，头像不进入模型', async t => {
  const root = temporary(t);
  for (const directory of ['work', 'workflow', 'cards/测试卡/src']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'workflow', '小汐.md'), '林小汐，称呼 {{user}}。');
  fs.writeFileSync(path.join(root, 'workflow', '助手共用规则.md'), '先确认草稿再写入。');
  assert.equal(typeof profiles.setWorkbenchUserProfile, 'function');
  profiles.setWorkbenchUserProfile(root, profile);
  const requests = [], failures = [];
  const bridge = createCodexBridge({ root, getStatus: async () => ({ authenticated: true, authMethod: 'ChatGPT' }), getChildEnv: async () => ({}),
    runTurn: async request => { requests.push(request); return { completed: true, ephemeral: true, text: '已收到' }; },
    onReply: async () => {}, onFailure: async (card, error) => failures.push(error) });
  t.after(() => bridge.stop());
  bridge.enable();
  await bridge.enqueue('测试卡', '开始创作', '', 'main', '', false, 'xiaoxi');
  assert.deepEqual(failures, []);
  assert.equal(requests.length, 1);
  for (const value of [profile.displayName, profile.identity, profile.preferences]) assert.ok(requests[0].prompt.includes(value));
  assert.ok(!requests[0].prompt.includes(PNG));
  const source = fs.readFileSync(new URL('../integrations/xiaoxi/tools/codex-bridge.mjs', import.meta.url), 'utf8');
  const builder = source.slice(source.indexOf('function personaPrompt('), source.indexOf('\nasync function terminateCodexProcess'));
  const sandbox = vm.createContext({ readUserProfile: profiles.readUserProfile, userProfileText: profiles.userProfileText,
    readPersonaPrompt, process, conversationPrompt: () => '', writeIntentPrompt: () => '' });
  new vm.Script(builder + '\nglobalThis.build = personaPrompt;').runInContext(sandbox);
  profiles.setWorkbenchUserProfile(root, { ...profile, preferences: '最新偏好：简洁回答' });
  const incremental = sandbox.build(root, '测试卡', '继续', '', true, false, readPersonaPrompt(root, 'xiaoxi'), 'main', '', false, '', null, true);
  assert.match(incremental, /最新偏好：简洁回答/);
  assert.ok(!incremental.includes(PNG));
});

test('宿主每次请求同步统一资料；角色列表移除两项，原本地用户资料仍保留', async t => {
  const root = temporary(t, false);
  let current = profile;
  const studio = new CardStudio({ dataDir: root, userProfile: () => current });
  const server = createServer((req, res) => void studio.proxy(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await studio.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const api = async (route, value) => {
    const response = await fetch(url + '/card-studio' + route, { method: value === undefined ? 'GET' : 'POST',
      headers: { origin: url, 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, data: await response.json() };
  };
  const info = await studio.start();
  const file = path.join(info.workspacePath, 'work/user-profile.json');
  fs.writeFileSync(file, JSON.stringify({ displayName: '旧姓名', confirmed: true }));
  const original = fs.readFileSync(file);
  let avatars = (await api('/api/chat-avatars')).data;
  assert.match(avatars.user.url, /^\/api\/chat-avatar\/user\?v=[a-f0-9]+$/);
  assert.ok(JSON.stringify(avatars.user).length < 180, '头像映射不携带图片正文，避免每条消息签名重复序列化大图');
  assert.equal(avatars.user.name, '念念');
  const userImage = await fetch(url + '/card-studio' + avatars.user.url);
  assert.equal(userImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await userImage.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.equal((await api('/api/chat-avatar/user', { mimeType: 'image/png', base64: PNG.split(',')[1] })).status, 400);
  assert.equal((await api('/api/chat-avatar/xiaoxi', { mimeType: 'image/png', base64: PNG.split(',')[1] })).status, 200);
  const xiaoxiImage = await fetch(url + '/card-studio/api/chat-avatar/xiaoxi');
  assert.equal(xiaoxiImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await xiaoxiImage.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  const personas = (await api('/api/persona')).data;
  assert.equal(personas.activeId, 'xiaoxi');
  assert.deepEqual(personas.personas.map(item => item.id), ['xiaoxi']);
  assert.equal((await api('/api/persona', { id: 'neutral' })).status, 400);
  fs.writeFileSync(path.join(info.workspacePath, 'work/persona-selection.json'), JSON.stringify({ activeId: 'momo' }));
  assert.equal((await api('/api/persona')).data.activeId, 'xiaoxi');
  const requests = [];
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '已收到统一用户资料。' } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  assert.equal((await api('/api/bridge/llm-config', { enabled: true, backend: 'openai', baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1', model: 'fixture' })).status, 200);
  assert.equal((await api('/api/new', { name: '统一资料' })).status, 200);
  const card = encodeURIComponent('统一资料');
  const conversationId = (await api('/api/conversations/' + card)).data.activeId;
  async function send(text) {
    const before = requests.length;
    assert.equal((await api('/api/chat/' + card, { text, targetType: 'card', conversationId })).status, 200);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (requests.length > before && !(await api('/api/bridge/pending')).data.pending.length) return requests.at(-1).messages[0].content;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('OpenAI 隔离端点未收到或未完成本轮请求');
  }
  const firstPrompt = await send('我叫不应自动保存的名字');
  for (const value of [profile.displayName, profile.identity, profile.preferences]) assert.ok(firstPrompt.includes(value));
  assert.ok(!firstPrompt.includes(PNG));
  current = { ...profile, displayName: '新姓名', identity: '最新身份', preferences: '最新偏好' };
  const secondPrompt = await send('继续讨论');
  for (const value of [current.displayName, current.identity, current.preferences]) assert.ok(secondPrompt.includes(value));
  assert.ok(!secondPrompt.includes(profile.identity));
  assert.ok(!secondPrompt.includes(PNG));
  current = { displayName: '', avatar: '', identity: '', preferences: '' };
  avatars = (await api('/api/chat-avatars')).data;
  assert.equal(avatars.user.url, '');
  assert.equal(avatars.user.name, '');
  assert.deepEqual(fs.readFileSync(file), original);
});

test('嵌入式用户头像设置使用工作台全局接口，角色头像仍从实例读取', async () => {
  const embedded = embedStudioHtml('<html><head></head><body></body></html>', '/instances/cards-1/card-studio');
  const script = [...embedded.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const listeners = new Map(), requests = [], apiCalls = [];
  const mapping = { user: { url: PNG, name: '念念', label: '念' }, xiaoxi: { url: '/instances/cards-1/card-studio/api/chat-avatar/xiaoxi', label: '汐' } };
  const parentDocument = { documentElement: { dataset: {} }, querySelector: () => null };
  const parent = { document: parentDocument, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name),
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: event => listeners.get(event.type)?.(event),
    fetch: async (url, options) => { requests.push({ url, ...options }); return Response.json({ profile }); } };
  const sandbox = vm.createContext({ window: { parent, addEventListener() {} }, document: { addEventListener() {},
    documentElement: { classList: { toggle() {} }, style: { setProperty() {} } } },
    MutationObserver: class { observe() {} }, el: () => ({}), state: { name: '' }, log: () => {},
    api: async (method, route) => { apiCalls.push([method, route]); return mapping; }, chatAvatars: {} });
  new vm.Script(script).runInContext(sandbox);
  const result = await sandbox.window.__workbenchSaveUserAvatar({ mimeType: 'image/png', base64: PNG.split(',')[1] });
  assert.equal(requests[0].url, '/api/user-profile');
  assert.deepEqual(JSON.parse(requests[0].body), { avatar: PNG });
  assert.equal(result.xiaoxi.url, mapping.xiaoxi.url);
  assert.ok(apiCalls.every(([method, route]) => method === 'GET' && route === '/api/chat-avatars'));
  await sandbox.window.__workbenchSaveUserAvatar({ reset: true });
  assert.deepEqual(JSON.parse(requests[1].body), { avatar: '' });
});

test('实例代理已添加实例前缀时，头像仍指向当前写卡器而不是工作台 API', async () => {
  const prefix = '/instances/cards-1/card-studio';
  const embedded = embedStudioHtml('<html><head></head><body></body></html>', prefix);
  const script = [...embedded.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
  const mapping = { user: { url: '/instances/cards-1/api/chat-avatar/user?v=a' },
    xiaoxi: { url: '/api/chat-avatar/xiaoxi?v=b' }, custom: { url: prefix + '/api/chat-avatar/custom?v=c' } };
  const sandbox = vm.createContext({ window: { fetch: async () => Response.json(mapping), EventSource: class {} } });
  new vm.Script(script).runInContext(sandbox);
  const response = await sandbox.window.fetch(prefix + '/api/chat-avatars');
  const value = await response.json();
  assert.equal(value.user.url, prefix + '/api/chat-avatar/user?v=a');
  assert.equal(value.xiaoxi.url, prefix + '/api/chat-avatar/xiaoxi?v=b');
  assert.equal(value.custom.url, prefix + '/api/chat-avatar/custom?v=c');
});
