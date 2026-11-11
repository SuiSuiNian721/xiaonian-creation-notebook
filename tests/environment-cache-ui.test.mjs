import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {EnvironmentDiscovery} from '../framework/environment.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
const memory=()=>{const values=new Map();return {getSetting:key=>values.get(key),setSetting:(key,value)=>values.set(key,structuredClone(value))};};

async function runBrowser(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.setPath('userData',process.env.AI_FUTURE_ENV_CACHE_PROFILE);
  app.on('window-all-closed',()=>{});await app.whenReady();
  let scans=0,release,blocked,stateGate,releaseState,stateCaptured=false;
  const store=memory();
  const discovery=new EnvironmentDiscovery({store,roots:[],env:{},scanLocal:async()=>{
    const version=++scans;if(blocked)await blocked;
    return {candidates:[{id:'candidate-'+version,label:'ComfyUI '+version,path:'fixture-'+version,selectable:true,values:{comfyPath:'fixture-'+version}}]};
  }});
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    try{
      if(req.url==='/test'){
        res.setHeader('content-type','text/html;charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
          import {mountEnvironmentDiscovery} from '/environment-view.js';
          window.fixture={ui:{},calls:[],selected:[]};
          fixture.mount=(moduleId,fresh=false)=>{
            fixture.controller?.abort();fixture.controller=new AbortController();if(fresh)fixture.ui={};
            const ctx={ui:fixture.ui,signal:fixture.controller.signal,state:{modules:[{id:'drawing'},{id:'comfyui'}]},api:async(path,options={})=>{
              fixture.calls.push({path,...options});const response=await fetch(path,{method:options.method||'GET',headers:{'content-type':'application/json'},...(options.body?{body:JSON.stringify(options.body)}:{})});return response.json();
            }};
            mountEnvironmentDiscovery(document.querySelector('#root'),ctx,{moduleId,onSelect:async candidate=>fixture.selected.push(candidate.id)});
          };window.ready=true;
        </script>`);return;
      }
      if(req.url.startsWith('/api/environment/')){
        res.setHeader('content-type','application/json');
        if(req.method==='GET'){
          const saved=discovery.state({moduleId:new URL(req.url,'http://fixture').searchParams.get('moduleId')});
          if(stateGate){stateCaptured=true;await stateGate;}
          res.end(JSON.stringify(saved));return;
        }
        let body='';for await(const chunk of req)body+=chunk;
        res.end(JSON.stringify(await discovery.scan(JSON.parse(body))));return;
      }
      const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));
      res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
  const js=source=>window.webContents.executeJavaScript(source);
  const wait=async source=>{const end=Date.now()+3000;while(Date.now()<end){if(await js(source))return;await new Promise(done=>setTimeout(done,20));}throw new Error('等待超时：'+source);};
  const candidate=id=>`!!document.querySelector('[data-environment-select="candidate-${id}"]')`;
  const errors=[];
  const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(error){errors.push(name+': '+error.message);}};
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('window.ready');
    await check('绘图和启动器切换后共享手动刷新的结果',async()=>{
      await js("fixture.mount('drawing')");await wait(candidate(1));
      await js("fixture.mount('comfyui')");await wait(candidate(1));assert.equal(scans,1);
      await js("document.querySelector('[data-environment-rescan]').click()");await wait(candidate(2));
      await js("fixture.mount('drawing')");await wait(candidate(2));assert.equal(scans,2);
      await js("document.querySelector('[data-environment-select]').click()");assert.deepEqual(await js('fixture.selected'),['candidate-2']);
    });
    await check('恢复正在执行的扫描会等到新结果而不重复启动',async()=>{
      blocked=new Promise(done=>release=done);
      const pending=discovery.scan({moduleId:'comfyui',refresh:true});
      await js("fixture.mount('drawing',true)");
      await wait("fixture.calls.filter(call=>call.path.startsWith('/api/environment/state')).length>=3");
      await new Promise(done=>setTimeout(done,80));
      release();blocked=null;await pending;await wait(candidate(scans));assert.equal(scans,3);
      assert.equal(await js("document.querySelector('[data-environment-rescan]').disabled"),false);
    });
    await check('再次进入只读最新持久结果，其他会话保留独立缓存',async()=>{
      await js("fixture.mount('drawing',true)");await wait(candidate(scans));
      await js('fixture.firstUi=fixture.ui;void 0');
      await discovery.scan({moduleId:'comfyui',refresh:true});
      await js("fixture.mount('comfyui',true)");await wait(candidate(scans));
      assert.equal(await js('fixture.firstUi.environmentDiscovery.comfyui?.result?.candidates[0].id || fixture.firstUi.environmentDiscovery.drawing.result.candidates[0].id'),'candidate-3');
      await js("fixture.ui=fixture.firstUi;fixture.mount('drawing')");await wait(candidate(4));assert.equal(scans,4);
    });
    await check('中断记录展示错误并等待手动刷新',async()=>{
      store.setSetting('resource.discovery.environment.comfyui',{attempted:true,status:'running',result:null});
      await js("fixture.mount('drawing',true)");await wait("document.querySelector('[data-environment-feedback]').textContent.includes('中断')");assert.equal(scans,4);
      assert.equal(await js("document.querySelector('[data-environment-rescan]').disabled"),false);
    });
    await check('迟到的缓存读取不会覆盖用户刚完成的刷新',async()=>{
      await discovery.scan({moduleId:'comfyui',refresh:true});
      stateGate=new Promise(done=>releaseState=done);
      await js("fixture.mount('drawing')");
      const end=Date.now()+3000;while(!stateCaptured&&Date.now()<end)await new Promise(done=>setTimeout(done,20));assert.equal(stateCaptured,true);
      await js("document.querySelector('[data-environment-rescan]').click()");await wait(candidate(6));
      releaseState();stateGate=null;
      await new Promise(done=>setTimeout(done,100));assert.equal(await js(candidate(6)),true);assert.equal(scans,6);
    });
    assert.deepEqual(errors,[]);console.log('ENVIRONMENT_CACHE_UI_RESULT 5 checks');
  }finally{release?.();releaseState?.();await js('fixture.controller?.abort();void 0').catch(()=>{});window.destroy();await discovery.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
}

if(process.argv.includes('--environment-cache-ui'))runBrowser().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('环境缓存：真实 Electron 与发现器验证共享、恢复、隔离和不隐式重扫',{skip:!electron,timeout:30000},async t=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const profile=await mkdtemp(join(tmpdir(),'environment-cache-ui-'));env.AI_FUTURE_ENV_CACHE_PROFILE=profile;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--environment-cache-ui'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
  assert.equal(code,0,output);assert.match(output,/ENVIRONMENT_CACHE_UI_RESULT/);
});
