import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';
import {installCharacterPackages} from './helpers/character-packages.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
async function run(kind){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');app.disableHardwareAcceleration();
  const directory=process.env.CHARACTER_AUDIT_TEST_DIR;app.setPath('userData',join(directory,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const backend=await createWorkbench({dataDir:join(directory,'data'),aiOptions:{fetchImpl:async()=>Response.json({choices:[{message:{content:'你好[sticker:wave]'}}]})}});
  const api=async(path,body,method=body?'POST':'GET')=>{const response=await fetch(backend.url+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const character=(await api('/api/characters',{name:'切换与表情回归角色'})).character,life=backend.context.life;
  life.configure(character.id,{mode:'full',memory:{autoExtract:false}});
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){throw new Error(error.message+'\n'+source+'\n'+errors.join('\n'));}},pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async source=>{const end=Date.now()+10000;while(Date.now()<end){if(await js(source))return;await pause(25);}throw new Error('UI 等待超时 '+source+'\n'+await js('document.querySelector("#lite-audit-root")?.innerHTML||document.querySelector("[data-life-feedback]")?.textContent||""'));};
  const capture=async name=>{if(!process.env.CHARACTER_AUDIT_UI_OUTPUT)return;await mkdir(process.env.CHARACTER_AUDIT_UI_OUTPUT,{recursive:true});window.webContents.invalidate();await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await pause(150);await writeFile(join(process.env.CHARACTER_AUDIT_UI_OUTPUT,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
  try{
    await window.loadURL(backend.url+'#/characters');await wait('!!document.querySelector("[data-character-life-id]")');
    if(kind==='scope'){
      for(const id of ['a','b','c']){life.data.put(character.id,'scope',{id:'companion:'+id,scope:'companion:'+id,moduleId:'companion',conversationId:id,title:'会话 '+id});life.saveState(character.id,{scope:'companion:'+id,state:{relationship:'属于 '+id,variables:{only:id}}});}
      await js(`(async()=>{const {openCharacterLife}=await import('/character-life.js');const {Drafts}=await import('/drafts.js');window.scopeAudit={fail:false,delay:false,calls:[]};window.auditDrafts=new Drafts();window.auditContext={state:{selectedCharacterId:${JSON.stringify(character.id)},characters:[${JSON.stringify(character)}],modules:[]},drafts:auditDrafts,refresh:async()=>{},fetch:async(url,options={})=>{scopeAudit.calls.push({url,body:options.body});if(url.includes('/life?')&&url.includes('conversationId=b')){if(scopeAudit.delay)await new Promise(done=>scopeAudit.release=done);if(scopeAudit.fail){scopeAudit.fail=false;return Response.json({error:'回归注入：新会话读取失败'},{status:503});}}return fetch(url,options);}};openCharacterLife(auditContext,{moduleId:'companion',conversationId:'a'});})()`);
      await wait('!!document.querySelector("[data-life-panel=profile]")');await js('document.querySelector("[data-life-tab=state]").click();void 0');
      await wait('!!document.querySelector("[data-life-panel=state]")');
      await js('document.querySelector("[name=relationship]").value="会话 a 的未保存草稿";scopeAudit.fail=true;var select=document.querySelector("[name=viewScope]");select.value="companion:b";select.dispatchEvent(new Event("change",{bubbles:true}));void 0');
      await wait('document.querySelector("[data-life-feedback]").textContent.includes("新会话读取失败")&&!document.querySelector("[data-life-save]").disabled');
      assert.equal(await js('document.querySelector("[name=viewScope]").value'),'companion:a');
      assert.equal(await js('document.querySelector("[name=relationship]").value'),'会话 a 的未保存草稿');
      await capture('scope-failure-light');
      await js('document.querySelector("[data-life-save]").click();void 0');await wait('document.querySelector("[data-life-feedback]").textContent.startsWith("已保存")');
      assert.equal(life.state(character.id,'companion:a').relationship,'会话 a 的未保存草稿');assert.equal(life.state(character.id,'companion:b').relationship,'属于 b');
      await js('scopeAudit.delay=true;scopeAudit.fail=true;var select=document.querySelector("[name=viewScope]");select.value="companion:b";select.dispatchEvent(new Event("change",{bubbles:true}));void 0');await wait('!!scopeAudit.release');
      await js('var select=document.querySelector("[name=viewScope]");select.value="companion:c";select.dispatchEvent(new Event("change",{bubbles:true}));scopeAudit.release();void 0');
      await wait('!document.querySelector("[data-life-save]").disabled');assert.equal(await js('document.querySelector("[name=viewScope]").value'),'companion:a');
      await js('scopeAudit.delay=false;var select=document.querySelector("[name=viewScope]");select.value="companion:c";select.dispatchEvent(new Event("change",{bubbles:true}));void 0');
      await wait('document.querySelector("[name=relationship]").value==="属于 c"&&!document.querySelector("[data-life-save]").disabled');
      assert.equal(await js('document.querySelector("[name=viewScope]").value'),'companion:c');
      await js('scopeAudit.delay=true;scopeAudit.fail=true;scopeAudit.release=null;var select=document.querySelector("[name=viewScope]");select.value="companion:b";select.dispatchEvent(new Event("change",{bubbles:true}));void 0');await wait('!!scopeAudit.release');
      await js(`(async()=>{const {openCharacterLife}=await import('/character-life.js');openCharacterLife(auditContext,{moduleId:'companion',conversationId:'c'});scopeAudit.release();})()`);
      await wait('!!document.querySelector("[data-life-panel=profile]")');await js('document.querySelector("[data-life-tab=state]").click();document.documentElement.dataset.theme="dark";void 0');
      await wait('document.querySelector("[name=relationship]")?.value==="属于 c"');await capture('scope-current-dark');
      assert.doesNotMatch(await js('document.querySelector("[data-life-feedback]").textContent'),/新会话读取失败/);
    }else{
      // A local color swatch exercises real image decoding and layout without external traffic.
      const {createServer}=await import('node:http'),{nativeImage}=createRequire(import.meta.url)('electron');
      const bitmap=Buffer.alloc(192*128*4);for(let offset=0;offset<bitmap.length;offset+=4){const second=Math.floor(offset/4)%192>=96;bitmap.set(second?[186,212,246,255]:[229,203,216,255],offset);}
      const png=nativeImage.createFromBitmap(bitmap,{width:192,height:128}).toPNG();
      let imageRequests=0,failImage=false;
      const imageServer=createServer((req,res)=>{imageRequests++;res.writeHead(failImage?503:200,{'content-type':'image/png'});res.end(failImage?'':png);});await new Promise(done=>imageServer.listen(0,'127.0.0.1',done));
      try{
        await api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');
        const instance=(await api('/api/instances',{moduleId:'companion-lite',name:'贴纸回归'})).instance,prefix='/instances/'+instance.id;
        await installCharacterPackages(backend.url+prefix,'companion-lite');
        const persona=(await api('/api/instances/'+instance.id+'/persona',{source:'library',characterId:character.id})).character;
        await api(prefix+'/api/characters/'+persona.id+'/life/settings',{mode:'lite',memory:{autoExtract:false},media:{memes:[{id:'wave',name:'挥手',url:'http://127.0.0.1:'+imageServer.address().port+'/wave.gif',tags:[]}]}});
        const result=await api(prefix+'/api/modules/companion-lite/chat',{text:'用文字和贴纸挥手'});assert.equal(result.actions.length,1,JSON.stringify(result));
        const history=await api(prefix+'/api/modules/companion-lite/state');assert.equal(history.messages.at(-1).actions.length,1,JSON.stringify(history));assert.ok(history.messages.at(-1).actions[0].url.startsWith(prefix+'/api/'));
        await js(`(async()=>{const {mount}=await import('/modules/companion-lite.js');const {Drafts}=await import('/drafts.js');window.auditMount=async()=>{document.querySelector('#lite-audit-root')?.remove();const root=document.createElement('div');root.id='lite-audit-root';document.querySelector('#page-content').replaceChildren(root);window.liteController=new AbortController();await mount(root,{instanceId:${JSON.stringify(instance.id)},signal:liteController.signal,api:async path=>(await fetch(${JSON.stringify(prefix)}+path)).json(),characters:{getSelected:()=>(${JSON.stringify(persona)})},state:{characters:[${JSON.stringify(persona)}],selectedCharacterId:${JSON.stringify(persona.id)},modules:[{id:'companion-lite',name:'精简陪伴'}]},drafts:new Drafts(),immersion:{enter:async()=>{}}});};await auditMount();})()`);
        await wait('!!document.querySelector(".lite-message-image")');await wait('document.querySelector(".lite-message-image").naturalWidth>0');
        assert.equal(await js('document.querySelectorAll(".lite-message-image").length'),1);assert.match(await js('document.querySelector("[data-lite-messages]").textContent'),/你好/);
        await capture('lite-sticker-light');await js('liteController.abort();document.documentElement.dataset.theme="dark";auditMount()');
        await wait('document.querySelector(".lite-message-image")?.naturalWidth>0');await capture('lite-sticker-dark');
        failImage=true;
        await api(prefix+'/api/modules/companion-lite/chat',{text:'再挥手一次'});await js('liteController.abort();auditMount()');
        await wait('Array.from(document.querySelectorAll(".lite-image-error")).some(node=>!node.hidden)');
        assert.match(await js('document.querySelector("[data-lite-messages]").textContent'),/图片加载失败/);
        await capture('lite-sticker-error-dark');
        const beforeRetry=imageRequests;failImage=false;
        await js('Array.from(document.querySelectorAll(".lite-image-error")).filter(node=>!node.hidden).forEach(node=>node.querySelector("button").click());void 0');
        await wait('Array.from(document.querySelectorAll(".lite-message-image")).every(node=>!node.hidden&&node.naturalWidth>0)');assert.ok(imageRequests>beforeRetry);
      }finally{await new Promise(done=>imageServer.close(done));}
    }
    console.log('CHARACTER_AUDIT_UI_OK '+kind);
  }finally{window.destroy();await backend.close();}
}
const kind=process.argv.find(value=>value.startsWith('--character-audit='))?.split('=')[1];
if(kind)run(kind).then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else for(const scenario of ['scope','media'])test('角色审计 Electron 行为回归：'+scenario,{skip:!electron,timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'character-audit-ui-')),env={...process.env,CHARACTER_AUDIT_TEST_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--character-audit='+scenario],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(done=>child.once('exit',done));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
  const code=await new Promise((done,reject)=>{child.once('exit',done);child.once('error',reject);});assert.equal(code,0,output);assert.match(output,/CHARACTER_AUDIT_UI_OK/);
});
