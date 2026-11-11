import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

async function run(mode){
  const {app,BrowserWindow}=createRequire(process.execPath)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.AI_FUTURE_BINDINGS_UI_DIR,'electron'));app.on('window-all-closed',()=>{});await app.whenReady();
  const server=createServer(async(req,res)=>{
    try{
      if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<main id="fixture"></main>');return;}
      const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w-]+\.js$/.test(name)){res.writeHead(404).end();return;}
      res.setHeader('content-type','text/javascript');res.end(await readFile(join(root,'public-workbench',name)));
    }catch{res.writeHead(404).end();}
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1440,height:1080,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,source)=>{const until=Date.now()+5000;while(Date.now()<until){if(await js(source))return;await pause(20);}throw new Error('等待超时：'+label);};
  const input=(selector,value)=>js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  try{
    await window.loadURL('http://127.0.0.1:'+server.address().port);
    if(mode==='voice'){
      await js(`(async()=>{
        const {mountVoiceStudio}=await import('/voice-studio.js'),{Drafts}=await import('/drafts.js');
        const f=window.fixture={root:document.querySelector('#fixture'),drafts:new Drafts(),calls:[],pending:[],pendingStates:[],controller:new AbortController(),hold:true};
        f.state={busy:false,voices:[],resources:{config:{provider:'moss',pythonPath:'C:\\\\old\\\\python.exe',clonePath:'',generatorPath:'',codecPath:'',searchRoots:[]},components:[],discovery:{attempted:true,result:{models:[{provider:'moss',kind:'clone',path:'C:\\\\models\\\\MOSS-clone'},{provider:'qwen3-tts',kind:'base',path:'C:\\\\models\\\\Qwen-base'},{provider:'qwen3-tts',kind:'custom-voice',path:'C:\\\\models\\\\Qwen-custom'},{provider:'qwen3-tts',kind:'voice-design',path:'C:\\\\models\\\\Qwen-design'}],environments:[{provider:'moss',path:'C:\\\\moss\\\\python.exe'},{provider:'qwen3-tts',path:'C:\\\\qwen\\\\python.exe'}],installations:[{provider:'qwen3-tts',path:'C:\\\\Qwen-source'}]}}}};
        f.ctx={signal:f.controller.signal,state:{},drafts:f.drafts,action:async(_button,work)=>work(),api:async(path,options={})=>{f.calls.push({path,body:options.body});if(path.endsWith('/config')){Object.assign(f.state.resources.config,options.body.values);const response=structuredClone(f.state);if(f.hold)await new Promise(done=>f.pending.push(done));return response;}const response=structuredClone(f.state);if(path.endsWith('/state')&&f.holdStates)await new Promise(done=>f.pendingStates.push(done));return response;}};
        f.mount=()=>mountVoiceStudio(f.root,f.ctx,{mode:'clone'});await f.mount();
      })()`);
      await input('#studio-generatorPath','C:\\my-unsaved-generator');
      await click('[data-studio-bind="clonePath"]');await wait('绑定请求挂起','fixture.pending.length===1');
      await input('#studio-clonePath','C:\\new-manual-clone');await js('fixture.pending.shift()();void 0');await pause(100);
      assert.equal(await js('document.querySelector("#studio-clonePath").value'),'C:\\new-manual-clone','迟到的候选绑定响应不得覆盖新输入');
      assert.equal(await js('document.querySelector("#studio-generatorPath").value'),'C:\\my-unsaved-generator','绑定一个字段不得丢掉其他未保存路径');
      await click('[data-studio-detect]');await pause(80);
      assert.equal(await js('document.querySelector("#studio-generatorPath").value'),'C:\\my-unsaved-generator','重新检索不得丢掉已有未保存路径');
      await js('fixture.hold=false;document.querySelector("#studio-provider").value="qwen3-tts";document.querySelector("#studio-provider").dispatchEvent(new Event("change",{bubbles:true}));void 0');
      for(const field of ['qwenPythonPath','qwenBasePath','qwenCustomVoicePath','qwenDesignPath','qwenSourcePath']){
        await click('[data-studio-bind="'+field+'"]');await wait('Qwen字段 '+field,`fixture.state.resources.config[${JSON.stringify(field)}]&&document.querySelector('#studio-'+${JSON.stringify(field)}).value===fixture.state.resources.config[${JSON.stringify(field)}]`);
      }
      await js('document.querySelector("[data-studio-config]").requestSubmit();void 0');await wait('保存配置','document.querySelector("[data-studio-resource-feedback]").textContent.includes("配置已保存")');
      assert.equal(await js('fixture.state.resources.config.clonePath'),'C:\\new-manual-clone');
      assert.equal(await js('fixture.state.resources.config.generatorPath'),'C:\\my-unsaved-generator');
      await js('fixture.holdStates=true;void 0');await wait('旧轮询响应挂起','fixture.pendingStates.length===1');
      await input('#studio-qwenBasePath','C:\\models\\new-after-poll');await js('document.querySelector("[data-studio-config]").requestSubmit();void 0');await wait('轮询期间保存','fixture.state.resources.config.qwenBasePath==="C:\\\\models\\\\new-after-poll"&&!document.querySelector("[data-studio-config] button[type=submit]").disabled');
      await js('fixture.pendingStates.shift()();fixture.holdStates=false;void 0');await pause(100);
      assert.equal(await js('document.querySelector("#studio-qwenBasePath").value'),'C:\\models\\new-after-poll','写入开始前的迟到轮询响应不得恢复旧配置');
      await js('fixture.controller.abort();void 0');
    }else{
      await js(`(async()=>{
        const {mountVisionExtension}=await import('/vision-extension.js');
        const f=window.fixture={root:document.querySelector('#fixture'),calls:[],state:{installed:false,supported:true,runtime:{status:'stopped'},bindings:{},searchRoots:[],components:[],discovery:{attempted:true,result:{candidates:[{id:'model',kind:'model',path:'C:\\\\models\\\\misleading-mmproj.gguf',verification:'metadata'},{id:'projector',kind:'projector',path:'C:\\\\models\\\\vision.gguf',verification:'metadata'},{id:'runtime',kind:'runtime',path:'C:\\\\llama\\\\llama-server.exe',verification:'metadata'}]}}}};
        f.fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):null;f.calls.push({path,body});if(path.endsWith('/configure')){f.state.bindings={...body};delete f.state.bindings.searchRoots;f.state.searchRoots=body.searchRoots;const snapshot=structuredClone(f.state);if(f.holdConfiguration)await new Promise(done=>f.releaseConfiguration=done);return {ok:true,json:async()=>snapshot};}return {ok:true,json:async()=>structuredClone(f.state)};};
        f.dispose=mountVisionExtension(f.root,{fetchImpl:f.fetch,draftToken:()=>'',applyConnection:()=>{throw new Error('采用路径不得自动填入角色连接');}});
      })()`);
      await wait('视觉候选','!!document.querySelector("[data-vision-adopt]")');
      assert.equal(await js('document.querySelector("[data-vision-adopt]").checkVisibility()'),true,'发现候选应直接可见');
      assert.equal(await js('!!document.querySelector("[data-vision-target=projector]")'),true,'GGUF 候选须明确选择用途，不能靠文件名绑定');
      await input('[data-vision-target="projector"]','modelPath');await click('[data-vision-adopt="projector"]');
      await input('[data-vision-target="model"]','projectorPath');await click('[data-vision-adopt="model"]');await click('[data-vision-adopt="runtime"]');
      await click('[data-vision-save-bindings]');await wait('视觉保存','fixture.calls.some(call=>call.path.endsWith("/configure"))');
      assert.equal(await js('fixture.state.bindings.modelPath'),'C:\\models\\vision.gguf');
      assert.equal(await js('fixture.state.bindings.projectorPath'),'C:\\models\\misleading-mmproj.gguf');
      assert.equal(await js('fixture.state.bindings.runtimePath'),'C:\\llama\\llama-server.exe');
      assert.equal(await js('fixture.calls.some(call=>/\\/(start|install|connection)$/.test(call.path))'),false,'采用和保存不能启动、下载或替换角色连接');
      await js('fixture.holdConfiguration=true;void 0');await input('[data-vision-field="modelPath"]','C:\\models\\submitted.gguf');await click('[data-vision-save-bindings]');await wait('视觉配置响应挂起','typeof fixture.releaseConfiguration==="function"');
      assert.equal(await js('document.querySelector("[data-vision-field=modelPath]").disabled'),false,'保存时仍可编辑下一版手动路径');
      await input('[data-vision-field="modelPath"]','C:\\models\\newer-draft.gguf');await js('fixture.releaseConfiguration();void 0');await pause(100);
      assert.equal(await js('document.querySelector("[data-vision-field=modelPath]").value'),'C:\\models\\newer-draft.gguf','迟到配置响应不得覆盖新的视觉路径');
      await js('fixture.dispose();void 0');
    }
    assert.deepEqual(errors,[]);console.log('BINDINGS_UI_OK '+mode);
  }finally{window.destroy();await new Promise(done=>server.close(done));}
}

const mode=process.argv.find(arg=>arg.startsWith('--bindings-ui='))?.split('=')[1];
if(mode)run(mode).then(()=>createRequire(process.execPath)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(process.execPath)('electron').app.exit(1);});
else for(const mode of ['voice','vision'])test(mode+' 的候选采用保留手动输入并写入精确字段',{skip:!electron,timeout:30000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'resource-bindings-ui-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,AI_FUTURE_BINDINGS_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--bindings-ui='+mode],{cwd:root,env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(()=>{if(child.exitCode===null)child.kill();});const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/BINDINGS_UI_OK/);
});
