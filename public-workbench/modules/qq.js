import { escape as e, icon, moduleIcon, help, eventList, dateLabel } from '../components.js';
import { mountInstallation } from '../installation-view.js';
import { mountEnvironmentDiscovery } from '../environment-view.js';
import qrcode from '../vendor/qrcode-generator.js';
import { openCharacterLife } from '../character-life.js';

const transportLabels = {disconnected:'未连接网关',connecting:'正在验证账号',verified:'账号已验证',reconnecting:'正在重新连接','identity-mismatch':'账号身份不符',error:'连接失败'};
const loginLabels = {logged_out:'未登录',starting:'正在启动 QQ',waiting_qrcode:'等待扫码',confirming:'请在手机上确认',online:'QQ 已登录',offline:'QQ 已离线',identity_mismatch:'登录账号不符'};
const deliveryLabels = {received:'已接收',queued:'等待处理',generating:'正在生成',generated:'已生成，待发送',sending:'等待网关确认',confirmed:'网关已确认',failed:'未发送成功',unknown:'发送结果未知',simulated:'模拟记录',skipped:'旁观中'};
const tabNames = {connect:'连接与角色',conversations:'会话记录',memories:'记忆管理',resources:'资源安装',events:'运行记录'};
const pendingLogin = login => Boolean(login?.sessionId) && ['starting','waiting_qrcode','confirming'].includes(login.status);
const allowIds = value => [...new Set(String(value || '').split(/[\s,，;；]+/).filter(Boolean))];
const sameIds = (value, saved) => JSON.stringify(allowIds(value)) === JSON.stringify(saved || []);
const canRemember = message => message.role === 'user' || ['confirmed','simulated'].includes(message.status);
const conversationName = value => `${value.channel === 'group' ? '群聊' : '私聊'} ${value.peerId}`;

