import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCharacter, processCharacterOutput } from '../framework/character-runtime/index.mjs';
import { WorkbenchStore } from '../framework/store.mjs';
import { newCharacter } from '../framework/contracts.mjs';
import { CharacterLife } from '../framework/character-life/service.mjs';

const card = (scripts, extra = {}) => ({ name: '脚本检查角色', raw: { name: '脚本检查角色', ...extra, extensions: { tavern_helper: { scripts: scripts.map((content, index) => ({ id: String(index), name: `脚本 ${index}`, enabled: true, content })) } } } });
const enabled = { scriptsEnabled: true };

test('初始化、脚本和模板的新变量进入同一轮实际模型提示，预演不写状态', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'character-runtime-context-'));
  const store = new WorkbenchStore(directory);
  const input = card(['setvar("scriptValue", 42);'], { description: '<% setvar("templateValue", 6) %>保持自然。', first_mes: '你好<initvar>hp: 8</initvar>' });
  const character = store.saveCharacter(newCharacter({ name: input.name, raw: input.raw }));
  const life = new CharacterLife({ store, dataDir: directory, sharedAI: { complete: async () => ({ text: '{}' }) } });
  t.after(async () => { await life.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  life.configure(character.id, { mode: 'full', runtime: enabled });
  const context = await life.preview(character.id, { moduleId: 'qq', text: '你好' });
  const promptState = JSON.parse(/连续状态[^\n]*\n([^\n]+)/.exec(context.messages.find(message => message.role === 'system').content)[1]);
  assert.deepEqual(promptState.variables, context.runtimeContext.variables);
  assert.equal(promptState.variables.scriptValue, 42);
  assert.equal(promptState.variables.templateValue, 6);
  assert.equal(promptState.variables.stat_data.hp, 8);
  assert.deepEqual(life.state(character.id).variables, {});
});

test('脚本消息增删改进入模型历史，后续脚本可读到前一支的结果，输入副本不变', async () => {
  const history = [{ role: 'user', content: '原消息' }, { role: 'assistant', content: '删除这条' }];
  const result = await renderCharacter(card([
    'setChatMessages([{message_id:0,message:"改过的消息"}]);deleteChatMessages([1]);createChatMessages([{role:"assistant",message:"新增消息"}]);',
    'setvar("seen",getChatMessage(0).message);',
  ]), { settings: enabled, history });
  assert.deepEqual(result.history.map(({ role, content }) => ({ role, content })), [{ role: 'user', content: '改过的消息' }, { role: 'assistant', content: '新增消息' }]);
  assert.equal(result.variables.seen, '改过的消息');
  assert.equal(history[0].content, '原消息');
  assert.equal(history.length, 2);
});

test('改写多模态消息的文字保留图片、工具调用和工具结果字段', async () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: '旧文字' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call', content: '{"ok":true}' },
  ];
  const result = await renderCharacter(card(['setChatMessages([{message_id:0,message:"新文字"}]);']), { settings: enabled, history });
  assert.equal(result.history[0].content[0].text, '新文字');
  assert.deepEqual(result.history[0].content[1], history[0].content[1]);
  assert.deepEqual(result.history[1].tool_calls, history[1].tool_calls);
  assert.equal(result.history[1].content, null);
  assert.deepEqual(result.history[2], history[2]);
});

test('MVU 初始化回调看到初值并能修正，本会话再次渲染不重复初始化', async () => {
  const character = card(['eventOn(Mvu.events.VARIABLE_INITIALIZED,(v,swipe)=>{v.stat_data.hp=10;v.initialized=(v.initialized||0)+1;v.swipe=swipe;});'], { first_mes: '<initvar>hp: 8</initvar>' });
  const first = await renderCharacter(character, { settings: enabled });
  assert.equal(first.variables.stat_data.hp, 10);
  assert.equal(first.variables.initialized, 1);
  assert.equal(first.variables.swipe, 0);
  const second = await renderCharacter(character, { settings: enabled, variables: first.variables });
  assert.equal(second.variables.initialized, 1);
});

test('更新开始、命令修正、应用、更新结束和写回前按真实阶段执行，脚本主体只加载一次', async () => {
  const character = card([`
    setvar('loads',(getvar('loads')||0)+1);const phases=[];let start;
    eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,v=>{start=v.stat_data.hp;v.stat_data.hp=9;phases.push('started');});
    eventOn(Mvu.events.COMMAND_PARSED,(v,commands,source)=>{if(v.stat_data.hp!==9)throw Error('开始回调没有生效');if(!source.includes('错误路径'))throw Error('缺少原文');commands[0].args[0]='hp';commands[0].args[1]='12';phases.push('parsed');});
    eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,(v,old)=>{if(v.stat_data.hp!==12||old.stat_data.hp!==8||start!==8)throw Error('更新前后快照错误');v.stat_data.hp=10;phases.push('ended');});
    eventOn(Mvu.events.BEFORE_MESSAGE_UPDATE,context=>{if(context.variables.stat_data.hp!==10)throw Error('结束回调没有生效');context.variables.ready=true;context.message_content='新正文';phases.push('before');});
    eventOn(tavern_events.MESSAGE_RECEIVED,()=>{phases.push('received');setvar('phases',phases);});
  `]);
  const result = await processCharacterOutput("旧正文<UpdateVariable>_.set('错误路径', 99);</UpdateVariable>", { character, variables: { stat_data: { hp: 8 } }, settings: enabled, history: [{ role: 'assistant', content: '旧正文' }] });
  assert.deepEqual(result.variables.phases, ['started', 'parsed', 'ended', 'before', 'received']);
  assert.equal(result.variables.loads, 1);
  assert.equal(result.variables.stat_data.hp, 10);
  assert.equal(result.variables.ready, true);
  assert.equal(result.variables.stat_data.错误路径, undefined);
  assert.equal(result.text, '新正文');
  assert.equal(result.trace.some(row => row.error), false, JSON.stringify(result.trace));
});

