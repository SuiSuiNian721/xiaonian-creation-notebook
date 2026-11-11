import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createWorkbench } from '../framework/server.mjs';

const electron = process.env.AI_FUTURE_ELECTRON || 'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
const png = process.env.DRAWING_PREVIEW_UI_PNG ? readFileSync(process.env.DRAWING_PREVIEW_UI_PNG) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=', 'base64');
async function run() {
  const { app, BrowserWindow, session } = createRequire(import.meta.url)('electron');
  app.setPath('userData', join(process.env.DRAWING_PREVIEW_UI_DIR, 'profile')); app.on('window-all-closed', () => {}); await app.whenReady();
  session.defaultSession.setSpellCheckerEnabled(false); session.defaultSession.setSpellCheckerLanguages([]);
  let socket, submitted, completed = false;
  class Socket extends EventTarget { constructor() { super(); this.readyState = 1; socket = this; } close() { this.readyState = 3; this.dispatchEvent(new Event('close')); } }
  const info = { EmptyImage: { input: { required: {} } }, SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output_node: true } };
  const drawingOptions = { WebSocketImpl: Socket, fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/system_stats') return Response.json({ system: { comfyui_version: '0.42.0' }, devices: [] });
    if (path === '/object_info') return Response.json(info);
    if (path === '/prompt') { submitted = JSON.parse(options.body); return Response.json({ prompt_id: submitted.prompt_id }); }
    if (path === '/queue') return Response.json({ queue_running: submitted && !completed ? [[0, submitted.prompt_id]] : [], queue_pending: [] });
    if (path.startsWith('/history/')) return Response.json(completed ? { [submitted.prompt_id]: { status: { completed: true, status_str: 'success' }, outputs: { '2': { images: [{ filename: 'fixture.png', type: 'output' }] } } } } : {});
    if (path === '/view') return new Response(png);
    return Response.json({});
  } };
  const backend = await createWorkbench({ dataDir: join(process.env.DRAWING_PREVIEW_UI_DIR, 'data'), drawingOptions, instanceOptionsFactory: () => ({ drawingOptions }) });
  let scope = '';
  const api = async (path, body) => { const res = await fetch(backend.url + scope + '/api/modules/drawing' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(res.ok, await res.clone().text()); return res.json(); };
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  const errors = []; window.webContents.on('console-message', event => { if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message); });
  const js = source => window.webContents.executeJavaScript(source), pause = ms => new Promise(r => setTimeout(r, ms));
  const capture = async (output, name) => {
    mkdirSync(output, { recursive: true }); await js('window.scrollTo(0,0);void 0');
    window.webContents.debugger.attach('1.3');
    try { const { cssContentSize } = await window.webContents.debugger.sendCommand('Page.getLayoutMetrics'); const shot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } }); writeFileSync(join(output, name), Buffer.from(shot.data, 'base64')); }
    finally { window.webContents.debugger.detach(); }
  };
  const wait = async source => { for (let i = 0; i < 120; i++) { if (await js(`Boolean(${source})`)) return; await pause(50); } throw new Error('界面等待超时: ' + source + ' ' + errors.join(';') + ' ' + await js('document.body.innerText.slice(-2000)')); };
  try {
    const migrated = await fetch(backend.url + '/api/instances/migrate-legacy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.ok(migrated.ok, await migrated.text());
    await api('/enable', {});
    const created=await fetch(backend.url+'/api/instances',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({moduleId:'drawing'})});assert.ok(created.ok,await created.clone().text());scope='/instances/'+(await created.json()).instance.id;
    await api('/connect', {}); await api('/workflows/import', { name: '预览测试工作流（模拟）', document: { '1': { class_type: 'EmptyImage', inputs: {} }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'fixture' } } } });
    assert.equal((await (await fetch(backend.url+scope+'/api/modules/drawing/state')).json()).defaultPreviewMethod,'auto');
    await api('/runtime/settings',{previewMethod:'none'});
    await window.loadURL(backend.url + '/#/module/drawing'); await wait("document.querySelector('#drawing-preview-method')");
    await js("document.querySelector('[data-module-tour]:popover-open [data-tour-skip]')?.click();void 0");
    assert.equal(await js("document.querySelector('#drawing-preview-method').value"), 'none');
    await js("document.querySelector('#drawing-preview-method').value='auto';document.querySelector('#drawing-preview-method').dispatchEvent(new Event('change',{bubbles:true}));void 0");
    await wait("!document.querySelector('#generate-image').disabled"); await js("document.querySelector('#generate-image').click();void 0");
    await wait("document.querySelector('.drawing-job')"); assert.equal(submitted.extra_data.preview_method, 'auto');
    const send = value => socket.dispatchEvent(new MessageEvent('message', { data: value }));
    send(JSON.stringify({ type: 'progress', data: { prompt_id: submitted.prompt_id, node: '1', value: 1, max: 8 } }));
    const header = Buffer.alloc(8); header.writeUInt32BE(1); header.writeUInt32BE(2, 4); send(Buffer.concat([header, png]));
    await wait("document.querySelector('.drawing-live-preview img')?.naturalWidth > 0 && !document.querySelector('.drawing-live-preview').hidden");
    const imagePath=await js("document.querySelector('.drawing-live-preview img').getAttribute('src')");assert.ok(imagePath.startsWith(scope+'/'));
    const secondResponse=await fetch(backend.url+'/api/instances',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({moduleId:'drawing'})});assert.ok(secondResponse.ok);const secondId=(await secondResponse.json()).instance.id;
    assert.equal((await fetch(backend.url+imagePath.replace(scope,'/instances/'+secondId))).status,404);
    await js("window.previewNode=document.querySelector('.drawing-live-preview img');document.querySelector('[data-job-cancel]').focus();void 0");
    send(Buffer.concat([header, png])); await pause(1100);
    assert.equal(await js("window.previewNode===document.querySelector('.drawing-live-preview img')"), true);
    assert.equal(await js("document.activeElement.hasAttribute('data-job-cancel')"), true);
    const output = process.env.DRAWING_PREVIEW_UI_OUTPUT;
    if (output) { await capture(output, 'preview-fixture.png'); await js("document.documentElement.dataset.theme='dark';void 0"); await capture(output, 'preview-dark-fixture.png'); await js("document.documentElement.dataset.theme='light';void 0"); }
    completed = true; send(JSON.stringify({ type: 'execution_success', data: { prompt_id: submitted.prompt_id } }));
    await wait("document.querySelector('.drawing-gallery img')?.naturalWidth > 0");
    assert.equal(await js("!document.querySelector('.drawing-live-preview') || document.querySelector('.drawing-live-preview').hidden"), true);
    await js("document.querySelector('#drawing-preview-method').value='none';document.querySelector('#drawing-preview-method').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#generate-image').click();void 0");
    await wait("document.querySelectorAll('.drawing-job').length===2"); assert.equal(submitted.extra_data.preview_method, 'none');
    if (output) await capture(output, 'completed-fixture.png');
    assert.deepEqual(errors, []); console.log('DRAWING_PREVIEW_UI_PASS');
  } finally { window.destroy(); await session.defaultSession.closeAllConnections(); await backend.close(); }
}
if (process.env.DRAWING_PREVIEW_UI_CHILD === '1') run().then(() => createRequire(import.meta.url)('electron').app.quit(), error => { console.error(error); createRequire(import.meta.url)('electron').app.exit(1); });
else test('桌面任务预览更新保留图片节点与焦点，完成后显示正式作品，关闭选项生效', { skip: !existsSync(electron) }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-preview-ui-'));
  const env = { ...process.env, DRAWING_PREVIEW_UI_CHILD: '1', DRAWING_PREVIEW_UI_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { env, windowsHide: true }); let text = '', closed = false;
  const closure = new Promise(done => child.once('close', code => { closed = true; done(code); }));
  t.after(async () => {
    if (!closed) child.kill(); await closure;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await new Promise((resolveTest, reject) => {
    child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron QA 超时\n' + text)); }, 40000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); closure.then(code => { clearTimeout(timer); code === 0 && text.includes('DRAWING_PREVIEW_UI_PASS') ? resolveTest() : reject(new Error(text)); });
  });
});
