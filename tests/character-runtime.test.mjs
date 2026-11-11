import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { parseCharacter, decodeCharacterPng, renderCharacter, processCharacterOutput, runCharacterScript } from '../framework/character-runtime/index.mjs';

const character = data => ({ id: 'momo', revision: 1, name: '茉茉', raw: { spec: 'chara_card_v2', data: { name: '茉茉', ...data } } });
const entry = (id, content, extra = {}) => ({ id, content, keys: [], enabled: true, ...extra });

test('normalizes v1/v2/v3 without modifying source and preserves raw extensions', () => {
  const input = character({ description: '陪伴 {{user}}', extensions: { custom: { retained: true } } });
  const before = structuredClone(input);
  const parsed = parseCharacter(input);
  assert.equal(parsed.characterId, 'momo');
  assert.equal(parsed.raw.data.extensions.custom.retained, true);
  assert.equal(parseCharacter({ name: '旧卡', description: '旧描述' }).description, '旧描述');
  parsed.raw.data.name = '副本';
  assert.deepEqual(input, before);
  assert.throws(() => parseCharacter('{broken'), /JSON|角色/);
});

test('reads PNG chara metadata and rejects damaged chunks', () => {
  function chunk(type, data) { const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(type, 4); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([header, data, crc]); }
  const raw = character({ description: '原卡' }).raw;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('tEXt', Buffer.from('chara\0' + Buffer.from(JSON.stringify(raw)).toString('base64'))), chunk('IEND', Buffer.alloc(0))]);
  assert.deepEqual(decodeCharacterPng(png), raw);
  png[30] ^= 1;
  assert.throws(() => decodeCharacterPng(png), /CRC|损坏/);
});

test('lore recursion, secondary logic, probability, external books and insertion depth are observable', async () => {
  const card = character({ character_book: { recursive_scanning: true, scan_depth: 2, entries: [
    entry(1, '王宫', { keys: ['森林'] }), entry(2, '见到女王', { keys: ['王宫'], extensions: { position: 4, depth: 2, role: 0 } }),
    entry(3, '不出现', { constant: true, extensions: { probability: 0, useProbability: true } }),
    entry(4, '双条件', { keys: ['森林'], secondary_keys: ['雨'], selective: true, selectiveLogic: 3 }),
  ] }, extensions: { world: '天气' } });
  const result = await renderCharacter(card, { latestInput: '森林下雨', worldbooks: [{ name: '天气', entries: [entry('sun', '天色将晚', { constant: true })] }], seed: 1 });
  assert.match(result.lore, /王宫/);
  assert.match(result.lore, /天色将晚/);
  assert.match(result.lore, /双条件/);
  assert.doesNotMatch(result.lore, /不出现/);
  assert.ok(result.afterMessages.some(message => message.depth === 2 && message.content === '见到女王'));
  assert.ok(result.trace.some(row => row.reason === 'probability'));
  assert.ok(result.trace.some(row => row.reason === 'recursion'));
});

test('worldbook budget counts rendered content and excludes overflow without truncation', async () => {
  const result = await renderCharacter(character({ character_book: { entries: [entry(1, '123456', { constant: true }), entry(2, 'ok', { constant: true })] } }), { settings: { worldbookBudgetChars: 3 } });
  assert.equal(result.lore, 'ok');
  assert.ok(result.trace.some(row => row.reason === 'budget'));
});

test('EJS executes conditions loops and async helpers, with macro variables and YAML initialization', async () => {
  const result = await renderCharacter(character({ description: '<% for (const x of [1,2]) { %><%= x %><% } %> <%- await getvar("stat_data.hp") %> {{user}} {{getvar::stat_data.hp}}', character_book: { entries: [entry(1, 'hp: 8\nbag:\n  - 苹果', { comment: '[InitVar]', enabled: false })] } }), { userName: '念念' });
  assert.match(result.profile, /12 8 念念 8/);
  assert.equal(result.variables.stat_data.hp, 8);
  assert.deepEqual(result.variables.stat_data.bag, ['苹果']);
});

test('EJS errors and disabled scripts remain visible in trace and never leak template source into prompt', async () => {
  const result = await renderCharacter(character({ description: '<%= noSuchVariable %>', extensions: { tavern_helper: { scripts: [{ name: '试验', content: 'setvar("ok", 1);' }] } } }), { settings: { scriptsEnabled: false } });
  assert.doesNotMatch(result.profile, /<%/);
  assert.ok(result.trace.some(row => row.error?.includes('noSuchVariable')));
  assert.ok(result.trace.some(row => row.reason === 'scripts-disabled'));
});

