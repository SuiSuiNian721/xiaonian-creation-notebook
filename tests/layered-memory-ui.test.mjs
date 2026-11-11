import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

async function run(kind='main'){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.AI_FUTURE_MEMORY_UI_DIR,'profile'));
  app.on('window-all-closed',()=>{});await app.whenReady();
  let aiCalls=0;
  const backend=await createWorkbench({dataDir:join(process.env.AI_FUTURE_MEMORY_UI_DIR,'data'),aiOptions:{fetchImpl:async()=>{aiCalls++;throw new Error('记忆界面 GET 不应请求模型');}}});
  const api=async(path,body)=>{const response=await fetch(backend.url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const character=(await api('/api/characters',{name:'青禾',description:'分层记忆界面测试角色'})).character;
  const path='/api/characters/'+character.id+'/life',life=backend.context.life,data=life.data;
  for(const id of ['character-lite','character-full']){
    await api('/api/modules/'+id+'/enable',{});const base='/api/modules/'+id+'/resources',plan=await api(base+'/plan',{optionalIds:[]});
    if(plan.canInstall){await api(base+'/install',{optionalIds:[],planId:plan.planId});for(let n=0;n<100;n++){const state=await api(base);if(state.prerequisitesReady)break;assert.notEqual(state.task?.status,'failed');await new Promise(done=>setTimeout(done,20));}}
  }
  await api(path+'/settings',{mode:'lite',enabled:true,memory:{enabled:true,autoExtract:false}});
  const stamp='2026-11-08T02:00:00.000Z';
  for(const [suffix,name] of [['a','念念'],['b','另一位朋友']]){
    const subjectKey='qq:private:'+suffix,scope='qq:private-'+suffix;
    data.put(character.id,'memory-subject',{id:subjectKey,subjectKey,name,moduleId:'qq',channel:'private',peerId:suffix,userId:suffix});
    data.put(character.id,'scope',{id:scope,scope,moduleId:'qq',conversationId:'private-'+suffix,subjectKey,userId:suffix,channel:'private',peerId:suffix});
  }
  for(const userId of ['30001','30002']){const subjectKey='qq:group:10001:'+userId;data.put(character.id,'memory-subject',{id:subjectKey,subjectKey,name:'小明',moduleId:'qq',channel:'group',peerId:'10001',userId});}
  const seed=(id,content,category,extra={})=>data.put(character.id,'memory',{id,content,category,layerVersion:1,scope:'qq:private-a',sourceScope:'qq:private-a',subjectKey:'qq:private:a',reality:'real',confidence:'explicit',canonicalKey:id,sourceId:'message-'+id,sourceQuote:'我喜欢先听结论',sourceCreatedAt:stamp,sourceSequence:1,evidence:[{sourceId:'message-'+id,scope:'qq:private-a',quote:'我喜欢先听结论',createdAt:stamp,userId:'a',role:'user'}],kind:category==='trait'?'preference':category==='plan'?'plan':'fact',status:'active',pinned:false,revision:1,entities:[],relations:[],expiresAt:null,origin:'learned',...extra});
  seed('trait-a','喜欢先听结论','trait');
  seed('experience-a','一起排查过识图接入','experience');
  seed('story-a','故事里共同经营温室','relationship',{reality:'story'});
  seed('inferred-a','可能偏好安静的交流','trait',{reality:'uncertain',confidence:'inferred'});
  seed('plan-a','周末整理温室','plan',{planStatus:'pending',expiresAt:'2030-11-09T10:00:00.000Z'});
  seed('done-a','已经选好种子','plan',{planStatus:'completed'});
  seed('expired-a','昨天给花浇水','plan',{planStatus:'pending',expiresAt:'2020-01-01T00:00:00.000Z'});
  seed('cancelled-a','取消旧的采购安排','plan',{planStatus:'cancelled'});
  seed('archived-a','暂时不使用的旧特点','trait',{status:'archived'});
  seed('trait-b','喜欢详尽的推导','trait',{scope:'qq:private-b',sourceScope:'qq:private-b',subjectKey:'qq:private:b',sourceQuote:'我喜欢详尽的推导',evidence:[{sourceId:'message-trait-b',scope:'qq:private-b',quote:'我喜欢详尽的推导',createdAt:stamp,userId:'b',role:'user'}]});
  await api(path+'/memories',{content:'手工留下的旧记忆',scope:'shared',kind:'fact'});
  life.saveMemorySummary(character.id,{moduleId:'qq',conversationId:'private-a',content:'今天讨论了识图接入，也约好了整理温室。'});
  data.put(character.id,'memory-job',{id:'qq:private-a',scope:'qq:private-a',status:'running',processed:2,total:8,cursor:2});
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,source)=>{const end=Date.now()+10000;while(Date.now()<end){if(await js(source))return;await pause(25);}throw new Error('等待超时：'+label+' '+await js(`document.querySelector('[data-life-feedback]')?.textContent||''`));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const input=(name,value)=>js(`(()=>{const node=document.querySelector('[data-character-life] [name='+CSS.escape(${JSON.stringify(name)})+']');if(node.type==='checkbox')node.checked=${JSON.stringify(value)};else node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const text=selector=>js(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const tab=async name=>{await click('[data-life-tab="'+name+'"]');await wait(name,`!!document.querySelector('[data-life-panel="${name}"]')`);};
  const saved=()=>wait('保存结束',`document.querySelector('[data-life-feedback]').textContent.startsWith('已保存')&&!document.querySelector('[data-life-save]').disabled`);
  const capture=async name=>{
    const directory=join(root,'artifacts','layered-memory-ui-20261108');await mkdir(directory,{recursive:true});
    await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');window.webContents.invalidate();await pause(150);
    let bitmap;
    try{bitmap=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});}
    catch(error){if(!/UnknownVizError/.test(error.message))throw error;window.webContents.invalidate();await pause(250);bitmap=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});}
    await writeFile(join(directory,name+'.png'),bitmap.toPNG());
  };
  try{
    await window.loadURL(backend.url+'#/characters');window.webContents.debugger.attach('1.3');await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await wait('角色列表',`!!document.querySelector('[data-character-life-id]')`);
    await js(`(async()=>{const {openCharacterLife}=await import('/character-life.js');const {Drafts}=await import('/drafts.js');const f=window.memoryUI={calls:[],defer:false,fail:false,aborted:0,overviewCalls:0};const originalTimeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>originalTimeout(fn,[3000,5000,10000].includes(ms)?180:ms,...args);f.ctx={state:{selectedCharacterId:${JSON.stringify(character.id)},characters:[${JSON.stringify(character)}],modules:[]},drafts:new Drafts(),refresh:async()=>{},fetch:async(url,options={})=>{f.calls.push({url,body:options.body});const overview=url.includes('/memory/overview');if(overview)f.overviewCalls++;const response=await fetch(url,options);if(overview&&f.defer){f.defer=false;await new Promise(done=>{f.release=done;options.signal.addEventListener('abort',()=>f.aborted++,{once:true});});if(f.fail){f.fail=false;throw new Error('旧读取错误');}}return response;}};f.open=(moduleId='qq',conversationId='private-a')=>openCharacterLife(f.ctx,{moduleId,conversationId});f.open();})()`);
    await wait('人设',`!!document.querySelector('[data-life-panel="profile"]')`);await tab('memory');
    await wait('分层分类',`document.querySelector('[data-life-memory-overview]')?.textContent.includes('喜欢先听结论')`);
    const overview=await text('[data-life-memory-overview]');
    for(const label of ['会话摘要','对话对象特点','共同经历与关系','计划与待办','初步理解','剧情','明确表达','待完成','已完成','已过期','已取消','已归档'])assert.match(overview,new RegExp(label));
    assert.equal(await js(`document.querySelectorAll('[data-life-tab]:not([hidden])').length`),3);
    assert.ok(await js(`document.querySelector('[name="memory.continuity"]')`));
    assert.match(await text('label[for="life-memory.sharing"]'),/旧记忆/);
    const groupLabels=await js(`['30001','30002'].map(id=>document.querySelector('[name="memorySubject"] option[value="qq:group:10001:'+id+'"]').textContent)`);assert.notEqual(groupLabels[0],groupLabels[1],'同一群内昵称相同的对象也须能明确区分');assert.match(groupLabels[0],/30001/);assert.match(groupLabels[1],/30002/);
    assert.equal(await js(`document.querySelector('[data-life-memory-source="trait-a"]').open`),false);
    await js(`document.querySelector('[data-life-memory-source="trait-a"]').open=true;void 0`);
    assert.match(await text('[data-life-memory-source="trait-a"]'),/我喜欢先听结论/);
    assert.match(await text('[data-life-memory-source="trait-a"]'),/2026/);
    assert.doesNotMatch(await text('[data-life-memory-overview]'),/qq:private-a|qq:private:a|canonicalKey/);
    if(kind==='source-selection'){
      await js(`(()=>{const node=document.querySelector('[data-life-memory-source="trait-a"] blockquote p').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,4);getSelection().removeAllRanges();getSelection().addRange(range);})()`);
      assert.equal(await js('getSelection().toString()'),'我喜欢先');
      const original=data.get(character.id,'memory','inferred-a');data.put(character.id,'memory',{...original,content:'选区保留期间到达的新理解',revision:original.revision+1});
      data.put(character.id,'memory-job',{id:'qq:private-a',scope:'qq:private-a',status:'running',processed:3,total:8,cursor:3});
      await wait('选区保留时仍更新整理进度',`document.querySelector('[data-life-memory-status]').textContent.includes('3 / 8')`);
      assert.equal(await js('getSelection().toString()'),'我喜欢先','后台分类更新不能清空正在复制的来源原话');
      assert.doesNotMatch(await text('[data-life-memory-traits]'),/选区保留期间到达的新理解/);
      await js('getSelection().removeAllRanges();void 0');await wait('清空选区后继续更新',`document.querySelector('[data-life-memory-traits]').textContent.includes('选区保留期间到达的新理解')`);
      assert.equal(await js(`document.querySelector('[data-life-memory-source="trait-a"]').open`),true);
      await js(`(()=>{const node=document.querySelector('[data-life-memory-source="trait-a"] blockquote p').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,4);getSelection().removeAllRanges();getSelection().addRange(range);document.querySelector('[name="memorySubject"]').focus();})()`);
      await input('memorySubject','qq:private:b');assert.doesNotMatch(await text('[data-life-memory-traits]'),/喜欢先听结论|选区保留期间到达的新理解/,'选择新对象后立即移除旧对象内容');await wait('复制来源时显式切对象立即显示新对象',`document.querySelector('[data-life-memory-traits]').textContent.includes('喜欢详尽的推导')`);
      assert.doesNotMatch(await text('[data-life-memory-traits]'),/喜欢先听结论|选区保留期间到达的新理解/);assert.equal(await js('getSelection().toString()'),'');
      await js(`(()=>{document.querySelector('[data-life-memory-source="trait-b"]').open=true;const node=document.querySelector('[data-life-memory-source="trait-b"] blockquote p').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,4);getSelection().removeAllRanges();getSelection().addRange(range);document.querySelector('[name="viewScope"]').focus();})()`);
      await input('viewScope','qq:private-b');await wait('复制来源时显式换会话',`document.querySelector('[name="viewScope"]').value==='qq:private-b'&&!document.querySelector('[data-life-save]').disabled`);
      assert.match(await text('[data-life-memory-traits]'),/喜欢详尽的推导/);assert.doesNotMatch(await text('[data-life-memory-traits]'),/喜欢先听结论|选区保留期间到达的新理解/);assert.doesNotMatch(await text('[data-life-memory-summary]'),/讨论了识图接入/);
      assert.deepEqual(errors,[]);console.log('LAYERED_MEMORY_UI_RESULT '+kind);return;
    }
    if(kind==='status-focus'){
      await js(`memoryUI.statusHelp=document.querySelector('[data-life-memory-status] [data-life-help]');memoryUI.statusHelp.focus();void 0`);
      assert.equal(await js(`memoryUI.statusHelp.getAttribute('aria-expanded')`),'true');
      data.put(character.id,'memory-job',{id:'qq:private-a',scope:'qq:private-a',status:'running',processed:3,total:8,cursor:3});
      await wait('键盘帮助展开时进度仍更新',`document.querySelector('[data-life-memory-status]').textContent.includes('3 / 8')`);
      assert.equal(await js('document.activeElement===memoryUI.statusHelp&&memoryUI.statusHelp.isConnected'),true,'整理进度不能替换正在聚焦的帮助按钮');
      assert.equal(await js(`memoryUI.statusHelp.getAttribute('aria-expanded')==='true'&&!!document.querySelector('.life-help-tooltip:popover-open')`),true,'轮询保留键盘帮助展开状态');
      await js('memoryUI.defer=true;memoryUI.fail=true;memoryUI.release=null;void 0');await wait('读取失败等待响应',`!!memoryUI.release`);await js('memoryUI.release();void 0');await wait('读取失败',`document.querySelector('[data-life-memory-status]').textContent.includes('旧读取错误')`);
      await js(`document.querySelector('[data-life-memory-refresh]').focus();void 0`);await click('[data-life-memory-refresh]');await wait('重试读取后状态恢复',`!document.querySelector('[data-life-memory-status]').textContent.includes('旧读取错误')`);
      assert.match(await text('[data-life-memory-status]'),/3 \/ 8/);
      data.put(character.id,'memory-job',{id:'qq:private-a',scope:'qq:private-a',status:'failed',processed:3,total:8,cursor:3,error:'测试：等待重试整理'});
      await wait('整理失败',`document.querySelector('[data-life-memory-status]').textContent.includes('等待重试整理')`);await js(`document.querySelector('[data-life-memory-organize]').focus();void 0`);await click('[data-life-memory-organize]');await saved();
      data.put(character.id,'memory-job',{id:'qq:private-a',scope:'qq:private-a',status:'idle',processed:8,total:8,cursor:8,error:''});await wait('重试整理后状态恢复',`document.querySelector('[data-life-memory-status]').textContent.includes('当前历史已整理')`);
      assert.doesNotMatch(await text('[data-life-memory-status]'),/等待重试整理/);assert.deepEqual(errors,[]);console.log('LAYERED_MEMORY_UI_RESULT '+kind);return;
    }
    await capture('memory-lite-light-1440');

    await input('memorySubject','qq:private:b');await wait('切换对象',`document.querySelector('[data-life-memory-traits]').textContent.includes('喜欢详尽的推导')`);
    assert.doesNotMatch(await text('[data-life-memory-traits]'),/喜欢先听结论/);
    await input('memorySubject','qq:private:a');await wait('返回对象',`document.querySelector('[data-life-memory-traits]').textContent.includes('喜欢先听结论')`);
    await click('[data-life-edit="trait-a"]');await input('content','纠正后的偏好');await input('category','experience');await input('reality','story');await input('confidence','inferred');
    assert.equal(await js(`!!document.querySelector('[data-life-memory-editor] [name="sourceId"]:not([type="hidden"])')`),false,'自动来源不可编辑');
    await click('[data-life-save]');await saved();let record=data.get(character.id,'memory','trait-a');
    assert.equal(record.content,'纠正后的偏好');assert.equal(record.category,'experience');assert.equal(record.reality,'story');assert.equal(record.confidence,'inferred');assert.equal(record.subjectKey,'qq:private:a');assert.equal(record.evidence[0].quote,'我喜欢先听结论');
    await click('[data-life-pin="experience-a"]');await saved();assert.equal(data.get(character.id,'memory','experience-a').pinned,true);
    await click('[data-life-archive="experience-a"]');await saved();assert.equal(data.get(character.id,'memory','experience-a').status,'archived');
    await click('[data-life-edit="plan-a"]');await input('planStatus','completed');await click('[data-life-save]');await saved();assert.equal(data.get(character.id,'memory','plan-a').planStatus,'completed');
    await click('[data-life-memory-summary-edit]');await input('summaryContent','人工纠正的会话摘要');await click('[data-life-memory-summary-save]');await saved();assert.equal(life.memoryOverview(character.id,{moduleId:'qq',conversationId:'private-a'}).summary.content,'人工纠正的会话摘要');
    await click('[data-life-delete="memories"][data-id="cancelled-a"]');assert.match(await text('.life-delete-confirm'),/原聊天.*保留/);await click('[data-confirm-delete]');await saved();assert.equal(data.get(character.id,'memory','cancelled-a'),null);

    await click('[data-life-edit="inferred-a"]');const original=data.get(character.id,'memory','inferred-a');await input('content','尚未保存的纠正草稿');
    data.put(character.id,'memory',{...original,revision:original.revision+1,content:'后台的新理解'});
    await wait('后台更新出现',`document.querySelector('[data-life-memory-traits]').textContent.includes('后台的新理解')`);
    await js(`(()=>{const node=document.querySelector('[name="content"]');node.focus();node.setSelectionRange(2,6);document.querySelector('[data-life-memory-source="inferred-a"]').open=true;})()`);
    const calls=await js('memoryUI.overviewCalls');await wait('再一次轮询',`memoryUI.overviewCalls>${calls+1}`);
    assert.deepEqual(await js(`(()=>{const n=document.querySelector('[name="content"]');return {value:n.value,focused:document.activeElement===n,start:n.selectionStart,end:n.selectionEnd,open:document.querySelector('[data-life-memory-source="inferred-a"]').open};})()`),{value:'尚未保存的纠正草稿',focused:true,start:2,end:6,open:true});
    await click('[data-life-save]');await wait('固定编辑版本冲突',`document.querySelector('[data-life-feedback]').textContent.includes('记忆已经改变')`);
    assert.equal(JSON.parse(await js(`memoryUI.calls.filter(c=>c.url.endsWith('/memories')).at(-1).body`)).revision,original.revision);
    assert.equal(await js(`document.querySelector('[name="content"]').value`),'尚未保存的纠正草稿');
    await click('[data-life-new]');

    await click('[data-life-memory-summary-edit]');await input('summaryContent','尚未保存的摘要纠正');
    const summaryBefore=life.memoryOverview(character.id,{moduleId:'qq',conversationId:'private-a'}).summary;
    life.saveMemorySummary(character.id,{moduleId:'qq',conversationId:'private-a',content:'后台更新的摘要',revision:summaryBefore.revision});
    await wait('后台摘要可见',`document.querySelector('[data-life-memory-summary]').textContent.includes('后台更新的摘要')`);
    await click('[data-life-memory-summary-save]');await wait('摘要固定版本冲突',`document.querySelector('[data-life-feedback]').textContent.includes('摘要已经改变')`);
    assert.equal(JSON.parse(await js(`memoryUI.calls.filter(c=>c.url.endsWith('/memory/summary')).at(-1).body`)).revision,summaryBefore.revision);
    assert.equal(await js(`document.querySelector('[name="summaryContent"]').value`),'尚未保存的摘要纠正');
    await click('[data-life-memory-summary-cancel]');

    await js('memoryUI.defer=true;memoryUI.release=null;void 0');await wait('旧GET等待',`!!memoryUI.release`);
    await click('[data-life-edit="done-a"]');await input('content','新保存的计划内容');await click('[data-life-save]');await saved();
    const newer=await text('[data-life-feedback]');await js('memoryUI.release();void 0');await pause(120);
    assert.equal(await text('[data-life-feedback]'),newer);assert.match(await text('[data-life-memory-plans]'),/新保存的计划内容/);
    await js('memoryUI.defer=true;memoryUI.fail=true;memoryUI.release=null;void 0');await wait('旧错误等待',`!!memoryUI.release`);
    await input('content','错误返回前的新草稿');await js('memoryUI.release();void 0');await wait('读取失败可重试',`document.querySelector('[data-life-memory-status]').textContent.includes('旧读取错误')`);assert.equal(await text('[data-life-feedback]'),'未保存的修改');
    await click('[data-life-memory-refresh]');await wait('读取恢复',`document.querySelector('[data-life-memory-refresh]').hidden`);assert.equal(await js(`document.querySelector('[name="content"]').value`),'错误返回前的新草稿');

    await js('memoryUI.defer=true;memoryUI.release=null;void 0');await wait('旧对象GET等待',`!!memoryUI.release`);await input('memorySubject','qq:private:b');await js('memoryUI.release();void 0');await wait('旧对象响应被忽略',`document.querySelector('[data-life-memory-traits]').textContent.includes('喜欢详尽的推导')`);assert.doesNotMatch(await text('[data-life-memory-traits]'),/后台的新理解/);
    await input('memorySubject','qq:private:a');await wait('对象恢复',`document.querySelector('[data-life-memory-traits]').textContent.includes('后台的新理解')`);
    await js('memoryUI.defer=true;memoryUI.release=null;void 0');await wait('旧会话GET等待',`!!memoryUI.release`);await input('viewScope','qq:private-b');await wait('新会话读取',`document.querySelector('[name="viewScope"]').value==='qq:private-b'&&!document.querySelector('[data-life-save]').disabled`);await js('memoryUI.release();void 0');await pause(100);assert.match(await text('[data-life-memory-traits]'),/喜欢详尽的推导/);assert.doesNotMatch(await text('[data-life-memory-summary]'),/后台更新的摘要/);
    await input('viewScope','qq:private-a');await wait('恢复原会话草稿',`document.querySelector('[name="content"]').value==='错误返回前的新草稿'&&!document.querySelector('[data-life-save]').disabled`);
    assert.equal(await js(`memoryUI.calls.some(call=>call.url.includes('/memory/organize'))`),false,'浏览和轮询不能要求后台启动整理');
    data.put(character.id,'memory-job',{id:'qq:private-a',scope:'qq:private-a',status:'failed',processed:2,total:8,cursor:2,error:'测试：整理服务暂不可用'});
    await wait('整理失败提供重试',`document.querySelector('[data-life-memory-status]').textContent.includes('整理服务暂不可用')`);
    await click('[data-life-memory-organize]');await saved();assert.equal(await js(`memoryUI.calls.filter(call=>call.url.includes('/memory/organize')).length`),1,'仅用户点击失败重试才提交整理');
    await click('[data-life-mode="full"]');await saved();await tab('memory');await js(`document.documentElement.dataset.theme='dark';document.querySelector('.life-main').scrollTop=0;void 0`);await capture('memory-full-dark-1440');
    window.setSize(1100,900);await js(`document.documentElement.dataset.theme='light';void 0`);await capture('memory-full-light-1100');
    assert.equal(await js(`(()=>{const p=document.querySelector('[data-life-panel="memory"]');return p.scrollWidth<=p.clientWidth+1})()`),true);
    await js(`document.documentElement.dataset.theme='dark';document.querySelector('[data-life-memory-source="inferred-a"]').open=true;document.querySelector('[data-life-memory-source="inferred-a"]').scrollIntoView({block:'center'});void 0`);await capture('memory-sources-dark-1100');
    await js(`document.querySelector('[data-life-memory-plans]').scrollIntoView({block:'start'});void 0`);await capture('memory-plans-dark-1100');
    await js('memoryUI.defer=true;memoryUI.release=null;void 0');await wait('关闭前读取',`!!memoryUI.release`);await click('[data-life-close]');const before=await js('memoryUI.overviewCalls');await js('memoryUI.release();void 0');await pause(550);assert.equal(await js('memoryUI.overviewCalls'),before);assert.ok(await js('memoryUI.aborted>0'));
    await js(`memoryUI.open('companion-lite','fresh');void 0`);await wait('强制精简',`!!document.querySelector('[data-life-panel="profile"]')`);await tab('memory');assert.equal(await js(`document.querySelectorAll('[data-life-tab]:not([hidden])').length`),3);assert.equal(await js(`document.querySelector('[data-life-mode="full"]').disabled`),true);assert.match(await text('[data-life-memory-status]'),/等待已保存对话/);assert.doesNotMatch(await text('[data-life-memory-status]'),/全部完成/);
    assert.equal((await api(path)).settings.mode,'full','强制精简入口不能改写角色原有完整版设置');await click('[data-life-save]');assert.equal(await js(`document.querySelector('[data-life-memory-manual]').open`),true);assert.equal(await js(`document.activeElement.name`),'content','手动记录主操作打开表单并定位输入');
    assert.equal(aiCalls,0,'所有阅读与轮询均不调用模型');assert.deepEqual(errors,[]);console.log('LAYERED_MEMORY_UI_RESULT 分类、来源、人工纠正、版本冲突、异步隔离、草稿与桌面主题通过');
  }finally{window.destroy();await backend.close();}
}

if(process.argv.includes('--layered-memory-ui-electron'))run(process.argv.at(-1)).then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else for(const [kind,name]of Object.entries({main:'分层记忆：真实 Electron 阅读管理、来源、异步刷新和桌面主题','source-selection':'分层记忆：后台更新保留来源文本选区，取消选择后继续刷新','status-focus':'分层记忆：进度更新保留键盘帮助，失败重试后仍能恢复'}))test(name,{skip:!electron,timeout:110000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'layered-memory-ui-')),env={...process.env,AI_FUTURE_MEMORY_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--layered-memory-ui-electron',kind],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(done=>child.once('exit',done));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/LAYERED_MEMORY_UI_RESULT/);
});
