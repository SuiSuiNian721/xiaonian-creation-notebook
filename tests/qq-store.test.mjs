import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const storeModule = await import('../framework/qq-store.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function fixture(t) {
  assert.equal(typeof storeModule.QQStore, 'function', '应实现 QQ 独立持久存储');
  const directory = await mkdtemp(join(tmpdir(), 'workbench-qq-store-'));
  let store = new storeModule.QQStore(directory);
  t.after(async () => { store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const binding = store.saveBinding({ characterId: 'card-a', revision: 1, hash: 'a'.repeat(64), name: '小璃', compatibility: 'supported', unsupportedFeatures: [], raw: {}, worldbook: [] });
  return { get store() { return store; }, binding, restart() { store.close(); store = new storeModule.QQStore(directory); } };
}

const route = bindingId => ({ selfId: '10001', bindingId, channel: 'private', peerId: '20001', sandbox: false });
const event = (dedupId = '10001:private:20001:1') => ({ dedupId, text: '念念喜欢星星', userId: '20001', userName: '念念', sourceMessageId: '1' });

test('QQ 会话按账号、绑定、私群、对端、沙盒和故事隔离，新故事保留旧历史', async t => {
  const f = await fixture(t), base = route(f.binding.id);
  const conversation = f.store.ensureConversation(base);
  f.store.claimInbound(conversation.id, event());
  assert.equal(f.store.ensureConversation(base).id, conversation.id);
  for (const change of [{ selfId: '10002' }, { bindingId: f.store.saveBinding({ ...f.binding, characterId: 'card-b', id: undefined }).id }, { channel: 'group' }, { peerId: '20002' }, { sandbox: true }]) {
    assert.notEqual(f.store.ensureConversation({ ...base, ...change }).id, conversation.id);
  }
  const next = f.store.newStory(conversation.id);
  assert.notEqual(next.id, conversation.id); assert.notEqual(next.storyId, conversation.storyId);
  assert.equal(f.store.messages(conversation.id).filter(message => message.role === 'user').length, 1);
  assert.equal(f.store.messages(next.id).length, 0);
  assert.equal(f.store.ensureConversation(base).id, next.id);
});

test('持久去重跨重启，崩溃中的发送转 unknown，旧队列不追发且未确认助手不进入历史', async t => {
  const f = await fixture(t), conversation = f.store.ensureConversation(route(f.binding.id));
  const turn = f.store.claimInbound(conversation.id, event());
  f.store.updateMessage(turn.reply.id, { content: '我记住啦', status: 'sending' });
  const waiting = f.store.claimInbound(conversation.id, event('10001:private:20001:2'));
  f.restart();
  assert.equal(f.store.claimInbound(conversation.id, event()), null);
  const rows = f.store.messages(conversation.id);
  assert.equal(rows.find(message => message.id === turn.reply.id).status, 'unknown');
  assert.equal(rows.find(message => message.id === waiting.reply.id).status, 'failed');
  assert.equal(f.store.history(conversation.id).filter(message => message.role === 'assistant').length, 0);
  assert.equal(f.store.inboundState(event().dedupId).status, 'abandoned');
});

test('手工记忆记录原话和来源，不能跨会话引用或编辑，摘要水位不能倒退', async t => {
  const f = await fixture(t), a = f.store.ensureConversation(route(f.binding.id));
  const b = f.store.ensureConversation({ ...route(f.binding.id), peerId: '20002' });
  const turn = f.store.claimInbound(a.id, event());
  const memory = f.store.saveMemory({ conversationId: a.id, content: '喜欢星星', sourceMessageId: turn.user.id });
  assert.equal(memory.sourceQuote, '念念喜欢星星');
  assert.equal(memory.conversationId, a.id); assert.equal(f.store.memories(b.id).length, 0);
  assert.throws(() => f.store.saveMemory({ conversationId: b.id, content: '偷用来源', sourceMessageId: turn.user.id }), /会话/);
  assert.throws(() => f.store.saveMemory({ conversationId: b.id, id: memory.id, content: '跨会话覆盖' }), /会话/);
  assert.equal(f.store.saveMemory({ conversationId: a.id, id: memory.id, content: '喜欢夜空里的星星' }).sourceQuote, '念念喜欢星星');
  f.store.updateMessage(turn.reply.id, { content: '好呀', status: 'confirmed', gatewayMessageId: '8' });
  f.store.saveSummary(a.id, { content: '念念喜欢星星。', throughSequence: turn.reply.sequence });
  assert.equal(f.store.summary(a.id).throughSequence, turn.reply.sequence);
  assert.throws(() => f.store.saveSummary(a.id, { content: '旧摘要', throughSequence: turn.user.sequence }), /水位/);
  assert.equal(f.store.deleteMemory(memory.id), true); assert.equal(f.store.memories(a.id).length, 0);
});
