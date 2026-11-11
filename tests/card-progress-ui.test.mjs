import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { attachChatRecovery } from '../integrations/xiaoxi/tools/chat-recovery-ui.mjs';

const electron = process.env.AI_FUTURE_ELECTRON || 'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';

async function run() {
  const { app, BrowserWindow } = createRequire(import.meta.url)('electron');
  app.setPath('userData', join(process.env.CARD_PROGRESS_UI_DIR, 'profile')); app.on('window-all-closed', () => {});
  await app.whenReady();
  const source = await readFile(new URL('../integrations/xiaoxi/tools/studio.mjs', import.meta.url), 'utf8');
  const css = source.match(/<style>([\s\S]*?)<\/style>/)[1];
  const window = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  const js = script => window.webContents.executeJavaScript(script);
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html class="dark"><style>' + css + '</style><body><main style="padding:40px;max-width:960px;margin:auto"><div id="toolbar"></div><section id="root"><div class="chat-message pending"><div class="chat-content"><div class="chat-bubble" id="bubble"><div class="chat-text">正在生成回复</div><div class="chat-text" id="preview">第一段正在生成的正文。</div></div></div></div><textarea id="chat-input"></textarea></section></main></body></html>'));
    await js(`
      window.clock = Date.now(); Date.now = () => clock;
      window.calls = []; window.changed = []; window.logs = [];
      window.task = { taskId: 'public-task', backend: 'openai', replyToAt: new Date(clock - 90000).toISOString(), queuedAt: new Date(clock - 90000).toISOString(), lastActivityAt: new Date(clock - 2000).toISOString(), phase: 'generating', canStop: true, allowWrite: false };
      window.recovery = (${attachChatRecovery.toString()})({
        api: async (...args) => { calls.push(args); return {ok:true}; },
        root: document.querySelector('#root'), toolbar: document.querySelector('#toolbar'), scope: () => ({cardName:'进度',conversationId:'main'}), isCurrent: () => true, canOperate: () => true,
        setBusy() {}, log: (...args) => logs.push(args), changed: async result => changed.push(result)
      });
      recovery.pendingControls({task}, document.querySelector('#bubble')); recovery.updateClocks();
    `);
    assert.equal(await js("!!document.querySelector('[role=progressbar]')"), true, '真实 DOM 应有无百分比进度条');
    assert.equal(await js("document.querySelector('[role=progressbar]').hasAttribute('aria-valuenow')"), false);
    assert.equal(await js("document.querySelector('.chat-reply-progress').dataset.active"), 'true');
    assert.match(await js("document.querySelector('.chat-reply-activity').textContent"), /最近活动.*2.*秒/);
    assert.match(await js("document.querySelector('[data-reply-queued-at]').textContent"), /已等待 1 分 30 秒/);
    await js("document.querySelector('.chat-stop').focus();clock += 31000;recovery.updateClocks();");
    assert.equal(await js("document.querySelector('.chat-reply-progress').dataset.active"), 'false', '静默时停止活跃动画');
    assert.equal(await js("getComputedStyle(document.querySelector('.chat-reply-progress-indicator')).animationName"), 'none');
    await js("task = {...task,lastActivityAt:new Date(clock).toISOString()};recovery.updatePendingControls({task},document.querySelector('#bubble'));recovery.updateClocks();");
    assert.equal(await js("document.querySelector('.chat-reply-progress').dataset.active"), 'true', '新活动无需重建停止按钮');
    assert.equal(await js("document.activeElement.className"), 'chat-stop');
    await js("task = {...task,lastActivityAt:'',startedAt:'',updatedAt:new Date(clock).toISOString()};recovery.updatePendingControls({task},document.querySelector('#bubble'));recovery.updateClocks();");
    assert.equal(await js("document.querySelector('.chat-reply-progress').dataset.active"), 'false', '普通状态发布时间不能冒充真实模型活动');
    await js("task = {...task,lastActivityAt:new Date(clock).toISOString()};recovery.updatePendingControls({task},document.querySelector('#bubble'));recovery.updateClocks();");
    assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await js("getComputedStyle(document.querySelector('.chat-reply-progress-indicator')).animationName"), 'none', '减少动态效果关闭动画');
    window.webContents.debugger.detach();
    const output = process.env.CARD_PROGRESS_UI_OUTPUT;
    if (output) {
      mkdirSync(output, { recursive: true });
      await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
      writeFileSync(join(output, 'card-progress-active.png'), (await window.webContents.capturePage()).toPNG());
      await js("clock += 31000;recovery.updateClocks();");
      writeFileSync(join(output, 'card-progress-quiet.png'), (await window.webContents.capturePage()).toPNG());
    }
    await js("task = {...task,phase:'waiting-service'};recovery.updatePendingControls({task},document.querySelector('#bubble'));recovery.updateClocks();");
    assert.equal(await js("document.querySelector('.chat-reply-progress').dataset.active"), 'false');
    await js("document.querySelector('.chat-stop').click();");
    await new Promise(done => setTimeout(done, 20));
    assert.equal(await js('calls.length'), 1);
    assert.equal((await js('calls[0]'))[1], '/api/chat-stop/' + encodeURIComponent('进度'));
    assert.equal(await js('changed.length'), 1);
    assert.equal(await js("document.activeElement.className"), 'chat-stop');
    console.log('CARD_PROGRESS_UI_PASS actual DOM, quiet activity, reduced motion, stop and focus');
  } finally { await js('recovery?.dispose()').catch(() => {}); window.destroy(); app.quit(); }
}

if (process.env.CARD_PROGRESS_UI_CHILD === '1') run().catch(error => { console.error(error); process.exit(1); });
else test('制卡回复真实 DOM 显示真实活动进度、静默/减少动效与停止焦点', { skip: !existsSync(electron), timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'card-progress-ui-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const env = { ...process.env, CARD_PROGRESS_UI_CHILD: '1', CARD_PROGRESS_UI_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(electron, [fileURLToPath(import.meta.url)], { env, windowsHide: true }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(output || '制卡进度 UI 验证超时')); }, 50000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 && output.includes('CARD_PROGRESS_UI_PASS') ? done() : reject(new Error(output)); });
  });
});
