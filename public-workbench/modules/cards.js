import { escape as e, icon, moduleIcon, eventList, help } from '../components.js';

export function activate() { window.__workbenchCancelExit?.(); }

export function mount(root, ctx) {
  let studio;
  let frame;
  let frameReady = false;
  let selected = '';
  let tab = 'overview';
  let listGeneration = 0;
  root.innerHTML = `<div class="module-heading">${moduleIcon('cards','large')}<div class="heading-title"><h1>角色卡</h1>${help('作品和聊天保存在工作台独立目录，可通过导入载入 PNG 或 JSON 角色卡。','角色卡说明')}</div><div class="remove-control"><button class="button ghost small" id="remove-module" type="button">移除入口</button><small>保留配置与资料</small></div></div>
    <div class="module-tabs" role="tablist" aria-label="模块页面">${[['overview','创作'],['resources','内置组件'],['config','接入配置'],['records','运行记录']].map(([id,label])=>`<button id="tab-${id}" type="button" role="tab" data-tab="${id}" aria-controls="cards-${id}" aria-selected="${id==='overview'}" tabindex="${id==='overview'?0:-1}">${label}</button>`).join('')}</div>
    <section id="cards-overview" role="tabpanel" aria-labelledby="tab-overview">
      <div id="card-library"><div class="panel-heading"><h2>我的作品</h2><div class="card-library-actions"><button class="button" id="import-card" type="button">${icon('upload')}导入</button><button class="button primary" id="create-card" type="button">${icon('plus')}新建人设</button></div></div><input id="card-import-file" type="file" accept=".json,.png" hidden><div id="card-list" aria-live="polite"><p>正在读取作品…</p></div></div>
      <div id="card-editor" hidden><div class="card-editor-heading"><button class="button small" type="button" id="back-to-cards">${icon('chevron')}作品列表</button><h2 id="editing-card-name"></h2><button type="button" class="button small card-editor-immerse" id="cards-immerse">${icon('expand')}沉浸模式</button></div><div id="card-editor-frame"></div></div>
      <p id="card-feedback" class="form-feedback" role="status"></p>
    </section>
    <section id="cards-resources" role="tabpanel" aria-labelledby="tab-resources" hidden><div class="panel glass"><div class="panel-heading"><h2>角色卡编辑组件</h2><span class="status-chip good">随工作台提供</span></div><p>编辑器、写作参考与导出工具已内置，无需另外下载。</p><div class="card-resource-meta"><span>角色卡创作组件</span><span>下载量 0 B</span></div></div></section>
    <section id="cards-config" role="tabpanel" aria-labelledby="tab-config" hidden><div class="panel glass"><div class="panel-heading"><h2>创作设置</h2></div><div class="field"><label for="card-workspace-path">作品目录</label><input id="card-workspace-path" readonly spellcheck="false"></div><p id="card-config-feedback" class="form-feedback" role="status"></p></div></section>
    <section id="cards-records" role="tabpanel" aria-labelledby="tab-records" hidden></section>`;
  const find = selector => root.querySelector(selector);
  find('#cards-immerse').addEventListener('click',()=>ctx.immersion.enter('cards'));
  window.addEventListener('card-studio-selection',event=>{
    if((!ctx.instanceId||event.detail?.frame===frame)&&typeof event.detail?.name==='string'){selected=event.detail.name;find('#editing-card-name').textContent=selected;}
  },{signal:ctx.signal});
  const feedback = (message, failed = false) => { find('#card-feedback').textContent=message; find('#card-feedback').className=`form-feedback${failed?' error':''}`; };
  const ensureStudio = async () => {
    if (!studio) studio = await ctx.api('/api/modules/cards/studio',{method:'POST',body:{},timeoutMs:30000});
    find('#card-workspace-path').value = studio.workspacePath;
    return studio;
  };
  const frameCall = async method => {
    if (!frame?.contentWindow?.[method]) return;
    let timer;
    try { await Promise.race([frame.contentWindow[method](),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('保存草稿超时，请重试。')),7000);})]); }
    finally { clearTimeout(timer); }
  };
  const flushDrafts = () => frameCall('__flushDrafts');
  const prepareExit = async () => {
    document.body.inert=true;
    try {await frameCall('__prepareDraftExit');}
    catch(error){cancelExit();throw error;}
  };
  const cancelExit = () => {document.body.inert=false;frame?.contentWindow?.__cancelDraftExit?.();};
  if(ctx.registerDraftHooks)ctx.registerDraftHooks({flush:flushDrafts,prepareExit,cancelExit});
  else {window.__workbenchFlushDrafts=flushDrafts;window.__workbenchPrepareExit=prepareExit;window.__workbenchCancelExit=cancelExit;}
  async function ensureFrame() {
    await ensureStudio();
    if (!frame) {
      frame=document.createElement('iframe'); frame.id='card-studio-frame'; frame.title='角色卡创作编辑器';
      frame.src=studio.url;
      find('#card-editor-frame').append(frame);
    }
    const deadline=Date.now()+15000;
    while (!frame.contentWindow?.__workbenchReady?.()) {
      if(Date.now()>deadline) {
        // The initial frame has never been shown or accepted user input.
        if(!frameReady){frame.remove();frame=undefined;}
        throw new Error('创作页未能载入。请再次点击“打开作品”重新加载，已有文件会保留。');
      }
      await new Promise(resolve=>setTimeout(resolve,60));
    }
    frameReady=true;
    return frame.contentWindow;
  }
  async function openCard(name) {
    feedback('正在打开作品…');
    try {
      const editor=await ensureFrame();
      if (selected!==name || editor.state?.name!==name || editor.state?.block!=='card' || !editor.state?.tree) await editor.__workbenchOpenCard(name);
      selected=name; find('#editing-card-name').textContent=name;
      find('#card-library').hidden=true; find('#card-editor').hidden=false; feedback('');
      await selectTab('overview');
    } catch(error) {feedback(error.message,true);}
  }
  async function loadCards() {
    const generation=++listGeneration;
    try {
      await ensureStudio();
      const cards=await ctx.api('/card-studio/api/cards');
      if(generation!==listGeneration)return;
      find('#card-list').innerHTML=cards.length?`<div class="card-work-grid">${cards.map(card=>`<article class="card-work glass"><span class="card-work-symbol">${moduleIcon('cards')}</span><h3>${e(card.name)}</h3>${card.warning?`<p class="form-feedback error">${e(card.warning)}</p>`:''}<button type="button" class="button" data-edit-card="${e(card.name)}">打开作品 ${icon('arrow')}</button></article>`).join('')}</div>`:'<div class="empty-workspace glass"><h3>还没有作品</h3><p>新建一份人设，或导入已有角色卡。</p></div>';
      find('#card-list').querySelectorAll('[data-edit-card]').forEach(button=>button.addEventListener('click',()=>ctx.action(button,()=>openCard(button.dataset.editCard))));
    }catch(error){find('#card-list').innerHTML=`<div class="panel glass"><p class="form-feedback error">${e(error.message)}</p><button class="button" id="retry-card-list" type="button">重新读取</button></div>`;find('#retry-card-list').onclick=loadCards;}
  }
  async function selectTab(next, focus = false) {
    if(next!==tab) await flushDrafts();
    tab=next;ctx.ui.moduleTabs.cards=tab;
    root.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;find(`#cards-${button.dataset.tab}`).hidden=!active;});
    if(tab==='records'){await ctx.refresh();find('#cards-records').innerHTML=`<div class="panel glass"><h2>运行记录</h2>${eventList(ctx.state.events.filter(event=>event.moduleId==='cards'),ctx.state.modules)}</div>`;}
    if(tab==='config')await ensureStudio();
    if(focus)find(`#tab-${next}`).focus();
  }
  root.querySelectorAll('[data-tab]').forEach(button=>{
    button.addEventListener('click',()=>selectTab(button.dataset.tab).catch(error=>ctx.notify(error.message,true)));
    button.addEventListener('keydown',event=>{const tabs=['overview','resources','config','records'];let next;if(event.key==='ArrowRight')next=tabs[(tabs.indexOf(tab)+1)%4];if(event.key==='ArrowLeft')next=tabs[(tabs.indexOf(tab)+3)%4];if(event.key==='Home')next=tabs[0];if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();void selectTab(next,true).catch(error=>ctx.notify(error.message,true));}});
  });
  find('#back-to-cards').onclick=()=>ctx.action(find('#back-to-cards'),async()=>{await flushDrafts();find('#card-editor').hidden=true;find('#card-library').hidden=false;await loadCards();});
  find('#remove-module').onclick=()=>ctx.action(find('#remove-module'),async()=>{
    try {
      await window.__workbenchPrepareExit();
      await ctx.disableModule('cards');ctx.navigate('home');
    } catch(error) {window.__workbenchCancelExit();throw error;}
  });
  find('#create-card').onclick=()=>{
    const dialog=document.createElement('dialog');dialog.className='card-create-dialog glass';
    dialog.innerHTML='<form><h2>新建人设</h2><div class="field"><label for="new-card-name">作品名称</label><input id="new-card-name" name="name" required maxlength="100" autocomplete="off"></div><p class="form-feedback error" role="alert"></p><div class="card-library-actions"><button type="button" class="button" data-cancel>取消</button><button class="button primary" type="submit">创建</button></div></form>';
    document.body.append(dialog);dialog.showModal();dialog.querySelector('input').focus();
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const name=dialog.querySelector('input').value.trim();const button=dialog.querySelector('[type="submit"]');button.disabled=true;try{await ensureStudio();await ctx.api('/card-studio/api/new',{method:'POST',body:{name}});dialog.close();await loadCards();await openCard(name);}catch(error){dialog.querySelector('[role="alert"]').textContent=error.message;}finally{button.disabled=false;}};
  };
  find('#import-card').onclick=()=>find('#card-import-file').click();
  find('#card-import-file').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;
    await ctx.action(find('#import-card'),async()=>{
      if(file.size>25*1024*1024)throw new Error('角色卡文件不能超过 25 MiB。');
      await ensureStudio();
      const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取角色卡。'));reader.readAsDataURL(file);});
      const name=file.name.replace(/\.(png|json)$/i,'');
      const result=await ctx.api('/card-studio/api/import',{method:'POST',body:{fileName:file.name,name,base64},timeoutMs:30000});
      await loadCards();await openCard(result.dir.replaceAll('\\','/').split('/').pop());
    });
  };
  void loadCards();
}
