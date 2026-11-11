import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
const audioPath='/internal/voice-audio/'+'a'.repeat(64)+'/'+'b'.repeat(64);

function browserFixture(){
  const fixture=window.voiceTest={state:{configured:true,running:false,busy:false,queued:0},calls:[],messages:[]};
  fixture.drafts=new Map();fixture.mediaUpdates=[];
  fixture.life={character:{id:'character',name:'小璃',raw:{}},settings:{mode:'full',enabled:true,memory:{enabled:true},media:{voiceEnabled:true,voiceId:'xiaoli-warm-bright',voiceMode:'requested'}},state:{scope:'shared'},tools:[]};
  fixture.mount=async(kind,instanceId)=>{
    fixture.controller?.abort();fixture.controller=new AbortController();
    const ctx={signal:fixture.controller.signal,instanceId,state:{selectedCharacterId:'character',characters:[fixture.life.character],modules:[{id:'companion-lite',name:'精简陪伴'}]},
      drafts:{read:(key,value)=>fixture.drafts.has(key)?structuredClone(fixture.drafts.get(key)):value,write:(key,value)=>fixture.drafts.set(key,structuredClone(value)),commit:key=>fixture.drafts.delete(key)},characters:{getSelected:()=>({id:'character',name:'小璃'})},
      action:async(_node,operation)=>operation(),
      fetch:async(path,options={})=>{
        if(path.startsWith('/api/characters/character/life?'))return Response.json(structuredClone(fixture.life));
        if(path==='/api/characters/character/life/settings'){
          const patch=JSON.parse(options.body);fixture.mediaUpdates.push(patch.media);Object.assign(fixture.life.settings.media,patch.media);return Response.json({settings:fixture.life.settings});
        }
        throw new Error('未准备的角色测试接口 '+path);
      },
      api:async(path,options={})=>{
        fixture.calls.push(path);
        if(path==='/api/characters/character/life/settings'){fixture.mediaUpdates.push(options.body.media);Object.assign(fixture.life.settings.media,options.body.media);return {settings:fixture.life.settings};}
        if(path.endsWith('/resources'))return {prerequisitesReady:true};
        if(path==='/api/modules/companion-lite/state')return {character:{name:'小璃'},messages:fixture.messages};
        if(path==='/api/voice/config')return {config:{}};
        if(path==='/api/voice/state')return structuredClone(fixture.state);
        if(path==='/api/voice/voices')throw new Error('服务未启动');
        if(path==='/api/voice/speech'){
          fixture.state.busy=true;
          return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('等待已取消')),{once:true}));
        }
        throw new Error('未准备的测试接口 '+path);
      }};
    if(kind==='life')window.openCharacterLife(ctx,{moduleId:'qq'});
    else await (kind==='lite'?window.mountLite:window.mountVoice)(document.querySelector('#root'),ctx);
  };
}