test('RFC6902 patch preserves pointer escaping and array operations atomically', async () => {
  const variables = { stat_data: { hp: 8, bag: ['a'], 'a/b': 1 } };
  const patch = [{ op: 'add', path: '/stat_data/bag/-', value: 'b' }, { op: 'replace', path: '/stat_data/a~1b', value: 2 }, { op: 'test', path: '/stat_data/hp', value: 8 }];
  const result = await processCharacterOutput('你好<UpdateVariable><JSONPatch>' + JSON.stringify(patch) + '</JSONPatch></UpdateVariable>', { variables });
  assert.equal(result.text, '你好');
  assert.deepEqual(result.variables.stat_data.bag, ['a', 'b']);
  assert.equal(result.variables.stat_data['a/b'], 2);
  assert.deepEqual(variables.stat_data.bag, ['a']);
  const failed = await processCharacterOutput('<JSONPatch>' + JSON.stringify([...patch, { op: 'replace', path: '/missing', value: 1 }]) + '</JSONPatch>', { variables });
  assert.deepEqual(failed.variables, variables);
  assert.ok(failed.trace.some(row => row.error));
});

test('official MVU delta/insert/move and native set/add/remove dialects execute', async () => {
  const initial = { stat_data: { hp: 8, bag: { apple: 1 } } };
  const official = await processCharacterOutput('<JSONPatch>' + JSON.stringify([{ op: 'delta', path: '/hp', value: -2 }, { op: 'insert', path: '/bag/pear', value: 2 }, { op: 'move', from: '/bag/apple', path: '/bag/redApple' }]) + '</JSONPatch>', { variables: initial });
  assert.equal(official.variables.stat_data.hp, 6);
  assert.deepEqual(official.variables.stat_data.bag, { pear: 2, redApple: 1 });
  const native = await processCharacterOutput("<UpdateVariable>_.set('hp', 8, 7); _.add('hp', 2); _.insert('bag', 'pear', 3); _.remove('bag.apple');</UpdateVariable>", { variables: initial });
  assert.equal(native.variables.stat_data.hp, 9);
  assert.deepEqual(native.variables.stat_data.bag, { pear: 3 });
});

test('variable patch rejects prototype paths and native arbitrary JS', async () => {
  const result = await processCharacterOutput('<JSONPatch>[{"op":"add","path":"/__proto__/polluted","value":true}]</JSONPatch>', { variables: {} });
  assert.equal({}.polluted, undefined);
  assert.ok(result.trace.some(row => row.error));
  const native = await processCharacterOutput('<UpdateVariable>globalThis.polluted=true; _.set("ok", 1);</UpdateVariable>', { variables: {} });
  assert.ok(native.trace.some(row => row.error));
  assert.equal(native.variables.ok, undefined);
});

test('output regex produces status HTML, respects display versus prompt and hides update blocks', async () => {
  const card = character({ extensions: { regex_scripts: [
    { findRegex: '/STATUS/g', replaceString: '<div>HP {{getvar::stat_data.hp}}</div>', placement: [2], markdownOnly: true, promptOnly: false },
    { findRegex: '/secret/g', replaceString: '', placement: [2], markdownOnly: false, promptOnly: true },
  ] } });
  const result = await processCharacterOutput('你好 STATUS secret', { character: card, variables: { stat_data: { hp: 9 } } });
  assert.ok(result.html.some(item => item.html.includes('HP 9')));
  assert.match(result.text, /secret/);
  assert.doesNotMatch(result.text, /<div>/);
  const prompt = await renderCharacter(card, { history: [{ role: 'assistant', content: 'secret' }] });
  assert.equal(prompt.history[0].content, '');
});

test('Tavern Helper subset updates variables, messages and event listeners with isolated contexts', async () => {
  const result = await runCharacterScript(`await waitGlobalInitialized('Mvu'); eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, v => { v.stat_data.hp = Math.min(10, v.stat_data.hp); }); await eventEmit(Mvu.events.VARIABLE_UPDATE_ENDED, variables); updateVariablesWith(v => ({...v, seen:true}), {type:'chat'}); createChatMessages([{role:'assistant',message:'准备好了'}]); injectPrompt('guard','请保持耐心',100);`, { variables: { stat_data: { hp: 20 } }, messages: [] });
  assert.equal(result.variables.stat_data.hp, 10);
  assert.equal(result.variables.seen, true);
  assert.equal(result.messages[0].message, '准备好了');
  assert.ok(result.actions.some(action => action.type === 'inject-prompt'));
  const next = await runCharacterScript('return typeof process + ":" + typeof require + ":" + typeof fetch;', {});
  assert.equal(next.result, 'undefined:undefined:undefined');
});

test('QuickJS interrupts infinite loops and rejects unsupported host APIs', async () => {
  await assert.rejects(runCharacterScript('while(true){}', { timeoutMs: 30 }), /超时|interrupted|限制/);
  await assert.rejects(runCharacterScript('return globalThis.constructor.constructor("return process")();'), /process/);
  await assert.rejects(runCharacterScript('await generate({});'), /不支持.*generate/);
});

