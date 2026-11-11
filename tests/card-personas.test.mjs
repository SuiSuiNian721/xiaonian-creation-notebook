import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as personas from '../integrations/xiaoxi/tools/personas.mjs';
import { buildBridgeMessages } from '../integrations/xiaoxi/tools/bridge-messages.mjs';
import { prepareConversationMemory, fingerprintConversationHistory } from '../integrations/xiaoxi/tools/conversation-memory.mjs';
import { queryConversationHistory } from '../integrations/xiaoxi/tools/conversation-history.mjs';
import { prepareChatRetry } from '../integrations/xiaoxi/tools/chat-retries.mjs';
import { readChatAvatar, readChatAvatars, saveChatAvatar } from '../integrations/xiaoxi/tools/chat-avatars.mjs';
import { createCodexBridge } from '../integrations/xiaoxi/tools/codex-bridge.mjs';
import { prepareChatBranch } from '../integrations/xiaoxi/tools/chat-actions.mjs';
import { userProfileText } from '../integrations/xiaoxi/tools/user-profile.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-personas-'));
  for (const dir of ['work', 'workflow', 'personas']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'workflow', '小汐.md'), '林小汐专属身份。', 'utf8');
  fs.writeFileSync(path.join(root, 'personas', '茉茉.md'), '茉茉专属身份，用户为 {{user}}。', 'utf8');
  fs.writeFileSync(path.join(root, 'workflow', '助手共用规则.md'), '通用制卡规则：\n'+fs.readFileSync(new URL('../integrations/xiaoxi/workflow/助手共用规则.md',import.meta.url),'utf8'), 'utf8');
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('小汐只保留人物身份，制卡工作与表达规则统一注入所有人设', t => {
  const root=fixture(t),prompt=fs.readFileSync(new URL('../integrations/xiaoxi/workflow/小汐.md',import.meta.url),'utf8');
  assert.match(prompt,/17\s*岁/);assert.match(prompt,/165\s*cm/);assert.match(prompt,/猫娘/);assert.match(prompt,/天文学研究员/);assert.match(prompt,/安静|克制/);
  assert.doesNotMatch(prompt,/workflow\.json|src\/|artifacts|待确认稿|自动 build|制卡研究员/);
  fs.writeFileSync(path.join(root,'workflow','小汐.md'),prompt,'utf8');
  const own=personas.savePersona(root,{name:'星河',prompt:'你是星河，一名画家。'});
  for(const id of ['xiaoxi','neutral',own.id]){
    const composed=personas.readPersonaPrompt(root,id).text;
    assert.match(composed,/完整待确认稿/);assert.match(composed,/workflow\.json/);assert.match(composed,/@open:<stage>/);assert.match(composed,/本次对话的表达要求/);
    if(id!=='xiaoxi')assert.doesNotMatch(composed,/林小汐|165\s*cm|猫娘|天文学研究员/);
  }
});

