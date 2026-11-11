import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

async function run(kind='main'){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.AI_FUTURE_MEDIA_UI_DIR,'profile'));
  app.on('window-all-closed',()=>{});await app.whenReady();
  const localRequests=[];
  const local=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'declared-vision',input_modalities:['text','image']}]}));
    let body='';for await(const part of req)body+=part;
    const value=JSON.parse(body);localRequests.push({value,key:req.headers.authorization});
    if(value.model==='unavailable'){res.statusCode=503;return res.end('{"error":"fixture unavailable"}');}
    res.end(JSON.stringify({choices:[{message:{content:'一张测试图片'}}]}));
  });
  await new Promise(done=>local.listen(0,'127.0.0.1',done));
  const baseUrl=`http://127.0.0.1:${local.address().port}/v1`;
  const backend=await createWorkbench({dataDir:join(process.env.AI_FUTURE_MEDIA_UI_DIR,'data')});
  const api=async(path,body)=>{const response=await fetch(backend.url+path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const character=(await api('/api/characters',{name:'青禾',description:'识图界面测试角色'})).character;
  const path='/api/characters/'+character.id+'/life';
  for(const id of ['character-lite','character-full']){
    await api('/api/modules/'+id+'/enable',{});const base='/api/modules/'+id+'/resources',plan=await api(base+'/plan',{optionalIds:[]});
    if(plan.canInstall){await api(base+'/install',{optionalIds:[],planId:plan.planId});for(let attempt=0;attempt<100;attempt++){const state=await api(base);if(state.prerequisitesReady)break;assert.notEqual(state.task?.status,'failed');await new Promise(done=>setTimeout(done,20));}}
  }
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,source)=>{const end=Date.now()+9000;while(Date.now()<end){if(await js(source))return;await pause(30);}throw new Error('等待超时：'+label+' '+await js(`document.querySelector('[data-life-feedback]')?.textContent||''`));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const input=(name,value)=>js(`(()=>{const node=document.querySelector('[data-character-life] [name='+CSS.escape(${JSON.stringify(name)})+']');if(node.type==='checkbox')node.checked=${JSON.stringify(value)};else node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const value=name=>js(`document.querySelector('[data-character-life] [name='+CSS.escape(${JSON.stringify(name)})+']').${name.endsWith('Enabled')?'checked':'value'}`);
  const tab=async name=>{await click('[data-life-tab="'+name+'"]');await wait(name+'面板',`!!document.querySelector('[data-life-panel="${name}"]')`);};
  const save=async()=>{await click('[data-life-save]');await wait('媒体保存',`document.querySelector('[data-life-feedback]').textContent.startsWith('已保存')&&!document.querySelector('[data-life-save]').disabled`);};
  const capture=async name=>{const output=join(root,'artifacts','qq-media-ui-20261108');await mkdir(output,{recursive:true});await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await pause(80);await writeFile(join(output,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
  try{
    await window.loadURL(backend.url+'#/characters');await wait('角色列表加载',`!!document.querySelector('[data-character-life-id]')`);
    await js(`(async()=>{const {openCharacterLife}=await import('/character-life.js');const {Drafts}=await import('/drafts.js');window.mediaUI={openCharacterLife,drafts:new Drafts(),calls:[],delaySave:false,delayTest:false,failSave:false};const fixture=window.mediaUI;fixture.controller=new AbortController();fixture.ctx={signal:fixture.controller.signal,state:{selectedCharacterId:${JSON.stringify(character.id)},characters:[${JSON.stringify(character)}],modules:[]},drafts:fixture.drafts,refresh:async()=>{},fetch:async(url,options={})=>{fixture.calls.push({url,body:options.body});if(url.endsWith('/settings')&&fixture.failSave){fixture.failSave=false;return Response.json({error:'测试：保存暂时失败'},{status:503});}const response=await fetch(url,options);if(url.endsWith('/settings')&&fixture.delaySave){fixture.delaySave=false;await new Promise(done=>fixture.releaseSave=done);}if(url.includes('/vision/test')&&fixture.delayTest){fixture.delayTest=false;await new Promise((done,reject)=>{fixture.releaseTest=done;options.signal.addEventListener('abort',()=>{fixture.aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true});});}return response;}};fixture.open=(moduleId='qq')=>openCharacterLife(fixture.ctx,{moduleId});fixture.open();})()`);
    await wait('人设面板',`!!document.querySelector('[data-life-panel="profile"]')`);
    assert.equal(await js(`!!document.querySelector('[data-life-tab="media"]')`),true,'精简版应有独立识图与表情页签');
    assert.equal(await js(`document.querySelectorAll('[data-life-tab]:not([hidden])').length`),3);
    assert.equal(await js(`document.querySelector('[data-life-tab="tools"]').hidden`),true);
    await tab('media');await wait('QQ能力与表情目录',`document.querySelector('[data-life-native-status]')?.textContent.includes('未验证')&&document.querySelector('[data-life-meme-catalog]')?.textContent.includes('322')`);
    assert.match(await js(`document.querySelector('[data-life-panel="media"]').textContent`),/QQ 识图/);
    const catalog=await js(`document.querySelector('[data-life-meme-catalog]').textContent`);assert.match(catalog,/大肥鱼.*286/s);assert.match(catalog,/大肥鱼和GPT娘.*36/s);assert.match(catalog,/非商业/);
    assert.ok(await js(`document.querySelector('[data-life-meme-catalog] a[href="https://space.bilibili.com/103739"]')`));
    assert.ok(await js(`document.querySelector('[data-life-meme-catalog] a[href*="creativecommons.org/licenses/by-nc/4.0"]')`));
    if(kind!=='main'){
      await input('media.visionNative','unsupported');await input('media.localVisionEnabled',true);await input('media.localVisionBaseUrl',baseUrl);await input('media.localVisionModel','sample-vision');
      if(kind==='feedback-save'){
        await js('mediaUI.delayTest=true;mediaUI.releaseTest=null;void 0');await click('[data-life-test-vision]');await wait('旧测试等待响应',`!!mediaUI.releaseTest`);await save();const newer=await js(`document.querySelector('[data-life-feedback]').textContent`);await js('mediaUI.releaseTest();void 0');await wait('旧测试结束',`!document.querySelector('[data-life-test-vision]').disabled`);assert.equal(await js(`document.querySelector('[data-life-feedback]').textContent`),newer,'迟到的成功不能覆盖较新保存反馈');
      }else if(kind==='feedback-input'){
        await js(`(()=>{const previous=mediaUI.ctx.fetch;mediaUI.ctx.fetch=async(url,options)=>{const response=await previous(url,options);if(url.includes('/vision/test')){await new Promise(done=>mediaUI.releaseReject=done);throw new Error('old-network-test-failure');}return response;};})()`);await click('[data-life-test-vision]');await wait('旧失败等待响应',`!!mediaUI.releaseReject`);await input('media.localVisionModel','new-input-after-request');const newer=await js(`document.querySelector('[data-life-feedback]').textContent`);await js('mediaUI.releaseReject();void 0');await wait('旧失败结束',`!document.querySelector('[data-life-test-vision]').disabled`);assert.equal(await js(`document.querySelector('[data-life-feedback]').textContent`),newer,'迟到的错误不能覆盖较新输入反馈');
      }else if(kind==='feedback-current'){
        await click('[data-life-test-vision]');await wait('有效测试成功',`document.querySelector('[data-life-feedback]').textContent==='测试完成，设置尚未保存。'&&!document.querySelector('[data-life-test-vision]').disabled`);await js(`(()=>{const previous=mediaUI.ctx.fetch;mediaUI.ctx.fetch=async(url,options)=>{if(url.includes('/vision/test'))throw new Error('current-network-test-failure');return previous(url,options);};})()`);await click('[data-life-test-vision]');await wait('有效测试错误',`document.querySelector('[data-life-feedback]').textContent==='current-network-test-failure'&&!document.querySelector('[data-life-test-vision]').disabled`);
      }else if(kind==='status-queue'){
        await click('[data-life-close]');await js(`(()=>{const previous=mediaUI.ctx.fetch;mediaUI.statusRequests=0;mediaUI.ctx.fetch=async(url,options)=>{const response=await previous(url,options);if(url.includes('/vision/status')&&++mediaUI.statusRequests===1)await new Promise(done=>mediaUI.releaseStatus=done);return response;};mediaUI.open();})()`);await wait('新编辑器人设',`!!document.querySelector('[data-life-panel="profile"]')`);await tab('media');await wait('初始状态等待响应',`!!mediaUI.releaseStatus`);await js('mediaUI.delayTest=true;mediaUI.releaseTest=null;void 0');await click('[data-life-test-vision]');await wait('新测试等待响应',`!!mediaUI.releaseTest`);await tab('profile');await tab('media');await js('mediaUI.releaseTest();void 0');await wait('新测试证据已显示',`document.querySelector('[data-life-local-status]').textContent.includes('已通过样图')&&!document.querySelector('[data-life-test-vision]').disabled`);await js('mediaUI.releaseStatus();void 0');await pause(200);assert.equal(await js('mediaUI.statusRequests'),1,'旧初始加载的自动重载不能覆盖新测试');assert.match(await js(`document.querySelector('[data-life-local-status]').textContent`),/已通过样图/);
      }
      assert.deepEqual(errors,[]);console.log('QQ_MEDIA_UI_RESULT '+kind);return;
    }
    await capture('qq-media-lite-light-1440');
    await js(`document.querySelector('[data-life-meme-catalog]').scrollIntoView({block:'end'});void 0`);await capture('qq-media-catalog-light-1440');await js(`document.querySelector('.life-main').scrollTop=0;void 0`);
    await input('media.visionNative','unsupported');await wait('无识图能力明确提示',`document.querySelector('[data-life-native-status]').textContent.includes('当前模型无法读取图片')`);
    await input('media.localVisionEnabled',true);await input('media.localVisionBaseUrl',baseUrl);await input('media.localVisionModel','sample-vision');await input('media.localVisionKey','private-test-key');await input('media.publicMemesEnabled',true);
    const before=(await api(path)).settings.media;
    await click('[data-life-test-vision]');await wait('样图已测试',`document.querySelector('[data-life-local-status]').textContent.includes('样图')&&!document.querySelector('[data-life-test-vision]').disabled`);
    assert.deepEqual((await api(path)).settings.media,before,'测试草稿不应保存配置');
    assert.match(localRequests.at(-1).key,/private-test-key/);assert.match(JSON.stringify(localRequests.at(-1).value),/image_url/);
    assert.doesNotMatch(await js(`document.querySelector('[data-life-feedback]').textContent`),/^已保存/);
    await save();let saved=(await api(path)).settings.media;assert.equal(saved.localVisionModel,'sample-vision');assert.equal(saved.publicMemesEnabled,true);assert.ok(saved.localVisionKey);assert.equal(await value('media.localVisionKey'),'','成功保存后清除密钥明文');
    await click('[data-life-close]');await js('mediaUI.open();void 0');await wait('重开人设',`!!document.querySelector('[data-life-panel="profile"]')`);await tab('media');assert.equal(await value('media.localVisionModel'),'sample-vision');
    await input('media.localVisionModel','declared-vision');await click('[data-life-test-vision]');await wait('元数据不冒充样图测试',`document.querySelector('[data-life-local-status]').textContent.includes('模型资料声明')&&!document.querySelector('[data-life-test-vision]').disabled`);
    assert.doesNotMatch(await js(`document.querySelector('[data-life-local-status]').textContent`),/已通过样图/);
    await input('media.localVisionModel','unavailable');await click('[data-life-test-vision]');await wait('本机测试失败',`document.querySelector('[data-life-local-status]').textContent.includes('验证失败')&&!document.querySelector('[data-life-test-vision]').disabled`);assert.equal(await value('media.localVisionModel'),'unavailable');
    await js('mediaUI.failSave=true;void 0');await click('[data-life-save]');await wait('保存失败',`document.querySelector('[data-life-feedback]').textContent.includes('保存暂时失败')`);assert.equal(await value('media.localVisionModel'),'unavailable');
    await input('media.localVisionModel','saved-before-delay');await js('mediaUI.delaySave=true;void 0');await click('[data-life-save]');await wait('保存响应延迟',`!!mediaUI.releaseSave`);await input('media.localVisionModel','newer-draft');await js('mediaUI.releaseSave();void 0');await wait('保存响应结束',`!document.querySelector('[data-life-save]').disabled`);assert.equal(await value('media.localVisionModel'),'newer-draft','保存后不能吞掉在途新输入');assert.equal((await api(path)).settings.media.localVisionModel,'saved-before-delay');
    await save();await input('media.localVisionKey','');await save();assert.ok((await api(path)).settings.media.localVisionKey,'空密钥保留');
    await input('media.clearLocalVisionKey',true);await save();assert.equal((await api(path)).settings.media.localVisionKey,'');assert.equal(await js(`document.querySelector('[name="media.clearLocalVisionKey"]').checked`),false);
    await input('media.localVisionModel','mode-switch-draft');await click('[data-life-mode="full"]');await wait('完整版切换',`document.querySelector('[data-life-mode="full"]').getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-life-save]').disabled`);assert.equal(await value('media.localVisionModel'),'mode-switch-draft');assert.equal(await js(`document.querySelectorAll('[data-life-tab]:not([hidden])').length`),8);
    await save();await tab('profile');await click('[data-life-save-shared-voice]');await wait('其他分区保存',`document.querySelector('[data-life-feedback]').textContent==='已保存'`);await tab('tools');await click('[data-life-save-media]');await wait('工具保存',`document.querySelector('[data-life-feedback]').textContent==='已保存'`);assert.equal((await api(path)).settings.media.localVisionModel,'mode-switch-draft');assert.equal((await api(path)).settings.media.publicMemesEnabled,true);
    await tab('media');await input('media.visionNative','auto');await wait('自动判断不沿用手动不支持结论',`document.querySelector('[data-life-native-status]').textContent.includes('未验证')`);await input('media.visionNative','supported');await wait('原生支持时隐藏辅助',`document.querySelector('[data-life-native-status]').textContent.includes('支持读取图片')&&document.querySelector('[data-life-local-vision]').hidden`);await input('media.visionNative','unsupported');
    await js(`document.documentElement.dataset.theme='dark';void 0`);await capture('qq-media-full-dark-1440');
    window.setSize(1100,900);await js(`document.documentElement.dataset.theme='light';void 0`);await capture('qq-media-full-light-1100');
    assert.equal(await js(`(()=>{const p=document.querySelector('[data-life-panel="media"]');return p.scrollWidth<=p.clientWidth+1})()`),true,'1100桌面无横向溢出');
    await js(`document.documentElement.dataset.theme='dark';void 0`);await capture('qq-media-full-dark-1100');
    await input('media.localVisionModel','stale-test');await js('mediaUI.delayTest=true;void 0');await click('[data-life-test-vision]');await wait('测试响应延迟',`!!mediaUI.releaseTest`);await input('media.localVisionModel','typed-during-test');await js('mediaUI.releaseTest();void 0');await wait('过期测试结束',`!document.querySelector('[data-life-test-vision]').disabled`);assert.equal(await value('media.localVisionModel'),'typed-during-test');assert.match(await js(`document.querySelector('[data-life-local-status]').textContent`),/未验证|已修改/);
    await js('mediaUI.releaseTest=null;mediaUI.delayTest=true;void 0');await click('[data-life-test-vision]');await wait('关闭前测试在途',`!!mediaUI.releaseTest`);await click('[data-life-close]');await wait('关闭取消请求',`mediaUI.aborted===true`);assert.equal(await js(`!!document.querySelector('[data-character-life]')`),false);
    await js(`(()=>{const previous=mediaUI.ctx.fetch;mediaUI.ctx.fetch=async(url,options)=>{const response=await previous(url,options);if(url.includes('/vision/status')){await new Promise(done=>mediaUI.releaseStatus=done);mediaUI.statusReleased=true;}return response;};mediaUI.open('companion-lite');})()`);await wait('强制精简人设',`!!document.querySelector('[data-life-panel="profile"]')`);await tab('media');assert.equal(await js(`document.querySelectorAll('[data-life-tab]:not([hidden])').length`),3);assert.equal(await js(`document.querySelector('[data-life-tab="tools"]').hidden`),true);
    await wait('状态请求延迟',`!!mediaUI.releaseStatus`);await input('media.localVisionModel','sample-after-status');await click('[data-life-test-vision]');await wait('较新测试完成',`document.querySelector('[data-life-local-status]').textContent.includes('已通过样图')&&!document.querySelector('[data-life-test-vision]').disabled`);await js('mediaUI.releaseStatus();void 0');await wait('旧状态已返回',`mediaUI.statusReleased===true`);await pause(50);assert.match(await js(`document.querySelector('[data-life-local-status]').textContent`),/已通过样图/,'迟到的初始状态不能覆盖较新测试结果');
    assert.deepEqual(errors,[]);console.log('QQ_MEDIA_UI_RESULT '+JSON.stringify({screenshots:5,localImageRequests:localRequests.length}));
  }finally{window.destroy();await backend.close();local.closeAllConnections();await new Promise(done=>local.close(done));}
}

if(process.argv.includes('--qq-media-ui-electron'))run(process.argv.at(-1)).then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else for(const [kind,name] of Object.entries({main:'QQ识图与表情：独立页、真实后端保存与草稿测试、密钥、过期响应、桌面布局','feedback-save':'QQ媒体反馈：旧测试成功不覆盖较新保存反馈','feedback-input':'QQ媒体反馈：旧网络失败不覆盖较新输入反馈','feedback-current':'QQ媒体反馈：有效测试仍显示成功与错误','status-queue':'QQ媒体状态：切页积累的旧自动重载不覆盖较新测试'}))test(name,{skip:!electron,timeout:80000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qq-media-ui-'));const env={...process.env,AI_FUTURE_MEDIA_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--qq-media-ui-electron',kind],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(done=>child.once('exit',done));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/QQ_MEDIA_UI_RESULT/);
});
