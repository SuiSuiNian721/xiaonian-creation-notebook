import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron='F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
function fixture(){
  window.calls=[];let controller;
  window.mountStudio=async(mode='clone',missing=false)=>{
    controller?.abort();controller=new AbortController();window.calls=[];
    const repositories={clone:'MOSS-TTS-Local-Transformer',generator:'MOSS-VoiceGenerator',codec:'MOSS-Audio-Tokenizer'};
    const state={busy:false,job:null,voices:[],resources:{supported:true,directory:'E:\\声音模型',config:{provider:'moss',pythonPath:'E:\\已有环境\\python.exe',searchRoots:[]},discovery:{attempted:true,result:{models:[],environments:[]}},components:['runtime','clone','generator','codec'].map(id=>({id,installed:missing==='stale'||!missing,ready:!missing,downloadBytes:id==='runtime'?null:4*1024**3,repository:repositories[id]?'OpenMOSS-Team/'+repositories[id]:null,revision:'a'.repeat(40),sourceUrl:repositories[id]?'https://huggingface.co/OpenMOSS-Team/'+repositories[id]+'/tree/'+'a'.repeat(40):'https://github.com/astral-sh/uv/releases/tag/0.10.12'})),bindings:{},environments:[],task:null}};
    const drafts=new Map();
    const ctx={signal:controller.signal,state:{selectedCharacterId:null},drafts:{read:(key,fallback)=>drafts.get(key)??fallback,write:(key,value)=>drafts.set(key,value),commit:(key,value)=>drafts.set(key,value)},action:async(button,work)=>work(),api:async(path,options={})=>{calls.push({path,body:options.body});if(path.endsWith('/install'))state.resources.task={status:'running',stage:'downloading',component:options.body.component,totalBytes:100,completedBytes:20};if(path.endsWith('/cancel-install'))state.resources.task.status='cancelled';return structuredClone(state);}};
    const {mountVoiceStudio}=await import('/voice-studio.js');await mountVoiceStudio(document.querySelector('#studio'),ctx,{mode});
  };
}
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');app.disableHardwareAcceleration();app.setPath('userData',join(process.env.VOICE_ENTRY_TEST_DIR,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    if(req.url==='/test'){res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/voice-studio.css"><style>body{padding:30px}#studio{max-width:1120px;margin:auto}</style><main id="studio"></main><script type="module">(${fixture.toString()})();await mountStudio();window.ready=true;</script></html>`);return;}
    try{const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1440,height:1080,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}}),errors=[];
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(source)=>{const until=Date.now()+5000;while(Date.now()<until){if(await js(source))return;await pause(30);}throw new Error('等待超时 '+source+' '+errors.join('\n'));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const capture=async name=>{if(process.env.VOICE_ENTRY_UI_OUTPUT){await mkdir(process.env.VOICE_ENTRY_UI_OUTPUT,{recursive:true});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await writeFile(join(process.env.VOICE_ENTRY_UI_OUTPUT,name),(await window.webContents.capturePage()).toPNG());}};
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('window.ready');
    assert.equal(await js('!!document.querySelector("[data-studio-open-resources]")'),true,'已有模型时也必须有可发现的模型下载入口');
    assert.equal(await js('document.querySelector("[data-studio-components]").open'),false,'已配置时保留紧凑布局');
    assert.match(await js('document.querySelector("[data-studio-open-resources]").textContent'),/模型下载/);
    await capture('voice-download-entry-overview.png');
    await click('[data-studio-open-resources]');assert.equal(await js('document.querySelector("[data-studio-components]").open'),true);
    assert.equal(await js('document.activeElement===document.querySelector("[data-studio-components]>summary")'),true,'打开资源后键盘焦点进入对应区域');
    assert.equal(await js('calls.filter(item=>item.body).length'),0,'打开下载入口不发起下载或修改配置');
    assert.match(await js('document.querySelector("[data-studio-component-summary]").textContent'),/已检查/);
    assert.equal(await js('document.querySelector("[data-studio-install=all]").disabled'),true,'当前功能资源齐全时不重复下载');
    for(const id of ['clone','generator','codec'])assert.match(await js(`document.querySelector('[data-studio-source="${id}"]').href`),/^https:\/\/huggingface\.co\/OpenMOSS-Team\/.+\/tree\/[a-f0-9]{40}$/);
    await js('mountStudio("clone",true)');assert.equal(await js('document.querySelector("[data-studio-components]").open'),true,'已选Python但缺模型时也展示下载入口');
    assert.match(await js('document.querySelector("[data-studio-install=all]").textContent'),/克隆/);
    await js('document.querySelector("[data-studio-components]").scrollIntoView({block:"start"});void 0');await capture('voice-model-downloads-light.png');
    await js('document.documentElement.dataset.theme="dark";void 0');await capture('voice-model-downloads-dark.png');
    await click('[data-studio-install=all]');await wait('calls.some(item=>item.body?.component==="clone-required")');
    assert.equal(await js('document.querySelector("[data-studio-cancel-install]").hidden'),false);await click('[data-studio-cancel-install]');
    await js('mountStudio("design",true)');assert.match(await js('document.querySelector("[data-studio-install=all]").textContent'),/生成/);
    await click('[data-studio-install=all]');await wait('calls.some(item=>item.body?.component==="generator-required")');
    await js('mountStudio("clone","stale")');
    assert.match(await js('document.querySelector("[data-studio-install=clone]").textContent'),/重新检查/);await click('[data-studio-install=clone]');
    await wait('calls.some(item=>item.path.endsWith("/detect")&&item.body?.refresh===true)');assert.equal(await js('calls.some(item=>item.path.endsWith("/install"))'),false,'旧版检查记录先重检，不重复下载');
    await js('mountStudio("clone",true)');
    await js('document.querySelector("#studio-provider").value="qwen3-tts";document.querySelector("#studio-provider").dispatchEvent(new Event("change",{bubbles:true}));void 0');
    assert.equal(await js('document.querySelector("[data-studio-qwen-models]").hidden'),false);assert.equal(await js('document.querySelector("[data-studio-install=all]").hidden'),true);
    await js('document.querySelector("#studio-provider").value="http";document.querySelector("#studio-provider").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("[data-studio-components]").open=false;void 0');
    assert.match(await js('document.querySelector("[data-studio-open-resources]").textContent'),/接口配置/);await click('[data-studio-open-resources]');
    assert.equal(await js('document.querySelector("[data-studio-config]").closest("details").open'),true);
    assert.equal(await js('document.activeElement.id'),'studio-httpUrl');assert.equal(await js('calls.filter(item=>item.body).length'),0);
    assert.deepEqual(errors,[]);console.log('VOICE_ENTRY_UI_OK');
  }finally{window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
if(process.argv.includes('--voice-entry-ui'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('声音下载入口：已有资源、缺模型、MOSS按功能下载、官方来源、Qwen与HTTP',{skip:!existsSync(electron),timeout:30000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-entry-'));const env={...process.env,VOICE_ENTRY_TEST_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--voice-entry-ui'],{cwd:root,env,windowsHide:true});t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/VOICE_ENTRY_UI_OK/);
});
