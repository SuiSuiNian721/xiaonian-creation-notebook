import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const implementation = await import('../desktop/workbench-immersion.cjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const SET = 'ai-future:immersion:set';
const GET = 'ai-future:immersion:get';
const CHANGED = 'ai-future:immersion:changed';

class Contents extends EventEmitter {
  constructor(url = 'http://127.0.0.1:3781/#/module/companion') {
    super();
    this.url = url;
    this.mainFrame = {};
    this.destroyed = false;
    this.messages = [];
  }

  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  send(channel, value) { this.messages.push({ channel, value }); }
  loadURL() { assert.fail('沉浸切换不得导航'); }
  reload() { assert.fail('沉浸切换不得重载'); }
}

class Window extends EventEmitter {
  constructor() {
    super();
    this.webContents = new Contents();
    this.fullscreen = false;
    this.fullscreenRequests = [];
    this.destroyed = false;
    this.completeImmediately = true;
    this.eventBeforeFlag = false;
    this.inFullscreenEvent = false;
  }

  isDestroyed() { return this.destroyed; }
  isFullScreen() { return this.fullscreen; }
  setFullScreen(value) {
    assert.equal(this.inFullscreenEvent, false, '不得在全屏事件回调内递归发起原生切换');
    this.fullscreenRequests.push(value);
    if (this.completeImmediately) this.completeFullscreen(value);
  }
  completeFullscreen(value) {
    if (!this.eventBeforeFlag) this.fullscreen = value;
    this.inFullscreenEvent = true;
    try {
      this.emit(value ? 'enter-full-screen' : 'leave-full-screen');
    } finally {
      this.inFullscreenEvent = false;
    }
    if (this.eventBeforeFlag) this.fullscreen = value;
  }
}

function fixture(t, { route = 'companion', fullscreen = false, initialWindow = true } = {}) {
  assert.equal(typeof implementation.WorkbenchImmersion, 'function', '必须提供独立的 WorkbenchImmersion 控制器');
  const window = new Window();
  window.webContents.url = `http://127.0.0.1:3781/#/module/${route}`;
  window.fullscreen = fullscreen;
  const handlers = new Map();
  const ipcMain = {
    handle(channel, listener) { assert.ok(!handlers.has(channel)); handlers.set(channel, listener); },
    removeHandler(channel) { handlers.delete(channel); },
  };
  let currentWindow = initialWindow ? window : undefined;
  const controller = new implementation.WorkbenchImmersion({ getWindow: () => currentWindow, ipcMain });
  t.after(() => controller.close());
  if (initialWindow) controller.attach(window.webContents);
  const invoke = (channel, value, sender = window.webContents, senderFrame = sender.mainFrame) => {
    const args = channel === GET && value === undefined ? [] : [value];
    return handlers.get(channel)({ sender, senderFrame }, ...args);
  };
  return { window, controller, handlers, invoke, setWindow: value => { currentWindow = value; } };
}

function key(contents, input = {}) {
  let prevented = false;
  contents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'F11', ...input });
  return prevented;
}

const settleFullscreen = () => new Promise(resolve => setImmediate(resolve));

test('点击进入当前模块，根窗口收到状态，退出保持原页面且不重载', async t => {
  const { controller, window, invoke } = fixture(t);
  const url = window.webContents.getURL();
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  assert.deepEqual(await invoke(SET, { active: true, moduleId: 'companion' }), { active: true, moduleId: 'companion', fullscreen: false });
  assert.deepEqual(window.webContents.messages, [{ channel: CHANGED, value: { active: true, moduleId: 'companion', fullscreen: false } }]);
  assert.deepEqual(await invoke(GET), controller.state());
  assert.deepEqual(await invoke(SET, { active: false }), { active: false, moduleId: null, fullscreen: false });
  assert.equal(window.webContents.getURL(), url);
  assert.deepEqual(window.fullscreenRequests, []);
});

test('写卡器可直接进入沉浸全屏，退出同时关闭全屏', async t => {
  const { controller, window } = fixture(t, { route: 'cards' });
  assert.deepEqual(controller.setMode({ active: true, moduleId: 'cards', fullscreen: true }), { active: true, moduleId: 'cards', fullscreen: true });
  await settleFullscreen();
  assert.deepEqual(controller.setMode({ active: false, moduleId: null }), { active: false, moduleId: null, fullscreen: false });
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false]);
});

