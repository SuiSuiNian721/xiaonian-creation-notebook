import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ai-future-test-'));
  const app = await createApp({ dataDir, port: 0, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { ...app, dataDir, api: (path, body, method = body === undefined ? 'GET' : 'POST') => api(app.url, path, body, method) };
}

async function api(url, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${url}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  return { status: response.status, ...value };
}

async function httpFixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readJson(req) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); }
async function until(read, predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('等待条件超时');
}

// 仅在测试进程内模拟 OneBot 正向 WebSocket，不连接用户现有 QQ。
async function oneBotFixture(t, onAction) {
  const sockets = new Set();
  const actions = [];
  let active;
  const server = createServer();
  function send(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
    active.write(Buffer.concat([header, bytes]));
  }
  server.on('upgrade', (req, socket) => {
    active = socket; sockets.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffer[1] & 128);
        const needed = offset + (masked ? 4 : 0) + length;
        if (buffer.length < needed) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), needed));
        buffer = buffer.subarray(needed);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;
        const action = JSON.parse(payload.toString()); actions.push(action);
        const result = onAction?.(action) ?? { status: 'ok', retcode: 0, data: { message_id: 123 } };
        send({ ...result, echo: action.echo });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}`, send, actions };
}

test('默认只提供一个可编辑角色，离线回复明确标识，独立会话互不污染', async t => {
  const app = await fixture(t);
  const initial = await app.api('/api/state');
  assert.equal(initial.character.name, '林小璃');
  assert.equal(initial.status.qq, 'disconnected');
  assert.equal(initial.status.model, 'offline');
  const a = (await app.api('/api/conversations', { title: 'A' })).conversation;
  const b = (await app.api('/api/conversations', { title: 'B' })).conversation;
  const reply = await app.api('/api/chat', { conversationId: a.id, text: '今天想散步' });
  assert.equal(reply.mode, 'demo');
  assert.match(reply.conversation.messages[1].content, /离线演示/);
  assert.equal(reply.conversation.messages[1].mode, 'demo');
  const state = await app.api('/api/state');
  assert.equal(state.conversations.find(c => c.id === b.id).messages.length, 0);
  const edited = await app.api('/api/character', { name: '小璃', description: '细心的伙伴', systemPrompt: '自然、坦诚地交流。' });
  assert.equal(edited.character.name, '小璃');
  assert.equal((await app.api('/api/health')).ok, true);
});

test('SQLite 保存历史与显式记忆，忘记后重启仍生效，不同数据目录隔离', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const conversation = (await first.api('/api/conversations', { title: '持久化' })).conversation;
  await first.api('/api/chat', { conversationId: conversation.id, text: '你好' });
  const memory = (await first.api('/api/memories', { content: '喜欢清晨散步', conversationId: conversation.id })).memory;
  await first.close();
  const resumed = await createApp({ dataDir: first.dataDir, port: 0 });
  t.after(() => resumed.close());
  const state = (await api(resumed.url, '/api/state'));
  assert.equal(state.conversations[0].messages.length, 2);
  assert.equal(state.memories[0].id, memory.id);
  assert.equal((await second.api('/api/state')).memories.length, 0);
  assert.equal((await api(resumed.url, `/api/memories/${memory.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await api(resumed.url, '/api/state')).memories.length, 0);
  assert.equal((await api(resumed.url, `/api/memories/${memory.id}`, undefined, 'DELETE')).status, 404);
  await resumed.close();
});

test('配置密钥从不回传，空值保留且可清除，失败配置不覆盖原配置', async t => {
  const app = await fixture(t);
  const saved = await app.api('/api/config', { llm: { baseUrl: 'https://example.com/v1', model: 'example', apiKey: 'secret-llm' }, tts: { apiKey: 'secret-tts' }, qq: { token: 'secret-qq', privateAllow: ['42'] } });
  assert.equal(saved.config.llm.hasKey, true);
  assert.equal(saved.config.qq.hasToken, true);
  assert.doesNotMatch(JSON.stringify(await app.api('/api/state')), /secret-/);
  assert.equal((await app.api('/api/config', { llm: { apiKey: '' } })).config.llm.hasKey, true);
  assert.equal((await app.api('/api/config', { llm: { clearKey: true } })).config.llm.hasKey, false);
  assert.equal((await app.api('/api/config', { qq: { wsUrl: 'file:///bad' } })).status, 400);
  assert.deepEqual((await app.api('/api/state')).config.qq.privateAllow, ['42']);
});

