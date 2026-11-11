import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runManaged } from '../framework/drawing-repositories.mjs';
import { WorkbenchStore } from '../framework/store.mjs';
import { createWorkbench } from '../framework/server.mjs';

const require = createRequire(import.meta.url);

test('管理进程结束前转发输出，分块 UTF-8 中文保持完整', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-log-'));
  const gate = join(directory, 'finish');
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive:true, force:true }); });
  const chunks = [];
  let finished = false;
  const script = `const fs=require('node:fs');const b=Buffer.from('中文输出\\n');process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stderr.write('安装进度\\n');},30);const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);process.exit(0);}},20);setTimeout(()=>process.exit(2),4000).unref();`;
  const pending = runManaged(process.execPath, ['-e', script, gate], { cwd:directory, onOutput:(text, stream) => chunks.push({text, stream}) }).then(result => { finished=true; return result; });
  try {
    const end=Date.now()+1500;
    while (Date.now()<end && !chunks.some(item=>item.text.includes('安装进度'))) await delay(20);
    assert.match(chunks.map(item=>item.text).join(''), /中文输出/);
    assert.ok(chunks.some(item=>item.stream==='stderr' && item.text.includes('安装进度')));
    assert.equal(finished, false, '应当在子进程结束前看到安装输出');
    assert.doesNotMatch(chunks.map(item=>item.text).join(''), /\uFFFD/);
  } finally { await writeFile(gate, 'finish'); await pending; }
});

test('日志窗口同源去重、关闭可重开，关闭不执行进程控制', async () => {
  const { ProcessLogWindows, parseLogTarget } = require('../desktop/process-log-window.cjs');
  const created=[];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options=options; this.webContents=new EventEmitter(); this.webContents.setWindowOpenHandler=handler=>{this.openHandler=handler;}; created.push(this); }
    isDestroyed(){ return !!this.destroyed; }
    isMinimized(){ return false; }
    show(){ this.shown=true; }
    focus(){ this.focused=true; }
    loadURL(url){ this.url=url; this.emit('ready-to-show'); return Promise.resolve(); }
    close(){ this.destroyed=true; this.emit('closed'); }
  }
  const base='http://127.0.0.1:61210';
  const windows=new ProcessLogWindows({BrowserWindow:Window,getBaseURL:()=>base});
  windows.open(); windows.open();
  assert.equal(created.length,1); assert.equal(created[0].focused,true);
  assert.equal(created[0].options.webPreferences.nodeIntegration,false);
  assert.equal(created[0].options.webPreferences.sandbox,true);
  assert.equal(created[0].options.icon,resolve('public-workbench/app.ico'));
  assert.equal(created[0].openHandler({url:'https://example.com'}).action,'deny');
  let prevented=false;
  created[0].webContents.emit('will-navigate',{preventDefault(){prevented=true;}},base+'/index.html');
  assert.equal(prevented,true);
  created[0].close(); windows.open(); assert.equal(created.length,2);
  const taskId='565e6d56-e5cc-4e55-8910-fcded6ba43ac';
  windows.open({taskId}); assert.equal(created.length,3); assert.match(created[2].url,new RegExp(taskId));
  assert.deepEqual(parseLogTarget(base,base+'/process-log.html'),{});
  for(const url of ['https://example.com/process-log.html',base+'/index.html',base+'/process-log.html?task=bad',base+'/process-log.html?other=1',base+'/process-log.html#other']) assert.equal(parseLogTarget(base,url),null,url);
  assert.throws(()=>windows.open({taskId:'../outside'}));
  windows.closeAll(); assert.ok(created.every(window=>window.destroyed));
});

test('只允许当前日志页写入剪贴板，其他来源和权限继续拒绝',()=>{
  const {isLogClipboardWrite}=require('../desktop/process-log-window.cjs');
  const base='http://127.0.0.1:61210';
  assert.equal(isLogClipboardWrite(base,base+'/process-log.html','clipboard-sanitized-write'),true);
  for(const [url,permission] of [[base+'/','clipboard-sanitized-write'],['http://127.0.0.1:61211/process-log.html','clipboard-sanitized-write'],[base+'/process-log.html','clipboard-read'],[base+'/process-log.html','media'],[base+'/process-log.html?task=bad','clipboard-sanitized-write']])assert.equal(isLogClipboardWrite(base,url,permission),false);
});

test('启动通知宿主打开日志，窗口失败不会误报已提交的启动失败', async t => {
  const directory=await mkdtemp(join(tmpdir(),'workbench-log-http-'));
  const taskId='565e6d56-e5cc-4e55-8910-fcded6ba43ac';
  const store=new WorkbenchStore(directory);
  store.setEnabled('drawing',true);
  store.saveConfig('drawing',{serviceUrl:'http://127.0.0.1:8188'});
  store.setSetting('drawing.manager.tasks',[{id:taskId,title:'安装 Python 依赖',status:'completed',log:'真实日志\n',logTruncated:true,error:null}]);
  store.close();
  let calls=0;
  const runtime=await createWorkbench({dataDir:directory,openProcessLog:source=>{calls++;assert.deepEqual(source,{});throw new Error('window failed');},drawingOptions:{WebSocketImpl:null,fetchImpl:async url=>new Response(JSON.stringify(new URL(url).pathname==='/system_stats'?{system:{},devices:[]}:{SaveImage:{output_node:true,input:{required:{images:['IMAGE']}}}}))}});
  t.after(async()=>{await runtime.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const launch=await fetch(runtime.url+'/api/modules/drawing/launch',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(launch.status,200);assert.equal(calls,1);assert.match((await launch.json()).logWindowError,/操作已提交/);
  const response=await fetch(runtime.url+'/api/modules/drawing/manager/tasks/'+taskId+'/logs');
  assert.equal(response.status,200);const log=await response.json();assert.equal(log.text,'真实日志\n');assert.equal(log.truncated,true);assert.equal(log.task.title,'安装 Python 依赖');assert.equal(log.inventory,undefined);
  assert.equal((await fetch(runtime.url+'/api/modules/drawing/manager/tasks/00000000-0000-0000-0000-000000000000/logs')).status,404);
});