test('F11在两个支持模块直接进入沉浸全屏，再次切换仅改变全屏', async t => {
  for (const moduleId of ['companion', 'companion-lite', 'cards']) {
    const { controller, window } = fixture(t, { route: moduleId });
    assert.equal(key(window.webContents), true);
    await settleFullscreen();
    assert.deepEqual(controller.state(), { active: true, moduleId, fullscreen: true });
    assert.equal(key(window.webContents), true);
    await settleFullscreen();
    assert.deepEqual(controller.state(), { active: true, moduleId, fullscreen: false });
    assert.equal(key(window.webContents), true);
    await settleFullscreen();
    assert.deepEqual(controller.state(), { active: true, moduleId, fullscreen: true });
  }
});

test('Esc退出沉浸和全屏，普通工作台的Esc保持交给页面', async t => {
  const { controller, window } = fixture(t, { route: 'cards' });
  assert.equal(key(window.webContents, { key: 'Escape' }), false);
  key(window.webContents);
  await settleFullscreen();
  assert.equal(key(window.webContents, { key: 'Escape' }), true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  assert.equal(window.webContents.getURL(), 'http://127.0.0.1:3781/#/module/cards');
  assert.equal(key(window.webContents, { key: 'Esc' }), false);
});

test('快捷键只处理无修饰非重复的keyDown，输入法组合与其他按键不被吞掉', t => {
  const { controller, window } = fixture(t);
  for (const input of [
    { type: 'keyUp' }, { type: 'char' }, { isAutoRepeat: true }, { repeat: true },
    { isComposing: true }, { key: 'Process' }, { key: 'a' }, { control: true },
    { alt: true }, { meta: true }, { shift: true },
  ]) assert.equal(key(window.webContents, input), false, JSON.stringify(input));
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  controller.setMode({ active: true, moduleId: 'companion', fullscreen: true });
  assert.equal(key(window.webContents, { key: 'Escape', isComposing: true }), false);
  assert.equal(controller.state().active, true);
});

test('其他路由和无法确定当前模块时不接管快捷键或隐式退出', t => {
  const { controller, window } = fixture(t, { route: 'drawing' });
  assert.equal(key(window.webContents), false);
  assert.equal(key(window.webContents, { key: 'Escape' }), false);
  for (const url of ['about:blank', 'http://127.0.0.1:3781/#/module/cards/extra', 'http://127.0.0.1:3781/#/module/companion-aux']) {
    window.webContents.url = url;
    assert.equal(key(window.webContents), false, url);
  }
  window.webContents.url = 'http://127.0.0.1:3781/#/module/companion';
  controller.setMode({ active: true, moduleId: 'companion' });
  window.webContents.url = 'about:blank';
  assert.equal(key(window.webContents, { key: 'Escape' }), false);
  assert.equal(controller.state().active, true);
  assert.deepEqual(controller.setMode({ active: false }), { active: false, moduleId: null, fullscreen: false });
});

test('原生子视图快捷键要求当前模块和主窗口归属，辅助窗口及旧视图不能接管', async t => {
  const { controller, window } = fixture(t);
  const stage = new Contents('http://127.0.0.1:3782/');
  const auxiliary = new Contents('http://127.0.0.1:3782/settings');
  let embedded = true;
  controller.attach(stage, { moduleId: 'companion', isEligibleSource: () => embedded });
  controller.attach(auxiliary);
  assert.equal(key(auxiliary), false);
  assert.equal(key(stage), true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: true });
  assert.deepEqual(stage.messages, []);
  embedded = false;
  assert.equal(key(stage, { key: 'Escape' }), false);
  assert.equal(controller.state().active, true);
  embedded = true;
  window.webContents.url = 'http://127.0.0.1:3781/#/module/cards';
  assert.equal(key(stage, { key: 'Escape' }), false);
  assert.equal(key(stage), false);
  window.webContents.url = 'http://127.0.0.1:3781/#/module/companion';
  assert.equal(key(stage, { key: 'Escape' }), true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
});

test('IPC拒绝伪造sender、子frame、销毁来源及额外参数', async t => {
  const { controller, window, invoke, handlers } = fixture(t);
  const foreign = new Contents(window.webContents.getURL());
  const value = { active: true, moduleId: 'companion' };
  for (const channel of [SET, GET]) {
    await assert.rejects(async () => invoke(channel, channel === SET ? value : undefined, foreign), /来源|source|sender/i);
    await assert.rejects(async () => invoke(channel, channel === SET ? value : undefined, window.webContents, {}), /来源|source|sender/i);
  }
  await assert.rejects(async () => handlers.get(SET)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, value, 'extra'), /参数|argument/i);
  await assert.rejects(async () => invoke(GET, { extra: true }), /参数|argument/i);
  window.webContents.destroyed = true;
  await assert.rejects(async () => invoke(SET, value), /来源|source|sender/i);
  assert.equal(controller.state().active, false);
});

