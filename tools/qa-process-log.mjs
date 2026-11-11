import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWorkbench } from '../framework/server.mjs';
import { runManaged } from '../framework/drawing-repositories.mjs';

const require=createRequire(import.meta.url);
const {ProcessLogWindows,isLogClipboardWrite}=require('../desktop/process-log-window.cjs');
const directory=resolve(process.env.AI_FUTURE_PROCESS_LOG_QA_DIR || `qa/process-log-${Date.now()}`);
const comfy=join(directory,'ComfyUI');
const gate=join(directory,'finish-install');
mkdirSync(join(comfy,'comfy'),{recursive:true});
mkdirSync(join(comfy,'custom_nodes','Fixture'),{recursive:true});
mkdirSync(join(comfy,'models'),{recursive:true});
for(const file of ['main.py','nodes.py','server.py'])writeFileSync(join(comfy,file),'# isolated log viewer fixture\n','utf8');
writeFileSync(join(comfy,'custom_nodes','Fixture','requirements.txt'),'# No pip installation is executed in this fixture.\n','utf8');
const checks=[],errors=[],children=[],downloads=[];
const opened=[];
let ready=false;
let runtime,window,windows;
app.setPath('userData',join(directory,'profile'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const js=(target,code)=>target.webContents.executeJavaScript(code,true);
const click=(target,selector)=>js(target,`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
async function wait(label,test){const end=Date.now()+20000;while(Date.now()<end){if(await test())return;await delay(80);}throw new Error('等待超时：'+label);}
const text=(target,selector)=>js(target,`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
const capture=async(target,name)=>{await delay(120);writeFileSync(join(directory,name+'.png'),(await target.webContents.capturePage()).toPNG());};

app.whenReady().then(async()=>{
  try {
    function LogWindow(options){
      const target=new BrowserWindow({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});
      // Keep the isolated QA windows off the user's desktop.
      target.show=()=>{};target.focus=()=>{};
      target.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
      return target;
    }
    windows=new ProcessLogWindows({BrowserWindow:LogWindow,getBaseURL:()=>runtime.url,onError:error=>errors.push(error.message)});
    runtime=await createWorkbench({dataDir:join(directory,'data'),openProcessLog:source=>{windows.open(source);},openComfyUI:async url=>{opened.push(url);},startupOptions:{pollMs:50},
      drawingOptions:{WebSocketImpl:null,
        fetchImpl:async url=>{if(!ready||!children.some(child=>child.exitCode==null&&child.signalCode==null))throw Object.assign(new Error('isolated refused'),{cause:{code:'ECONNREFUSED'}});return new Response(JSON.stringify(new URL(url).pathname==='/system_stats'?{system:{},devices:[]}:{SaveImage:{output_node:true,input:{required:{images:['IMAGE']}}}}));},
        runtimeOptions:{spawnImpl:(_exe,_args,options)=>{const script="console.log('\\x1b[32m真实子进程 · 启动日志\\x1b[0m');for(let i=0;i<150;i++)console.log('加载节点 '+i+' · 中文日志');setInterval(()=>console.log('实时输出 '+Date.now()),120);";const child=spawn(process.execPath,['-e',script],{...options,env:{...options.env,ELECTRON_RUN_AS_NODE:'1'}});children.push(child);return child;}},
      },
      drawingManagerOptions:{isRunning:async()=>false,runner:async(exe,args,options)=>{
        if(!args.includes('install'))return {code:0,stdout:'Python isolated log fixture\n',stderr:''};
        const script="const fs=require('node:fs');console.log('正在安装中文依赖');setInterval(()=>{console.log('Requirement already satisfied: fixture');if(fs.existsSync(process.argv[1])){console.error('fixture intentional failure');process.exit(7);}},120);";
        return runManaged('node',['-e',script,gate],{...options,timeoutMs:15000});
      }},
    });
    const api=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(runtime.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});assert.equal(response.status,200,path);return response.json();};
    await api('/api/modules/comfyui/enable',{});
    await api('/api/modules/comfyui/config',{values:{comfyPath:comfy,serviceUrl:'http://127.0.0.1:19888'}},'PUT');
    await api('/api/modules/drawing/runtime/settings',{pythonPath:process.execPath});
    window=new BrowserWindow({width:1420,height:960,show:false,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    window.webContents.setWindowOpenHandler(details=>windows.handleWindowOpen(details));
    window.webContents.session.setPermissionRequestHandler((contents,permission,callback)=>callback(!!contents&&!contents.isDestroyed()&&isLogClipboardWrite(runtime.url,contents.getURL(),permission)));
    window.webContents.session.on('will-download',(_event,item)=>{const path=join(directory,'exported-'+downloads.length+'.log');item.setSavePath(path);item.once('done',(_event,result)=>downloads.push({path,result}));});
    await window.loadURL(runtime.url+'#/module/comfyui');
    await wait('启动页',()=>js(window,"Boolean(document.querySelector('#runtime-launch'))"));
    await click(window,'#runtime-launch');
    await wait('自动独立窗口',()=>windows.windows.has('runtime'));
    let log=windows.windows.get('runtime');
    await wait('实时启动日志',async()=> (await text(log,'#log-output')).includes('真实子进程'));
    assert.doesNotMatch(await text(log,'#log-output'),/\x1b/);
    assert.equal(await text(log,'#log-status'),'进程运行中');
    checks.push('通过启动器点击启动后自动打开真实子进程输出，去除终端控制符');
    assert.equal(opened.length,0);ready=true;await wait('服务就绪后自动打开浏览器',()=>opened.length===1);await delay(120);assert.equal(opened.length,1);
    checks.push('进程启动不会提前打开浏览器，完整服务握手就绪后自动打开一次');
    await click(window,'#runtime-log-window');await delay(120);assert.equal(windows.windows.size,1);
    await js(log,"document.querySelector('#log-output').scrollTop=0;document.querySelector('#log-output').dispatchEvent(new Event('scroll'));void 0");
    await delay(1300);assert.equal(await js(log,"document.querySelector('#log-output').scrollTop"),0);assert.equal(await js(log,"document.querySelector('#log-follow').checked"),false);
    await click(log,'#log-follow');
    assert.equal(await js(log,"(()=>{const node=document.querySelector('#log-output');return node.scrollHeight-node.scrollTop-node.clientHeight<24;})()"),true);
    checks.push('重复打开复用窗口；向上滚动暂停跟随，可恢复滚动到底部');
    await js(log,"Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copiedLog=value;}}});void 0");
    await click(log,'#log-copy');assert.match(await js(log,'window.__copiedLog'),/中文日志/);
    await click(log,'#log-save');await wait('保存日志',()=>downloads.length===1);
    assert.equal(downloads[0].result,'completed');assert.match(readFileSync(downloads[0].path,'utf8'),/真实子进程/);
    await capture(log,'runtime-desktop');
    log.close();await wait('原日志窗口关闭',()=>!windows.windows.has('runtime'));assert.equal(children[0].exitCode,null);assert.equal(children[0].signalCode,null);
    await click(window,'#runtime-log-window');await wait('重开日志窗口',()=>windows.windows.has('runtime'));
    log=windows.windows.get('runtime');await wait('重开可读',async()=> (await text(log,'#log-output')).includes('实时输出'));
    checks.push('复制与真实文件导出通过；关闭日志不停止进程，重开继续读取');
    await click(window,'#runtime-stop');await wait('停止确认',async()=> !(await window.webContents.executeJavaScript("document.querySelector('#runtime-stop-confirmation').hidden")));await click(window,'#runtime-stop-confirm');await wait('停止完成',async()=> (await text(window,'#runtime-feedback')).includes('已停止'));
    await click(window,'#tab-resources');await wait('管理页',()=>js(window,"Boolean(document.querySelector('#manager-scan'))"));
    await click(window,'#manager-scan');await wait('插件索引',()=>js(window,"Boolean(document.querySelector('[data-repository=\"plugin:Fixture\"]'))"));
    await click(window,'[data-section="plugins"]');await click(window,'[data-repository="plugin:Fixture"]');
    await click(window,'#repository-dependencies');await wait('依赖预览',()=>js(window,"Boolean(document.querySelector('#plan-apply'))"));
    await click(window,'#plan-apply');
    await wait('安装窗口自动打开',()=>[...windows.windows.keys()].some(key=>key!=='runtime'));
    const taskId=[...windows.windows.keys()].find(key=>key!=='runtime');
    let taskWindow=windows.windows.get(taskId);
    await wait('安装完成前有输出',async()=> (await text(taskWindow,'#log-output')).includes('正在安装中文依赖'));
    assert.equal(await text(taskWindow,'#log-status'),'执行中');
    taskWindow.close();await wait('安装日志窗口关闭',()=>!windows.windows.has(taskId));
    const running=await api('/api/modules/drawing/manager/tasks/'+taskId+'/logs');assert.equal(running.task.status,'running');
    await wait('任务日志入口',()=>js(window,`Boolean(document.querySelector('a[href="/process-log.html?task=${taskId}"]'))`));
    await click(window,`a[href="/process-log.html?task=${taskId}"]`);await wait('任务日志重开',()=>windows.windows.has(taskId));taskWindow=windows.windows.get(taskId);
    writeFileSync(gate,'finish','utf8');
    await wait('安装失败状态',async()=> (await text(taskWindow,'#log-status'))==='失败');
    assert.match(await text(taskWindow,'#log-notice'),/依赖安装失败/);assert.match(await text(taskWindow,'#log-output'),/intentional failure/);
    await capture(taskWindow,'install-failed');
    checks.push('依赖预览并应用后自动显示安装实时输出；关闭不取消，失败原因与输出保留');
    taskWindow.setMinimumSize(360,360);taskWindow.setContentSize(390,660);await delay(100);
    assert.equal(await js(taskWindow,'document.documentElement.scrollWidth<=innerWidth'),true);
    assert.equal(await js(taskWindow,"document.querySelector('#log-output').getBoundingClientRect().bottom<=innerHeight+1"),true);
    await capture(taskWindow,'narrow');
    taskWindow.webContents.setZoomFactor(2);await delay(120);assert.equal(await js(taskWindow,'document.documentElement.scrollWidth<=innerWidth'),true);
    checks.push('窄窗与200%缩放无页面横向溢出，日志区域保持可滚动');
    await runtime.close();runtime=null;
    await wait('断开明确提示',async()=> (await text(taskWindow,'#log-status'))==='读取失败');
    assert.equal(errors.length,0,errors.join('\n'));
    writeFileSync(join(directory,'result.json'),JSON.stringify({ok:true,checks,errors,downloads,realComfyStarted:false,realDependencyInstallation:false,actualChildProcessOutput:true,clipboardAdapter:true},null,2),'utf8');
  }catch(error){
    writeFileSync(join(directory,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2),'utf8');
    for(const [key,target] of windows?.windows || [])if(!target.isDestroyed())await capture(target,'failure-'+key).catch(()=>{});
    process.exitCode=1;
  }finally{
    if(!existsSync(gate))writeFileSync(gate,'finish','utf8');
    windows?.closeAll();window?.destroy();await runtime?.close();
    for(const child of children)if(child.exitCode==null&&child.signalCode==null)child.kill();
    app.exit(process.exitCode || 0);
  }
});