test('所有脚本先注册再依次派发各阶段，JSONPatch 可通过命令参数修正，指针转义保留', async () => {
  const character = card([
    'eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,v=>{v.stat_data.hp=10;});eventOn(Mvu.events.COMMAND_PARSED,(v,commands)=>{commands[0].args[1]="2";});',
    'eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,v=>{v.stat_data.hp+=1;});eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,v=>{v.observed=v.stat_data.hp;});',
  ]);
  const result = await processCharacterOutput('<JSONPatch>[{"op":"delta","path":"/hp","value":1},{"op":"replace","path":"/a~1b","value":3}]</JSONPatch>', { character, settings: enabled, variables: { stat_data: { hp: 8, 'a/b': 0 } } });
  assert.equal(result.variables.stat_data.hp, 13);
  assert.equal(result.variables.observed, 13);
  assert.equal(result.variables.stat_data['a/b'], 3);
});

test('JSONPatch 命令也保留 op/path/value 接口供回调改写', async () => {
  const character = card(['eventOn(Mvu.events.COMMAND_PARSED,(v,commands)=>{commands[0].value=12;});']);
  const result = await processCharacterOutput('<JSONPatch>[{"op":"replace","path":"/hp","value":9}]</JSONPatch>', { character, settings: enabled, variables: { stat_data: { hp: 8 } } });
  assert.equal(result.variables.stat_data.hp, 12);
});

test('消息接收监听改写本轮显示文字，输入历史仍保持原样', async () => {
  const history = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '原回复' }];
  const character = card(['eventOn(tavern_events.MESSAGE_RECEIVED,id=>setChatMessages([{message_id:id,message:"脚本改写的回复"}]));']);
  const result = await processCharacterOutput('原回复', { character, settings: enabled, history });
  assert.equal(result.text, '脚本改写的回复');
  assert.equal(history[1].content, '原回复');
});

test('未启用脚本时不派发回调，格式损坏的变量块仍隐藏并保持原子失败', async () => {
  const character = card(['eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>setvar("unexpected",true));']);
  const result = await processCharacterOutput('你好<JSONPatch>[{"op":"replace","path":"/hp","value":7}]', { character, settings: { scriptsEnabled: false }, variables: { stat_data: { hp: 8 } } });
  assert.equal(result.text, '你好');
  assert.equal(result.variables.stat_data.hp, 8);
  assert.equal(result.variables.unexpected, undefined);
  assert.ok(result.trace.some(row => /未闭合/.test(row.error ?? '')));
});

test('一个监听替换整棵变量后，同阶段后续监听和后续阶段读取替换后的值', async () => {
  const character = card([
    'eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>replaceVariables({stat_data:{hp:10}}));eventOn(Mvu.events.BEFORE_MESSAGE_UPDATE,ctx=>{ctx.variables={...ctx.variables,ready:true};});',
    'eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,v=>{v.stat_data.hp+=1;});eventOn(Mvu.events.BEFORE_MESSAGE_UPDATE,ctx=>{ctx.variables.sawReady=ctx.variables.ready;});',
  ]);
  const result = await processCharacterOutput('<JSONPatch>[{"op":"delta","path":"/hp","value":2}]</JSONPatch>', { character, settings: enabled, variables: { stat_data: { hp: 8 } } });
  assert.equal(result.variables.stat_data.hp, 13);
  assert.equal(result.variables.sawReady, true);
});

test('命令回调可追加原生和 JSONPatch 命令，同一变量块失败不提交部分补丁', async () => {
  const character = card(['eventOn(Mvu.events.COMMAND_PARSED,(v,commands)=>{commands.push({type:"set",args:["extra","3"],full_match:"",reason:""});commands.push({op:"add",path:"/patchExtra",value:4});});']);
  const result = await processCharacterOutput('<JSONPatch>[{"op":"replace","path":"/hp","value":9},{"op":"replace","path":"/missing","value":1}]</JSONPatch>', { character, settings: enabled, variables: { stat_data: { hp: 8 } } });
  assert.equal(result.variables.stat_data.hp, 8);
  assert.equal(result.variables.stat_data.extra, 3);
  assert.equal(result.variables.stat_data.patchExtra, 4);
  assert.ok(result.trace.some(row => row.error?.includes('路径不存在')));
});

