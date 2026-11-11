import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { QQController } from '../framework/qq.mjs';
import { CharacterLife } from '../framework/character-life/service.mjs';

const voiceId = 'xiaoli-warm-bright';
const audio = { type: 'record', voiceId, profileSha256: 'fixed-profile', referenceSha256: 'fixed-reference', url: 'http://127.0.0.1/internal/voice-audio/complete/signed' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function until(predicate) {
  for (let attempts = 0; !predicate(); attempts++) {
    assert.ok(attempts < 150, '本地异步流程没有完成');
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function fixture(t, { sharedVoice = async () => audio, answer = async () => ({ text: '念念，我在。' }), options = {}, voiceMode='always' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-shared-voice-'));
  const characters = new Map(['xiaoli', 'momo'].map((id, index) => [id, { id, revision: index + 1, name: id, raw: { name: id, description: '角色设定' } }]));
  const store = { character: id => characters.get(id), requireCharacter: id => characters.get(id) };
  const calls = [], voices = [], requests = [], sends = [];
  class Socket extends EventTarget {
    constructor() { super(); this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(payload) {
      const request = JSON.parse(payload); requests.push(request);
      let data;
      if (request.action === 'get_login_info') data = { user_id: '10001', nickname: '本地模拟' };
      else if (request.action === 'get_status') data = { online: true, good: true };
      else { sends.push(request); data = { message_id: String(90000 + sends.length) }; }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data }) })));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const sharedAI = { complete: async (messages, configuration) => { calls.push({ messages, configuration }); return answer(messages, configuration); } };
  const life = new CharacterLife({ store, dataDir: directory, sharedAI, sharedVoice: async value => { voices.push(value); return sharedVoice(value); } });
  life.configure('xiaoli', { mode: 'lite', memory: { autoExtract: false }, media: { voiceEnabled: true, voiceId, voiceMode } });
  const qq = new QQController({ store, dataDir: directory, sharedAI, life,
    runtime: { connection: () => ({ wsUrl: 'ws://127.0.0.1:3001', expectedAccountId: '10001' }) },
    onebotOptions: { WebSocketImpl: Socket, heartbeatIntervalMs: 0, minSendIntervalMs: 0, ...options } });
  t.after(async () => {
    await qq.close(); await life.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  qq.bind({ characterId: 'xiaoli' });
  qq.saveRules({ privateAllow: ['20001'], groupAllow: [], requireMention: true });
  await qq.connect(); qq.start();
  let sequence = 0;
  return { qq, life, calls, voices, sends, requests,
    receive: (text = '你好') => qq.receive({ post_type: 'message', self_id: '10001', message_type: 'private', user_id: '20001', message_id: String(++sequence), message: text }),
  };
}

test('QQ 精简模式的共享音色经真实 OneBot 适配器发成 record，确认后保留文字历史', async t => {
  const f = await fixture(t);
  const result = await f.receive();
  assert.equal(result.reply.status, 'confirmed');
  assert.deepEqual(f.sends[0].params.message, [
    { type: 'text', data: { text: '念念，我在。' } },
    { type: 'record', data: { file: audio.url } },
  ]);
  assert.equal(f.voices[0].voiceId, voiceId);
  assert.equal(f.voices[0].moduleId, 'qq');
  assert.equal(f.voices[0].characterId, 'xiaoli');
  assert.equal(f.qq.messages(result.conversationId).messages.at(-1).content, '念念，我在。');
});

test('QQ 按要求模式只为当前明确语音请求附加 record，模型获得能力说明',async t=>{
  const f=await fixture(t,{voiceMode:'requested'});
  for(const input of ['你好','测试：回复一条语音','不要发语音','接着聊吧'])assert.equal((await f.receive(input)).reply.status,'confirmed');
  assert.equal(f.voices.length,1);
  assert.deepEqual(f.sends.map(request=>request.params.message.map(segment=>segment.type)),[['text'],['text','record'],['text'],['text']]);
  assert.match(f.calls[0].messages.map(message=>message.content).join('\n'),/共享音色/);
});

test('精简模式仅放行本轮共享音频，不放行主动消息携带的旧 record', async t => {
  const f = await fixture(t), first = await f.receive();
  const result = await f.qq.deliver({ characterId: 'xiaoli', conversationId: first.conversationId, text: '主动文字', sourceId: 'old-record',
    actions: [{ ...audio, url: 'http://127.0.0.1/old.wav' }, { type: 'image', url: 'https://example.invalid/old.png' }] });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(f.sends.at(-1).params.message, [
    { type: 'text', data: { text: '主动文字' } }, { type: 'record', data: { file: audio.url } },
  ]);
});

test('QQ 预演不调用共享声音，也不产生 OneBot 发送', async t => {
  const f = await fixture(t);
  const result = await f.qq.simulate({ channel: 'private', peerId: '20001', userId: '20001', text: '预演' });
  assert.equal(result.reply.status, 'simulated');
  assert.equal(f.voices.length, 0); assert.equal(f.sends.length, 0);
});

test('共享声音迟到时，配置变更、旧角色、取消和失效路由仍不能外发', async t => {
  for (const action of ['settings', 'bind', 'pause', 'rules', 'disconnect', 'story']) await t.test(action, async t => {
    const voice = deferred(), f = await fixture(t, { sharedVoice: () => voice.promise });
    const pending = f.receive(); await until(() => f.voices.length === 1);
    if (action === 'settings') f.life.configure('xiaoli', { media: { voiceEnabled: false } });
    if (action === 'bind') f.qq.bind({ characterId: 'momo' });
    if (action === 'pause') f.qq.pause();
    if (action === 'rules') f.qq.saveRules({ privateAllow: [], groupAllow: [], requireMention: true });
    if (action === 'disconnect') await f.qq.disconnect();
    if (action === 'story') f.qq.newStory(f.qq.conversations().conversations[0].id);
    voice.resolve(audio); const result = await pending;
    assert.equal(result.reply.status, 'failed'); assert.equal(f.sends.length, 0);
  });
});

test('语音完成后等待发送锁时变更配置，只发送文字而丢弃旧音频', async t => {
  const f = await fixture(t), waiting = deferred(), release = deferred();
  f.qq.acquireSend = async () => { waiting.resolve(); await release.promise; return () => {}; };
  const pending = f.receive(); await waiting.promise;
  f.life.configure('xiaoli', { media: { voiceEnabled: false } }); release.resolve();
  assert.equal((await pending).reply.status, 'confirmed');
  assert.deepEqual(f.sends[0].params.message, [{ type: 'text', data: { text: '念念，我在。' } }]);
});

test('共享语音可等待近 900 秒，文字超时和回复年龄不会提前截断', async t => {
  const voice = deferred(); t.after(() => voice.resolve(audio));
  const f = await fixture(t, { sharedVoice: () => voice.promise });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = f.receive(); await until(() => f.voices.length === 1);
  t.mock.timers.tick(899_000);
  assert.equal(f.voices[0].signal.aborted, false);
  voice.resolve(audio); const result = await pending;
  assert.equal(result.reply.status, 'confirmed'); assert.equal(f.sends[0].params.message.at(-1).type, 'record');
});

test('共享语音拥有有界独立预算，超时取消且迟到结果不发送', async t => {
  const voice = deferred(); t.after(() => voice.resolve(audio));
  const f = await fixture(t, { sharedVoice: () => voice.promise, options: { generationTimeoutMs: 100, maxReplyAgeMs: 100, voiceTimeoutMs: 500 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = f.receive(); await until(() => f.voices.length === 1);
  t.mock.timers.tick(499); assert.equal(f.voices[0].signal.aborted, false);
  t.mock.timers.tick(2); const result = await pending;
  assert.equal(result.reply.status, 'failed'); assert.match(result.reply.error, /语音.*超时/);
  assert.equal(f.voices[0].signal.aborted, true);
  voice.resolve(audio); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.sends.length, 0);
});

test('等待语音前的慢文字仍受原生成预算约束', async t => {
  const answer = deferred(), f = await fixture(t, { answer: () => answer.promise, options: { generationTimeoutMs: 100 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = f.receive(); await until(() => f.calls.length === 1);
  t.mock.timers.tick(101); const result = await pending;
  assert.equal(result.reply.status, 'failed'); assert.match(result.reply.error, /生成.*超时/);
  answer.resolve({ text: '迟到文字' }); assert.equal(f.voices.length, 0); assert.equal(f.sends.length, 0);
});

test('语音等待不延长旧队列的 TTL', async t => {
  const voice = deferred(), f = await fixture(t, { sharedVoice: () => voice.promise, options: { maxConcurrent: 1, queueTtlMs: 100, generationTimeoutMs: 100 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const first = f.receive('第一句'); await until(() => f.voices.length === 1);
  const second = f.receive('排队句'); t.mock.timers.tick(500);
  voice.resolve(audio); assert.equal((await first).reply.status, 'confirmed');
  const result = await second;
  assert.equal(result.reply.status, 'failed'); assert.match(result.reply.error, /队列/);
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
});

test('语音之后恢复剩余文字预算，等待发送锁也不能无限延长', async t => {
  const answer = deferred(), voice = deferred(), release = deferred(), waiting = deferred();
  const f = await fixture(t, { answer: () => answer.promise, sharedVoice: () => voice.promise, options: { generationTimeoutMs: 100, maxReplyAgeMs: 100 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  f.qq.acquireSend = async signal => { waiting.resolve(); await new Promise(resolve => { release.promise.then(resolve); signal.addEventListener('abort', resolve, { once: true }); }); return () => {}; };
  const pending = f.receive(); await until(() => f.calls.length === 1);
  t.mock.timers.tick(60); answer.resolve({ text: '念念，我在。' }); await until(() => f.voices.length === 1);
  t.mock.timers.tick(500); voice.resolve(audio); await waiting.promise;
  t.mock.timers.tick(39); assert.equal(f.voices[0].signal.aborted, false);
  t.mock.timers.tick(2); release.resolve(); const result = await pending;
  assert.equal(result.reply.status, 'failed'); assert.match(result.reply.error, /生成.*超时/); assert.equal(f.sends.length, 0);
});

test('语音完成后仅扣除实际语音耗时，回复年龄仍约束后续等待', async t => {
  const voice = deferred(), release = deferred(), waiting = deferred();
  const f = await fixture(t, { sharedVoice: () => voice.promise, options: { generationTimeoutMs: 1000, maxReplyAgeMs: 100 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  f.qq.acquireSend = async () => { waiting.resolve(); await release.promise; return () => {}; };
  const pending = f.receive(); await until(() => f.voices.length === 1);
  t.mock.timers.tick(500); voice.resolve(audio); await waiting.promise;
  t.mock.timers.tick(101); release.resolve(); const result = await pending;
  assert.equal(result.reply.status, 'failed'); assert.equal(f.voices[0].signal.aborted, false); assert.equal(f.sends.length, 0);
});
