import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkbench } from '../framework/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-future-module-guides-'));
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map(app => app.close()));
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    await rm(target, { recursive: true, force: true });
  });
  async function open(name = 'data') {
    const dataDir = join(root, name);
    const app = await createWorkbench({ dataDir, port: 0 });
    apps.push(app);
    return {
      ...app, dataDir,
      async api(path, value, method = value === undefined ? 'GET' : 'POST') {
        const response = await fetch(app.url + path, {
          method,
          headers: value === undefined ? {} : { 'content-type': 'application/json' },
          body: value === undefined ? undefined : JSON.stringify(value),
        });
        return { status: response.status, ...(await response.json()) };
      },
    };
  }
  return { open };
}

test('首次使用返回独立的空引导记录，不改变其他工作台状态', async t => {
  const app = await (await fixture(t)).open();
  const state = await app.api('/api/state');
  assert.deepEqual(state.moduleGuides, {});
  assert.deepEqual(state.preferences, { theme: 'light' });
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.tasks, []);
  assert.ok(state.modules.every(module => !module.enabled && module.lastOpenedAt === null));
});

test('首次展示只标记指定模块，重复提交幂等且不触发模块业务', async t => {
  const app = await (await fixture(t)).open();
  const before = await app.api('/api/state');
  assert.deepEqual(await app.api('/api/module-guides/drawing', {}), { status: 200, seen: true });
  const first = await app.api('/api/state');
  assert.deepEqual(first, { ...before, moduleGuides: { drawing: true } });
  assert.deepEqual(await app.api('/api/module-guides/drawing', {}), { status: 200, seen: true });
  assert.deepEqual(await app.api('/api/state'), first);
  assert.deepEqual(await app.api('/api/module-guides/comfyui', {}), { status: 200, seen: true });
  assert.deepEqual((await app.api('/api/state')).moduleGuides, { drawing: true, comfyui: true });
});

test('移除入口后重新添加仍保留该模块的引导记录', async t => {
  const app = await (await fixture(t)).open();
  assert.equal((await app.api('/api/modules/cards/enable', {})).status, 200);
  assert.equal((await app.api('/api/module-guides/cards', {})).status, 200);
  assert.equal((await app.api('/api/modules/cards/disable', {})).status, 200);
  assert.deepEqual((await app.api('/api/state')).moduleGuides, { cards: true });
  assert.equal((await app.api('/api/modules/cards/enable', {})).status, 200);
  assert.deepEqual((await app.api('/api/state')).moduleGuides, { cards: true });
});

test('服务重启并更换端口后保留记录，不同数据目录互不影响', async t => {
  const f = await fixture(t);
  const first = await f.open();
  assert.equal((await first.api('/api/module-guides/cards', {})).status, 200);
  assert.equal((await first.api('/api/module-guides/training', {})).status, 200);
  await first.close();
  // 占住原端口，保证重启覆盖真实的 origin 变化，而非碰巧复用端口。
  const occupied = createServer();
  await new Promise((resolveListen, reject) => {
    occupied.once('error', reject);
    occupied.listen(Number(new URL(first.url).port), '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise(resolveClose => occupied.close(resolveClose)));
  const restarted = await f.open();
  assert.notEqual(restarted.url, first.url);
  assert.deepEqual((await restarted.api('/api/state')).moduleGuides, { cards: true, training: true });
  const other = await f.open('other');
  assert.deepEqual((await other.api('/api/state')).moduleGuides, {});
});

test('主题与引导记录分别持久化，互相更新不会覆盖', async t => {
  const app = await (await fixture(t)).open();
  assert.equal((await app.api('/api/preferences', { theme: 'dark' })).status, 200);
  assert.equal((await app.api('/api/module-guides/voice', {})).status, 200);
  assert.deepEqual((await app.api('/api/state')).preferences, { theme: 'dark' });
  assert.equal((await app.api('/api/preferences', { theme: 'light' })).status, 200);
  const state = await app.api('/api/state');
  assert.deepEqual(state.preferences, { theme: 'light' });
  assert.deepEqual(state.moduleGuides, { voice: true });
  assert.equal((await app.api('/api/preferences', { theme: 'dark', moduleGuides: {} })).status, 400);
  const db = new DatabaseSync(join(app.dataDir, 'workbench.sqlite'), { readOnly: true });
  try {
    const setting = name => JSON.parse(db.prepare('SELECT value FROM settings WHERE name = ?').get(name).value);
    assert.deepEqual(setting('moduleGuides'), { voice: true });
    assert.deepEqual(setting('preferences'), { theme: 'light' });
  } finally { db.close(); }
});

test('拒绝未知模块和原型键，不允许写入额外字段或非对象正文', async t => {
  const app = await (await fixture(t)).open();
  for (const id of ['missing', '__proto__', 'constructor', 'prototype', 'toString']) {
    const response = await app.api(`/api/module-guides/${id}`, {});
    assert.equal(response.status, 404, id);
    assert.equal(typeof response.error, 'string');
  }
  for (const value of [{ seen: true }, { seen: false }, { moduleId: 'qq' }, { theme: 'dark' }, JSON.parse('{"__proto__":{"seen":true}}'), JSON.parse('{"constructor":true}'), null, [], true, 1, '']) {
    const response = await app.api('/api/module-guides/cards', value);
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.equal(typeof response.error, 'string');
  }
  for (const rawBody of ['', '{', '{"seen":']) {
    const response = await fetch(app.url + '/api/module-guides/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody });
    assert.equal(response.status, 400);
  }
  assert.deepEqual((await app.api('/api/state')).moduleGuides, {});
  assert.equal(({}).seen, undefined);
});

test('引导接口限制请求方法、JSON 类型和同源访问，拒绝时不保存记录', async t => {
  const app = await (await fixture(t)).open();
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await fetch(app.url + '/api/module-guides/cards', { method });
    assert.equal(response.status, 405, method);
    await response.text();
  }
  const wrongType = await fetch(app.url + '/api/module-guides/cards', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
  for (const headers of [{ origin: 'https://example.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await fetch(app.url + '/api/module-guides/cards', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.deepEqual((await app.api('/api/state')).moduleGuides, {});
});
