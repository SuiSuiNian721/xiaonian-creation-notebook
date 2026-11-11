import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, request } from 'node:http';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const backend = await import('../framework/server.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function api(url, path, value, method = value === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: value === undefined ? {} : { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  return { status: response.status, ...(await response.json()) };
}

async function fixture(t, options = {}) {
  assert.equal(typeof backend.createWorkbench, 'function', '统一工作台必须提供 createWorkbench 入口');
  const root = await mkdtemp(join(tmpdir(), 'ai-future-workbench-'));
  const dataDir = join(root, 'data');
  const staticDir = join(root, 'public');
  await mkdir(staticDir);
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>工作台测试</title>');
  const app = await backend.createWorkbench({ dataDir, staticDir, ...options });
  t.after(async () => {
    await app.close();
    const target = resolve(root);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(target, { recursive: true, force: true });
  });
  return { ...app, root, dataDir, staticDir, api: (path, value, method) => api(app.url, path, value, method) };
}

test('工作台启动为空白资料库，十三个独立模块均关闭，能力不冒充已接入', async t => {
  const app = await fixture(t);
  assert.deepEqual(await app.api('/api/health'), { status: 200, ok: true });
  const state = await app.api('/api/state');
  assert.deepEqual(state.modules.map(module => module.id), ['cards', 'training', 'drawing', 'comfyui', 'voice','voice-design', 'companion','character-lite','character-full','companion-lite', 'qq', 'mc-skin', 'mc-play']);
  assert.deepEqual(state.characters, []);
  assert.equal(state.selectedCharacterId, null);
  assert.deepEqual(state.preferences, { theme: 'light' });
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.tasks, []);
  for (const module of state.modules) {
    assert.equal(module.enabled, false);
    assert.equal(module.lastOpenedAt, null);
    assert.deepEqual(module.checks, {});
    assert.ok(module.capabilities.every(capability => capability.status === (['cards','drawing','training','comfyui','voice','voice-design','companion','character-lite','character-full','companion-lite','mc-skin','mc-play'].includes(module.id) ? 'available' : 'planned')));
    for (const setting of module.settings) assert.equal(module.config[setting.key], ['drawing','comfyui'].includes(module.id) && setting.key === 'serviceUrl' ? 'http://127.0.0.1:8188' : '');
  }
});

test('启用和停用隔离于模块配置，打开操作要求启用，配置按键合并', async t => {
  const app = await fixture(t);
  assert.equal((await app.api('/api/modules/drawing/open', {})).status, 409);
  assert.equal((await app.api('/api/modules/drawing/config', { values: { comfyPath: app.root, outputPath: app.staticDir } }, 'PUT')).status, 200);
  await app.api('/api/modules/drawing/enable', {});
  await app.api('/api/modules/drawing/open', {});
  await app.api('/api/modules/drawing/config', { values: { serviceUrl: 'http://127.0.0.1:8188' } }, 'PUT');
  await app.api('/api/modules/drawing/disable', {});
  let state = await app.api('/api/state');
  const drawing = state.modules.find(module => module.id === 'drawing');
  assert.equal(drawing.enabled, false);
  assert.equal(drawing.config.comfyPath, app.root);
  assert.equal(drawing.config.outputPath, app.staticDir);
  assert.equal(drawing.config.serviceUrl, 'http://127.0.0.1:8188');
  assert.ok(Date.parse(drawing.lastOpenedAt));
  assert.equal(state.modules.find(module => module.id === 'training').config.outputPath, '');
  await app.api('/api/modules/drawing/enable', {});
  state = await app.api('/api/state');
  assert.equal(state.modules.find(module => module.id === 'drawing').config.comfyPath, app.root);
  assert.equal((await app.api('/api/modules/missing/enable', {})).status, 404);
});

