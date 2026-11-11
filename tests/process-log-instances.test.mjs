import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {createWorkbench} from '../framework/server.mjs';
import {WorkbenchStore} from '../framework/store.mjs';

const taskId='565e6d56-e5cc-4e55-8910-fcded6ba43ac';
const require=createRequire(import.meta.url);
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'process-log-instances-'));
  const opened=[];
  const app=await createWorkbench({dataDir:directory,openProcessLog:source=>opened.push(source),instanceOptionsFactory:()=>({drawingOptions:{WebSocketImpl:null,fetchImpl:async url=>new Response(JSON.stringify(new URL(url).pathname==='/system_stats'?{system:{},devices:[]}:{SaveImage:{output_node:true,input:{required:{images:['IMAGE']}}}}))}})});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  app.context.store.setEnabled('comfyui',true);
  const manager=app.context.instanceManager,instance=await manager.create({moduleId:'comfyui'},{start:false});
  const store=new WorkbenchStore(manager.directory(instance.id));
  store.setSetting('drawing.manager.tasks',[{id:taskId,title:'实例任务',status:'completed',log:'实例管理日志',error:null}]);store.close();
  await manager.start(instance.id);
  const runtime=manager.runtimes.get(instance.id).context.drawing.runtime;
  await mkdir(dirname(runtime.logFile),{recursive:true});await writeFile(runtime.logFile,'实例服务日志','utf8');
  const api=async path=>{const response=await fetch(app.url+path);return {status:response.status,...await response.json()};};
  return {app,instance,opened,api};
}

async function page(app,search){
  const nodes=new Map(),requests=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',dataset:{},checked:true,scrollTop:0,scrollHeight:0,clientHeight:0,contains:()=>false,addEventListener(){}});return nodes.get(selector);};
  runInNewContext(await readFile(new URL('../public-workbench/process-log.js',import.meta.url),'utf8'),{
    URLSearchParams,URL,AbortController,location:{search},document:{querySelector:node},getSelection:()=>null,addEventListener(){},setTimeout:()=>0,clearTimeout(){},
    fetch:async(path,options)=>{const response=await fetch(app.url+path,options);requests.push({path,status:response.status});return response;},
  });
  const end=Date.now()+3000;while(!node('#log-status').textContent&&Date.now()<end)await new Promise(done=>setTimeout(done,10));
  return {requests,text:node('#log-output').textContent,status:node('#log-status').textContent,notice:node('#log-notice').textContent};
}

test('独立管理日志页面应读取所属实例任务',async t=>{
  const {app,instance,api}=await fixture(t);
  const scoped=await api(`/instances/${instance.id}/api/modules/drawing/manager/tasks/${taskId}/logs`);
  assert.equal(scoped.status,200);assert.equal(scoped.text,'实例管理日志');
  const actual=await page(app,`?instance=${instance.id}&task=${taskId}`);t.diagnostic(JSON.stringify(actual));
  assert.equal(actual.text,scoped.text);
});

test('独立服务日志页面应读取所属实例日志',async t=>{
  const {app,instance,api}=await fixture(t);
  const scoped=await api(`/instances/${instance.id}/api/modules/drawing/runtime/logs`);
  assert.equal(scoped.status,200);assert.equal(scoped.text,'实例服务日志');
  const actual=await page(app,`?instance=${instance.id}`);t.diagnostic(JSON.stringify(actual));
  assert.equal(actual.text,scoped.text);
});

test('启动实例时自动日志窗口应带实例身份',async t=>{
  const {app,instance,opened}=await fixture(t);
  const response=await fetch(`${app.url}/instances/${instance.id}/api/modules/drawing/launch`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.equal(opened.length,1);t.diagnostic(JSON.stringify(opened));
  assert.equal(opened[0].instanceId,instance.id);
});

test('桌面日志目标解析应保留实例身份',()=>{
  const {parseLogTarget}=require('../desktop/process-log-window.cjs');
  const instanceId='ad63115b-b59e-4c87-941c-0ef6a8658c10',base='http://127.0.0.1:61210';
  assert.deepEqual(parseLogTarget(base,`${base}/process-log.html?instance=${instanceId}&task=${taskId}`),{instanceId,taskId});
});

test('实例日志窗口分别去重，复制与原生另存支持实例查询参数',()=>{
  const {ProcessLogWindows,isLogClipboardWrite,parseLogTarget}=require('../desktop/process-log-window.cjs');
  const {installWorkbenchDownloads}=require('../desktop/downloads.cjs');
  const base='http://127.0.0.1:61210',a='ad63115b-b59e-4c87-941c-0ef6a8658c10',b='bd63115b-b59e-4c87-941c-0ef6a8658c10';
  class Window extends EventEmitter{
    constructor(){super();this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
    isDestroyed(){return false;}isMinimized(){return false;}show(){}focus(){}
    loadURL(url){this.url=url;return Promise.resolve();}
  }
  const windows=new ProcessLogWindows({BrowserWindow:Window,getBaseURL:()=>base});
  const root=windows.open(),first=windows.open({instanceId:a}),second=windows.open({instanceId:b});
  assert.notEqual(first,root);assert.notEqual(first,second);assert.equal(first,windows.open({instanceId:a}));
  assert.notEqual(windows.open({instanceId:a,taskId}),windows.open({instanceId:b,taskId}));
  assert.equal(new URL(first.url).searchParams.get('instance'),a);
  assert.equal(isLogClipboardWrite(base,first.url,'clipboard-sanitized-write'),true);
  assert.deepEqual(parseLogTarget(base,base+'/process-log.html'),{});
  for(const query of ['instance=','instance=bad','instance='+a+'&instance='+b,'instance='+a+'&task=bad','instance='+a+'&other=x']){
    assert.equal(parseLogTarget(base,base+'/process-log.html?'+query),null);
    assert.equal(isLogClipboardWrite(base,base+'/process-log.html?'+query,'clipboard-sanitized-write'),false);
  }
  assert.throws(()=>windows.open({instanceId:''}));assert.throws(()=>windows.open({instanceId:'bad'}));
  const session=new EventEmitter(),download=new EventEmitter();
  download.getURL=()=>`blob:${base}/fixture`;download.getFilename=()=>'实例日志.log';download.setSaveDialogOptions=options=>download.options=options;
  const dispose=installWorkbenchDownloads({session,getBaseURL:()=>base,getDownloadsPath:()=>tmpdir()});
  session.emit('will-download',{},download,{getURL:()=>first.url,isDestroyed:()=>false});
  assert.equal(download.options?.title,'导出日志');dispose();
});

test('日志页遇到空、非法或重复实例参数不读取根日志',async t=>{
  const {app,instance}=await fixture(t);
  for(const search of ['?instance=','?instance=bad','?instance='+instance.id+'&instance='+instance.id]){
    const actual=await page(app,search);assert.deepEqual(actual.requests,[],search);assert.equal(actual.status,'读取失败');
  }
});

test('日志页遇到丢失实例只显示该实例错误，不回退根日志',async t=>{
  const {app}=await fixture(t),missing='ad63115b-b59e-4c87-941c-0ef6a8658c10';
  const actual=await page(app,'?instance='+missing);
  assert.equal(actual.requests.length,1);assert.equal(actual.requests[0].path,`/instances/${missing}/api/modules/drawing/runtime/logs`);
  assert.equal(actual.requests[0].status,404);assert.equal(actual.status,'读取失败');
});