test('入口严格验证字段及当前模块，非法请求不改变状态', t => {
  const { controller, window } = fixture(t);
  for (const value of [
    null, [], 'companion', {}, { active: 1 }, { active: true },
    { active: true, moduleId: 'drawing' }, { active: true, moduleId: 'cards' },
    { active: true, moduleId: 'companion', fullscreen: 'true' },
    { active: true, moduleId: 'companion', extra: true },
    { active: false, fullscreen: true }, { active: false, moduleId: 'drawing' },
    JSON.parse('{"active":false,"__proto__":{"polluted":true}}'),
    Object.assign(Object.create({ inherited: true }), { active: false }),
  ]) assert.throws(() => controller.setMode(value), undefined, JSON.stringify(value));
  window.webContents.url = 'about:blank';
  assert.throws(() => controller.setMode({ active: true, moduleId: 'companion' }));
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  assert.deepEqual(window.webContents.messages, []);
  assert.equal(({}).polluted, undefined);
});

test('窗口实际全屏事件同步状态，离开全屏保留沉浸，重复状态不重复通知', async t => {
  const { controller, window } = fixture(t);
  window.completeImmediately = false;
  assert.deepEqual(controller.setMode({ active: true, moduleId: 'companion', fullscreen: true }), { active: true, moduleId: 'companion', fullscreen: false });
  window.completeFullscreen(true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: true });
  const count = window.webContents.messages.length;
  window.completeFullscreen(true);
  controller.setMode({ active: true, moduleId: 'companion' });
  await settleFullscreen();
  assert.equal(window.webContents.messages.length, count);
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: false });
});

test('进入全屏尚未完成时Esc合并退出意图，等待进入确认后再退出', async t => {
  const { controller, window } = fixture(t);
  window.completeImmediately = false;
  assert.equal(key(window.webContents), true);
  assert.equal(key(window.webContents, { key: 'Escape' }), true);
  assert.deepEqual(window.fullscreenRequests, [true], '一个原生切换完成前不发送相反请求');
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  window.completeFullscreen(true);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: true });
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
});

test('进入完成前连续F11合并true、false、true，只提交最终需要的原生切换', async t => {
  const { controller, window } = fixture(t);
  window.completeImmediately = false;
  assert.equal(key(window.webContents), true);
  assert.equal(key(window.webContents), true);
  assert.equal(key(window.webContents), true);
  assert.deepEqual(window.fullscreenRequests, [true]);
  window.completeFullscreen(true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: true });
  window.completeFullscreen(true);
  await settleFullscreen();
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true], '已收敛后接受原生正常退出全屏');
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: false });
});

test('退出已在途时再次请求进入，等待leave完成再进入且重复enter不会增发请求', async t => {
  const { controller, window } = fixture(t);
  window.completeImmediately = false;
  assert.equal(key(window.webContents), true);
  assert.equal(key(window.webContents), true);
  window.completeFullscreen(true);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  assert.equal(key(window.webContents), true);
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  window.completeFullscreen(true);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false, true]);
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: false });
  window.completeFullscreen(true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: true });
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false, true]);
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: false });
});

test('Esc取消等待中的重新全屏，原生退出完成后不再重入', async t => {
  const { controller, window } = fixture(t);
  assert.equal(key(window.webContents), true);
  await settleFullscreen();
  window.completeImmediately = false;
  assert.equal(key(window.webContents), true);
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  assert.equal(key(window.webContents), true);
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  assert.equal(key(window.webContents, { key: 'Escape' }), true);
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
});

test('Windows先发全屏事件再更新flag，F11和Esc仍可连续切换且通知反映新状态', async t => {
  const { controller, window } = fixture(t);
  window.eventBeforeFlag = true;
  const callbacks = [];
  window.on('enter-full-screen', () => callbacks.push({ event: true, actual: window.isFullScreen() }));
  window.on('leave-full-screen', () => callbacks.push({ event: false, actual: window.isFullScreen() }));
  for (const fullscreen of [true, false, true]) {
    assert.equal(key(window.webContents), true);
    await settleFullscreen();
    assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen });
  }
  assert.equal(key(window.webContents, { key: 'Escape' }), true);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  assert.deepEqual(callbacks, [
    { event: true, actual: false }, { event: false, actual: true },
    { event: true, actual: false }, { event: false, actual: true },
  ]);
  assert.deepEqual(window.fullscreenRequests, [true, false, true, false]);
  assert.deepEqual(window.webContents.messages.map(message => message.value.fullscreen), [true, false, true, false]);
});

test('Windows事件中的旧flag不会阻止串行退出，也不会重入原生setter', async t => {
  const { controller, window } = fixture(t);
  window.eventBeforeFlag = true;
  window.completeImmediately = false;
  key(window.webContents);
  key(window.webContents, { key: 'Escape' });
  window.completeFullscreen(true);
  assert.deepEqual(window.fullscreenRequests, [true], '完成事件返回前继续保留在途请求');
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true, false]);
  window.completeFullscreen(false);
  await settleFullscreen();
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
});

