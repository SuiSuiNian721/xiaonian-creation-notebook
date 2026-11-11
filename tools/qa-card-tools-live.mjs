import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';
import { getPngChara } from '../integrations/xiaoxi/tools/card.mjs';

// 显式运行的真实模型验收；只读现行连接，使用独立临时实例和自造卡，不读取角色或历史。
const entry = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'AI-Future-Workbench/desktop-entry/desktop-entry.json'), 'utf8'));
const db = new DatabaseSync(join(entry.profileDirectory, 'data/workbench.sqlite'), { readOnly: true });
let config;
try { config = JSON.parse(db.prepare('SELECT value FROM settings WHERE name = ?').get('ai.connection').value); } finally { db.close(); }
assert.equal(config.enabled, true);
const directory = await mkdtemp(join(tmpdir(), 'card-tools-live-'));
const output = resolve('artifacts/card-tools-live'); await mkdir(output, { recursive: true });
const report = { provider: config.provider, model: config.model || '跟随现行设置', realModel: true, checks: [], startedAt: new Date().toISOString() };
let runtime;
try {
  runtime = await createWorkbench({ dataDir: join(directory, 'data') });
  const api = async (route, value, method = value === undefined ? 'GET' : 'POST') => {
    const response = await fetch(runtime.url + route, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  await api('/api/ai/config', config, 'PUT');
  await api('/api/user-profile', { displayName: '验收员', identity: '', preferences: '' });
  await api('/api/instances/migrate-legacy', {});
  const instance = (await api('/api/instances', { moduleId: 'cards', name: '工具链隔离验收' })).instance;
  const cardApi = (route, value) => api('/instances/' + instance.id + '/card-studio/api/' + route, value);
  const studio = await api('/instances/' + instance.id + '/api/modules/cards/studio', {});
  await cardApi('new', { name: '星禾工具验收' });
  const name = encodeURIComponent('星禾工具验收');
  const conversationId = (await cardApi('conversations/' + name)).activeId;
  const send = async text => {
    const previous = await cardApi('chat/' + name + '?conversationId=' + conversationId);
    const last = previous.filter(message => message.role === 'agent' && !message.pinned && !message.pending).at(-1)?.at || '';
    await cardApi('chat/' + name, { text, targetType: 'card', conversationId });
    const end = Date.now() + 8 * 60 * 1000;
    while (Date.now() < end) {
      const messages = await cardApi('chat/' + name + '?conversationId=' + conversationId);
      const answer = messages.find(message => message.role === 'agent' && !message.pending && !message.pinned && message.at > last);
      if (answer) { assert.ok(!answer.error, answer.text); return answer; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('真实模型本轮超过八分钟');
  };
  console.log('真实模型：准备世界书、MVU、EJS 和正文完整稿');
  const first = await send('这是独立测试卡，请直接按以下已明确需求调用工具，无需追问。先读取当前卡，再分别调用世界书、MVU 和 EJS 生成器，最后 prepare_card_changes 展示完整稿，暂不写入。正文 description 为“星禾是一名成年天文学研究员，习惯耐心记录每个人的观星发现。”，first_mes 为“今晚一起看看星星吧，{{user}}。”。世界书 book=背景，条目 base=01-天文台，name=天文台，content=山顶天文台在晴夜开放，keys=[天文台]，constant=false。MVU book=变量，definition.groups=[{name:状态,fields:[{name:好感度,type:number,min:0,max:100,default:10}]}]。EJS book=界面，只生成状态栏，title=状态，groups 与 MVU 相同。生成结果通过 generatedIds 放入完整稿，不需重新抄写生成代码。');
  assert.match(first.text, /待确认修改稿/);
  const src = join(studio.workspacePath, 'cards/星禾工具验收/src');
  assert.equal((await readFile(join(src, 'text/description.md'), 'utf8')).trim(), '');
  report.checks.push('真实模型调用生成器并展示完整稿；确认前正文仍为空');
  await writeFile(join(output, 'draft.txt'), first.text, 'utf8');
  console.log('真实模型：确认写入、检查、静态诊断、导出');
  const second = await send('按这版写入，随后检查、静态诊断并导出角色卡。');
  await writeFile(join(output, 'reply.txt'), second.text, 'utf8');
  const artifact = await cardApi('artifacts/' + name + '?targetType=card');
  assert.equal(artifact.files.length, 2);
  const cardBytes = await readFile(join(studio.workspacePath, 'dist/星禾工具验收/card.json'));
  const card = JSON.parse(cardBytes);
  const png = await readFile(join(studio.workspacePath, 'dist/星禾工具验收/card.png'));
  assert.deepEqual(getPngChara(png), card);
  assert.match(card.data.description, /成年天文学研究员/);
  assert.ok(card.data.extensions.tavern_helper.scripts.some(script => script.content.includes('registerMvuSchema')));
  const entries = card.data.character_book.entries;
  assert.ok(entries.some(entry => entry.name.includes('InitVar') && entry.enabled === false));
  assert.ok(entries.some(entry => entry.content.includes('@@iframe')));
  assert.ok(entries.some(entry => entry.keys.includes('天文台') && entry.constant === false));
  report.checks.push('确认写入后世界书、MVU 脚本、正则与 EJS 存入源文件并导出，PNG 元数据与 JSON 完全一致');
  await writeFile(join(output, 'card.json'), cardBytes); await writeFile(join(output, 'card.png'), png);
  report.ok = true; report.runtimeInSillyTavernVerified = false;
} catch (error) { report.ok = false; report.error = error.stack || error.message; process.exitCode = 1; console.error(error.message); }
finally {
  await runtime?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: report.ok, provider: report.provider, checks: report.checks, output }));
}
