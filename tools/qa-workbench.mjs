import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCardStudioQa } from './qa-card-studio.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

export async function runQa({window,runtime,qaDir,dialog}) {
  mkdirSync(qaDir,{recursive:true});
  // Offscreen windows are not OS-focused. Emulate page focus for real DOM focus events.
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const checks=[];
  const errors=[];
  const requests=[];
  const sockets=[];
  const downloads=[];
  const networkEvent=(_event,method,params)=>{if(method==='Network.webSocketCreated')sockets.push(params.url);};
  window.webContents.debugger.on('message',networkEvent);
  await window.webContents.debugger.sendCommand('Network.enable');
  window.webContents.on('console-message', event => {if(/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message);});
  const js=async code=>{
    try{return await window.webContents.executeJavaScript(code);}
    catch(error){throw new Error(`页面操作失败 ${code.slice(0,180)}\n${error.message}`,{cause:error});}
  };
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const fill=(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const submit=selector=>js(`document.querySelector(${JSON.stringify(selector)}).requestSubmit();void 0`);
  const text=selector=>js(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`);
  async function waitFor(label,test,timeout=15000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await test())return;await pause(100);}throw new Error(`等待超时：${label}`);}
  async function api(path='/api/state',method='GET',body){const r=await fetch(runtime.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});assert.equal(r.status,200,`${method} ${path}`);return r.json();}
  const state=()=>api();
  async function view(route){await js(`location.hash=${JSON.stringify('/'+route)};void 0`);await waitFor(`页面 ${route}`,()=>js(`document.getElementById('main-content').getAttribute('aria-busy')==='false'&&location.hash===${JSON.stringify('#/'+route)}`));await pause(150);}
  async function shot(name){await js(`document.getElementById('toast').hidden=true;void 0`);window.webContents.invalidate();await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);await pause(250);writeFileSync(join(qaDir,`${name}.png`),(await window.webContents.capturePage()).toPNG());}
  async function add(id){await view('catalog');await click(`[data-add="${id}"]`);await waitFor(`添加 ${id}`,async()=> (await state()).modules.find(m=>m.id===id).enabled);await waitFor(`侧栏 ${id}`,()=>js(`Boolean(document.querySelector('[data-module-nav="${id}"]'))`));}
  async function config(id){await view(`module/${id}`);await waitFor(`模块 ${id} 已打开`,()=>js(`Boolean(document.querySelector('#tab-config'))`));await click('#tab-config');await waitFor('配置表单',()=>js(`Boolean(document.querySelector('#module-config-form'))`));}
  async function saveConfig(){await submit('#module-config-form');await waitFor('保存完成',()=>js(`!document.querySelector('#save-module-config').disabled`));assert.ok(!(await text('#config-feedback')).includes('失败'));}
  window.webContents.session.on('will-download',(_event,item)=>{
    const path=join(qaDir,`export-${downloads.length}.json`);item.setSavePath(path);
    item.once('done',(_event,result)=>{downloads.push({path,result});});
  });
  let blockCompanion=false;
  window.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    requests.push(details.url);
    callback({cancel:blockCompanion && new URL(details.url).pathname==='/modules/companion.js'});
  });
  try {
    await window.loadURL(runtime.url);
    await waitFor('工作台已读取',()=>js(`document.getElementById('app-shell').getAttribute('aria-busy')==='false'&&document.querySelector('h1')?.textContent==='我的工作台'`));
    assert.equal((await state()).modules.filter(m=>m.enabled).length,0);
    assert.equal((await state()).characters.length,0);
    assert.equal((await state()).tasks.length,0);
    assert.equal(await js(`performance.getEntriesByType('resource').some(e=>new URL(e.name).pathname.startsWith('/modules/'))`),false);
    await shot('welcome'); checks.push('空工作台可用，未添加模块不会载入业务视图');
    assert.equal(await js(`Boolean(document.querySelector('.welcome-surface,.workspace-footer,.hint-list'))`),false);
    await js(`document.querySelector('.help-button').focus();void 0`);
    assert.equal(await js(`document.querySelector('#help-tooltip').hidden`),false);
    assert.ok((await text('#help-tooltip')).includes('角色卡'));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
    assert.equal(await js(`document.querySelector('#help-tooltip').hidden`),true);
    await click('.help-button');assert.equal(await js(`document.querySelector('#help-tooltip').hidden`),false);
    await click('h1');assert.equal(await js(`document.querySelector('#help-tooltip').hidden`),true);
    checks.push('首页无口号与常驻教学段落，info 支持焦点、点击和 Escape 关闭');
    await view('catalog'); assert.equal(await js(`document.querySelectorAll('[data-module-card]').length`),9);
    await fill('#module-search','ComfyUI');assert.equal(await js(`document.querySelectorAll('[data-module-card]').length`),2);
    await fill('#module-search','');await click('[data-category="companion"]');assert.equal(await js(`document.querySelectorAll('[data-module-card]').length`),3);
    await click('[data-category="all"]');await shot('catalog');checks.push('九模块目录、搜索和分类可用');
    await click('.skip-link');await pause(150);
    assert.equal(await js('location.hash'),'#/catalog');
    assert.equal(await js('document.activeElement.id'),'main-content');
    checks.push('跳到工作区仅移动焦点，保持当前模块目录路由');

    await add('drawing');
    await add('comfyui');
    await add('voice');
    await view('module/voice');
    assert.equal(await js(`Boolean(document.querySelector('#tab-resources'))`),true,'模块内应提供资源安装入口');
    await click('#tab-resources');
    await waitFor('模块资源清单',()=>js(`Boolean(document.querySelector('#resource-plan-preview'))`));
    const originalDirectory = await js(`document.querySelector('#resource-directory').value`);
    const pickedDirectory = join(qaDir,'念念选择的资源 目录');
    mkdirSync(pickedDirectory,{recursive:true});
    const originalDialog = dialog.showOpenDialog;
    let pickerCalls = 0;
    dialog.showOpenDialog = async (parent,options) => {
      assert.equal(parent,window);
      assert.deepEqual(options.properties,['openDirectory','createDirectory']);
      assert.equal(options.defaultPath,pickerCalls < 2 ? originalDirectory : pickedDirectory);
      pickerCalls++;
      if (pickerCalls === 3) throw new Error('选择器测试异常');
      return pickerCalls === 1 ? {canceled:true,filePaths:[]} : {canceled:false,filePaths:[pickedDirectory]};
    };
    try {
      assert.equal(await js(`document.querySelector('#resource-directory').readOnly`),true);
      assert.equal(await js(`document.querySelector('#choose-resource-directory').disabled`),false);
      await click('#choose-resource-directory');
      await waitFor('取消文件夹选择',async()=>pickerCalls===1&&await js(`!document.querySelector('#choose-resource-directory').disabled`));
      assert.equal(await js(`document.querySelector('#resource-directory').value`),originalDirectory);
      await click('#choose-resource-directory');
      await waitFor('文件夹选择回填',()=>js(`document.querySelector('#resource-directory').value===${JSON.stringify(pickedDirectory)}&&!document.querySelector('#choose-resource-directory').disabled`));
      assert.equal((await api('/api/modules/voice/resources')).directory,pickedDirectory);
      assert.notEqual((await api('/api/modules/drawing/resources')).directory,pickedDirectory);
      await click('#choose-resource-directory');
      await waitFor('选择器异常恢复',async()=>pickerCalls===3&&await js(`!document.querySelector('#choose-resource-directory').disabled&&document.querySelector('#resource-feedback').classList.contains('error')`));
      assert.equal(await js(`document.querySelector('#resource-directory').value`),pickedDirectory);
      await click('#tab-config'); await click('#tab-resources');
      await waitFor('返回时恢复所选文件夹',()=>js(`document.querySelector('#resource-directory')?.value===${JSON.stringify(pickedDirectory)}`));
    } finally { dialog.showOpenDialog=originalDialog; }
    checks.push('文件夹选择回填与保存、取消不变、异常恢复、模块隔离及返回恢复通过；系统对话框使用隔离替身');
    assert.equal(await js(`document.querySelector('[data-required-resource]').checked&&document.querySelector('[data-required-resource]').disabled`),true);
    assert.ok((await text('#resource-prerequisites')).includes('必装'));
    assert.ok((await text('#resource-prerequisites')).includes('待确定'));
    assert.equal((await state()).tasks.length,0);
    await shot('module-resources');
    await click('#resource-plan-preview');
    await waitFor('安装清单确认',()=>js(`document.querySelector('#installation-confirm')?.open===true`));
    assert.equal(await js(`document.querySelector('#confirm-resource-install').disabled`),true);
    assert.ok((await text('#installation-confirm')).includes('待确定'));
    assert.ok((await text('#installation-confirm')).includes(pickedDirectory));
    await shot('resource-confirmation');
    await click('#cancel-resource-confirm');
    assert.equal(await js(`document.querySelector('#installation-confirm').open`),false);
    assert.equal(await js('document.activeElement.id'),'resource-plan-preview');
    checks.push('添加仅启用入口；模块内前置必选，未知大小如实呈现，未接入安装器不能执行');
    await testResourceView({js,click,text,waitFor,shot});
    checks.push('隔离界面夹具验证可选文件选择、总量、过期确认、安装进度与取消；夹具未执行下载');
    await config('comfyui');
    await fill('[name="comfyPath"]',`  ${qaDir}  `);await fill('[name="outputPath"]',join(qaDir,'missing-output'));await fill('[name="serviceUrl"]','http://127.0.0.1:8188');
    await saveConfig();assert.equal((await state()).modules.find(m=>m.id==='drawing').config.comfyPath,qaDir);
    assert.equal(await js(`document.querySelector('[name="comfyPath"]').value`),qaDir);
    assert.equal(await js(`document.querySelector('#check-paths').disabled`),false);
    await click('#check-paths');await waitFor('路径结果',async()=> (await state()).modules.find(m=>m.id==='drawing').checks?.comfyPath?.status==='valid');
    await waitFor('缺失路径显示',()=>js(`document.querySelector('[data-path-result="outputPath"]').textContent.includes('找不到')`));
    checks.push('配置真实保存；有效与缺失路径分别呈现，不启动外部工具');

    await fill('[name="serviceUrl"]','http://127.0.0.1:8189');
    await config('voice');
    assert.equal(await js(`document.querySelector('[name="serviceUrl"]').value`),'');
    await fill('[name="serviceUrl"]','http://127.0.0.1:9880');await saveConfig();
    await config('comfyui');assert.equal(await js(`document.querySelector('[name="serviceUrl"]').value`),'http://127.0.0.1:8189');
    assert.equal((await state()).modules.find(m=>m.id==='drawing').config.serviceUrl,'http://127.0.0.1:8188');
    checks.push('模块配置互相隔离，切换模块保留未提交草稿');

    await fill('[name="comfyPath"]',`  ${qaDir}  `);
    await js(`window.__originalFetch=window.fetch;window.fetch=(url,options)=>url==='/api/modules/drawing/config'&&options?.method==='PUT'?new Promise((resolve,reject)=>{window.__releaseSave=()=>window.__originalFetch(url,options).then(resolve,reject)}):window.__originalFetch(url,options);void 0`);
    await submit('#module-config-form');await waitFor('保存请求已暂停',()=>js(`typeof window.__releaseSave==='function'`));
    await fill('[name="serviceUrl"]','http://127.0.0.1:8190');
    await js(`window.__releaseSave();window.fetch=window.__originalFetch;void 0`);
    await waitFor('慢保存结束',()=>js(`!document.querySelector('#save-module-config').disabled`));
    assert.equal(await js(`document.querySelector('[name="serviceUrl"]').value`),'http://127.0.0.1:8190');
    assert.equal(await js(`document.querySelector('[name="comfyPath"]').value`),qaDir);
    assert.equal((await state()).modules.find(m=>m.id==='drawing').config.serviceUrl,'http://127.0.0.1:8189');
    await view('home');await config('comfyui');
    assert.equal(await js(`document.querySelector('[name="serviceUrl"]').value`),'http://127.0.0.1:8190');
    assert.equal(await js(`document.querySelector('[name="comfyPath"]').value`),qaDir);
    await saveConfig();checks.push('慢保存完成不会覆盖继续输入的新草稿');

    await fill('[name="outputPath"]',`  ${qaDir}  `);
    await js(`window.__stateReleases=[];window.__originalFetch=window.fetch;window.fetch=(url,options)=>url==='/api/state'?new Promise((resolve,reject)=>{window.__stateReleases.push(()=>window.__originalFetch(url,options).then(resolve,reject))}):window.__originalFetch(url,options);void 0`);
    await submit('#module-config-form');await waitFor('保存刷新已暂停',()=>js(`window.__stateReleases.length===1`));
    await click('#theme-toggle');await waitFor('主题刷新已暂停',()=>js(`window.__stateReleases.length===2`));
    await js(`window.__stateReleases[0]();void 0`);await waitFor('被取代的刷新完成',()=>js(`!document.querySelector('#save-module-config').disabled`));
    assert.equal(await js(`document.querySelector('[name="outputPath"]').value`),qaDir);
    assert.equal(await js(`document.querySelector('#check-paths').disabled`),false);
    await js(`window.__stateReleases[1]();window.fetch=window.__originalFetch;void 0`);
    await waitFor('主题刷新结束',()=>js(`document.documentElement.dataset.theme==='dark'`));
    await pause(150);await click('#theme-toggle');await waitFor('恢复浅色',async()=> (await state()).preferences.theme==='light');
    await fill('[name="outputPath"]',join(qaDir,'missing-output'));await saveConfig();
    checks.push('保存与主题刷新重叠时使用保存响应回填，不清空配置且路径检查仍可用');

    await view('module/drawing');await click('#remove-module');await waitFor('绘图已移除',async()=> !(await state()).modules.find(m=>m.id==='drawing').enabled);
    await add('drawing');await config('comfyui');assert.equal(await js(`document.querySelector('[name="serviceUrl"]').value`),'http://127.0.0.1:8190');
    checks.push('移除仅停用入口，重新添加恢复原配置');

    await view('characters');await fill('#new-character-name','测试角色 · 星禾');await fill('#new-character-description','这是一份隔离验收档案，用于检查共享人设与模块切换。');await submit('#create-character-form');
    await waitFor('角色创建',async()=> (await state()).characters.length===1);
    await waitFor('角色选择按钮',()=>js(`Boolean(document.querySelector('[data-select-character]'))`));
    const first=(await state()).characters[0];
    if((await state()).selectedCharacterId!==first.id) await click('[data-select-character]');
    await waitFor('选中角色',async()=> (await state()).selectedCharacterId===first.id);
    const raw={spec:'chara_card_v2',spec_version:'2.0',data:{name:'测试角色 · 沐岚',description:'用于验证原始字段保留的测试人设。',extensions:{custom:{favorite:'海风',flags:[true,false]}}},custom_root:{untouched:42}};
    await js(`(()=>{const file=new File([JSON.stringify(${JSON.stringify(raw)})],'qa-character.json',{type:'application/json'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#character-import-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor('角色卡导入',async()=> (await state()).characters.length===2);
    const second=(await state()).characters.find(c=>c.name.includes('沐岚'));
    assert.deepEqual(second.raw,raw);await fill('#character-select',second.id);
    await waitFor('共享角色已切换',async()=> (await state()).selectedCharacterId===second.id);
    await config('voice');await click('#tab-overview');assert.ok((await text('.binding-summary')).includes('沐岚'));
    await view('characters');await click(`[data-export-character="${second.id}"]`);
    await waitFor('真实文件导出',()=>downloads.length===1);
    assert.equal(downloads[0].result,'completed');
    const bundle=JSON.parse(readFileSync(downloads[0].path,'utf8'));assert.deepEqual(bundle.character.raw,raw);
    await js(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(${JSON.stringify(bundle)})],'roundtrip.json',{type:'application/json'}));const input=document.querySelector('#character-import-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor('往返完成',()=>js(`!document.querySelector('#import-character').disabled`));assert.equal((await state()).characters.length,2);
    checks.push('界面创建与文件导入、角色共享、真实下载后重新导入均通过');

    await js(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['{bad json'],'bad.json',{type:'application/json'}));const input=document.querySelector('#character-import-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor('损坏文件反馈',()=>js(`document.querySelector('#import-feedback').classList.contains('error')`));assert.equal((await state()).characters.length,2);
    await shot('characters');checks.push('损坏资料文件给出明确错误且不修改原数据');

    await add('companion');blockCompanion=true;await view('module/companion');
    await waitFor('模块局部加载失败',()=>js(`Boolean(document.querySelector('#retry-module'))`));
    await view('module/drawing');await waitFor('其他模块继续可用',()=>js(`Boolean(document.querySelector('#tab-overview'))`));
    await view('module/companion');await waitFor('失败可重试',()=>js(`Boolean(document.querySelector('#retry-module'))`));
    blockCompanion=false;await click('#retry-module');await waitFor('重试恢复',()=>js(`Boolean(document.querySelector('#companion-tab-stage'))`));
    checks.push('模块加载失败隔离，其他模块可用，重试能恢复');

    for(const id of ['cards','training','qq','mc-skin','mc-play']) await add(id);
    for(const id of ['training','mc-skin']) {await config(id);assert.ok(await js(`document.querySelectorAll('[data-setting]').length>0`));}
    await view('module/qq');await waitFor('QQ 管理界面',()=>js(`Boolean(document.querySelector('#qq-tab-connect'))`));
    assert.equal((await api('/api/modules/qq/state')).binding,null,'顶部选角不会自动绑定 QQ');
    await view('module/mc-play');await waitFor('MC 陪玩连接界面',()=>js(`Boolean(document.querySelector('#mc-connection-form'))`));
    await view('module/cards');await click('#tab-overview');await shot('cards-overview');
    await runCardStudioQa({window,runtime,qaDir,js,click,fill,waitFor,shot,view,checks});
    await view('module/voice');await click('#tab-overview');await shot('voice-character-context');
    await view('module/qq');await waitFor('QQ 接入表单',()=>js(`Boolean(document.querySelector('#qq-runtime-form'))`));
    await js(`document.querySelector('#qq-external-options').open=true;void 0`);
    await fill('#qq-runtime-mode','external');await fill('#qq-ws-url','ws://127.0.0.1:3001');await fill('#qq-expected-account','90001');
    await submit('#qq-runtime-form');await waitFor('QQ 接入方式已保存',async()=> (await api('/api/modules/qq/state')).runtime.mode==='external');
    const qqState=await api('/api/modules/qq/state');
    assert.equal(qqState.runtime.external.wsUrl,'ws://127.0.0.1:3001/');assert.equal(qqState.runtime.external.accountId,'90001');
    assert.equal(qqState.runtime.running,false);assert.equal(qqState.transport.status,'disconnected');assert.equal(qqState.paused,true);
    assert.equal((await state()).tasks.length,0);
    const externalRequests=requests.filter(url=>/^https?:/.test(url)&&new URL(url).origin!==runtime.url);
    assert.deepEqual(externalRequests,[]);assert.deepEqual(sockets,[]);
    checks.push('九个模块全部在同一窗口打开；QQ 配置保存不会发起外部连接');

    await view('events');await fill('#event-filter','drawing');
    const eventsText=await text('#event-results');assert.ok(eventsText.includes('角色绘图'));assert.ok(!eventsText.includes('角色声音'));
    await click('#refresh-events');await waitFor('日志刷新完成',()=>js(`!document.querySelector('#refresh-events').disabled`));
    checks.push('统一日志按模块过滤并可刷新');
    await view('home');await shot('desktop');
    await click('#theme-toggle');await waitFor('深色保存',async()=> (await state()).preferences.theme==='dark');await shot('desktop-dark');
    await window.loadURL(runtime.url);await waitFor('重载后主题和数据恢复',()=>js(`document.documentElement.dataset.theme==='dark'&&document.querySelectorAll('[data-module-nav]').length===9`));
    assert.equal((await state()).selectedCharacterId,second.id);checks.push('重载恢复主题、九模块和当前角色');
    await config('voice');await shot('module-dark');await click('#tab-resources');await waitFor('深色资源页',()=>js(`Boolean(document.querySelector('#resource-plan-preview'))`));await shot('resources-dark');await click('#theme-toggle');await waitFor('浅色保存',async()=> (await state()).preferences.theme==='light');await click('#tab-config');await shot('module-config');
    await click('#tab-overview');await shot('module-overview');
    // Desktop zoom and compact widths are real renderer checks, separate from backend tests.
    await view('catalog');await window.webContents.setZoomFactor(1.25);await pause(250);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);await shot('zoom-125');await window.webContents.setZoomFactor(1);
    window.setContentSize(1100,800);await pause(250);await shot('compact-desktop-catalog');
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);
    await config('drawing');assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);await shot('compact-desktop-config');
    await config('voice');await click('#tab-resources');await waitFor('桌面窄窗口资源页',()=>js(`Boolean(document.querySelector('#resource-plan-preview'))`));assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);await shot('compact-desktop-resources');
    await click('#resource-plan-preview');await waitFor('桌面窄窗口确认页',()=>js(`document.querySelector('#installation-confirm')?.open===true`));assert.equal(await js(`document.querySelector('#installation-confirm').scrollWidth<=document.querySelector('#installation-confirm').clientWidth`),true);await shot('compact-desktop-resource-confirmation');await click('#cancel-resource-confirm');
    window.setContentSize(1380,900);await pause(200);await view('home');
    await click('#activity-toggle');assert.equal(await js(`document.activeElement.id`),'close-activity');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);assert.equal(await js(`document.activeElement.id`),'activity-toggle');
    await config('drawing');await js(`document.querySelector('#tab-overview').focus();document.querySelector('#tab-overview').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));void 0`);
    assert.equal(await js(`document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab`),'records');
    checks.push('125% 缩放与 1100px 桌面窗口无横向溢出；抽屉焦点和标签页键盘操作可用');
    assert.deepEqual(errors,[]);
    writeFileSync(join(qaDir,'result.json'),JSON.stringify({ok:true,checks,errors,network:{requestCount:requests.length,externalRequests,sockets},downloads:downloads.map(d=>({filename:d.path.split(/[\\/]/).at(-1),result:d.result})),moduleCount:(await state()).modules.length,installerUiFixtureUsed:true,realBusinessTasksExecuted:false,realResourceDownloads:false},null,2),'utf8');
    await view('home');await shot('final');
  } catch(error) {
    const ui=await js(`({focused:document.hasFocus(),active:document.activeElement?.outerHTML,tooltip:document.querySelector('#help-tooltip')?.outerHTML})`).catch(()=>null);
    writeFileSync(join(qaDir,'failure.json'),JSON.stringify({ok:false,checks,errors,error:error.stack,ui},null,2),'utf8');
    await shot('failure').catch(()=>{});throw error;
  } finally {window.webContents.session.webRequest.onBeforeRequest(null);if(window.webContents.debugger.isAttached())window.webContents.debugger.detach();}
}

