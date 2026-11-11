import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {VOICE_PROVIDERS} from '../framework/voice-providers.mjs';

const {app,BrowserWindow}=createRequire('F:\\小汐的研究日志\\package.json')('electron');
const directory=resolve(process.env.AI_FUTURE_VOICE_PROVIDERS_QA_DIR||join('qa','voice-providers-'+Date.now()));
app.disableHardwareAcceleration();app.setPath('userData',join(directory,'electron'));app.on('window-all-closed',()=>{});
const wav=()=>{const bytes=Buffer.alloc(48044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE(Math.round(Math.sin(i/20)*5000),i);return bytes;};

async function run(){
  await mkdir(directory,{recursive:true});const screenshots=join(directory,'screenshots');await mkdir(screenshots,{recursive:true});
  let detections=0,commands=0,plan=null,compatible=false,discovery={attempted:false,status:'idle',result:null};
  const calls=[],config={provider:'moss',qwenPythonPath:process.execPath,qwenBasePath:directory,qwenDesignPath:directory,qwenCustomVoicePath:directory,searchRoots:[],httpUrl:'http://127.0.0.1:8899/v1/audio/speech',httpModel:'fixture',httpVoice:'speaker'};
  const resources={initialized:Promise.resolve(),state:()=>({config:{...config},providers:VOICE_PROVIDERS,discovery,bindings:Object.fromEntries(['qwenBasePath','qwenDesignPath','qwenCustomVoicePath'].map(field=>[field,{status:'available'}])),environments:[{provider:'qwen3-tts',path:process.execPath,status:compatible?'available':'incompatible',issues:['transformers 5 与所需 4.57.3 不兼容'],repairOptions:['repair-existing','create-isolated'].map(id=>({id,label:id==='repair-existing'?'修复原环境':'新建隔离环境',packages:{transformers:'4.57.3'}}))}],environmentPlan:plan,components:[],task:null}),
    detect:async value=>{if(!discovery.attempted||value.refresh){detections++;discovery={attempted:true,status:'completed',result:{models:[{provider:'qwen3-tts',kind:'base',path:directory,status:'available'}]}};}return resources.state();},configure:async values=>{Object.assign(config,values);return resources.state();},
    install:value=>{if(value.environmentMode)plan={id:'fixture-plan',provider:value.provider,mode:value.environmentMode,status:'prepared',target:join(directory,'new-qwen-env'),consequence:'执行会创建独立环境并安装依赖；原环境保留。',packages:['transformers==4.57.3'],commands:[{executable:process.execPath,args:['-m','venv','fixture-only']}]};else {assert.equal(value.planId,plan.id);commands++;plan.status='completed';compatible=true;}return resources.state();},cancel:async()=>{},close:async()=>{}};
  const backend=await createWorkbench({dataDir:join(directory,'profile'),voiceStudioOptions:{resources,runWorker:async request=>{calls.push(request);await writeFile(request.output,wav());if(request.referenceOutput)await writeFile(request.referenceOutput,wav());},fetchImpl:async()=>new Response(wav().subarray(44))}});
  for(const id of ['voice','voice-design']){backend.context.store.setEnabled(id,true);backend.context.store.setSetting('moduleGuides',{...backend.context.store.getSetting('moduleGuides'),[id]:true});}
  const character=backend.context.store.saveCharacter(newCharacter({name:'提供者测试角色',description:'fixture'}));backend.context.store.selectCharacter(character.id);
  const window=new BrowserWindow({show:false,width:1440,height:1080,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});window.webContents.setAudioMuted(true);
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=code=>window.webContents.executeJavaScript(`{const document=new Proxy(window.document,{get(target,key){if(key==='querySelector')return selector=>target.querySelector('.instance-panel:not([hidden])')?.querySelector(selector)||target.querySelector(selector);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});${code}}`,true),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,check)=>{const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await pause(60);}throw new Error('等待超时：'+label);};
  const set=async(selector,value)=>js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`),submit=selector=>js(`document.querySelector(${JSON.stringify(selector)}).requestSubmit();void 0`);
  const shot=async name=>{await pause(120);await writeFile(join(screenshots,name+'.png'),(await window.webContents.capturePage()).toPNG());};
  let success=false;
  try{
    await window.loadURL(backend.url+'/#/module/voice');await wait('首次发现与声音表单',async()=>detections===1&&await js("!!window.document.querySelector('.instance-panel:not([hidden])')?.querySelector('#studio-provider')"));await js("document.querySelector('[data-tour-skip]')?.click();void 0");
    await click('[data-voice-mode="clone"]');await wait('克隆操作',()=>js("!!document.querySelector('#studio-task')"));
    const originalInstance=await js("window.document.querySelector('.instance-panel:not([hidden])').dataset.instanceId");
    await set('#studio-provider','qwen3-tts');assert.equal(await js("document.querySelector('#studio-transcript').required"),true);
    await click('[data-studio-repair="create-isolated"]');await wait('环境计划',()=>js("!!document.querySelector('[data-studio-execute-plan]')"));assert.equal(commands,0);await js("document.querySelector('[data-studio-environment-plan]').scrollIntoView({block:'center',behavior:'instant'});void 0");await shot('Qwen环境计划_1440');
    await click('[data-studio-execute-plan]');await wait('计划执行',()=>commands===1);await set('#studio-task','synthesis');assert.equal(await js("document.querySelector('#studio-reference').required"),false);assert.equal(await js("document.querySelector('[data-studio-speaker]').hidden"),false);
    await set('#studio-text','念念，今天也想和你分享一点温暖。');await submit('[data-studio-form]');await wait('CustomVoice试听',()=>backend.context.voiceStudio.state().job?.status==='completed');await wait('试听显示完成',()=>js("!document.querySelector('[data-studio-player]').hidden"));assert.equal(calls[0].modelKind,'custom-voice');
    await set('#studio-name','Qwen预设');await submit('[data-studio-save-form]');await wait('保存音色',()=>backend.context.voiceStudio.voices().length===1);await wait('关联入口',()=>js("!document.querySelector('[data-studio-link-character]').hidden"));
    await click('[data-studio-link-character]');await wait('角色声音关联',()=>js("!!document.querySelector('dialog select[name=voiceId]')"));await js("document.querySelector('dialog form').requestSubmit();void 0");await wait('角色引用已保存',()=>js("document.querySelector('[data-studio-save-feedback]').textContent==='已关联到角色资料'"));
    await set('#studio-provider','http');assert.equal(await js("document.querySelector('#studio-provider').value"),'http');assert.equal(await js("document.querySelector('#studio-task').value"),'synthesis');assert.equal(await js("document.querySelector('#studio-task [value=clone]').disabled"),true);await js("document.querySelector('.voice-advanced').open=true;document.querySelector('#studio-httpUrl').scrollIntoView({block:'center',behavior:'instant'});void 0");await shot('HTTP声音配置_1440');
    await submit('[data-studio-form]');await wait('HTTP试听',()=>backend.context.voiceStudio.state().job?.provider==='http'&&backend.context.voiceStudio.state().job?.status==='completed');
    await click('[data-studio-detect]');await wait('手动刷新',()=>detections===2);
    // Hold opening the design instance. Parked forms must stay outside the main
    // document so global selectors cannot reach an inactive instance.
    await js(`window.__qaVoiceFetch=window.fetch;window.fetch=async function(...args){const response=await window.__qaVoiceFetch.apply(this,args);if(String(args[0]).includes('/api/modules/voice-design/open'))await new Promise(resolve=>{window.__qaReleaseVoiceDesign=resolve;});return response;};void 0`);
    const activeDesignReady=()=>js("(()=>{const panel=window.document.querySelector('.instance-panel:not([hidden])');return !!panel?.querySelector('#studio-instruction')&&!!panel?.querySelector('#studio-provider [value=http]');})()");
    await js("location.hash='/module/voice-design';void 0");await wait('设计实例打开响应被延迟',()=>js("typeof window.__qaReleaseVoiceDesign==='function'"));
    assert.equal(await js("!!window.document.querySelector('#studio-instruction')"),false,'非活动实例表单不得被主文档选择器命中');
    assert.equal(await activeDesignReady(),false,'隐藏设计页不能被当作当前可操作页面');
    await js("window.__qaReleaseVoiceDesign();window.fetch=window.__qaVoiceFetch;delete window.__qaVoiceFetch;delete window.__qaReleaseVoiceDesign;void 0");
    await wait('可见设计页面与引擎选项',activeDesignReady);
    assert.equal(await js("window.document.querySelector('.instance-panel:not([hidden])').querySelector('#studio-provider [value=http]').disabled"),true);assert.equal(detections,2);
    await js("document.querySelector('[data-tour-skip]')?.click();void 0");window.setSize(1280,1000);await pause(200);await shot('Qwen与HTTP能力_1280');assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    await click(`[data-instance-select="${originalInstance}"]`);await wait('恢复声音实例与音色库',()=>js("(()=>{const panel=window.document.querySelector('.instance-panel:not([hidden])');return !!panel?.querySelector('#studio-task')&&[...(panel?.querySelector('#shared-voice')?.options||[])].some(item=>item.textContent==='Qwen预设');})()"));
    assert.equal(await js("document.querySelector('#studio-provider').value"),'http','切回保留引擎选择');
    assert.equal(await js("document.querySelector('#studio-text').value"),'念念，今天也想和你分享一点温暖。','切回保留台词草稿');
    assert.deepEqual(errors,[]);success=true;
  }catch(error){await shot('失败现场');console.error(JSON.stringify({errors,text:await js('document.body.innerText')}));throw error;}finally{
    await writeFile(join(directory,'result.json'),JSON.stringify({ok:success,realInference:false,detections,commands,voices:backend.context.voiceStudio.voices(),errors},null,2)+'\n','utf8');window.destroy();await backend.close();
  }
  console.log(JSON.stringify({ok:success,directory}));app.exit(success?0:1);
}
app.whenReady().then(run).catch(error=>{console.error(error);app.exit(1);});