test('配置限制未知键和类型，拒绝原型键及超长字段，不污染其他命名空间', async t => {
  const app = await fixture(t);
  for (const values of [{ apiKey: 'secret' }, { outputPath: 7 }, { outputPath: 'a'.repeat(4097) }, { serviceUrl: 'file:///C:/private' }, JSON.parse('{"__proto__":"poison"}')]) {
    const response = await app.api('/api/modules/drawing/config', { values }, 'PUT');
    assert.equal(response.status, 400);
    assert.equal(typeof response.error, 'string');
  }
  assert.equal((await app.api('/api/modules/drawing/config', { values: {}, extra: true }, 'PUT')).status, 400);
  assert.equal((await app.api('/api/preferences', { theme: 'violet' })).status, 400);
  assert.equal((await app.api('/api/characters', { name: 'a'.repeat(121) })).status, 400);
  const state = await app.api('/api/state');
  assert.equal(state.modules.find(module => module.id === 'drawing').config.outputPath, '');
  assert.equal(({}).poison, undefined);
});

test('配置保存响应返回本次已落盘的规范化值和有效检查结果', async t => {
  const app = await fixture(t);
  const response = await app.api('/api/modules/drawing/config', { values: { comfyPath: `  ${app.root}  ` } }, 'PUT');
  assert.equal(response.status, 200);
  assert.equal(response.config.comfyPath, app.root);
  assert.deepEqual(response.checks, {});
  assert.deepEqual(response.config, (await app.api('/api/state')).modules.find(module => module.id === 'drawing').config);
});

test('多个角色共享资料库但原始字段各自保留，选择不会覆盖另一张角色卡', async t => {
  const app = await fixture(t);
  const raw = { spec: 'chara_card_v2', data: { name: '茉茉', description: '第一张卡', extensions: { custom: { list: [1, '中文'] } } }, unknown: true };
  const first = await app.api('/api/characters/import', { document: raw });
  const second = await app.api('/api/characters', { name: '小汐', description: '第二张卡', raw: { extra: '独立保留' } });
  assert.equal(first.status, 200);
  assert.equal(first.character.name, '茉茉');
  assert.equal(first.character.description, '第一张卡');
  assert.equal(first.character.revision, 1);
  assert.deepEqual(first.character.raw, raw);
  assert.notEqual(first.character.id, second.character.id);
  await app.api('/api/characters/select', { id: first.character.id });
  const state = await app.api('/api/state');
  assert.equal(state.characters.length, 2);
  assert.equal(state.selectedCharacterId, first.character.id);
  assert.deepEqual(state.characters.find(character => character.id === second.character.id).raw, { extra: '独立保留' });
  assert.equal((await app.api('/api/characters/select', { id: 'not-there' })).status, 404);
  assert.equal((await app.api('/api/state')).selectedCharacterId, first.character.id);
  await app.api('/api/characters/select', { id: null });
  assert.equal((await app.api('/api/state')).selectedCharacterId, null);
});

test('角色包跨资料库往返保留身份和版本，重复幂等，冲突或未知版本拒绝', async t => {
  const source = await fixture(t);
  const target = await fixture(t);
  const raw = { name: '雪', description: '原始内容', custom: { privateField: '原卡原样保留' }, arbitrary: [null, false, 3] };
  const created = (await source.api('/api/characters/import', { document: raw })).character;
  await source.api('/api/modules/qq/config', { values: { accountId: '12345' } }, 'PUT');
  const exported = await source.api(`/api/characters/${created.id}/export`);
  const { status, ...bundle } = exported;
  assert.deepEqual(Object.keys(bundle).sort(), ['character', 'format', 'schemaVersion']);
  assert.equal(bundle.format, 'ai-future-character');
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.character.id, created.id);
  assert.deepEqual(bundle.character.raw, raw);
  const imported = await target.api('/api/characters/import', { document: bundle });
  assert.equal(imported.character.id, created.id);
  assert.equal(imported.character.revision, 1);
  assert.deepEqual(imported.character.raw, raw);
  const duplicate = await target.api('/api/characters/import', { document: JSON.parse(JSON.stringify(bundle)) });
  assert.equal(duplicate.status, 200);
  assert.equal((await target.api('/api/state')).characters.length, 1);
  assert.equal((await target.api('/api/characters/import', { document: { ...bundle, character: { ...bundle.character, revision: 2 } } })).status, 409);
  assert.equal((await target.api('/api/characters/import', { document: { ...bundle, character: { ...bundle.character, name: '冲突' } } })).status, 409);
  assert.equal((await target.api('/api/characters/import', { document: { ...bundle, schemaVersion: 999 } })).status, 400);
  assert.equal((await target.api('/api/characters/import', { document: { format: 'ai-future-character', name: '不能冒充普通卡' } })).status, 400);
});