async function testResourceView({js,click,text,waitFor,shot}) {
  await click('#tab-config');
  await waitFor('生产配置页完成切换',()=>js(`Boolean(document.querySelector('#module-config-form'))`));
  // UI-only fixture; production catalogs do not include these files or an executable adapter.
  await js(`(async()=>{
    const {mountInstallation}=await import('/installation-view.js');
    const f=window.__resourceFixture={optionalIds:[],task:null,confirmations:0,installed:false,stale:true};
    const resources=()=>[
      {id:'qa-runtime',name:'流程测试前置',required:true,version:'1.0',status:f.installed?'installed':'available',sourceLabel:'隔离界面测试',downloadBytes:1048576,installedBytes:2097152},
      {id:'qa-model',name:'流程测试可选文件',required:false,version:'1.0',status:f.installed?'installed':'available',sourceLabel:'隔离界面测试',downloadBytes:2097152,installedBytes:3145728}
    ];
    const state=()=>({moduleId:'drawing',directory:${JSON.stringify('E:\\流程测试\\资源')},resources:resources(),prerequisitesReady:f.installed,optionalIds:f.optionalIds,task:f.task});
    const api=async(path,{method,body}={})=>{
      if(path.endsWith('/selection')){f.optionalIds=body.optionalIds;return state();}
      if(path.endsWith('/plan')){const selected=resources().filter(r=>r.required||body.optionalIds.includes(r.id));return {moduleId:'drawing',planId:'ui-fixture',directory:state().directory,resources:selected,downloadBytes:selected.reduce((s,r)=>s+r.downloadBytes,0),installedBytes:selected.reduce((s,r)=>s+r.installedBytes,0),unknownSizeCount:0,canInstall:true,reasons:[]};}
      if(path.endsWith('/install')){f.confirmations++;if(f.stale){f.stale=false;throw new Error('安装清单已变化');}f.task={id:'qa-task',moduleId:'drawing',status:'running',stage:'测试适配器正在运行',completedBytes:1048576,totalBytes:3145728,currentResourceId:'qa-runtime',at:new Date().toISOString()};return {task:f.task};}
      if(path.endsWith('/cancel')){f.task={...f.task,status:'cancelled',stage:'已取消'};return {task:f.task};}
      return state();
    };
    const ui={};
    window.__mountResourceFixture=()=>{window.__resourceFixtureController?.abort();window.__resourceFixtureController=new AbortController();mountInstallation(document.querySelector('#module-panel'),{api,ui,signal:window.__resourceFixtureController.signal,refresh:async()=>{}},'drawing');};
    // Remove the production view before using the isolated renderer fixture.
    window.__mountResourceFixture();
  })()`);
  await waitFor('可选资源测试夹具',()=>js(`Boolean(document.querySelector('[data-optional-resource="qa-model"]'))`));
  assert.equal(await js(`document.querySelector('[data-optional-resource]').checked`),false);
  await click('[data-optional-resource]');
  await waitFor('可选文件选择保存',()=>js(`window.__resourceFixture.optionalIds.includes('qa-model')&&!document.querySelector('#resource-plan-preview').disabled`));
  assert.equal(await text('#resource-download-total'),'3 MiB');
  assert.equal(await text('#resource-space-total'),'5 MiB');
  await js('window.__mountResourceFixture();void 0');
  await waitFor('返回资源页保留选择',()=>js(`document.querySelector('[data-optional-resource]')?.checked===true`));
  await shot('resources-optional-ui-fixture');
  await click('#resource-plan-preview');await waitFor('可执行清单确认',()=>js(`document.querySelector('#installation-confirm')?.open===true`));
  assert.equal(await js('window.__resourceFixture.confirmations'),0);
  await click('#confirm-resource-install');
  await waitFor('过期清单明确报错',async()=> (await text('#installation-confirm-error')).includes('清单已变化'));
  assert.equal(await js('window.__resourceFixture.task'),null);
  await click('#cancel-resource-confirm');await click('#resource-plan-preview');
  await waitFor('重新确认清单',()=>js(`document.querySelector('#installation-confirm')?.open===true`));
  await click('#confirm-resource-install');
  await waitFor('任务进度显示',()=>js(`document.querySelector('#resource-task progress')?.value===1048576`));
  await js('window.__mountResourceFixture();void 0');
  await waitFor('返回页面恢复安装进度',()=>js(`document.querySelector('#resource-task progress')?.value===1048576`));
  await shot('resources-progress-ui-fixture');
  assert.equal(await js(`document.querySelector('#resource-plan-preview').disabled`),true);
  await click('#cancel-resource-task');
  await waitFor('取消反馈',async()=> (await text('#resource-task')).includes('已取消'));
  assert.equal(await js(`document.querySelector('#resource-plan-preview').disabled`),false);
  await js('window.__resourceFixtureController.abort();delete window.__resourceFixture;delete window.__mountResourceFixture;void 0');
  await click('#tab-overview');
  await waitFor('恢复生产模块页面',()=>js(`Boolean(document.querySelector('#go-config'))`));
}
