import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
function fixture(){
  const select=document.querySelector('#models');
  for(let i=0;i<1000;i++){
    const name=i===700||i===701?'重复模型.safetensors':i===800?'中文模型.safetensors':`model-${i}.safetensors`;
    const path='E:\\模型库\\分类-'+i+'\\'+'很长的目录名称\\'.repeat(8)+name;
    const option=new Option(name+' · '+path,path);option.dataset.label=name;option.dataset.description=path;select.add(option);
  }
  select.selectedIndex=601;
  window.events={input:0,change:0,apply:0};
  for(const type of ['input','change'])select.addEventListener(type,()=>events[type]++);
  document.querySelector('#apply').onclick=()=>events.apply++;
  window.setQuery=value=>{const input=document.querySelector('[data-search-select-input]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
}
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.setPath('userData',join(process.env.SEARCH_SELECT_TEST_DIR,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    if(req.url==='/test'){
      res.setHeader('content-type','text/html;charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>body{padding:30px}.field{max-width:1100px}select{width:100%}#after{margin:20px}dialog{background:var(--glass-solid);color:var(--ink);padding:30px;border:0;border-radius:14px}</style><h1>模型选择</h1><form><div class="field"><label for="models">已检索到的模型</label><select id="models" name="model"><option value="">选择模型</option></select></div><button id="apply" type="button">选用底模</button><button id="after" type="button">下一个操作</button><label for="short">训练方式</label><select id="short"><option>A</option><option>B</option></select><fieldset id="disabled-group"><select id="dynamic" data-searchable aria-label="动态模型"><option value="a">Alpha</option><option value="b">Beta</option></select></fieldset></form><dialog id="modal"><label for="inside">角色模型</label><select id="inside" data-searchable><option>A</option><option>B</option></select><button id="modal-after">后续操作</button></dialog><script type="module">(${fixture.toString()})();try{const {installSearchableSelects}=await import('/searchable-select.js');window.disposeSearch=installSearchableSelects(document);}catch(error){window.initError=error.message;}window.ready=true;</script></html>`);return;
    }
    try{const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){throw new Error(source.slice(0,500)+'\n'+error.message+'\n'+errors.join('\n'));}},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(source)=>{const until=Date.now()+5000;while(Date.now()<until){if(await js(source))return;await pause(30);}throw new Error('等待超时：'+source+' '+errors.join('\n'));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const key=async keyCode=>{keyCode=({ArrowDown:'Down',ArrowUp:'Up'})[keyCode]||keyCode;window.webContents.sendInputEvent({type:'keyDown',keyCode});window.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(40);};
  const query=async value=>{await js(`setQuery(${JSON.stringify(value)});void 0`);await pause(30);};
  const capture=async name=>{if(process.env.SEARCH_SELECT_UI_OUTPUT){await mkdir(process.env.SEARCH_SELECT_UI_OUTPUT,{recursive:true});await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await writeFile(join(process.env.SEARCH_SELECT_UI_OUTPUT,name),(await window.webContents.capturePage()).toPNG());}};
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('window.ready');
    assert.equal(await js('window.initError||""'),'','长列表应安装搜索选择框');
    window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    // 真实鼠标路径，确保没有弹出屏幕外的原生下拉窗口。
    const point=await js('(()=>{const r=document.querySelector("#models").getBoundingClientRect();return {x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)}})()');
    window.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});window.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
    await wait('document.querySelector("[data-search-select-input]")===document.activeElement');
    assert.equal(await js('document.querySelectorAll("[data-search-select-option]").length'),1001,await js('JSON.stringify({focus:document.activeElement?.tagName,popup:document.querySelector("[data-search-select-popup]")?.outerHTML.slice(0,1200),options:document.querySelector("#models").options.length})'));
    const original=await js('document.querySelector("#models").value');
    const activeBounds=await js('(()=>{const row=document.querySelector("[data-active]").getBoundingClientRect(),list=document.querySelector(".search-select-options");return {top:row.top,bottom:row.bottom,listTop:list.getBoundingClientRect().top,listBottom:list.getBoundingClientRect().bottom,scroll:list.scrollTop}})()');
    assert.ok(activeBounds.top>=activeBounds.listTop-1&&activeBounds.bottom<=activeBounds.listBottom+1,'打开列表时当前选项应在可见范围内 '+JSON.stringify(activeBounds));
    await query('中文 分类-800');assert.equal(await js('document.querySelectorAll("[data-search-select-option]").length'),1);
    assert.equal(await js('document.querySelector("#models").value'),original,'搜索不改动已选值');
    await key('Escape');assert.equal(await js('document.activeElement.id'),'models');assert.equal(await js('document.querySelector("#models").value'),original);
    await key('Enter');await query('重复模型');assert.equal(await js('document.querySelectorAll("[data-search-select-option]").length'),2);
    await key('ArrowDown');
    await js('(()=>{const select=document.querySelector("#models"),selected=select.selectedIndex;select.innerHTML=select.innerHTML;select.selectedIndex=selected;})()');
    await pause(40);
    assert.equal(await js('document.querySelector("[data-search-select-input]").value'),'重复模型','轮询重建候选保留关键词');
    assert.match(await js('document.querySelector("[data-active]").textContent'),/分类-701/,'轮询重建同名选项保留键盘候选，而不是退回首项');
    await key('Enter');
    assert.match(await js('document.querySelector("#models").value'),/分类-701/);
    assert.deepEqual(await js('events'),{input:1,change:1,apply:0});
    assert.equal(await js('new FormData(document.querySelector("form")).get("model")'),await js('document.querySelector("#models").value'));
    await click('#apply');assert.equal(await js('events.apply'),1);
    await click('#models');await query('NO-SUCH-MODEL');assert.match(await js('document.querySelector("[data-search-select-status]").textContent'),/没有匹配/);
    await key('Enter');assert.equal(await js('events.change'),1,'空结果不能清空已选值');
    await query('MODEL-42');assert.ok(await js('document.querySelectorAll("[data-search-select-option]").length>0'),'大小写不影响搜索');
    await query('e:/模型库/分类-800/');assert.equal(await js('document.querySelectorAll("[data-search-select-option]").length'),1,'Windows 路径使用正斜杠也能匹配');
    await query('e:\\模型库\\分类-800\\');assert.equal(await js('document.querySelectorAll("[data-search-select-option]").length'),1,'原生 Windows 路径继续匹配');
    await query('MODEL-42');
    await js('document.querySelector("[data-search-select-input]").dispatchEvent(new CompositionEvent("compositionstart"));void 0');await key('Enter');
    assert.equal(await js('events.change'),1,'中文输入法确认文字不能误选模型');
    await js('document.querySelector("[data-search-select-input]").dispatchEvent(new CompositionEvent("compositionend"));void 0');await key('Escape');
    // 靠近右下角时，列表仍完整留在窗口内；长路径不会撑宽。
    await js('document.querySelector("#models").style.cssText="position:fixed;right:10px;bottom:12px;width:500px";void 0');await click('#models');await query('重复模型');
    const bounds=await js('(()=>{const r=document.querySelector("[data-search-select-popup]").getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,screenWidth:innerWidth,screenHeight:innerHeight}})()');
    assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=bounds.screenWidth&&bounds.bottom<=bounds.screenHeight,JSON.stringify(bounds));assert.ok(bounds.width<=760&&bounds.height<=420);
    await capture('searchable-models-light.png');await js('document.documentElement.dataset.theme="dark";void 0');await capture('searchable-models-dark.png');await key('Escape');
    await click('#short');assert.equal(await js('!!document.querySelector("[data-search-select-popup]")'),false,'短列表保持原有操作');
    await click('#dynamic');await wait('!!document.querySelector("[data-search-select-input]")');
    await js(`document.querySelector('#dynamic').innerHTML=${JSON.stringify('<option value="c" disabled>不可用</option><optgroup label="禁用组" disabled><option value="d">不可选</option></optgroup><option value="e">新模型</option>')};void 0`);
    await wait('document.querySelectorAll("[data-search-select-option]").length===3');await key('Enter');assert.equal(await js('document.querySelector("#dynamic").value'),'e');
    const dynamic=async options=>{await js(`document.querySelector('#dynamic').innerHTML=${JSON.stringify(options)};void 0`);await pause(40);};
    const fallback='<option value="default" selected>默认</option>';
    await dynamic(fallback+'<option value="same">模型 Alpha</option><option value="same">模型 Beta</option>');
    await click('#dynamic');await query('模型');await key('ArrowDown');
    await dynamic(fallback+'<option value="same">模型 Beta</option><option value="same">模型 Alpha</option>');
    assert.equal(await js('document.querySelector("[data-active]").textContent'),'模型 Beta','同值选项重排后按完整身份保留，不借用旧索引');
    await key('Enter');assert.equal(await js('document.querySelector("#dynamic").selectedIndex'),1);
    await dynamic(fallback+'<optgroup label="A"><option value="same">模型</option></optgroup><optgroup label="B"><option value="same">模型</option></optgroup>');
    await click('#dynamic');await query('模型');await key('ArrowDown');
    await dynamic(fallback+'<optgroup label="B"><option value="same">模型</option></optgroup><optgroup label="A"><option value="same">模型</option></optgroup>');
    await key('Enter');assert.equal(await js('document.querySelector("#dynamic").selectedOptions[0].parentElement.label'),'B','同名同值选项按分组区分');
    await dynamic(fallback+'<option value="same">模型 Alpha</option><option value="same">模型 Beta</option>');
    await click('#dynamic');await key('ArrowDown');await key('ArrowDown');
    await dynamic(fallback+'<option value="same">模型 Alpha</option>');
    assert.equal(await js('document.querySelector("[data-active]").textContent'),'默认','候选删除时不能以重复值误认另一模型');
    await key('Escape');
    await dynamic(fallback+'<option value="same">模型 Alpha</option><option value="same">模型 Beta</option>');
    await click('#dynamic');await key('ArrowDown');await key('ArrowDown');
    await dynamic(fallback+'<option value="same">模型 Alpha</option><option value="same" disabled>模型 Beta</option>');
    assert.equal(await js('document.querySelector("[data-active]").textContent'),'默认','候选禁用后回退已选项');
    await key('Escape');
    await dynamic(fallback+'<option value="same">重复</option><option value="same">重复</option>');
    await click('#dynamic');await key('ArrowDown');await key('ArrowDown');
    await dynamic(fallback+'<option value="same">重复</option><option value="same">重复</option>');
    assert.equal(await js('document.querySelector("[data-active]").textContent'),'默认','完全相同的重复选项无法唯一恢复时回退，不猜索引');
    await key('Escape');
    await click('#dynamic');await js('document.querySelector("#disabled-group").disabled=true;void 0');await wait('!document.querySelector("[data-search-select-popup]")');
    await js('document.querySelector("#disabled-group").disabled=false;document.querySelector("#dynamic").insertAdjacentHTML("afterend",\'<details><summary id="next-summary">高级设置</summary><input id="closed-input"></details>\');void 0');
    await click('#dynamic');await key('Tab');assert.equal(await js('document.activeElement.id'),'next-summary','Tab 使用浏览器焦点顺序，跳过折叠内容');
    await js('document.querySelector("#disabled-group").disabled=false;document.querySelector("#modal").showModal();void 0');await click('#inside');await query('B');await key('Enter');assert.equal(await js('document.querySelector("#inside").value'),'B');
    await click('#inside');await key('Escape');assert.equal(await js('document.querySelector("#modal").open'),true,'关闭搜索不关闭所属对话框');
    await click('#inside');await key('Tab');assert.equal(await js('document.activeElement.id'),'modal-after','Tab 继续到原表单下一项');
    await js('document.querySelector("#modal").close();void 0');await click('#models');await js('document.querySelector("#models").remove();void 0');await wait('!document.querySelector("[data-search-select-popup]")');
    await click('#dynamic');await js('disposeSearch();void 0');assert.equal(await js('!!document.querySelector("[data-search-select-popup]")'),false);
    assert.deepEqual(errors,[]);console.log('SEARCH_SELECT_UI_OK');
  }finally{window.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
if(process.argv.includes('--search-select-ui'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('可搜索选择框：千项长路径、键盘、中文输入、动态选项与模态窗口',{skip:!electron,timeout:30000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'search-select-'));
  const env={...process.env,SEARCH_SELECT_TEST_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--search-select-ui'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output);assert.match(output,/SEARCH_SELECT_UI_OK/);
});
