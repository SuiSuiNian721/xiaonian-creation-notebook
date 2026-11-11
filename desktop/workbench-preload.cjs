const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbenchWindow', {
  setImmersive: value => ipcRenderer.invoke('ai-future:immersion:set', value),
  getImmersive: () => ipcRenderer.invoke('ai-future:immersion:get'),
  onImmersiveChange(callback) {
    if (typeof callback !== 'function') throw new TypeError('沉浸状态订阅需要回调函数。');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('ai-future:immersion:changed', listener);
    return () => { ipcRenderer.removeListener('ai-future:immersion:changed', listener); };
  },
});
