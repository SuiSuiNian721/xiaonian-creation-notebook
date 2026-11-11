// Run with Electron after qa-workbench-mcp.mjs has produced its isolated data.
import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkbench} from '../framework/server.mjs';

const directory=resolve('artifacts/unified-mcp-qa');
app.setPath('userData',join(directory,'electron'));app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
const report=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));
const backend=await createWorkbench({dataDir:join(directory,'data')});
const window=new BrowserWindow({show:false,width:1420,height:960,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
const js=code=>window.webContents.executeJavaScript(code);
const wait=async code=>{for(let i=0;i<200;i++){if(await js(code))return;await delay(50);}throw new Error('等待界面超时：'+code);};
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
const screenshot=async name=>{
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  window.webContents.invalidate();await delay(200);
  await writeFile(join(directory,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
};
try{
  const config=await fetch(backend.url+'/api/ai/mcp').then(r=>r.json());
  const started=await fetch(config.http.url,{method:'POST',headers:{'content-type':'application/json',...config.http.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'workbench_instance_start',arguments:{instanceId:report.instanceId}}})}).then(r=>r.json());
  assert.equal(started.result.isError,undefined,JSON.stringify(started));
  await window.loadURL(backend.url+'#/module/drawing');
  await wait(`Boolean(document.querySelector('[data-instance-select="${report.instanceId}"]'))`);
  await click(`[data-instance-select="${report.instanceId}"]`);
  await wait(`document.querySelector('.instance-panel:not([hidden])')?.dataset.instanceId===${JSON.stringify(report.instanceId)}`);
  await wait(`Boolean(document.querySelector('#drawing-jobs img'))`);
  await wait(`document.querySelector('#drawing-jobs img')?.complete&&document.querySelector('#drawing-jobs img')?.naturalWidth===512`);
  assert.ok(await js(`document.querySelector('#drawing-workflow').textContent.includes('MCP SDK 真实模型出图')`));
  await js("document.querySelector('[data-tour-skip]')?.click();void 0");
  await screenshot('desktop-generated-result');
  await click('#tab-workflows');
  await wait("Boolean(document.querySelector('.drawing-mcp-tools'))");
  assert.equal(await js("Boolean(document.querySelector('#drawing-mcp-form'))"),false);
  assert.ok(await js("document.querySelector('.drawing-mcp-tools').textContent.includes('comfy_manager_plan')"));
  await click('#module-panel a[href="#/settings"]');
  await wait("Boolean(document.querySelector('#shared-ai-form'))");
  assert.equal(await js("document.querySelector('[name=mcpEnabled]').checked"),true);
  assert.ok(await js("document.querySelector('[name=mcpEnabled]').closest('label').textContent.includes('工作台 MCP')"));
  await js("document.querySelector('#mcp-export').closest('details').open=true;void 0");
  let downloaded;
  window.webContents.session.once('will-download',(_event,item)=>{item.setSavePath(join(directory,'exported-client.json'));downloaded=new Promise((accept,reject)=>item.once('done',(_event,status)=>status==='completed'?accept():reject(new Error(status))));});
  await click('#mcp-export');
  for(let i=0;i<100&&!downloaded;i++)await delay(20);
  assert.ok(downloaded);await downloaded;
  const exported=JSON.parse(await readFile(join(directory,'exported-client.json'),'utf8'));
  assert.deepEqual(exported.mcpServers['ai-future-workbench'],config.stdio);
  await screenshot('desktop-unified-mcp');
  assert.deepEqual(errors,[]);
  await writeFile(join(directory,'ui-result.json'),JSON.stringify({passed:true,realElectron:true,visibleGeneratedImage:true,instanceId:report.instanceId,globalSettingsNavigation:true,exportedStdioConfiguration:true,consoleErrors:errors},null,2)+'\n','utf8');
  console.log('UNIFIED_MCP_UI passed');
}catch(error){console.error(error);await screenshot('desktop-failure').catch(()=>{});process.exitCode=1;}
finally{window.destroy();await backend.close();app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
