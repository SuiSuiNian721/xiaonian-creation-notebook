import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQController } from '../framework/qq.mjs';
import { completeAiriChat } from '../framework/companion-ai.mjs';
import { CharacterLife } from '../framework/character-life/service.mjs';
import { Companion } from '../framework/companion.mjs';

const character = { id: 'shared-role', revision: 1, name: '茉茉', raw: { name: '茉茉', description: '共同人设' } };
function lifeFixture() {
  const contexts = [], observations = [], processed = [], decisions = [];
  const life = {
    async context(value) { contexts.push(value); return { prompt: '共同人设\n世界书\n长期记忆', beforeMessages: [], afterMessages: [{ role: 'system', content: '深度世界书', depth: 1 }], settings: {} }; },
    async processOutput(value) { processed.push(value); return { text: value.text.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/g, ''), actions: [], state: { mood: 'happy' } }; },
    async observe(value) { observations.push(value); },
    async decide(value) { decisions.push(value); return { reply: value.text !== '旁观消息', reason: 'observing', delayMs: 0 }; },
  };
  return { life, contexts, observations, processed, decisions };
}
async function qqFixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'character-life-adapters-'));
  const f = lifeFixture(), calls = [], sends = [];
  const qq = new QQController({ store: { character: () => character }, dataDir: directory, life: f.life,
    sharedAI: { complete: async messages => { calls.push(messages); return { text: '我在。<UpdateVariable>{}</UpdateVariable>' }; } },
    onebotOptions: { minSendIntervalMs: 0 }, ...extra });
  qq.bind({ characterId: character.id }); qq.saveRules({ privateAllow: ['20001'], groupAllow: ['30001'], requireMention: true });
  qq.actualSelfId = '10001'; qq.paused = false;
  qq.transport.state = () => ({ status: 'verified', selfId: '10001', connectionId: 'connection' });
  qq.transport.send = async value => { sends.push(value); return { messageId: '123' }; };
  t.after(async () => { await qq.close(); await rm(directory, { recursive: true, force: true }); });
  const receive = (message = '你好', more = {}) => qq.receive({ post_type: 'message', self_id: '10001', message_type: 'private', user_id: '20001', message_id: '1', message: message, ...more });
  return { qq, calls, sends, receive, directory, ...f };
}

async function realLife(t,ai=async()=>({text:'{"memories":[]}'})){
  const directory=await mkdtemp(join(tmpdir(),'character-life-dispatch-'));
  const store={character:()=>character,requireCharacter:()=>character,state:()=>({characters:[character],selectedCharacterId:character.id})};
  const life=new CharacterLife({store,dataDir:directory,sharedAI:{complete:ai}});
  life.configure(character.id,{mode:'full',memory:{autoExtract:false}});
  t.after(async()=>{await life.close();await rm(directory,{recursive:true,force:true});});
  return {life,store,directory};
}

test('原生送达确认等待期间切精简后，旧形象动作和旧观察均被撤销',async t=>{
  const {life}=await realLife(t);let entered,release,actions=0,observations=0;
  const waiting=new Promise(r=>{entered=r;});
  const originalObserve=life.observe.bind(life);life.observe=async value=>{observations++;return originalObserve(value);};
  const result=await completeAiriChat({life,character,sharedAI:{config:()=>({enabled:true,provider:'codex'}),complete:async()=>({text:'{"reply":"你好","actions":[{"type":"motion","name":"wave"}]}'})},
    value:{messages:[{role:'user',content:'你好'}]},confirmDelivery:async()=>{entered();return new Promise(r=>{release=r;});},onActions:async()=>{actions++;return [{status:'dispatched'}];}});
  const pending=result.afterDelivery();await waiting;life.configure(character.id,{mode:'lite'});release(true);await pending;
  assert.equal(actions,0);assert.equal(observations,0);assert.equal(life.data.list(character.id,'turn').length,0);
});