test('真实模型接口接收人设、显式记忆和本会话历史；同会话请求串行', async t => {
  const calls = [];
  const modelUrl = await httpFixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer local-key');
    const value = await readJson(req); calls.push(value);
    await new Promise(resolve => setTimeout(resolve, 20));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: `回复${calls.length}` } }] }));
  });
  const app = await fixture(t);
  await app.api('/api/config', { llm: { baseUrl: `${modelUrl}/v1`, model: 'test-model', apiKey: 'local-key' } });
  const c = (await app.api('/api/conversations', { title: '模型会话' })).conversation;
  await app.api('/api/memories', { content: '喜欢花茶' });
  const results = await Promise.all(['一', '二'].map(text => app.api('/api/chat', { conversationId: c.id, text })));
  assert.ok(results.every(result => result.mode === 'model'));
  assert.equal(calls[0].stream, false);
  assert.equal(calls[0].model, 'test-model');
  assert.match(calls[0].messages[0].content, /林小璃/);
  assert.match(calls[0].messages[0].content, /喜欢花茶/);
  assert.deepEqual(calls[1].messages.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
  const state = await app.api('/api/state');
  assert.deepEqual(state.conversations[0].messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('模型失败返回错误，不冒充演示成功；TTS 只生成并保存音频', async t => {
  let speechRequest;
  const provider = await httpFixture(t, async (req, res) => {
    if (req.url.endsWith('/chat/completions')) { res.statusCode = 503; res.end('upstream unavailable'); return; }
    speechRequest = await readJson(req);
    res.setHeader('content-type', 'audio/wav');
    res.end(Buffer.from('RIFF-test-audio'));
  });
  const app = await fixture(t);
  const c = (await app.api('/api/conversations', {})).conversation;
  const demo = await app.api('/api/chat', { conversationId: c.id, text: '想喝茶' });
  await app.api('/api/config', { llm: { baseUrl: `${provider}/v1`, model: 'broken' }, tts: { baseUrl: `${provider}/v1`, model: 'tts-1', voice: 'alloy' } });
  assert.equal((await app.api('/api/chat', { conversationId: c.id, text: '模型失败测试' })).status, 502);
  const state = await app.api('/api/state');
  assert.equal(state.conversations[0].messages.filter(m => m.role === 'assistant').length, 1);
  const speech = await app.api('/api/speech', { conversationId: c.id, messageId: demo.conversation.messages[1].id });
  assert.equal(speech.status, 200);
  assert.equal(speechRequest.voice, 'alloy');
  assert.equal(speechRequest.response_format, 'wav');
  const response = await fetch(`${app.url}${speech.audioUrl}`);
  assert.match(response.headers.get('content-type'), /^audio\/wav/);
  assert.equal(await response.text(), 'RIFF-test-audio');
  assert.equal((await app.api('/api/state')).conversations[0].messages[1].audioUrl, speech.audioUrl);
});

test('QQ 沙盒遵守名单及@规则，连接后仍绝不向 OneBot 发送', async t => {
  const bot = await oneBotFixture(t);
  const app = await fixture(t);
  await app.api('/api/config', { qq: { wsUrl: bot.url, privateAllow: ['42'], groupAllow: ['100'], requireMention: true } });
  assert.equal((await app.api('/api/qq/connect', {})).status, 200);
  const ignored = await app.api('/api/qq/simulate', { channel: 'qq-private', peerId: '99', text: '你好' });
  assert.equal(ignored.accepted, false);
  assert.equal((await app.api('/api/qq/simulate', { channel: 'qq-group', peerId: '100', text: '你好', mentioned: false })).accepted, false);
  const accepted = await app.api('/api/qq/simulate', { channel: 'qq-group', peerId: '100', text: '你好', mentioned: true });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.conversation.sandbox, true);
  assert.equal(accepted.conversation.messages[1].delivery, 'simulated');
  assert.equal(bot.actions.length, 0);
  await app.api('/api/qq/disconnect', {});
  assert.equal((await app.api('/api/state')).status.qq, 'disconnected');
});

test('真实 QQ 消息去重；OneBot 拒绝发送时保留 failed 状态，不显示 sent', async t => {
  const bot = await oneBotFixture(t, () => ({ status: 'failed', retcode: 1200, wording: 'denied' }));
  const app = await fixture(t);
  await app.api('/api/config', { qq: { wsUrl: bot.url, privateAllow: ['42'] } });
  await app.api('/api/qq/connect', {});
  const event = { post_type: 'message', message_type: 'private', self_id: 7, user_id: 42, message_id: 9001, message: [{ type: 'text', data: { text: '你好' } }] };
  bot.send(event); bot.send(event);
  const state = await until(() => app.api('/api/state'), s => s.conversations[0]?.messages.some(m => m.delivery === 'failed'));
  assert.equal(state.conversations[0].messages.length, 2);
  assert.equal(bot.actions.length, 1);
  assert.equal(bot.actions[0].action, 'send_private_msg');
  assert.equal(bot.actions[0].params.message[0].type, 'text');
  assert.equal(state.conversations[0].messages[1].delivery, 'failed');
  assert.ok(state.events.some(e => e.level === 'error'));
});

test('服务仅绑定 loopback，拒绝异源、伪造 Host、过大正文和非法输入', async t => {
  const app = await fixture(t);
  await assert.rejects(createApp({ dataDir: app.dataDir, host: '0.0.0.0', port: 0 }), /回环/);
  const foreign = await fetch(`${app.url}/api/config`, { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${app.url}/api/state`, { headers: { host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await app.api('/api/chat', { conversationId: 'missing', text: 'hello' })).status, 404);
  assert.equal((await app.api('/api/conversations', { channel: 'other' })).status, 400);
  assert.equal((await app.api('/api/memories', { content: '' })).status, 400);
  const large = await fetch(`${app.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(100_000) }) });
  assert.equal(large.status, 413);
  assert.equal((await fetch(`${app.url}/%2e%2e%5cPRODUCT.md`)).status, 400);
});

