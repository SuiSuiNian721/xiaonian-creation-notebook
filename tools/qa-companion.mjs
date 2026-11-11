import electron from 'electron';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectAiriInstall} from '../framework/companion-source.mjs';
import {createWorkbench} from '../framework/server.mjs';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {WorkbenchImmersion} from '../desktop/workbench-immersion.cjs';

const {app,BrowserWindow}=electron;
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=resolve(process.env.AI_FUTURE_COMPANION_QA_DIR||join(root,'qa','companion-native'));
await mkdir(output,{recursive:true});
app.setPath('userData',join(output,'profile'));
let host;
let runtime,modelServer;
const report={checks:[],errors:[]};
const write=async(name,value)=>writeFile(join(output,name),Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value,null,2),'utf8');
process.on('uncaughtException',error=>{report.errors.push(error.stack);void write('uncaught.json',report.errors);});
await app.whenReady();
const window=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{contextIsolation:true,sandbox:true,preload:join(root,'desktop/workbench-preload.cjs'),offscreen:true,backgroundThrottling:false}});
const immersion=new WorkbenchImmersion({getWindow:()=>window,ipcMain:electron.ipcMain});immersion.attach(window.webContents);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(label,predicate,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await delay(100);}throw new Error('等待超时：'+label);}
const js=async code=>{try{return await window.webContents.executeJavaScript(code,true);}catch(error){throw new Error('工作台页面操作失败：'+code.slice(0,260)+'\n'+error.message,{cause:error});}};
const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);
async function captureModule(name){
  const directory=join(root,'.impeccable/review');await mkdir(directory,{recursive:true});
  window.webContents.invalidate();
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  await delay(250);
  const base=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  if(!host.area.visible||!host.activeWindow?.embedded||!host.activeWindow.view.getVisible()){
    await writeFile(join(directory,name+'.png'),base.toPNG());return;
  }
  const active=host.activeWindow,layer=await active.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
  const bounds=active.view.getBounds(),[width,height]=window.getContentSize();
  report.captures||={};report.captures[name]={bounds,root:[width,height],layer:layer.getSize(),viewport:await active.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,ratio:devicePixelRatio})')};
  const dimensions=report.captures[name];
  assert.equal(dimensions.viewport.width,bounds.width,'原生截图视口宽度必须匹配实际视图');
  assert.equal(dimensions.viewport.height,bounds.height,'原生截图视口高度必须匹配实际视图');
  assert.ok(Math.abs(dimensions.layer.width/bounds.width-dimensions.layer.height/bounds.height)<0.01,'合成截图不能改变原生画面的比例');
  await write(name+'-native.png',layer.toPNG());
  const composite=new BrowserWindow({show:false,width,height,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}});
  try{
    const html=`<!doctype html><html><body style="margin:0;overflow:hidden"><img src="${base.toDataURL()}" style="position:absolute;inset:0;width:${width}px;height:${height}px"><img src="${layer.toDataURL()}" style="position:absolute;left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px"></body></html>`;
    await composite.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));await delay(100);
    await writeFile(join(directory,name+'.png'),(await composite.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  }finally{composite.destroy();}
}
const requests=[];
const live=process.env.AI_FUTURE_COMPANION_LIVE==='1';
const reply=live?'茉茉已接入工作台':'隔离模型已通过工作台连接回复。'+Date.now();
const privateText='仅属于角色 A 的测试内容 '+Date.now();
try {
  const native=await import('../desktop/companion-host.cjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
  assert.equal(typeof native.CompanionHost,'function','必须实现完整 AIRI 桌面宿主');
  report.sampleRequests=[];
  host=new native.CompanionHost({getWindow:()=>window,qa:true,onError:error=>report.errors.push(String(error)),onContents:(contents,view)=>{
    immersion.attach(contents,{moduleId:'companion',isEligibleSource:()=>view.embedded&&host.activeWindow===view&&host.area.visible});
    contents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{if(/hiyori[^/]*\.zip|AvatarSample_[^/]*\.vrm/i.test(details.url))report.sampleRequests.push(details.url);callback({});});
  }});
  const install=inspectAiriInstall();assert.equal(install.available,true,install.reason);
  modelServer=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');requests.push(value);
    if(!value.stream){
      const content=value.messages?.[0]?.content?.startsWith('整理已经发生')?JSON.stringify({memories:[{content:'用户发送过工程接入测试内容',kind:'fact',sourceQuote:privateText}],expressions:[],state:{mood:'平静'},diary:'完成了一轮工程接入测试。'}):reply;
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'qa',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(`data: ${JSON.stringify({id:'qa',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:reply},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'qa',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve=>modelServer.listen(0,'127.0.0.1',resolve));
  runtime=await createWorkbench({dataDir:join(output,'data'),companionOptions:{host}});
  const api=async(path,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(runtime.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(value));return value;
  };
  await api('/api/modules/companion/enable',{});
  await api('/api/modules/cards/enable',{});
  await api('/api/preferences',{theme:'light'});
  let connection={provider:'openai',enabled:true,baseUrl:`http://127.0.0.1:${modelServer.address().port}/v1`,model:'qa-model',apiKey:'qa-secret'};
  if(live){
    const original=new DatabaseSync(join(app.getPath('appData'),'AI-Future-Workbench/data/workbench.sqlite'),{readOnly:true});
    try{connection=JSON.parse(original.prepare('SELECT value FROM settings WHERE name=?').get('ai.connection').value);}finally{original.close();}
    assert.equal(connection.enabled,true,'真实共用 AI 应已启用');
    report.live={provider:connection.provider,model:connection.model};
  }
  await api('/api/ai/config',connection,'PUT');
  const {character}=await api('/api/characters',{name:'茉茉',description:'隔离测试角色，工程伙伴'});await api('/api/characters/select',{id:character.id});
  await window.loadURL(runtime.url+'#/module/companion');
  await wait('完整运行端',()=>host.started);
  report.network=[];
  host.session.webRequest.onBeforeSendHeaders({urls:[runtime.url+'/*']},(details,callback)=>{
    report.network.push({path:new URL(details.url).pathname,method:details.method,origin:details.requestHeaders.Origin||details.requestHeaders.origin||null,site:details.requestHeaders['Sec-Fetch-Site']||details.requestHeaders['sec-fetch-site']||null});
    callback({requestHeaders:details.requestHeaders});
  });
  await wait('模块实际显示',()=>js('!!document.querySelector("#companion-tab-stage")'));
  await wait('陪伴说明入口',()=>js('!!document.querySelector("[data-module-help=companion]")'));
  if(await js('!!document.querySelector("[data-module-tour]:popover-open")'))await click('[data-tour-skip]');
  report.checks.push('完整主进程和原生服务初始化');
  report.visibility=await js('({hidden:document.hidden,viewport:document.querySelector("#companion-viewport").getBoundingClientRect().toJSON()})');
  for(const view of ['stage','chat','settings']) {
    await click('#companion-tab-'+view);
    if(view==='stage'){
      const stage=[...host.windows.values()].find(window=>window.kind==='stage').webContents;
      await wait('内置模型目录',()=>stage.executeJavaScript('document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("display-models").displayModels.some(model=>model.id==="display-model-builtin-ds-whale")'));
      await stage.executeJavaScript('document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("settings-stage-model-selection").selected="";void 0');
      await wait('无模型空状态',()=>js('!!document.querySelector("#companion-stage-empty:not([hidden])")'));
      await wait('无模型渲染状态完成初始化',()=>stage.executeJavaScript('document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("settings-stage-model").stageModelRenderer==="disabled"'));
      assert.equal(host.model.available,false);assert.equal(await js('document.querySelector("#companion-desktop").disabled'),true);
      report.stage=await stage.executeJavaScript('(()=>{const p=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia,s=p._s.get("settings-stage-model");return {selected:s.stageModelSelected,renderer:s.stageModelRenderer,models:p._s.get("display-models").displayModels.map(m=>({id:m.id,name:m.name}))};})()');
      assert.equal(report.stage.selected,'');assert.equal(report.stage.renderer,'disabled');assert.equal(report.stage.models.some(model=>model.id.startsWith('preset-')),false);
      report.channel=await stage.executeJavaScript('(()=>{const p=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia;return {url:localStorage.getItem("settings/connection/websocket-url"),connected:p._s.get("mods:channels:proj-airi:server")?.connected};})()');
      assert.equal(report.channel.url,`ws://127.0.0.1:${host.serverChannelPort}/ws`);
      await captureModule('companion-empty');report.checks.push('无示例模型，个人模型导入入口与无模型聊天入口可用');continue;
    }
    if(view==='settings'){
      await wait('平台设置首页',()=>js('!document.querySelector("#companion-settings").hidden'));
      await wait('平台设置隐藏原生视图',()=>host.area.visible===false);
      await captureModule('desktop');
      await click('#companion-settings [data-companion-route="/settings/models"]');
    }
    await wait(view+' 视图切换',()=>host.activeWindow?.kind===view);
    const contents=host.activeWindow.webContents;
    await delay(1200);
    await contents.executeJavaScript('document.getAnimations({subtree:true}).forEach(a=>{if(a.effect?.getTiming().iterations!==Infinity)try{a.finish()}catch{}});void 0;');
    const page=await contents.executeJavaScript('({text:document.body.innerText.slice(0,4000),url:location.href,canvas:document.querySelectorAll("canvas").length,pinia:!!document.querySelector("#app")?.__vue_app__?.config.globalProperties?.$pinia})');
    assert.ok(page.text.trim()||page.canvas>0,view+' 页面不能空白');
    assert.doesNotMatch(page.text,/\bAIRI\b/i,view+' 展示应使用平台名称');
    assert.doesNotMatch(await contents.executeJavaScript('document.title'),/\bAIRI\b/i);
    report[view]=page;
    if(view==='chat'){
      await click('[data-module-help="companion"]');
      await wait('使用说明遮挡原生层',()=>host.area.visible===false);
      await click('[data-start-tour]');
      await wait('引导显示',()=>js('!!document.querySelector("[data-module-tour]:popover-open")'));
      assert.equal(host.area.visible,false);
      await captureModule('companion-guide');
      await click('[data-tour-skip]');
      await wait('关闭引导恢复同一个聊天视图',()=>host.area.visible&&host.activeWindow.webContents===contents);
      report.checks.push('陪伴说明与引导让原生视图隐藏，关闭后恢复同一个聊天实例');
      report.chatInputs=await contents.executeJavaScript('[...document.querySelectorAll("textarea,input,[contenteditable=true]")].map(e=>({tag:e.tagName,placeholder:e.getAttribute("placeholder"),disabled:e.disabled}))');
      await contents.executeJavaScript(`(()=>{const input=document.querySelector('textarea')||document.querySelector('[contenteditable=true]');if(!input)throw new Error('没有找到聊天输入');input.focus();if(input.tagName==='TEXTAREA')input.value=${JSON.stringify(live?'这是工程接入测试。只回复“茉茉已接入工作台”，不要调用任何工具。':privateText)};else input.textContent=${JSON.stringify(privateText)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      contents.sendInputEvent({type:'keyDown',keyCode:'Enter'});contents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await delay(300);
      report.chatState=await contents.executeJavaScript('(()=>{const p=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia;const c=p._s.get("consciousness");return {activeProvider:c?.activeProvider,activeModel:c?.activeModel,activeCustomModel:c?.activeCustomModelName,input:document.querySelector("textarea")?.value,text:document.body.innerText,chatKeys:Object.keys(p._s.get("chat")||{}),sessionKeys:Object.keys(p._s.get("chat-session")||{})};})()');
      if(!live)await wait('聊天请求进入工作台模型桥',()=>requests.length>0);
      await wait('原生聊天显示助手回复',()=>contents.executeJavaScript(`(()=>{const messages=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat-session').messages;return messages.some(message=>message.role==='assistant'&&JSON.stringify(message.content).includes(${JSON.stringify(reply)}));})()`),live?180000:25000);
      if(!live){
        await write('model-requests.json',requests);
        const chatRequest=requests.find(value=>!value.messages?.[0]?.content?.startsWith('整理已经发生')&&value.messages?.some(message=>message.role==='user'&&JSON.stringify(message.content).includes(privateText)));
        assert.ok(chatRequest,'应找到真实输入对应的聊天请求');assert.equal(chatRequest.model,'qa-model');assert.match(chatRequest.messages.map(message=>message.content).join('\n'),/茉茉/);
        await wait('原生回复确认后写入角色记忆',async()=>{const value=await api('/api/characters/'+character.id+'/life');return value.memories.some(memory=>memory.sourceQuote===privateText);});
        report.checks.push('原生会话实际写入助手回复后才整理有来源的长期记忆');
      }
      report.assistantReply=await contents.executeJavaScript(`(()=>{const messages=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat-session').messages;return JSON.parse(JSON.stringify(messages.filter(message=>message.role==='assistant').at(-1)?.content));})()`);
      await write('chat-reply.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      report.checks.push('实际聊天控件经过工作台 AI 连接并显示助手回复');
      const lead=[...host.windows.values()].find(window=>window.kind==='stage').webContents;
      const before=await lead.executeJavaScript('(()=>{const p=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia;return {card:p._s.get("airi-card").activeCardId,session:p._s.get("chat-session").activeSessionId};})()');
      const next=await api('/api/characters',{name:'角色 B',description:'另一位隔离测试角色'});await api('/api/characters/select',{id:next.character.id});
      await wait('原生卡片切换',()=>lead.executeJavaScript('document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("airi-card").activeCard?.name==="角色 B"'));
      const after=await lead.executeJavaScript('(()=>{const p=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia;return {card:p._s.get("airi-card").activeCardId,session:p._s.get("chat-session").activeSessionId,messages:JSON.parse(JSON.stringify(p._s.get("chat-session").messages))};})()');
      assert.notEqual(before.card,after.card);assert.notEqual(before.session,after.session);assert.equal(JSON.stringify(after.messages).includes(privateText),false);
      report.checks.push('切换工作台角色同步原生卡片，并隔离历史会话');
    }
    await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});await delay(350);
    await write(view+'.png',(await contents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    report.checks.push(view+' 页面实际载入');
  }
  const settings=host.activeWindow.webContents;
  report.settingsPages=[];
  for(const route of ['/settings/airi-card','/settings/modules','/settings/models','/settings/scene','/settings/memory','/settings/providers','/settings/connection','/settings/system','/settings/modules/mcp','/settings/modules/vision','/settings/modules/hearing','/settings/modules/speech','/settings/modules/gaming-minecraft','/settings/modules/gaming-factorio','/settings/modules/artistry']){
    await settings.executeJavaScript(`document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(${JSON.stringify(route)})`);
    await delay(180);
    const page=await settings.executeJavaScript('({text:document.body.innerText,route:location.hash})');
    assert.ok(page.text.trim(),route+' 应显示真实页面');
    if(route==='/settings/models')assert.doesNotMatch(page.text,/Hiyori|AvatarSample|Neuro-sama|Grok Ani|Switch to Godot|Click 选择模型/i);
    if(route==='/settings/modules/hearing'){
      assert.doesNotMatch(page.text,/Audio Input Device|Auto-send Settings|Auto-send transcribed text|Automatically send transcribed text/);
      assert.match(page.text,/这会调用对话模型/);
      await settings.executeJavaScript('(()=>{const target=[...document.querySelectorAll("*")].find(element=>element.children.length===0&&element.textContent.includes("识别后稍等片刻"));target?.scrollIntoView({block:"center"});})()');
      await delay(900);
      await settings.capturePage(undefined,{stayHidden:true,stayAwake:true});await delay(350);
      await write('hearing-adapted.png',(await settings.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      report.hearingText=page.text;
    }
    if(route==='/settings/modules/speech')assert.doesNotMatch(page.text,/Use Custom SSML|Enable to input raw SSML/);
    if(route==='/settings/modules/vision')assert.doesNotMatch(page.text,/Vision capture cadence|Tune how frequently|Lower values capture/);
    assert.doesNotMatch(page.text,/\bAIRI\b/i,route+' 应使用平台名称');report.settingsPages.push({route,text:page.text.slice(0,350)});
  }
  report.checks.push('15 个原生设置子页面实际载入');
  for(const route of ['/about','/onboarding']){
    await settings.executeJavaScript(`document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(${JSON.stringify(route)})`);
    await delay(500);
    const text=await settings.executeJavaScript('document.body.innerText');assert.ok(text.trim());assert.doesNotMatch(text,/\bAIRI\b/i,route+' 应使用平台名称');
  }
  assert.ok(host.brandIcon&&!host.brandIcon.isEmpty());
  for(const owned of host.windows.values())assert.doesNotMatch(owned.getTitle(),/\bAIRI\b/i);
  assert.doesNotMatch(await js('document.body.innerText'),/\bAIRI\b/i);
  report.checks.push('入口、设置、首次配置、关于页面、窗口标题与图标使用平台品牌');
  await click('#companion-settings-back');await wait('返回平台设置',()=>js('!document.querySelector("#companion-settings").hidden'));
  await wait('原生视图隐藏',()=>!host.area.visible);
  await click('#theme-toggle');
  await wait('深色主题同步',()=>js('document.documentElement.dataset.theme==="dark"'));
  await delay(300);
  report.desktopControls=await js('[...document.querySelectorAll("#companion-desktop,[data-module-ai-control=companion]")].map(button=>{const css=getComputedStyle(button);return {text:button.innerText,color:css.color,background:css.backgroundColor,disabled:button.disabled};})');
  await captureModule('desktop-dark');
  report.checks.push('桌面明暗主题实际检查，截图视口与原生视图等比一致');
  const key=(contents,keyCode)=>{contents.focus();contents.sendInputEvent({type:'keyDown',keyCode});contents.sendInputEvent({type:'keyUp',keyCode});};
  await click('#companion-tab-stage');await click('#companion-immerse');
  await wait('陪伴沉浸',()=>js('document.documentElement.dataset.immersive==="companion"'));
  const immersed=await js('(()=>{const box=document.querySelector("#companion-viewport").getBoundingClientRect();return {sidebar:getComputedStyle(document.querySelector(".sidebar")).display,topbar:getComputedStyle(document.querySelector(".topbar")).display,x:box.x,width:box.width,height:box.height,windowWidth:innerWidth,windowHeight:innerHeight};})()');
  assert.equal(immersed.sidebar,'none');assert.equal(immersed.topbar,'none');assert.equal(immersed.x,0);assert.equal(immersed.width,immersed.windowWidth);assert.ok(immersed.height>=immersed.windowHeight-50);
  await captureModule('companion-immersive');
  key(window.webContents,'F11');await wait('真实窗口全屏',()=>window.isFullScreen());
  key(window.webContents,'F11');await wait('保留沉浸退出全屏',()=>!window.isFullScreen()&&immersion.state().active);
  key(window.webContents,'Escape');await wait('回到工作台',()=>js('!document.documentElement.dataset.immersive'));
  report.checks.push('陪伴沉浸隐藏工作台并铺满窗口，F11切换真实全屏，Esc返回');
  await click('#companion-tab-chat');await wait('聊天视图',()=>host.activeWindow?.kind==='chat'&&host.area.visible);
  const chat=host.activeWindow.webContents,chatDraft='沉浸模式退出后保留的聊天草稿';
  await chat.executeJavaScript(`(()=>{const input=document.querySelector('textarea');input.value=${JSON.stringify(chatDraft)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('#companion-immerse');await wait('聊天沉浸视图布局',()=>host.area.y===48);
  await captureModule('chat-immersive');
  key(chat,'F11');await wait('原生聊天焦点全屏',()=>window.isFullScreen());
  key(chat,'Escape');await wait('原生聊天焦点返回',()=>!immersion.state().active&&!window.isFullScreen());
  assert.equal(await chat.executeJavaScript('document.querySelector("textarea").value'),chatDraft);
  report.checks.push('原生聊天焦点F11/Esc生效，聊天草稿保留');
  await click('[data-module-ai-control="companion"]');
  await wait('AI 浮层避让原生视图',()=>host.state().visible===false);
  await click('[data-ai-close]');
  await wait('关闭浮层恢复原生视图',()=>host.state().visible===true);
  report.checks.push('AI 接入浮层不被原生视图遮挡');
  await api('/api/modules/cards/studio',{});
  const cardName='沉浸验证作品 '+Date.now();await api('/card-studio/api/new',{name:cardName});
  await js("location.hash='/module/cards';void 0");
  await wait('写卡器作品列表',()=>js(`!!document.querySelector('[data-edit-card="${cardName}"]')`));
  await wait('角色卡说明入口',()=>js('!!document.querySelector("[data-module-help=cards]")'));
  if(await js('!!document.querySelector("[data-module-tour]:popover-open")'))await click('[data-tour-skip]');
  await click(`[data-edit-card="${cardName}"]`);
  await wait('写卡器载入',()=>js('!!document.querySelector("#card-studio-frame")?.contentWindow?.__workbenchReady?.()&&!document.querySelector("#card-editor").hidden'));
  await js('window.__qaFrame=document.querySelector("#card-studio-frame");window.__qaEditor=window.__qaFrame.contentWindow;void 0;');
  const editorDraft='未保存的写卡草稿 '+Date.now();
  await js('(()=>{const editor=window.__qaEditor,doc=editor.document;if(editor.state.mode!=="edit")doc.querySelector("#btn-mode").click();})()');
  await wait('写卡器编辑模式',()=>js('!!window.__qaEditor.document.querySelector("#btn-edit-picker")'));
  await js('(()=>{const doc=window.__qaEditor.document;doc.querySelector("#btn-edit-picker").click();const field=[...doc.querySelectorAll("#picker-pop button")].find(button=>button.textContent.trim()==="描述");if(!field)throw new Error("没有找到描述字段");field.click();})()');
  await wait('写卡器正文字段',()=>js('!!window.__qaEditor.document.querySelector("#pane textarea")'));
  await js(`(()=>{const editor=window.__qaEditor,input=editor.document.querySelector('#pane textarea');input.value=${JSON.stringify(editorDraft)};input.dispatchEvent(new editor.Event('input',{bubbles:true}));})()`);
  await wait('写卡器切换编辑模式后聊天输入完成恢复',()=>js('window.__qaEditor.document.querySelector("#chat-input")?.disabled===false'));
  await js(`(()=>{const editor=window.__qaEditor,doc=editor.document;const input=doc.querySelector('#chat-input');input.value=${JSON.stringify(editorDraft)};input.dispatchEvent(new editor.Event('input',{bubbles:true}));input.focus();})()`);
  report.cardDrafts={before:await js('({chat:window.__qaEditor.document.querySelector("#chat-input").value,body:window.__qaEditor.document.querySelector("#pane textarea").value})')};
  await click('[data-module-help="cards"]');await click('[data-start-tour]');
  assert.equal(await js('document.querySelector("#card-studio-frame")===window.__qaFrame&&window.__qaFrame.contentWindow===window.__qaEditor'),true);
  assert.equal(await js('window.__qaEditor.document.querySelector("#chat-input").value'),editorDraft);
  assert.equal(await js('window.__qaEditor.document.querySelector("#pane textarea").value'),editorDraft);
  await js('window.__qaEditor.document.querySelector("#chat-input").focus();void 0;');
  key(window.webContents,'Escape');
  await wait('写卡器焦点 Esc 关闭引导',()=>js('!document.querySelector("[data-module-tour]:popover-open")'));
  await click('[data-module-help="cards"]');await click('[data-start-tour]');
  await click('#cards-immerse');await wait('写卡器沉浸',()=>js('document.documentElement.dataset.immersive==="cards"'));
  await wait('进入沉浸模式收起引导',()=>js('!document.querySelector("[data-module-tour]:popover-open")&&!document.documentElement.hasAttribute("data-module-help-open")'));
  assert.equal(await js('document.querySelector("#card-studio-frame")===window.__qaFrame&&window.__qaFrame.contentWindow===window.__qaEditor'),true);
  const editorBox=await js('document.querySelector("#card-studio-frame").getBoundingClientRect().toJSON()');assert.equal(editorBox.x,0);assert.ok(editorBox.height>=window.getContentSize()[1]-50);
  await captureModule('cards-immersive');
  await js('window.__qaEditor.document.querySelector("#chat-input").focus();void 0;');
  key(window.webContents,'F11');await wait('写卡iframe焦点F11',()=>window.isFullScreen());
  key(window.webContents,'Escape');await wait('写卡iframe焦点Esc',()=>!window.isFullScreen()&&!immersion.state().active);
  assert.equal(await js('document.querySelector("#card-studio-frame")===window.__qaFrame&&window.__qaFrame.contentWindow===window.__qaEditor'),true);
  assert.equal(await js('window.__qaEditor.document.querySelector("#chat-input").value'),editorDraft);
  assert.equal(await js('window.__qaEditor.document.querySelector("#pane textarea").value'),editorDraft);
  report.cardDrafts.after=await js('({chat:window.__qaEditor.document.querySelector("#chat-input").value,body:window.__qaEditor.document.querySelector("#pane textarea").value})');
  report.checks.push('写卡器沉浸和iframe焦点快捷键通过，编辑器实例、未保存正文及聊天草稿保留');
  await js("location.hash='/home';void 0");await wait('离开模块隐藏原生视图',()=>host.state().visible===false);
  host.viewport({visible:false});
  assert.equal(host.state().visible,false);
  report.checks.push('离开模块隐藏原生视图');
  report.state=host.state();
  await host.close();host=null;
  assert.equal(window.isDestroyed(),false,'关闭 AIRI 不能关闭工作台');
  report.checks.push('运行端退出保留宿主窗口');
  assert.deepEqual(report.sampleRequests,[],'不能加载上游示例模型资源');
  report.ok=report.errors.length===0;
} catch(error) {report.ok=false;report.errors.push(error.stack||String(error));report.diagnostics=host?.diagnostics;report.failedWorkbench=await js('document.body.innerText').catch(()=>null);if(host?.activeWindow&&!host.activeWindow.webContents.isDestroyed())report.failedText=await host.activeWindow.webContents.executeJavaScript('document.body.innerText').catch(()=>null);}
finally {
  immersion.close();
  if(host)await host.close().catch(error=>report.errors.push(error.stack));
  if(runtime)await runtime.close().catch(error=>report.errors.push(error.stack));
  if(modelServer)await new Promise(resolve=>modelServer.close(resolve));
  await write('result.json',report);
  app.exit(report.ok?0:1);
}