test('关闭后已排队的全屏完成回调不再推进切换或发送状态', async t => {
  const { controller, window } = fixture(t);
  window.eventBeforeFlag = true;
  window.completeImmediately = false;
  key(window.webContents);
  key(window.webContents, { key: 'Escape' });
  window.completeFullscreen(true);
  const count = window.webContents.messages.length;
  controller.close();
  await settleFullscreen();
  assert.deepEqual(window.fullscreenRequests, [true]);
  assert.equal(window.webContents.messages.length, count);
});

test('窗口延迟创建时可以附着并读取实际状态，不在未知窗口上导航', t => {
  const { controller, window, setWindow } = fixture(t, { initialWindow: false, fullscreen: true });
  assert.deepEqual(controller.state(), { active: false, moduleId: null, fullscreen: false });
  setWindow(window);
  controller.attach(window.webContents);
  assert.equal(controller.state().fullscreen, true);
  assert.equal(key(window.webContents), true);
  assert.deepEqual(controller.state(), { active: true, moduleId: 'companion', fullscreen: true });
});

test('关闭解除自有IPC和监听，保留其他监听且反复关闭安全', t => {
  const { controller, window, handlers } = fixture(t);
  const child = new Contents();
  const independent = () => {};
  window.webContents.on('before-input-event', independent);
  window.on('enter-full-screen', independent);
  controller.attach(child, { moduleId: 'companion', isEligibleSource: () => true });
  controller.attach(child, { moduleId: 'companion', isEligibleSource: () => true });
  const detach = controller.attach(child, { moduleId: 'companion', isEligibleSource: () => true });
  assert.equal(child.listenerCount('before-input-event'), 1);
  detach();
  assert.equal(key(child), false);
  controller.close();
  controller.close();
  assert.deepEqual([...handlers.keys()], []);
  assert.deepEqual(window.webContents.listeners('before-input-event'), [independent]);
  assert.deepEqual(window.listeners('enter-full-screen'), [independent]);
  assert.equal(window.listenerCount('leave-full-screen'), 0);
  assert.equal(child.listenerCount('destroyed'), 0);
  assert.equal(key(window.webContents), false);
  assert.throws(() => controller.setMode({ active: true, moduleId: 'companion' }), /关闭|closed/i);
});

test('销毁子视图自动解除快捷键，不遗留监听', t => {
  const { controller } = fixture(t);
  const child = new Contents();
  controller.attach(child, { moduleId: 'companion', isEligibleSource: () => true });
  child.destroyed = true;
  child.emit('destroyed');
  assert.equal(child.listenerCount('before-input-event'), 0);
  assert.equal(child.listenerCount('destroyed'), 0);
});

test('sandbox preload仅依赖electron并暴露窄接口，订阅不泄漏IPC事件且可取消', async () => {
  const file = new URL('../desktop/workbench-preload.cjs', import.meta.url);
  assert.ok(existsSync(file), '必须提供 sandbox 可用的根 preload');
  const ipc = new EventEmitter();
  const invokes = [];
  ipc.invoke = async (...args) => { invokes.push(args); return { active: false, moduleId: null, fullscreen: false }; };
  ipc.removeListener = ipc.removeListener.bind(ipc);
  let exposed;
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    require(name) {
      assert.equal(name, 'electron', 'sandbox preload只能require electron');
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'workbenchWindow'); exposed = api; } } };
    },
  }, { filename: file.pathname });
  assert.deepEqual(Object.keys(exposed).sort(), ['getImmersive', 'onImmersiveChange', 'setImmersive']);
  const value = { active: true, moduleId: 'cards' };
  await exposed.setImmersive(value);
  await exposed.getImmersive();
  assert.deepEqual(invokes, [[SET, value], [GET]]);
  assert.throws(() => exposed.onImmersiveChange(null));
  const received = [];
  const unsubscribe = exposed.onImmersiveChange((...args) => received.push(args));
  const state = { active: true, moduleId: 'cards', fullscreen: true };
  ipc.emit(CHANGED, { sender: 'private electron event' }, state);
  assert.deepEqual(received, [[state]]);
  assert.equal(unsubscribe(), undefined, '取消订阅不能返回ipcRenderer对象');
  assert.equal(unsubscribe(), undefined);
  ipc.emit(CHANGED, {}, { active: false, moduleId: null, fullscreen: false });
  assert.deepEqual(received, [[state]]);
  assert.equal(ipc.listenerCount(CHANGED), 0);
});
