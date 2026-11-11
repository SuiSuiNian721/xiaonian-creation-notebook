import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WorkbenchStore } from '../framework/store.mjs';
import { ComfyDrawing } from '../framework/drawing.mjs';
import { DrawingManager } from '../framework/drawing-manager.mjs';
import { createWorkbench } from '../framework/server.mjs';

const defaultUrl = 'http://127.0.0.1:8188';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-config-'));
  const comfy = join(directory, 'ComfyUI');
  await mkdir(join(comfy, 'comfy'), { recursive: true });
  for (const name of ['main.py', 'server.py', 'nodes.py']) await writeFile(join(comfy, name), '# fixture\n');
  const store = new WorkbenchStore(directory);
  const drawing = new ComfyDrawing({ store, dataDir: directory, WebSocketImpl: null, fetchImpl: async () => { throw new Error('offline'); } });
  drawing.runtime.saveSettings({ pythonPath: process.execPath });
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); await drawing.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return { directory, comfy, store, drawing, closers };
}

test('路径配置与空地址采用本机默认，两个入口持久化同一地址', async t => {
  const f = await fixture(t);
  assert.equal(f.store.module('drawing').config.serviceUrl, defaultUrl);
  for (const id of ['comfyui', 'drawing']) {
    f.store.saveConfig(id, { comfyPath: f.comfy, serviceUrl: '  ' });
    assert.equal(f.store.module(id).config.serviceUrl, defaultUrl);
    assert.deepEqual(f.store.module('drawing').config, f.store.module('comfyui').config);
    const persisted = JSON.parse(f.store.db.prepare('SELECT config FROM modules WHERE id = ?').get('drawing').config);
    assert.equal(persisted.serviceUrl, defaultUrl);
  }
});

test('旧资料地址缺失仍可预览启动、连接与维护；自定义地址和端口保持', async t => {
  const f = await fixture(t);
  // Reproduce persisted pre-fix data without going through the save API.
  f.store.db.prepare('UPDATE modules SET config = ? WHERE id = ?').run(JSON.stringify({ comfyPath: f.comfy }), 'drawing');
  let command = await f.drawing.runtime.command();
  assert.equal(command.args[command.args.indexOf('--port') + 1], '8188');
  assert.equal(f.drawing.config().serviceUrl, defaultUrl);
  let maintenanceUrl;
  const manager = new DrawingManager({ drawing: f.drawing, store: f.store, dataDir: f.directory, isRunning: async ({ url }) => { maintenanceUrl = url; return false; } });
  f.closers.push(() => manager.close());
  await manager.offline(f.comfy);
  assert.equal(maintenanceUrl, defaultUrl + '/');
  await assert.rejects(f.drawing.connect(), /无法连接 ComfyUI/);
  let launched = false;
  f.drawing.runtime.launch = async () => { launched = true; return { starting: true }; };
  assert.equal((await f.drawing.launch()).starting, true);
  assert.equal(launched, true);
  f.store.saveConfig('comfyui', { comfyPath: f.comfy });
  assert.equal(JSON.parse(f.store.db.prepare('SELECT config FROM modules WHERE id = ?').get('drawing').config).serviceUrl, defaultUrl);
  for (const url of ['http://127.0.0.1:19091', 'http://remote.test:8288']) {
    f.store.saveConfig('comfyui', { serviceUrl: url });
    f.store.saveConfig('drawing', { outputPath: join(f.directory, 'output') });
    assert.equal(f.drawing.config().serviceUrl, url);
    assert.equal((await f.drawing.discover(f.comfy)).serviceUrl, url);
    if (url.includes('127.0.0.1')) {
      command = await f.drawing.runtime.command();
      assert.equal(command.args[command.args.indexOf('--port') + 1], '19091');
    } else await assert.rejects(f.drawing.runtime.command(), /本机 HTTP/);
  }
});

test('HTTP 只保存检测路径也返回可启动的共享地址，局部保存保留自定义端口', async t => {
  const f = await fixture(t);
  const app = await createWorkbench({ dataDir: join(f.directory, 'http'), drawingOptions: { WebSocketImpl: null } });
  f.closers.push(() => app.close());
  const api = async (path, body, method = 'PUT') => {
    const response = await fetch(app.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await api('/api/modules/comfyui/enable', {}, 'POST');
  const saved = await api('/api/modules/comfyui/config', { values: { comfyPath: f.comfy } });
  assert.equal(saved.config.serviceUrl, defaultUrl);
  await api('/api/modules/comfyui/config', { values: { serviceUrl: 'http://localhost:19091' } });
  const updated = await api('/api/modules/drawing/config', { values: { outputPath: f.directory } });
  assert.equal(updated.config.serviceUrl, 'http://localhost:19091');
  const state = await (await fetch(app.url + '/api/state')).json();
  assert.deepEqual(state.modules.find(item => item.id === 'comfyui').config, state.modules.find(item => item.id === 'drawing').config);
});
