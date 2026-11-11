import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// 单独显式执行，正常 npm test / 桌面 QA 不发送真实模型请求。
if (!process.argv.includes('--live')) throw new Error('真实 Codex 检查需要显式传入 --live。');
const packaged = process.argv.includes('--packaged');
const { CardStudio } = await import(packaged
  ? '../dist-workbench/win-unpacked/resources/app/framework/card-studio.mjs'
  : '../framework/card-studio.mjs');
const directory = resolve(process.env.AI_FUTURE_CODEX_QA_DIR || `qa/codex-live-${Date.now()}`);
await mkdir(directory, { recursive: true });
const studio = new CardStudio({ dataDir: join(directory, 'data') });
const server = createServer((request, response) => void studio.proxy(request, response));
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const call = async (path, body) => {
  const response = await fetch(origin + '/card-studio/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error || path);
  return result;
};
const started = Date.now();
const record = { startedAt: new Date().toISOString(), isolatedData: directory, packaged, realModelRequest: true, ok: false };
try {
  const auth = await call('bridge/codex-status');
  assert.equal(auth.authMethod, 'ChatGPT');
  record.auth = auth;
  await call('bridge/llm-config', { backend: 'codex', enabled: true, codexModel: 'gpt-6.1-sol', codexReasoningEffort: 'low' });
  const name = 'Codex连接验证';
  await call('new', { name });
  const key = encodeURIComponent(name);
  const { activeId } = await call('conversations/' + key);
  await call('chat/' + key, { text: '这是独立工作区的连接诊断。请只回复 BRIDGE_OK，不调用工具、不读写文件、不提出问题。', targetType: 'card', conversationId: activeId, personaId: 'neutral' });
  let reply;
  while (Date.now() - started < 90000) {
    const messages = await call('chat/' + key + '?conversationId=' + encodeURIComponent(activeId));
    reply = messages.find(item => item.role === 'agent' && item.at && !item.pending);
    if (reply) break;
    await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(reply, 'Codex 在 90 秒内应完成回复');
  assert.ok(!reply.error, reply.text);
  assert.match(reply.text, /BRIDGE_OK/);
  record.reply = { text: reply.text, personaId: reply.personaId, at: reply.at };
  await studio.close();
  await studio.start();
  const status = await call('bridge/llm-status');
  assert.equal(status.enabled, true);
  assert.equal(status.codex.enabled, true);
  const messages = await call('chat/' + key + '?conversationId=' + encodeURIComponent(activeId));
  assert.ok(messages.some(item => item.at === reply.at && item.text === reply.text));
  record.restartPreserved = true;
  const usage = await readFile(join(directory, 'data/card-studio/work/codex-usage.jsonl'), 'utf8').catch(() => '');
  record.usageRecorded = !!usage.trim();
  record.ok = true;
} catch (error) {
  record.error = error.message;
  process.exitCode = 1;
} finally {
  await studio.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  record.durationMs = Date.now() - started;
  await writeFile(join(directory, 'result.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(record, null, 2));
}
