import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { requestBridgeCompletion, buildBridgeMessages } from '../integrations/xiaoxi/tools/bridge-messages.mjs';
import { SharedAI } from '../framework/shared-ai.mjs';

const tools = [{ type: 'function', function: { name: 'check_card', description: '检查当前卡', parameters: { type: 'object', properties: {}, additionalProperties: false } } }];
const call = { id: 'call_one', type: 'function', function: { name: 'check_card', arguments: '{}' } };
async function modelServer(t, reply) {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const result = reply(JSON.parse(text));
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: result }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('角色卡桥向模型提供工具并把真实结果回送后再生成答复', async t => {
  const requests = [], executed = [];
  const baseUrl = await modelServer(t, body => {
    requests.push(body);
    return requests.length === 1 ? { content: null, tool_calls: [call] } : { content: '检查结果：缺少开场白。' };
  });
  const reply = await requestBridgeCompletion({ baseUrl, model: 'fixture', messages: [{ role: 'user', content: '检查当前卡' }], tools }, {
    executeTool: async (name, args) => { executed.push({ name, args }); return { errors: ['缺少开场白'] }; },
  });
  assert.equal(reply, '检查结果：缺少开场白。');
  assert.deepEqual(requests[0].tools, tools);
  assert.deepEqual(executed, [{ name: 'check_card', args: {} }]);
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content), { errors: ['缺少开场白'] });
});

test('未知工具和坏参数不执行，循环有界且取消后不执行下一项', async t => {
  let executions = 0, requests = 0;
  const baseUrl = await modelServer(t, () => { requests++; return { content: null, tool_calls: [{ ...call, function: { name: 'shell', arguments: '{}' } }] }; });
  await assert.rejects(requestBridgeCompletion({ baseUrl, model: 'fixture', messages: [{ role: 'user', content: '检查' }], tools }, {
    maxToolRounds: 2, executeTool: async () => executions++,
  }), /工具.*上限/);
  assert.equal(executions, 0); assert.equal(requests, 3);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestBridgeCompletion({ baseUrl, tools, messages: [] }, { signal: controller.signal, executeTool: async () => executions++ }), /停止/);
  assert.equal(executions, 0);
});

test('桥提示词以实际能力说明检查、生成、确认写入、导出，不再要求切换后端', () => {
  const prompt = buildBridgeMessages({ toolsEnabled: true })[0].content;
  assert.match(prompt, /工具/); assert.match(prompt, /确认/);
  assert.doesNotMatch(prompt, /切换到 Codex|不能直接修改文件/);
});

function shared(t, provider, overrides) {
  const settings = new Map([['ai.connection', { provider, enabled: true, model: 'fixture', baseUrl: 'https://fixture.invalid/v1' }]]);
  const store = { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value), event() {} };
  const ai = new SharedAI({ store, dataDir: process.cwd(), ...overrides });
  t.after(() => ai.close()); return ai;
}

test('共用 API 转接保留无正文的工具调用和下一轮工具结果', async t => {
  let input;
  const ai = shared(t, 'openai', { fetchImpl: async (_url, options) => { input = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: null, tool_calls: [call] } }] }); } });
  const messages = [{ role: 'user', content: '检查' }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '{"errors":[]}' }];
  const result = await ai.complete(messages, { moduleId: 'cards', tools });
  assert.deepEqual(input.tools, tools); assert.deepEqual(input.messages, messages); assert.deepEqual(result.toolCalls, [call]);
});

test('共用 Codex 转接使用 JSON 工具协议，实际操作由宿主执行', async t => {
  let input;
  const ai = shared(t, 'codex', { codexRunner: async options => { input = options; return { text: JSON.stringify({ content: '', tool_calls: [{ name: 'check_card', arguments: '{}' }] }) }; } });
  const result = await ai.complete([{ role: 'user', content: '检查' }], { moduleId: 'cards', tools });
  assert.equal(input.allowWrite, false); assert.match(input.prompt, /check_card/);
  assert.equal(result.toolCalls[0].function.name, 'check_card');
  assert.equal(result.text, '');
});
