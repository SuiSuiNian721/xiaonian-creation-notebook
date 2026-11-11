import electron from 'electron';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';

// Uses the real WAV cached by qa-shared-voice.mjs; no second GPU inference.
const directory=resolve(process.env.AI_FUTURE_VOICE_QA_DIR||'qa/shared-voice-1794122758300');
const {app,BrowserWindow}=electron;
app.setPath('userData',join(directory,'ui-profile'));
async function run(){
await mkdir(directory,{recursive:true});
const runtime=await createWorkbench({dataDir:join(directory,'profile')});
runtime.context.store.setEnabled('voice',true);
const window=new BrowserWindow({show:false,width:1420,height:960,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
window.webContents.setAudioMuted(true);
const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
const js=code=>window.webContents.executeJavaScript(code,true);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(label,predicate){const end=Date.now()+30000;while(Date.now()<end){if(await predicate())return;await pause(100);}throw new Error('等待超时：'+label);}
const report={ok:false,realCachedWav:true,mutedPlayback:true,errors};
try{
  await window.loadURL(runtime.url+'/#/module/voice');
  await wait('声音界面',()=>js("!!document.querySelector('[data-voice-form]')"));
  await js("document.querySelector('[data-tour-skip]')?.click();void 0");
  await js("document.querySelector('[data-voice-start]').click();void 0");
  await wait('固定测试音色',()=>js("document.querySelector('#shared-voice')?.selectedOptions[0]?.textContent.includes('测试音色')"));
  await js("document.querySelector('#voice-text').value='念念，我在这里。今天也想和你一起，发现一点温暖的小事情。';document.querySelector('[data-voice-form]').requestSubmit();void 0");
  await wait('完整 WAV 播放器',()=>js("document.querySelector('[data-voice-player]')?.hidden===false"));
  await wait('音频可解码',()=>js("Number.isFinite(document.querySelector('audio').duration)&&document.querySelector('audio').duration>0"));
  await js("document.querySelector('audio').play();void 0");
  await wait('实际播放推进',()=>js("document.querySelector('audio').currentTime>0.2"));
  report.player=await js("(()=>{const a=document.querySelector('audio');return {duration:a.duration,currentTime:a.currentTime,paused:a.paused,error:a.error?.code??null}})()");
  assert.equal(report.player.paused,false);assert.equal(report.player.error,null);
  await js("document.querySelector('audio').pause();void 0");
  await writeFile(join(directory,'角色声音_桌面验证.png'),(await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);report.ok=true;
}catch(error){report.error=error.stack;await writeFile(join(directory,'声音界面_失败.png'),(await window.webContents.capturePage()).toPNG());process.exitCode=1;}
finally{
  await writeFile(join(directory,'ui-result.json'),JSON.stringify(report,null,2)+'\n','utf8');
  window.destroy();await runtime.close();console.log(JSON.stringify(report));app.exit(report.ok?0:1);
}
}
app.whenReady().then(run).catch(error=>{console.error(error);app.exit(1);});
