import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = [process.env.AI_FUTURE_ELECTRON, join(root, 'node_modules/electron/dist/electron.exe'), 'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

// The browser runs the shipped module, with only the HTTP boundary replaced.
function browserFixture() {
  const copy = value => structuredClone(value);
  const state = {
    runtime:{mode:'managed', running:false, installation:{status:'missing'}, login:{sessionId:null,status:'logged_out',qrcodeUrl:null}, external:{wsUrl:'',accountId:'',hasToken:false}},
    transport:{status:'disconnected'}, paused:true, binding:null, rules:{privateAllow:[],groupAllow:[],requireMention:true}, actualSelfId:null, aiEnabled:true, pending:0, queued:0, generating:0, lastError:null,
  };
  const conversations = [{id:'story-1',selfId:'90001',bindingId:'b1',channel:'private',peerId:'12345',storyId:'s1',sandbox:false,active:true,characterId:'alpha',characterName:'茉茉',revision:1,messageCount:2,updatedAt:'2026-11-07T01:00:00Z'}];
  const messages = [{id:'1',conversationId:'story-1',role:'user',content:'喜欢雨天',userName:'念念',userId:'12345',sourceMessageId:'qq-11',status:'received',createdAt:'2026-11-07T01:00:00Z'}, {id:'2',conversationId:'story-1',role:'assistant',content:'我记住了。',replyTo:'1',gatewayMessageId:'qq-12',status:'confirmed',createdAt:'2026-11-07T01:00:01Z'}];
  const memories = [{id:'memory-1',conversationId:'story-1',content:'念念喜欢雨天',sourceMessageId:'1',sourceQuote:'喜欢雨天',updatedAt:'2026-11-07T01:00:00Z'}];
  const host = {modules:[{id:'qq',name:'QQ 对话',description:'管理 QQ 连接、角色和记录。',discovery:{name:'NapCat QQ 独立运行端'},config:{},settings:[],capabilities:[],requirements:[],optionalIntegrations:[]}], characters:[{id:'alpha',name:'茉茉',revision:1,raw:{name:'茉茉'}},{id:'beta',name:'小璃',revision:2,raw:{name:'小璃',mvu:{}}}],selectedCharacterId:'beta',events:[]};
  const controller = new AbortController();
  const candidates = [
    {id:'qq-component-A',kind:'qq-component',label:'QQ 组件 A',path:'E:\\QQComponents\\DetectedA',values:{installDirectory:'E:\\QQComponents\\DetectedA'},selectable:true},
    {id:'qq-component-B',kind:'qq-component',label:'QQ 组件 B',path:'E:\\QQComponents\\DetectedB',values:{installDirectory:'E:\\QQComponents\\DetectedB'},selectable:true},
  ];
  const fixture = window.qqTest = {state,host,conversations,messages,memories,candidates,calls:[],controller,deferPoll:false,polls:[],deferred:[],pending:[],failRuntime:false};
  fixture.defer = (path,key,method = 'GET') => fixture.deferred.push({path,key,method});
  fixture.release = key => {const index = fixture.pending.findIndex(item => item.key === key);if (index < 0) throw new Error(`未找到延迟响应：${key}`);fixture.pending.splice(index,1)[0].resolve();};
  const publicState = () => { const result = copy(state); result.runtime.login.qrcodeUrl = null; return result; };
  const api = async (url, options = {}) => {
    const path = url.replace('/api/modules/qq', '');
    const {method = 'GET', body} = options;
    fixture.calls.push({path,method,body:copy(body)});
    const reply = value => {
      const index = fixture.deferred.findIndex(item => item.path === path && item.method === method);
      if (index < 0) return value;
      const {key} = fixture.deferred.splice(index,1)[0];
      return new Promise(resolve => fixture.pending.push({key,resolve:() => resolve(copy(value))}));
    };
    if (path.startsWith('/api/environment/state?')) return reply({attempted:false});
    if (path === '/api/environment/scan') return reply({moduleId:body.moduleId,candidates:copy(candidates),partial:false,warnings:[],scannedAt:'2026-11-07T01:00:00Z',canChooseDirectory:true});
    if (path === '/api/environment/choose-directory') return {directory:'E:\\QQComponents',cancelled:false};
    if (path === '/state') return publicState();
    if (path === '/conversations') return {conversations:copy(conversations)};
    const route = path.match(/^\/conversations\/([^/]+)\/(messages|memories)$/);
    if (route?.[2] === 'messages') return reply({conversation:copy(conversations.find(item => item.id === route[1])),messages:copy(messages.filter(item => item.conversationId === route[1])),summary:{content:'',throughSequence:0}});
    if (route?.[2] === 'memories') return reply({conversationId:route[1],memories:copy(memories.filter(item => item.conversationId === route[1]))});
    if (path === '/binding') {
      if (body.characterId === 'beta' && !body.acceptLimited) throw new Error('角色含受限能力：MVU 变量系统。请明确接受基础文字模式后绑定。');
      const character = host.characters.find(item => item.id === body.characterId);
      state.binding = character ? {id:'binding',characterId:character.id,name:character.name,revision:character.revision,compatibility:character.id === 'beta' ? 'limited' : 'supported',unsupportedFeatures:character.id === 'beta' ? ['MVU 变量系统'] : [],acceptedLimited:!!body.acceptLimited} : null;
      state.paused = true; return publicState();
    }
    if (path === '/rules') { state.rules = copy(body); return publicState(); }
    if (path === '/connect') { state.transport.status = 'verified'; state.actualSelfId = '90001'; return publicState(); }
    if (path === '/replies/start') { state.paused = false; return publicState(); }
    if (path === '/replies/pause') { state.paused = true; return publicState(); }
    if (path === '/disconnect') { state.transport.status = 'disconnected';state.paused = true;return publicState(); }
    if (path === '/stop') {state.transport.status='disconnected';state.runtime.running=false;state.runtime.login={sessionId:null,status:'logged_out',qrcodeUrl:null};state.paused=true;return publicState();}
    if (path === '/runtime') {
      if (fixture.failRuntime) throw new Error('QQ 组件核验失败，请重新选择。');
      if(Object.keys(body).length===1&&body.mode===state.runtime.mode)return copy(state.runtime);
      state.runtime.mode = body.mode;
      if (body.installDirectory !== undefined) {state.runtime.installation.installDirectory = body.installDirectory;state.runtime.installation.status = 'ready';}
      if (body.wsUrl !== undefined) state.runtime.external.wsUrl = body.wsUrl;
      if (body.accountId !== undefined) state.runtime.external.accountId = body.accountId;
      if (body.token) state.runtime.external.hasToken = true;
      state.runtime.running = false;state.paused = true;state.transport.status = 'disconnected';
      return reply(copy(state.runtime));
    }
    if (path === '/login/start' || path === '/login/refresh') {
      const sessionId = path === '/login/start' ? 'qr-A' : 'qr-B';
      state.runtime.running = true; state.runtime.login = {sessionId,status:'waiting_qrcode',qrcodeUrl:`https://qq.example.test/scan?session=${sessionId}`};
      return copy(state.runtime);
    }
    if (path === '/login/poll') {
      if (fixture.deferPoll) return new Promise(resolve => fixture.polls.push({sessionId:body.sessionId,resolve}));
      return copy(state.runtime);
    }
    if (path === '/login/cancel') { state.runtime.running = false; state.runtime.login = {sessionId:null,status:'logged_out',qrcodeUrl:null}; return copy(state.runtime); }
    if (path === '/memories') {
      const memory = {id:body.id || 'memory-new',...copy(body),sourceQuote:messages.find(item => item.id === body.sourceMessageId)?.content || null};
      const index = memories.findIndex(item => item.id === memory.id);
      if (index < 0) memories.push(memory); else memories[index] = memory;
      return reply({memory:copy(memory)});
    }
    if (path === '/memories/delete') { const index = memories.findIndex(item => item.id === body.id); if (index >= 0) memories.splice(index,1); return reply({ok:true,deleted:index >= 0}); }
    if (/\/new-story$/.test(path)) { conversations[0].active = false; const conversation = {...conversations[0],id:'story-2',storyId:'s2',active:true,messageCount:0}; conversations.unshift(conversation); return {conversation:copy(conversation)}; }
    throw new Error(`未配置的测试接口：${method} ${path}`);
  };
  fixture.ctx = {state:host,ui:{moduleTabs:{}},signal:controller.signal,api,drafts:new window.Drafts(),refresh:async () => {},notify:() => {},navigate:() => {},action:async (_button,job) => job()};
}

async function runBrowserTests() {
  const {app, BrowserWindow} = createRequire(import.meta.url)('electron');
  app.on('window-all-closed',() => {});
  await app.whenReady();
  const staticRoot = join(root, 'public-workbench');
  const server = createServer(async (req,res) => {
    if (req.url === '/test') {
      res.setHeader('content-type','text/html;charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><style>body{padding:24px}#root{max-width:1240px;margin:auto}</style><div id="root"></div><script type="module">import {Drafts} from '/drafts.js';import {mount} from '/modules/qq.js';window.Drafts=Drafts;window.mountQQ=mount;(${browserFixture.toString()})();await mount(document.querySelector('#root'),window.qqTest.ctx);window.mounted=true;</script>`);
      return;
    }
    try {
      const path = resolve(staticRoot, '.' + decodeURIComponent(req.url.split('?')[0]));
      assert.ok(path.startsWith(staticRoot + sep));
      res.setHeader('content-type',extname(path) === '.css' ? 'text/css' : 'text/javascript');
      res.end(await readFile(path));
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const window = new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{offscreen:true,nodeIntegration:false,contextIsolation:true}});
  const errors = [];
  window.webContents.on('console-message',event => {if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message);});
  const js = source => window.webContents.executeJavaScript(source);
  const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
  const wait = async (label,source) => {const end = Date.now()+10000;while (Date.now()<end) {if (await js(source)) return;await pause(40);}throw new Error(`等待超时：${label}`);};
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const fill = (selector,value) => js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const count = path => js(`qqTest.calls.filter(call=>call.path===${JSON.stringify(path)}).length`);
  const checks = [];
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);
    window.webContents.setZoomFactor(1);
    await wait('三个 QQ 管理入口',`window.mounted && Boolean(document.querySelector('#qq-tab-connect'))`);
    if (process.argv.includes('--qq-ui-environment')) {
      await runEnvironmentTests({js,wait,click,fill,pause,checks});
      if (process.env.QQ_UI_QA_DIR) {
        await fill('#qq-runtime-mode','managed');await js(`document.querySelector('#qq-component-options').open=true;document.querySelector('#qq-component-options').scrollIntoView({block:'start'});void 0`);await pause(150);
        mkdirSync(process.env.QQ_UI_QA_DIR,{recursive:true});writeFileSync(join(process.env.QQ_UI_QA_DIR,'components-desktop.png'),(await window.webContents.capturePage()).toPNG());
      }
      assert.deepEqual(errors,[]);console.log('QQ_UI_RESULT '+JSON.stringify(checks));return;
    }
    if (process.argv.includes('--qq-ui-races')) {
      await runMemoryRaceTests({js,wait,click,fill,pause,checks});
      assert.deepEqual(errors,[]);console.log('QQ_UI_RESULT '+JSON.stringify(checks));return;
    }
    assert.equal(await js(`document.querySelector('#qq-character').value`),'','顶部角色不会自动绑定到 QQ');
    assert.equal(await js(`document.querySelector('#qq-prepare').hidden`),false);
    assert.equal(await js(`Boolean(document.querySelector('input[name="message"],textarea[name="message"],#qq-send'))`),false);
    await fill('#qq-private-allow','12345\n67890');
    await js(`document.querySelector('#qq-private-allow').focus();qqTest.state.runtime.installation.status='ready';void 0`);
    await click('#qq-refresh-state');
    await wait('状态刷新完成',`!document.querySelector('#qq-refresh-state').disabled`);
    assert.equal(await js(`document.querySelector('#qq-private-allow').value`),'12345\n67890');
    checks.push('仅提供 QQ 管理；初始角色独立，刷新保留规则草稿');

    await fill('#qq-character','alpha');
    await click('#qq-save-binding');await wait('角色绑定',`qqTest.state.binding?.characterId==='alpha'`);
    await click('#qq-save-rules');await wait('范围保存',`qqTest.state.rules.privateAllow.length===2`);
    await js(`qqTest.state.runtime.running=true;qqTest.state.runtime.login={sessionId:'online',status:'online',accountId:'90001',nickname:'测试账号',qrcodeUrl:null};void 0`);
    await click('#qq-refresh-state');await wait('可开始扮演',`!document.querySelector('#qq-start').disabled`);
    await click('#qq-start');await wait('开始扮演',`qqTest.state.paused===false`);
    assert.deepEqual(await js(`qqTest.calls.filter(call=>['/connect','/replies/start'].includes(call.path)).map(call=>call.path)`),['/connect','/replies/start']);
    await fill('#qq-character','beta');await click('#qq-save-binding');
    await wait('受限能力确认',`Boolean(document.querySelector('#qq-accept-limited')) && !document.querySelector('#qq-limited-confirm').hidden`);
    assert.equal(await js(`document.querySelector('#qq-accept-limited').checked`),false);
    await click('#qq-accept-limited');await click('#qq-save-binding');await wait('基础文字模式绑定',`qqTest.state.binding?.characterId==='beta'`);
    assert.equal(await js(`qqTest.state.binding.acceptedLimited`),true);
    assert.equal(await js(`document.querySelector('#qq-limited-confirm').hidden`),true,'基础文字模式绑定成功后收起确认');
    checks.push('先验证真实账号再开始，动态卡必须显式接受基础文字模式');

    await js(`document.querySelector('#qq-external-options').open=true;void 0`);await click('#qq-save-runtime');
    await wait('原配置保存',`document.querySelector('#qq-runtime-feedback').textContent.includes('已保存')`);
    assert.equal(await js(`document.querySelector('#qq-transport-status').textContent`),'账号已验证','保存原配置不能假报断开');
    if(process.env.QQ_UI_QA_DIR){mkdirSync(process.env.QQ_UI_QA_DIR,{recursive:true});writeFileSync(join(process.env.QQ_UI_QA_DIR,'managed-online.png'),(await window.webContents.capturePage()).toPNG());}

    await click('#qq-disconnect');await wait('断开工作台连接',`qqTest.state.transport.status==='disconnected'`);
    assert.equal(await js(`qqTest.state.runtime.login.status`),'online','断开后仍保留 QQ 登录');
    assert.equal(await count('/stop'),0);
    assert.equal(await js(`document.querySelector('#qq-disconnect').textContent`),'断开连接');
    await click('#qq-stop');await wait('停止 QQ 后台',`qqTest.state.runtime.login.status==='logged_out'`);
    assert.equal(await count('/stop'),1);checks.push('断开连接保留登录端，独立停止按钮结束后台 QQ');
    await js(`qqTest.deferPoll=true;void 0`);await click('#qq-login');
    await wait('扫码会话',`document.querySelector('#qq-qrcode').dataset.sessionId==='qr-A'`);
    await wait('旧扫码轮询已开始',`qqTest.polls.length===1`);
    await click('#qq-refresh-code');await wait('刷新二维码',`document.querySelector('#qq-qrcode').dataset.sessionId==='qr-B'`);
    await js(`qqTest.polls.shift().resolve({...qqTest.state.runtime,login:{sessionId:'qr-A',status:'online',accountId:'11111',qrcodeUrl:null}});void 0`);
    await pause(150);
    assert.equal(await js(`document.querySelector('#qq-qrcode').dataset.sessionId`),'qr-B');
    assert.equal(await js(`document.querySelector('#qq-account').textContent.includes('11111')`),false);
    assert.equal(await js(`document.querySelector('#qq-qrcode svg')!==null`),true,'二维码由本地编码库绘制');
    await click('#qq-refresh-state');await pause(100);
    assert.equal(await js(`document.querySelector('#qq-qrcode svg')!==null`),true,'普通状态的空二维码不能覆盖当前码');
    const cancellations = await count('/login/cancel');
    await click('#qq-tab-conversations');await pause(1600);
    assert.equal(await count('/login/cancel'),cancellations,'离开扫码页面不取消后台会话');
    checks.push('二维码只接受匹配会话，普通状态不清码，切页不取消后台登录');

    await wait('只读会话',`Boolean(document.querySelector('[data-qq-conversation="story-1"]'))`);
    await click('[data-qq-conversation="story-1"]');
    await wait('消息来源',`document.querySelector('#qq-messages')?.textContent.includes('qq-11')`);
    assert.equal(await js(`document.querySelector('#qq-messages').textContent.includes('网关已确认')`),true);
    await click('#qq-tab-memories');
    await wait('记忆列表',`Boolean(document.querySelector('[data-edit-memory="memory-1"]'))`);
    await click('[data-edit-memory="memory-1"]');
    await fill('#qq-memory-content','念念喜欢雨天和窗边');await click('#qq-save-memory');
    await wait('记忆保存',`qqTest.memories[0].content==='念念喜欢雨天和窗边'`);
    assert.equal(await js(`qqTest.memories[0].sourceMessageId`),'1');
    await click('[data-delete-memory="memory-1"]');
    assert.equal(await js(`document.querySelector('[data-memory-delete-confirm="memory-1"]').textContent.includes('无法恢复')`),true);
    await click('[data-confirm-delete-memory="memory-1"]');await wait('记忆删除',`qqTest.memories.length===0`);
    await click('#qq-new-story');
    assert.equal(await js(`document.querySelector('#qq-new-story-confirm').textContent.includes('保留')`),true);
    await click('#qq-confirm-new-story');await wait('新故事',`qqTest.conversations[0].id==='story-2'`);
    assert.equal(await js(`qqTest.conversations.find(item=>item.id==='story-1').active`),false);
    checks.push('记录只读并显示来源/送达，记忆可编辑删除，新故事保留旧资料');

    await click('#qq-tab-connect');
    await wait('连接页恢复',`Boolean(document.querySelector('#qq-runtime-mode'))`);
    await js(`document.querySelector('#qq-external-options').open=true;void 0`);
    await fill('#qq-runtime-mode','external');await fill('#qq-ws-url','ws://127.0.0.1:3001');await fill('#qq-expected-account','90001');await fill('#qq-token','not-a-real-token');
    await click('#qq-save-runtime');await wait('外接网关保存',`qqTest.state.runtime.mode==='external'`);
    assert.equal(await js(`document.querySelector('#qq-managed-login').hidden`),true);
    assert.equal(await js(`document.querySelector('#qq-token').value`),'');
    const draftText = await js(`JSON.stringify(qqTest.ctx.drafts.read('qq:runtime',{}))`);
    assert.equal(draftText.includes('not-a-real-token'),false);
    await js(`document.querySelector('#qq-tab-memories').focus();document.querySelector('#qq-tab-memories').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));void 0`);
    assert.equal(await js(`document.activeElement.id`),'qq-tab-conversations');
    checks.push('外接网关隐藏扫码且令牌不进入草稿，业务标签支持键盘');

    if (process.env.QQ_UI_QA_DIR) {
      mkdirSync(process.env.QQ_UI_QA_DIR,{recursive:true});
      for (const [name,width,height,theme,zoom] of [['desktop',1440,1100,'light',1],['dark',1440,1100,'dark',1],['desktop-125',1440,1100,'light',1.25]]) {
        window.setContentSize(width,height);
        window.webContents.setZoomFactor(zoom);
        await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#qq-tab-connect').click();void 0`);await pause(200);
        assert.equal(await js(`document.documentElement.scrollWidth>window.innerWidth`),false,`${name} 不横向溢出`);
        writeFileSync(join(process.env.QQ_UI_QA_DIR,`${name}.png`),(await window.webContents.capturePage()).toPNG());
      }
    }
    assert.deepEqual(errors,[]);
    console.log('QQ_UI_RESULT '+JSON.stringify(checks));
  } finally {
    window.destroy();
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await stopped;
  }
}