test('兼容的非流式 completion 使用统一人设与全局记忆，并标注离线模式', async t => {
  const app = await fixture(t);
  await app.api('/api/character', { name: '璃', description: '爱好花茶', systemPrompt: '亲切地交流。' });
  await app.api('/api/memories', { content: '周末想去公园' });
  const result = await app.api('/v1/chat/completions', { messages: [{ role: 'user', content: '早上好' }], stream: false });
  assert.equal(result.status, 200);
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.mode, 'demo');
  assert.match(result.choices[0].message.content, /璃/);
  assert.equal((await app.api('/v1/chat/completions', { messages: [{ role: 'user', content: '早上好' }], stream: true })).status, 400);
  const calls = [];
  const provider = await httpFixture(t, async (req, res) => { calls.push(await readJson(req)); res.end(JSON.stringify({ choices: [{ message: { content: '好的，周末去公园。' } }] })); });
  await app.api('/api/config', { llm: { baseUrl: `${provider}/v1`, model: 'local-test' } });
  const generated = await app.api('/v1/chat/completions', { messages: [{ role: 'user', content: '我们周末去哪里？' }] });
  assert.equal(generated.mode, 'model');
  assert.match(calls[0].messages[0].content, /璃/);
  assert.match(calls[0].messages[0].content, /周末想去公园/);
  assert.equal(calls[0].stream, false);
});