test('角色素材索引仅导出受管元数据，绝对路径和额外配置不能进入包信封', async t => {
  const app = await fixture(t);
  const document = {
    format: 'ai-future-character', schemaVersion: 1,
    character: {
      id: 'shared-character', name: '共享角色', description: '', revision: 3,
      raw: { name: '共享角色', custom: { pathInOriginalCard: 'C:\\raw-card\\image.png' } },
      assets: [
        { id: 'portrait', kind: 'image', name: '立绘', moduleId: 'drawing', characterId: 'shared-character', ref: 'images/portrait.png', absolutePath: 'C:\\secret.png', apiKey: 'secret' },
        { id: 'voice', kind: 'audio', name: '声线', moduleId: null, characterId: 'shared-character', ref: 'C:\\private.wav' },
      ],
    },
    config: { token: 'secret' }, events: [{ message: 'private' }],
  };
  assert.equal((await app.api('/api/characters/import', { document })).status, 200);
  const exported = await app.api('/api/characters/shared-character/export');
  assert.equal(exported.config, undefined);
  assert.equal(exported.events, undefined);
  assert.equal(exported.character.revision, 3);
  assert.equal(exported.character.assets[0].ref, 'images/portrait.png');
  assert.equal(exported.character.assets[0].absolutePath, undefined);
  assert.equal(exported.character.assets[0].apiKey, undefined);
  assert.equal(exported.character.assets[1].ref, undefined);
  assert.equal(exported.character.raw.custom.pathInOriginalCard, 'C:\\raw-card\\image.png');
  assert.equal((await app.api('/api/characters/import', { document })).status, 200);
  assert.equal((await app.api('/api/characters/import', { document: { ...document, character: { ...document.character, id: 'another-character' } } })).status, 400);
});

test('路径检查逐项返回错误，修改后清除旧检查，网址只标记尚未连接', async t => {
  const app = await fixture(t);
  await app.api('/api/modules/drawing/config', { values: { comfyPath: join(app.root, 'missing'), outputPath: join(app.staticDir, 'index.html'), serviceUrl: 'http://127.0.0.1:1' } }, 'PUT');
  const checked = await app.api('/api/modules/drawing/check-paths', {});
  assert.equal(checked.status, 200);
  assert.equal(checked.checks.comfyPath.status, 'missing');
  assert.equal(checked.checks.outputPath.status, 'wrong-type');
  assert.equal(checked.checks.serviceUrl.status, 'unchecked');
  assert.ok(Date.parse(checked.checks.comfyPath.checkedAt));
  assert.ok(!checked.checks.comfyPath.message.includes(app.root));
  await app.api('/api/modules/drawing/config', { values: { comfyPath: app.root } }, 'PUT');
  const cleared = (await app.api('/api/state')).modules.find(module => module.id === 'drawing');
  assert.equal(cleared.checks.comfyPath, undefined);
  assert.equal(cleared.checks.outputPath.status, 'wrong-type');
  assert.equal((await app.api('/api/modules/drawing/check-paths', {})).checks.comfyPath.status, 'valid');
  assert.equal((await app.api('/api/modules/training/check-paths', {})).checks.trainerPath.status, 'empty');
  assert.equal((await app.api('/api/health')).ok, true);
});

test('配置、主题、当前角色、版本及事件关闭再打开仍保留', async t => {
  const app = await fixture(t);
  const character = (await app.api('/api/characters', { name: '重启保留', raw: { nested: { value: 7 } } })).character;
  await app.api('/api/characters/select', { id: character.id });
  await app.api('/api/modules/training/config', { values: { trainerPath: app.root } }, 'PUT');
  await app.api('/api/modules/training/enable', {});
  await app.api('/api/modules/training/open', {});
  await app.api('/api/preferences', { theme: 'dark' });
  const before = await app.api('/api/state');
  await app.close();
  const reopened = await backend.createWorkbench({ dataDir: app.dataDir, staticDir: app.staticDir });
  try { assert.deepEqual(await api(reopened.url, '/api/state'), before); }
  finally { await reopened.close(); }
});

