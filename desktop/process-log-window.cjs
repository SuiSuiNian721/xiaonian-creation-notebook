const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function parseLogTarget(baseURL, target) {
  try {
    const base = new URL(baseURL);
    const url = new URL(target, base);
    if (url.origin !== base.origin || url.username || url.password || url.pathname !== '/process-log.html' || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !['task','instance'].includes(key) || url.searchParams.getAll(key).length !== 1 || !UUID.test(url.searchParams.get(key)))) return null;
    return {...(url.searchParams.has('task')?{taskId:url.searchParams.get('task')}:{}),...(url.searchParams.has('instance')?{instanceId:url.searchParams.get('instance')}:{})};
  } catch { return null; }
}

class ProcessLogWindows {
  constructor({BrowserWindow, getBaseURL, onError = error => console.error('日志窗口：', error.message)}) {
    this.BrowserWindow = BrowserWindow;
    this.getBaseURL = getBaseURL;
    this.onError = onError;
    this.windows = new Map();
  }
  open({taskId,instanceId} = {}) {
    if (taskId !== undefined && !UUID.test(taskId)) throw new Error('日志任务标识无效。');
    if (instanceId !== undefined && !UUID.test(instanceId)) throw new Error('日志实例标识无效。');
    const key = (instanceId ? instanceId + ':' : '') + (taskId || 'runtime');
    const existing = this.windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show(); existing.focus(); return existing;
    }
    const url = new URL('/process-log.html', this.getBaseURL());
    if (instanceId) url.searchParams.set('instance', instanceId);
    if (taskId) url.searchParams.set('task', taskId);
    const window = new this.BrowserWindow({
      width:1100, height:720, minWidth:520, minHeight:360, show:false,
      title:'ComfyUI 日志', icon:require('node:path').join(__dirname,'../public-workbench/app.ico'), backgroundColor:'#0c0c10', autoHideMenuBar:true,
      webPreferences:{contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false},
    });
    this.windows.set(key, window);
    window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    window.webContents.on('will-navigate', (event, target) => { if (target !== url.href) event.preventDefault(); });
    window.once('ready-to-show', () => { window.show(); window.focus(); });
    window.once('closed', () => { if (this.windows.get(key) === window) this.windows.delete(key); });
    window.loadURL(url.href).catch(this.onError);
    return window;
  }
  handleWindowOpen({url}) {
    const source = parseLogTarget(this.getBaseURL(), url);
    if (source) this.open(source);
    return {action:'deny'};
  }
  closeAll() {
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.close();
    this.windows.clear();
  }
}

function isLogClipboardWrite(baseURL, target, permission) {
  return permission === 'clipboard-sanitized-write' && parseLogTarget(baseURL, target) !== null;
}

module.exports = {ProcessLogWindows, parseLogTarget, isLogClipboardWrite};
