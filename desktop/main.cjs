const { app, BrowserWindow, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const aurora = process.env.AI_FUTURE_VARIANT === 'aurora';
const variant = aurora ? {
  name: 'AI未来 Aurora', appId: 'ai.future.demo.aurora', profile: 'AI-Future-Demo-Aurora',
  frontend: 'public-aurora', title: 'AI-未来 · Aurora', background: '#e9eef5',
} : {
  name: 'AI未来 Demo', appId: 'ai.future.demo', profile: 'AI-Future-Demo',
  frontend: 'public', title: 'AI-未来 · 角色工作台', background: '#f6f7f4',
};
const qa = process.env.AI_FUTURE_QA === '1';
const qaDir = process.env.AI_FUTURE_QA_DIR || path.join(root, 'qa', new Date().toISOString().replace(/[:.]/g, '-'));
const isolatedProfile = process.env.AI_FUTURE_PROFILE_DIR ? path.resolve(process.env.AI_FUTURE_PROFILE_DIR) : null;
app.setName(variant.name);
app.setPath('userData', qa ? path.join(qaDir, 'profile') : isolatedProfile || path.join(app.getPath('appData'), variant.profile));
if (!qa && !app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', showMainWindow);
if (qa) {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
let runtime;
let window;
let tray;
let background = false;
let quitting = false;

function showMainWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function writeQa(name, value) {
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}

async function createWindow(url) {
  window = new BrowserWindow({
    width: 1380, height: 920, minWidth: 780, minHeight: 640,
    show: !qa, backgroundColor: variant.background, title: variant.title, autoHideMenuBar: aurora,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'user-gesture-required', backgroundThrottling: !qa, offscreen: qa },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', event => {
    if (background && !quitting && !qa) { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => { window = undefined; });
  await window.loadURL(url);
  if (!qa) showMainWindow();
  return window;
}

function setMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '工作台', submenu: [
      { label: '显示工作台', click: showMainWindow },
      { label: '关闭窗口后继续运行', type: 'checkbox', checked: background, click: item => { background = item.checked; } },
      { type: 'separator' }, { label: '退出 Demo', accelerator: 'Alt+F4', click: () => { quitting = true; app.quit(); } },
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '查看', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }] },
  ]);
  Menu.setApplicationMenu(menu);
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4;
    const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 235;
    const letter = (x >= 10 && x <= 13 && y >= 8 && y <= 24) || (x >= 10 && x <= 23 && y >= 8 && y <= 11) || (x >= 10 && x <= 20 && y >= 15 && y <= 18);
    pixels[offset] = letter ? 225 : 65;
    pixels[offset + 1] = letter ? 245 : 83;
    pixels[offset + 2] = letter ? 237 : 41;
    pixels[offset + 3] = inside ? 255 : 0;
  }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }));
  tray.setToolTip(variant.name);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示工作台', click: showMainWindow }, { label: '退出', click: () => { quitting = true; app.quit(); } }]));
  tray.on('double-click', showMainWindow);
}

app.whenReady().then(async () => {
  app.setAppUserModelId(variant.appId);
  const { createApp } = await import(pathToFileURL(path.join(root, 'src/server.mjs')).href);
  const dataDir = qa ? path.join(qaDir, 'data') : path.join(app.getPath('userData'), 'data');
  if (aurora && !qa && !isolatedProfile) {
    const { bootstrapProfile } = await import(pathToFileURL(path.join(root, 'src/profile-bootstrap.mjs')).href);
    const imported = await bootstrapProfile({ sourceDataDir: path.join(app.getPath('appData'), 'AI-Future-Demo', 'data'), targetDataDir: dataDir });
    if (imported.status === 'copied') {
      fs.writeFileSync(path.join(app.getPath('userData'), 'profile-import.json'), JSON.stringify({ at: new Date().toISOString(), ...imported, note: '旧版 SQLite 只读在线快照；旧数据保留原位。' }, null, 2), 'utf8');
    }
  }
  runtime = await createApp({ dataDir, port: 0, host: '127.0.0.1', staticDir: path.join(root, variant.frontend) });
  const mainWindow = await createWindow(runtime.url);
  if (qa) {
    const { runQa } = await import(pathToFileURL(path.join(root, 'tools', aurora ? 'qa-aurora.mjs' : 'qa-desktop.mjs')).href);
    await runQa({ window: mainWindow, runtime, qaDir });
    writeQa('complete.json', { ok: true, at: new Date().toISOString() });
    app.exit(0);
  } else setMenu();
}).catch(error => {
  if (qa) writeQa('error.txt', error.stack || String(error));
  else {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), error.stack || String(error), 'utf8');
    } catch {}
    require('electron').dialog.showErrorBox(`${variant.name} 无法启动`, error.message);
  }
  app.exit(1);
});
app.on('window-all-closed', () => { if (!background) app.quit(); });
app.on('before-quit', event => {
  if (!runtime || quitting === 'closed') return;
  event.preventDefault(); quitting = 'closed';
  Promise.resolve(runtime.close()).finally(() => { tray?.destroy(); app.quit(); });
});