test('模块日志只接受已知事件，失败隔离，最多保存最近 500 条', async t => {
  const app = await fixture(t);
  assert.equal((await app.api('/api/events', { moduleId: 'qq', kind: 'module.loaded', level: 'info', message: '已加载' })).status, 409);
  await app.api('/api/modules/cards/enable', {});
  await app.api('/api/modules/drawing/enable', {});
  assert.equal((await app.api('/api/events', { moduleId: 'drawing', kind: 'module.load.failed', level: 'error', message: '页面加载失败' })).status, 200);
  assert.equal((await app.api('/api/events', { moduleId: 'not-there', kind: 'module.load.failed', level: 'error', message: 'x' })).status, 404);
  assert.equal((await app.api('/api/events', { moduleId: 'cards', kind: 'module.loaded', level: 'info', message: 'x', extra: 7 })).status, 400);
  assert.equal((await app.api('/api/events', { moduleId: 'cards', kind: 'module.loaded', level: 'info', message: 'x'.repeat(1001) })).status, 400);
  assert.equal((await app.api('/api/events', { moduleId: 'cards', characterId: 'not-there', kind: 'module.loaded', level: 'info', message: 'x' })).status, 404);
  assert.equal((await app.api('/api/state')).modules.find(module => module.id === 'cards').enabled, true);
  const filtered = await app.api('/api/events?moduleId=drawing');
  assert.ok(filtered.events.every(event => event.moduleId === 'drawing'));
  for (let index = 0; index < 505; index++) await app.api('/api/events', { moduleId: 'cards', kind: 'module.loaded', level: 'info', message: `加载 ${index}` });
  const events = (await app.api('/api/state')).events;
  assert.equal(events.length, 500);
  assert.equal(events[0].message, '加载 504');
});

test('启用、打开、检查网址只准备内置规则，不连接外部服务或执行生成任务', async t => {
  const app = await fixture(t);
  let externalCalls = 0;
  const target = createServer((req, res) => { externalCalls++; res.end('{}'); });
  await new Promise(resolveListen => target.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => target.close(resolveClose)));
  const serviceUrl = `http://127.0.0.1:${target.address().port}`;
  for (const id of ['drawing', 'voice', 'companion', 'qq', 'mc-play']) {
    await app.api(`/api/modules/${id}/config`, { values: { serviceUrl } }, 'PUT');
    await app.api(`/api/modules/${id}/enable`, {});
    await app.api(`/api/modules/${id}/open`, {});
    await app.api(`/api/modules/${id}/check-paths`, {});
  }
  await app.api('/api/modules/training/enable', {});
  await app.api('/api/modules/training/open', {});
  assert.equal(externalCalls, 0);
  assert.deepEqual((await app.api('/api/state')).tasks.map(({moduleId,status})=>({moduleId,status})),[{moduleId:'companion',status:'completed'}]);
  const prepared=await app.api('/api/modules/companion/resources');assert.equal(prepared.prerequisitesReady,true);assert.ok(prepared.resources.every(resource=>resource.downloadBytes===0));
  assert.ok((await readdir(app.dataDir)).every(name => /^(?:workbench|instances)\.sqlite(?:-wal|-shm)?$/.test(name) || ['mcp-connection.json','instances','instances.lock','shared-voice','resources'].includes(name)));
  assert.deepEqual(await readdir(join(app.dataDir,'resources')),['companion']);
  assert.deepEqual(await readdir(join(app.dataDir,'shared-voice','studio','jobs')),[],'创建声音库不执行任何推理任务');
  assert.deepEqual(await readdir(join(app.dataDir,'instances')),[]);
});

