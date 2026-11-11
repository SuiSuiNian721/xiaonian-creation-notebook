import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';
import {characterPackageAdapter} from '../framework/character-packages.mjs';
import {existingComponentCandidates} from '../framework/optional-components.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  const directory=process.env.AI_FUTURE_GUIDE_TEST_DIR;
  assert.ok(directory,'测试使用独立临时目录');
  app.setPath('userData',join(directory,'profile'));
  app.on('window-all-closed',()=>{});await app.whenReady();
  // 正常添加会自动准备规则；写入失败时仍需验证原有安装恢复页的引导。
  // MC 安装页验收不能依赖开发机是否已经准备好运行组件；训练页仍使用现有内核。
  const backend=await createWorkbench({dataDir:join(directory,'data'),componentOptions:{candidates:{...existingComponentCandidates(),'mc-play':[]}},installationAdapters:{'local-character-policy':{
    ...characterPackageAdapter,
    async install(context){if(context.resource.id==='companion-lite')throw new Error('验收：内置规则暂时不可写');await characterPackageAdapter.install(context);},
  }}});
  const api=async(path,body)=>{const response=await fetch(backend.url+path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});assert.equal(response.status,200);return response.json();};
  const ids=['drawing','cards','training','comfyui','voice','voice-design','companion-lite','qq','mc-skin','mc-play'];
  for(const id of ids)await api('/api/modules/'+id+'/enable',{});
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
  let companionResourceRequests=0,resumeCompanionResources;
  window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
    if(new URL(details.url).pathname.endsWith('/api/modules/companion-lite/resources')&&++companionResourceRequests===2){
      // Keep the installation list loading until its guide has anchored to the placeholder.
      resumeCompanionResources=()=>{resumeCompanionResources=null;callback({});};return;
    }
    callback({});
  });
  const errors=[];
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=async source=>{try{return await window.webContents.executeJavaScript(`{const document=new Proxy(window.document,{get(target,key){if(key==='querySelector')return selector=>target.querySelector('.instance-panel:not([hidden])')?.querySelector(selector)||target.querySelector(selector);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});${source}}`);}catch(error){throw new Error(error.message+'\n'+source+'\n'+errors.join('\n'));}};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(label,source)=>{const end=Date.now()+15000;while(Date.now()<end){if(await js(source))return;await pause(40);}throw new Error('等待超时：'+label+' '+errors.join('\n')+' '+await js(`JSON.stringify({tour:document.querySelector('[data-module-tour]:popover-open')?.textContent,scroll:scrollY,targets:[...document.querySelectorAll('#resource-plan-preview')].map(n=>({visible:n.checkVisibility(),rect:n.getBoundingClientRect().toJSON(),parent:n.closest('[data-instance-id]')?.dataset.instanceId})),panel:document.querySelector('.instance-panel:not([hidden])')?.innerText.slice(0,700)})`));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const tour='[data-module-tour]:popover-open';
  const manual='[data-module-manual][open]';
  const open=async id=>{await js(`location.hash='/module/${id}';void 0`);await wait(id+' 使用说明',`document.querySelector('[data-module-help="${id}"]')`);};
  const visibleBox=selector=>js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,viewport:[innerWidth,innerHeight]};})()`);
  const checks=[];
  const capture=async name=>{
    const output=process.env.AI_FUTURE_GUIDE_UI_OUTPUT;
    if(output){
      mkdirSync(output,{recursive:true});window.webContents.invalidate();
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await pause(180);
      writeFileSync(join(output,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    }
  };
  try{
    await window.loadURL(backend.url+'#/module/drawing');
    await wait('首次自动引导',`document.querySelector('${tour}')`);
    assert.ok(await js(`document.activeElement.matches('[data-tour-next]')`));
    const help=await visibleBox('[data-module-help="drawing"]'),ai=await visibleBox('[data-module-ai-control="drawing"]');
    assert.ok(help.right<=ai.x,'使用说明必须位于 AI 接入左侧');
    await wait('首次引导记录',`fetch('/instances/'+document.querySelector('.instance-panel:not([hidden])').dataset.instanceId+'/api/state').then(r=>r.json()).then(s=>s.moduleGuides?.drawing===true)`);
    await capture('drawing-tour-light');
    await click('[data-tour-next]');assert.equal(await js(`document.querySelector('${tour}').dataset.step`),'1');
    await click('[data-tour-back]');assert.equal(await js(`document.querySelector('${tour}').dataset.step`),'0');
    await click('[data-tour-skip]');
    await open('voice');await wait('另一个模块首次引导',`document.querySelector('${tour}')`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
    await wait('Esc 关闭',`!document.querySelector('${tour}')`);
    await open('drawing');await pause(100);assert.equal(await js(`!!document.querySelector('${tour}')`),false);
    await window.reload();await wait('重载完成',`document.querySelector('[data-module-help="drawing"]')`);
    assert.equal(await js(`!!document.querySelector('${tour}')`),false);
    checks.push('首次自动、按模块记忆、跳过、Esc、上一步、刷新不重复');

    await click('[data-module-help="drawing"]');await wait('使用说明',`document.querySelector('${manual}')`);
    assert.ok(await js(`document.querySelector('${manual}').textContent.includes('开始引导')`));
    await capture('drawing-manual-light');
    await click('[data-start-tour]');await wait('手动重播',`document.querySelector('${tour}')`);
    await js(`document.documentElement.dataset.theme='dark';void 0`);await capture('drawing-tour-dark');
    window.setSize(1100,800);
    await pause(120);
    const rect=await visibleBox('[data-tour-card]');assert.ok(rect.x>=0&&rect.y>=0&&rect.right<=rect.viewport[0]&&rect.bottom<=rect.viewport[1],JSON.stringify(rect));
    await capture('drawing-tour-1100');
    await click('[data-tour-skip]');
    window.setSize(1440,1000);await js(`document.documentElement.dataset.theme='light';void 0`);
    checks.push('说明入口、手动重播、两种主题与桌面窗口边界');

    for(const id of ids){
      await open(id);
      if(!await js(`!!document.querySelector('${tour}')`)){await click('[data-module-help="'+id+'"]');await click('[data-start-tour]');}
      await wait(id+' 引导',`document.querySelector('${tour}')`);
      if(id==='mc-play'){
        assert.equal(await js("document.querySelector('[data-component-installation]')?.dataset.componentInstallation"),'mc-play');
        assert.equal(await js("document.querySelector('[data-tour-title]').textContent"),'先准备运行组件');
        assert.equal(await js("!!document.querySelector('#mc-connect')"),false,'尚未安装时引导组件准备，不显示不可用的游戏连接表单');
      }
      if(id==='companion-lite'){
        await wait('资源清单加载中的引导目标',`document.querySelector('[data-tour-spotlight]')?.dataset.target==='[data-package-installation]'`);
        assert.equal(typeof resumeCompanionResources,'function');resumeCompanionResources();
        await wait('资源加载后滚动定位安装按钮',`document.querySelector('[data-tour-spotlight]')?.dataset.target==='#resource-plan-preview'`);
        checks.push('资源清单延迟加载后，引导自动滚动到实际安装按钮');
      }
      for(let step=0;step<8;step++){
        await wait(id+' 当前高亮位置',`document.querySelector('[data-tour-spotlight]')?.dataset.target`);
        assert.equal(await js(`document.querySelector('[data-tour-unavailable]').hidden`),true,id+' 有真实可见的目标');
        const last=await js(`document.querySelector('[data-tour-next]').textContent==='完成'`);
        await click('[data-tour-next]');
        if(last)break;
        assert.ok(step<6,id+' 引导不宜超过七步');
      }
      assert.equal(await js(`!!document.querySelector('${tour}')`),false,id+' 完成后关闭');
      if(id==='voice'){
        await click('[data-module-help="voice"]');
        const text=await js(`document.querySelector('${manual}').textContent`);
        assert.match(text,/生成声音/);assert.match(text,/用于当前角色/);
        assert.doesNotMatch(text,/尚未提供语音合成|外部服务中完成|声线管理、语音生成和声音克隆还在接入中/);
        await click('[data-manual-close]');
      }
      await click('[data-module-ai-control="'+id+'"]');
      await wait(id+' AI 接入读取完成',`!!document.querySelector('[data-ai-editor] form,[data-ai-editor] .form-feedback.error')`);
      assert.equal(await js(`document.querySelector('[data-ai-editor] .form-feedback.error')?.textContent||''`),'',id+' AI 接入可读取模块接口');
      assert.ok(await js(`!!document.querySelector('[data-ai-editor] form')`),id+' AI 接入表单可用');
      await click('[data-ai-close]');
    }
    checks.push('九个模块的实例 AI 接入弹层均能读取并显示表单');
    checks.push('九个实际模块逐步高亮有效、可选组件安装阶段引导、最后完成关闭');
    await open('training');await click('[data-module-help="training"]');await click('[data-start-tour]');
    await click('#tab-config');
    await wait('切到配置后定位实际环境入口',`document.querySelector('[data-tour-spotlight]').dataset.target==='#config-trainerPath'`);
    await js(`document.querySelector('#config-trainerPath').value='E:\\\\未保存的训练器路径';document.querySelector('#config-trainerPath').dispatchEvent(new Event('input',{bubbles:true}));void 0`);
    await click('[data-tour-skip]');
    assert.equal(await js(`document.querySelector('#config-trainerPath').value`),'E:\\未保存的训练器路径');
    await open('drawing');await click('[data-module-help="drawing"]');await click('[data-start-tour]');
    await click('#tab-workflows');
    await js(`for(let i=0;i<7;i++){if(document.querySelector('[data-tour-title]').textContent==='准备工作流')break;document.querySelector('[data-tour-next]').click();}void 0`);
    await wait('工作流页签定位导入入口',`document.querySelector('[data-tour-spotlight]').dataset.target==='#import-workflow'`);
    await js(`for(const selector of ['#import-workflow','#manage-workflows','#tab-workflows'])document.querySelector(selector)?.setAttribute('hidden','');void 0`);
    await wait('目标消失时仍可继续',`!document.querySelector('[data-tour-unavailable]').hidden`);
    await click('[data-tour-next]');
    assert.equal(await js(`document.querySelector('${tour}').dataset.step`),'3');
    await click('[data-tour-skip]');
    checks.push('引导中实际换页签重新定位、未保存表单保持、目标消失可继续');
    await open('qq');await click('[data-module-help="qq"]');await click('[data-start-tour]');
    await click('#qq-external-options summary');await pause(80);
    assert.equal(await js(`!!document.querySelector('${tour}')`),true,'展开普通折叠区不应结束引导');
    await click('[data-tour-skip]');
    const qqId=(await api('/api/instances')).instances.find(item=>item.moduleId==='qq').id;
    const qq=await api('/instances/'+qqId+'/api/modules/qq/state');assert.equal(qq.paused,true);
    assert.equal(qq.runtime.running,false);
    const mcId=(await api('/api/instances')).instances.find(item=>item.moduleId==='mc-play').id;
    const mc=await api('/instances/'+mcId+'/api/modules/mc-play/state');
    assert.equal(mc.connection.workerActive,false,'组件安装页引导与 AI 设置不启动 MC worker');
    checks.push('引导没有启动 QQ 或开启回复');

    await open('drawing');await click('[data-module-help="drawing"]');await click('[data-start-tour]');
    await open('cards');assert.equal(await js(`!!document.querySelector('${tour}')`),false,'导航清理旧引导');
    await click('[data-module-help="cards"]');
    await click('[data-manual-close]');
    assert.ok(await js(`document.activeElement.matches('[data-module-help="cards"]')`),'关闭后恢复入口焦点');
    assert.equal(await js(`document.documentElement.hasAttribute('data-module-help-open')`),false);
    checks.push('导航清理浮层、关闭恢复焦点');
    assert.deepEqual(errors,[]);
    console.log('MODULE_HELP_UI_RESULT '+JSON.stringify(checks));
  }finally{
    resumeCompanionResources?.();
    window.destroy();await backend.close();
  }
}

if(process.argv.includes('--module-help-electron')){
  run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
}else{
  test('模块使用说明与引导：实际十模块 Electron 操作、首次记录、重播和窗口定位',{skip:!electron,timeout:110000},async t=>{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const directory=await mkdtemp(join(tmpdir(),'workbench-guides-'));env.AI_FUTURE_GUIDE_TEST_DIR=directory;
    const child=spawn(electron,[fileURLToPath(import.meta.url),'--module-help-electron'],{cwd:root,env,windowsHide:true});
    t.after(async()=>{
      if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
      assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    });
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(code,0,output);assert.ok(output.includes('MODULE_HELP_UI_RESULT'),output);
  });
}