test('分块上传超过限制时仍返回明确的 JSON 错误', async t => {
  const app = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const req = request(`${app.url}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write('{"x":"'); req.write('a'.repeat(100_000)); req.end('"}');
  });
  assert.equal(response.status, 413);
  assert.match(response.value.error, /64 KiB/);
});

test('群聊保留发言者，只响应@自己，不附带私聊专属记忆，成功发送需OneBot确认', async t => {
  const calls = [];
  const provider = await httpFixture(t, async (req, res) => { calls.push(await readJson(req)); res.end(JSON.stringify({ choices: [{ message: { content: '大家好。' } }] })); });
  const bot = await oneBotFixture(t);
  const app = await fixture(t);
  await app.api('/api/config', { llm: { baseUrl: `${provider}/v1`, model: 'test' }, qq: { wsUrl: bot.url, groupAllow: ['100'], privateAllow: ['42'] } });
  const privateConversation = (await app.api('/api/conversations', { channel: 'qq-private', peerId: '42' })).conversation;
  await app.api('/api/memories', { content: '只属于私聊的内容', conversationId: privateConversation.id });
  const sandbox = await app.api('/api/qq/simulate', { channel: 'qq-group', peerId: '100', userId: '42', text: '你好', mentioned: true });
  assert.match(sandbox.conversation.messages[0].content, /群成员 42/);
  assert.doesNotMatch(calls[0].messages[0].content, /只属于私聊的内容/);
  await app.api('/api/qq/connect', {});
  const base = { post_type: 'message', message_type: 'group', self_id: 7, user_id: 43, group_id: 100 };
  bot.send({ ...base, message_id: 8100, message: [{ type: 'at', data: { qq: '8' } }, { type: 'text', data: { text: '不要回答' } }] });
  bot.send({ ...base, message_id: 8101, message: [{ type: 'at', data: { qq: '7' } }, { type: 'text', data: { text: '回答这一条' } }] });
  const state = await until(() => app.api('/api/state'), s => s.conversations.some(c => !c.sandbox && c.channel === 'qq-group' && c.messages.some(m => m.delivery === 'sent')));
  const live = state.conversations.find(c => !c.sandbox && c.channel === 'qq-group');
  assert.equal(live.messages.length, 2);
  assert.match(live.messages[0].content, /群成员 43/);
  assert.equal(bot.actions.length, 1);
  assert.equal(bot.actions[0].action, 'send_group_msg');
  assert.doesNotMatch(calls[1].messages[0].content, /只属于私聊的内容/);
});

test('生成期间重连后，不把旧QQ连接的回复发送到新连接', async t => {
  let release;
  let started = false;
  const ready = new Promise(resolve => { release = resolve; });
  const provider = await httpFixture(t, async (req, res) => { await readJson(req); started = true; await ready; res.end(JSON.stringify({ choices: [{ message: { content: '稍等后生成的回复' } }] })); });
  const bot = await oneBotFixture(t);
  const app = await fixture(t);
  await app.api('/api/config', { llm: { baseUrl: `${provider}/v1`, model: 'slow' }, qq: { wsUrl: bot.url, privateAllow: ['42'] } });
  await app.api('/api/qq/connect', {});
  bot.send({ post_type: 'message', message_type: 'private', self_id: 7, user_id: 42, message_id: 9901, message: '你好' });
  await until(async () => started, value => value);
  await app.api('/api/qq/disconnect', {});
  await app.api('/api/qq/connect', {});
  release();
  const state = await until(() => app.api('/api/state'), s => s.conversations[0]?.messages.length === 2 && s.conversations[0].messages[1].delivery !== 'sending');
  assert.equal(state.conversations[0].messages[1].delivery, 'failed');
  assert.equal(bot.actions.length, 0);
});

test('OneBot 发送 null、数组或标量时忽略无效事件，继续处理正常消息', async t => {
  const bot = await oneBotFixture(t);
  const app = await fixture(t);
  await app.api('/api/config', { qq: { wsUrl: bot.url, privateAllow: ['42'] } });
  await app.api('/api/qq/connect', {});
  for (const invalid of [null, [], 42, 'invalid', false]) bot.send(invalid);
  bot.send({ post_type: 'message', message_type: 'private', self_id: 7, user_id: 42, message_id: 9902, message: '正常消息' });
  const state = await until(() => app.api('/api/state'), s => s.conversations[0]?.messages[1]?.delivery === 'sent');
  assert.equal(bot.actions.length, 1);
  assert.ok(state.events.some(event => event.level === 'warning' && /忽略/.test(event.message)));
});

test('生成期间移出QQ允许名单后，回复标为失败且不再外发', async t => {
  for (const channel of ['private', 'group']) {
    await t.test(channel, async t => {
      let release;
      let started = false;
      const ready = new Promise(resolve => { release = resolve; });
      const provider = await httpFixture(t, async (req, res) => { await readJson(req); started = true; await ready; res.end(JSON.stringify({ choices: [{ message: { content: '等待生成的回复' } }] })); });
      const bot = await oneBotFixture(t);
      const app = await fixture(t);
      await app.api('/api/config', { llm: { baseUrl: `${provider}/v1`, model: 'slow' }, qq: { wsUrl: bot.url, privateAllow: ['42'], groupAllow: ['100'] } });
      await app.api('/api/qq/connect', {});
      bot.send({ post_type: 'message', message_type: channel, self_id: 7, user_id: 42, group_id: 100, message_id: 9903, message: [{ type: 'at', data: { qq: '7' } }, { type: 'text', data: { text: '你好' } }] });
      await until(async () => started, value => value);
      await app.api('/api/config', { qq: channel === 'private' ? { privateAllow: [] } : { groupAllow: [] } });
      release();
      const state = await until(() => app.api('/api/state'), s => s.conversations[0]?.messages.length === 2 && s.conversations[0].messages[1].delivery !== 'sending');
      assert.equal(state.status.qq, 'connected');
      assert.equal(state.conversations[0].messages[1].delivery, 'failed');
      assert.equal(bot.actions.length, 0);
      assert.ok(state.events.some(event => event.level === 'error' && /当前规则已不再允许/.test(event.message)));
    });
  }
});
