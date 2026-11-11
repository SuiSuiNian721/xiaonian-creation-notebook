import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron'),directory=process.env.SETTINGS_SECTIONS_TEST_DIR;
  app.setPath('userData',join(directory,'electron'));app.on('window-all-closed',()=>{});await app.whenReady();
  const backend=await createWorkbench({dataDir:join(directory,'data')});
  const window=new BrowserWindow({show:false,width:1420,height:960,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const errors=[],js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const wait=async(source)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await js(source))return;await pause(40);}throw new Error('等待超时 '+source);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const select=name=>click(`[data-settings-tab="${name}"]`);
  const fill=(selector,value)=>js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const shot=async name=>{
    if(!process.env.SETTINGS_SECTIONS_OUTPUT)return;
    mkdirSync(process.env.SETTINGS_SECTIONS_OUTPUT,{recursive:true});
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    // 离屏 Chromium 第一次抓取可能唤醒合成器并返回旧帧；先刷新再取最终截图。
    await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await new Promise((resolve,reject)=>{
      const painted=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{window.webContents.removeListener('paint',painted);reject(new Error('截图前等待重绘超时'));},5000);
      window.webContents.once('paint',painted);window.webContents.invalidate();
    });
    writeFileSync(join(process.env.SETTINGS_SECTIONS_OUTPUT,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  };
  try{
    await window.loadURL(backend.url+'#/settings');await wait("Boolean(document.querySelector('#ai-provider'))");
    assert.equal(await js("document.querySelector('[data-settings-tab][aria-selected=true]')?.textContent.trim()"),'AI 接入','进入设置直接呈现 AI 接入');
    assert.equal(await js("document.querySelectorAll('[data-settings-panel]:not([hidden])').length"),1);
    await js("(()=>{const p=document.querySelector('#ai-provider');p.value='openai';p.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await fill('#ai-base-url','http://127.0.0.1:19999/v1');await fill('#ai-key','draft-key-only');
    await js("window.__settingsForm=document.querySelector('#shared-ai-form');void 0");
    await shot('ai-first-light');
    await select('user');await wait("Boolean(document.querySelector('#profile-display-name'))");await fill('#profile-display-name','分区切换保留的草稿');
    await select('storage');await wait("Boolean(document.querySelector('[data-component-source] input'))");await fill('[data-component-source] input','https://example.invalid/components/');
    await select('general');await click('#theme-toggle');await wait("document.documentElement.dataset.theme==='dark'");
    assert.equal(await js("document.querySelector('[data-theme-choice][aria-pressed=true]').dataset.themeChoice"),'dark');
    await shot('general-dark');
    await select('ai');
    assert.equal(await js("document.querySelector('#shared-ai-form')===window.__settingsForm"),true,'切换分区不能重建表单');
    assert.equal(await js("document.querySelector('#ai-base-url').value"),'http://127.0.0.1:19999/v1');
    assert.equal(await js("document.querySelector('#ai-key').value"),'draft-key-only');
    await js("document.querySelector('[data-settings-tab=ai]').focus();void 0");
    for(const key of ['ArrowRight','End','Home']){
      const keyCode=key==='ArrowRight'?'Right':key;
      window.webContents.sendInputEvent({type:'keyDown',keyCode});window.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(80);
      const expected={ArrowRight:'user',End:'general',Home:'ai'}[key];
      assert.equal(await js("document.activeElement.dataset.settingsTab"),expected);
      assert.equal(await js("document.querySelector('[data-settings-tab][aria-selected=true]').dataset.settingsTab"),expected);
    }
    assert.equal(await js("document.querySelectorAll('[data-settings-tab][tabindex=\"0\"]').length"),1);
    await select('user');assert.equal(await js("document.querySelector('#profile-display-name').value"),'分区切换保留的草稿');
    await select('storage');assert.equal(await js("document.querySelector('[data-component-source] input').value"),'https://example.invalid/components/');
    await select('ai');await click('#shared-ai-form [type=submit]');await wait("document.querySelector('#ai-feedback').textContent==='共用连接已保存。'");
    const config=await fetch(backend.url+'/api/ai/config').then(response=>response.json());assert.equal(config.baseUrl,'http://127.0.0.1:19999/v1');assert.equal(config.hasKey,true);
    for(const [width,height] of [[1420,960],[900,900],[780,640]]){
      window.setSize(width,height);await pause(200);
      assert.equal(await js("document.querySelector('.brand small')"),null,'用户身份区不再显示应用名称小标签');
      assert.ok(await js("['#sidebar-user-name','.local-status'].every(selector=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)>=12)"),'用户名称和状态文字至少 12px');
      assert.equal(await js("document.documentElement.scrollWidth>innerWidth"),false,'桌面页面不横向溢出');
      assert.ok(await js("(()=>{const el=document.querySelector('#ai-provider'),r=el.getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight;})()"),'AI 接入方式在首屏可见');
      assert.ok(await js("[...document.querySelectorAll('[data-settings-tab]')].every(tab=>tab.getBoundingClientRect().right<=innerWidth&&tab.scrollWidth<=tab.clientWidth)"),'分区按钮未截断');
      await shot('ai-dark-'+width);
    }
    const enabled=await fetch(backend.url+'/api/modules/companion-lite/enable',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(enabled.status,200);
    window.setSize(1420,960);await window.loadURL(backend.url+'?ux-check=companion#/module/companion-lite');
    await wait("Boolean(document.querySelector('[data-lite-form]'))");
    assert.equal(await js("Boolean(document.querySelector('[data-package-installation]'))"),false,'首次添加直接进入聊天界面，无需手动安装内置规则');
    await js("document.querySelector('[data-module-tour]:popover-open [data-tour-skip]')?.click();void 0");await shot('companion-auto-ready');
    assert.deepEqual(errors,[]);console.log('SETTINGS_SECTIONS_RESULT passed');
  }finally{window.destroy();await backend.close();}
}
if(process.argv.includes('--settings-sections-electron'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('设置分区默认 AI 接入，键盘可操作并保留草稿和桌面可读性',{skip:!electron,timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'workbench-settings-sections-')),env={...process.env,SETTINGS_SECTIONS_TEST_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--settings-sections-electron'],{cwd:root,env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output);assert.match(output,/SETTINGS_SECTIONS_RESULT passed/);
});
