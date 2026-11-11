import test from 'node:test';
import assert from 'node:assert/strict';

const onebotModule = await import('../framework/qq-onebot.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

class Socket extends EventTarget {
  static instances = [];
  static responder = () => undefined;
  constructor(url) { super(); this.url = url; this.readyState = 0; Socket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(payload) { const request = JSON.parse(payload); const response = Socket.responder(request, this); if (response) queueMicrotask(() => this.receive({ echo: request.echo, ...response })); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

function transport(options = {}) {
  assert.equal(typeof onebotModule.OneBotTransport, 'function', '应实现独立 OneBot 协议适配器');
  Socket.instances = [];
  Socket.responder = request => ({ status: 'ok', retcode: 0, data: request.action === 'get_login_info' ? { user_id: '10001', nickname: '角色号' } : request.action === 'get_status' ? { online: true, good: true } : { message_id: '90001' } });
  return new onebotModule.OneBotTransport({ WebSocketImpl: Socket, requestTimeoutMs: 25, connectTimeoutMs: 100, ...options });
}

test('通用 RPC 接受不含 message_id 的状态响应，连接必须验证实际 QQ 身份和在线证据', async t => {
  const client = transport(); t.after(() => client.close());
  await client.connect({ wsUrl: 'ws://127.0.0.1:3001', token: 'private-token', expectedAccountId: '10001' });
  assert.equal(client.state().status, 'verified');
  assert.equal(client.state().selfId, '10001');
  assert.equal((await client.rpc('get_status')).online, true);
  assert.equal(JSON.stringify(client.state()).includes('private-token'), false);
  assert.equal((await client.send({ channel: 'private', peerId: '20001', text: '你好' }, client.state().connectionId)).messageId, '90001');
});

test('身份不符或未在线不能成为可收发通道', async t => {
  const client = transport(); t.after(() => client.close());
  await assert.rejects(client.connect({ wsUrl: 'ws://127.0.0.1:3001', expectedAccountId: '99999' }), /身份/);
  assert.equal(client.state().status, 'identity-mismatch');
  Socket.responder = request => ({ status: 'ok', retcode: 0, data: request.action === 'get_login_info' ? { user_id: '10001' } : { online: false, good: true } });
  await assert.rejects(client.connect({ wsUrl: 'ws://127.0.0.1:3001', expectedAccountId: '10001' }), /在线/);
  assert.notEqual(client.state().status, 'verified');
});

test('发送超时或断线是 unknown，网关明确拒绝是 failed；不自动重发', async t => {
  const client = transport(); t.after(() => client.close());
  await client.connect({ wsUrl: 'ws://127.0.0.1:3001', expectedAccountId: '10001' });
  let sends = 0;
  Socket.responder = () => { sends++; return undefined; };
  await assert.rejects(client.send({ channel: 'private', peerId: '20001', text: '未知' }, client.state().connectionId), error => error.delivery === 'unknown');
  assert.equal(sends, 1);
  Socket.responder = () => ({ status: 'failed', retcode: 1200, data: null });
  await assert.rejects(client.send({ channel: 'private', peerId: '20001', text: '失败' }, client.state().connectionId), error => error.delivery === 'failed');
  Socket.responder = (_request, socket) => { queueMicrotask(() => socket.close()); return undefined; };
  await assert.rejects(client.send({ channel: 'group', peerId: '30001', text: '断线' }, client.state().connectionId), error => error.delivery === 'unknown');
});

test('OneBot 文字标准化保留群发送者，拒绝自发、错号、重放和非文本事件', () => {
  assert.equal(typeof onebotModule.parseOneBotMessage, 'function', '应实现 OneBot 事件标准化');
  const event = { post_type: 'message', self_id: '10001', message_type: 'group', group_id: '30001', user_id: '20001', message_id: '-9', time: 100,
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 晚安 ' } }, { type: 'image', data: { file: 'private' } }] };
  const parsed = onebotModule.parseOneBotMessage(event, { selfId: '10001', receivedAfter: 90_000 });
  assert.equal(parsed.userId, '20001'); assert.equal(parsed.channel, 'group'); assert.equal(parsed.mentioned, true);
  assert.equal(parsed.text, '晚安'); assert.equal(parsed.dedupId, '10001:group:30001:-9');
  assert.equal(onebotModule.parseOneBotMessage({ ...event, user_id: '10001' }), null);
  assert.equal(onebotModule.parseOneBotMessage(event, { selfId: '10002' }), null);
  assert.equal(onebotModule.parseOneBotMessage(event, { receivedAfter: 110_000 }), null);
  assert.equal(onebotModule.parseOneBotMessage({ ...event, post_type: 'message_sent' }), null);
  assert.equal(onebotModule.parseOneBotMessage({ ...event, message: [{ type: 'image', data: {} }] }), null);
});

test('媒体动作转换成实际 OneBot 消息段，不把动作 JSON 或 CQ 指令作为文字发出', async t => {
  const client = transport(); t.after(() => client.close());
  await client.connect({ wsUrl: 'ws://127.0.0.1:3001', expectedAccountId: '10001' });
  let request;
  Socket.responder = value => { request = value; return { status: 'ok', retcode: 0, data: { message_id: '90002' } }; };
  await client.send({ channel: 'private', peerId: '20001', text: '看这里', actions: [
    { type: 'image', url: 'https://example.invalid/image.png' }, { type: 'voice', url: 'https://example.invalid/voice.wav' }, { type: 'face', id: 14 },
  ] }, client.state().connectionId);
  assert.deepEqual(request.params.message, [
    { type: 'text', data: { text: '看这里' } }, { type: 'image', data: { file: 'https://example.invalid/image.png' } },
    { type: 'record', data: { file: 'https://example.invalid/voice.wav' } }, { type: 'face', data: { id: '14' } },
  ]);
  await assert.rejects(client.send({ channel: 'private', peerId: '20001', text: '坏数据', actions: [{ type: 'image', url: 'javascript:alert(1)' }] }, client.state().connectionId), /媒体/);
  await client.send({ channel: 'private', peerId: '20001', text: '', actions: [{ type: 'image', url: 'https://example.invalid/only.png' }] }, client.state().connectionId);
  assert.equal(request.params.message.length, 1); assert.equal(request.params.message[0].type, 'image');
  await assert.rejects(client.send({ channel: 'private', peerId: '20001', text: '', actions: [{ type: 'motion', name: 'Wave' }] }, client.state().connectionId), /内容|媒体/);
});

test('只有启用角色媒体接入时才接收纯图片，保留 URL 给视觉工具而不读取网关本地路径', () => {
  const event = { post_type: 'message', self_id: '10001', message_type: 'private', user_id: '20001', message_id: '2', message: [{ type: 'image', data: { url: 'https://example.invalid/photo.png', file: 'C:\\private.png' } }] };
  assert.equal(onebotModule.parseOneBotMessage(event), null);
  const parsed = onebotModule.parseOneBotMessage(event, { includeMedia: true });
  assert.equal(parsed.text, '[图片]'); assert.deepEqual(parsed.attachments, [{ type: 'image', url: 'https://example.invalid/photo.png' }]);
  assert.equal(onebotModule.parseOneBotMessage({ ...event, message: [{ type: 'image', data: { file: 'C:\\private.png' } }] }, { includeMedia: true }), null);
});
