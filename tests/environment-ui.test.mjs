import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { moduleDefinitions } from '../framework/registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = [process.env.AI_FUTURE_ELECTRON, join(root, 'node_modules/electron/dist/electron.exe'), 'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

function browserFixture() {
  const copy = value => structuredClone(value);
  const field = (key, label, type = 'path') => ({key, label, type, help:'', placeholder:''});
  const drawing = {id:'drawing', name:'角色绘图', config:{comfyPath:'E:\\old\\ComfyUI',workflowPath:'E:\\workflows',outputPath:'E:\\art',serviceUrl:'http://remote.test:8188'}, settings:[field('comfyPath','ComfyUI 目录'),field('workflowPath','工作流目录'),field('outputPath','作品目录'),field('serviceUrl','服务地址','url')]};
  const module = (id, settings) => ({id, name:id, config:{}, settings, checks:{}, capabilities:[], requirements:[], optionalIntegrations:[], usesCharacterContext:false});
  const modules = [drawing,module('comfyui',[]),module('training',[field('trainerPath','训练器目录'),field('outputPath','训练产物目录')]),module('voice',[field('voicePath','声音模型')]),module('mc-play',[]),module('mc-skin',[field('pythonPath','Python 可执行文件'),field('skinPath','原皮肤'),field('outputPath','作品目录')]),module('qq',[]),module('companion',[])];
  for(const item of modules)item.discovery=window.discoveryTargets[item.id];
  const candidate = (id, values, label = id, selectable = true) => ({id, kind:'local', label, path:Object.values(values)[0], values, selectable, ...(!selectable?{reason:'此目录不是工作台固定版本运行包'}:{})});
  const fixture = window.envTest = {
    ui:{moduleTabs:{}}, drafts:new window.Drafts(), state:{modules,characters:[],events:[],selectedCharacterId:null}, calls:[],
    candidates:{drawing:[candidate('comfy-one',{comfyPath:'E:\\one\\ComfyUI',outputPath:'E:\\one\\ComfyUI\\output',workflowPath:'E:\\one\\ComfyUI\\user\\default\\workflows'},'ComfyUI 本体'),candidate('comfy-two',{comfyPath:'F:\\portable\\ComfyUI',outputPath:'F:\\portable\\ComfyUI\\output',workflowPath:'F:\\portable\\ComfyUI\\user\\default\\workflows'},'ComfyUI 便携包')],training:[candidate('trainer',{trainerPath:'E:\\tools\\Next-Trainer'})],'mc-play':[candidate('world',{serverHost:'192.168.1.7',serverPort:'54321'},'念念的世界')],'mc-skin':[candidate('python',{pythonPath:'E:\\Python\\python.exe'})],qq:[candidate('unsupported',{installDirectory:'E:\\NapCat'},'独立 NapCat',false),candidate('managed',{installDirectory:'E:\\qq-runtime'},'工作台运行包')]},
    mc:{config:{serverHost:'127.0.0.1',serverPort:'25565',gameVersion:'1.21.1',authMode:'offline',playerName:'Momo',ownerName:'Niannian'},connection:{status:'disconnected'},runtime:{available:true,version:'test'},history:[],aiEnabled:false},
    skinRuntime:{available:false,error:'尚未检查 Python'},drawingRuntime:{settings:{pythonPath:'E:\\old\\python.exe',vramMode:'lowvram'}},issues:{},
    deferred:[], pending:[], scanError:null, directory:'F:\\chosen', selected:[], adopting:false, denySelection:false,
  };
  fixture.candidates.comfyui = copy(fixture.candidates.drawing);
  fixture.defer = moduleId => fixture.deferred.push(moduleId);
  fixture.release = moduleId => {const index=fixture.pending.findIndex(item=>item.moduleId===moduleId);if(index<0)throw new Error('没有延迟扫描');fixture.pending.splice(index,1)[0].resolve();};
  fixture.api = async (path,{method='GET',body}={}) => {
    fixture.calls.push({path,method,body:copy(body)});
    if(path.startsWith('/api/environment/state?'))return {attempted:false,result:null};
    if(path==='/api/environment/scan') {
      const error=fixture.scanError;
      const result={moduleId:body.moduleId,candidates:copy(fixture.candidates[body.moduleId]||[]),issues:copy(fixture.issues[body.moduleId]||[]),partial:false,warnings:[],scannedAt:new Date().toISOString(),canChooseDirectory:true};
      if(fixture.deferred.includes(body.moduleId)) {fixture.deferred.splice(fixture.deferred.indexOf(body.moduleId),1);await new Promise(resolve=>fixture.pending.push({moduleId:body.moduleId,resolve}));}
      if(error)throw new Error(error);
      return result;
    }
    if(path==='/api/environment/choose-directory')return {directory:fixture.directory,cancelled:!fixture.directory};
    if(path==='/api/modules/mc-play/state')return copy(fixture.mc);
    if(path==='/api/modules/mc-skin/state')return {jobs:[],templates:[],runtime:copy(fixture.skinRuntime)};
    const route=path.match(/^\/api\/modules\/([^/]+)\/config$/);
    if(route&&method==='PUT'){
      const target=modules.find(item=>item.id===route[1]);
      if(route[1]==='drawing'&&body.runtimeSettings){
        if(fixture.deferRuntimeSave)await new Promise(resolve=>fixture.releaseRuntimeSave=resolve);
        if(fixture.failDrawingSave)throw new Error('配置保存失败');
        fixture.drawingRuntime.settings={...fixture.drawingRuntime.settings,...body.runtimeSettings};
      }
      target.config={...target.config,...body.values};return {config:copy(target.config),checks:{},...(body.runtimeSettings?{runtimeSettings:copy(fixture.drawingRuntime.settings)}:{})};
    }
    if(path==='/api/modules/drawing/discover')return {comfyPath:'E:\\normalized\\ComfyUI'};
    if(path==='/api/modules/drawing/runtime'){if(fixture.runtimeError)throw new Error('运行设置暂时无法读取');const snapshot=copy(fixture.drawingRuntime);if(fixture.deferRuntime)await new Promise(resolve=>fixture.releaseRuntime=resolve);return snapshot;}
    throw new Error(`未配置的接口：${method} ${path}`);
  };
  fixture.mount = async (kind, fresh = false) => {
    fixture.controller?.abort();
    if(fresh){fixture.ui={moduleTabs:{}};fixture.drafts=new window.Drafts();fixture.calls=[];}
    fixture.controller=new AbortController();
    const ctx={state:fixture.state,ui:fixture.ui,drafts:fixture.drafts,signal:fixture.controller.signal,api:fixture.api,refresh:async()=>{},notify:()=>{},action:async(_button,job)=>job(),navigate:()=>{}};
    const target=document.querySelector('#root');target.innerHTML='';
    if(kind==='drawing'||kind==='comfyui')window.mountDrawing(target,ctx,{launcher:kind==='comfyui'});
    if(kind==='mc-play')window.mountMC(target,ctx);
    if(kind==='training'||kind==='voice'){fixture.ui.moduleTabs[kind]='config';window.defineModuleView({id:kind,flow:[],guide:[]})(target,ctx);}
    if(kind==='mc-skin')window.mountSkin(target,ctx);
    if(kind==='component'||kind==='companion'){
      const {mountEnvironmentDiscovery}=await import('/environment-view.js');
      fixture.component=mountEnvironmentDiscovery(target,ctx,{moduleId:kind==='companion'?'companion':'qq',canSelect:()=>!fixture.denySelection,onSelect:async candidate=>{fixture.selected.push(candidate.id);if(fixture.adopting)await new Promise(resolve=>{fixture.finishAdoption=resolve;});if(fixture.adoptionError)throw new Error(fixture.adoptionError);}});
    }
    fixture.ctx=ctx;fixture.kind=kind;
  };
}

