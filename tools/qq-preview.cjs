const { app } = require('electron');
let firstWindow = true;
app.on('browser-window-created', (_event, window) => {
  if (!firstWindow) return;
  firstWindow = false;
  window.webContents.once('did-finish-load', () => {
    window.setTitle('AI未来 工作台 · QQ 预览');
    window.show();
    window.focus();
    void window.webContents.executeJavaScript(`(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const entry = document.querySelector('[data-module-nav="qq"]');
        if (entry) { entry.click(); return; }
        await new Promise(done => setTimeout(done, 100));
      }
    })()`).catch(() => {});
  });
});
require('../desktop/workbench.cjs');
