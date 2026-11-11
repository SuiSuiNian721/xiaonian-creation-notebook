const SET = 'ai-future:immersion:set';
const GET = 'ai-future:immersion:get';
const CHANGED = 'ai-future:immersion:changed';
const MODULES = new Set(['companion', 'companion-lite', 'cards']);

function isAlive(value) {
  return Boolean(value && !value.isDestroyed());
}

function validateMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('沉浸参数必须是普通对象。');
  }
  if (Reflect.ownKeys(value).some(key => !['active', 'moduleId', 'fullscreen'].includes(key))
      || typeof value.active !== 'boolean'
      || (Object.hasOwn(value, 'fullscreen') && typeof value.fullscreen !== 'boolean')
      || (Object.hasOwn(value, 'moduleId') && value.moduleId !== null && !MODULES.has(value.moduleId))
      || (value.active && !MODULES.has(value.moduleId))
      || (!value.active && value.fullscreen === true)) {
    throw new TypeError('沉浸参数包含无效字段或值。');
  }
}

class WorkbenchImmersion {
  #getWindow;
  #ipcMain;
  #window;
  #windowListeners;
  #sources = new Map();
  #active = false;
  #moduleId = null;
  #fullscreen = false;
  #fullscreenTarget;
  #fullscreenInFlight;
  #lastSent = JSON.stringify({ active: false, moduleId: null, fullscreen: false });
  #closed = false;

  constructor({ getWindow, ipcMain }) {
    if (typeof getWindow !== 'function' || typeof ipcMain?.handle !== 'function'
        || typeof ipcMain?.removeHandler !== 'function') {
      throw new TypeError('沉浸控制器需要窗口和 IPC 接口。');
    }
    this.#getWindow = getWindow;
    this.#ipcMain = ipcMain;
    ipcMain.handle(SET, (event, ...args) => {
      this.#assertSender(event);
      if (args.length !== 1) throw new TypeError('沉浸设置参数无效。');
      return this.setMode(args[0]);
    });
    ipcMain.handle(GET, (event, ...args) => {
      this.#assertSender(event);
      if (args.length !== 0) throw new TypeError('沉浸状态查询不接受参数。');
      return this.state();
    });
    this.#syncWindow();
  }

  #unbindWindow() {
    if (this.#window && this.#windowListeners) {
      for (const [name, listener] of Object.entries(this.#windowListeners)) {
        this.#window.removeListener(name, listener);
      }
    }
    this.#window = undefined;
    this.#windowListeners = undefined;
  }

