import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
import {VoiceResources} from '../framework/voice-resources.mjs';

const {app,BrowserWindow}=createRequire('F:\\小汐的研究日志\\package.json')('electron');
const directory=resolve(process.env.AI_FUTURE_VOICE_MODEL_QA_DIR||join('qa','voice-model-downloads-'+Date.now()));
app.disableHardwareAcceleration();app.setPath('userData',join(directory,'electron'));app.on('window-all-closed',()=>{});
const hash=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const revision='b'.repeat(40);

async function run(){
  await mkdir(directory,{recursive:true});const settings=new Map(),requests=[],filesByRepo=new Map(),manual=join(directory,'manual-base');await mkdir(manual,{recursive:true});let pauseFirstWeight=true;
  function files(repository){
    if(filesByRepo.has(repository))return filesByRepo.get(repository);
    const kind=repository.endsWith('-Base')?'base':repository.endsWith('-CustomVoice')?'custom_voice':'voice_design';
    const result=new Map([['config.json',Buffer.from(JSON.stringify({model_type:'qwen3_tts',architectures:['Qwen3TTSForConditionalGeneration'],tts_model_type:kind}))],['generation_config.json',Buffer.from('{}')],['tokenizer_config.json',Buffer.from('{}')],['vocab.json',Buffer.from('{}')],['merges.txt',Buffer.from('#version:0.2\na b')],['model.safetensors',Buffer.alloc(128,42)],['speech_tokenizer/config.json',Buffer.from('{"model_type":"qwen3_tts_tokenizer"}')],['speech_tokenizer/model.safetensors',Buffer.alloc(96,41)]]);filesByRepo.set(repository,result);return result;
  }
  const fetchImpl=async(input,options={})=>{
    const url=String(input);requests.push({url,range:options.headers?.Range});assert.equal(options.headers?.Authorization,undefined);
    const metadata=url.match(/^https:\/\/huggingface\.co\/api\/models\/(Qwen\/[^/]+)\/revision\/main\?blobs=true$/);
    if(metadata){const repository=metadata[1];return new Response(JSON.stringify({id:repository,sha:revision,siblings:[...files(repository)].map(([rfilename,bytes])=>({rfilename,size:bytes.length,blobId:gitBlob(bytes),...(rfilename.endsWith('.safetensors')?{lfs:{sha256:hash(bytes),size:bytes.length}}:{})})).concat([{rfilename:'examples/demo.wav',size:999999,lfs:{sha256:'c'.repeat(64),size:999999}}])}));}
    const file=url.match(/^https:\/\/huggingface\.co\/(Qwen\/[^/]+)\/resolve\/([a-f0-9]{40})\/(.+)$/);assert.ok(file,'只能访问本地fixture的官方模型URL');assert.equal(file[2],revision);
    const filename=decodeURIComponent(file[3]),bytes=files(file[1]).get(filename);assert.ok(bytes,'不能下载demo文件');
    if(filename==='model.safetensors'&&pauseFirstWeight){pauseFirstWeight=false;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,5));},pull(){return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}),{headers:{'content-length':String(bytes.length)}});}
    const offset=Number(options.headers?.Range?.match(/^bytes=(\d+)-$/)?.[1]||0);return new Response(bytes.subarray(offset),{status:offset?206:200,headers:{'content-length':String(bytes.length-offset),'content-type':filename.endsWith('.json')?'application/json':'application/octet-stream',...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})}});
  };
  const resources=new VoiceResources({store:{getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))},dataDir:join(directory,'resources-profile'),directory:join(directory,'models'),searchRoots:[],candidates:{},fetchImpl,platform:'win32',arch:'x64'});await resources.configure({qwenBasePath:manual});
  const backend=await createWorkbench({dataDir:join(directory,'profile'),voiceStudioOptions:{resources,runWorker:()=>assert.fail('下载QA不能启动推理')}});backend.context.store.setEnabled('voice',true);backend.context.store.setSetting('moduleGuides',{voice:true});
  const window=new BrowserWindow({show:false,width:1440,height:1080,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}}),errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=code=>window.webContents.executeJavaScript(`{const document=new Proxy(window.document,{get(target,key){if(key==='querySelector')return selector=>target.querySelector('.instance-panel:not([hidden])')?.querySelector(selector)||target.querySelector(selector);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});${code}}`,true),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,check)=>{const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await pause(50);}throw new Error('等待超时：'+label);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`),set=(selector,value)=>js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const report={ok:false,realDownloads:false,models:[],errors};
  try{
    await window.loadURL(backend.url+'/#/module/voice');await wait('可见声音模块',()=>js("!!window.document.querySelector('.instance-panel:not([hidden]) #studio-provider')"));await js("document.querySelector('[data-tour-skip]')?.click();void 0");await click('[data-voice-mode="clone"]');await wait('克隆操作',()=>js("!!document.querySelector('#studio-task')"));await set('#studio-provider','qwen3-tts');assert.equal(requests.length,0,'启动与首次本地发现不能联网');
    assert.equal(await js("window.document.querySelector('.instance-panel:not([hidden])').querySelectorAll('[data-studio-plan-model]').length"),3,'三类模型必须有独立下载入口');
    for(const [kind,size,field] of [['base','0.6B','qwenBasePath'],['custom-voice','1.7B','qwenCustomVoicePath'],['voice-design','1.7B','qwenDesignPath']]){
      await set(`[data-studio-model-size="${kind}"]`,size);const previousWeightReads=requests.filter(item=>item.url.endsWith('.safetensors')).length;
      await click(`[data-studio-plan-model="${kind}"]`);await wait('准备'+kind,()=>resources.state().modelPlan?.modelKind===kind&&resources.state().modelPlan?.status==='prepared');await wait('计划可执行',()=>js("!!document.querySelector('[data-studio-download-model]:not(:disabled)')"));
      const plan=resources.state().modelPlan;assert.equal(requests.filter(item=>item.url.endsWith('.safetensors')).length,previousWeightReads);assert.equal(await js("document.querySelector('[data-studio-model-plan]').textContent.includes(''+"+JSON.stringify(revision)+")"),true);assert.ok(plan.files.every(file=>file.sha256&&file.bytes>=0));
      await js("document.querySelector('[data-studio-model-plan] details').open=true;void 0");await set('#studio-task','synthesis');assert.equal(await js("document.querySelector('[data-studio-model-plan] details').open"),true,'界面状态刷新不能收起正在查看的文件清单');
      await click('[data-studio-download-model]');
      if(kind==='base'){
        await wait('部分权重落盘',async()=>((await readFile(join(plan.directory,'model.safetensors.part')).catch(()=>Buffer.alloc(0))).length===5));await click('[data-studio-cancel-install]');await wait('取消下载',()=>resources.state().modelPlan.status==='cancelled');await wait('同计划可继续',()=>js("!!document.querySelector('[data-studio-download-model]:not(:disabled)')"));await click('[data-studio-download-model]');
      }
      await wait('下载'+kind,()=>resources.state().modelPlan.status==='completed');assert.equal(resources.state().config[field],kind==='base'?manual:'','下载不得自动覆盖绑定');
      await wait('显示绑定操作',()=>js("!!document.querySelector('[data-studio-model-plan] [data-studio-bind]')"));await click('[data-studio-model-plan] [data-studio-bind]');
      // The config path is set before the asynchronous metadata inspection ends.
      // Wait for the completed configure operation, then assert the actual binding.
      await wait('绑定'+kind,()=>resources.state().config[field]===plan.directory&&resources.state().bindings[field]?.status==='available'&&!resources.operation);assert.equal(resources.state().bindings[field].status,'available');report.models.push({kind,size,planId:plan.id,directory:plan.directory});
    }
    assert.ok(requests.some(item=>item.range==='bytes=5-'));assert.equal(await js("document.querySelector('[data-studio-model-size=voice-design]').options.length"),1);
    await js("document.querySelector('[data-studio-model-plan]').scrollIntoView({block:'center',behavior:'instant'});void 0");await pause(120);await writeFile(join(directory,'Qwen独立下载_1440.png'),(await window.webContents.capturePage()).toPNG());assert.deepEqual(errors,[]);report.ok=true;
  }catch(error){report.error=error.stack;console.error(JSON.stringify({error:report.error,text:await js('document.body.innerText')}));throw error;}finally{report.requests=requests;await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n','utf8');window.destroy();await backend.close();}
  console.log(JSON.stringify({ok:report.ok,directory}));app.exit(report.ok?0:1);
}
app.whenReady().then(run).catch(error=>{console.error(error);app.exit(1);});
