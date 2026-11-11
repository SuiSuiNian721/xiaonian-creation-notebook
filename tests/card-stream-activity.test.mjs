import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SharedAI } from '../framework/shared-ai.mjs';
import { requestBridgeCompletion } from '../integrations/xiaoxi/tools/bridge-messages.mjs';
import { runCodexAppServer } from '../integrations/xiaoxi/tools/codex-app-server.mjs';
import { createWorkbench } from '../framework/server.mjs';
import { readModelResponse } from '../integrations/xiaoxi/tools/model-response.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
const tools = [{ type: 'function', function: { name: 'read_card', parameters: { type: 'object', properties: {} } } }];
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
function aiFixture(t, codexRunner) {
  const settings = new Map([['ai.connection', { provider: 'codex', enabled: true, model: 'retained-model', reasoningEffort: 'max' }]]);
  const ai = new SharedAI({ store: { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value), event() {} }, dataDir: tmpdir(), codexRunner });
  t.after(() => ai.close()); return ai;
}

test('结构化回复按根 content 增量解码，嵌套字段与工具参数不进入预览', async t => {
  const previews = [], text = '{"tool_calls":[],"nested":{"content":"不该出现"},"content":"中文\\n引号\\\"和\\\\路径\\u4f60\\u597d"}';
  const ai = aiFixture(t, async options => {
    for (let i = 1; i <= text.length; i++) options.onProgress({ phase: 'generating', partialText: text.slice(0, i), activityRevision: i });
    return { text };
  });
  const result = await ai.complete([{ role: 'user', content: '回复' }], { moduleId: 'cards', tools, onProgress: value => previews.push(value) });
  assert.equal(result.text, '中文\n引号"和\\路径你好');
  assert.equal(previews.filter(value => value.partialText).at(-1)?.partialText, result.text);
  for (const value of previews) {
    assert.ok(result.text.startsWith(value.partialText || ''));
    assert.doesNotMatch(value.partialText || '', /不该出现|tool_calls|arguments/);
  }
});

test('制卡长任务使用无活动时限，持续真实活动不受原总时限影响', async t => {
  let input;
  const ai = aiFixture(t, async options => {
    input = options;
    for (let i = 1; i <= 5; i++) { await pause(30); options.onProgress({ phase: 'thinking', activityRevision: i }); assert.equal(options.signal.aborted, false); }
    return { text: '{"content":"完成","tool_calls":[]}' };
  });
  const result = await ai.complete([{ role: 'user', content: '长任务' }], { moduleId: 'cards', tools, timeoutMs: 50, idleTimeoutMs: 80 });
  assert.equal(result.text, '完成'); assert.equal(input.timeoutMs, null); assert.equal(input.idleTimeoutMs, 80);
});

test('重复阶段和旧活动版本不延长制卡无活动时限', async t => {
  const ai = aiFixture(t, options => new Promise((done, reject) => {
    const timer = setInterval(() => options.onProgress({ phase: 'thinking', activityRevision: 1 }), 15);
    options.signal.addEventListener('abort', () => { clearInterval(timer); reject(new Error('aborted')); }, { once: true });
  }));
  await assert.rejects(ai.complete([{ role: 'user', content: '等待' }], { moduleId: 'cards', tools, idleTimeoutMs: 70 }), /没有新进展|未收到.*活动/);
});

async function endpoint(t, reply) {
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; await reply(JSON.parse(raw), res); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  return 'http://127.0.0.1:' + server.address().port + '/internal/ai/v1';
}

test('内置桥流式显示安全预览，真实活动允许跨越旧总时限且最终正文不重复', async t => {
  const previews = [];
  const baseUrl = await endpoint(t, async (body, res) => {
    assert.equal(body.workbenchIdleTimeoutMs, 110); assert.equal(body.workbenchTimeoutMs, undefined);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 1; i <= 5; i++) { res.write(event({ workbench: { phase: 'generating', activityRevision: i, partialText: '你好'.slice(0, i) } })); await pause(30); }
    res.end(event({ choices: [{ delta: { content: '你好' } }] }) + 'data: [DONE]\n\n');
  });
  const result = await requestBridgeCompletion({ baseUrl, messages: [], tools }, { timeoutMs: 50, idleTimeoutMs: 110, onProgress: value => previews.push(value) });
  assert.equal(result, '你好'); assert.ok(previews.some(value => value.partialText === '你好'));
});

test('内置桥保活注释与重复活动版本不能让停滞流无限等待', async t => {
  const baseUrl = await endpoint(t, async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write(': waiting\n\n' + event({ workbench: { phase: 'thinking', activityRevision: 1 } })), 15);
    res.once('close', () => clearInterval(timer));
  });
  await assert.rejects(requestBridgeCompletion({ baseUrl, messages: [], tools }, { idleTimeoutMs: 80 }), /没有新进展|未收到.*活动/);
});

