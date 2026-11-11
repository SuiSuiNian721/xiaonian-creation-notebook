import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron='F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
function fixture(){
  const prefix='/instances/11111111-1111-4111-8111-111111111111',audio=prefix+'/internal/voice-audio/'+'a'.repeat(64)+'/'+'b'.repeat(64);
  const voice={id:'voice-11111111-1111-4111-8111-111111111111',name:'念念的声音',source:'design'};
  window.exportFixture={calls:[],drafts:new Map(),voice,audio};const f=window.exportFixture;
  f.studio={busy:false,job:{id:'candidate',mode:'design',status:'completed',result:{id:'audio',url:audio}},voices:[voice],resources:{config:{},components:[]}};
  f.mount=async(mode='design')=>{
    f.controller?.abort();f.controller=new AbortController();
    const ctx={signal:f.controller.signal,state:{selectedCharacterId:null},url:path=>prefix+path,notify:()=>{},action:async(_button,work)=>work(),drafts:{read:(key,fallback)=>f.drafts.get(key)??fallback,write:(key,value)=>f.drafts.set(key,value),commit:(key,value)=>f.drafts.set(key,value)},api:async(path,options={})=>{
      f.calls.push({path,body:options.body});
      if(path==='/api/voice/config')return {config:{}};
      if(path==='/api/voice/state')return {busy:false,running:false,configured:false};
      if(path==='/api/voice/voices')return {voices:[voice]};
      if(path==='/api/voice-studio/state')return structuredClone(f.studio);
      if(path==='/api/voice/speech')return {url:audio};
      throw new Error('意外请求 '+path);
    }};
    const {mountWorkspace}=await import('/modules/voice.js');await mountWorkspace(document.querySelector('#root'),ctx,mode);
  };
}
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron'),directory=process.env.VOICE_EXPORT_UI_DIR;
  app.disableHardwareAcceleration();app.setPath('userData',join(directory,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const wav=Buffer.alloc(48044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const server=createServer(async(req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/voice-studio.css"><main id="root"></main><script type="module">(${fixture.toString()})();await exportFixture.mount();window.ready=true;</script></html>`);}
    if(req.url==='/card-studio/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end('<a id="artifact" href="/card-studio/api/artifact-file/card?file=png&targetType=card" download="角色卡.png">导出</a>');}
    if(req.url.startsWith('/api/modules/drawing/images/')||req.url.startsWith('/card-studio/api/artifact-file/')){res.writeHead(200,{'content-type':'image/png'});return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64'));}
    if(req.url==='/process-log.html'){res.setHeader('content-type','text/html;charset=utf-8');return res.end('<button id="export" onclick="const a=document.createElement(\'a\');a.href=window.URL.createObjectURL(new Blob([\'日志内容\']));a.download=\'进程日志.log\';a.click()">导出日志</button>');}
    if(req.url.includes('/internal/voice-audio/')||/^\/instances\/[^/]+\/api\/voice\/voices\/[^/]+\/audio$/.test(req.url)){res.writeHead(200,{'content-type':'audio/wav',...(req.url.includes('/api/voice/')?{'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent('念念的声音.wav')}:{})});return res.end(wav);}
    try{const path=resolve(root,'public-workbench','.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(join(root,'public-workbench')+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port;
  const window=new BrowserWindow({show:false,width:1420,height:1000,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});window.webContents.setAudioMuted(true);
  const {installWorkbenchDownloads}=createRequire(import.meta.url)('../desktop/downloads.cjs');
  const dispose=installWorkbenchDownloads({session:window.webContents.session,getBaseURL:()=>base,getDownloadsPath:()=>directory}),downloads=[],errors=[];let cancelNext=false;
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  window.webContents.session.on('will-download',(_event,item)=>{
    const record={filename:item.getFilename(),options:item.getSaveDialogOptions(),url:item.getURL()};downloads.push(record);
    item.once('done',(_event,state)=>{record.state=state;record.path=item.getSavePath();});
    if(cancelNext){cancelNext=false;item.cancel();}else item.setSavePath(join(directory,'download-'+downloads.length+extname(item.getFilename())));
  });
  const js=async source=>{try{return await window.webContents.executeJavaScript(source,true);}catch(error){throw new Error(error.message+'\n'+source+'\n'+errors.join('\n'));}},pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(check)=>{const until=Date.now()+8000;while(Date.now()<until){if(await check())return;await pause(30);}throw new Error('等待导出超时 '+errors.join('\n')+' '+JSON.stringify(downloads)+' '+await js('document.querySelector("#root")?.innerText'));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const download=async selector=>{const count=downloads.length;await click(selector);await wait(()=>downloads.length===count+1&&downloads.at(-1).state);return downloads.at(-1);};
  try{
    await window.loadURL(base+'/');await wait(()=>js('window.ready'));
    assert.equal(await js('!!document.querySelector("[data-studio-export]")'),true,'声音候选必须提供另存音频');
    assert.equal(await js('!!document.querySelector("[data-voice-export-reference]")'),true,'已保存声线必须提供参考音频导出');
    assert.equal(await js('document.querySelector("[data-voice-export]").hidden'),true);
    const before=await js('JSON.stringify([...exportFixture.drafts])');cancelNext=true;
    const cancelled=await download('[data-studio-export]');assert.equal(cancelled.state,'cancelled');assert.equal(await js('JSON.stringify([...exportFixture.drafts])'),before);
    const candidate=await download('[data-studio-export]');assert.equal(candidate.state,'completed');assert.equal(candidate.options.title,'另存音频');assert.deepEqual(await readFile(candidate.path),wav);
    const reference=await download('[data-voice-export-reference]');assert.equal(reference.state,'completed');assert.match(reference.url,/\/instances\/[^/]+\/api\/voice\/voices\/voice-.+\/audio$/);assert.deepEqual(await readFile(reference.path),wav);
    await js('document.querySelector("#voice-text").value="测试合成结果";document.querySelector("[data-voice-form]").requestSubmit();void 0');
    await wait(()=>js('!document.querySelector("[data-voice-export]").hidden'));
    const speech=await download('[data-voice-export]');assert.equal(speech.state,'completed');assert.equal(speech.filename,'念念的声音.wav');
    assert.deepEqual(await js('exportFixture.calls.filter(call=>call.body).map(call=>call.path)'),['/api/voice/speech'],'导出不保存音色、不改角色引用、不触发额外生成');
    if(process.env.VOICE_EXPORT_UI_EVIDENCE){await mkdir(process.env.VOICE_EXPORT_UI_EVIDENCE,{recursive:true});await writeFile(join(process.env.VOICE_EXPORT_UI_EVIDENCE,'voice-export-ui.png'),(await window.webContents.capturePage()).toPNG());await js("document.querySelector('.voice-workspace').scrollIntoView({block:'start'});new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");await writeFile(join(process.env.VOICE_EXPORT_UI_EVIDENCE,'voice-library-export-ui.png'),(await window.webContents.capturePage()).toPNG());}
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'桌面增加导出入口后不横向溢出');
    for(const [name,href] of [['训练参数.json','blob'],['作品.png',base+'/api/modules/drawing/images/test?download=1']]){
      const count=downloads.length;await js(`(()=>{const a=document.createElement('a');a.href=${href==='blob'?"URL.createObjectURL(new Blob(['{\"ok\":true}'],{type:'application/json'}))":JSON.stringify(href)};a.download=${JSON.stringify(name)};a.click();})()`);await wait(()=>downloads.length===count+1&&downloads.at(-1).state);assert.equal(downloads.at(-1).state,'completed');assert.ok(downloads.at(-1).options.defaultPath.endsWith(name));
    }
    await js("new Promise(done=>{const frame=document.createElement('iframe');frame.id='card-frame';frame.onload=done;frame.src='/card-studio/';document.body.append(frame);})");
    const count=downloads.length;await js("document.querySelector('#card-frame').contentDocument.querySelector('#artifact').click();void 0");await wait(()=>downloads.length===count+1&&downloads.at(-1).state);assert.equal(downloads.at(-1).options.title,'另存图片');
    const logs=new BrowserWindow({show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
    logs.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
    try{await logs.loadURL(base+'/process-log.html');const count=downloads.length;await logs.webContents.executeJavaScript("document.querySelector('#export').click();void 0",true);await wait(()=>downloads.length===count+1&&downloads.at(-1).state);assert.equal(downloads.at(-1).options.title,'导出日志');}finally{logs.destroy();}
    await js('exportFixture.studio.job.status="generating";exportFixture.mount("clone")');assert.equal(await js('document.querySelector("[data-studio-export]").hidden'),true,'新任务不能另存旧候选');
    assert.deepEqual(errors,[]);if(process.env.VOICE_EXPORT_UI_EVIDENCE){await mkdir(process.env.VOICE_EXPORT_UI_EVIDENCE,{recursive:true});await writeFile(join(process.env.VOICE_EXPORT_UI_EVIDENCE,'voice-export-result.json'),JSON.stringify({realElectron:true,realInference:false,savePathSimulated:true,downloads},null,2)+'\n');}
    console.log('VOICE_EXPORT_UI_OK');
  }finally{await js('exportFixture.controller.abort();void 0').catch(()=>{});dispose();window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
if(process.argv.includes('--voice-export-ui'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('实际 Electron 声音导出：候选、已保存参考、合成、取消与实例路径',{skip:!existsSync(electron),timeout:40000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-export-ui-')),env={...process.env,VOICE_EXPORT_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--voice-export-ui'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/VOICE_EXPORT_UI_OK/);
});
