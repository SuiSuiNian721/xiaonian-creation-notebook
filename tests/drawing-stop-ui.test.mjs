import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWorkbench } from '../framework/server.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const python=process.env.AI_FUTURE_TEST_PYTHON;
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
const pause=ms=>new Promise(done=>setTimeout(done,ms));

async function runBrowser(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});if(process.env.AI_FUTURE_COMFY_STOP_ELECTRON_PROFILE)app.setPath('userData',process.env.AI_FUTURE_COMFY_STOP_ELECTRON_PROFILE);await app.whenReady();
  const directory=await mkdtemp(join(tmpdir(),'comfy-stop-ui-')),comfy=join(directory,'ComfyUI');let service,child,window,output='';
  try{
    await mkdir(join(comfy,'comfy'),{recursive:true});for(const name of ['server.py','nodes.py'])await writeFile(join(comfy,name),'# fixture\n');
    await writeFile(join(comfy,'main.py'),`import argparse,json\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\np=argparse.ArgumentParser();p.add_argument('--port',type=int);p.add_argument('--listen');args=p.parse_args()\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  value={'system':{'comfyui_version':'stop-fixture'}} if self.path=='/system_stats' else {'Save':{'input':{'required':{'text':['STRING']}},'output_node':True}}\n  data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)\n def log_message(self,*args):pass\nHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()\n`);
    const socket=createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done));
    child=spawn(python,['-s',join(comfy,'main.py'),'--listen','127.0.0.1','--port',String(port)],{cwd:comfy,windowsHide:true});child.stderr.on('data',chunk=>output+=chunk);child.on('error',error=>{output+=error.message;});
    const until=Date.now()+15000;while(Date.now()<until){try{if((await fetch('http://127.0.0.1:'+port+'/system_stats')).ok)break;}catch{}await pause(80);}
    assert.equal(child.exitCode,null,output);
    service=await createWorkbench({dataDir:join(directory,'profile'),instances:false,drawingOptions:{WebSocketImpl:null}});
    service.context.store.setEnabled('drawing',true);service.context.store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:'+port});service.context.drawing.runtime.saveSettings({pythonPath:python});
    window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
    const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
    await window.loadURL(service.url);
    const js=source=>window.webContents.executeJavaScript(source);
    await js(`(async()=>{const {mountRuntime}=await import('/drawing-runtime-view.js');const {Drafts}=await import('/drafts.js');document.body.innerHTML='<main id="stop-test-root" style="padding:28px"></main>';window.stopTestController=new AbortController();const ctx={signal:stopTestController.signal,drafts:new Drafts(),state:await fetch('/api/state').then(r=>r.json()),action:async(_button,job)=>job(),navigate:()=>{},refresh:async()=>{},api:async(path,{method='GET',body}={})=>{const response=await fetch(path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;}};await mountRuntime(document.querySelector('#stop-test-root'),ctx);})()`);
    const wait=async source=>{const deadline=Date.now()+35000;while(Date.now()<deadline){if(await js(source))return;await pause(70);}throw new Error('DOM wait '+source+'\n'+await js("document.querySelector('#runtime-feedback')?.textContent")+'\n'+output);};
    const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
    assert.equal(await js("document.querySelector('#runtime-stop').disabled"),true);
    await click('#runtime-connect');await wait("document.querySelector('#runtime-connection').textContent==='ComfyUI 已连接'");
    assert.equal(await js("document.querySelector('#runtime-stop').disabled"),false,'与截图相同的外部连接不能再禁用停止');
    assert.equal(await js("document.querySelector('#runtime-launch').disabled"),false,'外部服务退出后仍能重新核对并启动');
    assert.match(await js("document.querySelector('#runtime-launch').textContent"),/检查并启动/);
    const firstExited=new Promise(done=>child.once('exit',done));child.kill();await firstExited;
    assert.equal(await js("document.querySelector('#runtime-launch').disabled"),false,'外部服务自行退出、连接缓存尚在时保留重新启动入口');
    child=spawn(python,['-s',join(comfy,'main.py'),'--listen','127.0.0.1','--port',String(port)],{cwd:comfy,windowsHide:true});child.stderr.on('data',chunk=>output+=chunk);
    const restarted=Date.now()+15000;while(Date.now()<restarted){try{if((await fetch('http://127.0.0.1:'+port+'/system_stats')).ok)break;}catch{}await pause(80);}
    await click('#runtime-stop');await wait("!document.querySelector('#runtime-stop-confirmation').hidden");
    assert.match(await js("document.querySelector('#runtime-stop-target').textContent"),new RegExp('PID '+child.pid));assert.equal(child.exitCode,null);
    await click('#runtime-stop-cancel');assert.equal(child.exitCode,null);assert.equal(await js("document.querySelector('#runtime-stop-confirmation').hidden"),true);
    await click('#runtime-stop');await wait("!document.querySelector('#runtime-stop-confirmation').hidden");
    const qa=process.env.AI_FUTURE_COMFY_STOP_UI_OUTPUT;if(qa){mkdirSync(qa,{recursive:true});writeFileSync(join(qa,'external-stop-confirm.png'),(await window.webContents.capturePage()).toPNG());}
    await click('#runtime-stop-confirm');await wait("document.querySelector('#runtime-feedback').textContent.includes('已停止')");
    const exited=Date.now()+5000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<exited)await pause(30);
    assert.equal(child.exitCode!==null||child.signalCode!==null,true);await wait("document.querySelector('#runtime-stop').disabled&&!document.querySelector('#runtime-launch').disabled");
    assert.deepEqual(errors,[]);await js('stopTestController.abort();void 0');
    console.log('COMFY_STOP_UI_RESULT '+JSON.stringify({scope:'actual workbench HTTP + Electron + isolated Python main.py service; no production ComfyUI stopped',pid:child.pid,port,stopped:true,errors}));
  }finally{window?.destroy();if(child&&child.exitCode===null&&child.signalCode===null)child.kill();await service?.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});}
}
if(process.argv.includes('--comfy-stop-ui-electron'))runBrowser().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('ComfyUI 已连接的外部本机服务可确认停止，按钮和进程状态同步',{skip:process.platform!=='win32'||!electron||!python,timeout:150000},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'comfy-stop-electron-')),env={...process.env,AI_FUTURE_COMFY_STOP_ELECTRON_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[fileURLToPath(import.meta.url),'--comfy-stop-ui-electron'],{cwd:root,env,windowsHide:true});t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(done=>child.once('exit',done));}assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/COMFY_STOP_UI_RESULT/);
});
