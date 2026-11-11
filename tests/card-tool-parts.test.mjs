import test from 'node:test';
import assert from 'node:assert/strict';
const parts = await import('../integrations/xiaoxi/tools/card-tools.mjs').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });

test('制卡能力包含读取、世界书、MVU、EJS、待确认写入、检查诊断和导出', () => {
  assert.ok(Array.isArray(parts.CARD_TOOLS));
  assert.deepEqual(parts.CARD_TOOLS.map(tool => tool.function.name).sort(), ['read_card', 'generate_worldbook', 'generate_mvu', 'generate_ejs', 'prepare_card_changes', 'apply_card_changes', 'check_card', 'diagnose_card', 'export_card'].sort());
});

test('MVU 生成连接四项世界书、结构脚本和正则，保留已有扩展且不写文件', () => {
  assert.equal(typeof parts.generateCardParts, 'function');
  const source = { 'extra.json': JSON.stringify({ custom: 1, extensions: { tavern_helper: { scripts: [{ id: 'keep', name: '自定义', content: '保留' }] } } }) };
  const files = parts.generateCardParts('generate_mvu', { book: '变量', definition: { groups: [{ name: '状态', fields: [{ name: '好感度', type: 'number', min: 0, max: 100, default: 10 }] }] } }, source);
  const extra = JSON.parse(files.find(file => file.path === 'extra.json').content);
  assert.equal(extra.custom, 1); assert.equal(extra.extensions.tavern_helper.scripts[0].id, 'keep');
  assert.ok(extra.extensions.tavern_helper.scripts.some(script => script.content.includes('registerMvuSchema')));
  assert.ok(extra.extensions.regex_scripts.length >= 4);
  const init = files.find(file => file.path.endsWith('01-初始变量.yaml'));
  assert.match(init.content, /enabled: false/); assert.match(init.content, /\[InitVar\]/);
  assert.match(files.find(file => file.path.endsWith('02-变量列表.md')).content, /format_message_variable/);
  assert.match(files.find(file => file.path.endsWith('03-更新规则.md')).content, /好感度/);
  assert.match(files.find(file => file.path.endsWith('04-输出格式.md')).content, /JSONPatch/);
  assert.equal(JSON.parse(source['extra.json']).extensions.tavern_helper.scripts.length, 1);
});

test('世界书与 EJS 生成返回可写入的配对文件，MVU 非法字段和越界路径被拒绝', () => {
  assert.equal(typeof parts.generateCardParts, 'function');
  const book = parts.generateCardParts('generate_worldbook', { book: '背景', entries: [{ base: '01-天文台', name: '天文台', content: '{{user}} 来到天文台。', keys: ['天文台'] }] }, {});
  assert.equal(book.length, 2); assert.match(book[0].content, /\{\{user\}\}/); assert.match(book[1].content, /constant: false/);
  const ejs = parts.generateCardParts('generate_ejs', { book: '阶段', controller: { varPath: '状态.好感度', stages: [{ max: 50, entry: '陌生' }, { entry: '熟悉' }] }, statusbar: { title: '状态', groups: [{ name: '状态', fields: [{ name: '好感度' }] }] } }, {});
  assert.equal(ejs.length, 4); assert.match(ejs[0].content, /getwi/);
  assert.throws(() => parts.generateCardParts('generate_mvu', { definition: { groups: [{ name: '状态', fields: [{ name: 'x', type: 'magic' }] }] } }, {}), /类型/);
  assert.throws(() => parts.validateSourceChanges([{ path: '../other/card.json', content: '{}' }], {}), /路径/);
  assert.throws(() => parts.validateSourceChanges([{ path: 'extra.json', content: '{bad' }], {}), /JSON/);
  assert.throws(() => parts.validateSourceChanges([{ path: 'text/description.md', content: 'a' }, { path: 'text/description.md', content: 'b' }], {}), /重复/);
});

test('明确写入请求接受自然表达，否定、疑问、条件、改稿和引用不能授权', () => {
  assert.equal(typeof parts.isExplicitCardWriteRequest, 'function');
  for (const text of ['确认写入', '按这版写入并导出', '就这样吧，写入世界书', '这版可以，帮我保存进去', '按新稿写入',
    '我确认刚才展示的完整修改稿。请按这份稿写入这些文件，不再扩写。', '我同意按这份完整修改稿写入']) assert.equal(parts.isExplicitCardWriteRequest(text), true, text);
  for (const text of ['不要写入，先解释', '可以', '可以写入吗？', '可以写入吗', '请把姓名改成小明再写入', '如果没问题就保存', '先改一下再写入', '“确认写入”是什么意思', '她说确认写入', '暂时不要保存', '等我检查后再写入',
    '我确认完整修改稿，但不要写入', '请先修改稿再写入', '我确认按完整修改稿写入，如果没问题的话', '请按完整修改稿先调整再写入，不再扩写。',
    '请完整修改稿件再写入', '我确认要完整修改稿件再写入，不再扩写。']) assert.equal(parts.isExplicitCardWriteRequest(text), false, text);
});

test('已有 MVU 结构不会与新规则静默混用，显式更新保留脚本 ID', () => {
  const definition = { groups: [{ name: '状态', fields: [{ name: '好感度', type: 'number', default: 1 }] }] };
  const first = parts.generateCardParts('generate_mvu', { definition }, {});
  const source = Object.fromEntries(first.map(file => [file.path, file.content]));
  const updated = structuredClone(definition); updated.groups[0].fields[0].name = '信任';
  assert.throws(() => parts.generateCardParts('generate_mvu', { definition: updated }, source), /已有.*脚本/);
  const next = parts.generateCardParts('generate_mvu', { definition: updated, replaceGenerated: true }, source);
  const before = JSON.parse(source['extra.json']).extensions.tavern_helper.scripts;
  const after = JSON.parse(next.find(file => file.path === 'extra.json').content).extensions.tavern_helper.scripts;
  assert.deepEqual(after.map(script => script.id), before.map(script => script.id));
  assert.match(after[1].content, /信任/);
});
