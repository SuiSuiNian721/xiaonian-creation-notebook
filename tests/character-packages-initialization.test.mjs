import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';
import { WorkbenchStore } from '../framework/store.mjs';
import { characterPackageAdapter, characterResourceCatalog } from '../framework/character-packages.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workbench-bundled-init-'));
  const app = await createWorkbench({ dataDir, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const api = async (path, value) => {
    const response = await fetch(app.url + path, { method: value === undefined ? 'GET' : 'POST',
      headers: value === undefined ? {} : { 'content-type': 'application/json' },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { httpStatus: response.status, ...await response.json() };
  };
  return { app, api, dataDir };
}

const resourcePath = (moduleId, prefix = '') => `${prefix}/api/modules/${moduleId}/resources`;
const policyPath = resource => join(resource.installationDirectory, resource.id, resource.version, 'policy.json');

test('首次添加角色和陪伴模块自动校验内置策略，不请求安装计划', async t => {
  const { api } = await fixture(t);
  for (const moduleId of Object.keys(characterResourceCatalog)) {
    assert.equal((await api(resourcePath(moduleId))).prerequisitesReady, false);
    assert.equal((await api(`/api/modules/${moduleId}/enable`, {})).httpStatus, 200);
    const state = await api(resourcePath(moduleId));
    assert.equal(state.prerequisitesReady, true, moduleId);
    assert.ok(state.resources.every(resource => resource.status === 'installed'));
    for (const resource of state.resources) assert.match(await readFile(policyPath(resource), 'utf8'), /ai-future-behavior-policy/);
  }
});

test('并行创建实例自动准备并共享策略，保留全局模块开关及各自人设', async t => {
  const installed = [];
  const { app, api } = await fixture(t, { installationAdapters: { 'local-character-policy': {
    ...characterPackageAdapter,
    async install(context) { installed.push(context.resource.id); await characterPackageAdapter.install(context); },
  } } });
  const results = await Promise.all(['companion-lite', 'companion', 'character-full'].map(moduleId => api('/api/instances', { moduleId })));
  const directories = [];
  for (const result of results) {
    assert.equal(result.httpStatus, 201, JSON.stringify(result));
    const { instance } = result, prefix = '/instances/' + instance.id;
    const state = await api(resourcePath(instance.moduleId, prefix));
    assert.equal(state.prerequisitesReady, true, instance.moduleId);
    directories.push(state.resources.find(resource => resource.id === 'role-base').installationDirectory);
    assert.equal((await api(prefix + '/api/state')).characters.length, 0);
  }
  assert.equal(new Set(directories).size, 1);
  assert.equal(installed.filter(id => id === 'role-base').length, 1);
  assert.equal(installed.filter(id => id === 'role-full').length, 1);
  assert.ok((await api('/api/state')).modules.every(module => !module.enabled));
  const original = (await api('/api/characters', { name: '保留人设', description: '沿用资料库' })).character;
  const instance = results[0].instance;
  const copied = await api(`/api/instances/${instance.id}/persona`, { source: 'library', characterId: original.id });
  const before = app.context.instanceManager.context(instance.id).store.state();
  await api(`/api/instances/${instance.id}/stop`, {});
  await api(`/api/instances/${instance.id}/start`, {});
  const after = await api(`/instances/${instance.id}/api/state`);
  assert.equal(after.selectedCharacterId, copied.character.id);
  assert.deepEqual(after.characters, before.characters);
  assert.equal(installed.filter(id => id === 'role-base').length, 1);
});

test('重复添加复用已校验文件，损坏只撤销能力并在再次添加时修复', async t => {
  const { app, api } = await fixture(t);
  await api('/api/modules/character-full/enable', {});
  const state = await api(resourcePath('character-full'));
  assert.equal(state.prerequisitesReady, true);
  const file = policyPath(state.resources[0]), original = await readFile(file, 'utf8');
  const modified = (await stat(file)).mtimeMs, record = app.context.store.getSetting('module.resources.character-full');
  const character = (await api('/api/characters', { name: '原有角色', description: '原有人设' })).character;
  await api('/api/characters/select', { id: character.id });
  await api('/api/modules/character-full/disable', {});
  await api('/api/modules/character-full/enable', {});
  assert.equal((await stat(file)).mtimeMs, modified);
  assert.deepEqual(app.context.store.getSetting('module.resources.character-full'), record);
  await writeFile(file, '{}', 'utf8');
  assert.equal((await api(resourcePath('character-full'))).prerequisitesReady, false);
  await api('/api/modules/character-full/enable', {});
  assert.equal((await api(resourcePath('character-full'))).prerequisitesReady, true);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await api('/api/state')).selectedCharacterId, character.id);
});

test('旧资料已启用但从未安装时启动补准备，初始化失败仍可进入工作台并重试', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workbench-bundled-legacy-'));
  const store = new WorkbenchStore(dataDir);
  store.setEnabled('companion-lite', true);
  store.setSetting('user.profile', { name: '旧资料名字' });
  store.close();
  let fail = true;
  const app = await createWorkbench({ dataDir, installationAdapters: { 'local-character-policy': {
    ...characterPackageAdapter,
    async install(context) { if (fail) throw new Error('测试磁盘暂不可写'); await characterPackageAdapter.install(context); },
  } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let state = await (await fetch(app.url + resourcePath('companion-lite'))).json();
  assert.equal(state.prerequisitesReady, false);
  assert.equal(state.task?.status, 'failed');
  assert.match(state.task.error, /磁盘暂不可写/);
  assert.equal((await fetch(app.url + '/api/state')).status, 200);
  assert.deepEqual(app.context.store.getSetting('user.profile'), { name: '旧资料名字' });
  fail = false;
  const result = await fetch(app.url + '/api/modules/companion-lite/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 200);
  state = await (await fetch(app.url + resourcePath('companion-lite'))).json();
  assert.equal(state.prerequisitesReady, true);
});

test('创建实例失败不假报就绪，现有手动安装入口可以恢复', async t => {
  let fail = true;
  const { api } = await fixture(t, { installationAdapters: { 'local-character-policy': {
    ...characterPackageAdapter,
    async install(context) { if (fail) throw new Error('内置策略写入失败'); await characterPackageAdapter.install(context); },
  } } });
  const result = await api('/api/instances', { moduleId: 'companion-lite' });
  assert.equal(result.httpStatus, 201);
  const base = resourcePath('companion-lite', '/instances/' + result.instance.id);
  const failed = await api(base);
  assert.equal(failed.prerequisitesReady, false);
  assert.equal(failed.task?.status, 'failed');
  fail = false;
  const plan = await api(base + '/plan', { optionalIds: [] });
  assert.equal((await api(base + '/install', { planId: plan.planId, optionalIds: [] })).httpStatus, 200);
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await api(base);
    if (state.prerequisitesReady) return;
    assert.notEqual(state.task?.status, 'failed');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('恢复安装未结束');
});

test('自动准备只接受随工作台提供的完整可信清单，不触发外部下载', async t => {
  let downloads = 0;
  const customized = structuredClone(characterResourceCatalog['character-full']);
  customized.resources.push({ id: 'external-model', name: '外部模型', required: true, status: 'available', version: '1',
    sourceLabel: '外部下载', downloadBytes: 1, installedBytes: 1, adapterId: 'external' });
  const { api } = await fixture(t, { resourceCatalog: { 'character-full': customized }, installationAdapters: {
    external: { async install() { downloads++; }, async verify() { return true; } },
    'qq-napcat': { async install() { downloads++; }, async verify() { return true; } },
  } });
  for (const id of ['character-full', 'qq']) {
    await api(`/api/modules/${id}/enable`, {});
    const state = await api(resourcePath(id));
    assert.equal(state.prerequisitesReady, false);
    assert.equal(state.task, null);
  }
  await api('/api/modules/companion-lite/enable', {});
  assert.equal((await api(resourcePath('companion-lite'))).prerequisitesReady, true);
  assert.equal(downloads, 0);
});
