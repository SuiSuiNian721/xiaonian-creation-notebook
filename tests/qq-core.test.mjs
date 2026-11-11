import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const core = await import('../framework/qq.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function until(predicate, label = '等待本地模拟完成') {
  const deadline = Date.now() + 1800;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(label); await delay(2); }
}

async function fixture(t, { answer, options = {}, limited = false } = {}) {
  assert.equal(typeof core.QQController, 'function', '应实现 QQController 门面');
  const directory = await mkdtemp(join(tmpdir(), 'workbench-qq-core-'));
  const gateway = { accountId: '10001', online: true, sockets: [], sends: [], requests: [], mode: 'confirm' };
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; gateway.sockets.push(this); queueMicrotask(() => { if (this.readyState === 3) return; this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(payload) {
      const request = JSON.parse(payload); gateway.requests.push(request);
      let data;
      if (request.action === 'get_login_info') data = { user_id: gateway.accountId, nickname: '角色号' };
      else if (request.action === 'get_status') data = { online: gateway.online, good: gateway.online };
      else {
        gateway.sends.push(request);
        if (gateway.mode === 'drop') { queueMicrotask(() => this.close()); return; }
        if (gateway.mode === 'timeout') return;
        if (gateway.mode === 'reject') { queueMicrotask(() => this.receive({ echo: request.echo, status: 'failed', retcode: 1200 })); return; }
        data = { message_id: String(90000 + gateway.sends.length) };
      }
      queueMicrotask(() => this.receive({ echo: request.echo, status: 'ok', retcode: 0, data }));
    }
    receive(value) { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const characters = new Map([
    ['card-a', { id: 'card-a', revision: 1, name: '小璃', description: '', raw: { data: { name: '小璃', description: '你是小璃', ...(limited ? { extensions: { mvu: {} } } : {}) } } }],
    ['card-b', { id: 'card-b', revision: 2, name: '茉茉', description: '', raw: { name: '茉茉', description: '你是茉茉' } }],
  ]);
  const hostStore = { selectedCharacterId: 'card-b', character(id) { return characters.get(id) ?? null; }, requireCharacter(id) { const character = this.character(id); if (!character) throw new Error('missing character'); return character; } };
  const calls = [];
  const ai = { async complete(messages, configuration) { calls.push({ messages, configuration }); return answer ? answer(messages, configuration, calls.length) : { text: '我在这里。' }; } };
  const runtime = { connects: 0, stops: 0, state() { return { mode: 'external', running: false, external: { wsUrl: 'ws://127.0.0.1:3001', accountId: '10001', hasToken: true } }; },
    connection() { this.connects++; return { wsUrl: 'ws://127.0.0.1:3001', token: 'secret-onebot-token', expectedAccountId: '10001' }; }, async stop() { this.stops++; }, async close() {} };
  let controller;
  const create = () => new core.QQController({ store: hostStore, dataDir: directory, sharedAI: ai, runtime,
    onebotOptions: { WebSocketImpl: Socket, requestTimeoutMs: 35, connectTimeoutMs: 100, heartbeatIntervalMs: 0, reconnectBaseMs: 10, reconnectMaxMs: 30, minSendIntervalMs: 0, ...options } });
  controller = create();
  t.after(async () => { await controller.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const f = { get controller() { return controller; }, gateway, calls, runtime, hostStore, ai, characters,
    async ready() { controller.bind({ characterId: 'card-a', acceptLimited: limited }); controller.saveRules({ privateAllow: ['20001', '20002'], groupAllow: ['30001'], requireMention: true }); await controller.connect(); controller.start(); },
    emit(text = '你好', extra = {}) { gateway.sockets.at(-1).receive({ post_type: 'message', self_id: gateway.accountId, message_type: 'private', user_id: '20001', message_id: String(100 + gateway.requests.length), message: [{ type: 'text', data: { text } }], ...extra }); },
    async idle() { await until(() => controller.state().pending === 0); },
    async restart() { await controller.close(); controller = create(); },
  };
  return f;
}

test('查询不连接不调用 AI，绑定快照不跟随顶部选角，重启默认暂停且不泄露令牌', async t => {
  const f = await fixture(t);
  assert.equal(f.controller.state().paused, true); assert.equal(f.controller.state().aiEnabled, true);
  assert.deepEqual(f.controller.conversations(), { conversations: [] });
  assert.equal(f.calls.length, 0); assert.equal(f.runtime.connects, 0);
  f.controller.bind({ characterId: 'card-a' }); f.hostStore.selectedCharacterId = 'card-b';
  assert.equal(f.controller.state().binding.characterId, 'card-a');
  await f.ready(); f.emit(); await until(() => f.gateway.sends.length === 1); await f.idle();
  assert.match(f.calls[0].messages[0].content, /小璃/); assert.doesNotMatch(f.calls[0].messages[0].content, /你是茉茉/);
  assert.equal(f.calls[0].configuration.moduleId, 'qq'); assert.equal(f.calls[0].configuration.policy, 'chat-only');
  assert.ok(f.calls[0].configuration.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(f.controller.state()).includes('secret-onebot-token'), false);
  await f.restart(); assert.equal(f.controller.state().paused, true); assert.equal(f.controller.state().binding.characterId, 'card-a');
  assert.equal(f.controller.conversations().conversations.length, 1); assert.equal(f.gateway.sends.length, 1);
});

test('有限角色需明确接受；私聊名单和允许群@规则在调用 AI 前过滤，QQ 文字不执行管理命令', async t => {
  const f = await fixture(t, { limited: true });
  assert.throws(() => f.controller.bind({ characterId: 'card-a' }), /基础文字|受限/);
  await f.ready();
  assert.throws(() => f.controller.saveRules({ privateAllow: [], groupAllow: [], requireMention: false }), /@|提及/);
  f.emit('未允许', { user_id: '99999', message_id: '1' });
  f.emit('群里没@', { message_type: 'group', group_id: '30001', message_id: '2' });
  f.emit('自发', { user_id: '10001', message_id: '3' });
  f.emit('错号', { self_id: '10002', message_id: '4' });
  await delay(15); assert.equal(f.calls.length, 0);
  f.emit('/reset', { message_type: 'group', group_id: '30001', message_id: '5', message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '/reset' } }] });
  await until(() => f.gateway.sends.length === 1); await f.idle();
  const row = f.controller.conversations().conversations[0];
  assert.equal(row.channel, 'group'); assert.equal(f.controller.messages(row.id).messages[0].userId, '20001');
  assert.match(f.calls[0].messages.at(-1).content, /QQ.*20001|20001.*QQ/);
  assert.match(f.calls[0].messages.at(-1).content, /\/reset/);
});

test('暂停、改角、移出名单和新故事会取消慢生成，即使模型迟到也不会发送', async t => {
  for (const action of ['pause', 'bind', 'rules', 'story', 'disconnect']) {
    await t.test(action, async t => {
      let finish;
      const f = await fixture(t, { answer: () => new Promise(resolveAnswer => { finish = resolveAnswer; }) });
      await f.ready(); f.emit('慢一点'); await until(() => f.calls.length === 1);
      const signal = f.calls[0].configuration.signal;
      if (action === 'pause') f.controller.pause();
      if (action === 'bind') f.controller.bind({ characterId: 'card-b' });
      if (action === 'rules') f.controller.saveRules({ privateAllow: [], groupAllow: ['30001'], requireMention: true });
      if (action === 'story') f.controller.newStory(f.controller.conversations().conversations[0].id);
      if (action === 'disconnect') await f.controller.disconnect();
      assert.equal(signal.aborted, true);
      finish({ text: '迟到的旧回复' }); await f.idle(); await delay(5);
      assert.equal(f.gateway.sends.length, 0);
      const rows = f.controller.conversations().conversations.flatMap(row => f.controller.messages(row.id).messages);
      assert.equal(rows.find(row => row.role === 'assistant').status, 'failed');
    });
  }
});

test('持久去重在重启后阻止再生成，unknown 回复不进入已说历史，也不自动重发', async t => {
  const f = await fixture(t); await f.ready(); f.gateway.mode = 'timeout';
  f.emit('第一句', { message_id: 'same-event' });
  // OneBot 的 message_id 必须是数值标识，非数值事件应被过滤。
  await delay(10); assert.equal(f.calls.length, 0);
  f.emit('第一句', { message_id: '101' }); await until(() => f.calls.length === 1); await f.idle();
  const conversationId = f.controller.conversations().conversations[0].id;
  assert.equal(f.controller.messages(conversationId).messages.at(-1).status, 'unknown');
  f.gateway.mode = 'confirm'; f.emit('第二句', { message_id: '102' }); await until(() => f.calls.length === 2); await f.idle();
  assert.equal(f.calls[1].messages.filter(message => message.role === 'assistant').length, 0);
  await f.restart(); await f.controller.connect(); f.controller.start();
  f.emit('第一句', { message_id: '101' }); await delay(15);
  assert.equal(f.calls.length, 2); assert.equal(f.gateway.sends.length, 2);
});

test('沙盒拥有独立记录与记忆分区，执行层永远不调用 QQ 发送，记忆只注入原会话', async t => {
  const f = await fixture(t); await f.ready();
  const simulated = await f.controller.simulate({ channel: 'private', peerId: '20001', userId: '20001', text: '沙盒秘密' });
  assert.equal(simulated.simulated, true); assert.equal(simulated.reply.status, 'simulated'); assert.equal(f.gateway.sends.length, 0);
  const memory = f.controller.saveMemory({ conversationId: simulated.conversationId, content: '这是沙盒记忆', sourceMessageId: simulated.userMessageId }).memory;
  assert.equal(memory.sourceQuote, '沙盒秘密');
  f.emit('真实会话', { message_id: '201' }); await until(() => f.gateway.sends.length === 1); await f.idle();
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages), /沙盒秘密|沙盒记忆/);
  const real = f.controller.conversations().conversations.find(row => !row.sandbox);
  f.controller.saveMemory({ conversationId: real.id, content: '念念喜欢星星' });
  f.emit('原会话', { message_id: '202' }); await until(() => f.gateway.sends.length === 2); await f.idle();
  assert.match(JSON.stringify(f.calls.at(-1).messages), /念念喜欢星星/);
  f.emit('另一个人', { message_id: '203', user_id: '20002' }); await until(() => f.gateway.sends.length === 3); await f.idle();
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1).messages), /念念喜欢星星/);
  assert.deepEqual(f.controller.memories(real.id).memories.map(row => row.content), ['念念喜欢星星']);
  assert.equal(f.controller.deleteMemory({ id: memory.id }).deleted, true);
});

