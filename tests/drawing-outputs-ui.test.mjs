import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../framework/server.mjs';

const electron = process.env.AI_FUTURE_ELECTRON || 'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
async function run() {
  const { app, BrowserWindow } = createRequire(import.meta.url)('electron'); app.disableHardwareAcceleration(); app.setPath('userData', join(process.env.DRAWING_OUTPUTS_UI_DIR, 'profile')); app.on('window-all-closed', () => {}); await app.whenReady();
  const audio = Buffer.alloc(44 + 8000 * 2); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(16000, 40);
  let video, promptId, completed = false;
  const text = '<img src=x onerror="globalThis.injected=true"><script>globalThis.injected=true</script>\n' + '完整文本'.repeat(1500);
  const drawingOptions = { WebSocketImpl: null, fetchImpl: async (url, options = {}) => {
    const value = new URL(url);
    if (value.pathname === '/system_stats') return Response.json({ system: { comfyui_version: '0.42.0' } });
    if (value.pathname === '/object_info') return Response.json({ SaveText: { input: { required: { text: ['STRING'] } }, output_node: true } });
    if (value.pathname === '/prompt') { promptId = JSON.parse(options.body).prompt_id; return Response.json({ prompt_id: promptId }); }
    if (value.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    if (value.pathname.startsWith('/history/')) return Response.json(completed ? { [promptId]: { status: { status_str: 'success', completed: true }, outputs: { '1': { images: [{ filename: '色块演示.webm', type: 'output' }], animated: [true] }, '2': { audio: [{ filename: '静音演示.wav', type: 'output' }] }, '3': { text: [text] }, '4': { metrics: { score: 0.8, html: '<svg onload=alert(1)>', url: '/api/modules/drawing/state' } } } } } : {});
    if (value.pathname === '/view') return new Response(value.searchParams.get('filename').endsWith('.wav') ? audio : video);
    return Response.json({});
  } };
  const backend = await createWorkbench({ dataDir: join(process.env.DRAWING_OUTPUTS_UI_DIR, 'data'), drawingOptions, instanceOptionsFactory: () => ({ drawingOptions }) });
  const window = new BrowserWindow({ show: false, width: 1440, height: 1100, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  const js = source => window.webContents.executeJavaScript(source), errors = [];
  window.webContents.on('console-message', event => { if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message); });
  const pause = ms => new Promise(done => setTimeout(done, ms));
  const wait = async source => { for (let count = 0; count < 120; count++) { if (await js(`Boolean(${source})`)) return; await pause(50); } throw new Error('界面等待超时：' + source + ' ' + errors.join(';')); };
  const api = async (path, body) => { const response = await fetch(backend.url + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  try {
    await api('/api/instances/migrate-legacy', {});
    const instance = await api('/api/instances', { moduleId: 'drawing' }), scope = '/instances/' + instance.instance.id;
    const route = scope + '/api/modules/drawing';
    await api(route + '/connect', {});
    const workflow = await api(route + '/workflows/import', { name: '视频、音频与文本', document: { '1': { class_type: 'SaveText', inputs: { text: 'test' } } } });
    window.webContents.session.webRequest.onBeforeRequest({ urls: [backend.url + '/app.js'] }, (_details, callback) => callback({ cancel: true }));
    await window.loadURL(backend.url + '/');
    video = Buffer.from(await js(`(async()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d');let frame=0;const paint=()=>{context.fillStyle='#688fbb';context.fillRect(0,0,320,180);context.fillStyle='#f4debc';context.fillRect(90+(frame++%8)*3,40,120,100);};paint();const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];recorder.ondataavailable=event=>chunks.push(event.data);const done=new Promise(resolve=>recorder.onstop=resolve);recorder.start();const timer=setInterval(paint,80);await new Promise(resolve=>setTimeout(resolve,1200));clearInterval(timer);recorder.stop();await done;stream.getTracks().forEach(track=>track.stop());return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));})()`));
    const job = await api(route + '/jobs', { workflowId: workflow.id, requestId: randomUUID(), values: {}, characterId: null }); completed = true;
    const result = await api(route + `/jobs/${job.id}/refresh`, {}); assert.equal(result.status, 'completed'); assert.ok(result.results.every(item => item.url.startsWith(scope + '/')));
    const raw = result.results.find(item => item.kind === 'data');
    assert.equal(JSON.parse(await (await fetch(backend.url + raw.url + '?download=1')).text()).metrics.url, '/api/modules/drawing/state', '下载原始数据不得由实例代理改写');
    await js(`(async()=>{document.body.innerHTML='<main style="padding:32px;max-width:1100px;margin:auto"><div id="jobs"></div></main>';window.qaJobs=${JSON.stringify([result])};window.qaRender=(await import('/drawing-job-view.js')).renderDrawingJobs;window.qaActions={view:()=>{},save:()=>{throw new Error('非图片不得保存到角色');},remove:async(button,id)=>{button.disabled=true;const response=await fetch(${JSON.stringify(route)}+'/jobs/'+id+'/hide',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!response.ok)throw new Error('移除记录失败');qaJobs=(await (await fetch(${JSON.stringify(route)}+'/state')).json()).jobs;qaRender(document.querySelector('#jobs'),qaJobs,qaActions);}};Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.qaCopied=text},configurable:true});qaRender(document.querySelector('#jobs'),qaJobs,qaActions);})()`);
    assert.equal(await js("document.querySelectorAll('video[controls]').length"), 1); assert.equal(await js("document.querySelectorAll('audio[controls]').length"), 1);
    await wait("document.querySelector('video').readyState>=1 && document.querySelector('audio').readyState>=1");
    assert.equal(await js("document.querySelector('video').videoWidth"), 320); assert.ok(await js("document.querySelector('audio').duration>0"));
    await js("(async()=>{const video=document.querySelector('video'),audio=document.querySelector('audio');video.muted=true;audio.muted=true;await Promise.all([video.play(),audio.play()]);})()");
    await wait("document.querySelector('video').currentTime>0.2 && document.querySelector('audio').currentTime>0.2");
    await js("document.querySelector('video').pause();document.querySelector('audio').pause();void 0");
    assert.equal(await js("document.querySelectorAll('[data-image-library]').length"), 0);
    assert.equal(await js('globalThis.injected'), undefined); assert.match(await js("document.querySelector('.drawing-result-text').textContent"), /<img src=x/);
    assert.equal(await js("document.querySelector('.drawing-result-text img')"), null);
    await js("document.querySelector('[data-result-copy]').click();void 0"); await wait('window.qaCopied'); assert.equal(await js('window.qaCopied'), text);
    await js("window.qaVideo=document.querySelector('video');qaRender(document.querySelector('#jobs'),structuredClone(qaJobs),qaActions);void 0"); assert.equal(await js("qaVideo===document.querySelector('video')"), true, '普通轮询不重建播放器');
    const second = await api('/api/instances', { moduleId: 'drawing' }); assert.equal((await fetch(backend.url + result.results[0].url.replace(scope, '/instances/' + second.instance.id))).status, 404);
    assert.equal((await fetch(backend.url+'/instances/'+second.instance.id+`/api/modules/drawing/jobs/${job.id}/hide`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    await js("document.querySelector('[data-job-remove]').click();void 0");await wait("document.querySelector('.drawing-empty')");
    assert.equal((await api(route+'/state')).jobs.length,0);
    const videoResult=result.results.find(item=>item.kind==='video');assert.deepEqual(Buffer.from(await (await fetch(backend.url+videoResult.url)).arrayBuffer()),video,'移除视频记录仍保留完整视频文件');
    await api(route+`/jobs/${job.id}/restore`,{});
    await js(`(async()=>{qaJobs=(await (await fetch(${JSON.stringify(route)}+'/state')).json()).jobs;qaRender(document.querySelector('#jobs'),qaJobs,qaActions);})()`);await wait("document.querySelector('video')?.readyState>=2");
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true); assert.deepEqual(errors, []);
    const output = process.env.DRAWING_OUTPUTS_UI_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      const capture = async name => { await pause(150); window.webContents.debugger.attach('1.3'); try { const { cssContentSize } = await window.webContents.debugger.sendCommand('Page.getLayoutMetrics'); const screenshot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } }); writeFileSync(join(output, name), Buffer.from(screenshot.data, 'base64')); } finally { window.webContents.debugger.detach(); } };
      await capture('drawing-outputs-light.png'); await js("document.documentElement.dataset.theme='dark';void 0"); await capture('drawing-outputs-dark.png');
    }
    console.log('DRAWING_OUTPUTS_UI_PASS real WebM/WAV decoding, escaped text, full copy, instance isolation; no GPU jobs');
  } finally { window.destroy(); await backend.close(); app.quit(); }
}
if (process.env.DRAWING_OUTPUTS_UI_CHILD === '1') run().catch(error => { console.error(error); process.exit(1); });
else test('多媒体结果可在桌面播放、复制完整文本、转义内容并隔离实例', { skip: !existsSync(electron), timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-outputs-ui-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await new Promise((done, reject) => {
    const env = { ...process.env, DRAWING_OUTPUTS_UI_CHILD: '1', DRAWING_OUTPUTS_UI_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { env, windowsHide: true }); let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error(output)); }, 50000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); code === 0 && output.includes('DRAWING_OUTPUTS_UI_PASS') ? done() : reject(new Error(output)); });
  });
});
