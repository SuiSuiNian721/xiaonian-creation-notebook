import { escape as e, icon, moduleIcon, help, eventList } from './components.js';
import { mountEnvironmentDiscovery } from './environment-view.js';
import {mountResourcePreparation,preparationFor} from './resource-preparation.js';
import {mountBotSkin} from './mc-bot-skin-view.js';

const labels={disconnected:'未连接世界',connecting:'正在连接…',connected:'已进入世界',disconnecting:'正在断开…',error:'连接失败'};
const kinds={connection:'连接',chat:'游戏聊天',instruction:'指令',action:'动作',notice:'提示',error:'错误'};

export function mount(root,ctx) {
  if(!document.querySelector('#mc-play-style')) {
    const style=document.createElement('link');style.id='mc-play-style';style.rel='stylesheet';style.href='/mc-play.css';document.head.append(style);
  }
  const base='/api/modules/mc-play';
  const draftKey='mc-play:connection';
  let data;
  let tab=ctx.ui.moduleTabs['mc-play']||'play';
  let tabController;
  let polling;
  let skinView;
  let stateRevision=0;
  let historySignature='';
  let environment;
  const find=selector=>root.querySelector(selector);
  const api=(path,method='GET',body)=>ctx.api(base+path,{method,body,timeoutMs:20000});
  const active=()=>data?.connection.workerActive??['connecting','connected','disconnecting'].includes(data?.connection.status);
  const defaults=config=>({serverHost:config.serverHost||'127.0.0.1',serverPort:config.serverPort||'25565',gameVersion:config.gameVersion||'',authMode:config.authMode||'offline',playerName:config.playerName||'AiriCompanion',ownerName:config.ownerName||''});
  const currentValues=form=>Object.fromEntries(['serverHost','serverPort','gameVersion','authMode','playerName','ownerName'].map(name=>[name,form.elements[name].value]));
  const pageActive=signal=>!ctx.signal.aborted&&!signal.aborted;
  function feedback(message='',error=false,signal=ctx.signal) {if(!pageActive(signal))return;const node=find('#mc-feedback');if(node){node.textContent=message;node.className='form-feedback'+(error?' error':'');}}
  function acceptState(result,signal,revision) {if(!pageActive(signal)||revision!==stateRevision)return false;data=result;stateRevision++;return true;}
  async function run(button,job,signal=ctx.signal) {
    if(!pageActive(signal)||button?.disabled)return;
    if(button)button.disabled=true;
    try {await job();}
    catch(error){feedback(error.message,true,signal);}
    finally {if(pageActive(signal)){if(button?.isConnected)button.disabled=false;updateStatus();}}
  }
  async function refresh(signal=ctx.signal) {const revision=stateRevision,result=await api('/state');if(!signal.aborted&&!ctx.signal.aborted&&revision===stateRevision)data=result;}
  function startPolling(signal) {
    let loading=false;
    polling=setInterval(async()=>{
      if(loading)return;loading=true;
      try{await refresh(signal);if(!signal.aborted){if(tab==='skin')skinView?.update(data);else updateStatus();}}
      catch(error){if(!signal.aborted){if(tab==='skin')skinView?.error(error.message);else feedback(error.message,true);}}
      finally{loading=false;}
    },1800);
  }
  async function save(form,signal) {
    const snapshot=currentValues(form),revision=stateRevision;
    const result=await api('/connection','PUT',snapshot),saved=defaults(result.config);
    ctx.drafts.reconcile(draftKey,snapshot,saved);
    if(!acceptState(result,signal,revision)||!form.isConnected)return;
    for(const [name,value] of Object.entries(saved)) if(form.elements[name].value===snapshot[name])form.elements[name].value=value;
    await ctx.refresh();
  }
  function updateHistory() {
    const target=find('#mc-history');if(!target)return;
    const items=data.history.slice(-70);
    const signature=items.map(item=>item.id).join(',');if(signature===historySignature)return;historySignature=signature;
    const nearBottom=target.scrollHeight-target.scrollTop-target.clientHeight<70;
    target.innerHTML=items.length?items.map(item=>`<li class="mc-history-item ${item.kind==='error'?'error':''}"><div><span>${e(kinds[item.kind]||item.kind)}</span><time>${e(new Date(item.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}))}</time></div><p>${e(item.message)}</p>${item.error?`<p class="form-feedback error">${e(item.error)}</p>`:''}${item.result?`<details><summary>执行结果</summary><pre>${e(item.result)}</pre></details>`:''}</li>`).join(''):'<li class="quiet-empty">暂无游戏消息</li>';
    if(nearBottom)target.scrollTop=target.scrollHeight;
  }
  function updateStatus() {
    if(!data || tab!=='play' || !find('#mc-state'))return;
    const connection=data.connection;const online=connection.status==='connected';
    find('#mc-player-name').textContent=connection.playerName||data.config.playerName||'';
    const state=find('#mc-state');state.className='status-chip'+(online?' good':'');state.textContent=labels[connection.status]||connection.status;
    find('#mc-ai-state').textContent=online?(connection.paused?'AI 已暂停':connection.thinking?'正在思考':'AI 陪玩中'):(data.aiEnabled?'AI 已启用':'AI 未启用');
    find('#mc-session-character').textContent=connection.character?connection.character.name:'未绑定角色';
    const stats=find('#mc-live-stats');stats.hidden=!online;
    find('#mc-health').textContent=connection.health===undefined?'—':`${connection.health} / 20`;
    find('#mc-food').textContent=connection.food===undefined?'—':`${connection.food} / 20`;
    find('#mc-position').textContent=connection.position?['x','y','z'].map(key=>Number(connection.position[key]).toFixed(1)).join(' · '):'—';
    find('#mc-live-version').textContent=connection.gameVersion||'—';
    find('#mc-players').textContent=connection.players?.join('、')||'—';
    const auth=find('#mc-authentication');auth.hidden=!connection.authentication;
    if(connection.authentication){find('#mc-auth-code').textContent=connection.authentication.code||'';find('#mc-auth-message').textContent=connection.authentication.message||'请完成微软账号登录。';}
    find('#mc-error').textContent=connection.error||'';
    find('#mc-connect').disabled=active()||!data.runtime.available;
    find('#mc-save').disabled=active();
    find('#mc-disconnect').disabled=!active()||connection.status==='disconnecting';
    find('#mc-connection-form').querySelectorAll('input,select').forEach(input=>{input.disabled=active();});
    environment?.update();
    for(const id of ['mc-follow','mc-come'])find('#'+id).disabled=!online||!connection.ownerName;
    find('#mc-pause').disabled=!online;
    find('#mc-resume').disabled=!online||!connection.paused||!data.aiEnabled;
    find('#mc-send').disabled=!online||connection.paused||!data.aiEnabled;
    find('#mc-runtime-note').textContent=data.runtime.available?'':data.runtime.reason;
    updateHistory();
  }
  function play(signal) {
    const report=(message='',error=false)=>feedback(message,error,signal);
    const action=(button,job)=>run(button,job,signal);
    async function postState(path,body={}) {
      const revision=stateRevision,result=await api(path,'POST',body);
      acceptState(result.state??result,signal,revision);
      return result;
    }
    const values=defaults(ctx.drafts.read(draftKey,data.config));
    find('#module-panel').innerHTML=`<div class="mc-service-bar"><div><span id="mc-state" class="status-chip"></span><span id="mc-ai-state" class="mc-secondary"></span></div><button type="button" class="button" id="mc-disconnect">断开世界</button></div><p id="mc-feedback" class="form-feedback" role="status"></p><p id="mc-error" class="form-feedback error" role="alert"></p><p id="mc-runtime-note" class="form-feedback error"></p><div class="mc-play-layout"><section class="panel glass mc-connection-panel"><div class="panel-heading"><h2>连接世界</h2>${help('Minecraft Java 版。单机世界需先对局域网开放，填写游戏里显示的端口。地址不包含 http://。机器人需要与真人玩家使用不同的名字。','连接世界说明')}</div><form id="mc-connection-form"><div class="mc-fields"><div class="field"><label for="mc-host">服务器地址</label><input id="mc-host" name="serverHost" value="${e(values.serverHost)}" placeholder="127.0.0.1" maxlength="253" spellcheck="false" autocomplete="off" required></div><div class="field"><label for="mc-port">游戏端口</label><input id="mc-port" name="serverPort" type="number" min="1" max="65535" value="${e(values.serverPort)}" required></div><div class="field"><div class="field-label"><label for="mc-version">游戏版本</label>${help('留空会从服务器自动识别。模组整合包的专用网络协议未必兼容 Mineflayer。','游戏版本说明')}</div><input id="mc-version" name="gameVersion" value="${e(values.gameVersion)}" placeholder="自动识别" maxlength="32" spellcheck="false"></div><div class="field"><label for="mc-auth">登录方式</label><select id="mc-auth" name="authMode"><option value="offline" ${values.authMode==='offline'?'selected':''}>离线 / 局域网</option><option value="microsoft" ${values.authMode==='microsoft'?'selected':''}>微软账号</option></select></div><div class="field"><div class="field-label"><label for="mc-player">机器人玩家名</label>${help('离线模式填写 1–16 位英文、数字或下划线。微软模式可填账号登录标识，连接时会提供设备登录码。','机器人登录说明')}</div><input id="mc-player" name="playerName" value="${e(values.playerName)}" maxlength="254" autocomplete="off" spellcheck="false" required></div><div class="field"><div class="field-label"><label for="mc-owner">你的游戏名</label>${help('填写你在游戏中显示的英文玩家名，陪玩角色用它识别主人和跟随目标。','你的游戏名说明')}</div><input id="mc-owner" name="ownerName" value="${e(values.ownerName)}" maxlength="16" placeholder="Minecraft 玩家名" autocomplete="off" spellcheck="false"></div></div><div class="form-actions"><button class="button" id="mc-save" type="submit">保存配置</button><button class="button primary" id="mc-connect" type="button">${icon('mc-play')}连接世界</button></div></form><section id="mc-authentication" class="mc-authentication" hidden><p id="mc-auth-message"></p><strong id="mc-auth-code"></strong><button type="button" id="mc-open-auth" class="button">打开微软登录</button></section><div id="mc-live-stats" class="mc-live-stats" hidden><dl><div><dt>生命</dt><dd id="mc-health"></dd></div><div><dt>饱食度</dt><dd id="mc-food"></dd></div><div><dt>坐标</dt><dd id="mc-position"></dd></div><div><dt>版本</dt><dd id="mc-live-version"></dd></div><div class="wide"><dt>在线玩家</dt><dd id="mc-players"></dd></div></dl></div></section><section class="panel glass mc-companion-panel"><div class="panel-heading"><h2>陪玩</h2><span class="mc-secondary" id="mc-session-character"></span></div><div class="mc-command-bar"><button type="button" class="button" id="mc-follow">跟随我</button><button type="button" class="button" id="mc-come">来到身边</button><button type="button" class="button" id="mc-pause">暂停并停止</button><button type="button" class="button" id="mc-resume">恢复 AI</button></div><ol id="mc-history" class="mc-history" aria-label="游戏消息与动作" aria-live="polite"></ol><form id="mc-instruction-form"><label class="sr-only" for="mc-instruction">陪玩指令</label><textarea id="mc-instruction" rows="2" maxlength="4000" placeholder="跟着我，或者帮我收集附近的木头…">${e(ctx.ui.mcPlayInstruction||'')}</textarea><div class="mc-instruction-actions"><a class="text-link" href="#/settings">共用 AI 设置 ${icon('arrow')}</a><button type="submit" class="button primary" id="mc-send">发送指令 ${icon('arrow')}</button></div></form></section></div>`;
    const playerName=document.createElement('strong');playerName.id='mc-player-name';playerName.className='mc-player-name';find('#mc-state').before(playerName);
    const form=find('#mc-connection-form');
    form.addEventListener('input',()=>ctx.drafts.write(draftKey,currentValues(form)),{signal});
    if(!data.runtime.available){const repair=document.createElement('button');repair.type='button';repair.className='button small';repair.textContent='修复运行组件';find('#mc-runtime-note').after(repair);repair.addEventListener('click',()=>selectTab('resources'),{signal});}
    const discovery=document.createElement('div');find('#mc-connection-form').before(discovery);
    environment=mountEnvironmentDiscovery(discovery,{...ctx,signal},{moduleId:'mc-play',canSelect:()=>!active(),onSelect:candidate=>{
      const form=find('#mc-connection-form');
      for(const name of ['serverHost','serverPort'])if(Object.hasOwn(candidate.values,name))form.elements[name].value=candidate.values[name];
      form.dispatchEvent(new Event('input',{bubbles:true}));report('有未保存的修改');
    }});
    const settingsLink=find('.mc-instruction-actions .text-link');settingsLink.href='#';settingsLink.textContent='AI 接入';settingsLink.addEventListener('click',event=>{event.preventDefault();find('[data-module-ai-control]')?.click();},{signal});
    form.addEventListener('submit',event=>{event.preventDefault();void action(find('#mc-save'),async()=>{await save(form,signal);report('配置已保存。');});},{signal});
    find('#mc-connect').addEventListener('click',event=>void action(event.currentTarget,async()=>{
      if(!form.reportValidity())return;
      await save(form,signal);await postState('/connect');report();
    }),{signal});
    find('#mc-disconnect').onclick=event=>action(event.currentTarget,async()=>{await postState('/disconnect');report();});
    for(const [id,kind] of [['mc-follow','follow'],['mc-come','come'],['mc-pause','pause'],['mc-resume','resume']])find('#'+id).onclick=event=>action(event.currentTarget,async()=>{await postState('/command',{kind});report(kind==='pause'?'已暂停 AI 并请求停止动作。':kind==='resume'?'已恢复 AI 陪玩。':'运行端已接收操作。');});
    find('#mc-instruction').oninput=event=>{ctx.ui.mcPlayInstruction=event.target.value;};
    find('#mc-instruction-form').addEventListener('submit',event=>{event.preventDefault();const snapshot=find('#mc-instruction').value.trim();if(!snapshot)return;void action(find('#mc-send'),async()=>{await postState('/command',{kind:'instruction',text:snapshot});if(!pageActive(signal))return;if(find('#mc-instruction').value.trim()===snapshot){find('#mc-instruction').value='';ctx.ui.mcPlayInstruction='';}report('指令已交给陪玩角色，执行结果会显示在消息中。');});},{signal});
    find('#mc-open-auth').onclick=event=>action(event.currentTarget,async()=>{await api('/open-auth','POST',{});});
    historySignature='';updateStatus();
    startPolling(signal);
  }
  async function draw() {
    clearInterval(polling);tabController?.abort();tabController=new AbortController();const signal=tabController.signal;skinView=undefined;
    if(ctx.signal.aborted||!data)return;
    root.querySelectorAll('[data-tab]').forEach(button=>{const selected=button.dataset.tab===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    find('#module-panel').setAttribute('aria-labelledby','mc-tab-'+tab);
    if(tab==='play')play(signal);
    else if(tab==='skin'){
      skinView=mountBotSkin(find('#module-panel'),{...ctx,signal},{state:data,onState:value=>{stateRevision++;data=value;}});
      startPolling(signal);
    }
    else if(tab==='resources'){
      find('#module-panel').innerHTML=`<section class="panel glass"><div class="panel-heading"><h2>陪玩运行组件</h2><span class="status-chip ${data.runtime.available?'good':''}">${data.runtime.available?'陪玩运行端已就绪':'陪玩组件不完整'}</span></div><dl class="mc-runtime-details"><div><dt>来源版本</dt><dd>${e(data.runtime.version)}</dd></div><div><dt>许可</dt><dd>MIT</dd></div><div><dt>运行方式</dt><dd>独立受管进程</dd></div></dl>${data.runtime.reason?`<p class="form-feedback error">${e(data.runtime.reason)}</p>`:''}<div data-mc-runtime-preparation></div><details class="setup-guide"><summary>连接与运行说明</summary><ol><li>打开 Minecraft Java 版世界，单机可使用“对局域网开放”。</li><li>在连接页填写地址、游戏端口及机器人名，点击连接。</li><li>微软登录使用独立账号缓存；需要拥有可加入服务器的游戏账号。</li><li>跟随与移动使用内置动作工具；自然语言陪玩使用工作台共用 AI。</li><li>角色资料在连接时绑定，切换角色后重新连接才会生效。</li></ol></details></section>`;
      mountResourcePreparation(find('[data-mc-runtime-preparation]'),{...ctx,signal},{...preparationFor('mc-play'),open:!data.runtime.available,onTarget:async()=>{await refresh(signal);if(!signal.aborted)await draw();}});
    }
    else {await ctx.refresh();if(signal.aborted)return;find('#module-panel').innerHTML=`<section class="panel glass"><div class="panel-heading"><h2>运行记录</h2></div>${eventList(ctx.state.events.filter(event=>event.moduleId==='mc-play'),ctx.state.modules)}</section>`;}
  }
  function selectTab(value,focus=false){tab=value;ctx.ui.moduleTabs['mc-play']=tab;void draw();if(focus)find('[data-tab="'+value+'"]').focus();}
  root.innerHTML=`<div class="mc-play-shell"><div class="module-heading">${moduleIcon('mc-play','large')}<div class="heading-title"><h1>MC 陪玩</h1>${help('Minecraft 陪玩运行端按需安装。连接世界后可在这里发送指令、查看游戏消息和动作状态。','MC 陪玩说明')}</div><div class="remove-control"><button type="button" class="button ghost small" id="remove-mc-play">移除入口</button><small>断开陪玩，保留配置与资料</small></div></div><div class="module-tabs" role="tablist" aria-label="MC 陪玩页面">${[['play','陪玩'],['skin','皮肤'],['resources','运行组件'],['records','运行记录']].map(([id,label])=>`<button type="button" role="tab" id="mc-tab-${id}" data-tab="${id}" aria-controls="module-panel">${label}</button>`).join('')}</div><section id="module-panel" role="tabpanel"><div class="initial-loading" role="status">正在读取陪玩状态…</div></section></div>`;
  find('#remove-mc-play').onclick=event=>run(event.currentTarget,async()=>{await ctx.api('/api/modules/mc-play/disable',{method:'POST',body:{}});await ctx.refresh();ctx.navigate('home');});
  root.querySelectorAll('[data-tab]').forEach(button=>{
    button.addEventListener('click',()=>selectTab(button.dataset.tab),{signal:ctx.signal});
    button.addEventListener('keydown',event=>{const tabs=['play','skin','resources','records'];let next;if(event.key==='ArrowRight')next=tabs[(tabs.indexOf(tab)+1)%tabs.length];if(event.key==='ArrowLeft')next=tabs[(tabs.indexOf(tab)+tabs.length-1)%tabs.length];if(event.key==='Home')next=tabs[0];if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();selectTab(next,true);}},{signal:ctx.signal});
  });
  ctx.signal.addEventListener('abort',()=>{clearInterval(polling);tabController?.abort();},{once:true});
  void refresh().then(()=>{if(!ctx.signal.aborted)void draw();}).catch(error=>{if(!ctx.signal.aborted)find('#module-panel').innerHTML=`<div class="module-failure"><h2>暂时无法读取陪玩状态</h2><p>${e(error.message)}</p><button class="button" id="retry-mc-state">重试</button></div>`;const retry=find('#retry-mc-state');if(retry)retry.onclick=()=>ctx.rerender();});
}