async function runEnvironmentTests({js,wait,click,fill,pause,checks}) {
  const candidate = id => `#qq-component-discovery [data-environment-select="${id}"]`;
  const runtimeCount = () => js(`qqTest.calls.filter(call=>call.path==='/runtime').length`);
  const scanCount = () => js(`qqTest.calls.filter(call=>call.path==='/api/environment/scan').length`);
  const reset = async (mode = 'managed') => {
    await js(`(async()=>{qqTest.controller.abort();(${browserFixture.toString()})();qqTest.state.runtime.mode=${JSON.stringify(mode)};qqTest.state.runtime.installation.installDirectory='E:\\\\QQComponents\\\\Existing';await window.mountQQ(document.querySelector('#root'),qqTest.ctx);})()`);
    await wait('组件位置',`Boolean(document.querySelector('#qq-component-directory'))`);
  };
  await reset();
  await wait('自动扫描候选',`Boolean(document.querySelector(${JSON.stringify(candidate('qq-component-A'))}))`);
  assert.equal(await js(`document.querySelector('#qq-component-directory').readOnly`),false,'未运行时允许手动填写组件路径');
  const existing = await js(`document.querySelector('#qq-component-directory').value`);
  assert.ok(existing.endsWith('Existing'));
  assert.equal(await scanCount(),1);
  assert.equal(await runtimeCount(),0,'自动扫描不配置 QQ');
  const manual='E:\\QQComponents\\Manual';await fill('#qq-component-directory',manual);
  assert.equal(await js(`qqTest.ctx.drafts.read('qq:component',{}).installDirectory`),manual);
  await click('#qq-component-discovery [data-environment-rescan]');await wait('重新扫描完成',`!document.querySelector('#qq-component-discovery [data-environment-rescan]').disabled`);
  assert.equal(await js(`document.querySelector('#qq-component-directory').value`),manual,'未选择的扫描结果不能覆盖手动路径');
  await click(candidate('qq-component-A'));
  assert.equal(await js(`document.querySelector('#qq-component-directory').value`),'E:\\QQComponents\\DetectedA');
  assert.equal(await runtimeCount(),0,'选择候选只更新草稿');
  assert.equal(await js(`qqTest.ctx.drafts.read('qq:component',{}).installDirectory`),'E:\\QQComponents\\DetectedA');
  checks.push('受管页首次自动扫描，手动路径与候选采用均只更新草稿');

  await js(`qqTest.failRuntime=true;void 0`);await click('#qq-save-component');
  await wait('采用失败保留草稿',`document.querySelector('#qq-feedback').textContent.includes('核验失败')`);
  assert.equal(await js(`document.querySelector('#qq-component-directory').value`),'E:\\QQComponents\\DetectedA');
  assert.equal(await js(`qqTest.ctx.drafts.read('qq:component',{}).installDirectory`),'E:\\QQComponents\\DetectedA');
  await js(`qqTest.failRuntime=false;void 0`);await click('#qq-save-component');
  await wait('组件位置已保存',`document.querySelector('#qq-component-feedback').textContent.includes('已保存')`);
  assert.deepEqual(await js(`qqTest.calls.filter(call=>call.path==='/runtime').at(-1).body`),{installDirectory:'E:\\QQComponents\\DetectedA',mode:'managed'});
  assert.equal(await js(`qqTest.calls.some(call=>['/connect','/login/start','/replies/start'].includes(call.path)||call.path.includes('/install'))`),false,'明确保存位置仍不启动、连接或安装');
  checks.push('明确保存才提交位置；校验失败保留草稿，不自动启动或写入令牌');
  await fill('#qq-component-directory',manual);await click('#qq-save-component');
  await wait('手动组件位置保存',`qqTest.state.runtime.installation.installDirectory===${JSON.stringify(manual)}`);
  assert.equal(await js(`qqTest.calls.filter(call=>call.path==='/runtime').at(-1).body.installDirectory`),manual);

  await click(candidate('qq-component-B'));
  await js(`qqTest.defer('/runtime','component-save','PUT');void 0`);await click('#qq-save-component');
  await wait('组件保存延迟',`qqTest.pending.some(item=>item.key==='component-save')`);
  await click('#qq-tab-conversations');await js(`qqTest.ctx.drafts.write('qq:component',{installDirectory:'E:\\\\QQComponents\\\\NewDraft'});void 0`);await click('#qq-tab-connect');
  const newer = await js(`document.querySelector('#qq-component-directory').value`);
  await js(`qqTest.release('component-save');void 0`);await pause(70);
  assert.equal(await js(`document.querySelector('#qq-component-directory').value`),newer,'迟到保存响应保留后来的草稿');
  assert.equal(await js(`qqTest.ctx.drafts.read('qq:component',{}).installDirectory`),newer);

  await js(`qqTest.state.runtime.running=true;qqTest.state.runtime.login={sessionId:'running',status:'waiting_qrcode',qrcodeUrl:null};void 0`);await click('#qq-refresh-state');
  await wait('运行时锁定组件',`document.querySelector('#qq-save-component').disabled && document.querySelector(${JSON.stringify(candidate('qq-component-A'))}).disabled`);
  await click(candidate('qq-component-A'));
  assert.equal(await js(`document.querySelector('#qq-component-directory').value`),newer);
  await js(`qqTest.state.runtime.running=false;qqTest.state.runtime.login={sessionId:'online',status:'online',accountId:'90001'};void 0`);await click('#qq-refresh-state');
  await wait('已登录时锁定组件',`document.querySelector('#qq-save-component').disabled`);
  checks.push('迟到响应保留新草稿，运行和登录期间禁止更换组件');

  await reset('external');
  assert.equal(await scanCount(),0,'外接模式不加载扫描');
  assert.equal(await js(`document.querySelector('#qq-managed-login').hidden`),true);
  await fill('#qq-runtime-mode','managed');assert.equal(await scanCount(),0,'未保存的模式选择不启动扫描');
  await click('#qq-save-runtime');
  await wait('受管模式加载扫描',`Boolean(document.querySelector(${JSON.stringify(candidate('qq-component-A'))}))`);
  const before = await js(`document.querySelector('#qq-component-directory').value`);
  await fill('#qq-runtime-mode','external');
  assert.equal(await js(`document.querySelector(${JSON.stringify(candidate('qq-component-A'))}).disabled`),true);
  await click(candidate('qq-component-A'));
  assert.equal(await js(`document.querySelector('#qq-component-directory').value`),before);
  checks.push('外接模式不扫描，模式变化后再次检查是否允许采用');
}

