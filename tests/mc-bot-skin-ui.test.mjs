import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32,deflateSync} from 'node:zlib';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron='F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
function png(){
  const chunk=(type,data)=>{const tag=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([size,tag,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(64,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc(64*257);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const offset=y*257+x*4+1;pixels.set([115,94,164,255],offset);}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(){
  const {mount}=await import('/mc-play-view.js'),{Drafts}=await import('/drafts.js');
  const f=window.skinFixture={calls:[],controller:new AbortController(),revision:0};
  f.state={runtime:{available:true,version:'fixture'},config:{playerName:'ConfiguredBot',serverHost:'127.0.0.1',serverPort:25565},connection:{status:'disconnected',playerName:'ActualBot'},history:[],aiEnabled:false,skin:{image:null,texture:null,generation:{status:'idle',message:''},application:{status:'idle',message:''},hasApiKey:false,busy:false}};
  f.ctx={signal:f.controller.signal,ui:{moduleTabs:{}},drafts:new Drafts(),state:{events:[],modules:[]},refresh:async()=>{},notify:()=>{},api:async(path,options={})=>{
    f.calls.push({path,method:options.method||'GET',body:options.body});
    if(path.startsWith('/api/environment/'))return {attempted:true,result:{candidates:[],issues:[],warnings:[]}};
    if(path.endsWith('/state'))return structuredClone(f.state);
    if(path.endsWith('/connection')&&options.method==='PUT')f.state.config={...f.state.config,...options.body};
    else if(path.endsWith('/connect'))f.state.connection={...f.state.connection,status:'connected',skinProtocol:1,playerName:f.state.config.playerName};
    else if(path.endsWith('/disconnect'))f.state.connection.status='disconnected';
    else if(path.endsWith('/command')){if(options.body.kind==='pause')f.state.connection.paused=true;if(options.body.kind==='resume')f.state.connection.paused=false;}
    else if(path.endsWith('/skin')&&options.method==='PUT'){
      const image=new Image();image.src='data:image/png;base64,'+options.body.base64;await image.decode();
      f.state.skin.image={id:String(++f.revision),name:options.body.name,width:image.naturalWidth,height:image.naturalHeight,model:options.body.model,previewUrl:'/instances/test-bot/api/modules/mc-play/skin/image?revision='+f.revision};
      f.state.skin.texture=null;f.state.skin.application={status:'changed',message:''};
    }else if(path.endsWith('/skin')&&options.method==='PATCH'){
      if(options.body.model){f.state.skin.image.model=options.body.model;f.state.skin.texture=null;f.state.skin.application={status:'changed',message:''};}
      if(options.body.apiKey)f.state.skin.hasApiKey=true;
      if(options.body.clearApiKey)f.state.skin.hasApiKey=false;
    }else if(path.endsWith('/skin/apply')){f.state.skin.busy=true;f.state.skin.generation={status:'waiting',message:'MineSkin 正在生成纹理'};f.state.skin.application={status:'generating',message:'正在准备皮肤'};}
    else if(path.endsWith('/skin/reset')){f.state.skin.application={status:'applied',mode:'default',message:'已恢复世界默认皮肤'};}
    else throw new Error('意外请求 '+path);
    const snapshot=structuredClone(f.state),result=path.endsWith('/command')?{state:snapshot}:snapshot;
    if(f.delayNext){f.delayNext=false;return new Promise(done=>{f.resolveMutation=()=>{f.resolveMutation=undefined;done(result);};});}return result;
  }};
  f.chooseFile=async(height=64,name='念念的皮肤.png')=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=height;canvas.getContext('2d').fillRect(0,0,64,height);
    const blob=await new Promise(done=>canvas.toBlob(done,'image/png')),transfer=new DataTransfer();transfer.items.add(new File([blob],name,{type:'image/png'}));
    const input=document.querySelector('[data-bot-skin-file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  };
  mount(document.querySelector('#root'),f.ctx);window.ready=true;
}
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.MC_BOT_SKIN_UI_DIR,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const image=png(),requests=[],errors=[];
  const server=createServer(async(req,res)=>{
    requests.push(req.url);
    if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>body{padding:32px}#root{max-width:1080px;margin:auto}</style><main id="root"></main><script type="module">(${fixture.toString()})();</script></html>`);}
    if(req.url.startsWith('/instances/test-bot/api/modules/mc-play/skin/image?')){res.setHeader('content-type','image/png');return res.end(image);}
    try{const path=resolve(root,'public-workbench','.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(join(root,'public-workbench')+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1320,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source,true),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async expression=>{const until=Date.now()+8000;while(Date.now()<until){if(await js(expression))return;await pause(30);}throw new Error('等待皮肤界面超时：'+expression+' '+errors.join('\n'));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);await wait('window.ready && !!document.querySelector("#mc-connection-form")');
    assert.equal(await js('!!document.querySelector("#mc-tab-skin")'),true,'MC 实例必须提供皮肤页');
    assert.equal(await js('document.querySelector("#mc-player-name").textContent'),'ActualBot','显示实际连接玩家名');
    await js('document.querySelector("#mc-player").value="DraftBot";document.querySelector("#mc-player").dispatchEvent(new Event("input",{bubbles:true}));void 0');
    await click('#mc-tab-skin');await wait('!!document.querySelector("[data-bot-skin-file]")');
    assert.equal(await js('document.querySelector("[data-bot-skin-apply]").disabled'),true);
    assert.equal(await js('document.querySelector("[data-bot-skin-reset]").disabled'),true);
    await js('skinFixture.chooseFile()');await wait('!!document.querySelector("[data-bot-skin-preview]").dataset.ready');
    assert.deepEqual(await js('skinFixture.calls.filter(call=>call.method!=="GET").map(call=>[call.path,call.method])'),[['/api/modules/mc-play/skin','PUT']],'导入只保存 PNG，不发起上传与应用');
    assert.equal(await js('document.querySelector("[data-bot-skin-apply]").textContent'),'上传并应用');
    assert.match(await js('document.querySelector("[data-bot-skin-upload-note]").textContent'),/MineSkin/);
    assert.ok(requests.some(path=>path.startsWith('/instances/test-bot/api/modules/mc-play/skin/image?')),'预览直接使用实例作用域 URL');
    await js('skinFixture.state.connection.status="connected";void 0');await pause(2000);
    assert.equal(await js('document.querySelector("[data-bot-skin-apply]").disabled'),true,'旧运行端没有皮肤协议时不能应用');
    await js('skinFixture.state.connection.skinProtocol=1;void 0');await wait('!document.querySelector("[data-bot-skin-apply]").disabled');
    await js('document.querySelector("[data-bot-skin-key-settings]").open=true;document.querySelector("[data-bot-skin-key]").value="draft-secret";document.querySelector("[data-bot-skin-key]").focus();document.querySelector("[data-bot-skin-key]").dispatchEvent(new Event("input",{bubbles:true}));void 0');
    await pause(2000);
    assert.deepEqual(await js('[document.activeElement.hasAttribute("data-bot-skin-key"),document.activeElement.value]'),[true,'draft-secret'],'轮询保留输入内容和焦点');
    await click('[data-bot-skin-key-save]');await wait('document.querySelector("[data-bot-skin-key]").value===""');
    assert.equal(await js('document.querySelector("[data-bot-skin-key]").type'),'password');
    assert.equal(await js('document.querySelector("[data-bot-skin-key-clear]").disabled'),false);
    await click('[data-bot-skin-key-clear]');await wait('document.querySelector("[data-bot-skin-key-clear]").disabled');
    await click('[data-bot-skin-apply]');await wait('document.querySelector("[data-bot-skin-replace]").disabled');
    assert.equal(await js('document.querySelector("[data-bot-skin-model]").disabled'),true);
    assert.match(await js('document.querySelector("[data-bot-skin-generation]").textContent'),/MineSkin/);
    await js('skinFixture.state.skin.busy=false;skinFixture.state.skin.texture={url:"https://textures.minecraft.net/texture/fixture",model:"classic"};skinFixture.state.skin.generation={status:"ready",message:"纹理已准备"};skinFixture.state.skin.application={status:"applied",mode:"custom",message:"已应用到世界"};void 0');
    await wait('document.querySelector("[data-bot-skin-apply]").textContent==="应用到世界"');
    assert.equal(await js('document.querySelector("[data-bot-skin-upload-note]").hidden'),true);
    await js('document.querySelector("[data-bot-skin-model]").value="slim";document.querySelector("[data-bot-skin-model]").dispatchEvent(new Event("change",{bubbles:true}));void 0');
    await wait('skinFixture.calls.some(call=>call.body?.model==="slim")');
    await click('[data-bot-skin-reset]');await wait('document.querySelector("[data-bot-skin-application]").textContent.includes("默认")');
    assert.ok(await js('skinFixture.state.skin.image'),'恢复默认保留本地 PNG');
    const preview=await js('document.querySelector("[data-bot-skin-preview]").toDataURL()');
    await js('skinFixture.state.skin.application={status:"error",message:"世界连接中断，请重新连接后重试"};void 0');
    await wait('document.querySelector("[data-bot-skin-application]").textContent.includes("连接中断")');
    assert.equal(await js('document.querySelector("[data-bot-skin-preview]").toDataURL()'),preview,'应用失败保留预览');
    await js('skinFixture.chooseFile(32,"旧版皮肤.png")');await wait('skinFixture.state.skin.image.height===32 && !document.querySelector("[data-bot-skin-model]").disabled');
    assert.equal(await js('document.querySelector("[data-bot-skin-model]").value'),'classic');
    assert.equal(await js('document.querySelector("[data-bot-skin-model] option[value=slim]").disabled'),true);
    const mutationCount=await js('skinFixture.calls.filter(call=>call.method!=="GET").length');
    await js('skinFixture.chooseFile(40,"尺寸不对.png")');await wait('document.querySelector("[data-bot-skin-feedback]").classList.contains("error")');
    assert.equal(await js('skinFixture.calls.filter(call=>call.method!=="GET").length'),mutationCount,'错误尺寸不提交到后端');
    await js('skinFixture.delayNext=true;skinFixture.chooseFile()');await wait('!!skinFixture.resolveMutation');
    await click('#mc-tab-play');assert.equal(await js('document.querySelector("#mc-player").value'),'DraftBot','返回陪玩页保留未保存连接草稿');
    await js('skinFixture.resolveMutation();void 0');await pause(100);
    assert.ok(await js('!!document.querySelector("#mc-connection-form")'),'离开皮肤页后返回的异步结果不能改写新页面');
    const pixels=await js(`(async()=>{
      const {drawBotSkin}=await import('/mc-bot-skin-view.js');const source=document.createElement('canvas');source.width=64;source.height=64;const context=source.getContext('2d');const fill=(x,y,w,h,color)=>{context.fillStyle=color;context.fillRect(x,y,w,h);};
      fill(8,8,8,8,'#ff0000');fill(40,8,4,8,'#0000ff');fill(44,20,4,12,'#00ff00');fill(36,52,4,12,'#ffff00');fill(52,20,4,12,'#ff00ff');fill(44,52,4,12,'#00ffff');
      const canvas=document.createElement('canvas'),sample=(x,y)=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data);drawBotSkin(canvas,source,'classic');const modern=[sample(88,40),sample(128,40),sample(60,110),sample(156,110),sample(380,110),sample(284,110)];
      drawBotSkin(canvas,source,'slim');const slim=sample(52,110);
      source.height=32;fill(44,20,2,12,'#ff0000');fill(46,20,2,12,'#0000ff');drawBotSkin(canvas,source,'classic');const legacy=[sample(52,110),sample(148,110),sample(172,110)];
      fill(0,0,64,32,'#000000');fill(8,8,8,8,'#ff0000');fill(24,8,8,8,'#00ff00');const original=source.toDataURL();drawBotSkin(canvas,source);const opaqueLegacy=[sample(88,40),sample(312,40)],sourceUnchanged=source.toDataURL()===original;
      context.clearRect(0,0,1,1);drawBotSkin(canvas,source);const outsideTransparency=sample(88,40);
      fill(40,8,8,8,'#0000ff');fill(56,8,8,8,'#ffff00');const alpha=new ImageData(new Uint8ClampedArray([0,0,0,128]),1,1);context.putImageData(alpha,63,31);drawBotSkin(canvas,source);const legacyAlpha128=sample(88,40);
      alpha.data[3]=127;context.putImageData(alpha,63,31);drawBotSkin(canvas,source);const legacyAlpha127=[sample(88,40),sample(312,40)];
      source.height=64;fill(0,0,64,64,'#000000');fill(8,8,8,8,'#ff0000');fill(40,8,8,8,'#0000ff');drawBotSkin(canvas,source);const modernOpaque=sample(88,40);
      return {modern,slim,legacy,opaqueLegacy,sourceUnchanged,outsideTransparency,legacyAlpha128,legacyAlpha127,modernOpaque};
    })()`);
    assert.deepEqual(pixels.modern,[[0,0,255,255],[255,0,0,255],[0,255,0,255],[255,255,0,255],[255,0,255,255],[0,255,255,255]],'正背面分别使用基础层和外层 UV');
    assert.equal(pixels.slim[3],0,'Alex 手臂比 Steve 窄一像素');
    assert.deepEqual(pixels.legacy,[[255,0,0,255],[0,0,255,255],[255,0,0,255]],'64×32 左臂使用右臂水平镜像');
    assert.deepEqual(pixels.opaqueLegacy,[[255,0,0,255],[0,255,0,255]],'64×32 不透明旧帽层背景不能遮住正面与背面的头部');
    assert.equal(pixels.sourceUnchanged,true,'旧版兼容只影响预览，保留原始像素');
    assert.deepEqual(pixels.outsideTransparency,[255,0,0,255],'Minecraft 1.20.1 的旧帽层检测只检查图片右半区');
    assert.deepEqual(pixels.legacyAlpha128,[255,0,0,255],'右半区 alpha=128 仍按旧版不透明背景处理');
    assert.deepEqual(pixels.legacyAlpha127,[[0,0,255,255],[255,255,0,255]],'右半区存在 alpha<128 时保留旧版自定义帽层');
    assert.deepEqual(pixels.modernOpaque,[0,0,255,255],'旧版兼容不得清除现代皮肤的帽层');
    await click('#mc-tab-skin');assert.equal(await js('document.querySelector("[data-bot-skin-key]").maxLength'),512,'API Key 长度上限与后端一致');
    const chooseSkin=async name=>{await js(`skinFixture.chooseFile(64,${JSON.stringify(name)})`);await wait(`document.querySelector('[data-bot-skin-filename]').textContent.includes(${JSON.stringify(name)}) && !document.querySelector('[data-bot-skin-replace]').disabled`);};
    await js('skinFixture.state.connection.status="disconnected";void 0');await chooseSkin('保存前.png');
    await click('#mc-tab-play');
    await js('document.querySelector("#mc-player").value="SavedBot";document.querySelector("#mc-player").dispatchEvent(new Event("input",{bubbles:true}));skinFixture.delayNext=true;void 0');
    await click('#mc-save');await wait('!!skinFixture.resolveMutation');
    await click('#mc-tab-skin');await chooseSkin('保存期间更新.png');
    await js('skinFixture.resolveMutation();void 0');await pause(50);
    await click('#mc-tab-play');await click('#mc-tab-skin');
    assert.match(await js('document.querySelector("[data-bot-skin-filename]").textContent'),/保存期间更新/,'延迟连接保存返回不能覆盖期间保存的新皮肤');
    await click('#mc-tab-play');assert.equal(await js('document.querySelector("#mc-player").value'),'SavedBot','延迟保存仍在服务端保存配置');
    await js('skinFixture.delayNext=true;void 0');await click('#mc-save');await wait('!!skinFixture.resolveMutation');
    await click('#mc-tab-skin');await click('#mc-tab-play');
    await js('document.querySelector("#mc-player").value="LaterDraft";document.querySelector("#mc-player").dispatchEvent(new Event("input",{bubbles:true}));skinFixture.resolveMutation();void 0');await pause(50);
    assert.deepEqual(await js('[document.querySelector("#mc-player").value,document.querySelector("#mc-feedback").textContent]'),['LaterDraft',''],'旧保存回调不能改写重新打开页面的草稿或反馈');
    const connects=await js('skinFixture.calls.filter(call=>call.path.endsWith("/connect")).length');
    await js('skinFixture.delayNext=true;void 0');await click('#mc-connect');await wait('!!skinFixture.resolveMutation');
    await click('#mc-tab-skin');await js('skinFixture.resolveMutation();void 0');
    await wait(`skinFixture.calls.filter(call=>call.path.endsWith('/connect')).length===${connects+1}`);
    assert.equal(await js('skinFixture.state.connection.status'),'connected','点击连接后切页不会取消保存后的连接请求');
    await chooseSkin('指令前.png');await click('#mc-tab-play');
    await js('skinFixture.delayNext=true;void 0');await click('#mc-pause');await wait('!!skinFixture.resolveMutation');
    await click('#mc-tab-skin');await chooseSkin('指令期间更新.png');await click('#mc-tab-play');
    await js('skinFixture.resolveMutation();void 0');await pause(50);
    assert.equal(await js('document.querySelector("#mc-feedback").textContent'),'','旧快捷命令回调不能写入重新打开页面的反馈');
    assert.equal(await js('skinFixture.state.connection.paused'),true,'快捷命令的服务端操作继续完成');
    await click('#mc-tab-skin');assert.match(await js('document.querySelector("[data-bot-skin-filename]").textContent'),/指令期间更新/,'快捷命令旧状态不能覆盖新皮肤');
    await click('#mc-tab-play');await js('skinFixture.delayNext=true;void 0');await click('#mc-disconnect');await wait('!!skinFixture.resolveMutation');
    await click('#mc-tab-skin');await chooseSkin('断开期间更新.png');await js('skinFixture.resolveMutation();void 0');await pause(50);
    await click('#mc-tab-play');await click('#mc-tab-skin');
    assert.match(await js('document.querySelector("[data-bot-skin-filename]").textContent'),/断开期间更新/,'延迟断开回调不能覆盖新皮肤');
    assert.equal(await js('skinFixture.state.connection.status'),'disconnected','切页后已经提交的断开仍完成');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.deepEqual(errors,[]);console.log('MC_BOT_SKIN_UI_OK');
  }finally{await js('skinFixture.controller.abort();void 0').catch(()=>{});window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
if(process.argv.includes('--mc-bot-skin-ui'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('实际 Electron MC 皮肤：本地导入、协议门槛、应用状态、像素预览与页面生命周期',{skip:!existsSync(electron),timeout:40000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mc-bot-skin-ui-')),env={...process.env,MC_BOT_SKIN_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--mc-bot-skin-ui'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/MC_BOT_SKIN_UI_OK/);
});