  #syncWindow() {
    const candidate = this.#getWindow();
    const window = isAlive(candidate) ? candidate : undefined;
    if (window !== this.#window) {
      this.#unbindWindow();
      this.#window = window;
      this.#fullscreenTarget = undefined;
      this.#fullscreenInFlight = undefined;
      if (window) {
        const sync = fullscreen => {
          const inFlight = this.#fullscreenInFlight;
          // Windows 的事件先于 fullscreen flag 更新，等原生 setter 返回后再推进。
          queueMicrotask(() => {
            if (this.#closed || this.#syncWindow() !== window) return;
            if (inFlight?.fullscreen === fullscreen && this.#fullscreenInFlight === inFlight) {
              this.#fullscreenInFlight = undefined;
              this.#advanceFullscreen(window);
            }
            this.#publish();
          });
        };
        this.#windowListeners = {
          'enter-full-screen': () => sync(true),
          'leave-full-screen': () => sync(false),
          closed: () => this.close(),
        };
        for (const [name, listener] of Object.entries(this.#windowListeners)) window.on(name, listener);
      }
    }
    this.#fullscreen = Boolean(window?.isFullScreen());
    return window;
  }

  #advanceFullscreen(window) {
    if (this.#fullscreenInFlight !== undefined || this.#fullscreenTarget === undefined) return;
    if (window.isFullScreen() === this.#fullscreenTarget) {
      this.#fullscreenTarget = undefined;
      return;
    }
    // 每次只发送一个原生切换；完成事件到达后再处理期间合并的最新意图。
    this.#fullscreenInFlight = { fullscreen: this.#fullscreenTarget };
    window.setFullScreen(this.#fullscreenInFlight.fullscreen);
  }

  #currentModule(window) {
    if (!isAlive(window?.webContents)) return null;
    try {
      const match = new URL(window.webContents.getURL()).hash.match(/^#\/module\/(companion|companion-lite|cards)$/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  #assertSender(event) {
    const window = this.#closed ? undefined : this.#syncWindow();
    const root = window?.webContents;
    if (!isAlive(root) || event?.sender !== root || event.senderFrame !== root.mainFrame) {
      throw new Error('沉浸 IPC 来源必须是工作台主页面。');
    }
  }

  #publish() {
    if (this.#closed) return;
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized === this.#lastSent || !isAlive(this.#window?.webContents)) return;
    this.#window.webContents.send(CHANGED, state);
    this.#lastSent = serialized;
  }

  #handleInput(contents, options, event, input) {
    if (this.#closed || !isAlive(contents) || input?.type !== 'keyDown'
        || input.isAutoRepeat || input.repeat || input.isComposing
        || input.control || input.alt || input.meta || input.shift) return;
    if (!['F11', 'Escape', 'Esc'].includes(input.key)) return;
    const window = this.#syncWindow();
    const moduleId = this.#currentModule(window);
    if (!moduleId || (this.#active && this.#moduleId !== moduleId)) return;
    if (contents !== window.webContents) {
      if (options.moduleId !== moduleId || typeof options.isEligibleSource !== 'function') return;
      try {
        if (options.isEligibleSource(contents, window) !== true) return;
      } catch {
        return;
      }
    }
    if (input.key === 'F11') {
      const fullscreen = this.#fullscreenTarget ?? window.isFullScreen();
      this.setMode({ active: true, moduleId, fullscreen: this.#active ? !fullscreen : true });
    } else {
      if (!this.#active) return;
      this.setMode({ active: false });
    }
    event.preventDefault();
  }

  attach(webContents, options = {}) {
    if (this.#closed) throw new Error('沉浸控制器已关闭。');
    if (typeof options === 'function') options = { moduleId: 'companion', isEligibleSource: options };
    if (!isAlive(webContents) || typeof webContents.on !== 'function' || !options
        || typeof options !== 'object'
        || (options.moduleId !== undefined && !MODULES.has(options.moduleId))
        || (options.isEligibleSource !== undefined && typeof options.isEligibleSource !== 'function')) {
      throw new TypeError('沉浸快捷键来源或归属配置无效。');
    }
    this.#syncWindow();
    const existing = this.#sources.get(webContents);
    if (existing) {
      existing.options = options;
      return existing.detach;
    }
    const registration = { options };
    const onInput = (event, input) => this.#handleInput(webContents, registration.options, event, input);
    const detach = () => {
      if (this.#sources.get(webContents) !== registration) return;
      webContents.removeListener('before-input-event', onInput);
      webContents.removeListener('destroyed', detach);
      this.#sources.delete(webContents);
    };
    registration.detach = detach;
    this.#sources.set(webContents, registration);
    webContents.on('before-input-event', onInput);
    webContents.on('destroyed', detach);
    this.#publish();
    return detach;
  }

  setMode(value) {
    if (this.#closed) throw new Error('沉浸控制器已关闭。');
    validateMode(value);
    const window = this.#syncWindow();
    if (value.active && (!window || this.#currentModule(window) !== value.moduleId)) {
      throw new Error('只能进入当前工作台模块的沉浸模式。');
    }
    this.#active = value.active;
    this.#moduleId = value.active ? value.moduleId : null;
    const fullscreen = value.active ? value.fullscreen : false;
    if (window && fullscreen !== undefined) {
      this.#fullscreenTarget = fullscreen;
      this.#advanceFullscreen(window);
    }
    this.#publish();
    return this.state();
  }

  state() {
    if (!this.#closed) this.#syncWindow();
    return { active: this.#active, moduleId: this.#moduleId, fullscreen: this.#fullscreen };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ipcMain.removeHandler(SET);
    this.#ipcMain.removeHandler(GET);
    for (const { detach } of this.#sources.values()) detach();
    this.#unbindWindow();
  }
}

module.exports = { WorkbenchImmersion };