test('QQ 回复等待发送锁时切模式，发送时移除旧媒体且不提交旧变量',async t=>{
  const f=await qqFixture(t),{life,store}=await realLife(t);
  f.qq.life=life;f.qq.hostStore=store;
  f.qq.sharedAI={complete:async()=>({text:JSON.stringify({reply:'你好<UpdateVariable>_.set("old",99);</UpdateVariable>',actions:[{type:'meme',id:'flower'}]})})};
  life.configure(character.id,{media:{memes:[{id:'flower',name:'花',url:'https://example.invalid/flower.png',tags:[]}]}});
  let entered,release;const waiting=new Promise(r=>{entered=r;});
  f.qq.acquireSend=async()=>{entered();await new Promise(r=>{release=r;});return ()=>{};};
  const pending=f.receive();await waiting;life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});release();
  const result=await pending;assert.equal(result.reply.status,'confirmed');assert.equal(f.sends.length,1);assert.deepEqual(f.sends[0].actions,[]);
  assert.equal(life.state(character.id,`qq:${result.conversationId}`).variables.old,undefined);
});

test('原生主动文字送达等待期间切精简后，不再派发携带的动作',async t=>{
  const {life,store,directory}=await realLife(t);let entered,release,actions=0;
  const waiting=new Promise(r=>{entered=r;});
  const companion=new Companion({store:{...store,module:()=>({enabled:true})},dataDir:directory,life,host:{characterContext:async()=>({managed:true,id:character.id,conversationId:'native'}),deliver:async()=>{entered();await new Promise(r=>{release=r;});return {delivered:true,status:'confirmed'};},actions:async()=>{actions++;return [{status:'dispatched'}];},async close(){}}});
  companion.status='running';
  const pending=companion.deliver({characterId:character.id,conversationId:'native',sourceId:'proactive-old',text:'你好',actions:[{type:'motion',name:'wave'}]});
  await waiting;life.configure(character.id,{mode:'lite'});release();const result=await pending;
  assert.equal(result.delivered,true);assert.equal(actions,0);
  await companion.close();
});

test('原生多个动作逐项派发，在第一个动作等待期间切模式会撤销后续动作',async t=>{
  const {life,store,directory}=await realLife(t);let entered,release;const sent=[];
  const waiting=new Promise(r=>{entered=r;});
  const companion=new Companion({store,dataDir:directory,life,host:{actions:async value=>{sent.push(value);entered();await new Promise(r=>{release=r;});return [{status:'dispatched'}];},async close(){}}});
  const pending=companion.performActions({characterId:character.id,sourceId:'actions-old',actions:[{type:'motion',name:'wave'},{type:'expression',name:'happy'}]});
  await waiting;life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});release();await pending;
  assert.equal(sent.length,1);assert.deepEqual(sent[0].actions,[{type:'motion',name:'wave'}]);await companion.close();
});

test('QQ 与角色服务共用人设和深度世界书，确认送达后再整理变量记忆', async t => {
  const f = await qqFixture(t); const result = await f.receive();
  assert.equal(result.reply.status, 'confirmed'); assert.equal(result.reply.content, '我在。');
  assert.match(f.calls[0][0].content, /共同人设.*世界书.*长期记忆/s);
  assert.equal(f.calls[0].at(-2).content, '深度世界书');
  assert.equal(f.contexts[0].character.id, character.id); assert.equal(f.contexts[0].character.raw.description, '共同人设');
  assert.equal(f.sends[0].text, '我在。'); assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].sourceId, '10001:private:20001:1');
  assert.equal(f.observations[0].reply, '我在。'); assert.equal(f.observations[0].synthetic, false);
});

test('QQ 整理异常不改写送达状态；失败与未知送达不产生经历', async t => {
  const f = await qqFixture(t); f.life.observe = async () => { throw new Error('整理失败'); };
  assert.equal((await f.receive()).reply.status, 'confirmed');
  f.life.observe = async value => f.observations.push(value);
  f.qq.transport.send = async () => { const error = new Error('未知'); error.delivery = 'unknown'; throw error; };
  assert.equal((await f.receive('再次', { message_id: '2' })).reply.status, 'unknown');
  assert.equal(f.observations.length, 0);
});

test('只有媒体的回复仍执行真实发送，确认后才整理', async t => {
  const f = await qqFixture(t);
  f.life.processOutput = async () => ({ text: '', actions: [{ type: 'image', url: 'https://example.invalid/meme.png' }] });
  const result = await f.receive(); assert.equal(result.reply.status, 'confirmed'); assert.equal(f.observations.length, 1);
  assert.equal(f.sends[0].actions[0].type, 'image');
});

