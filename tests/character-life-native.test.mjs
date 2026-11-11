import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
let bridge;
try { bridge = require('../desktop/companion-life.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; bridge = {}; }
function nativeFixture() {
  const history = [{ id: 'user-1', role: 'user', content: '你好' }], actions = [], voice = [];
  const sessions = { activeSessionId: 'session-1', getSessionMessages: () => history, getSessionGeneration: () => 2, appendSessionMessage: (_id, value) => history.push(value) };
  const stores = new Map([
    ['airi-card', { activeCardId: 'native-card' }], ['chat-session', sessions], ['chat', {}],
    ['llm-streaming-control', { dispatchWith: async (token, context) => actions.push({ token, context }) }],
    ['speech-runtime', { isHost: () => true, openIntent: () => ({ writeLiteral: value => voice.push(value), end() {} }) }],
  ]);
  const context = { document: { querySelector: () => ({ __vue_app__: { config: { globalProperties: { $pinia: { _s: stores } } } } }) }, localStorage: { getItem: () => JSON.stringify({ role: 'native-card' }) }, crypto: { randomUUID: () => 'id' }, Date, setTimeout };
  const call = (name, value) => new Script(`(${bridge[name].toString()})(${JSON.stringify(value)})`).runInNewContext(context);
  return { stores, sessions, history, actions, voice, call, context };
}

test('原生桥读取真实会话与消息标识，动作使用 AIRI 现有 ACT 与 speech-runtime 接口', async () => {
  assert.equal(typeof bridge.nativeCharacterContext, 'function');
  const f = nativeFixture(), context = f.call('nativeCharacterContext');
  assert.equal(context.conversationId, 'session-1'); assert.equal(context.sourceId, 'user-1'); assert.equal(context.generation, 2);
  const result = await f.call('nativeLifeActions', { characterId: 'role', conversationId: 'session-1', sourceId: 'turn-1', actions: [{ type: 'expression', name: 'happy' }, { type: 'motion', name: 'Wave' }, { type: 'voice', text: '你好' }] });
  assert.equal(result.length, 3); assert.match(f.actions[0].token, /^<\|ACT /); assert.match(f.actions[0].token, /happy/); assert.match(f.actions[1].token, /Wave/); assert.equal(f.voice[0], '你好');
});

test('完整音频播放期间切换角色或进入新用户轮次会停止旧声音',async()=>{
  const f=nativeFixture(),timers=new Map(),audio=[];let sequence=0;
  f.context.Audio=class{constructor(url){this.url=url;this.paused=false;audio.push(this);}async play(){}pause(){this.paused=true;}addEventListener(){}};
  f.context.setInterval=callback=>{const id=++sequence;timers.set(id,callback);return id;};f.context.clearInterval=id=>timers.delete(id);
  const payload={characterId:'role',conversationId:'session-1',sourceId:'one',actions:[{type:'record',url:'http://127.0.0.1/voice.wav',voiceId:'xiaoli-warm-bright'}]};
  assert.equal((await f.call('nativeLifeActions',payload))[0].status,'playing');assert.equal(timers.size,1);
  f.history.push({id:'new-user',role:'user',content:'下一句'});for(const callback of [...timers.values()])callback();assert.equal(audio[0].paused,true);assert.equal(timers.size,0);
  await f.call('nativeLifeActions',{...payload,sourceId:'two'});f.stores.get('airi-card').activeCardId='another';for(const callback of [...timers.values()])callback();assert.equal(audio[1].paused,true);
});

test('原生主动消息写入现有会话，跨会话或重复来源拒绝', async () => {
  assert.equal(typeof bridge.nativeDeliver, 'function');
  const f = nativeFixture(), payload = { characterId: 'role', conversationId: 'session-1', sourceId: 'scheduled-1', text: '喝水时间。' };
  assert.equal((await f.call('nativeDeliver', payload)).delivered, true); assert.equal(f.history.at(-1).role, 'assistant');
  assert.equal((await f.call('nativeDeliver', payload)).delivered, false); assert.equal(f.history.length, 2);
  f.sessions.activeSessionId = 'session-2'; assert.equal((await f.call('nativeDeliver', { ...payload, sourceId: 'scheduled-2' })).delivered, false);
});

test('原生送达确认等待实际助手消息落入当前会话，取消代数不匹配时拒绝', async () => {
  assert.equal(typeof bridge.nativeConfirmReply, 'function');
  const f = nativeFixture(), input = { characterId: 'role', conversationId: 'session-1', sourceId: 'user-1', generation: 2, text: '确认回复' };
  setTimeout(() => f.history.push({ id: 'a1', role: 'assistant', content: '确认回复' }), 5);
  assert.equal(await f.call('nativeConfirmReply', input), true);
  assert.equal(await f.call('nativeConfirmReply', { ...input, generation: 1 }), false);
  f.sessions.activeSessionId = 'session-2'; assert.equal(await f.call('nativeConfirmReply', input), false);
});

test('下一轮用户消息已进入时不确认旧回复，也不启动迟到的旧语音',async()=>{
  const f=nativeFixture();let plays=0;
  f.history.push({id:'old-reply',role:'assistant',content:'旧回复'},{id:'user-2',role:'user',content:'新一轮'});
  f.context.Audio=class{async play(){plays++;}pause(){}addEventListener(){}};
  f.context.setInterval=()=>1;f.context.clearInterval=()=>{};
  assert.equal(await f.call('nativeConfirmReply',{characterId:'role',conversationId:'session-1',sourceId:'user-1',generation:2,text:'旧回复'}),false);
  const results=await f.call('nativeLifeActions',{characterId:'role',conversationId:'session-1',sourceId:'user-1:action:0',userSourceId:'user-1',generation:2,actions:[{type:'record',url:'http://127.0.0.1/voice.wav',voiceId:'xiaoli-warm-bright'}]});
  assert.equal(results.length,0);assert.equal(plays,0);
});