test('同会话串行且队列有界，未来排队的用户消息不提前进入当前上下文', async t => {
  const completions = [];
  const f = await fixture(t, { answer: () => new Promise(resolveAnswer => completions.push(resolveAnswer)), options: { maxQueuePerConversation: 2 } });
  await f.ready(); f.emit('第一条', { message_id: '301' }); await until(() => f.calls.length === 1);
  f.emit('第二条', { message_id: '302' }); f.emit('第三条溢出', { message_id: '303' });
  await delay(10); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls[0].messages), /第二条|第三条/);
  completions.shift()({ text: '第一条回复' }); await until(() => f.calls.length === 2);
  assert.match(JSON.stringify(f.calls[1].messages), /第一条回复/);
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /第三条/);
  completions.shift()({ text: '第二条回复' }); await f.idle();
  assert.equal(f.gateway.sends.length, 2);
  assert.ok(f.controller.messages(f.controller.conversations().conversations[0].id).messages.some(row => row.status === 'failed' && /队列/.test(row.error)));
});

test('预算触发的滚动摘要经过同一 QQ 隔离策略，保留水位且不会外发摘要', async t => {
  const f = await fixture(t, { options: { summaryTriggerChars: 20, summaryKeepMessages: 2 }, answer: messages => ({ text: messages[0].content.includes('滚动摘要') ? '念念与小璃谈论了星星。' : '小璃认真听着念念说话。' }) });
  await f.ready();
  for (let i = 0; i < 4; i++) { f.emit('今天我们一起看星星。', { message_id: String(400 + i) }); await until(() => f.gateway.sends.length === i + 1); await f.idle(); }
  const detail = f.controller.messages(f.controller.conversations().conversations[0].id);
  assert.ok(detail.summary.throughSequence > 0); assert.match(detail.summary.content, /星星/);
  assert.ok(f.calls.some(call => call.messages[0].content.includes('滚动摘要')));
  assert.ok(f.calls.every(call => call.configuration.moduleId === 'qq' && call.configuration.policy === 'chat-only'));
  assert.ok(f.gateway.sends.every(request => !request.params.message[0].data.text.includes('谈论了星星')));
});