test('群聊旁观经 decide 保留上下文且不发送，后续提及可看到旁观消息', async t => {
  const f = await qqFixture(t);
  f.qq.saveRules({ privateAllow: ['20001'], groupAllow: ['30001'], requireMention: false });
  const first = await f.receive('旁观消息', { message_type: 'group', group_id: '30001' });
  assert.equal(first.reply.status, 'skipped'); assert.equal(f.calls.length, 0); assert.equal(f.observations.length, 0);
  await f.receive('[CQ:at,qq=10001] 回应', { message_type: 'group', group_id: '30001', message_id: '2' });
  assert.match(JSON.stringify(f.contexts[0].history), /旁观消息/); assert.equal(f.sends.length, 1);
});

test('QQ 主动送达沿用当前会话并持久去重，暂停时拒绝', async t => {
  const f = await qqFixture(t); const first = await f.receive();
  const value = { characterId: character.id, moduleId: 'qq', conversationId: first.conversationId, text: '记得吃饭。', sourceId: 'proactive:1' };
  const result = await f.qq.deliver(value); assert.equal(result.status, 'confirmed'); assert.equal(f.sends.length, 2);
  assert.equal((await f.qq.deliver(value)).delivered, false); assert.equal(f.sends.length, 2);
  f.qq.pause(); assert.equal((await f.qq.deliver({ ...value, sourceId: 'proactive:2' })).status, 'skipped');
});

test('QQ 主动发送占用会话顺序，随后入站不会并行生成', async t => {
  const f = await qqFixture(t), first = await f.receive(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.qq.transport.send = async value => { if (value.text === '主动消息') { entered(); await new Promise(resolve => { release = resolve; }); } return { messageId: 'next' }; };
  const outgoing = f.qq.deliver({ characterId: character.id, conversationId: first.conversationId, text: '主动消息', sourceId: 'ordered-1' });
  await started;
  const inbound = f.receive('跟随消息', { message_id: '2' });
  try { await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.calls.length, 1); }
  finally { release(); }
  await outgoing; await inbound; assert.equal(f.calls.length, 2);
});

test('主动消息在媒体工具等待期间关闭开关，最终发送检查仍能阻止外发',async t=>{
  const f=await qqFixture(t);const first=await f.receive();
  let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});let enabled=true;
  f.life.processOutput=async value=>{entered();await new Promise(resolve=>{release=resolve;});return {text:value.text,actions:[]};};
  const pending=f.qq.deliver({characterId:character.id,characterRevision:1,conversationId:first.conversationId,text:'主动消息',sourceId:'guarded-proactive',canSend:()=>enabled});
  await waiting;enabled=false;release();const result=await pending;
  assert.equal(result.delivered,false);assert.equal(f.sends.length,1);
});

test('求助动作只发给配置且在允许名单中的主人，动作失败不改变主回复送达', async t => {
  const f = await qqFixture(t);
  f.life.processOutput = async value => ({ text: value.text.replace(/<UpdateVariable>.*?<\/UpdateVariable>/g, ''), actions: value.text.startsWith('我在') ? [{ type: 'help', ownerId: '20001', text: '需要你看看' }] : [] });
  assert.equal((await f.receive()).reply.status, 'confirmed');
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].peerId, '20001'); assert.equal(f.sends[1].text, '需要你看看');
  f.life.processOutput = async () => ({ text: '主回复', actions: [{ type: 'help', ownerId: '99999', text: '未允许' }] });
  assert.equal((await f.receive('第二条', { message_id: '2' })).reply.status, 'confirmed'); assert.equal(f.sends.length, 3);
});