async function runBrowserTests(kind){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();
  app.setPath('userData',process.env.AI_FUTURE_VOICE_UI_DIR);
  app.on('window-all-closed',()=>{});await app.whenReady();
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    if(req.url==='/test'){
      res.setHeader('content-type','text/html;charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/character-life.css"><div id="root"></div><script type="module">import {mount as mountLite} from '/modules/companion-lite.js';import {mount as mountVoice} from '/modules/voice.js';import {openCharacterLife} from '/character-life.js';Object.assign(window,{mountLite,mountVoice,openCharacterLife});(${browserFixture.toString()})();window.mounted=true;</script>`);
    }
    try{const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}
    catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  const window=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){throw new Error(error.message+'\n'+source+'\n'+errors.join('\n'));}},pause=ms=>new Promise(resolvePause=>setTimeout(resolvePause,ms));
  const wait=async(label,source)=>{const end=Date.now()+6000;while(Date.now()<end){if(await js(source))return;await pause(40);}throw new Error('等待超时：'+label);};
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('测试模块加载','window.mounted');
    if(kind==='lite'){
      for(const instanceId of [undefined,'11111111-1111-4111-8111-111111111111']){
        const prefix=instanceId?'/instances/'+instanceId:'';
        await js(`(async()=>{voiceTest.messages=[{role:'assistant',content:'你好',actions:${JSON.stringify([
          {type:'record',url:prefix+audioPath},
          {type:'record',url:'http://127.0.0.1:12345'+prefix+audioPath},
          {type:'record',url:'https://example.invalid'+prefix+audioPath},
          {type:'record',url:'//example.invalid'+prefix+audioPath},
          {type:'record',url:'/api/voice/state'},
          {type:'record',url:'/instances/22222222-2222-4222-8222-222222222222'+audioPath},
        ])}}];voiceTest.messages[0].actions.push({type:'record',url:location.origin+${JSON.stringify(prefix+audioPath)}});await voiceTest.mount('lite',${JSON.stringify(instanceId)});})()`);
        assert.equal(await js(`document.querySelectorAll('audio').length`),2,'仅显示当前实例的相对路径及当前同源签名语音');
        assert.deepEqual(await js(`[...document.querySelectorAll('audio')].map(node=>new URL(node.src).pathname)`),[prefix+audioPath,prefix+audioPath]);
      }
    }else if(kind==='mode'){
      const mode='[data-character-life] [name="media.voiceMode"]';
      const closeAndReopen=async()=>{await js(`document.querySelector('[data-life-close]').click();voiceTest.drafts.clear();voiceTest.mount('life');void 0`);await wait('重开声音设置',`!!document.querySelector(${JSON.stringify(mode)})`);};
      const save=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);await wait('声音设置保存',`document.querySelector('[data-life-feedback]').textContent==='已保存'`);};
      await js(`voiceTest.mount('life');void 0`);await wait('语音发送模式选择',`!!document.querySelector(${JSON.stringify(mode)})`);
      assert.deepEqual(await js(`(()=>{const node=document.querySelector(${JSON.stringify(mode)});return {label:node.labels[0]?.textContent,options:[...node.options].map(item=>[item.value,item.textContent]),value:node.value};})()`),{label:'语音发送',options:[['requested','仅在明确要求时'],['always','每条回复']],value:'requested'});
      await js(`document.querySelector(${JSON.stringify(mode)}).value='always';void 0`);await save('[data-life-save-shared-voice]');
      assert.equal(await js('voiceTest.mediaUpdates.at(-1).voiceMode'),'always');
      await closeAndReopen();assert.equal(await js(`document.querySelector(${JSON.stringify(mode)}).value`),'always','人设声音模式从已保存设置重开');
      await js(`document.querySelector('[data-life-tab="tools"]').click();void 0`);await wait('工具声音模式',`!!document.querySelector('[data-life-panel="tools"] [name="media.voiceMode"]')`);
      assert.equal(await js(`document.querySelector(${JSON.stringify(mode)}).labels[0]?.textContent`),'语音发送');
      assert.equal(await js(`document.querySelector(${JSON.stringify(mode)}).value`),'always');
      await js(`document.querySelector(${JSON.stringify(mode)}).value='requested';document.querySelector('[name="media.voiceEnabled"]').checked=false;void 0`);await save('[data-life-save-media]');
      assert.equal(await js('voiceTest.mediaUpdates.at(-1).voiceMode'),'requested');assert.equal(await js('voiceTest.mediaUpdates.at(-1).voiceEnabled'),false);
      await closeAndReopen();assert.equal(await js(`document.querySelector(${JSON.stringify(mode)}).value`),'requested','工具保存的模式在人设声音设置重开保留');
      assert.equal(await js(`document.querySelector('[name="media.voiceEnabled"]').checked`),false,'声音总开关独立保留');
      await js(`document.querySelector('[data-life-tab="tools"]').click();void 0`);assert.equal(await js(`document.querySelector(${JSON.stringify(mode)}).value`),'requested','工具声音模式重新打开保留');
      await js(`document.querySelector('[data-life-tab="profile"]').click();document.querySelector(${JSON.stringify(mode)}).value='always';void 0`);await save('[data-life-save-shared-voice]');
      await js(`document.querySelector('[data-life-tab="tools"]').click();void 0`);assert.equal(await js(`document.querySelector(${JSON.stringify(mode)}).value`),'always','人设保存后工具草稿同步已保存的声音模式');
    }else if(kind==='bind'){
      await js(`(async()=>{voiceTest.state.voiceId='xiaoli-warm-bright';voiceTest.life.settings.media.voiceMode='always';await voiceTest.mount('voice');document.querySelector('[data-voice-bind]').click();})()`);
      await wait('当前角色音色绑定',`document.querySelector('[data-voice-feedback]').textContent==='当前角色已使用此音色'`);
      assert.deepEqual(await js('voiceTest.mediaUpdates.at(-1)'),{voiceEnabled:true,voiceId:'xiaoli-warm-bright',voiceMode:'requested',voiceTool:''});
      await js(`document.querySelector('#voice-text').value='你好';document.querySelector('[data-voice-form]').requestSubmit();void 0`);
      await wait('仅请求时模式仍可手动试听',`voiceTest.calls.includes('/api/voice/speech')&&!document.querySelector('[data-voice-cancel]').hidden`);
      await js(`document.querySelector('[data-voice-cancel]').click();void 0`);await wait('结束手动试听',`document.querySelector('[data-voice-feedback]').textContent==='已取消等待'`);
    }else{
      await js(`(async()=>{await voiceTest.mount('voice');document.querySelector('#voice-text').value='你好';document.querySelector('[data-voice-form]').requestSubmit();})()`);
      await wait('正在等待合成',`!document.querySelector('[data-voice-cancel]').hidden`);
      await js(`document.querySelector('[data-voice-cancel]').click();void 0`);
      await wait('取消等待反馈',`document.querySelector('[data-voice-feedback]').textContent==='已取消等待'`);
      assert.equal(await js(`document.querySelector('[data-voice-stop]').disabled`),true,'取消等待后仍反映后端 busy');
      await js(`voiceTest.state.busy=false;voiceTest.state.running=true;void 0`);
      await wait('后台合成结束后恢复停止按钮',`!document.querySelector('[data-voice-stop]').disabled`);
      await js(`voiceTest.state.busy=true;void 0`);
      await wait('其他实例开始生成后同步繁忙状态',`document.querySelector('[data-voice-stop]').disabled`);
      assert.equal(await js(`voiceTest.calls.filter(path=>path==='/api/voice/voices').length`),1,'轮询仅获取 state，不反复探测声音服务');
      const count=await js(`voiceTest.controller.abort();voiceTest.calls.filter(path=>path==='/api/voice/state').length`);
      await pause(3300);
      assert.equal(await js(`voiceTest.calls.filter(path=>path==='/api/voice/state').length`),count,'卸载后清理状态轮询');
    }
    console.log('SHARED_VOICE_UI_RESULT '+kind);
  }finally{
    await js('voiceTest.controller?.abort();void 0').catch(()=>{});window.destroy();server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));
  }
}

if(process.argv.includes('--shared-voice-ui-electron')){
  runBrowserTests(process.argv.at(-1)).then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
}else{
  const names={lite:'精简陪伴在实际 DOM 回放同源签名语音，拒绝外部和跨实例地址',state:'角色声音在取消等待后同步后台状态，并在卸载时停止轮询',mode:'人设与工具的语音发送模式可访问、保存并重开保留',bind:'用于当前角色启用明确请求模式，手动试听仍可合成'};
  for(const kind of ['lite','state','mode','bind'])test(names[kind],{skip:!electron,timeout:25000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'shared-voice-ui-'));
    const env={...process.env,AI_FUTURE_VOICE_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(electron,[fileURLToPath(import.meta.url),'--shared-voice-ui-electron',kind],{cwd:root,env,windowsHide:true});
    t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolveExit=>child.once('exit',resolveExit));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',resolveExit);});
    assert.equal(code,0,output);assert.ok(output.includes('SHARED_VOICE_UI_RESULT '+kind),output);
  });
}