test('OpenAI 桥兼容无 ID 旧待回复记录，新中性和自定义请求保持身份且不会重复生成', async t => {
  const root = fixture(t), customPersona = personas.savePersona(root, { name: '桥接测试', prompt: '按当前身份讨论。' });
  const source = fs.readFileSync(new URL('../integrations/xiaoxi/tools/bridge.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').split('const cfg = loadCfg();')[0] + '\nglobalThis.onceForTest = once;';
  for (const id of [undefined, 'neutral', customPersona.id]) {
    let pending = [{ role: 'user', at: '2026-01-01T00:00:00.000Z', text: '讨论故事。', cardName: '兼容卡', conversationId: 'main', ...(id ? { personaId: id } : {}) }];
    const expectedId = id || 'xiaoxi';
    let completions = 0;
    const replies = [];
    const sandbox = vm.createContext({ fs, path, ROOT: root, process: { env: {}, on() {} },
      createConversationStore: () => ({}), readPersonaPrompt: personas.readPersonaPrompt,
      readUserProfile: () => ({ displayName: '' }), userProfileText, buildBridgeMessages,
      readChatVersionSelection: () => ({}), isChatRetry: () => false, chatContextHistory: value => value,
      AbortController, AbortSignal, setInterval: () => 0, clearInterval() {},
      requestBridgeCompletion: async ({ messages }) => { completions++; assert.ok(messages[0].content.includes(personas.personaById(expectedId, root).name)); return '隔离模型答复。'; },
      fetch: async (url, options) => {
        if (url.endsWith('/api/bridge/pending')) return Response.json({ pending });
        if (url.includes('/api/chat/')) return Response.json(pending);
        if (url.endsWith('/task-start')) return Response.json({ claimId: 'fixture-claim' });
        if (url.endsWith('/reply')) {
          const body = JSON.parse(options.body);
          if (body.personaId !== expectedId) return Response.json({ error: '回复人设与待回复消息不一致' }, { status: 400 });
          replies.push(body); pending = [];
        }
        return Response.json({ ok: true });
      },
    });
    new vm.Script(source).runInContext(sandbox);
    assert.equal(await sandbox.onceForTest({}), true);
    assert.equal(await sandbox.onceForTest({}), false);
    assert.equal(completions, 1);
    assert.equal(replies[0].personaId, expectedId);
    assert.equal(replies[0].personaName, personas.personaById(expectedId, root).name);
  }
});

function custom(root, name = '星河', prompt = '细致地陪伴用户创作。') {
  assert.equal(typeof personas.savePersona, 'function', '必须提供自定义人设保存接口');
  return personas.savePersona(root, { name, prompt });
}

test('无人设选择时默认中性，已有明确选择保持不变', t => {
  const root = fixture(t);
  assert.equal(personas.readPersonaSelection(root), 'neutral');
  for (const id of ['xiaoxi', 'momo', 'neutral']) {
    assert.equal(personas.writePersonaSelection(root, id), id);
    assert.equal(personas.readPersonaSelection(root), id);
  }
  assert.equal(personas.personaById('momo').name, '茉茉');
});

test('多个自定义人设独立保存、更新、复制并保留稳定 ID', t => {
  const root = fixture(t);
  const first = custom(root), second = custom(root, '青禾', '直率地提出建议。');
  assert.match(first.id, /^custom_[a-f0-9-]{36}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.builtin, false);
  const updated = personas.savePersona(root, { id: first.id, name: '星河新版', prompt: '以具体例子帮助构思。' });
  assert.equal(updated.id, first.id);
  assert.equal(personas.personaById(first.id, root).prompt, updated.prompt);
  assert.equal(personas.personaById(second.id, root).prompt, second.prompt);
  const all = personas.listPersonas(root);
  assert.deepEqual(all.slice(0, 3).map(item => item.id), ['neutral', 'xiaoxi', 'momo']);
  assert.ok(all.slice(0, 3).every(item => item.builtin && typeof item.prompt === 'string'));
  assert.match(all.find(item => item.id === 'xiaoxi').prompt, /林小汐专属/);
  const copy = custom(root, '林小汐副本', all.find(item => item.id === 'xiaoxi').prompt);
  assert.equal(copy.builtin, false);
  personas.writePersonaSelection(root, second.id);
  assert.equal(personas.readPersonaSelection(root), second.id);
  const data = fs.readFileSync(path.join(root, 'work', 'personas.json'));
  assert.notEqual(data.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.equal(JSON.parse(data).personas.length, 3);
  assert.deepEqual(fs.readdirSync(path.join(root, 'work')).sort(), ['persona-selection.json', 'personas.json']);
});

test('删除当前自定义人设退回中性，删除其他项不改变当前选择，内置项只读', t => {
  const root = fixture(t), first = custom(root), second = custom(root, '青禾');
  personas.writePersonaSelection(root, first.id);
  personas.deletePersona(root, second.id);
  assert.equal(personas.readPersonaSelection(root), first.id);
  personas.deletePersona(root, first.id);
  assert.equal(personas.readPersonaSelection(root), 'neutral');
  assert.throws(() => personas.personaById(first.id, root), /未知|不存在/);
  for (const id of ['neutral', 'xiaoxi', 'momo']) {
    assert.throws(() => personas.savePersona(root, { id, name: '覆盖', prompt: '覆盖' }), /内置|只读/);
    assert.throws(() => personas.deletePersona(root, id), /内置|只读/);
  }
});

test('拒绝危险 ID、非法字段和超限内容，失败不改原数据', t => {
  const root = fixture(t);
  custom(root);
  const file = path.join(root, 'work', 'personas.json'), before = fs.readFileSync(file);
  for (const id of ['__proto__', 'constructor', 'toString', '../momo', '..\\momo', 'custom_../x', '', null, 7]) {
    assert.throws(() => personas.personaById(id, root));
    assert.throws(() => personas.writePersonaSelection(root, id));
    assert.throws(() => personas.deletePersona(root, id));
    assert.throws(() => personas.savePersona(root, { id, name: '无效', prompt: '正文' }));
  }
  for (const value of [null, [], { name: '', prompt: '正文' }, { name: 'x'.repeat(61), prompt: '正文' },
    { name: '正常', prompt: '' }, { name: '正常', prompt: 'x'.repeat(20001) }, { name: '换\n行', prompt: '正文' },
    { name: '正常', prompt: '\0正文' }, JSON.parse('{"name":"正常","prompt":"正文","__proto__":{}}')]) {
    assert.throws(() => personas.savePersona(root, value));
  }
  assert.deepEqual(fs.readFileSync(file), before);
});

test('自定义人设数量上限不影响既有人设编辑', t => {
  const root = fixture(t), first = custom(root);
  for (let index = 1; index < 50; index++) custom(root, '助手' + index);
  assert.throws(() => custom(root, '第51个'), /50|上限/);
  assert.equal(personas.savePersona(root, { id: first.id, name: '更新', prompt: '更新正文' }).id, first.id);
  assert.equal(personas.listPersonas(root).length, 53);
});

test('损坏注册表和选择显式报错，不能静默覆盖', t => {
  const root = fixture(t), registry = path.join(root, 'work', 'personas.json');
  for (const bad of ['{broken', 'null', '{"version":1,"personas":{}}', '{"version":1,"personas":[{"id":"__proto__","name":"坏","prompt":"坏"}]}']) {
    fs.writeFileSync(registry, bad, 'utf8');
    assert.throws(() => personas.listPersonas(root), /人设|格式|损坏/);
    assert.throws(() => personas.readPersonaSelection(root), /人设|格式|损坏/);
    assert.throws(() => custom(root), /人设|格式|损坏/);
    assert.equal(fs.readFileSync(registry, 'utf8'), bad);
  }
  fs.unlinkSync(registry);
  fs.writeFileSync(path.join(root, 'work', 'persona-selection.json'), '{broken', 'utf8');
  assert.throws(() => personas.readPersonaSelection(root), /人设|格式|损坏/);
});

test('work junction 不能指向工作区外', t => {
  const root = fixture(t), outside = fixture(t), work = path.join(root, 'work');
  fs.rmdirSync(work);
  fs.symlinkSync(path.join(outside, 'work'), work, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => personas.listPersonas(root), /链接|junction/);
  assert.throws(() => personas.writePersonaSelection(root, 'neutral'), /链接|junction/);
  assert.throws(() => custom(root), /链接|junction/);
  assert.deepEqual(fs.readdirSync(path.join(outside, 'work')), []);
});

test('重复 ID、非法 UTF-8 和目录型注册表都显式拒绝', t => {
  const root = fixture(t), first = custom(root), file = path.join(root, 'work', 'personas.json');
  const record = { id: first.id, name: first.name, prompt: first.prompt };
  fs.writeFileSync(file, JSON.stringify({ version: 1, personas: [record, record] }), 'utf8');
  assert.throws(() => personas.listPersonas(root), /损坏/);
  fs.writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
  assert.throws(() => personas.listPersonas(root), /UTF-8|损坏/);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => personas.listPersonas(root), /普通文件/);
  assert.throws(() => custom(root), /普通文件/);
});

test('删除前选择配置异常时保留人设注册表，不部分删除当前项', t => {
  const root = fixture(t), first = custom(root), registry = path.join(root, 'work', 'personas.json');
  personas.writePersonaSelection(root, first.id);
  const before = fs.readFileSync(registry);
  fs.writeFileSync(path.join(root, 'work', 'persona-selection.json'), 'null', 'utf8');
  assert.throws(() => personas.deletePersona(root, first.id), /损坏/);
  assert.deepEqual(fs.readFileSync(registry), before);
});

test('中性和自定义提示不读内置人物正文，共用规则与程序授权保持独立', t => {
  const root = fixture(t), first = custom(root, '星河', '以星河身份交流，称呼 {{user}}。');
  fs.writeFileSync(path.join(root, 'work', 'user-profile.json'), JSON.stringify({ displayName: '念念', confirmed: true }), 'utf8');
  fs.unlinkSync(path.join(root, 'workflow', '小汐.md'));
  fs.unlinkSync(path.join(root, 'personas', '茉茉.md'));
  const neutral = personas.readPersonaPrompt(root, 'neutral');
  assert.equal(neutral.name, '中性助手');
  assert.doesNotMatch(neutral.text, /林小汐专属|茉茉专属|所爱的人/);
  assert.match(neutral.text, /通用制卡规则/);
  assert.match(neutral.text, /写入授权|程序授权/);
  assert.match(neutral.text, /本次对话的表达要求/);
  const own = personas.readPersonaPrompt(root, first.id);
  assert.match(own.text, /以星河身份交流，称呼 念念/);
  assert.match(own.text, /通用制卡规则/);
  const messages = buildBridgeMessages({ persona: own.text, personaId: first.id, personaName: first.name });
  assert.match(messages[0].content, /不能直接修改文件/);
  assert.match(buildBridgeMessages()[0].content, /中性助手/);
});

test('历史桥接署名保留快照，中性、删除的人设和无 ID 旧记录不会冒充当前助手', () => {
  const history = [
    { role: 'agent', at: 'a', text: '旧答复' },
    { role: 'agent', at: 'b', text: '中性答复', personaId: 'neutral' },
    { role: 'agent', at: 'c', text: '自定义答复', personaId: 'custom_11111111-1111-4111-8111-111111111111', personaName: '星河原名' },
  ];
  const messages = buildBridgeMessages({ personaId: 'momo', personaName: '茉茉', history });
  assert.match(messages[1].content, /林小汐此前的回复/);
  assert.match(messages[2].content, /中性助手此前的回复/);
  assert.match(messages[3].content, /星河原名此前的回复/);
  assert.equal(queryConversationHistory(history, { messageAt: 'c' }).messages[0].personaName, '星河原名');
});

test('长期记忆、历史指纹和重试保留自定义人设名称快照', async t => {
  const root = fixture(t), first = custom(root);
  const history = [{ role: 'user', at: 'u', text: '开始' }, { role: 'agent', at: 'a', text: '旧答复', personaId: first.id, personaName: '星河原名' }];
  const memory = await prepareConversationMemory({ workDir: path.join(root, 'work'), cardName: '卡片', conversationId: 'main', history });
  assert.match(memory.historyPrompt, /星河原名/);
  assert.equal(memory.recentHistory[1].personaName, '星河原名');
  assert.notEqual(fingerprintConversationHistory(history), fingerprintConversationHistory(history.map(message => ({ ...message, personaName: '新名' }))));
  assert.equal(prepareChatRetry(history).personaName, '星河原名');
});

test('实际压缩历史时摘要输入包含原始人设名称，删除注册项也不影响归属', async t => {
  const root = fixture(t), first = custom(root), summaries = [];
  const history = Array.from({ length: 4 }, (_, index) => [
    { role: 'user', at: 'u' + index, text: '问题'.repeat(100) },
    { role: 'agent', at: 'a' + index, text: '答复'.repeat(100), personaId: first.id, personaName: '星河原名' },
  ]).flat();
  personas.deletePersona(root, first.id);
  const memory = await prepareConversationMemory({ workDir: path.join(root, 'work'), cardName: '卡片', conversationId: 'main', history,
    limits: { maxHistoryChars: 1000, targetRecentChars: 400, maxSummaryChars: 150, maxBatchChars: 4000, maxInputChars: 6000, maxCurrentTextChars: 500, minRecentTurns: 1 },
    generateSummary: async request => { summaries.push(request); return { summary: '星河原名提出了建议；用户尚未确认。' }; },
  });
  assert.ok(memory.coveredCount > 0);
  assert.ok(summaries.length > 0);
  assert.match(summaries[0].prompt, /"speaker":"星河原名"/);
  assert.match(summaries[0].prompt, /"personaName":"星河原名"/);
  assert.match(memory.historyPrompt, /星河原名/);
});

test('创建聊天分支保留发送时署名，之后改名或删除不重新归属旧回复', t => {
  const root = fixture(t), item = custom(root, '星河原名', '讨论故事。');
  const history = [
    { role: 'user', at: 'u1', text: '原问题', cardName: '卡片', conversationId: 'main', personaId: item.id, personaName: item.name },
    { role: 'agent', at: 'a1', text: '旧回复', cardName: '卡片', conversationId: 'main', personaId: item.id, personaName: item.name },
  ];
  const branch = prepareChatBranch(root, history, {}, { cardName: '卡片', conversationId: 'main', messageAt: 'a1', role: 'agent', expectedRevision: 0, contextRevision: 0, newConversationId: 'branch-1' });
  assert.equal(branch.messages[1].personaName, '星河原名');
  personas.savePersona(root, { id: item.id, name: '星河新名', prompt: '另一种风格。' });
  personas.deletePersona(root, item.id);
  const messages = buildBridgeMessages({ history: branch.messages });
  assert.match(messages.at(-1).content, /星河原名此前的回复/);
  assert.doesNotMatch(messages.at(-1).content, /星河新名/);
});

test('动态头像支持中性与自定义，删除后历史请求安全返回空头像', t => {
  const root = fixture(t), first = custom(root);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWl8AAAAASUVORK5CYII=';
  const payload = { mimeType: 'image/png', base64: png };
  assert.equal(readChatAvatars(root).neutral.label, '助');
  assert.equal(readChatAvatars(root)[first.id].label, '星');
  saveChatAvatar(root, first.id, payload);
  assert.equal(readChatAvatar(root, first.id).mimeType, 'image/png');
  saveChatAvatar(root, 'neutral', payload);
  personas.deletePersona(root, first.id);
  assert.equal(readChatAvatar(root, first.id), null);
  assert.throws(() => saveChatAvatar(root, first.id, payload), /未知|不存在/);
  for (const id of ['__proto__', '../outside']) assert.throws(() => readChatAvatar(root, id));
});

test('缺少人物资源时默认头像仍可读取', t => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, 'workflow', '小汐.md'));
  fs.unlinkSync(path.join(root, 'personas', '茉茉.md'));
  assert.equal(readChatAvatars(root).neutral.label, '助');
});