test('原生流清理内部块且保留工具调用，只有最终轮送达回调才记录', async () => {
  const f = lifeFixture(); let body;
  const chunks = [
    { id: 'reply1', choices: [{ index: 0, delta: { role: 'assistant', content: '你好<Update' }, finish_reason: null }] },
    { id: 'reply1', choices: [{ index: 0, delta: { content: 'Variable>{}</UpdateVariable>。' }, finish_reason: null }] },
    { id: 'reply1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  const sharedAI = { config: () => ({ enabled: true, provider: 'openai', baseUrl: 'https://local.invalid/v1', model: 'fixture' }), fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); } };
  const result = await completeAiriChat({ sharedAI, life: f.life, character, conversationId: 'native-session', sourceId: 'native-user-1', value: { stream: true, messages: [{ role: 'user', content: '你好' }] } });
  const output = result.response ? await result.response.text() : JSON.stringify(result.value);
  assert.doesNotMatch(output, /UpdateVariable/); assert.match(body.messages[0].content, /共同人设/);
  assert.equal(f.observations.length, 0); assert.equal(typeof result.afterDelivery, 'function');
  await result.afterDelivery(); await result.afterDelivery(); assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].conversationId, 'native-session'); assert.equal(f.observations[0].reply, '你好。');
});

test('原生工具中间轮保留工具，不提前记录；取消后最终回复也不记录', async () => {
  const f = lifeFixture(), controller = new AbortController();
  const sharedAI = { config: () => ({ enabled: true, provider: 'codex' }), complete: async () => ({ text: '{"content":"稍等<UpdateVariable>{}</UpdateVariable>","tool_calls":[{"name":"look","arguments":"{}"}]}' }) };
  const args = { sharedAI, life: f.life, character, conversationId: 's', sourceId: 'turn', signal: controller.signal, value: { messages: [{ role: 'user', content: '看看' }], tools: [{ type: 'function', function: { name: 'look' } }] } };
  const middle = await completeAiriChat(args); assert.equal(middle.value.choices[0].message.tool_calls[0].function.name, 'look');
  assert.doesNotMatch(middle.value.choices[0].message.content, /UpdateVariable/); await middle.afterDelivery?.(); assert.equal(f.observations.length, 0);
  sharedAI.complete = async () => ({ text: '{"content":"看见了","tool_calls":[]}' });
  const last = await completeAiriChat(args); controller.abort(); await last.afterDelivery?.(); assert.equal(f.observations.length, 0);
});

test('原生只有媒体的最终轮执行动作，空文字不会让媒体静默消失', async () => {
  const f = lifeFixture(); let deliveredActions;
  f.life.processOutput = async () => ({ text: '', actions: [{ type: 'image', url: 'https://example.invalid/a.png' }] });
  const result = await completeAiriChat({ life: f.life, character, sharedAI: { config: () => ({ enabled: true, provider: 'codex' }), complete: async () => ({ text: '媒体响应' }) },
    value: { messages: [{ role: 'user', content: '发张图片' }] }, onActions: async actions => { deliveredActions = actions; return [{ status: 'displayed' }]; } });
  await result.afterDelivery(); assert.equal(deliveredActions[0].type, 'image'); assert.equal(f.observations.length, 1);
});

test('HTTP 完成但原生客户端没有确认写入时，不记为已发生对话', async () => {
  const f = lifeFixture(); let checked = false;
  const result = await completeAiriChat({ life: f.life, character, sharedAI: { config: () => ({ enabled: true, provider: 'codex' }), complete: async () => ({ text: '未落入会话' }) },
    value: { messages: [{ role: 'user', content: '你好' }] }, confirmDelivery: async text => { checked = true; assert.equal(text, '未落入会话'); return false; } });
  await result.afterDelivery(); assert.equal(checked, true); assert.equal(f.observations.length, 0);
});

