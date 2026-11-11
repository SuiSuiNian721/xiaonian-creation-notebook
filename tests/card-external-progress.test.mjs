import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachChatStream } from '../integrations/xiaoxi/tools/chat-stream-ui.mjs';

const cardName = '进度回归';
const pause = ms => new Promise(done => setTimeout(done, ms));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'card-external-progress-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../integrations/xiaoxi/tools/studio.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', XIAOXI_WORKSPACE_ROOT: directory, XIAOXI_NO_OPEN: '1', XIAOXI_API_TOKEN: 'progress-test-token' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  let readyTimer;
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(() => { throw new Error('制卡测试进程提前退出：' + output); }),
    new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('制卡测试启动超时：' + output)), 8000); }),
  ]).finally(() => clearTimeout(readyTimer));
  const url = 'http://127.0.0.1:' + ready.port;
  t.after(async () => {
    if (child.exitCode === null) { child.send({ type: 'xiaoxi-shutdown' }); await once(child, 'exit'); }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const api = async (route, body) => {
    const response = await fetch(url + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-xiaoxi-token': 'progress-test-token' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await api('new', { name: cardName })).status, 200);
  const conversationId = (await api('conversations/' + encodeURIComponent(cardName))).value.activeId;
  await mkdir(join(directory, 'work'), { recursive: true });
  // 只开启任务协议，测试自己驱动状态，不启动自动桥或模型。
  await writeFile(join(directory, 'work/llm-config.json'), JSON.stringify({ backend: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'fixture' }), 'utf8');
  let sequence = 0;
  const begin = async () => {
    const replyToAt = new Date(Date.now() + ++sequence).toISOString();
    await appendFile(join(directory, 'work/agent-chat.jsonl'), JSON.stringify({ role: 'user', at: replyToAt, text: '继续写稿', cardName, conversationId, personaId: 'xiaoxi' }) + '\n', 'utf8');
    const result = await api('bridge/task-start', { cardName, conversationId, replyToAt, backend: 'openai' });
    assert.equal(result.status, 200, JSON.stringify(result));
    return { cardName, conversationId, replyToAt, claimId: result.value.claimId };
  };
  const history = async () => (await api('chat/' + encodeURIComponent(cardName) + '?conversationId=' + conversationId)).value;
  const current = async () => (await history()).find(message => message.pending)?.task;
  const events = async () => {
    const controller = new AbortController();
    const response = await fetch(url + '/api/chat-events/' + encodeURIComponent(cardName) + '?conversationId=' + conversationId, { signal: controller.signal });
    assert.equal(response.status, 200);
    const frames = []; let buffer = '';
    const reading = (async () => {
      for await (const chunk of response.body) {
        buffer += new TextDecoder().decode(chunk);
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
          if (event && data) frames.push({ event, ...JSON.parse(data) });
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    t.after(async () => { controller.abort(); await reading; });
    return { frames, async wait(predicate) {
      const until = Date.now() + 2500;
      while (Date.now() < until) { const result = frames.find(predicate); if (result) return result; await pause(20); }
      assert.fail('未收到预期 SSE 事件：' + JSON.stringify(frames));
    } };
  };
  return { directory, api, begin, history, current, events, conversationId };
}

test('外部任务在 HTTP 与 SSE 共用公开快照，真实活动递增，保活不伪造进度', async t => {
  const app = await fixture(t), identity = await app.begin(), first = await app.current();
  assert.equal(typeof first.taskId, 'string'); assert.notEqual(first.taskId, identity.claimId);
  assert.equal(first.partialText, ''); assert.equal(first.activityRevision, 0);
  assert.equal(Number.isSafeInteger(first.previewRevision), true);
  assert.ok(Number.isFinite(Date.parse(first.lastActivityAt)));
  const events = await app.events();
  const snapshot = await events.wait(frame => frame.event === 'snapshot');
  assert.deepEqual(snapshot.tasks, [first]);
  assert.doesNotMatch(JSON.stringify(snapshot), /claimId|toolResults|generations|proposal|progress-test-token/);
  await pause(5);
  assert.equal((await app.api('bridge/task-state', identity)).status, 200);
  assert.deepEqual(await app.current(), first, '无字段的任务保活不能改变公开版本或活动时间');
  const update = { ...identity, phase: 'generating', round: 1, partialText: '<img src=x onerror=alert(1)>安全正文', activityRevision: 2 };
  assert.equal((await app.api('bridge/task-state', update)).status, 200);
  const changed = await app.current();
  assert.equal(changed.partialText, update.partialText); assert.equal(changed.activityRevision, 2);
  assert.ok(changed.previewRevision > first.previewRevision); assert.ok(changed.lastActivityAt > first.lastActivityAt);
  const progress = await events.wait(frame => frame.event === 'progress' && frame.task?.activityRevision === 2);
  assert.deepEqual(progress.task, changed);
  assert.doesNotMatch(JSON.stringify(progress), /claimId|toolResults|generations|proposal/);
  await app.api('bridge/task-state', { ...identity, phase: 'thinking', round: 1, partialText: '迟到旧稿', activityRevision: 1 });
  assert.deepEqual(await app.current(), changed, '旧活动版本不能回退阶段和正文');
  await app.api('bridge/task-state', { ...identity, phase: 'running-tool', round: 2, partialText: '', activityRevision: 3 });
  const nextRound = await app.current(); assert.equal(nextRound.partialText, ''); assert.equal(nextRound.round, 2);
  await app.api('bridge/task-state', { ...identity, phase: 'finalizing', activityRevision: 3 });
  assert.equal((await app.current()).lastActivityAt, nextRound.lastActivityAt, '相同活动版本的阶段更新不能延长真实活动时间');
});

test('外部状态原子验证正文与版本，截断上限之外的输入被拒绝', async t => {
  const app = await fixture(t), identity = await app.begin(), first = await app.current();
  for (const invalid of [{ partialText: {} }, { partialText: '字'.repeat(100001) }, { activityRevision: -1 }, { activityRevision: 0.5 }, { activityRevision: Number.MAX_SAFE_INTEGER + 1 }, { round: 14 }]) {
    const result = await app.api('bridge/task-state', { ...identity, phase: 'generating', ...invalid });
    assert.equal(result.status, 400, JSON.stringify(invalid).slice(0, 120));
    assert.deepEqual(await app.current(), first, '非法字段不能先写入其他字段');
  }
  const content = '字'.repeat(100000);
  assert.equal((await app.api('bridge/task-state', { ...identity, partialText: content, activityRevision: 1 })).status, 200);
  assert.equal((await app.current()).partialText.length, 100000);
});

test('外部停止和失败保留安全片段，成功/结束发送 ended 且不保留幽灵任务', async t => {
  const app = await fixture(t), events = await app.events();
  let identity = await app.begin();
  await app.api('bridge/task-state', { ...identity, phase: 'generating', partialText: '停止前的正文片段', activityRevision: 1 });
  const first = await app.current();
  assert.equal((await app.api('chat-stop/' + encodeURIComponent(cardName), { targetType: 'card', conversationId: app.conversationId, replyToAt: identity.replyToAt })).status, 200);
  assert.equal(await app.current(), undefined);
  const stopped = (await app.history()).find(message => message.partialText === '停止前的正文片段');
  assert.ok(stopped, '停止回复必须保存已收到的安全片段');
  assert.equal(stopped.error, true);
  await events.wait(frame => frame.event === 'progress' && frame.task?.taskId === first.taskId && frame.task.ended);
  const late = await app.api('bridge/reply', { ...identity, text: '迟到完整稿' });
  assert.ok(late.status >= 400 && late.status < 500, '已停止任务的迟到回复继续被拒绝');
  identity = await app.begin();
  const prepared = await app.api('bridge/tool', { ...identity, callId: 'pending-proposal', tool: 'prepare_card_changes', args: {
    summary: '待确认正文', files: [{ path: 'text/description.md', content: '这份正文尚未完整展示。' }],
  } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  await app.api('bridge/task-state', { ...identity, partialText: '失败前的安全正文', activityRevision: 1 });
  const failedTask = await app.current();
  assert.equal((await app.api('bridge/reply', { ...identity, text: '连接失败，请重试', error: true, partialText: '不信任的桥正文' })).status, 200);
  const failed = (await app.history()).find(message => message.text === '连接失败，请重试');
  assert.equal(failed.partialText, '失败前的安全正文'); assert.equal(failed.error, true);
  await assert.rejects(readFile(join(app.directory, 'cards', cardName, '.card/tool-proposals', app.conversationId + '.json')), { code: 'ENOENT' }, '失败片段不得登记为已展示的完整稿');
  assert.equal(await app.current(), undefined);
  await events.wait(frame => frame.event === 'progress' && frame.task?.taskId === failedTask.taskId && frame.task.ended);
  identity = await app.begin();
  const completed = await app.current();
  assert.equal((await app.api('bridge/reply', { ...identity, text: '完整回复' })).status, 200);
  await events.wait(frame => frame.event === 'progress' && frame.task?.taskId === completed.taskId && frame.task.ended);
  assert.equal(await app.current(), undefined);
  identity = await app.begin(); const abandoned = await app.current();
  await app.api('bridge/task-finish', identity);
  await events.wait(frame => frame.event === 'progress' && frame.task?.taskId === abandoned.taskId && frame.task.ended);
  assert.equal((await app.current()).phase, 'waiting-service');
  assert.equal((await app.current()).taskId, undefined);
});

test('流式界面接受外部公开任务编号，保留版本拒旧与通用模型阶段', () => {
  class EventSourceFixture {
    static latest;
    constructor() { this.listeners = new Map(); EventSourceFixture.latest = this; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, data) { this.listeners.get(name)({ data: JSON.stringify(data) }); }
    close() {}
  }
  const scope = { cardName, conversationId: 'main' };
  const stream = attachChatStream({ EventSource: EventSourceFixture, scope: () => scope, isCurrent: () => true, changed() {}, refresh() {} });
  try {
    stream.start();
    const task = { ...scope, taskId: 'public-task', replyToAt: '2026-11-11T00:00:00Z', backend: 'openai', phase: 'starting', previewRevision: 1, partialText: '' };
    const messages = [{ pending: true, text: '旧状态', task }];
    EventSourceFixture.latest.emit('progress', { task: { ...task, phase: 'generating', previewRevision: 3, partialText: '<script>安全文字</script>' } });
    assert.equal(stream.apply(messages)[0].partialText, '<script>安全文字</script>');
    EventSourceFixture.latest.emit('progress', { task: { ...task, previewRevision: 2, partialText: '旧稿' } });
    assert.equal(stream.apply(messages)[0].partialText, '<script>安全文字</script>');
    EventSourceFixture.latest.emit('progress', { task: { ...task, taskId: 'old-task', previewRevision: 99, partialText: '旧任务' } });
    assert.notEqual(stream.apply(messages)[0].partialText, '旧任务');
    assert.match(stream.apply([{ pending: true, text: '', task }])[0].text, /连接模型/);
    EventSourceFixture.latest.emit('progress', { task: { ...task, previewRevision: 4, ended: true } });
    assert.equal(stream.apply(messages)[0].partialText, '');
  } finally { stream.dispose(); }
});