test('意外掉线取消旧生成并退避重连，每次重连核对同一账号，主动断开不再连接', async t => {
  let finish;
  const f = await fixture(t, { answer: () => new Promise(resolveAnswer => { finish = resolveAnswer; }) });
  await f.ready(); f.emit('旧连接', { message_id: '501' }); await until(() => f.calls.length === 1);
  f.gateway.sockets.at(-1).close(); assert.equal(f.calls[0].configuration.signal.aborted, true);
  finish({ text: '不能补发' }); await until(() => f.gateway.sockets.length === 2 && f.controller.state().transport.status === 'verified');
  assert.equal(f.gateway.sends.length, 0);
  f.gateway.accountId = '10002'; f.gateway.sockets.at(-1).close();
  await until(() => f.controller.state().transport.status === 'identity-mismatch');
  assert.equal(f.controller.state().paused, true);
  const attempts = f.gateway.sockets.length; await f.controller.disconnect(); await delay(50);
  assert.equal(f.gateway.sockets.length, attempts); assert.equal(f.runtime.stops,0,'断开连接应保留 QQ 登录端');
  await f.controller.disconnect({stopRuntime:true});assert.ok(f.runtime.stops>0,'明确停止才关闭 QQ');
});

test('网关明确 retcode 拒绝记 failed，优先于 sending 状态，失败内容不进入已说历史', async t => {
  const f = await fixture(t); await f.ready(); f.gateway.mode = 'reject';
  f.emit('应明确失败', { message_id: '601' }); await until(() => f.calls.length === 1); await f.idle();
  const conversationId = f.controller.conversations().conversations[0].id;
  assert.equal(f.controller.messages(conversationId).messages.at(-1).status, 'failed');
  f.gateway.mode = 'confirm'; f.emit('继续聊天', { message_id: '602' }); await until(() => f.calls.length === 2); await f.idle();
  assert.equal(f.calls[1].messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal(f.gateway.sends.length, 2);
});

test('普通方括号角色文本原样发送，仅有效完整 JSON 取 reply，内部结构和残缺数据不外发', async t => {
  assert.equal(core.extractQQReply('[微笑] 念念，晚上好。'), '[微笑] 念念，晚上好。');
  assert.equal(core.extractQQReply('{微笑} 晚上好。'), '{微笑} 晚上好。');
  assert.equal(core.extractQQReply('{"reply":"晚上好。","summary":"仅供内部"}'), '晚上好。');
  assert.throws(() => core.extractQQReply('{"tool_calls":[{"name":"read_file"}]}'), /内部数据|可发送/);
  assert.throws(() => core.extractQQReply('[{"role":"tool","content":"系统资料"}]'), /内部数据|可发送/);
  assert.throws(() => core.extractQQReply('{"reply":"未结束","tool_calls":['), /内部数据|完整/);
  assert.throws(() => core.extractQQReply('{tool_calls: [read_file]}'), /内部数据|完整/);
  const f = await fixture(t, { answer: () => ({ text: '[微笑] 念念，晚上好。' }) }); await f.ready();
  f.emit('角色动作', { message_id: '603' }); await until(() => f.calls.length === 1); await f.idle();
  assert.equal(f.gateway.sends[0]?.params.message[0].data.text, '[微笑] 念念，晚上好。');
});

test('从历史故事重新开始也取消同一路由的当前生成，释放单并发槽',async t=>{
  const f=await fixture(t,{options:{maxConcurrent:1},answer:(_messages,_config,count)=>count===2?new Promise(()=>{}):{text:'新的故事回复'}});
  await f.ready();f.emit('故事 A',{message_id:'701'});await until(()=>f.gateway.sends.length===1);await f.idle();
  const first=f.controller.conversations().conversations[0];f.controller.newStory(first.id);
  f.emit('故事 B 的慢回复',{message_id:'702'});await until(()=>f.calls.length===2);
  f.controller.newStory(first.id);assert.equal(f.calls[1].configuration.signal.aborted,true);
  f.emit('故事 C',{message_id:'703'});await until(()=>f.calls.length===3);await f.idle();
  assert.equal(f.gateway.sends.length,2);
});

test('新故事的开场白进入初始场景参考，不作为已经发送的助手历史',async t=>{
  const f=await fixture(t);f.characters.get('card-a').raw.data.first_mes='{{char}}站在灯塔旁，等待{{user}}。';
  await f.ready();f.emit('你在哪里',{message_id:'704'});await until(()=>f.calls.length===1);await f.idle();
  assert.match(f.calls[0].messages[0].content,/小璃站在灯塔旁/);
  assert.equal(f.calls[0].messages.some(message=>message.role==='assistant'),false);
});