test('真实内部 HTTP 链路只发送正文预览增量，重建后与最终结果一致', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'card-stream-http-')), previews = [], raw = '{"content":"第一段。\\n第二段。","tool_calls":[]}';
  let input;
  const app = await createWorkbench({ dataDir: directory, instances: false, aiOptions: { codexRunner: async options => {
    input = options;
    for (let i = 1; i <= raw.length; i++) options.onProgress({ phase: 'generating', partialText: raw.slice(0, i), activityRevision: i });
    return { text: raw };
  } } });
  t.after(async () => { await app.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  app.context.sharedAI.save({ provider: 'codex', enabled: true });
  const request = body => fetch(app.url + '/internal/ai/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + app.context.sharedAI.token }, body: JSON.stringify(body) });
  const body = { messages: [{ role: 'user', content: '回复' }], tools, stream: true, workbenchIdleTimeoutMs: 10000 };
  for (const value of [0, -1, '10000', 1800001]) { const response = await request({ ...body, workbenchIdleTimeoutMs: value }); assert.equal(response.status, 400); await response.text(); }
  const response = await request(body), wire = await response.text();
  assert.doesNotMatch(wire, /tool_calls\\"|不该出现/);
  assert.match(wire, /previewDelta/);
  const result = await readModelResponse(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }), { onProgress: value => previews.push(value) });
  assert.equal(input.timeoutMs, null); assert.equal(input.idleTimeoutMs, 10000);
  assert.equal(result.choices[0].message.content, '第一段。\n第二段。');
  assert.equal(previews.filter(value => value.partialText).at(-1).partialText, result.choices[0].message.content);
  assert.ok(previews.some(value => value.partialText === '第一段。'));
});

test('共用兼容 API 的流式函数参数只在完成后返回，预览保持普通正文', async t => {
  const settings = new Map([['ai.connection', { provider: 'openai', enabled: true, model: 'fixture', baseUrl: 'https://fixture.invalid/v1' }]]), previews = [];
  const ai = new SharedAI({ dataDir: tmpdir(), store: { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value), event() {} }, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(event({ choices: [{ delta: { content: '正在读取。' } }] }) + event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_card', arguments: '{}' } }] } }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(() => ai.close());
  const result = await ai.complete([{ role: 'user', content: '读取' }], { moduleId: 'cards', tools, idleTimeoutMs: 10000, onProgress: value => previews.push(value) });
  assert.equal(result.toolCalls[0].function.name, 'read_card');
  assert.equal(result.text, '正在读取。');
  assert.ok(previews.some(value => value.partialText === result.text));
  assert.ok(previews.every(value => !/read_card|arguments/.test(value.partialText || '')));
});

test('截断或过滤的完成标记不能授权工具，UTF-8 正文和多工具参数共享字节上限', async () => {
  const call = { index: 0, id: 'read', type: 'function', function: { name: 'read_card', arguments: '{}' } };
  for (const finish_reason of ['length', 'content_filter']) {
    const value = { choices: [{ delta: { tool_calls: [call] }, finish_reason }] };
    await assert.rejects(readModelResponse(new Response(event(value) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })), /完整结束|截断|过滤/);
    await assert.rejects(readModelResponse(Response.json({ choices: [{ message: { tool_calls: [call] }, finish_reason }] })), /完整结束|截断|过滤/);
  }
  const large = '中'.repeat(1500000);
  await assert.rejects(readModelResponse(new Response(event({ choices: [{ delta: { content: large } }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })), /4 MiB/);
  const args = '中'.repeat(750000), calls = [0, 1].map(index => ({ ...call, index, id: 'call_' + index, function: { name: 'read_card', arguments: args } }));
  await assert.rejects(readModelResponse(new Response(event({ choices: [{ delta: { tool_calls: calls } }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })), /4 MiB/);
});

async function nativeFixture(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'card-stream-cli-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return { cwd: directory, cli: 'fixture', prompt: '回复', inferenceOnly: true, timeoutMs: null, idleTimeoutMs: 200, closeTimeoutMs: 80,
    spawnProcess: (_cli, args, options) => spawn(process.execPath, [fileURLToPath(new URL('./fixtures/codex-config-cli.mjs', import.meta.url)), ...args], { ...options, env: { ...options.env, CODEX_FIXTURE_MODE: mode, CODEX_FIXTURE_LOG: join(directory, 'events.jsonl') } }) };
}

test('原生宿主推理关闭总时限并发布真实活动版本，空增量不会保活', async t => {
  const states = [], options = await nativeFixture(t, 'slow-active');
  const result = await runCodexAppServer({ ...options, onProgress: value => states.push(value) });
  assert.equal(result.text, 'OK');
  assert.ok(states.filter(value => value.activityRevision > 1).length >= 5);
  await assert.rejects(runCodexAppServer(await nativeFixture(t, 'empty-active')), /未收到新的 Codex 活动/);
});
