import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-future-preferences-'));
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map(app => app.close()));
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    await rm(target, { recursive: true, force: true });
  });
  async function open(name = 'data') {
    const app = await createApp({ dataDir: join(root, name), port: 0, airiAssets: { available: false } });
    apps.push(app);
    return {
      ...app,
      async state() { const response = await fetch(app.url + '/api/state'); assert.equal(response.status, 200); return response.json(); },
      async save(input) {
        const response = await fetch(app.url + '/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        return { status: response.status, value: await response.json() };
      },
    };
  }
  return { open };
}

test('新数据目录默认浅色，主题作为独立preferences返回', async t => {
  const app = await (await fixture(t)).open();
  const state = await app.state();
  assert.deepEqual(state.preferences, { theme: 'light' });
  assert.equal(state.config.llm.baseUrl, '');
  assert.equal(state.status.qq, 'disconnected');
});

test('主题保存到SQLite，随机端口变化和服务重启后仍保留', async t => {
  const f = await fixture(t);
  const first = await f.open();
  assert.deepEqual(await first.save({ theme: 'dark' }), { status: 200, value: { preferences: { theme: 'dark' } } });
  const otherOrigin = await f.open();
  assert.notEqual(otherOrigin.url, first.url);
  assert.deepEqual((await otherOrigin.state()).preferences, { theme: 'dark' });
  await first.close(); await otherOrigin.close();
  const restarted = await f.open();
  assert.deepEqual((await restarted.state()).preferences, { theme: 'dark' });
  assert.equal((await restarted.save({ theme: 'light' })).status, 200);
  assert.deepEqual((await restarted.state()).preferences, { theme: 'light' });
});

test('非法主题或缺少字段返回400，不覆盖已保存主题及模型QQ配置', async t => {
  const app = await (await fixture(t)).open();
  await app.save({ theme: 'dark' });
  const before = await app.state();
  for (const invalid of [{}, { theme: 'auto' }, { theme: 'Dark' }, { theme: '' }, { theme: null }, { theme: 1 }, { theme: true }, { theme: {} }, null, []]) {
    const response = await app.save(invalid);
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.equal(typeof response.value.error, 'string');
  }
  const after = await app.state();
  assert.deepEqual(after.preferences, { theme: 'dark' });
  assert.deepEqual(after.config, before.config);
  assert.equal(after.status.qq, 'disconnected');
});

test('不同数据目录的主题相互隔离，不把任意额外字段持久化到preferences', async t => {
  const f = await fixture(t);
  const first = await f.open('a'); const second = await f.open('b');
  await first.save({ theme: 'dark', apiKey: 'not-a-preference', qq: { connected: true } });
  assert.deepEqual((await first.state()).preferences, { theme: 'dark' });
  assert.deepEqual((await second.state()).preferences, { theme: 'light' });
});
