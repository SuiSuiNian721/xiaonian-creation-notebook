import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';
import { WorkbenchStore } from '../framework/store.mjs';

const route = (id = 'drawing', action = '') => `/api/modules/${id}/resources${action ? `/${action}` : ''}`;
const resource = (id, required, overrides = {}) => ({ id, name: id, version: '1.0', required, status: 'available', sourceLabel: '隔离测试文件', downloadBytes: 4, installedBytes: 4, adapterId: 'fixture', ...overrides });
const catalog = () => ({ drawing: { revision: 'fixture-v1', resources: [resource('runtime', true), resource('model', false)] }, voice: { revision: 'fixture-v1', resources: [resource('voice-runtime', true), resource('voice-model', false)] } });
const fileAdapter = () => ({
  async install({ resource: entry, directory, signal, report }) {
    signal.throwIfAborted();
    report({ stage: '写入测试文件', completedBytes: 0, totalBytes: 4 });
    await writeFile(join(directory, `${entry.id}.txt`), 'test');
    report({ stage: '测试文件已写入', completedBytes: 4, totalBytes: 4 });
  },
  async verify({ resource: entry, directory }) { return await readFile(join(directory, `${entry.id}.txt`), 'utf8') === 'test'; },
});

async function api(url, path, value, method = value === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${url}${path}`, { method, headers: value === undefined ? {} : { 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { httpStatus: response.status, ...(await response.json()) };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-future-installation-'));
  const dataDir = join(root, 'data');
  const app = await createWorkbench({ dataDir, ...options });
  t.after(async () => {
    await app.close();
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  return { ...app, root, dataDir, api: (path, value, method) => api(app.url, path, value, method) };
}

async function waitFor(app, predicate, id = 'drawing') {
  const limit = Date.now() + 4000;
  while (Date.now() < limit) {
    const state = await app.api(route(id));
    if (predicate(state)) return state;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.fail('资源任务未在预期时间内达到目标状态');
}

async function start(app, optionalIds = [], id = 'drawing') {
  await app.api(`/api/modules/${id}/enable`, {});
  const plan = await app.api(route(id, 'plan'), { optionalIds });
  assert.equal(plan.httpStatus, 200);
  return app.api(route(id, 'install'), { optionalIds, planId: plan.planId });
}

test('外部模块清单声明待接入前置，预览只读，添加不创建任务或资源目录', async t => {
  const app = await fixture(t);
  const cards = await app.api(route('cards'));
  assert.equal(cards.prerequisitesReady, true);
  assert.deepEqual(cards.resources, []);
  const skin = await app.api(route('mc-skin'));
  assert.equal(skin.prerequisitesReady, true);
  assert.deepEqual(skin.resources, []);
  const play = await app.api(route('mc-play'));
  assert.equal(play.prerequisitesReady, true);
  assert.deepEqual(play.resources, []);
  const training = await app.api(route('training'));
  assert.equal(training.prerequisitesReady, true);
  assert.deepEqual(training.resources, []);
  assert.equal(training.task, null);
  for (const id of ['drawing']) {
    const state = await app.api(route(id));
    assert.equal(state.httpStatus, 200);
    assert.equal(state.moduleId, id);
    assert.equal(state.directory, join(app.dataDir, 'resources', id));
    assert.equal(state.prerequisitesReady, false);
    assert.equal(state.task, null);
    assert.deepEqual(state.optionalIds, []);
    assert.equal(state.resources.length, 1);
    assert.deepEqual(state.resources.map(item => [item.required, item.selected, item.status, item.version, item.downloadBytes, item.installedBytes]), [[true, true, 'pending', null, null, null]]);
    assert.match(state.resources[0].reason, /安装包尚未接入/);
    const before = await app.api('/api/state');
    const plan = await app.api(route(id, 'plan'), { optionalIds: [] });
    assert.equal(plan.canInstall, false);
    assert.equal(plan.downloadBytes, null);
    assert.equal(plan.installedBytes, null);
    assert.equal(plan.unknownSizeCount, 1);
    assert.deepEqual(await app.api('/api/state'), before);
    await app.api(`/api/modules/${id}/enable`, {});
    assert.equal((await app.api(route(id, 'install'), { planId: plan.planId, optionalIds: [] })).httpStatus, 409);
    assert.equal((await app.api(route(id))).task, null);
  }
  for(const id of ['voice','voice-design']){const state=await app.api(route(id));assert.equal(state.prerequisitesReady,true);assert.deepEqual(state.resources,[]);assert.equal(state.task,null);}
  assert.deepEqual((await app.api('/api/state')).tasks, []);
  assert.ok((await readdir(app.dataDir)).every(name => /^(?:workbench|instances)\.sqlite(?:-wal|-shm)?$/.test(name) || ['mcp-connection.json','instances','instances.lock','shared-voice'].includes(name)));
  assert.deepEqual(await readdir(join(app.dataDir,'shared-voice','studio','jobs')),[]);
  assert.deepEqual(await readdir(join(app.dataDir,'instances')),[]);
});

test('服务端强制纳入前置并拒绝无效选择和额外字段，未知大小保持 null', async t => {
  const entries = catalog();
  entries.drawing.resources[1].downloadBytes = null;
  const app = await fixture(t, { resourceCatalog: entries, installationAdapters: { fixture: fileAdapter() } });
  const plan = await app.api(route('drawing', 'plan'), { optionalIds: ['model'] });
  assert.equal(plan.httpStatus, 200);
  assert.deepEqual(plan.resources.map(item => item.id), ['runtime', 'model']);
  assert.equal(plan.downloadBytes, null);
  assert.equal(plan.installedBytes, 8);
  assert.equal(plan.unknownSizeCount, 1);
  assert.equal(plan.canInstall, true);
  for (const optionalIds of [['runtime'], ['unknown'], ['model', 'model'], null, 'model']) {
    assert.equal((await app.api(route('drawing', 'plan'), { optionalIds })).httpStatus, 400);
    assert.equal((await app.api(route('drawing', 'selection'), { optionalIds }, 'PUT')).httpStatus, 400);
  }
  assert.equal((await app.api(route('drawing', 'plan'), { optionalIds: [], adapter: 'shell' })).httpStatus, 400);
  assert.equal((await app.api(route('drawing', 'install'), { optionalIds: [], planId: 'unknown' })).httpStatus, 409);
  assert.equal((await app.api(route('missing'))).httpStatus, 404);
  assert.equal((await app.api(route(), {}, 'POST')).httpStatus, 405);
});

test('可选选择按模块隔离并持久化，改动选择使旧确认失效', async t => {
  const entries = catalog();
  const options = { resourceCatalog: entries, installationAdapters: { fixture: fileAdapter() } };
  const app = await fixture(t, options);
  await app.api('/api/modules/drawing/enable', {});
  const old = await app.api(route('drawing', 'plan'), { optionalIds: [] });
  const selected = await app.api(route('drawing', 'selection'), { optionalIds: ['model'] }, 'PUT');
  assert.equal(selected.httpStatus, 200);
  assert.deepEqual(selected.optionalIds, ['model']);
  assert.equal(selected.resources.find(item => item.id === 'model').selected, true);
  assert.deepEqual((await app.api(route('voice'))).optionalIds, []);
  assert.equal((await app.api(route('drawing', 'install'), { planId: old.planId, optionalIds: [] })).httpStatus, 409);
  await app.close();
  const reopened = await createWorkbench({ dataDir: app.dataDir, ...options });
  try {
    assert.deepEqual((await api(reopened.url, route())).optionalIds, ['model']);
    assert.deepEqual((await api(reopened.url, route('voice'))).optionalIds, []);
  } finally { await reopened.close(); }
});

test('元数据和确认选择变化使计划失效，停用模块不能安装', async t => {
  const entries = catalog();
  const app = await fixture(t, { resourceCatalog: entries, installationAdapters: { fixture: fileAdapter() } });
  const disabled = await app.api(route('drawing', 'plan'), { optionalIds: [] });
  assert.equal((await app.api(route('drawing', 'install'), { planId: disabled.planId, optionalIds: [] })).httpStatus, 409);
  await app.api('/api/modules/drawing/enable', {});
  const old = await app.api(route('drawing', 'plan'), { optionalIds: [] });
  entries.drawing.resources[0].version = '2.0';
  assert.equal((await app.api(route('drawing', 'install'), { planId: old.planId, optionalIds: [] })).httpStatus, 409);
  const current = await app.api(route('drawing', 'plan'), { optionalIds: [] });
  assert.equal((await app.api(route('drawing', 'install'), { planId: current.planId, optionalIds: ['model'] })).httpStatus, 409);
  assert.equal((await app.api(route())).task, null);
});

test('适配器写入并校验后才标记成功，前置复用且可选文件不影响基础就绪', async t => {
  const entries = catalog();
  const installed = [];
  const adapter = fileAdapter();
  const original = adapter.install;
  adapter.install = async context => { installed.push(context.resource.id); await original(context); };
  const options = { resourceCatalog: entries, installationAdapters: { fixture: adapter } };
  const app = await fixture(t, options);
  await app.api('/api/modules/drawing/enable', {});
  const old = await app.api(route('drawing', 'plan'), { optionalIds: ['model'] });
  const launched = await start(app);
  assert.equal(launched.httpStatus, 200);
  assert.ok(['queued', 'running'].includes(launched.task.status));
  let state = await waitFor(app, value => value.task?.status === 'completed');
  assert.equal(state.prerequisitesReady, true);
  assert.equal(state.resources.find(item => item.id === 'runtime').status, 'installed');
  assert.equal(state.resources.find(item => item.id === 'model').status, 'available');
  assert.equal(await readFile(join(state.directory, 'runtime.txt'), 'utf8'), 'test');
  assert.equal((await app.api(route('drawing', 'install'), { planId: old.planId, optionalIds: ['model'] })).httpStatus, 409);
  const plan = await app.api(route('drawing', 'plan'), { optionalIds: ['model'] });
  assert.equal(plan.downloadBytes, 4);
  assert.equal(plan.installedBytes, 4);
  assert.deepEqual(plan.resources.map(item => item.id), ['runtime', 'model']);
  assert.equal((await app.api(route('drawing', 'install'), { planId: plan.planId, optionalIds: ['model'] })).httpStatus, 200);
  state = await waitFor(app, value => value.task?.status === 'completed' && value.resources.every(item => item.status === 'installed'));
  assert.deepEqual(installed, ['runtime', 'model']);
  assert.equal((await app.api('/api/state')).tasks[0].status, 'completed');
  await app.close();
  const reopened = await createWorkbench({ dataDir: app.dataDir, ...options });
  try {
    const persisted = await api(reopened.url, route());
    assert.equal(persisted.task.status, 'completed');
    assert.equal(persisted.prerequisitesReady, true);
    entries.drawing.resources[0].version = '2.0';
    assert.equal((await api(reopened.url, route())).prerequisitesReady, false);
  } finally { await reopened.close(); }
});

test('清单可选项在前时仍先安装全部前置，各组保留原始顺序', async t => {
  const entries = catalog();
  entries.drawing.resources = [resource('model-a', false), resource('runtime-a', true), resource('model-b', false), resource('runtime-b', true)];
  const installed = [];
  const adapter = fileAdapter();
  const original = adapter.install;
  adapter.install = async context => { installed.push(context.resource.id); await original(context); };
  const app = await fixture(t, { resourceCatalog: entries, installationAdapters: { fixture: adapter } });
  assert.equal((await start(app, ['model-b', 'model-a'])).httpStatus, 200);
  await waitFor(app, value => value.task?.status === 'completed');
  assert.deepEqual(installed, ['runtime-a', 'runtime-b', 'model-a', 'model-b']);
});

test('只报告适配器真实阶段和字节，不伪造计时进度，同模块拒绝并发', async t => {
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const adapter = fileAdapter();
  const original = adapter.install;
  adapter.install = async context => {
    context.report({ stage: '等待测试数据', completedBytes: 2, totalBytes: 4 });
    await gate;
    await original(context);
  };
  const app = await fixture(t, { resourceCatalog: catalog(), installationAdapters: { fixture: adapter } });
  t.after(release);
  const launched = await start(app);
  assert.equal(launched.httpStatus, 200);
  const state = await waitFor(app, value => value.task?.stage === '等待测试数据');
  assert.equal(state.task.completedBytes, 2);
  assert.equal(state.task.totalBytes, 4);
  assert.equal(state.task.currentResourceId, 'runtime');
  const plan = await app.api(route('drawing', 'plan'), { optionalIds: [] });
  assert.equal((await app.api(route('drawing', 'install'), { planId: plan.planId, optionalIds: [] })).httpStatus, 409);
  assert.deepEqual((await app.api(route())).task, state.task);
  release();
  await waitFor(app, value => value.task?.status === 'completed');
});

test('安装异常和校验失败不能标记资源已安装', async t => {
  for (const mode of ['throw', 'verify']) {
    const adapter = fileAdapter();
    if (mode === 'throw') adapter.install = async () => { throw new Error('测试下载失败'); };
    else adapter.verify = async () => false;
    const app = await fixture(t, { resourceCatalog: catalog(), installationAdapters: { fixture: adapter } });
    assert.equal((await start(app)).httpStatus, 200);
    const state = await waitFor(app, value => value.task?.status === 'failed');
    assert.equal(state.prerequisitesReady, false);
    assert.equal(state.resources[0].status, 'available');
    assert.match(state.task.error, mode === 'throw' ? /测试下载失败/ : /校验/);
  }
});

test('缺少安装或校验适配器时不可安装且不生成任务', async t => {
  for (const adapters of [{}, { fixture: { install: async () => {} } }]) {
    const app = await fixture(t, { resourceCatalog: catalog(), installationAdapters: adapters });
    await app.api('/api/modules/drawing/enable', {});
    const plan = await app.api(route('drawing', 'plan'), { optionalIds: [] });
    assert.equal(plan.canInstall, false);
    assert.match(plan.reasons.join(' '), /适配器/);
    assert.equal((await app.api(route('drawing', 'install'), { planId: plan.planId, optionalIds: [] })).httpStatus, 409);
    assert.equal((await app.api(route())).task, null);
  }
});

test('取消发出 AbortSignal，错误模块与旧任务 ID 不得影响当前任务', async t => {
  let aborted = false;
  const adapter = {
    async install({ signal, report }) {
      report({ stage: '等待可取消数据' });
      await new Promise((resolveWait, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    },
    async verify() { return true; },
  };
  const app = await fixture(t, { resourceCatalog: catalog(), installationAdapters: { fixture: adapter } });
  const launched = await start(app);
  await waitFor(app, value => value.task?.stage === '等待可取消数据');
  assert.equal((await app.api(route('voice', 'cancel'), { taskId: launched.task.id })).httpStatus, 409);
  assert.equal((await app.api(route('drawing', 'cancel'), { taskId: 'not-current' })).httpStatus, 409);
  const cancelled = await app.api(route('drawing', 'cancel'), { taskId: launched.task.id });
  assert.equal(cancelled.httpStatus, 200);
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(aborted, true);
  const state = await app.api(route());
  assert.equal(state.prerequisitesReady, false);
  assert.equal(state.resources[0].status, 'available');
  assert.equal(state.task.completedBytes, 0);
  assert.equal(state.task.totalBytes, null);
});

test('关闭服务中止并等待安装器，重启保留 interrupted 且不标成功', async t => {
  let settled = false;
  const adapter = {
    async install({ signal, report }) {
      report({ stage: '等待关闭' });
      await new Promise(resolveWait => signal.addEventListener('abort', resolveWait, { once: true }));
      await new Promise(resolveWait => setTimeout(resolveWait, 15));
      report({ stage: '迟到进度不得恢复任务', completedBytes: 4, totalBytes: 4 });
      settled = true;
    },
    async verify() { assert.fail('中断后不应校验'); },
  };
  const options = { resourceCatalog: catalog(), installationAdapters: { fixture: adapter } };
  const app = await fixture(t, options);
  await start(app);
  await waitFor(app, value => value.task?.stage === '等待关闭');
  await app.close();
  assert.equal(settled, true);
  const reopened = await createWorkbench({ dataDir: app.dataDir, ...options });
  try {
    const state = await api(reopened.url, route());
    assert.equal(state.task.status, 'interrupted');
    assert.equal(state.prerequisitesReady, false);
  } finally { await reopened.close(); }
});

test('启动时将意外退出留下的 queued 或 running 任务标为 interrupted', async t => {
  const app = await fixture(t);
  await app.close();
  const store = new WorkbenchStore(app.dataDir);
  for (const [moduleId, status] of [['drawing', 'running'], ['voice', 'queued']]) {
    store.setSetting(`module.resources.${moduleId}`, { optionalIds: [], selectionRevision: 0, installed: {}, task: { id: `old-${moduleId}`, moduleId, status, stage: '旧任务', completedBytes: 2, totalBytes: 4, currentResourceId: 'runtime', at: new Date().toISOString() } });
  }
  store.close();
  const reopened = await createWorkbench({ dataDir: app.dataDir });
  try {
    for (const id of ['drawing', 'voice']) {
      const state = await api(reopened.url, route(id));
      assert.equal(state.task.status, 'interrupted');
      assert.equal(state.task.completedBytes, 2);
      assert.equal(state.prerequisitesReady, id==='voice');
    }
  } finally { await reopened.close(); }
});

test('原生选择目录按模块保存并重启恢复，取消不改位置，更换后旧清单失效', async t => {
  let chosen = null;
  const calls = [];
  const options = { resourceCatalog: catalog(), installationAdapters: { fixture: fileAdapter() }, chooseDirectory: async input => { calls.push(input); return chosen; } };
  const app = await fixture(t, options);
  await app.api('/api/modules/drawing/enable', {});
  const initial = await app.api(route());
  assert.equal(initial.canChooseDirectory, true);
  const old = await app.api(route('drawing', 'plan'), { optionalIds: [] });
  const cancelled = await app.api(route('drawing', 'choose-directory'), {});
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.directory, initial.directory);
  assert.equal((await app.api(route('drawing', 'plan'), { optionalIds: [] })).planId, old.planId);
  chosen = join(app.root, '念念的资源 目录');
  await mkdir(chosen);
  const selected = await app.api(route('drawing', 'choose-directory'), {});
  assert.equal(selected.httpStatus, 200);
  assert.equal(selected.directory, chosen);
  assert.equal(selected.cancelled, false);
  assert.equal(calls[1].defaultPath, initial.directory);
  assert.equal((await app.api(route('voice'))).directory, join(app.dataDir, 'resources', 'voice'));
  assert.deepEqual(await readdir(chosen), []);
  assert.equal((await app.api(route('drawing', 'install'), { planId: old.planId, optionalIds: [] })).httpStatus, 409);
  assert.equal((await app.api(route('drawing', 'plan'), { optionalIds: [] })).directory, chosen);
  assert.equal((await app.api(route('drawing', 'choose-directory'), { directory: app.root })).httpStatus, 400);
  await app.close();
  const reopened = await createWorkbench({ dataDir: app.dataDir, ...options });
  try { assert.equal((await api(reopened.url, route())).directory, chosen); }
  finally { await reopened.close(); }
});

test('更换目录保留原文件，安装状态只对对应目录生效且新任务写入所选位置', async t => {
  let chosen;
  const app = await fixture(t, { resourceCatalog: catalog(), installationAdapters: { fixture: fileAdapter() }, chooseDirectory: async () => chosen });
  assert.equal((await start(app)).httpStatus, 200);
  const installed = await waitFor(app, value => value.task?.status === 'completed');
  chosen = join(app.root, '新的位置'); await mkdir(chosen);
  const newDirectory = chosen;
  let state = await app.api(route('drawing', 'choose-directory'), {});
  assert.equal(state.httpStatus, 200);
  assert.equal(state.prerequisitesReady, false);
  assert.equal(state.task, null);
  assert.equal(await readFile(join(installed.directory, 'runtime.txt'), 'utf8'), 'test');
  chosen = installed.directory;
  assert.equal((await app.api(route('drawing', 'choose-directory'), {})).prerequisitesReady, true);
  chosen = newDirectory;
  await app.api(route('drawing', 'choose-directory'), {});
  assert.equal((await start(app)).httpStatus, 200);
  state = await waitFor(app, value => value.task?.status === 'completed');
  assert.equal(state.prerequisitesReady, true);
  assert.equal(state.task.directory, newDirectory);
  assert.equal(await readFile(join(newDirectory, 'runtime.txt'), 'utf8'), 'test');
  assert.equal(await readFile(join(installed.directory, 'runtime.txt'), 'utf8'), 'test');
});

test('未接入原生选择器或无效选择时保持原目录，不从 HTTP 接收任意路径', async t => {
  const browser = await fixture(t);
  await browser.api('/api/modules/drawing/enable', {});
  assert.equal((await browser.api(route())).canChooseDirectory, false);
  assert.equal((await browser.api(route('drawing', 'choose-directory'), {})).httpStatus, 503);
  let chosen = 'relative-directory';
  const app = await fixture(t, { chooseDirectory: async () => chosen });
  await app.api('/api/modules/drawing/enable', {});
  const initial = await app.api(route());
  for (const value of ['relative-directory', join(app.root, 'missing-folder'), join(app.dataDir, 'workbench.sqlite')]) {
    chosen = value;
    assert.equal((await app.api(route('drawing', 'choose-directory'), {})).httpStatus, 400);
    assert.equal((await app.api(route())).directory, initial.directory);
  }
});

test('选择目录与安装互斥，不重复弹窗，运行时拒绝更换目录', async t => {
  let releasePicker;
  const pickerGate = new Promise(resolveGate => { releasePicker = resolveGate; });
  const adapter = fileAdapter();
  let releaseInstall;
  const installGate = new Promise(resolveGate => { releaseInstall = resolveGate; });
  const install = adapter.install;
  adapter.install = async context => { await installGate; await install(context); };
  const app = await fixture(t, { resourceCatalog: catalog(), installationAdapters: { fixture: adapter }, chooseDirectory: async () => pickerGate });
  t.after(() => { releasePicker(null); releaseInstall(); });
  await app.api('/api/modules/drawing/enable', {});
  await app.api('/api/modules/voice/enable', {});
  const pending = app.api(route('drawing', 'choose-directory'), {});
  await waitFor(app, value => value.choosingDirectory === true);
  assert.equal((await app.api(route('voice', 'choose-directory'), {})).httpStatus, 409);
  assert.equal((await start(app)).httpStatus, 409);
  releasePicker(null);
  assert.equal((await pending).cancelled, true);
  assert.equal((await start(app)).httpStatus, 200);
  await waitFor(app, value => value.task?.status === 'running');
  assert.equal((await app.api(route('drawing', 'choose-directory'), {})).httpStatus, 409);
  releaseInstall();
  await waitFor(app, value => value.task?.status === 'completed');
});