export async function mount(root, ctx) {
  if (!document.querySelector('#qq-style')) {
    const link = document.createElement('link'); link.id = 'qq-style'; link.rel = 'stylesheet'; link.href = new URL('../qq.css', import.meta.url).href; document.head.append(link);
  }
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const api = (path, method = 'GET', body) => ctx.api(`/api/modules/qq${path}`, {method,body,timeoutMs:25000});
  const find = selector => root.querySelector(selector);
  const live = () => !ctx.signal.aborted;
  const module = () => ctx.state.modules.find(item => item.id === 'qq');
  let data;
  let tab = Object.hasOwn(tabNames, ctx.ui.moduleTabs.qq) ? ctx.ui.moduleTabs.qq : 'connect';
  let tabController;
  let stateTimer, loginTimer, recordsTimer;
  let revision = 0;
  let operation = false;
  let loginPolling = false;
  let loginEpoch = 0;
  let qr = null;
  let renderedQr = '';
  let limitedNotice = '';
  let conversations = [];
  let selectedId = ctx.ui.qqConversationId || '';
  let detail;
  let memories = [];
  let editingMemoryId = null;
  let messageSignature = '';
  let recordsLoading = false;
  let recordSelection = 0;
  let detailRequest = 0;
  let detailApplied = 0;
  let componentDiscovery;
  let componentDiscoveryController;
  const currentRecord = (signal, id, selection) => live() && !signal.aborted && selectedId === id && recordSelection === selection;

  root.classList.add('qq-module');
  root.innerHTML = `<div class="module-heading">${moduleIcon('qq','large')}<div class="heading-title"><h1>${e(module().name)}</h1>${help('在这里管理 QQ 账号、扮演角色与资料。消息在 QQ 中收发。','QQ 对话说明')}</div><div class="remove-control"><button type="button" class="button ghost small" id="qq-remove">移除入口</button><small>保留配置与资料</small></div></div>
    <div class="qq-navigation"><div class="module-tabs" role="tablist" aria-label="QQ 管理页面">${['connect','conversations','memories'].map(id => `<button type="button" id="qq-tab-${id}" role="tab" data-qq-tab="${id}" aria-controls="qq-panel">${tabNames[id]}</button>`).join('')}</div><div class="qq-secondary-actions"><button type="button" id="qq-tab-resources" class="button ghost small" data-qq-tab="resources">${icon('download')}资源安装</button><button type="button" id="qq-tab-events" class="button ghost small" data-qq-tab="events">${icon('activity')}运行记录</button></div></div>
    <p id="qq-feedback" class="form-feedback qq-feedback" role="status" hidden></p><section id="qq-panel" role="tabpanel"><div class="qq-loading" role="status">正在读取 QQ 状态…</div></section>`;

  const lifeButton = document.createElement('button'); lifeButton.type = 'button'; lifeButton.className = 'button small'; lifeButton.id = 'qq-character-life'; lifeButton.dataset.modulePersona = '';
  lifeButton.innerHTML = `${icon('person')}人设与记忆`; find('.qq-secondary-actions').prepend(lifeButton);
  lifeButton.addEventListener('click', () => openCharacterLife(ctx, {characterId:data?.binding?.characterId || null,moduleId:'qq',conversationId:selectedId || '',trigger:lifeButton}), {signal:ctx.signal});
  ctx.signal.addEventListener('abort', () => {clearTimeout(stateTimer);clearTimeout(loginTimer);clearTimeout(recordsTimer);tabController?.abort();root.classList.remove('qq-module');++loginEpoch;}, {once:true});
  find('#qq-remove').addEventListener('click', () => ctx.action(find('#qq-remove'), async () => {
    await api('/disable','POST',{}); await ctx.refresh(); ctx.notify('QQ 入口已移除，配置与资料仍然保留。'); ctx.navigate('home');
  }), {signal:ctx.signal});
  root.querySelectorAll('[data-qq-tab]').forEach(button => {
    button.addEventListener('click', () => selectTab(button.dataset.qqTab), {signal:ctx.signal});
    if (button.getAttribute('role') !== 'tab') return;
    button.addEventListener('keydown', event => {
      const ids = ['connect','conversations','memories']; const index = ids.indexOf(button.dataset.qqTab);
      const next = event.key === 'ArrowRight' ? ids[(index+1)%3] : event.key === 'ArrowLeft' ? ids[(index+2)%3] : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids[2] : null;
      if (next) {event.preventDefault();selectTab(next,true);}
    }, {signal:ctx.signal});
  });

  function feedback(message = '', error = false) {
    if (!live()) return;
    const node = find('#qq-feedback'); node.hidden = !message; node.textContent = message; node.className = `form-feedback qq-feedback${error ? ' error' : ''}`;
  }
  function localFeedback(selector, message = '', error = false) {
    const node = find(selector); if (!node) return;
    node.textContent = message; node.className = `form-feedback${error ? ' error' : ' neutral'}`;
  }
  async function run(button, job) {
    if (operation || button?.disabled || !live()) return;
    operation = true; if (button) button.disabled = true; feedback(); updateStatus();
    try {await job();}
    catch (error) {feedback(error.message,true);}
    finally {operation = false;if (live()) {if (button?.isConnected) button.disabled = false;updateStatus();}}
  }
  function acceptState(value) {
    if (!live()) return;
    ++revision; data = value;
    if (qr && (data.runtime?.mode !== 'managed' || data.runtime.login.sessionId !== qr.sessionId || !pendingLogin(data.runtime.login))) qr = null;
    updateStatus(); scheduleLogin();
  }
  function acceptRuntime(value, {sessionId, replaceSession = false} = {}) {
    if (!live() || (sessionId && data.runtime?.login.sessionId !== sessionId)) return false;
    if (sessionId && !replaceSession && value.login?.sessionId !== sessionId) return false;
    data = {...data,runtime:value}; ++revision;
    if (pendingLogin(value.login) && value.login.qrcodeUrl) qr = {sessionId:value.login.sessionId,text:value.login.qrcodeUrl};
    else if (!pendingLogin(value.login) || qr?.sessionId !== value.login.sessionId) qr = null;
    updateStatus();scheduleLogin();return true;
  }
  async function readState() {
    const serial = revision; const value = await api('/state');
    if (live() && serial === revision) acceptState(value);
  }
  async function pollState() {
    try {await readState();}
    catch (error) {if (live()) feedback(error.message,true);}
    finally {if (live()) stateTimer = setTimeout(pollState,2500);}
  }
  function scheduleLogin() {
    clearTimeout(loginTimer);
    if (live() && tab === 'connect' && !loginPolling && data?.runtime?.mode === 'managed' && pendingLogin(data.runtime.login)) loginTimer = setTimeout(pollLogin,1200);
  }
  async function pollLogin() {
    if (!live() || tab !== 'connect' || loginPolling || !pendingLogin(data?.runtime?.login)) return;
    const sessionId = data.runtime.login.sessionId; const epoch = loginEpoch;
    loginPolling = true;
    try {
      const value = await api('/login/poll','POST',{sessionId});
      if (live() && tab === 'connect' && epoch === loginEpoch) acceptRuntime(value,{sessionId});
    } catch (error) {if (live() && tab === 'connect' && epoch === loginEpoch && data.runtime.login.sessionId === sessionId) feedback(error.message,true);}
    finally {loginPolling = false;scheduleLogin();}
  }
  function selectTab(next, focus = false) {
    if (!live()) return;
    tab = next;ctx.ui.moduleTabs.qq = next;feedback();draw();
    if (focus) find(`#qq-tab-${next}`).focus();
  }
  function draw() {
    tabController?.abort();disposeComponentDiscovery();tabController = new AbortController();
    clearTimeout(loginTimer);clearTimeout(recordsTimer);++loginEpoch;
    if (!live()) {tabController.abort();return;}
    root.querySelectorAll('[data-qq-tab]').forEach(button => {
      const active = button.dataset.qqTab === tab;
      if (button.getAttribute('role') === 'tab') {button.setAttribute('aria-selected',String(active));button.tabIndex = active ? 0 : -1;}
      else button.setAttribute('aria-pressed',String(active));
    });
    const panel = find('#qq-panel');panel.setAttribute('aria-labelledby',`qq-tab-${tab}`);
    if (!data) return;
    if (tab === 'connect') drawConnection(tabController.signal);
    else if (tab === 'resources') mountInstallation(panel,{api:ctx.api,ui:ctx.ui,signal:tabController.signal,refresh:async () => {await ctx.refresh();await readState();}},'qq');
    else if (tab === 'events') drawEvents(tabController.signal);
    else drawRecords(tabController.signal);
    scheduleLogin();
  }

  function bindingDirty() {const field = find('#qq-character');return field ? field.value !== (data.binding?.characterId || '') : false;}
  function rulesDirty() {return find('#qq-private-allow') ? !sameIds(find('#qq-private-allow').value,data.rules.privateAllow) || !sameIds(find('#qq-group-allow').value,data.rules.groupAllow) || find('#qq-require-mention')?.checked !== (data.rules.requireMention !== false) : false;}
  function canConfigureComponent() {
    const runtime = data?.runtime;
    return runtime?.mode === 'managed' && find('#qq-runtime-mode')?.value === 'managed' && !runtime.running
      && !['starting','waiting_qrcode','confirming','online','identity_mismatch'].includes(runtime.login.status)
      && !['connecting','verified','reconnecting'].includes(data.transport.status)
      && !['downloading','extracting'].includes(runtime.installation.status);
  }
  function disposeComponentDiscovery() {
    componentDiscoveryController?.abort();componentDiscoveryController = null;componentDiscovery = null;
  }
  function updateComponentDiscovery() {
    const host = find('#qq-component-discovery');
    if (!host) return;
    if (data.runtime.mode !== 'managed') {disposeComponentDiscovery();host.replaceChildren();return;}
    if (!componentDiscovery) {
      const controller = new AbortController();componentDiscoveryController = controller;
      tabController.signal.addEventListener('abort',() => controller.abort(),{once:true,signal:controller.signal});
      componentDiscovery = mountEnvironmentDiscovery(host,{...ctx,signal:controller.signal},{moduleId:'qq',
        canSelect:() => !controller.signal.aborted && !operation && canConfigureComponent(),
        onSelect:candidate => {
          if (controller.signal.aborted || operation || !canConfigureComponent() || host !== find('#qq-component-discovery')) return;
          const directory = candidate.values?.installDirectory;
          if (candidate.selectable === false || typeof directory !== 'string' || !directory.trim()) return;
          find('#qq-component-directory').value = directory;ctx.drafts.write('qq:component',{installDirectory:directory});
          localFeedback('#qq-component-feedback','组件位置尚未保存');updateStatus();
        },
      });
    }
    componentDiscovery?.update();
  }
  function drawConnection(signal) {
    const binding = ctx.drafts.read('qq:binding',{characterId:data.binding?.characterId || '',acceptLimited:false});
    const rules = ctx.drafts.read('qq:rules',{privateAllow:data.rules.privateAllow.join('\n'),groupAllow:data.rules.groupAllow.join('\n'),requireMention:data.rules.requireMention!==false});
    const runtime = ctx.drafts.read('qq:runtime',{mode:data.runtime.mode,wsUrl:data.runtime.external?.wsUrl || '',accountId:data.runtime.external?.accountId || ''});
    const component = ctx.drafts.read('qq:component',{installDirectory:data.runtime.installation.installDirectory || ''});
    renderedQr = '';
    find('#qq-panel').innerHTML = `<div class="qq-service-bar"><div class="qq-service-status"><span id="qq-transport-status" class="status-chip"></span><span id="qq-reply-status"></span></div><div class="qq-service-actions"><button type="button" id="qq-start" class="button primary">${icon('play')}开始扮演</button><button type="button" id="qq-pause" class="button">暂停扮演</button><button type="button" id="qq-disconnect" class="button ghost">断开连接</button></div></div><p id="qq-ready-note" class="qq-ready-note" hidden></p><p id="qq-runtime-error" class="form-feedback error qq-runtime-error" role="alert" hidden></p>
      <div class="qq-connection-layout"><section class="panel glass qq-account-panel"><div class="panel-heading"><h2>QQ 账号</h2><button type="button" id="qq-refresh-state" class="button ghost small">${icon('activity')}刷新</button></div><div class="qq-account-identity"><span class="qq-account-symbol">${icon('qq')}</span><div><strong id="qq-account"></strong><span id="qq-login-status"></span></div></div><div id="qq-managed-login"><p id="qq-installation-state" class="qq-context-line"></p><div class="qq-account-actions"><button type="button" class="button primary" id="qq-prepare">${icon('download')}准备 QQ 环境</button><button type="button" class="button primary" id="qq-login">扫码登录</button></div><div id="qq-qrcode-panel" class="qq-qrcode-panel" hidden><div id="qq-qrcode" role="img" aria-label="使用手机 QQ 扫描此二维码"></div><p id="qq-code-status" role="status"></p><div class="qq-code-actions"><button type="button" class="button small" id="qq-refresh-code">刷新二维码</button><button type="button" class="button ghost small" id="qq-cancel-login">取消登录</button></div></div>
      <details id="qq-component-options" class="qq-external-options" ${component.installDirectory ? '' : 'open'}><summary>QQ 组件</summary><form id="qq-component-form"><div class="field"><div class="field-label"><label for="qq-component-directory">组件位置</label>${help('复用经过校验的 QQ 程序包。登录和账号资料仍使用工作台的独立目录。保存位置不会启动 QQ。','QQ 组件位置说明')}</div><input id="qq-component-directory" name="installDirectory" value="${e(component.installDirectory)}" spellcheck="false" autocomplete="off"></div><div id="qq-component-discovery"></div><div class="form-actions"><p id="qq-component-feedback" class="form-feedback" role="status"></p><button type="submit" class="button" id="qq-save-component">保存组件位置</button></div></form></details></div><button type="button" class="button" id="qq-connect">验证连接</button>
      <details id="qq-external-options" class="qq-external-options" ${data.runtime.mode === 'external' ? 'open' : ''}><summary>已有 QQ 网关</summary><form id="qq-runtime-form"><div class="field"><div class="field-label"><label for="qq-runtime-mode">接入方式</label>${help('受管 QQ 在工作台中扫码。已有网关使用 OneBot 11 正向 WebSocket；连接后会核对机器人 QQ 号。','接入方式说明')}</div><select id="qq-runtime-mode" name="mode"><option value="managed" ${runtime.mode === 'managed' ? 'selected' : ''}>工作台扫码</option><option value="external" ${runtime.mode === 'external' ? 'selected' : ''}>已有正向网关</option></select></div><div id="qq-external-fields"><div class="field"><label for="qq-ws-url">WebSocket 地址</label><input id="qq-ws-url" name="wsUrl" value="${e(runtime.wsUrl)}" placeholder="ws://127.0.0.1:3001" maxlength="2048" autocomplete="off" spellcheck="false"></div><div class="field"><label for="qq-expected-account">机器人 QQ 号</label><input id="qq-expected-account" name="accountId" value="${e(runtime.accountId)}" inputmode="numeric" pattern="[0-9]+" maxlength="32" autocomplete="off" spellcheck="false"></div><div class="field"><label for="qq-token">访问令牌</label><input id="qq-token" name="token" type="password" maxlength="4096" autocomplete="new-password" placeholder="${data.runtime.external?.hasToken ? '已保存，留空保留' : '可选'}"></div></div><p id="qq-runtime-change-note" class="qq-context-line" hidden>保存会断开当前 QQ 连接。</p><div class="form-actions"><p id="qq-runtime-feedback" class="form-feedback" role="status"></p><button type="submit" class="button" id="qq-save-runtime">保存接入方式</button></div></form></details></section>
      <section class="panel glass qq-role-panel"><div class="panel-heading"><h2>角色与回复范围</h2>${help('只有允许名单内的 QQ 会处理消息。群聊还必须 @ 机器人。修改角色会暂停扮演；修改回复范围会取消旧回复。','回复范围说明')}</div><form id="qq-binding-form"><div class="field"><label for="qq-character">QQ 扮演角色</label><select id="qq-character" name="characterId"><option value="">未绑定角色</option>${ctx.state.characters.map(character => `<option value="${e(character.id)}" ${binding.characterId === character.id ? 'selected' : ''}>${e(character.name)} · v${e(character.revision)}</option>`).join('')}</select></div><div id="qq-binding-summary" class="qq-context-line"></div><div id="qq-limited-confirm" class="qq-limited-confirm" hidden><p id="qq-limited-message"></p><label class="qq-checkbox"><input type="checkbox" id="qq-accept-limited" ${binding.acceptLimited ? 'checked' : ''}>接受基础文字模式</label></div><div class="form-actions"><p id="qq-binding-feedback" class="form-feedback" role="status"></p><button type="submit" class="button" id="qq-save-binding">保存角色</button></div></form>
      <form id="qq-rules-form" class="qq-rules-form"><div class="qq-allow-fields"><div class="field"><div class="field-label"><label for="qq-private-allow">允许私聊的 QQ 号</label>${help('每行一个 QQ 号。留空时不处理私聊。','私聊允许名单说明')}</div><textarea id="qq-private-allow" name="privateAllow" rows="4" maxlength="6000" inputmode="numeric" spellcheck="false">${e(rules.privateAllow)}</textarea></div><div class="field"><div class="field-label"><label for="qq-group-allow">允许回复的群号</label>${help('每行一个群号。留空时不处理群聊。','群聊允许名单说明')}</div><textarea id="qq-group-allow" name="groupAllow" rows="4" maxlength="6000" inputmode="numeric" spellcheck="false">${e(rules.groupAllow)}</textarea></div></div><label class="qq-checkbox"><input type="checkbox" checked disabled>群聊仅在被 @ 时回复</label><div class="form-actions"><p id="qq-rules-feedback" class="form-feedback" role="status"></p><button type="submit" class="button" id="qq-save-rules">保存回复范围</button></div></form></section></div>`;

    const stop = document.createElement('button');stop.type='button';stop.id='qq-stop';stop.className='button ghost';stop.textContent='停止 QQ';
    find('#qq-login').after(stop);
    const lifecycle = document.createElement('span');lifecycle.innerHTML=help('关闭工作台会暂停自动回复并保留 QQ 后台；重开后验证连接即可继续。停止 QQ 会结束登录端，账号资料会保留，下次可能需要扫码。','QQ 后台运行说明');
    find('.qq-account-panel .panel-heading').append(lifecycle);
    stop.addEventListener('click',event=>run(event.currentTarget,async()=>{++loginEpoch;acceptState(await api('/stop','POST',{}));}),{signal});
    find('#qq-prepare').addEventListener('click', () => selectTab('resources'), {signal});
    const componentForm = find('#qq-component-form');
    componentForm.addEventListener('input',()=>{
      ctx.drafts.write('qq:component',{installDirectory:componentForm.elements.installDirectory.value});
      localFeedback('#qq-component-feedback','组件位置尚未保存');updateStatus();
    },{signal});
    componentForm.addEventListener('submit', event => {
      event.preventDefault();
      if (!canConfigureComponent()) return;
      const snapshot = {installDirectory:componentForm.elements.installDirectory.value};
      if (!snapshot.installDirectory.trim()) return;
      void run(find('#qq-save-component'),async () => {
        if (!canConfigureComponent()) return;
        const value = await api('/runtime','PUT',{installDirectory:snapshot.installDirectory,mode:'managed'});
        const saved = {installDirectory:value.installation.installDirectory || snapshot.installDirectory};
        ctx.drafts.reconcile('qq:component',snapshot,saved);
        if (!live()) return;
        if (data.runtime.mode === 'managed') {++loginEpoch;acceptRuntime(value);await readState();}
        if (signal.aborted || componentForm !== find('#qq-component-form')) return;
        if (componentForm.elements.installDirectory.value === snapshot.installDirectory) componentForm.elements.installDirectory.value = saved.installDirectory;
        localFeedback('#qq-component-feedback',componentForm.elements.installDirectory.value === saved.installDirectory ? '组件位置已保存' : '已保存，新的组件位置尚未保存');
        updateStatus();
      });
    }, {signal});
    find('#qq-refresh-state').addEventListener('click', event => run(event.currentTarget,readState), {signal});
    find('#qq-start').addEventListener('click', event => run(event.currentTarget,async () => {
      if (bindingDirty() || rulesDirty()) throw new Error('请先保存角色与回复范围。');
      if (data.transport.status !== 'verified') acceptState(await api('/connect','POST',{}));
      acceptState(await api('/replies/start','POST',{}));
    }), {signal});
    find('#qq-pause').addEventListener('click', event => run(event.currentTarget,async () => acceptState(await api('/replies/pause','POST',{}))), {signal});
    find('#qq-connect').addEventListener('click', event => run(event.currentTarget,async () => acceptState(await api('/connect','POST',{}))), {signal});
    find('#qq-disconnect').addEventListener('click', event => run(event.currentTarget,async () => {++loginEpoch;acceptState(await api('/disconnect','POST',{}));}), {signal});
    find('#qq-login').addEventListener('click', event => run(event.currentTarget,async () => {
      const epoch = ++loginEpoch;const value = await api('/login/start','POST',{});
      if (live() && epoch === loginEpoch) {data.paused = true;acceptRuntime(value);}
    }), {signal});
    find('#qq-refresh-code').addEventListener('click', event => run(event.currentTarget,async () => {
      const sessionId = data.runtime.login.sessionId;const epoch = ++loginEpoch;
      const value = await api('/login/refresh','POST',{sessionId});
      if (live() && epoch === loginEpoch) acceptRuntime(value,{sessionId,replaceSession:true});
    }), {signal});
    find('#qq-cancel-login').addEventListener('click', event => run(event.currentTarget,async () => {
      const sessionId = data.runtime.login.sessionId;++loginEpoch;
      const value = await api('/login/cancel','POST',{sessionId});acceptRuntime(value,{sessionId,replaceSession:true});
    }), {signal});
    const bindingForm = find('#qq-binding-form');
    bindingForm.addEventListener('change', event => {
      if (event.target.id === 'qq-character') {limitedNotice = '';find('#qq-accept-limited').checked = false;}
      ctx.drafts.write('qq:binding',{characterId:find('#qq-character').value,acceptLimited:find('#qq-accept-limited').checked});
      localFeedback('#qq-binding-feedback',bindingDirty() ? '角色修改尚未保存' : '');updateStatus();
    }, {signal});
    bindingForm.addEventListener('submit', event => {
      event.preventDefault();const characterId = find('#qq-character').value;const accepted = find('#qq-accept-limited').checked;
      const character = ctx.state.characters.find(item => item.id === characterId);
      void run(find('#qq-save-binding'),async () => {
        try {
          const value = await api('/binding','PUT',{characterId:characterId || null,...(character ? {revision:character.revision} : {}),...(accepted ? {acceptLimited:true} : {})});
          if (!signal.aborted && find('#qq-character').value === characterId) {limitedNotice = '';find('#qq-accept-limited').checked = false;}
          acceptState(value);ctx.drafts.reconcile('qq:binding',{characterId,acceptLimited:accepted},{characterId:value.binding?.characterId || '',acceptLimited:false});
          if (!signal.aborted) localFeedback('#qq-binding-feedback',bindingDirty() ? '已保存，新的修改仍保留' : '角色已保存');
        } catch (error) {
          if (!signal.aborted && find('#qq-character').value === characterId && error.message.includes('受限能力')) {limitedNotice = error.message;updateStatus();find('#qq-accept-limited').focus();}
          throw error;
        }
      });
    }, {signal});
    const compatibilityLabel = find('#qq-accept-limited').parentElement;
    for (const node of compatibilityLabel.childNodes) if (node.nodeType === Node.TEXT_NODE) node.textContent = '接受列出的兼容范围';
    const rulesForm = find('#qq-rules-form');
    const mention = rulesForm.querySelector('input[type="checkbox"]'); mention.disabled = false; mention.id = 'qq-require-mention'; mention.name = 'requireMention'; mention.checked = rules.requireMention !== false;
    const mentionHelp = document.createElement('span'); mentionHelp.innerHTML = help('关闭后，角色会旁观允许名单内的群聊，并按照「人设与记忆」中的群聊参与频率决定是否回应。','群聊参与说明'); mention.parentElement.append(mentionHelp);
    const rulesValues = () => ({privateAllow:find('#qq-private-allow').value,groupAllow:find('#qq-group-allow').value,requireMention:mention.checked});
    rulesForm.addEventListener('input', () => {ctx.drafts.write('qq:rules',rulesValues());localFeedback('#qq-rules-feedback',rulesDirty() ? '回复范围尚未保存' : '');updateStatus();}, {signal});
    rulesForm.addEventListener('submit', event => {
      event.preventDefault();const snapshot = rulesValues();
      void run(find('#qq-save-rules'),async () => {
        const value = await api('/rules','PUT',{privateAllow:allowIds(snapshot.privateAllow),groupAllow:allowIds(snapshot.groupAllow),requireMention:snapshot.requireMention});
        acceptState(value);const saved = {privateAllow:value.rules.privateAllow.join('\n'),groupAllow:value.rules.groupAllow.join('\n'),requireMention:value.rules.requireMention!==false};ctx.drafts.reconcile('qq:rules',snapshot,saved);
        if (!signal.aborted && mention.checked === snapshot.requireMention) mention.checked = saved.requireMention;
        if (!signal.aborted) {for (const name of ['privateAllow','groupAllow']) if (rulesForm.elements[name].value === snapshot[name]) rulesForm.elements[name].value = saved[name];localFeedback('#qq-rules-feedback',rulesDirty() ? '已保存，新的修改仍保留' : '回复范围已保存');}
      });
    }, {signal});
    const runtimeForm = find('#qq-runtime-form');
    const runtimeValues = () => ({mode:runtimeForm.elements.mode.value,wsUrl:runtimeForm.elements.wsUrl.value,accountId:runtimeForm.elements.accountId.value});
    const updateRuntimeFields = () => {const external = runtimeForm.elements.mode.value === 'external';find('#qq-external-fields').hidden = !external;runtimeForm.elements.wsUrl.required = external;runtimeForm.elements.accountId.required = external;};
    runtimeForm.addEventListener('input', () => {ctx.drafts.write('qq:runtime',runtimeValues());localFeedback('#qq-runtime-feedback','接入方式尚未保存');updateRuntimeFields();updateStatus();}, {signal});
    runtimeForm.addEventListener('change', () => {updateRuntimeFields();updateStatus();}, {signal});
    runtimeForm.addEventListener('submit', event => {
      event.preventDefault();const snapshot = runtimeValues();const token = runtimeForm.elements.token.value;
      void run(find('#qq-save-runtime'),async () => {
        const body = snapshot.mode === 'external' ? {...snapshot,...(token ? {token} : {})} : {mode:'managed'};
        const value = await api('/runtime','PUT',body);++loginEpoch;acceptRuntime(value);await readState();
        ctx.drafts.reconcile('qq:runtime',snapshot,{mode:value.mode,wsUrl:value.external.wsUrl || '',accountId:value.external.accountId || ''});
        if (!signal.aborted) {if (runtimeForm.elements.token.value === token) runtimeForm.elements.token.value = '';runtimeForm.elements.token.placeholder = value.external.hasToken ? '已保存，留空保留' : '可选';localFeedback('#qq-runtime-feedback','接入方式已保存');}
        updateStatus();
      });
    }, {signal});
    updateRuntimeFields();updateStatus();
  }

  function updateStatus() {
    if (!live() || !data || tab !== 'connect' || !find('#qq-account')) return;
    const runtime = data.runtime;const login = runtime.login;const managed = runtime.mode === 'managed';const verified = data.transport.status === 'verified';
    const ready = runtime.installation.status === 'ready';const waiting = pendingLogin(login);
    const expected = managed ? login.accountId : runtime.external.accountId;
    const accountId = verified ? data.actualSelfId : login.status === 'online' && managed ? login.accountId : null;
    find('#qq-account').textContent = accountId ? `${login.nickname || 'QQ'} · ${accountId}` : expected ? `预期账号 ${expected}` : '尚未登录 QQ';
    find('#qq-login-status').textContent = managed ? loginLabels[login.status] || login.status : '已有正向网关';
    const transport = find('#qq-transport-status');transport.textContent = transportLabels[data.transport.status] || data.transport.status;transport.className = `status-chip${verified ? ' good' : ['error','identity-mismatch'].includes(data.transport.status) ? ' qq-error-chip' : ''}`;
    find('#qq-reply-status').textContent = !data.paused && verified ? data.generating ? `正在处理 ${data.generating} 条${data.queued ? ` · 等待 ${data.queued} 条` : ''}` : '扮演中' : '扮演已暂停';
    const dirty = bindingDirty() || rulesDirty();const hasRange = data.rules.privateAllow.length + data.rules.groupAllow.length > 0;
    const canConnect = managed ? login.status === 'online' : Boolean(runtime.external.wsUrl && runtime.external.accountId);
    const note = dirty ? '先保存角色与回复范围，再开始扮演。' : !data.binding ? '选择并保存 QQ 扮演角色。' : !hasRange ? '保存至少一个允许私聊的 QQ 号或群号。' : !data.aiEnabled ? '先启用 QQ 模块的 AI 接入。' : '';
    find('#qq-ready-note').textContent = note;find('#qq-ready-note').hidden = !note;
    find('#qq-start').disabled = operation || !data.paused || !canConnect || !data.binding || !hasRange || !data.aiEnabled || dirty || ['connecting','reconnecting'].includes(data.transport.status);
    find('#qq-pause').disabled = operation || data.paused;
    find('#qq-disconnect').disabled = operation || data.transport.status === 'disconnected';
    find('#qq-stop').disabled = operation || !runtime.running;
    find('#qq-connect').hidden = verified || !canConnect;find('#qq-connect').disabled = operation || ['connecting','reconnecting'].includes(data.transport.status);
    find('#qq-managed-login').hidden = !managed;
    find('#qq-save-component').disabled = operation || !canConfigureComponent() || !find('#qq-component-directory').value.trim() || find('#qq-component-directory').value === (runtime.installation.installDirectory || '');
    find('#qq-component-directory').disabled = operation || !canConfigureComponent();
    updateComponentDiscovery();
    find('#qq-prepare').hidden = ready;find('#qq-prepare').disabled = operation;
    find('#qq-login').hidden = !ready || login.status === 'online' || waiting;find('#qq-login').disabled = operation;
    find('#qq-login').textContent = runtime.running ? '接回 QQ' : '扫码登录';
    find('#qq-installation-state').hidden = ready;
    find('#qq-installation-state').textContent = {missing:'未配置 NapCat QQ 独立运行端',downloading:'正在下载 NapCat QQ 运行端',extracting:'正在解压 NapCat QQ 运行端',error:'NapCat QQ 运行端准备失败'}[runtime.installation.status] || '';
    find('#qq-qrcode-panel').hidden = !waiting;
    find('#qq-code-status').textContent = loginLabels[login.status] || '';
    find('#qq-refresh-code').disabled = operation || login.status === 'starting';find('#qq-cancel-login').disabled = operation;
    const qrNode = find('#qq-qrcode');const qrValue = qr?.sessionId === login.sessionId ? qr : null;
    const signature = qrValue ? `${qrValue.sessionId}:${qrValue.text}` : '';
    if (signature !== renderedQr) {
      renderedQr = signature;qrNode.dataset.sessionId = qrValue?.sessionId || '';qrNode.replaceChildren();
      if (qrValue) {try {const code = qrcode(0,'M');code.addData(qrValue.text);code.make();qrNode.innerHTML = code.createSvgTag({cellSize:4,margin:16,scalable:true});} catch {qrNode.textContent = '二维码无法显示，请刷新二维码。';}}
    }
    qrNode.hidden = !qrValue;
    const error = [data.lastError,runtime.installation.error,login.error,data.transport.error].filter(Boolean).filter((value,index,all) => all.indexOf(value) === index).join(' ');
    find('#qq-runtime-error').textContent = error;find('#qq-runtime-error').hidden = !error;
    find('#qq-binding-summary').textContent = data.binding ? `已绑定：${data.binding.name} · v${data.binding.revision}${data.binding.compatibility === 'limited' ? ' · 基础文字模式' : ''}` : '';
    find('#qq-binding-summary').hidden = !data.binding;
    find('#qq-limited-confirm').hidden = !limitedNotice;
    find('#qq-limited-message').textContent = limitedNotice;
    find('#qq-runtime-change-note').textContent = managed && runtime.running ? '修改接入方式会停止 QQ 后台，账号资料保留。' : '修改接入方式会断开当前连接。';
    find('#qq-runtime-change-note').hidden = !runtime.running && data.transport.status === 'disconnected';
    for (const id of ['qq-save-binding','qq-save-rules','qq-save-runtime','qq-refresh-state']) find(`#${id}`).disabled = operation;
  }

  function drawEvents(signal) {
    find('#qq-panel').innerHTML = `<section class="panel glass"><div class="panel-heading"><h2>运行记录</h2><button type="button" class="button small" id="qq-refresh-events">${icon('activity')}刷新</button></div><div id="qq-events">${eventList(ctx.state.events.filter(item => item.moduleId === 'qq'),ctx.state.modules)}</div></section>`;
    find('#qq-refresh-events').addEventListener('click', event => run(event.currentTarget,async () => {await ctx.refresh();if (!signal.aborted) find('#qq-events').innerHTML = eventList(ctx.state.events.filter(item => item.moduleId === 'qq'),ctx.state.modules);}), {signal});
  }
  function drawRecords(signal) {
    messageSignature = '';++recordSelection;++detailRequest;
    find('#qq-panel').innerHTML = `<div class="qq-records-layout"><aside class="panel glass qq-conversation-panel"><div class="panel-heading"><h2>会话</h2><button type="button" class="button ghost small" id="qq-refresh-records" aria-label="刷新会话">${icon('activity')}</button></div><div id="qq-conversation-list" class="qq-conversation-list"><p class="quiet-empty" role="status">正在读取会话…</p></div></aside><section id="qq-record-detail" class="panel glass qq-record-detail"><div class="quiet-empty">在 QQ 中开始对话后，会话会显示在这里。</div></section></div>`;
    find('#qq-refresh-records').addEventListener('click', event => run(event.currentTarget,() => loadRecords(signal,true)), {signal});
    void loadRecords(signal,true);
  }
  async function loadRecords(signal, force = false) {
    if (recordsLoading === signal || signal.aborted || !live()) return;
    recordsLoading = signal;clearTimeout(recordsTimer);
    try {
      const result = await api('/conversations');if (signal.aborted || !live()) return;
      conversations = result.conversations;
      if (!conversations.some(item => item.id === selectedId)) selectedId = conversations[0]?.id || '';
      ctx.ui.qqConversationId = selectedId;renderConversations(signal);
      if (selectedId) await loadDetail(signal,force);
      else find('#qq-record-detail').innerHTML = '<div class="quiet-empty">在 QQ 中开始对话后，会话会显示在这里。</div>';
    } catch (error) {if (!signal.aborted && live()) {feedback(error.message,true);if (!conversations.length) find('#qq-conversation-list').innerHTML = '<p class="quiet-empty">读取失败，请刷新会话。</p>';}}
    finally {if (recordsLoading === signal) recordsLoading = null;if (!signal.aborted && live()) recordsTimer = setTimeout(() => loadRecords(signal),4000);}
  }
  function renderConversations(signal) {
    const container = find('#qq-conversation-list');const focused = document.activeElement?.dataset.qqConversation;
    const signature = JSON.stringify(conversations.map(item => [item.id,item.active,item.messageCount,item.updatedAt]));
    if (container.dataset.signature !== signature) {
      container.dataset.signature = signature;
      container.innerHTML = conversations.length ? conversations.map(item => `<button type="button" class="qq-conversation" data-qq-conversation="${e(item.id)}"><strong>${e(conversationName(item))}</strong><span>${e(item.characterName || '角色快照')} · ${item.active ? '当前故事' : '历史故事'}${item.sandbox ? ' · 模拟' : ''}</span><small>${e(dateLabel(item.updatedAt))} · ${e(item.messageCount)} 条</small></button>`).join('') : '<p class="quiet-empty">暂无 QQ 会话</p>';
      container.querySelectorAll('[data-qq-conversation]').forEach(button => button.addEventListener('click', () => {
        const changed = selectedId !== button.dataset.qqConversation;
        selectedId = button.dataset.qqConversation;ctx.ui.qqConversationId = selectedId;editingMemoryId = null;messageSignature = '';++recordSelection;++detailRequest;
        if (changed) {detail = null;memories = [];find('#qq-record-detail').innerHTML = '<div class="quiet-empty" role="status">正在读取会话…</div>';}
        renderConversations(signal);void loadDetail(signal,true).catch(error => {if (!signal.aborted) feedback(error.message,true);});
      }, {signal}));
      if (focused) [...container.querySelectorAll('[data-qq-conversation]')].find(button => button.dataset.qqConversation === focused)?.focus();
    }
    container.querySelectorAll('[data-qq-conversation]').forEach(button => {if (button.dataset.qqConversation === selectedId) button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');});
  }
  async function loadDetail(signal, force = false) {
    const id = selectedId;const selection = recordSelection;const request = ++detailRequest;
    let messagesResult, memoriesResult;
    try {[messagesResult,memoriesResult] = await Promise.all([api(`/conversations/${encodeURIComponent(id)}/messages`),api(`/conversations/${encodeURIComponent(id)}/memories`)]);}
    catch (error) {if (request === detailRequest && currentRecord(signal,id,selection)) throw error;return;}
    if (request !== detailRequest || !currentRecord(signal,id,selection)) return;
    detailApplied = request;
    const changed = detail?.conversation.id !== id;detail = messagesResult;memories = memoriesResult.memories;
    if (changed) editingMemoryId = null;
    if (force || changed || !find('#qq-story-heading')) {
      const item = conversations.find(value => value.id === id) || messagesResult.conversation;
      find('#qq-record-detail').innerHTML = `<div class="panel-heading"><h2 id="qq-story-heading">${e(conversationName(item))}</h2>${item.active ? '<button type="button" class="button small" id="qq-new-story">开始新故事</button>' : '<span class="status-chip">历史故事</span>'}</div><p class="qq-scope">QQ ${e(item.selfId)} · ${e(item.characterName || '角色快照')}${item.revision ? ` v${e(item.revision)}` : ''}${item.sandbox ? ' · 模拟会话' : ''}</p><div id="qq-new-story-confirm" class="qq-inline-confirm" hidden><p>旧消息和记忆会保留在旧故事，新故事从空白上下文开始。</p><div><button type="button" class="button primary small" id="qq-confirm-new-story">开始新故事</button><button type="button" class="button ghost small" id="qq-cancel-new-story">取消</button></div></div>${tab === 'conversations' ? '<details id="qq-summary" class="qq-summary" hidden><summary>会话摘要</summary><p></p></details><ol id="qq-messages" class="qq-messages" aria-label="QQ 消息记录"></ol>' : '<div id="qq-memory-editor"></div><ul id="qq-memory-list" class="qq-memory-list" aria-label="本故事的长期记忆"></ul>'}`;
      find('#qq-new-story')?.addEventListener('click', () => {find('#qq-new-story-confirm').hidden = false;find('#qq-confirm-new-story').focus();}, {signal});
      find('#qq-cancel-new-story')?.addEventListener('click', () => {find('#qq-new-story-confirm').hidden = true;find('#qq-new-story').focus();}, {signal});
      find('#qq-confirm-new-story')?.addEventListener('click', event => run(event.currentTarget,async () => {
        const selection = recordSelection;++detailRequest;
        const result = await api(`/conversations/${encodeURIComponent(id)}/new-story`,'POST',{});if (!currentRecord(signal,id,selection)) return;
        selectedId = result.conversation.id;ctx.ui.qqConversationId = selectedId;editingMemoryId = null;detail = null;messageSignature = '';++recordSelection;++detailRequest;
        if (!signal.aborted) {const next = await api('/conversations');if (signal.aborted) return;conversations = next.conversations;renderConversations(signal);await loadDetail(signal,true);feedback('已开始新故事，旧消息与记忆仍然保留。');}
      }), {signal});
      if (tab === 'memories') drawMemoryEditor(signal);
    }
    if (tab === 'conversations') renderMessages(signal);
    else renderMemories(signal);
  }
  function renderMessages(signal) {
    const list = find('#qq-messages');if (!list) return;
    const signature = JSON.stringify(detail.messages);if (messageSignature === signature || list.contains(document.activeElement)) return;
    messageSignature = signature;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.innerHTML = detail.messages.length ? detail.messages.map(message => `<li class="qq-message${['failed','unknown'].includes(message.status) ? ' qq-message-error' : ''}"><div class="qq-message-heading"><strong>${e(message.role === 'assistant' ? conversations.find(item => item.id === selectedId)?.characterName || '角色' : message.userName || message.userId || 'QQ 用户')}</strong><span class="status-chip${message.status === 'confirmed' ? ' good' : ''}">${e(deliveryLabels[message.status] || message.status)}</span><time>${e(dateLabel(message.createdAt))}</time></div><p class="qq-message-content">${e(message.content || (['queued','generating'].includes(message.status) ? '等待回复' : '暂无文字内容'))}</p><div class="qq-message-source"><span>${message.sourceMessageId ? `QQ 消息 ${e(message.sourceMessageId)}` : `回复记录 #${e(message.replyTo || message.id)}`}${message.gatewayMessageId ? ` · 网关消息 ${e(message.gatewayMessageId)}` : ''}</span>${canRemember(message) ? `<button type="button" class="button ghost small" data-remember-message="${e(message.id)}">加入记忆</button>` : ''}</div>${message.error ? `<p class="form-feedback error">${e(message.error)}</p>` : ''}</li>`).join('') : '<li class="quiet-empty">这个故事还没有消息。</li>';
    if (nearBottom) list.scrollTop = list.scrollHeight;
    find('#qq-summary').hidden = !detail.summary?.content;find('#qq-summary p').textContent = detail.summary?.content || '';
    list.querySelectorAll('[data-remember-message]').forEach(button => button.addEventListener('click', () => {
      const source = detail.messages.find(message => message.id === button.dataset.rememberMessage);
      ctx.drafts.write(`qq:memory:${selectedId}:new`,{content:source.content,sourceMessageId:source.id});editingMemoryId = null;selectTab('memories');
    }, {signal}));
  }
  function memoryKey() {return `qq:memory:${selectedId}:${editingMemoryId || 'new'}`;}
  function drawMemoryEditor(signal) {
    const memory = memories.find(item => item.id === editingMemoryId);
    const draft = ctx.drafts.read(memoryKey(),{content:memory?.content || '',sourceMessageId:memory?.sourceMessageId || ''});
    const sources = detail.messages.filter(canRemember);
    find('#qq-memory-editor').innerHTML = `<form id="qq-memory-form"><div class="panel-heading qq-memory-heading"><h3>${memory ? '编辑记忆' : '新增记忆'}</h3>${help('记忆只用于当前 QQ 账号、角色、会话和故事。开始新故事后，旧记忆仍留在旧故事。','记忆范围说明')}${memory ? '<button type="button" class="button ghost small" id="qq-new-memory">新增记忆</button>' : ''}</div><div class="field"><label for="qq-memory-content">记忆内容</label><textarea id="qq-memory-content" name="content" maxlength="4000" rows="3" required>${e(draft.content)}</textarea></div><div class="field"><label for="qq-memory-source">记忆来源</label><select id="qq-memory-source" name="sourceMessageId"><option value="">手工记录</option>${sources.map(message => `<option value="${e(message.id)}" ${draft.sourceMessageId === message.id ? 'selected' : ''}>#${e(message.id)} · ${e((message.userName || (message.role === 'assistant' ? '角色' : 'QQ 用户')) + '：' + message.content.slice(0,70))}</option>`).join('')}</select></div><div class="form-actions"><p id="qq-memory-feedback" class="form-feedback" role="status"></p><button type="submit" class="button primary" id="qq-save-memory">保存记忆</button></div></form>`;
    const form = find('#qq-memory-form');
    const values = () => ({content:form.elements.content.value,sourceMessageId:form.elements.sourceMessageId.value});
    form.addEventListener('input', () => {ctx.drafts.write(memoryKey(),values());localFeedback('#qq-memory-feedback','记忆修改尚未保存');}, {signal});
    find('#qq-new-memory')?.addEventListener('click', () => {editingMemoryId = null;drawMemoryEditor(signal);find('#qq-memory-content').focus();}, {signal});
    form.addEventListener('submit', event => {
      event.preventDefault();const snapshot = values();const conversationId = selectedId;const id = editingMemoryId;const key = memoryKey();const selection = recordSelection;
      void run(find('#qq-save-memory'),async () => {
        const request = ++detailRequest;
        const result = await api('/memories','POST',{conversationId,...(id ? {id} : {}),content:snapshot.content,sourceMessageId:snapshot.sourceMessageId || null});
        ctx.drafts.reconcile(key,snapshot,{content:result.memory.content,sourceMessageId:result.memory.sourceMessageId || ''});
        if (!currentRecord(signal,conversationId,selection) || request < detailApplied) return;
        detailApplied = ++detailRequest;
        const index = memories.findIndex(item => item.id === result.memory.id);if (index < 0) memories.push(result.memory);else memories[index] = result.memory;
        const sameEditor = form === find('#qq-memory-form');
        const stillSame = sameEditor && JSON.stringify(values()) === JSON.stringify(snapshot) && editingMemoryId === id;
        if (stillSame) {ctx.drafts.write(key,{content:'',sourceMessageId:''});editingMemoryId = null;drawMemoryEditor(signal);}
        renderMemories(signal);if (sameEditor) localFeedback('#qq-memory-feedback',stillSame ? '记忆已保存' : '已保存，新的修改仍保留');
      });
    }, {signal});
  }
  function renderMemories(signal) {
    const list = find('#qq-memory-list');if (!list) return;
    const signature = JSON.stringify(memories);if (list.dataset.signature === signature || list.contains(document.activeElement)) return;
    list.dataset.signature = signature;
    list.innerHTML = memories.length ? memories.map(memory => `<li class="qq-memory"><p class="qq-memory-content">${e(memory.content)}</p><div class="qq-memory-source">${memory.sourceMessageId ? `<span>来源：记录 #${e(memory.sourceMessageId)}</span><blockquote>${e(memory.sourceQuote || '')}</blockquote>` : '<span>来源：手工记录</span>'}</div><div class="qq-memory-actions"><time>${e(dateLabel(memory.updatedAt))}</time><button type="button" class="button ghost small" data-edit-memory="${e(memory.id)}">编辑</button><button type="button" class="button ghost small qq-danger" data-delete-memory="${e(memory.id)}">删除</button></div><div class="qq-inline-confirm" data-memory-delete-confirm="${e(memory.id)}" hidden><p>删除这条记忆后无法恢复，原始消息仍保留。</p><div><button type="button" class="button small qq-danger" data-confirm-delete-memory="${e(memory.id)}">删除记忆</button><button type="button" class="button ghost small" data-cancel-delete-memory="${e(memory.id)}">取消</button></div></div></li>`).join('') : '<li class="quiet-empty">这个故事还没有长期记忆。</li>';
    const confirmation = id => [...list.querySelectorAll('[data-memory-delete-confirm]')].find(node => node.dataset.memoryDeleteConfirm === id);
    list.querySelectorAll('[data-edit-memory]').forEach(button => button.addEventListener('click', () => {editingMemoryId = button.dataset.editMemory;drawMemoryEditor(signal);find('#qq-memory-content').focus();}, {signal}));
    list.querySelectorAll('[data-delete-memory]').forEach(button => button.addEventListener('click', () => {confirmation(button.dataset.deleteMemory).hidden = false;confirmation(button.dataset.deleteMemory).querySelector('[data-confirm-delete-memory]').focus();}, {signal}));
    list.querySelectorAll('[data-cancel-delete-memory]').forEach(button => button.addEventListener('click', () => {confirmation(button.dataset.cancelDeleteMemory).hidden = true;[...list.querySelectorAll('[data-delete-memory]')].find(node => node.dataset.deleteMemory === button.dataset.cancelDeleteMemory)?.focus();}, {signal}));
    list.querySelectorAll('[data-confirm-delete-memory]').forEach(button => button.addEventListener('click', () => run(button,async () => {
      const id = button.dataset.confirmDeleteMemory;const conversationId = selectedId;const selection = recordSelection;const request = ++detailRequest;await api('/memories/delete','POST',{id});
      if (!currentRecord(signal,conversationId,selection) || request < detailApplied) return;
      detailApplied = ++detailRequest;
      memories = memories.filter(item => item.id !== id);if (editingMemoryId === id) {ctx.drafts.write(memoryKey(),{content:'',sourceMessageId:''});editingMemoryId = null;drawMemoryEditor(signal);}
      button.blur();renderMemories(signal);feedback('记忆已删除，原始消息仍保留。');
    }), {signal}));
  }

  async function load() {
    try {data = await api('/state');if (!live()) return;draw();stateTimer = setTimeout(pollState,2500);}
    catch (error) {
      if (!live()) return;
      find('#qq-panel').innerHTML = `<section class="panel glass"><h2>QQ 状态暂时无法读取</h2><p class="form-feedback error">${e(error.message)}</p><button type="button" class="button" id="qq-retry">重试</button></section>`;
      find('#qq-retry').addEventListener('click',load,{signal:ctx.signal});
    }
  }
  await load();
}
