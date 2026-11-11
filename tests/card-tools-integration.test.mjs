import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';
import { getPngChara } from '../integrations/xiaoxi/tools/card.mjs';
import { CardStudio } from '../framework/card-studio.mjs';

const toolCall = (name, args = {}, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const completion = (...calls) => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }] });
const prose = text => Response.json({ choices: [{ message: { role: 'assistant', content: text } }] });
const definition = { groups: [{ name: '状态', fields: [{ name: '好感度', type: 'number', min: 0, max: 100, default: 10 }] }] };

async function fixture(t, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), 'card-tools-integration-'));
  const app = await createWorkbench({ dataDir: root, aiOptions: { fetchImpl } });
  t.after(async () => { await app.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const api = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url + path, { method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  await api('/api/ai/config', { provider: 'openai', enabled: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture' }, 'PUT');
  await api('/api/modules/cards/enable', {}); await api('/api/modules/cards/studio', {});
  await api('/card-studio/api/new', { name: '工具链' });
  const conversationId = (await api('/card-studio/api/conversations/' + encodeURIComponent('工具链'))).activeId;
  const path = '/card-studio/api/chat/' + encodeURIComponent('工具链');
  const send = async text => {
    const history = await api(path + '?conversationId=' + conversationId);
    const last = history.filter(message => message.role === 'agent' && !message.pinned && !message.pending).at(-1)?.at || '';
    await api(path, { text, targetType: 'card', conversationId });
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      const messages = await api(path + '?conversationId=' + conversationId);
      const answer = messages.find(message => message.role === 'agent' && !message.pinned && !message.pending && message.at > last);
      if (answer) return answer;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('等待工具回复超时');
  };
  return { root, api, send };
}

test('真实桥与共用 AI：生成世界书/MVU/EJS→展示完整稿→确认写入→检查→导出 JSON/PNG', async t => {
  const calls = [];
  const app = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.tools.some(tool => tool.function.name === 'generate_mvu'));
    assert.doesNotMatch(body.messages[0].content, /切换到 Codex/);
    const user = body.messages.findLast(message => message.role === 'user').content;
    const results = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    calls.push({ user, results });
    if (user === '生成部件') {
      if (!results.length) return completion(
        toolCall('generate_mvu', { definition, book: '变量' }),
        toolCall('generate_worldbook', { book: '背景', entries: [{ base: '01-天文台', name: '天文台', content: '{{user}} 在山顶天文台观星。', keys: ['天文台'] }] }),
        toolCall('generate_ejs', { book: '界面', statusbar: { ...definition, title: '状态' } }));
      if (results.length === 3) {
        assert.ok(results.every(result => result.generationId), JSON.stringify(results));
        return completion(toolCall('prepare_card_changes', { summary: '正文、世界书与变量系统', generatedIds: results.map(result => result.generationId), files: [{ path: 'text/description.md', content: '成年天文学研究员，喜欢修复旧望远镜。' }, { path: 'text/first_mes.md', content: '今晚一起看星星吗，{{user}}？' }] }));
      }
      assert.ok(results.at(-1).proposalId, JSON.stringify(results));
      return prose('完整稿已准备好，请确认。');
    }
    if (user === '我确认刚才展示的完整修改稿。请按这份稿写入并导出，不再扩写。') {
      if (!results.length) return completion(toolCall('read_card'));
      if (results.length === 1) return completion(toolCall('apply_card_changes', { proposalId: results[0].pendingProposal.id, confirmation: user }));
      if (results.length === 2) { assert.equal(results[1].saved, true, JSON.stringify(results[1])); return completion(toolCall('check_card'), toolCall('diagnose_card'), toolCall('export_card')); }
      assert.deepEqual(results[2].errors, []); assert.equal(results.at(-1).artifacts.files.length, 2);
      return prose('已完成写入和导出。');
    }
    return prose('继续讨论，不写入。');
  });
  const first = await app.send('生成部件');
  assert.equal(first.error, undefined, first.text);
  assert.match(first.text, /待确认修改稿/); assert.match(first.text, /registerMvuSchema/); assert.match(first.text, /天文台/);
  const sourceRoot = join(app.root, 'card-studio/cards/工具链/src');
  assert.equal((await readFile(join(sourceRoot, 'text/description.md'), 'utf8')).trim(), '');
  const second = await app.send('我确认刚才展示的完整修改稿。请按这份稿写入并导出，不再扩写。');
  assert.equal(second.error, undefined, second.text); assert.match(second.text, /已导出/);
  const card = JSON.parse(await readFile(join(app.root, 'card-studio/dist/工具链/card.json'), 'utf8'));
  const png = getPngChara(await readFile(join(app.root, 'card-studio/dist/工具链/card.png')));
  assert.deepEqual(png, card);
  assert.match(card.data.description, /天文学研究员/);
  assert.equal(card.data.character_book.entries.find(entry => entry.name === '[InitVar]初始变量').enabled, false);
  assert.ok(card.data.extensions.tavern_helper.scripts.some(script => script.content.includes('registerMvuSchema')));
  assert.ok(card.data.character_book.entries.some(entry => entry.content.includes('@@iframe')));
  assert.ok(card.data.character_book.entries.some(entry => entry.content.includes('{{user}} 在山顶天文台')));
  assert.equal(calls.length, 6, '完整稿由宿主展示，省去一轮模型复述');
});

test('空卡导出返回真实检查错误，工具错误可交模型解释而不伪造成品', async t => {
  const app = await fixture(t, async (_url, options) => {
    const body = JSON.parse(options.body), result = body.messages.findLast(message => message.role === 'tool');
    if (!result) return completion(toolCall('export_card'));
    const value = JSON.parse(result.content); assert.match(value.error, /check 未通过/);
    return prose('导出未完成：需要先保存角色描述和开场白。');
  });
  const answer = await app.send('导出'); assert.match(answer.text, /导出未完成/);
  await assert.rejects(readFile(join(app.root, 'card-studio/dist/工具链/card.json')), { code: 'ENOENT' });
});

test('服务端工具绑定当前任务：同轮不能批准、源文件漂移拒绝、调用幂等、停止和重试不再执行', async t => {
  const root = await mkdtemp(join(tmpdir(), 'card-tools-lifecycle-'));
  const studio = new CardStudio({ dataDir: root });
  const server = createServer((req, res) => void studio.proxy(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await studio.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const api = async (route, data) => {
    const response = await fetch(url + '/card-studio/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, ...await response.json() };
  };
  const info = await studio.start();
  await api('new', { name: '边界' });
  const name = encodeURIComponent('边界');
  const conversationId = (await api('conversations/' + name)).activeId;
  // 配置文件启用任务协议，但不拉起自动桥，精确驱动服务端任务状态。
  await writeFile(join(info.workspacePath, 'work/llm-config.json'), JSON.stringify({ backend: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'fixture' }));
  let sequence = 0;
  const begin = async (text, metadata = {}) => {
    const replyToAt = new Date(Date.now() + (++sequence * 100)).toISOString();
    await appendFile(join(info.workspacePath, 'work/agent-chat.jsonl'), JSON.stringify({ role: 'user', at: replyToAt, text, cardName: '边界', conversationId, personaId: 'xiaoxi', ...metadata }) + '\n');
    const claim = await api('bridge/task-start', { cardName: '边界', conversationId, replyToAt, backend: 'openai' });
    assert.equal(claim.status, 200, JSON.stringify(claim));
    const identity = { cardName: '边界', conversationId, replyToAt, claimId: claim.claimId };
    return { identity, tools: claim.tools, tool: (tool, args = {}, callId = tool + (++sequence)) => api('bridge/tool', { ...identity, tool, args, callId }), reply: text => api('bridge/reply', { ...identity, text }) };
  };
  const one = await begin('准备稿件');
  const progress = await api('bridge/task-state', { ...one.identity, phase: 'generating', round: 2 });
  assert.equal(progress.status, 200);
  const pendingResponse = await fetch(url + '/card-studio/api/chat/' + name + '?conversationId=' + conversationId);
  const pending = (await pendingResponse.json()).find(message => message.pending);
  assert.equal(pending.task.phase, 'generating'); assert.equal(pending.task.round, 2);
  assert.match(pending.text, /第 2 步.*生成/);
  const proposal = await one.tool('prepare_card_changes', { summary: '描述', files: [{ path: 'text/description.md', content: '确认的描述' }] });
  assert.equal(proposal.status, 200);
  assert.equal(proposal.replyReady, 'proposal');
  assert.equal((await one.tool('apply_card_changes', { proposalId: proposal.proposalId, confirmation: '准备稿件' })).status, 400);
  await one.reply('待确认');
  const denied = await begin('不要写入，也不要导出，先解释一下');
  const denial = await denied.tool('apply_card_changes', { proposalId: proposal.proposalId, confirmation: '不要写入，也不要导出，先解释一下' });
  assert.equal(denial.status, 400); assert.match(denial.error, /没有明确同意/);
  assert.equal((await readFile(join(info.workspacePath, 'cards/边界/src/text/description.md'), 'utf8')).trim(), '');
  await denied.reply('先解释');
  await api('save/' + name, { kind: 'text', key: 'description', content: '用户手动修改' });
  const two = await begin('写入确认稿');
  const drift = await two.tool('apply_card_changes', { proposalId: proposal.proposalId, confirmation: '写入确认稿' });
  assert.equal(drift.status, 400); assert.match(drift.error, /正文.*变化/);
  const next = await two.tool('prepare_card_changes', { summary: '更新描述', files: [{ path: 'text/description.md', content: '新确认稿' }] });
  await two.reply('新稿');
  const three = await begin('按新稿写入');
  const args = { proposalId: next.proposalId, confirmation: '按新稿写入' };
  const applied = await three.tool('apply_card_changes', args, 'stable-call');
  assert.equal(applied.saved, true, JSON.stringify(applied));
  assert.deepEqual(await three.tool('apply_card_changes', args, 'stable-call'), applied);
  assert.equal((await three.tool('apply_card_changes', args, 'different-call')).status, 400);
  const stoppedRequest = await api('chat-stop/' + name, { targetType: 'card', conversationId, replyToAt: three.identity.replyToAt });
  assert.equal(stoppedRequest.status, 200, JSON.stringify(stoppedRequest));
  const stopped = await three.tool('export_card'); assert.equal(stopped.status, 409);
  const retry = await begin('按新稿写入', { retryOfAt: 'old-reply', retrySourceUserAt: one.identity.replyToAt });
  assert.deepEqual(retry.tools.map(tool => tool.function.name), ['read_card']);
  assert.equal((await retry.tool('export_card')).status, 400);
  assert.equal(await readFile(join(info.workspacePath, 'cards/边界/src/text/description.md'), 'utf8'), '新确认稿');
});
