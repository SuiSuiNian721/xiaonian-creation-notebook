import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
import {newCharacter} from '../framework/contracts.mjs';

const {app,BrowserWindow}=createRequire('F:\\小汐的研究日志\\package.json')('electron');
const real=process.env.AI_FUTURE_VOICE_REAL==='1';
const directory=resolve(process.env.AI_FUTURE_VOICE_STUDIO_QA_DIR||join('qa','voice-studio-'+Date.now()));
app.disableHardwareAcceleration();app.setPath('userData',join(directory,'electron'));
app.on('window-all-closed',()=>{});

function sample(){const data=Buffer.alloc(3*48000+44);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(24000,24);data.writeUInt32LE(48000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);for(let i=44;i<data.length;i+=2)data.writeInt16LE(Math.round(Math.sin(i/18)*4000),i);return data;}
async function run(){
  await mkdir(directory,{recursive:true});const screenshots=join(directory,'screenshots');await mkdir(screenshots,{recursive:true});
  let sourceReference='',hold=false,release,started,delayDetect=false,detectStarted,releaseDetect;
  const paths={pythonPath:process.execPath,generatorPath:directory,clonePath:directory,codecPath:directory};let prepared=false,installTask=null;
  const resources={initialized:Promise.resolve(),state:()=>({config:prepared?paths:{},components:['runtime','generator','clone','codec'].map(id=>({id,name:id,installed:prepared,downloadBytes:100*1024*1024})),task:installTask}),
    detect:async()=>{if(delayDetect){detectStarted?.();await new Promise(done=>{releaseDetect=done;});}prepared=true;return resources.state();},install:()=>{installTask={status:'running',stage:'downloading',completedBytes:50*1024*1024,totalBytes:100*1024*1024};return resources.state();},cancel:async()=>{installTask={...installTask,status:'cancelled',stage:'cancelled'};},configure:async()=>{},close:async()=>{}};
  const worker=async request=>{if(hold){started?.();await new Promise(done=>{release=done;});}await writeFile(request.output,sample());if(request.referenceOutput)await writeFile(request.referenceOutput,sample());};
  const backend=await createWorkbench({dataDir:join(directory,'profile'),choosePath:async()=>sourceReference,voiceStudioOptions:real?{}:{resources,runWorker:worker}});
  const store=backend.context.store;for(const id of ['voice-design','voice']){store.setEnabled(id,true);store.setSetting('moduleGuides',{...store.getSetting('moduleGuides'),[id]:true});}
  const character=store.saveCharacter(newCharacter({name:'声音验收角色',description:'独立测试角色'}));store.selectCharacter(character.id);
  if(real){
    console.log('校验并复用已有声音环境');const resources=backend.context.voiceResources;await resources.detect();const found=resources.state().discovery.result;
    const config={pythonPath:found.environments.find(item=>item.provider==='moss'&&item.status==='available')?.path};
    for(const kind of ['generator','clone','codec'])config[kind+'Path']=found.models.find(item=>item.provider==='moss'&&item.kind===kind&&item.status==='available')?.path;
    assert.ok(Object.values(config).every(Boolean),'本机检索需找到完整 MOSS 环境与模型');await resources.configure(config);
    assert.ok(resources.state().components.every(item=>item.installed));
  }
  const window=new BrowserWindow({show:false,width:1440,height:1080,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});window.webContents.setAudioMuted(true);
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=code=>window.webContents.executeJavaScript(`{const document=new Proxy(window.document,{get(target,key){if(key==='querySelector')return selector=>target.querySelector('.instance-panel:not([hidden])')?.querySelector(selector)||target.querySelector(selector);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});${code}}`,true),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,check,timeout=15000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await pause(80);}throw new Error('等待超时：'+label);};
  const fill=async values=>js(`(()=>{for(const [selector,value] of Object.entries(${JSON.stringify(values)})){const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const submit=selector=>js(`document.querySelector(${JSON.stringify(selector)}).requestSubmit();void 0`);
  const screenshot=async name=>{await pause(200);const path=join(screenshots,name+'.png');await writeFile(path,(await window.webContents.capturePage()).toPNG());return path;};
  const report={ok:false,realInference:real,mutedPlayback:true,screenshots:[],errors};
  try{
    await window.loadURL(backend.url+'/#/module/voice-design');await wait('声音生成模块',()=>js("!!document.querySelector('[data-studio-form]')"));
    await wait('声音生成帮助就绪',()=>js("!!document.querySelector('[data-module-help=voice-design]')"));await js("document.querySelector('[data-tour-skip]')?.click();void 0");
    assert.equal(await js("document.querySelector('.module-heading h1').textContent"),'声音');assert.equal(await js("document.querySelector('#studio-reference')===null"),true,'从0生成不要求参考录音');
    if(!real){
      await fill({'#studio-instruction':'温和清亮、自然轻快的普通话声音。','#studio-text':'念念，今天也想和你分享一点温暖。'});await submit('[data-studio-form]');
      await wait('缺环境提示',()=>js("document.querySelector('[data-studio-feedback]').textContent.includes('声音组件')"));
      report.screenshots.push(await screenshot('声音生成_空环境_1440'));
      delayDetect=true;const detecting=new Promise(done=>{detectStarted=done;});await click('[data-studio-detect]');await detecting;
      await js("document.querySelector('.voice-advanced').open=true;void 0");await fill({'#studio-pythonPath':'E:\\声音草稿\\新的-python.exe'});releaseDetect();delayDetect=false;
      await wait('检测完成',()=>js("document.querySelector('[data-studio-resource-feedback]').textContent==='检测完成'"));
      assert.equal(await js("document.querySelector('#studio-pythonPath').value"),'E:\\声音草稿\\新的-python.exe','迟到检测结果不得覆盖新配置草稿');
      await js("document.querySelector('.voice-advanced').open=false;document.querySelector('[data-studio-components]').open=false;void 0");
    }
    await fill({'#studio-instruction':'年轻女性普通话声音，清亮柔和，轻松自然，带浅浅笑意。','#studio-text':'念念，窗外的阳光很好，我们一起出去走走吧。','#studio-seed':'90321','#studio-count':'2'});
    console.log('开始声音设计'+(real?'：真实 MOSS 推理':''));await submit('[data-studio-form]');
    await wait('声音设计完成',()=>js("!document.querySelector('[data-studio-player]').hidden"),real?950000:15000);
    await wait('完整 WAV 解码',()=>js("Number.isFinite(document.querySelector('[data-studio-player]').duration)&&document.querySelector('[data-studio-player]').duration>0"));
    await js("document.querySelector('[data-studio-player]').play();void 0");await wait('播放器推进',()=>js("document.querySelector('[data-studio-player]').currentTime>0.15"));await js("document.querySelector('[data-studio-player]').pause();void 0");
    const designed=backend.context.voiceStudio.state().job;report.design={id:designed.id,status:designed.status,audio:designed.result};
    const candidates=backend.context.voiceStudio.state().candidates;assert.equal(candidates.length,2);assert.deepEqual(candidates.map(item=>item.seed),[90321,90322]);
    assert.equal(await js("document.querySelectorAll('[data-studio-candidate]').length"),2);
    report.batch=candidates;report.screenshots.push(await screenshot('声音生成_批量候选_1440'));
    await js("document.documentElement.dataset.theme='dark';void 0");window.setSize(1280,1000);await pause(150);report.screenshots.push(await screenshot('声音生成_批量候选_深色1280'));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);await js("document.documentElement.dataset.theme='light';void 0");window.setSize(1440,1080);
    const first=candidates[0];await click(`[data-studio-candidate="${first.id}"]`);await click(`[data-studio-keep="${first.id}"]`);
    await wait('逐份保留',()=>js(`document.querySelector('[data-studio-keep="${first.id}"]').textContent==='已保留'`));
    const kept=backend.context.voiceStudio.voices()[0];
    await js('window.confirm=()=>false;void 0');await click(`[data-studio-discard="${first.id}"]`);assert.equal(backend.context.voiceStudio.state().candidates.length,2);
    await js('window.confirm=()=>true;void 0');await click(`[data-studio-discard="${first.id}"]`);
    await wait('逐份删除',()=>js("document.querySelectorAll('[data-studio-candidate]').length===1"));
    assert.equal(backend.context.voiceStudio.voices().some(item=>item.id===kept.id),true,'删除试听保留独立音色');
    assert.equal((await fetch(first.result.url)).status,404,'已删除试听缓存不能继续读取');
    await fill({'#studio-name':'生成测试音色'});await submit('[data-studio-save-form]');await wait('保存设计音色',()=>js("document.querySelector('#shared-voice').selectedOptions[0]?.textContent==='生成测试音色'"));
    await click('[data-voice-bind]');await wait('绑定当前角色',()=>js("document.querySelector('[data-voice-feedback]').textContent==='当前角色已使用此音色'"));
    const activeId=await js("document.querySelector('.instance-panel:not([hidden])').dataset.instanceId"),instanceStore=backend.context.instanceManager.runtimes.get(activeId).context.store;
    const life=await (await fetch(backend.url+'/instances/'+activeId+'/api/characters/'+instanceStore.state().selectedCharacterId+'/life')).json();assert.equal(life.settings.media.voiceMode,'requested');assert.equal(life.settings.media.voiceId,backend.context.voiceStudio.voices().find(item=>item.name==='生成测试音色').id);
    await fill({'#voice-text':'念念，我在这里。'});console.log('验证保存后的音色合成'+(real?'：真实 MOSS 克隆':''));await submit('[data-voice-form]');
    await wait('保存音色合成完成',()=>js("!document.querySelector('[data-voice-player]').hidden"),real?950000:15000);
    report.screenshots.push(await screenshot('声音生成_1440'));
    await click('[data-voice-use-reference]');await wait('合成声音可用于克隆',()=>js("!!document.querySelector('[data-studio-reference-audio]')&&!document.querySelector('[data-studio-reference-audio]').hidden"));
    assert.equal(await js("document.querySelector('#studio-transcript').value"),'念念，我在这里。');
    assert.equal(await js("document.querySelector('#studio-seed').value"),'90321','首次直达克隆补齐默认参数');
    sourceReference=join(directory,'profile','shared-voice','studio','jobs',designed.id,'preview.wav');
    await click('[data-voice-mode="clone"]');await wait('声音克隆页签',()=>js("!!document.querySelector('#studio-reference')"));
    await click('[data-path-field="referencePath"]');await wait('原生选择返回参考路径',()=>js("document.querySelector('#studio-reference').value.length>0"));
    assert.equal(await js("document.querySelector('[data-studio-reference-audio]').hidden"),true,'选择文件替换生成参考');
    await click('[data-voice-mode="design"]');await wait('回生成选择参考',()=>js("!!document.querySelector('#studio-instruction')"));
    await click('[data-studio-use-reference]');await wait('候选直接用于克隆',()=>js("!!document.querySelector('[data-studio-reference-audio]')&&!document.querySelector('[data-studio-reference-audio]').hidden"));
    assert.equal(await js("document.querySelector('#studio-transcript').value"),'念念，窗外的阳光很好，我们一起出去走走吧。');
    await fill({'#studio-text':'你好，念念。很高兴再次听见你的声音。'});console.log('开始参考录音克隆'+(real?'：真实 MOSS 推理':''));await submit('[data-studio-form]');
    await wait('克隆试听完成',async()=>backend.context.voiceStudio.state().job?.mode==='clone'&&backend.context.voiceStudio.state().job?.status==='completed'&&await js("!document.querySelector('[data-studio-player]').hidden&&document.querySelector('[data-studio-status]').textContent==='已完成'"),real?950000:15000);
    await fill({'#studio-name':'克隆测试音色'});await submit('[data-studio-save-form]');await wait('保存克隆音色',()=>js("document.querySelector('#shared-voice').selectedOptions[0]?.textContent==='克隆测试音色'"));
    report.clone=backend.context.voiceStudio.state().job;report.voices=backend.context.voiceStudio.voices();assert.deepEqual(report.voices.map(item=>item.source),['design','design','clone']);
    report.screenshots.push(await screenshot('声音克隆_1440'));window.setSize(1280,1000);await pause(150);report.screenshots.push(await screenshot('声音克隆_1280'));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'桌面不应横向溢出');
    await click('[data-voice-mode="design"]');await wait('生成页签同步音色库',()=>js("(()=>{const panel=window.document.querySelector('.instance-panel:not([hidden])');return !!panel?.querySelector('#studio-instruction')&&[...(panel?.querySelector('#shared-voice')?.options||[])].some(item=>item.textContent==='克隆测试音色');})()"));
    assert.equal(await js("document.querySelector('#studio-instruction').value"),'年轻女性普通话声音，清亮柔和，轻松自然，带浅浅笑意。','切回保留设计描述草稿');
    await click('[data-voice-mode="clone"]');await wait('回到克隆页签',()=>js("!!document.querySelector('#studio-reference')"));
    assert.equal(await js("document.querySelector('#studio-reference').value"),'','生成参考不必导出再选文件');
    assert.equal(await js("document.querySelector('[data-studio-reference-audio]').hidden"),false,'切回保留生成参考');
    assert.equal(await js("document.querySelector('#studio-name').value"),'克隆测试音色','切回保留音色名称');
    if(!real){
      hold=true;const ready=new Promise(done=>{started=done;});await submit('[data-studio-form]');await ready;
      await click('[data-voice-mode="design"]');await wait('生成中可切换页签',()=>js("!!document.querySelector('#studio-instruction')"));assert.equal(backend.context.voiceStudio.state().busy,true);
      await click('[data-voice-mode="clone"]');await wait('生成中切回克隆',()=>js("!!document.querySelector('#studio-reference')"));assert.equal(backend.context.voiceStudio.state().busy,true);
      await click('[data-studio-cancel]');release();hold=false;await wait('取消不交付',()=>js("document.querySelector('[data-studio-status]').textContent==='已取消'"));assert.equal(backend.context.voiceStudio.state().job.result,undefined);
      prepared=false;await wait('组件状态同步',()=>js("!document.querySelector('[data-studio-install=generator]').disabled"));await js("document.querySelector('[data-studio-components]').open=true;void 0");await click('[data-studio-install="generator"]');
      await wait('下载进度',()=>js("document.querySelector('[data-studio-install-progress]').value===52428800"));
      await js("document.querySelector('[data-studio-components]').scrollIntoView({block:'start',behavior:'instant'});void 0");await pause(100);report.screenshots.push(await screenshot('声音组件_下载中_1280'));
      await click('[data-studio-cancel-install]');await wait('下载已取消',()=>js("document.querySelector('[data-studio-install-status]').textContent.includes('已取消')"));
      assert.equal(await js("document.querySelector('[data-studio-install-progress]').value"),50*1024*1024,'取消后保留已下载进度，不继续显示不定进度动画');
      report.screenshots.push(await screenshot('声音组件_1280'));
    }
    const outputs=join(directory,'outputs');await mkdir(outputs,{recursive:true});report.outputFiles=[];
    for(const [name,result] of [['生成声音.wav',designed.result],['克隆声音.wav',report.clone.result]]){const response=await fetch(result.url);assert.equal(response.status,200);const path=join(outputs,name);await writeFile(path,Buffer.from(await response.arrayBuffer()));report.outputFiles.push(path);}
    assert.deepEqual(errors,[]);report.ok=true;
  }catch(error){report.error=error.stack;report.screenshots.push(await screenshot('失败现场'));console.error(error.stack);}
  finally{await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n','utf8');window.destroy();await backend.close();console.log(JSON.stringify({ok:report.ok,realInference:real,directory,error:report.error,errors}));app.exit(report.ok?0:1);}
}
app.whenReady().then(run).catch(error=>{console.error(error);app.exit(1);});