test('enabled imported scripts run on render and MVU output events', async () => {
  const card = character({ extensions: { tavern_helper: { scripts: [{ name: 'clamp', enabled: true, content: 'eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, v => { v.stat_data.hp = Math.min(10, v.stat_data.hp); });' }] } } });
  const result = await processCharacterOutput('<JSONPatch>[{"op":"replace","path":"/hp","value":20}]</JSONPatch>', { character: card, variables: { stat_data: { hp: 8 } }, settings: { scriptsEnabled: true } });
  assert.equal(result.variables.stat_data.hp, 10);
});

test('prompt order is a real card field and scan depth zero excludes old messages', async () => {
  const card = character({ description: '描述', personality: '性格', extensions: { workbench: { prompt_order: ['personality', 'description'] } }, character_book: { entries: [entry(1, '旧关键词触发', { keys: ['过去'], extensions: { scan_depth: 0 } })] } });
  const result = await renderCharacter(card, { latestInput: '现在', history: [{ role: 'user', content: '过去' }] });
  assert.ok(result.profile.indexOf('性格：') < result.profile.indexOf('角色设定：'));
  assert.equal(result.lore, '');
});

test('greeting initvar initializes only once and is not exposed in opening', async () => {
  const card = character({ first_mes: '你好<initvar>hp: 12</initvar>' });
  const first = await renderCharacter(card);
  assert.equal(first.variables.stat_data.hp, 12);
  assert.equal(first.opening, '你好');
  const again = await renderCharacter(card, { variables: { ...first.variables, stat_data: { hp: 3 } } });
  assert.equal(again.variables.stat_data.hp, 3);
});

test('native set creates nested paths and replaces array elements without insertion', async () => {
  const result = await processCharacterOutput("<UpdateVariable>_.set('bag[0]', 'apple', 'pear'); _.set('status.feeling', '好');</UpdateVariable>", { variables: { stat_data: { bag: ['apple','orange'] } } });
  assert.deepEqual(result.variables.stat_data.bag, ['pear','orange']);
  assert.equal(result.variables.stat_data.status.feeling, '好');
});

test('malformed variable container cannot apply a partial nested patch', async () => {
  const result = await processCharacterOutput('<UpdateVariable><JSONPatch>[{"op":"add","path":"/hp","value":9}]</JSONPatch>', { variables: {} });
  assert.deepEqual(result.variables, {});
  assert.ok(result.trace.some(row => /未闭合/.test(row.error ?? '')));
});

test('script variable replacement updates the public variables binding', async () => {
  const result = await runCharacterScript('replaceVariables({hp:2}); variables.hp += 1; return getvar("hp");');
  assert.equal(result.variables.hp, 3);
  assert.equal(result.result, 3);
});

test('sandbox has a wall clock limit even for pathological regular expressions', { timeout: 8000 }, async () => {
  const started = Date.now();
  await assert.rejects(runCharacterScript('return /^(a+)+$/.test("a".repeat(10000) + "!");', { timeoutMs: 30 }), /超时|interrupted|限制/);
  assert.ok(Date.now() - started < 4000);
});

test('prompt regex preserves multimodal and tool call protocol messages', async () => {
  const card = character({ extensions: { regex_scripts: [{ findRegex: '/secret/g', replaceString: '', placement: [1,2], promptOnly: true }] } });
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'secret hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '{"secret":"protocol"}' },
  ];
  const result = await renderCharacter(card, { history });
  assert.equal(result.history[0].content[0].text, 'hello');
  assert.deepEqual(result.history[0].content[1], history[0].content[1]);
  assert.deepEqual(result.history[1], history[1]);
  assert.deepEqual(result.history[2], history[2]);
});

test('legacy MVU value-description tuples preserve metadata and publish display changes', async () => {
  const card = character({ character_book: { entries: [entry(1, '{ hp: [8, "体力说明"], // comment\n }', { comment: '[InitVar]', enabled: false })] } });
  const rendered = await renderCharacter(card);
  assert.deepEqual(rendered.variables.stat_data.hp, [8, '体力说明']);
  const result = await processCharacterOutput("<UpdateVariable>_.set('hp', 8, 6); _.add('hp', 1);</UpdateVariable>", { variables: rendered.variables });
  assert.deepEqual(result.variables.stat_data.hp, [7, '体力说明']);
  assert.match(result.variables.display_data.hp, /6.*7/);
});

test('EJS variable helper options apply defaults, conditions and numeric bounds', async () => {
  const result = await runCharacterScript('setvar("hp", getvar("missing", {defaults:4})); setvar("hp", 9, {flags:"nx"}); incvar("hp", 100, {max:10}); return getvar("hp");');
  assert.equal(result.result, 10);
});