test('Codex 使用发送时自定义人设快照并默认中性，不在异步登录后重新读取新设定', async t => {
  const root = fixture(t), first = custom(root, '星河原名', '旧版独有正文。');
  fs.mkdirSync(path.join(root, 'cards', '测试卡', 'src'), { recursive: true });
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const requests = [], replies = [], failures = [];
  const bridge = createCodexBridge({ root,
    getStatus: async () => { await gate; return { authenticated: true, authMethod: 'ChatGPT' }; },
    getChildEnv: async () => ({}),
    runTurn: async request => { requests.push(request); return { completed: true, ephemeral: true, text: '已收到' }; },
    onReply: async (cardName, text, meta) => { replies.push({ cardName, text, ...meta }); },
    onFailure: async (cardName, error) => { failures.push(error); },
  });
  bridge.enable();
  const pending = bridge.enqueue('测试卡', '开始创作', '', 'main', '', false, first.id);
  personas.savePersona(root, { id: first.id, name: '星河新名', prompt: '新版不同正文。' });
  openGate();
  await pending;
  assert.deepEqual(failures, []);
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /旧版独有正文/);
  assert.doesNotMatch(requests[0].prompt, /新版不同正文/);
  assert.equal(replies[0].personaName, '星河原名');
  await bridge.enqueue('测试卡', '你好');
  assert.match(requests[1].prompt, /你是中性助手/);
  assert.equal(replies[1].personaId, 'neutral');
  await bridge.stop();
});
