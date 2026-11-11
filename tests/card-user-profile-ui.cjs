require('../desktop/process-stdio.cjs').installStdioGuards();
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'card-profile-ui-'));
const output = path.join(root, 'artifacts', 'card-user-profile-ui');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(directory, 'electron'));
const report = { checks: [], errors: [] };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWl8AAAAASUVORK5CYII=';
let runtime, win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source, true);
const frame = "document.querySelector('#card-studio-frame').contentWindow";
const frameJs = source => js(`(()=>{const w=${frame},d=w.document;return (${source});})()`);
async function wait(label, predicate) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { if (await predicate()) return; await pause(100); }
  throw new Error('等待超时：' + label);
}
async function api(route, value) {
  const response = await fetch(runtime.url + route, { method: value === undefined ? 'GET' : 'POST',
    headers: { origin: runtime.url, 'content-type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
async function capture(name) {
  await pause(250);
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
const deadline = setTimeout(() => {
  report.errors.push('卡片用户资料界面检查超时');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  app.exit(1);
}, 120000);

app.whenReady().then(async () => {
  const { createWorkbench } = await import(pathToFileURL(path.join(root, 'framework/server.mjs')));
  runtime = await createWorkbench({ dataDir: path.join(directory, 'data') });
  await api('/api/instances/migrate-legacy', {});
  await api('/api/modules/cards/enable', {});
  const instance = (await api('/api/instances', { moduleId: 'cards', name: '头像验收写卡器' })).instance;
  const cardApi = (route, value) => api('/instances/' + instance.id + route, value);
  await api('/api/user-profile', { displayName: '头像验收', avatar: 'data:image/png;base64,' + png, identity: '', preferences: '' });
  const studio = await cardApi('/api/modules/cards/studio', {});
  await cardApi('/card-studio/api/new', { name: '头像验收卡' });
  const card = encodeURIComponent('头像验收卡');
  const conversationId = (await cardApi('/card-studio/api/conversations/' + card)).activeId;
  const xiaoxi = fs.readFileSync('E:\\OC\\小汐\\Quality20_00021_.png').toString('base64');
  await cardApi('/card-studio/api/chat-avatar/xiaoxi', { mimeType: 'image/png', base64: xiaoxi });
  const userAt = '2026-11-07T00:00:00.000Z';
  const history = [
    { role: 'user', at: userAt, text: '小汐，我们一起整理今天的故事吧。', personaId: 'xiaoxi', personaName: '林小汐', cardName: '头像验收卡', conversationId },
    { role: 'agent', at: '2026-11-07T00:00:01.000Z', replyToAt: userAt, text: '好呀，从你最想保留的那个片段开始。', personaId: 'xiaoxi', personaName: '林小汐', cardName: '头像验收卡', conversationId },
  ];
  fs.writeFileSync(path.join(studio.workspacePath, 'work/agent-chat.jsonl'), history.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  win = new BrowserWindow({ show: false, width: 1480, height: 1000, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  report.avatarRequests = [];
  win.webContents.session.webRequest.onCompleted({ urls: ['http://127.0.0.1:*/*chat-avatar*'] }, details => report.avatarRequests.push({ url: details.url, status: details.statusCode }));
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
  await win.loadURL(runtime.url + '/#/module/cards');
  await wait('打开作品入口', () => js('!!document.querySelector("[data-edit-card]")'));
  await js('document.querySelector("[data-edit-card]").click()');
  await js('document.querySelector("[data-tour-skip]")?.click()');
  await wait('编辑器', () => js('!!document.querySelector("#card-studio-frame")?.contentWindow?.__workbenchReady?.()'));
  await wait('用户消息', () => frameJs('!!d.querySelector(".chat-message.user .chat-sender")'));
  assert.equal(await frameJs('d.querySelector(".chat-message.user .chat-sender").textContent'), '头像验收');
  const options = await frameJs('Array.from(d.querySelector("#persona-select").options).map(option=>option.value)');
  assert.deepEqual(options, ['xiaoxi']);
  await wait('双方头像', () => frameJs('Array.from(d.querySelectorAll(".chat-message .chat-avatar img")).length>=2&&Array.from(d.querySelectorAll(".chat-message .chat-avatar img")).every(img=>img.complete&&img.naturalWidth>0)'));
  report.checks.push('卡片聊天展示用户姓名和双方头像，内置人设只有林小汐');
  await capture('chat-before.png');
  await js(`(()=>{const w=${frame},input=w.document.querySelector('#chat-input');input.value='资料更新时保留这份草稿';input.dispatchEvent(new w.Event('input',{bubbles:true}));})()`);
  await api('/api/user-profile', { displayName: '更新后的名字' });
  await js("window.dispatchEvent(new CustomEvent('workbench:user-profile-changed'))");
  await wait('用户名刷新', () => frameJs('d.querySelector(".chat-message.user .chat-sender").textContent==="更新后的名字"'));
  assert.equal(await frameJs('d.querySelector("#chat-input").value'), '资料更新时保留这份草稿');
  report.checks.push('用户资料保存后聊天姓名刷新且输入草稿保留');
  await js(`(()=>{const w=${frame};w.openChatAvatarSettings();})()`);
  await wait('头像设置', () => frameJs('d.querySelectorAll(".avatar-dialog-row").length===2'));
  await js(`(()=>{const w=${frame},data=atob(${JSON.stringify(xiaoxi)}),file=new w.File([Uint8Array.from(data,c=>c.charCodeAt(0))],'qa-user.png',{type:'image/png'}),transfer=new w.DataTransfer();transfer.items.add(file);const input=w.document.querySelector('.avatar-dialog-row input');input.files=transfer.files;input.dispatchEvent(new w.Event('change',{bubbles:true}));})()`);
  await wait('头像上传保存', () => frameJs('d.querySelector("#chat-avatar-dialog [role=status]").textContent.includes("已更新")'));
  const saved = (await api('/api/user-profile')).profile;
  assert.equal(saved.avatar, 'data:image/png;base64,' + xiaoxi);
  assert.equal(saved.displayName, '更新后的名字');
  assert.ok(!fs.existsSync(path.join(studio.workspacePath, 'work/chat-avatars/user.png')));
  await js(`${frame}.document.querySelector('#chat-avatar-dialog').remove()`);
  await wait('新用户头像', () => frameJs('d.querySelector(".chat-message.user .chat-avatar img")?.naturalWidth>1'));
  assert.equal(await frameJs('d.querySelector("#chat-input").value'), '资料更新时保留这份草稿');
  report.checks.push('卡片头像设置真实上传至全局资料，刷新图片且保留用户名和草稿');
  await capture('chat-after.png');
  await api('/api/user-profile', { avatar: '', displayName: '' });
  await js("window.dispatchEvent(new CustomEvent('workbench:user-profile-changed'))");
  await wait('头像清除', () => frameJs('!d.querySelector(".chat-message.user .chat-avatar img")&&d.querySelector(".chat-message.user .chat-sender").textContent==="你"'));
  assert.equal(await frameJs('d.querySelector("#chat-input").value'), '资料更新时保留这份草稿');
  report.checks.push('清空头像与名称即时回退，草稿仍保留');
  await capture('chat-cleared.png');
}).catch(async error => {
  report.errors.push(error.stack || error.message);
  if (win) {
    await capture('failure.png').catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.html'), await js('document.documentElement.outerHTML').catch(() => ''), 'utf8');
    report.frame = await frameJs('({avatars:w.chatAvatars,html:d.querySelector("#chatmain")?.innerHTML})').catch(() => null);
  }
}).finally(async () => {
  clearTimeout(deadline);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  win?.destroy();
  await runtime?.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify(report));
  app.exit(report.errors.length ? 1 : 0);
});