test('真实角色服务与 QQ 共享变量初始化，失败输出不提交，确认后持久化', async t => {
  const f = await qqFixture(t);
  const card = { ...character, raw: { name: '茉茉', description: '体力 <%= getvar("stat_data.hp") %>', character_book: { entries: [{ comment: '[InitVar]', enabled: false, content: 'hp: 8' }] } } };
  const host = { character: () => card, requireCharacter: () => card, state: () => ({ characters: [card] }) };
  const sharedAI = { complete: async () => ({ text: '走了一会。<UpdateVariable>_.add("hp", -1);</UpdateVariable>' }) };
  const directory = await mkdtemp(join(tmpdir(), 'character-life-adapter-service-'));
  const life = new CharacterLife({ store: host, dataDir: directory, sharedAI });
  t.after(async () => { await life.close(); await rm(directory, { recursive: true, force: true }); }); life.configure(card.id, { mode:'full', memory: { autoExtract: false }, behavior: { learnStyle: false } });
  f.qq.life = life; f.qq.hostStore = host; f.qq.sharedAI = sharedAI; f.qq.bind({ characterId: card.id }); f.qq.paused = false;
  f.qq.transport.send = async () => { const error = new Error('unknown'); error.delivery = 'unknown'; throw error; };
  const failed = await f.receive(); assert.equal(failed.reply.status, 'unknown');
  assert.equal(life.view(card.id, { moduleId: 'qq', conversationId: failed.conversationId }).state.variables.stat_data, undefined);
  f.qq.transport.send = async () => ({ messageId: '8' });
  const delivered = await f.receive('走吧', { message_id: '2' }); assert.equal(delivered.reply.status, 'confirmed');
  assert.equal(life.view(card.id, { moduleId: 'qq', conversationId: delivered.conversationId }).state.variables.stat_data.hp, 7);
});

test('原生适配使用实际session和user message标识，角色或session变化后不记录', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'character-life-native-context-'));
  const f = lifeFixture(); let native = { managed: true, id: character.id, conversationId: 'native-one', sourceId: 'u1', generation: 1 };
  const companion = new Companion({ store: { state: () => ({ selectedCharacterId: character.id, characters: [character] }) }, dataDir: directory, life: f.life,
    host: { characterContext: async () => ({ ...native }), close: async () => {} }, sharedAI: { config: () => ({ enabled: true, provider: 'codex' }), complete: async () => ({ text: '你好' }) } });
  t.after(async () => { await companion.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await companion.complete({ messages: [{ role: 'user', content: '你好' }] });
  assert.equal(f.contexts[0].conversationId, 'native-one');
  native = { ...native, conversationId: 'native-two' }; await result.afterDelivery(); assert.equal(f.observations.length, 0);
  const next = await companion.complete({ messages: [{ role: 'user', content: '你好' }] }); await next.afterDelivery();
  assert.equal(f.observations[0].sourceId, 'native-two:u1');
});

test('原生流工具参数碎片保持完整，截断流不会产生送达回调', async () => {
  const f = lifeFixture(); let text = [
    { id: 'tool', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'look', arguments: '{"what"' } }] }, finish_reason: null }] },
    { id: 'tool', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"screen"}' } }] }, finish_reason: null }] },
    { id: 'tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const args = { life: f.life, character, value: { stream: true, messages: [{ role: 'user', content: '看屏幕' }] },
    sharedAI: { config: () => ({ enabled: true, provider: 'openai', baseUrl: 'https://local.invalid', model: 'test' }), fetch: async () => new Response(text) } };
  const result = await completeAiriChat(args), data = await result.response.text();
  const chunk = JSON.parse(data.split('\n')[0].slice(6)); assert.equal(chunk.choices[0].delta.tool_calls[0].function.arguments, '{"what":"screen"}');
  await result.afterDelivery(); assert.equal(f.observations.length, 0);
  text = text.replace('data: [DONE]\n\n', ''); await assert.rejects(completeAiriChat(args), /未完整结束/);
});

test('真实角色服务保留原生图片和工具协议字段', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'character-life-multimodal-')); let body;
  const sharedAI = { config: () => ({ enabled: true, provider: 'openai', baseUrl: 'https://local.invalid', model: 'test' }), fetch: async (_url, options) => { body = JSON.parse(options.body); return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '看到了' }, finish_reason: 'stop' }] }); } };
  const life = new CharacterLife({ store: { requireCharacter: () => character }, dataDir: directory, sharedAI });
  life.configure(character.id,{mode:'full'});
  t.after(async () => { await life.close(); await rm(directory, { recursive: true, force: true }); });
  const messages = [{ role: 'user', content: [{ type: 'text', text: '看一下' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'look', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call1', content: '<JSONPatch>原始工具输出</JSONPatch>' }];
  await completeAiriChat({ life, character, sharedAI, value: { messages } });
  assert.deepEqual(body.messages.slice(-3), messages);
});