async function runBrowserTests() {
  const {app, BrowserWindow, session}=createRequire(import.meta.url)('electron');
  if(process.env.AI_FUTURE_ENV_UI_PROFILE)app.setPath('userData',process.env.AI_FUTURE_ENV_UI_PROFILE);
  app.on('window-all-closed',()=>{});await app.whenReady();
  session.defaultSession.setSpellCheckerEnabled(false);session.defaultSession.setSpellCheckerLanguages([]);
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    if(req.url==='/test'){
      res.setHeader('content-type','text/html;charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/drawing.css"><style>body{padding:28px}#root{max-width:1120px;margin:auto}</style><div id="root"></div><script type="module">import {Drafts} from '/drafts.js';import {mountConnection} from '/drawing-connection-view.js';import {mount as mountMC} from '/mc-play-view.js';import {mount as mountSkin} from '/skin-studio.js';import {defineModuleView} from '/module-view.js';Object.assign(window,{Drafts,mountDrawing:mountConnection,mountMC,mountSkin,defineModuleView,discoveryTargets:${JSON.stringify(Object.fromEntries(moduleDefinitions.map(item=>[item.id,item.discovery])))} });(${browserFixture.toString()})();await envTest.mount('drawing');window.mounted=true;</script></html>`);
      return;
    }
    try{const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}
    catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true,spellcheck:false}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){throw new Error(`页面脚本执行失败：${source}\n${errors.join('\n')}\n${error.message}`);}};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(label,source)=>{const end=Date.now()+8000;while(Date.now()<end){if(await js(source))return;await pause(35);}throw new Error(`等待超时：${label}`);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const fill=(selector,value)=>js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const mount=(kind,fresh=false)=>js(`envTest.mount(${JSON.stringify(kind)},${fresh})`);
  const scanCount=moduleId=>js(`envTest.calls.filter(call=>call.path==='/api/environment/scan'&&call.body.moduleId===${JSON.stringify(moduleId)}).length`);
  const adopt='[data-environment-select]';
  const checks=[];
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('绘图表单',`window.mounted`);
    assert.equal(await scanCount('drawing'),1,'首次打开绘图配置应自动扫描一次');
    await wait('多个候选',`document.querySelectorAll('${adopt}').length===2`);
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'E:\\art');
    assert.equal(await js(`document.querySelector('#config-serviceUrl').value`),'http://remote.test:8188');
    assert.equal(await js(`envTest.calls.some(call=>call.method==='PUT')`),false);
    await click(`${adopt}[data-environment-select="comfy-two"]`);
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'E:\\art','采用本机环境保留已有作品目录');
    assert.equal(await js(`document.querySelector('#config-workflowPath').value`),'E:\\workflows','采用本机环境保留已有工作流目录');
    assert.equal(await js(`envTest.drafts.read('module:drawing',{}).comfyPath`),'F:\\portable\\ComfyUI');
    assert.equal(await js(`document.querySelector('#config-serviceUrl').value`),'http://remote.test:8188','采用本机路径仍保留远端服务地址');
    assert.equal(await js(`document.querySelector('#check-paths').disabled`),true);
    await fill('#config-outputPath','');await fill('#config-workflowPath','');await click(`${adopt}[data-environment-select="comfy-two"]`);
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'F:\\portable\\ComfyUI\\output','空作品目录才补本机默认值');
    assert.equal(await js(`document.querySelector('#config-workflowPath').value`),'F:\\portable\\ComfyUI\\user\\default\\workflows','空工作流目录才补本机默认值');
    checks.push('首次只扫描；多个候选明确选择后填值并标记草稿，保留远程地址');

    await fill('#config-outputPath','E:\\正在写的新作品');
    await js(`envTest.defer('drawing');void 0`);await click('[data-environment-rescan]');
    await wait('延迟扫描',`envTest.pending.length===1`);await mount('drawing');
    assert.equal(await scanCount('drawing'),2,'扫描未结束时返回配置页复用同一个请求');
    await fill('#config-workflowPath','E:\\我的工作流草稿');
    await js(`envTest.release('drawing');void 0`);await wait('重扫完成',`!document.querySelector('[data-environment-rescan]').disabled`);
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'E:\\正在写的新作品');
    assert.equal(await js(`document.querySelector('#config-workflowPath').value`),'E:\\我的工作流草稿');
    assert.equal(await js(`envTest.calls.filter(call=>call.path==='/api/environment/scan').at(-1).body.refresh`),true);
    await mount('drawing');await wait('缓存候选',`document.querySelectorAll('${adopt}').length===2`);
    assert.equal(await scanCount('drawing'),2,'重新进入配置页复用扫描缓存');
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'E:\\正在写的新作品');
    await click('#save-module-config');await wait('保存结束',`document.querySelector('#config-feedback').textContent.includes('已保存')`);
    assert.equal(await js(`envTest.calls.find(call=>call.method==='PUT').body.values.comfyPath`),'F:\\portable\\ComfyUI','隐藏的 ComfyUI 本体路径随原保存流程提交');
    assert.equal(await js(`document.querySelector('#check-paths').disabled`),false,'保存隐藏本体路径和草稿后恢复路径检查');
    checks.push('重扫和返回配置保留用户草稿；隐藏路径随显式保存提交');

    await js(`envTest.scanError='扫描暂时失败，请重试';void 0`);await click('[data-environment-rescan]');
    await wait('扫描错误',`document.querySelector('[data-environment-feedback]').textContent.includes('扫描暂时失败')`);
    await js(`envTest.scanError=null;envTest.candidates.drawing=[];void 0`);await click('[data-environment-rescan]');
    await wait('空结果',`document.querySelector('[data-environment-empty]')`);
    assert.match(await js(`document.querySelector('[data-environment-empty]').textContent`),/ComfyUI 本体/,'空状态必须点名缺少的扫描目标');
    const beforeCancel=await scanCount('drawing');await js(`envTest.directory=null;void 0`);await click('[data-environment-directory]');
    await wait('目录选择取消',`!document.querySelector('[data-environment-directory]').disabled`);
    assert.equal(await scanCount('drawing'),beforeCancel,'取消选择目录不重新扫描');
    await js(`envTest.directory=${JSON.stringify('F:\\chosen')};void 0`);await click('[data-environment-directory]');
    await wait('选择目录扫描',`envTest.calls.some(call=>call.path==='/api/environment/scan'&&call.body.directory==='F:\\\\chosen')`);
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'E:\\正在写的新作品');
    checks.push('错误可重新扫描；无结果可选目录扩大范围，不写入表单');

    await js(`envTest.defer('drawing');void 0`);await click('[data-environment-rescan]');await wait('切页前扫描',`envTest.pending.length===1`);
    await mount('voice');await js(`envTest.release('drawing');void 0`);await pause(80);
    assert.equal(await js(`Boolean(document.querySelector('[data-environment-discovery]'))`),false,'声音模块不出现无意义的扫描控件');
    assert.equal(await js(`document.querySelector('#config-voicePath').value`),'');
    checks.push('切页后忽略迟到扫描响应，其他工具不增加扫描控件');

    await js(`envTest.drawingRuntime.settings.pythonPath='E:\\\\old\\\\python.exe';void 0`);
    await mount('comfyui');await wait('启动器复用绘图空结果',`document.querySelector('[data-environment-empty]')`);
    await click('[data-environment-rescan]');await wait('启动器扫描',`document.querySelectorAll('${adopt}').length===2`);
    await wait('Python 启动配置',`document.querySelector('#connection-python')`);
    await js(`envTest.candidates.comfyui[1].values.pythonPath='F:\\\\portable\\\\python_embeded\\\\python.exe';envTest.ui.environmentDiscovery.comfyui.result.candidates[1].values.pythonPath=envTest.candidates.comfyui[1].values.pythonPath;void 0`);
    await click(`${adopt}[data-environment-select="comfy-two"]`);
    assert.equal(await js(`document.querySelector('#connection-python').value`),'F:\\portable\\python_embeded\\python.exe');
    assert.equal(await js(`envTest.drawingRuntime.settings.pythonPath`),'E:\\old\\python.exe','采用前不改持久启动配置');
    await click('#save-module-config');await wait('保存配套 Python',`envTest.drawingRuntime.settings.pythonPath==='F:\\\\portable\\\\python_embeded\\\\python.exe'`);
    assert.equal(await js(`envTest.drawingRuntime.settings.vramMode`),'lowvram','局部保存 Python 不覆盖其它运行参数');
    assert.equal(await js(`envTest.calls.filter(call=>call.path==='/api/modules/drawing/runtime/settings').length`),0,'环境与 Python 通过同一个配置 PUT 保存');
    assert.equal(await js(`envTest.calls.filter(call=>call.path==='/api/modules/drawing/config').at(-1).body.runtimeSettings.pythonPath`),'F:\\portable\\python_embeded\\python.exe');
    await fill('#connection-python','E:\\manual\\python.exe');await click('#save-module-config');await wait('手动 Python 保存',`envTest.drawingRuntime.settings.pythonPath==='E:\\\\manual\\\\python.exe'`);
    await click(`${adopt}[data-environment-select="comfy-one"]`);
    assert.equal(await js(`document.querySelector('#connection-python').value`),'','没有配套 Python 的候选不沿用另一安装的旧解释器');
    checks.push('ComfyUI 配套 Python 可见采用与手动修改，显式保存到实际启动设置，保留其他参数');
    await js(`envTest.deferRuntime=true;void 0`);await mount('comfyui',true);
    await wait('延迟读取 Python',`typeof envTest.releaseRuntime==='function'`);
    await fill('#connection-python','E:\\new\\python.exe');
    await js(`envTest.deferRuntime=false;envTest.releaseRuntime();void 0`);
    await wait('Python 初值读取完成',`!document.querySelector('#save-module-config').disabled`);
    assert.equal(await js(`document.querySelector('#connection-python').value`),'E:\\new\\python.exe','迟到的持久设置不能覆盖手动修改');
    await js(`envTest.deferRuntimeSave=true;void 0`);await click('#save-module-config');
    await wait('延迟保存 Python',`typeof envTest.releaseRuntimeSave==='function'`);await fill('#connection-python','E:\\later\\python.exe');
    await js(`envTest.deferRuntimeSave=false;envTest.releaseRuntimeSave();void 0`);
    await wait('Python 提交后仍有修改',`document.querySelector('#config-feedback').textContent.includes('仍有新修改')`);
    assert.equal(await js(`document.querySelector('#connection-python').value`),'E:\\later\\python.exe');
    assert.equal(await js(`envTest.drafts.read('drawing:runtime',{}).pythonPath`),'E:\\later\\python.exe');
    checks.push('迟到的 Python 初值和保存响应保留新输入');
    await fill('#config-comfyPath','E:\\unsaved\\ComfyUI');await fill('#connection-python','E:\\unsaved\\python.exe');
    await js(`envTest.beforeFailedSave=structuredClone({config:envTest.state.modules.find(item=>item.id==='drawing').config,runtime:envTest.drawingRuntime.settings});envTest.failDrawingSave=true;envTest.drafts.write('drawing:runtime',{...envTest.drafts.read('drawing:runtime',{}),vramMode:'highvram'});void 0`);
    await click('#save-module-config');await wait('原子保存失败',`document.querySelector('#config-feedback').textContent.includes('配置保存失败')`);
    assert.deepEqual(await js(`({config:envTest.state.modules.find(item=>item.id==='drawing').config,runtime:envTest.drawingRuntime.settings})`),await js(`envTest.beforeFailedSave`));
    assert.equal(await js(`document.querySelector('#config-comfyPath').value`),'E:\\unsaved\\ComfyUI');
    assert.equal(await js(`document.querySelector('#connection-python').value`),'E:\\unsaved\\python.exe');
    await js(`envTest.failDrawingSave=false;void 0`);await click('#save-module-config');await wait('原子保存重试完成',`document.querySelector('#config-feedback').textContent==='配置已保存'`);
    assert.equal(await js(`envTest.drafts.read('drawing:runtime',{}).vramMode`),'highvram','只核对 Python 提交，不删除其他未保存运行参数');
    checks.push('原子保存失败保留全部草稿，重试与成功响应保留其他运行参数草稿');
    await js(`envTest.runtimeError=true;envTest.drawingRuntime.settings.pythonPath='E:\\\\old\\\\python.exe';void 0`);await mount('comfyui',true);
    await wait('Python 读取错误',`document.querySelector('#config-feedback').textContent.includes('无法读取 Python')&&!document.querySelector('#save-module-config').disabled`);
    await wait('读取失败仍可采用候选',`document.querySelector('${adopt}')`);await click(`${adopt}[data-environment-select="comfy-one"]`);
    await click('#save-module-config');await wait('读取失败后明确清空旧绑定',`envTest.drawingRuntime.settings.pythonPath===''`);
    await js(`envTest.runtimeError=false;void 0`);
    assert.equal(await scanCount('comfyui'),1);
    assert.equal(await js(`Boolean(document.querySelector('#discover-comfy'))`),true);
    await click('#discover-comfy');await wait('兼容原路径检测',`document.querySelector('#config-comfyPath').value==='E:\\\\normalized\\\\ComfyUI'`);
    checks.push('ComfyUI 启动器共享检索结果并保留原目录规范化按钮');

    await js(`envTest.state.modules.find(item=>item.id==='drawing').config.serviceUrl='';void 0`);
    await mount('comfyui',true);
    assert.equal(await js(`document.querySelector('#config-serviceUrl').value`),'http://127.0.0.1:8188','旧配置空地址应展示实际默认值，不能只给占位符');
    await click('#save-module-config');await wait('默认地址保存',`document.querySelector('#config-feedback').textContent.includes('已保存')`);
    assert.equal(await js(`envTest.calls.find(call=>call.method==='PUT').body.values.serviceUrl`),'http://127.0.0.1:8188');
    await fill('#config-serviceUrl','http://localhost:19091');
    await click('#save-module-config');await wait('自定义地址保存',`document.querySelector('#config-feedback').textContent.includes('已保存')`);
    await mount('drawing',true);
    assert.equal(await js(`document.querySelector('#config-serviceUrl').value`),'http://localhost:19091','两个入口保留用户指定的地址与端口');
    checks.push('空地址回填并保存本机默认；共享配置保持自定义地址和端口');

    await js(`envTest.candidates.training[0].label='Next Trainer · Legacy';void 0`);
    await mount('training');await wait('训练器候选',`document.querySelector('${adopt}')`);
    assert.equal(await js(`document.querySelector('.environment-location strong').textContent`),'训练环境 1','旧缓存中的内部品牌不作为展示标签');
    assert.equal(await js(`document.querySelector('${adopt}').getAttribute('aria-label')`),'采用 训练环境 1');
    await click(adopt);
    assert.equal(await js(`document.querySelector('#config-trainerPath').value`),'E:\\tools\\Next-Trainer');
    assert.equal(await js(`envTest.drafts.read('module:training',{}).trainerPath`),'E:\\tools\\Next-Trainer');
    await mount('mc-skin');assert.equal(await scanCount('mc-skin'),0,'制作页不触发配置扫描');
    await click('[data-tab="config"]');await wait('Python 候选',`document.querySelector('${adopt}')`);await click(adopt);
    assert.equal(await js(`document.querySelector('#config-pythonPath').value`),'E:\\Python\\python.exe');
    assert.equal(await js(`document.querySelector('#config-skinPath').value`),'');
    assert.equal(await js(`document.querySelector('#config-outputPath').value`),'');
    assert.equal(await js(`envTest.drafts.read('module:mc-skin',{}).pythonPath`),'E:\\Python\\python.exe');
    assert.equal(await js(`envTest.calls.some(call=>call.path.includes('runtime/check'))`),false,'发现 Python 不代表已验证运行环境');
    checks.push('训练器和皮肤配置共用发现；Python 只填路径，不猜作品或运行诊断');

    await mount('mc-play');await wait('局域网世界',`document.querySelector('${adopt}')`);
    assert.equal(await js(`Boolean(document.querySelector('[data-environment-directory]'))`),false);
    await fill('#mc-owner','NewOwner');await click(adopt);
    assert.equal(await js(`document.querySelector('#mc-host').value`),'192.168.1.7');
    assert.equal(await js(`document.querySelector('#mc-port').value`),'54321');
    assert.equal(await js(`document.querySelector('#mc-owner').value`),'NewOwner');
    assert.equal(await js(`document.querySelector('#mc-version').value`),'1.21.1');
    assert.equal(await js(`envTest.calls.some(call=>['/api/modules/mc-play/connect','/api/modules/mc-play/connection'].includes(call.path))`),false);
    await js(`envTest.mc.connection.status='connected';void 0`);await wait('在线时禁止改世界',`document.querySelector('#mc-host').disabled&&document.querySelector('${adopt}').disabled`);
    checks.push('MC 仅填局域网地址与端口，保留游戏名和登录方式，不自动连接；在线时不能采用');

    await mount('component');await wait('QQ 两种候选',`document.querySelectorAll('${adopt}').length===2`);
    assert.equal(await js(`document.querySelector('[data-environment-select="unsupported"]').disabled`),true);
    await js(`envTest.denySelection=true;void 0`);await click('[data-environment-select="managed"]');
    assert.equal(await js(`envTest.selected.length`),0,'采用时重新检查权限');
    await js(`envTest.denySelection=false;envTest.component.update();envTest.adopting=true;void 0`);
    await click('[data-environment-select="managed"]');await click('[data-environment-select="managed"]');
    assert.equal(await js(`envTest.selected.length`),1,'采用过程中不并发提交');
    await js(`envTest.adoptionError='文件已变化，请重新扫描';envTest.finishAdoption();void 0`);
    await wait('采用错误',`document.querySelector('[data-environment-feedback]').textContent.includes('文件已变化')`);
    assert.equal(await js(`document.querySelector('[data-environment-select="managed"]').disabled`),false);
    checks.push('共用组件按当下状态阻止采用，不能采用的候选显示原因，采用错误可重试');

    await js(`envTest.adoptionError=null;void 0`);await click('[data-environment-select="managed"]');await mount('component');
    assert.equal(await js(`document.querySelector('[data-environment-select="managed"]').disabled`),true,'返回页面时继续等待原来的采用操作');
    await js(`envTest.finishAdoption();void 0`);await pause(35);
    assert.equal(await js(`document.querySelector('[data-environment-select="managed"]').disabled`),false,'旧页面操作结束后，新页面恢复采用按钮');
    checks.push('未结束的扫描和采用操作跨页面复用，完成后恢复当前页面');

    const targets=[['drawing','ComfyUI 本体'],['comfyui','ComfyUI 本体'],['training','训练环境'],['mc-skin','Python'],['mc-play','Minecraft Java'],['qq','NapCat']];
    for(const [id,name] of targets){
      await js(`envTest.candidates[${JSON.stringify(id)}]=[];envTest.defer(${JSON.stringify(id)});void 0`);
      await mount(id==='qq'?'component':id,true);
      if(id==='mc-skin')await click('#tab-config');
      await wait(id+' 扫描中',`envTest.pending.some(item=>item.moduleId===${JSON.stringify(id)})`);
      assert.ok((await js(`document.querySelector('[data-environment-results]').textContent`)).includes(name),'扫描中也须点名 '+name);
      await js(`envTest.release(${JSON.stringify(id)});void 0`);await wait(id+' 空状态',`document.querySelector('[data-environment-empty]')`);
      const empty=await js(`document.querySelector('[data-environment-empty]').textContent`);assert.ok(empty.includes(name),empty);assert.doesNotMatch(empty,/未找到本机环境/);
      await js(`envTest.scanError='读取目录失败';void 0`);await click('[data-environment-rescan]');
      await wait(id+' 错误',`document.querySelector('[data-environment-feedback]').textContent.includes('读取目录失败')`);
      assert.ok((await js(`document.querySelector('[data-environment-feedback]').textContent`)).includes(name));
      await js(`envTest.scanError=null;void 0`);
    }
    await js(`envTest.issues.comfyui=[{name:'ComfyUI 本体',path:'E:\\\\broken\\\\ComfyUI',detail:'未找到 server.py'}];void 0`);
    await mount('comfyui',true);await wait('不完整目录详情',`document.querySelector('[data-environment-results]').textContent.includes('server.py')`);
    await js(`envTest.issues.comfyui[0].status='unreadable';envTest.issues.comfyui[0].detail='server.py 权限不足，尚未核实';void 0`);
    await mount('comfyui',true);await wait('权限不足详情',`document.querySelector('[data-environment-results]').textContent.includes('权限不足')`);
    assert.match(await js(`document.querySelector('[data-environment-empty]').textContent`),/无法完成检查/);
    assert.doesNotMatch(await js(`document.querySelector('[data-environment-empty]').textContent`),/不完整|缺少/);
    await js(`envTest.skinRuntime={available:false,missingComponents:[{id:'pillow',name:'Pillow 图像库'}],error:'所选 Python 缺少 Pillow'};void 0`);
    await mount('mc-skin',true);await wait('Pillow 状态',`document.querySelector('#skin-runtime-status').textContent.includes('Pillow')`);
    assert.doesNotMatch(await js(`document.querySelector('#skin-runtime-status').textContent`),/Python 未就绪/);
    checks.push('全部扫描入口的加载、空结果及错误均明确组件；缺文件和 Pillow 错误显示具体原因');

    await js(`envTest.candidates.companion=[{id:'airi-ready',label:'AIRI',path:'E:\\\\ready\\\\AIRI',values:{airiPath:'E:\\\\ready\\\\AIRI'},selectable:true}];envTest.issues.companion=[{name:'陪伴运行组件',path:'E:\\\\configured\\\\AIRI',status:'incomplete',detail:'已保存目录缺少 resources/app.asar',explicit:true},{name:'陪伴运行组件',path:'E:\\\\unrelated',status:'incomplete',detail:'普通扫描目录缺少入口'}];void 0`);
    await mount('companion',true);await wait('可用陪伴候选',`document.querySelector('[data-environment-select="airi-ready"]:not([disabled])')`);
    const companionResults=await js(`document.querySelector('[data-environment-results]').textContent`);
    assert.match(companionResults,/已保存目录缺少 resources\/app\.asar/,'有可用候选时仍显示显式配置的错误');
    assert.ok(companionResults.includes('E:\\configured\\AIRI'),'明确指出错误配置的路径');
    assert.doesNotMatch(companionResults,/普通扫描目录缺少入口|unrelated/,'有可用候选时继续隐藏普通扫描噪音');
    assert.equal(await js(`document.querySelectorAll('[data-environment-select]').length`),1,'错误配置不会伪装成可采用候选');
    checks.push('陪伴可用候选与显式错误配置同时显示，普通扫描噪音仍隐藏');

    const output=process.env.AI_FUTURE_ENV_UI_OUTPUT;
    if(output){
      await js(`envTest.issues.comfyui[0].status='incomplete';envTest.issues.comfyui[0].detail='未找到 server.py';void 0`);
      mkdirSync(output,{recursive:true});await mount('comfyui',true);await wait('截图缺件',`document.querySelector('[data-environment-results]').textContent.includes('server.py')`);
      for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await pause(70);writeFileSync(join(output,`environment-components-${theme}.png`),(await window.webContents.capturePage()).toPNG());}
      await mount('component',true);await wait('QQ 空状态截图',`document.querySelector('[data-environment-empty]')`);await pause(70);writeFileSync(join(output,'napcat-empty.png'),(await window.webContents.capturePage()).toPNG());
      await mount('companion',true);await wait('陪伴显式配置问题截图',`document.querySelector('[data-environment-select="airi-ready"]')`);await pause(70);writeFileSync(join(output,'companion-explicit-issue.png'),(await window.webContents.capturePage()).toPNG());
    }
    assert.deepEqual(errors,[]);console.log('ENVIRONMENT_UI_RESULT '+JSON.stringify(checks));
  }finally{await js(`envTest.controller?.abort();void 0`).catch(()=>{});window.destroy();await session.defaultSession.closeAllConnections();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

if(process.argv.includes('--environment-ui-electron')){
  runBrowserTests().then(()=>createRequire(import.meta.url)('electron').app.quit(),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
}else{
  test('环境发现：真实 Electron DOM 中验证首次扫描、候选采用、草稿保护和模块接入',{skip:!electron,timeout:60000},async t=>{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const profile=await mkdtemp(join(tmpdir(),'environment-ui-'));env.AI_FUTURE_ENV_UI_PROFILE=profile;
    const child=spawn(electron,[fileURLToPath(import.meta.url),'--environment-ui-electron'],{cwd:root,env,windowsHide:true});
    let closed=false;const closure=new Promise(done=>child.once('close',code=>{closed=true;done(code);}));
    t.after(async()=>{if(!closed)child.kill();await closure;assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);closure.then(resolve);});
    assert.equal(code,0,output);assert.ok(output.includes('ENVIRONMENT_UI_RESULT'),output);
  });
}
