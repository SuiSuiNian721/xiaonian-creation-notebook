import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
function wav(){const bytes=Buffer.alloc(48044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);return bytes;}
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.AI_FUTURE_VOICE_RECOVERY_DIR,'electron'));app.on('window-all-closed',()=>{});await app.whenReady();
  const staticRoot=join(root,'public-workbench'),server=createServer(async(req,res)=>{try{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/voice-studio.css"><title>声音恢复回归</title><main id="root" style="padding:24px"></main></html>');return;}
    if(/^\/audio-[ABC]\.wav$/.test(path)){res.setHeader('content-type','audio/wav');res.end(wav());return;}
    const target=resolve(staticRoot,'.'+decodeURIComponent(path));if(!target.startsWith(staticRoot+sep))throw new Error('invalid path');
    res.setHeader('content-type',({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[extname(target)]||'application/octet-stream');res.end(await readFile(target));
  }catch{res.statusCode=404;res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  const js=code=>window.webContents.executeJavaScript(code,true),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,source)=>{const end=Date.now()+10000;while(Date.now()<end){if(await js(source))return;await pause(30);}throw new Error('等待超时：'+label);};
  const output=join(root,'artifacts/full-bugfix-20261110/resources');await mkdir(output,{recursive:true});
  const shot=async name=>{await pause(120);await writeFile(join(output,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  try{
    await window.loadURL('http://127.0.0.1:'+server.address().port);
    await js(`(async()=>{window.abort=new AbortController();window.savedCallbacks=[];window.nextJob='B';window.holdSave=false;
      window.studioState={busy:false,canCancel:false,voices:[],job:{id:'job-A',status:'completed',stage:'completed',result:{id:'audio-A',url:'/audio-A.wav'}},resources:{config:{provider:'moss'},components:[]}};
      const drafts=new Map();window.ctx={signal:abort.signal,state:{selectedCharacterId:'character-A'},drafts:{read:(k,v)=>drafts.get(k)||v,write:(k,v)=>drafts.set(k,v),commit:()=>{}},action:async(b,fn)=>fn(),api:async(path,options={})=>{
        if(path==='/api/state')return {characters:[{id:'character-A',name:'测试角色'}]};
        if(path==='/api/voice-studio/save'){const voice={id:'voice-'+options.body.jobId.slice(-1),name:options.body.name};if(holdSave)await new Promise(resolve=>window.resolveSave=resolve);studioState.voices.push(voice);return voice;}
        if(path==='/api/voice-studio/jobs'){studioState.job={id:'job-'+nextJob,status:'completed',stage:'completed',result:{id:'audio-'+nextJob,url:'/audio-'+nextJob+'.wav'}};return structuredClone(studioState);}
        return structuredClone(studioState);
      }};await import('/voice-studio.js').then(m=>m.mountVoiceStudio(document.querySelector('#root'),ctx,{mode:'design',onSaved:voice=>savedCallbacks.push(voice.id)}));})()`);
    await js(`document.querySelector('#studio-name').value='已保存声音 A';document.querySelector('[data-studio-save-form]').requestSubmit();`);
    await wait('A 保存完成',`document.querySelector('[data-studio-save-feedback]').textContent==='已保存到音色库'`);
    await js(`document.querySelector('[data-studio-link-character]').click();`);
    await wait('A 关联弹窗',`!!document.querySelector('dialog [name=voiceId]')`);
    assert.equal(await js(`document.querySelector('dialog [name=voiceId]').value`),'voice-A');
    await js(`document.querySelector('dialog').close();document.querySelector('#studio-instruction').value='新声音';document.querySelector('#studio-text').value='新的试听台词';document.querySelector('#studio-name').value='未保存声音 B';document.querySelector('[data-studio-form]').requestSubmit();`);
    await wait('B 试听就绪',`document.querySelector('[data-studio-player]').src.endsWith('/audio-B.wav')&&!document.querySelector('[data-studio-save-form]').hidden`);
    await shot('voice-new-candidate');
    assert.equal(await js(`document.querySelector('[data-studio-save-feedback]').textContent`),'');
    assert.equal(await js(`document.querySelector('[data-studio-link-character]').hidden`),true);
    await js(`document.querySelector('[data-studio-link-character]').click();`);
    assert.equal(await js(`!!document.querySelector('dialog[open]')`),false,'隐藏入口也不得关联旧声音');
    await js(`holdSave=true;document.querySelector('[data-studio-save-form]').requestSubmit();`);
    await wait('B 保存等待',`typeof resolveSave==='function'`);
    await js(`nextJob='C';document.querySelector('#studio-name').value='未保存声音 C';document.querySelector('[data-studio-form]').requestSubmit();`);
    await wait('C 试听就绪',`document.querySelector('[data-studio-player]').src.endsWith('/audio-C.wav')`);
    await js(`resolveSave();`);await wait('B 保存返回',`savedCallbacks.includes('voice-B')`);
    assert.equal(await js(`document.querySelector('[data-studio-save-feedback]').textContent`),'');
    assert.equal(await js(`document.querySelector('[data-studio-link-character]').hidden`),true,'B 的迟到保存响应不得关联 C');
    await js(`holdSave=false;document.querySelector('[data-studio-save-form]').requestSubmit();`);
    await wait('C 保存完成',`savedCallbacks.includes('voice-C')`);
    assert.equal(await js(`document.querySelector('[data-studio-link-character]').hidden`),false);
    await shot('voice-current-saved');assert.deepEqual(errors,[]);
    await writeFile(join(output,'voice-ui-result.json'),JSON.stringify({ok:true,realInference:false,savedCallbacks:await js('savedCallbacks'),staleSaveIgnored:true},null,2)+'\n','utf8');
    console.log('VOICE_RECOVERY_UI_RESULT ok');
  }finally{await js('abort.abort()').catch(()=>{});window.destroy();await new Promise(done=>server.close(done));}
}
if(process.argv.includes('--voice-recovery-electron'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('声音保存与角色关联只属于当前候选，迟到保存响应不污染下一份试听',{skip:!electron,timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-recovery-ui-')),env={...process.env,AI_FUTURE_VOICE_RECOVERY_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--voice-recovery-electron'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const [code]=await once(child,'exit');assert.equal(code,0,output);assert.match(output,/VOICE_RECOVERY_UI_RESULT ok/);
});