test('只绑定回环并拒绝异源、伪造 Host、超大正文和静态目录穿越', async t => {
  const app = await fixture(t);
  await assert.rejects(backend.createWorkbench({ dataDir: app.dataDir, host: '0.0.0.0' }), /回环/);
  const foreign = await fetch(`${app.url}/api/preferences`, { method: 'POST', headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{"theme":"dark"}' });
  assert.equal(foreign.status, 403);
  const nullOrigin = await fetch(`${app.url}/api/state`, { headers: { origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  const forgedHostStatus = await new Promise((resolveRequest, reject) => {
    const req = request(`${app.url}/api/state`, { headers: { host: 'evil.invalid' } }, response => { response.resume(); resolveRequest(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  const large = await fetch(`${app.url}/api/characters/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: { name: '卡', value: 'a'.repeat(2 * 1024 * 1024) } }) });
  assert.equal(large.status, 413);
  assert.match((await large.json()).error, /2 MiB/);
  assert.equal((await fetch(`${app.url}/%2e%2e%5csecret.txt`)).status, 400);
  assert.equal((await fetch(`${app.url}/%2f..%2fsecret.txt`)).status, 400);
  assert.equal((await fetch(`${app.url}/api/characters`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${app.url}/api/characters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })).status, 400);
  assert.equal((await fetch(`${app.url}/api/characters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad}' })).status, 400);
  assert.match(await (await fetch(app.url)).text(), /工作台测试/);
  await writeFile(join(app.root, 'secret.txt'), 'private');
  await symlink(app.root, join(app.staticDir, 'outside'), 'junction');
  assert.equal((await fetch(`${app.url}/outside/secret.txt`)).status, 404);
  assert.equal((await fetch(`${app.url}/outside/data/workbench.sqlite`)).status, 404);
  assert.equal((await app.api('/api/state')).preferences.theme, 'light');
});

test('分块过大正文返回 JSON 413，服务仍响应健康检查', async t => {
  const app = await fixture(t);
  const response = await new Promise((resolveRequest, reject) => {
    const req = request(`${app.url}/api/characters/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolveRequest({ status: res.statusCode, value: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write('{"document":{"name":"卡","large":"');
    req.write('a'.repeat(2 * 1024 * 1024));
    req.end('"}}');
  });
  assert.equal(response.status, 413);
  assert.match(response.value.error, /2 MiB/);
  assert.equal((await app.api('/api/health')).ok, true);
});

test('异步路径检查携带配置版本，旧结果不能覆盖已修改的新状态', async t => {
  const app = await fixture(t);
  const { WorkbenchStore } = await import('../framework/store.mjs');
  const store = new WorkbenchStore(join(app.root, 'concurrent-data'));
  try {
    store.saveConfig('drawing', { comfyPath: app.root });
    const snapshot = store.module('drawing');
    store.saveConfig('drawing', { comfyPath: join(app.root, 'new-value') });
    const staleChecks = { comfyPath: { status: 'valid', message: '旧路径存在。', checkedAt: new Date().toISOString() } };
    assert.deepEqual(store.applyChecks('drawing', snapshot.configRevision, staleChecks), {});
    assert.equal(store.module('drawing').config.comfyPath, join(app.root, 'new-value'));
    const current = store.module('drawing');
    const currentChecks = { comfyPath: { status: 'missing', message: '找不到此路径。', checkedAt: new Date().toISOString() } };
    assert.deepEqual(store.applyChecks('drawing', current.configRevision, currentChecks), currentChecks);
    store.saveConfig('drawing', { comfyPath: app.root });
    assert.deepEqual(store.applyChecks('drawing', snapshot.configRevision, staleChecks), {});
  } finally { store.close(); }
});

test('原卡过深时明确拒绝，普通原卡保留原型同名字段，导出记录不携带配置', async t => {
  const app = await fixture(t);
  let nested = {};
  for (let depth = 0; depth < 70; depth++) nested = { nested };
  assert.equal((await app.api('/api/characters/import', { document: { name: '过深', nested } })).status, 400);
  const document = JSON.parse('{"name":"自定义字段","__proto__":{"preserved":true},"constructor":{"custom":7}}');
  const { character } = await app.api('/api/characters/import', { document });
  const bundle = await app.api(`/api/characters/${character.id}/export`);
  assert.deepEqual(bundle.character.raw, document);
  assert.equal(({}).preserved, undefined);
  const event = (await app.api('/api/events')).events.find(entry => entry.kind === 'character.exported');
  assert.equal(event.characterId, character.id);
  assert.equal(event.moduleId, null);
  assert.equal((await app.api('/api/characters/import', { document: { format: 'ai-future-character', schemaVersion: 1, character: { ...bundle.character, revision: 0 } } })).status, 400);
});

test('日志屏蔽本地路径，静态模块正确提供 JS MIME 和 HEAD', async t => {
  const app = await fixture(t);
  await writeFile(join(app.staticDir, 'module.js'), 'export const moduleId = "cards";');
  const response = await fetch(`${app.url}/module.js`);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(await response.text(), /export const/);
  const head = await fetch(`${app.url}/module.js`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
  await app.api('/api/events', { moduleId: 'cards', kind: 'module.load.failed', level: 'error', message: '加载 C:\\private\\module.js 以及 /home/private/module.js 失败。' });
  const event = (await app.api('/api/events')).events[0];
  assert.doesNotMatch(event.message, /C:|\/home\/private/);
  assert.match(event.message, /本地路径/);
  assert.equal((await app.api('/api/events?moduleId=unknown')).status, 404);
});

test('UNC、设备路径和相对路径在读取文件系统前返回未检查', async t => {
  const app = await fixture(t);
  let reads = 0;
  const intercepted = async () => { reads++; throw new Error('不应读取这个路径'); };
  t.mock.method(fs, 'stat', intercepted);
  t.mock.method(fs, 'lstat', intercepted);
  syncBuiltinESMExports();
  try {
    const paths = ['\\\\server.invalid\\share\\models', '//server.invalid/share/models', '\\\\?\\UNC\\server.invalid\\share', '\\\\?\\C:\\models', '\\\\.\\C:\\models', 'relative/models', 'C:relative'];
    for (const path of paths) {
      await app.api('/api/modules/drawing/config', { values: { comfyPath: path } }, 'PUT');
      const checked = await app.api('/api/modules/drawing/check-paths', {});
      assert.equal(checked.checks.comfyPath.status, 'unchecked');
      assert.match(checked.checks.comfyPath.message, /本地.*绝对路径/);
    }
    assert.equal(reads, 0, '远程或设备路径不应进入 stat / lstat');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('路径检查不跟随符号链接或目录联接，普通本地路径仍然有效', async t => {
  const app = await fixture(t);
  const linked = join(app.root, 'linked-public');
  await symlink(app.staticDir, linked, 'junction');
  for (const path of [linked, join(linked, 'index.html')]) {
    await app.api('/api/modules/voice/config', { values: { modelPath: path } }, 'PUT');
    const checked = await app.api('/api/modules/voice/check-paths', {});
    assert.equal(checked.checks.modelPath.status, 'unchecked');
    assert.match(checked.checks.modelPath.message, /链接路径暂不检查/);
  }
  await app.api('/api/modules/voice/config', { values: { modelPath: join(app.staticDir, 'index.html') } }, 'PUT');
  assert.equal((await app.api('/api/modules/voice/check-paths', {})).checks.modelPath.status, 'valid');
});

test('完整角色包超出重导入预算时写入前拒绝，计入中文简介的重复字节', async t => {
  const app = await fixture(t);
  const document = { name: 'roundtrip', description: '中'.repeat(64_000), padding: 'x'.repeat(1_753_000) };
  assert.ok(Buffer.byteLength(JSON.stringify(document)) < 1900 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ document })) < 2 * 1024 * 1024);
  const response = await app.api('/api/characters/import', { document });
  assert.equal(response.status, 400);
  assert.match(response.error, /角色资料包.*2 MiB/);
  const state = await app.api('/api/state');
  assert.deepEqual(state.characters, []);
  assert.deepEqual(state.events, []);
});

test('预算内的大型原卡可以完整导出再导入，不因固定余量被误拒绝', async t => {
  const source = await fixture(t);
  const target = await fixture(t);
  const document = { name: '大卡往返', description: '中文'.repeat(1000), padding: 'x'.repeat(1_850_000), entries: Array.from({ length: 1000 }, (_, index) => ({ index, text: '资料' })) };
  const created = await source.api('/api/characters/import', { document });
  assert.equal(created.status, 200);
  const { status, ...bundle } = await source.api(`/api/characters/${created.character.id}/export`);
  assert.equal(status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify({ document: bundle })) <= 2 * 1024 * 1024);
  const imported = await target.api('/api/characters/import', { document: bundle });
  assert.equal(imported.status, 200);
  assert.equal(imported.character.id, created.character.id);
  assert.deepEqual(imported.character.raw, document);
});