test('消息接收事件使用删除后的实际消息编号，脚本主体改写回复也能显示', async () => {
  const character = card(['deleteChatMessages([0]);setChatMessages([{message_id:0,message:"主体修改"}]);eventOn(tavern_events.MESSAGE_RECEIVED,id=>{const message=getChatMessage(id);setChatMessages([{message_id:id,message:message.message+"与事件修改"}]);});']);
  const result = await processCharacterOutput('原回复', { character, settings: enabled, history: [{ role: 'user', content: '原问题' }, { role: 'assistant', content: '原回复' }] });
  assert.equal(result.text, '主体修改与事件修改');
});

test('初始化历史拼写和标准拼写监听均能响应，失败脚本不留下变量或监听', async () => {
  const character = card([
    'setvar("bad",true);eventOn(Mvu.events.VARIABLE_INITIALIZED,v=>{v.badEvent=true;});throw Error("脚本加载失败");',
    'eventOn("mag_variable_initialized",v=>{v.modern=true;});eventOn("mag_variable_initiailized",v=>{v.legacy=true;});',
  ]);
  const result = await renderCharacter(character, { settings: enabled });
  assert.equal(result.variables.bad, undefined);
  assert.equal(result.variables.badEvent, undefined);
  assert.equal(result.variables.modern, true);
  assert.equal(result.variables.legacy, true);
  assert.ok(result.trace.some(row => row.name === '脚本 0' && row.error === '脚本加载失败'));
});

test('失败的生命周期监听回滚自己的改动，合法模型补丁和其他监听仍执行', async () => {
  const character = card([
    'eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,v=>{v.stat_data.hp=99;throw Error("结束监听失败");});',
    'eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,v=>{v.otherSaw=v.stat_data.hp;});',
  ]);
  const result = await processCharacterOutput('<JSONPatch>[{"op":"replace","path":"/hp","value":9}]</JSONPatch>', { character, settings: enabled, variables: { stat_data: { hp: 8 } } });
  assert.equal(result.variables.stat_data.hp, 9);
  assert.equal(result.variables.otherSaw, 9);
  assert.ok(result.trace.some(row => row.error?.includes('结束监听失败')));
});

test('失败的异步初始化等待同批回调结束后整体回滚，不泄漏迟到变量', async () => {
  const character = card(['$(()=>{throw Error("初始化失败")});$(async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();setvar("leaked",true)});', 'setvar("good",1);']);
  const result = await renderCharacter(character, { settings: enabled });
  assert.equal(result.variables.leaked, undefined);
  assert.equal(result.variables.good, 1);
  assert.ok(result.trace.some(row => row.error?.includes('初始化失败')));
});

test('失败脚本撤销提示词后仍恢复前一支脚本的完整动作和轨迹', async () => {
  const result = await renderCharacter(card(['setvar("good",1);injectPrompt("guard","有效提示");', 'uninjectPrompts(["guard"]);throw Error("第二支失败");']), { settings: enabled });
  assert.equal(result.variables.good, 1);
  assert.ok(result.afterMessages.some(message => message.content === '有效提示'));
  assert.ok(result.trace.some(row => row.name === '脚本 0' && row.executed));
  assert.ok(result.trace.some(row => row.name === '脚本 1' && row.error === '第二支失败'));
});

test('无论脚本是否开启，超出有限数值范围的命令都失败且不变成 null', async () => {
  for (const source of ["<UpdateVariable>_.set('hp',1e999);</UpdateVariable>", '<JSONPatch>[{"op":"replace","path":"/hp","value":1e999}]</JSONPatch>']) {
    for (const scriptsEnabled of [false, true]) {
      const result = await processCharacterOutput(source, { character: card([';']), settings: { scriptsEnabled }, variables: { stat_data: { hp: 8 } } });
      assert.equal(result.variables.stat_data.hp, 8, source + String(scriptsEnabled));
      assert.ok(result.trace.some(row => row.error?.includes('有限')));
    }
  }
});

test('删除当前输出后发生后续脚本或监听错误，输出保持删除状态而不是 undefined', async () => {
  for (const scripts of [
    ['deleteChatMessages([0]);', 'throw Error("后续脚本失败");'],
    ['eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>deleteChatMessages([0]));', 'eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>{throw Error("后续监听失败")});'],
  ]) {
    const result = await processCharacterOutput('原回复', { character: card(scripts), settings: enabled, history: [{ role: 'assistant', content: '原回复' }] });
    assert.equal(result.text, '');
    assert.ok(result.trace.some(row => row.error?.includes('失败')));
  }
});

test('异步初始化中嵌套派发事件不会等待自身，事件后的变量仍完成写入', async () => {
  for (const trailing of ['', 'await Promise.resolve();']) {
    const result = await renderCharacter(card([`eventOn('custom',()=>setvar('seen',true));$(async()=>{await eventEmit('custom');setvar('after',true)});${trailing}`]), { settings: enabled });
    assert.equal(result.variables.seen, true);
    assert.equal(result.variables.after, true);
    assert.equal(result.trace.some(row => row.error), false, JSON.stringify(result.trace));
  }
});