async function runMemoryRaceTests({js,wait,click,fill,pause,checks}) {
  const select = async id => {await click(`[data-qq-conversation="${id}"]`);await wait(`会话 ${id}`,`document.querySelector('#qq-story-heading')?.textContent.includes('${id === 'story-1' ? '12345' : '67890'}')`);};
  const held = key => wait(`延迟响应 ${key}`,`qqTest.pending.some(item=>item.key===${JSON.stringify(key)})`);
  const release = async key => {await js(`qqTest.release(${JSON.stringify(key)});void 0`);await pause(70);};
  const reset = async (tab = 'memories') => {
    await js(`(async()=>{qqTest.controller.abort();(${browserFixture.toString()})();qqTest.conversations.push({...qqTest.conversations[0],id:'story-B',peerId:'67890',storyId:'sB'});qqTest.messages.push({id:'3',conversationId:'story-B',role:'user',content:'B独立消息',userName:'另一位用户',status:'received'});qqTest.memories.push({id:'memory-B',conversationId:'story-B',content:'B独立记忆',sourceMessageId:'3',sourceQuote:'B独立消息'});qqTest.ctx.ui.moduleTabs.qq=${JSON.stringify(tab)};await window.mountQQ(document.querySelector('#root'),qqTest.ctx);})()`);
    await wait('首个会话资料',`document.querySelector('#qq-story-heading')?.textContent.includes('12345')`);
  };
  const updateB = async () => {
    await click('[data-edit-memory="memory-B"]');await fill('#qq-memory-content','B编辑后的记忆');await click('#qq-save-memory');
    await wait('B记忆保存',`document.querySelector('#qq-memory-list')?.textContent.includes('B编辑后的记忆')`);
    assert.equal(await js(`document.querySelector('#qq-memory-list').textContent.includes('A迟到')`),false,'A 的迟到写入不能混入 B 的记忆列表');
  };

  await reset('conversations');
  await js(`qqTest.messages[0].content='A旧消息';qqTest.defer('/conversations/story-1/messages','old-detail');void 0`);
  await click('[data-qq-conversation="story-1"]');await held('old-detail');
  await select('story-B');await js(`qqTest.messages[0].content='A较新消息';void 0`);await select('story-1');
  await wait('较新详情',`document.querySelector('#qq-messages')?.textContent.includes('A较新消息')`);
  await release('old-detail');
  assert.equal(await js(`document.querySelector('#qq-messages').textContent.includes('A较新消息')`),true,'切换 A → B → A 后，旧的 A 响应不能覆盖新详情');
  checks.push('详情以请求序号接收，A → B → A 的旧响应不会覆盖新详情');

  for (const edit of [false,true]) {
    await reset();
    if (edit) await click('[data-edit-memory="memory-1"]');
    await fill('#qq-memory-content',edit ? 'A迟到修正' : 'A迟到新增');
    await js(`qqTest.defer('/memories','late-save','POST');void 0`);await click('#qq-save-memory');await held('late-save');
    await select('story-B');await release('late-save');await updateB();
  }
  checks.push('新增和修正记忆的迟到响应不会混入其他会话');

  await reset();
  await js(`qqTest.defer('/memories/delete','late-delete','POST');void 0`);
  await click('[data-delete-memory="memory-1"]');await click('[data-confirm-delete-memory="memory-1"]');await held('late-delete');
  await js(`qqTest.defer('/conversations/story-B/messages','B-loading');void 0`);await click('[data-qq-conversation="story-B"]');await held('B-loading');
  await release('late-delete');await release('B-loading');
  await wait('B仍可完成读取',`document.querySelector('#qq-memory-list')?.textContent.includes('B独立记忆')`);
  assert.equal(await js(`document.querySelector('#qq-story-heading').textContent.includes('67890')`),true);
  checks.push('迟到删除不改变当前会话，也不取消新会话正在进行的读取');

  for (const remove of [false,true]) {
    await reset();
    await js(`qqTest.defer('/conversations/story-1/memories','stale-memory-read');void 0`);await click('[data-qq-conversation="story-1"]');await held('stale-memory-read');
    if (remove) {
      await click('[data-delete-memory="memory-1"]');await click('[data-confirm-delete-memory="memory-1"]');
      await wait('本地记忆已删除',`!document.querySelector('[data-edit-memory="memory-1"]')`);
    } else {
      await click('[data-edit-memory="memory-1"]');await fill('#qq-memory-content','A最新修正');await click('#qq-save-memory');
      await wait('本地记忆已修正',`document.querySelector('#qq-memory-list')?.textContent.includes('A最新修正')`);
    }
    await release('stale-memory-read');
    assert.equal(await js(`document.querySelector('#qq-memory-list').textContent.includes('念念喜欢雨天')`),false,'较早的读取不能撤销记忆修正或恢复已删除的记忆');
    if (!remove) assert.equal(await js(`document.querySelector('#qq-memory-list').textContent.includes('A最新修正')`),true);
  }
  checks.push('写入和删除会使先前的详情快照失效，不回滚修正或恢复删除项');

  await reset();
  await fill('#qq-memory-content','A迟到新增');await js(`qqTest.defer('/memories','ABA-save','POST');void 0`);await click('#qq-save-memory');await held('ABA-save');
  await select('story-B');await select('story-1');await fill('#qq-memory-content','返回 A 后正在写的新草稿');
  await release('ABA-save');
  assert.equal(await js(`document.querySelector('#qq-memory-content').value`),'返回 A 后正在写的新草稿','离开又返回同一会话后，旧表单响应不能清空新草稿');
  checks.push('返回同一会话后仍保留新编辑器中的草稿');

  await click('#qq-tab-connect');
  const rangeHelp = await js(`document.querySelector('[aria-label="回复范围说明"]').dataset.help`);
  assert.ok(rangeHelp.includes('修改角色会暂停扮演'));
  assert.ok(rangeHelp.includes('修改回复范围会取消旧回复'));
  assert.equal(rangeHelp.includes('保存后需重新开始扮演'),false);
  checks.push('回复范围说明与后端的暂停和取消行为一致');
}

if (process.argv.includes('--qq-ui-electron')) {
  runBrowserTests().then(() => createRequire(import.meta.url)('electron').app.exit(0),error => {console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
} else {
  for (const [name,extra] of [['QQ 管理模块：真实 DOM 中验证扫码时序、独立绑定、草稿与只读记录',[]],['QQ 记忆与详情：真实 DOM 中验证跨会话迟到响应和写入顺序',['--qq-ui-races']],['QQ 组件扫描：真实 DOM 中验证候选草稿与明确保存',['--qq-ui-environment']]]) test(name, {skip:!electron,timeout:60000}, async t => {
    const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron,[fileURLToPath(import.meta.url),'--qq-ui-electron',...extra],{cwd:root,env,windowsHide:true});
    t.after(() => {if (child.exitCode === null) child.kill();});
    let output = '';
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(code,0,output);
    assert.ok(output.includes('QQ_UI_RESULT'),output);
  });
}
