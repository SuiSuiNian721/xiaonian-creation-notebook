import {escape as e,icon,moduleIcon,eventList,help} from '../components.js';
import {openCharacterLife} from '../character-life.js';
import {mountPackageInstallation} from './optional-package.js';
import {mountPathPicker} from '../path-picker.js';
import {mountResourcePreparation,preparationFor} from '../resource-preparation.js';
import {mountEnvironmentDiscovery} from '../environment-view.js';

const pages=[['stage','陪伴'],['chat','聊天'],['settings','设置'],['records','记录']];
const settings=[
  ['models','角色模型','导入 Live2D 或 VRM 模型','person'],
  ['modules/speech','声音','选择声音和语音服务','voice'],
  ['modules/hearing','语音输入','设置麦克风和语音识别','voice'],
];
const advanced=[['scene','场景'],['airi-card','角色卡'],['providers','模型服务'],['modules/vision','视觉'],['modules/mcp','MCP 工具'],['modules/gaming-minecraft','Minecraft'],['modules/gaming-factorio','Factorio'],['modules/artistry','绘图'],['connection','连接设置'],['system','显示设置']];
const settingTitle=route=>[...settings,...advanced].find(([path])=>'/settings/'+path===route)?.[1]||'更多设置';

export async function mount(root,ctx){
  const installation=await ctx.api('/api/modules/companion/resources');
  if(ctx.signal.aborted)return;
  if(!installation.prerequisitesReady)return mountPackageInstallation(root,ctx,'companion');
  let state=await ctx.api('/api/modules/companion/state');
  if(ctx.signal.aborted)return;
  let selected=pages.some(([id])=>id===ctx.ui.companionView)?ctx.ui.companionView:'stage';
  let detailRoute=ctx.ui.companionSettingsRoute||'',running=state.status==='running',busy=false,frame=0,lastArea='',revision=0,switching=0,startupController;
  const draftKey='module:companion';
  let installDraft=ctx.drafts?.read(draftKey,{}).airiPath??state.source?.installPath??'';
  const request=(path,body)=>ctx.api('/api/modules/companion/'+path,{method:'POST',body,timeoutMs:60000});
  const emptyStage=()=>`<div id="companion-stage-empty" class="companion-empty">${moduleIcon('companion','large')}<h2>尚未导入角色模型</h2><p>Live2D ZIP · VRM</p><div class="companion-empty-actions"><button type="button" class="button primary" data-companion-route="/settings/models">${icon('upload')}导入模型</button><button type="button" class="button ghost" data-companion-switch="chat">打开聊天 ${icon('arrow')}</button></div></div>`;
  root.innerHTML=`<div class="module-heading">${moduleIcon('companion','large')}<div class="heading-title"><h1>虚拟陪伴</h1>${help('选择角色后聊天，导入自己的模型后开启形象。声音和其他功能在设置中配置。','虚拟陪伴说明')}</div><div class="remove-control"><button type="button" class="button ghost small" id="companion-remove">移除入口</button><small>保留配置与资料</small></div></div>
    <div class="companion-toolbar"><div class="module-tabs" role="tablist" aria-label="陪伴页面">${pages.map(([id,label])=>`<button type="button" role="tab" id="companion-tab-${id}" data-companion-view="${id}" aria-controls="companion-panel">${label}</button>`).join('')}</div><div class="companion-actions"><button type="button" id="companion-desktop" class="button small">${icon('companion')}桌面陪伴</button><button type="button" id="companion-immerse" class="button small">${icon('expand')}沉浸模式</button></div></div>
    <p id="companion-feedback" class="form-feedback" role="status"></p>
    <section id="companion-panel" role="tabpanel"><div id="companion-native-heading" class="companion-native-heading" hidden><button type="button" class="button ghost small" id="companion-settings-back">${icon('back')}返回设置</button><h2 id="companion-setting-title"></h2></div><div id="companion-viewport" class="companion-viewport">${emptyStage()}</div>
    <div id="companion-settings" class="companion-settings" hidden><div class="companion-settings-list">${settings.map(([route,title,description,symbol])=>`<button type="button" class="companion-setting-row" data-companion-route="/settings/${route}"><span class="companion-setting-icon">${icon(symbol)}</span><span><strong>${title}</strong><small ${route==='models'?'id="companion-model-status"':''}>${description}</small></span>${icon('arrow')}</button>`).join('')}</div><details class="companion-advanced"><summary>更多设置</summary><div>${advanced.map(([route,title,unavailable])=>`<button type="button" class="button ghost" ${unavailable?'disabled':'data-companion-route="/settings/'+route+'"'}>${title}${icon('arrow')}</button>`).join('')}</div></details></div><div id="companion-records" hidden></div></section>`;
  const find=selector=>root.querySelector(selector),viewport=find('#companion-viewport'),feedback=find('#companion-feedback');
  const lifeButton=document.createElement('button');lifeButton.type='button';lifeButton.className='button small';lifeButton.id='companion-character-life';lifeButton.dataset.modulePersona='';lifeButton.innerHTML=`${icon('person')}人设与记忆`;
  find('.companion-actions').prepend(lifeButton);
  lifeButton.addEventListener('click',()=>openCharacterLife(ctx,{moduleId:'companion',trigger:lifeButton}),{signal:ctx.signal});
  const nativeView=()=>selected==='chat'?'chat':selected==='stage'&&state.runtime?.model?.available?'stage':selected==='settings'&&detailRoute?'settings':null;
  function area(){
    if(ctx.signal.aborted||!root.checkVisibility()||!running||!nativeView()||document.hidden||document.documentElement.dataset.moduleHelpOpen||document.documentElement.dataset.characterLifeOpen||document.querySelector('[data-module-ai-popover]:popover-open')||document.querySelector('#help-tooltip:not([hidden])')||document.querySelector('#activity-drawer:not([hidden])'))return {visible:false};
    const rect=viewport.getBoundingClientRect(),x=Math.max(0,rect.left),y=Math.max(0,rect.top);
    return {visible:rect.bottom>0&&rect.right>0&&rect.top<innerHeight,x,y,width:Math.max(0,Math.min(rect.right,innerWidth)-x),height:Math.max(0,Math.min(rect.bottom,innerHeight)-y),theme:ctx.state.preferences.theme};
  }
  function layout(){
    cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
      const value=area(),serialized=JSON.stringify(value);if(serialized===lastArea)return;lastArea=serialized;
      void request('viewport',value).catch(error=>{if(!ctx.signal.aborted){feedback.textContent=error.message;feedback.className='form-feedback error';}});
    });
  }
  function tabs(){
    root.querySelectorAll('[data-companion-view]').forEach(button=>{const active=button.dataset.companionView===selected;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    find('#companion-panel').setAttribute('aria-labelledby','companion-tab-'+selected);
    viewport.hidden=selected==='records'||selected==='settings'&&!detailRoute;
    find('#companion-settings').hidden=selected!=='settings'||!!detailRoute;
    find('#companion-native-heading').hidden=selected!=='settings'||!detailRoute;
    find('#companion-setting-title').textContent=settingTitle(detailRoute);
    find('#companion-records').hidden=selected!=='records';
    find('#companion-stage-empty')?.toggleAttribute('hidden',selected!=='stage'||!!state.runtime?.model?.available);
    find('#companion-desktop').disabled=!running||busy||!state.runtime?.model?.available;
    root.querySelectorAll('[data-companion-route]').forEach(button=>{button.disabled=!running||busy;});
    find('#companion-model-status').textContent=state.runtime?.model?.available?state.runtime.model.name:'导入 Live2D 或 VRM 模型';
  }
  async function select(view,route=''){
    switching++;const generation=++revision;selected=view;detailRoute=route;ctx.ui.companionView=view;ctx.ui.companionSettingsRoute=route;feedback.textContent='';feedback.className='form-feedback';tabs();
    try{
      if(view==='records'){
        await request('viewport',{visible:false});lastArea='';await ctx.refresh();if(ctx.signal.aborted||generation!==revision)return;
        find('#companion-records').innerHTML=`<div class="panel glass"><div class="panel-heading"><h2>运行记录</h2><button type="button" id="companion-refresh" class="button small">刷新</button></div>${eventList(ctx.state.events.filter(event=>event.moduleId==='companion'),ctx.state.modules)}</div>`;
        find('#companion-refresh').addEventListener('click',()=>void select('records'),{signal:ctx.signal});
      }else if(running){
        const target=nativeView();
        if(target)await request('window',{view:target,...(target==='settings'?{route:detailRoute}:{})});
        if(!ctx.signal.aborted&&generation===revision){lastArea='';layout();}
      }
    }catch(error){if(!ctx.signal.aborted){feedback.textContent=error.message;feedback.className='form-feedback error';}}finally{switching--;}
  }
  function showStartFailure(error,failed){
    running=false;selected='stage';detailRoute='';ctx.ui.companionView='stage';ctx.ui.companionSettingsRoute='';feedback.textContent='';
    showStartup(error,failed);
  }
  function showStartup(error,failed=state){
    startupController?.abort();startupController=new AbortController();
    const local={...ctx,signal:startupController.signal};
    viewport.innerHTML=`<div class="companion-start"><h2>${error?'陪伴暂时无法打开':'陪伴尚未启动'}</h2>${error?`<p>${e(error.message)}</p>`:''}${failed.runtime?.restartRequired?'':error?'<button type="button" id="companion-retry" class="button primary">重新打开</button>':'<button type="button" class="button primary" data-companion-start>打开陪伴</button>'}<div data-companion-environment></div><form id="companion-install-form" class="field"><div class="field-label"><label for="companion-install">运行组件安装目录</label>${help('兼容 0.12.0-beta.5 运行组件。采用候选只填入路径，保存后再打开陪伴。','运行组件说明')}</div><input id="companion-install" value="${e(installDraft)}" autocomplete="off"><button type="submit" class="button">保存位置</button></form><div data-companion-preparation></div></div>`;
    const input=find('#companion-install');
    mountPathPicker(input,local,{moduleId:'companion',target:'module',field:'airiPath',kind:'directory'});
    input.addEventListener('input',()=>{installDraft=input.value;ctx.drafts?.write(draftKey,{...ctx.drafts.read(draftKey,{}),airiPath:installDraft});},{signal:local.signal});
    mountEnvironmentDiscovery(find('[data-companion-environment]'),local,{moduleId:'companion',canSelect:()=>!busy,onSelect:candidate=>{
      if(typeof candidate.values?.airiPath!=='string')throw new Error('候选缺少运行组件位置，请重新扫描。');
      input.value=candidate.values.airiPath;input.dispatchEvent(new Event('input',{bubbles:true}));
    }});
    mountResourcePreparation(find('[data-companion-preparation]'),local,{...preparationFor('companion'),open:!!error||!installDraft.trim(),onTarget:()=>{input.focus();input.closest('.path-picker')?.querySelector('[data-path-field]')?.click();}});
    find('#companion-retry')?.addEventListener('click',()=>void start(),{signal:ctx.signal});
    find('[data-companion-start]')?.addEventListener('click',()=>void start(),{signal:local.signal});
    find('#companion-install-form').addEventListener('submit',event=>{event.preventDefault();const airiPath=input.value;void ctx.action(event.submitter,async()=>{try{
      const result=await ctx.api('/api/modules/companion/config',{method:'PUT',body:{values:{airiPath}}}),saved=result.config??{airiPath};
      ctx.drafts?.reconcile(draftKey,{airiPath},saved);
      if(local.signal.aborted)return;
      if(input.value===airiPath)input.value=installDraft=saved.airiPath??airiPath;
      feedback.className='form-feedback';feedback.textContent=input.value!==(saved.airiPath??airiPath)?'位置已保存，新的修改仍保留。':failed.runtime?.restartRequired?'安装位置已保存，请重新打开工作台。':'安装位置已保存，点击打开陪伴。';
    }catch(failure){if(!local.signal.aborted){feedback.textContent=failure.message;feedback.className='form-feedback error';}}});},{signal:local.signal});
  }
  async function start(){
    if(busy)return;busy=true;tabs();feedback.textContent='正在连接陪伴…';
    try{
      state=await request('start',{});running=true;
      if(ctx.signal.aborted){await request('viewport',{visible:false});return;}
      startupController?.abort();viewport.innerHTML=emptyStage();await select(selected,detailRoute);
    }catch(error){
      if(ctx.signal.aborted)return;
      const failed=await ctx.api('/api/modules/companion/state').catch(()=>state);if(ctx.signal.aborted)return;
      showStartFailure(error,failed);
    }finally{busy=false;if(!ctx.signal.aborted)tabs();}
  }
  root.addEventListener('click',event=>{
    const setting=event.target.closest('[data-companion-route]'),page=event.target.closest('[data-companion-switch]');
    if(setting&&!setting.disabled)void select('settings',setting.dataset.companionRoute);
    else if(page)void select(page.dataset.companionSwitch);
  },{signal:ctx.signal});
  root.querySelectorAll('[data-companion-view]').forEach(button=>{
    button.addEventListener('click',()=>void select(button.dataset.companionView),{signal:ctx.signal});
    button.addEventListener('keydown',event=>{
      const buttons=[...root.querySelectorAll('[data-companion-view]')],index=buttons.indexOf(button);let next;
      if(event.key==='ArrowRight')next=buttons[(index+1)%buttons.length];if(event.key==='ArrowLeft')next=buttons[(index+buttons.length-1)%buttons.length];
      if(event.key==='Home')next=buttons[0];if(event.key==='End')next=buttons.at(-1);
      if(next){event.preventDefault();next.focus();void select(next.dataset.companionView);}
    },{signal:ctx.signal});
  });
  find('#companion-settings-back').addEventListener('click',()=>void select('settings'),{signal:ctx.signal});
  find('#companion-immerse').addEventListener('click',()=>ctx.immersion.enter('companion'),{signal:ctx.signal});
  find('#companion-desktop').addEventListener('click',event=>void ctx.action(event.currentTarget,async()=>{const generation=revision;state=await request('window',{view:'desktop'});if(!ctx.signal.aborted&&generation===revision){feedback.className='form-feedback';feedback.textContent='角色已移到桌面，点击“陪伴”可收回。';}}),{signal:ctx.signal});
  find('#companion-remove').addEventListener('click',event=>void ctx.action(event.currentTarget,async()=>{await ctx.disableModule('companion');ctx.navigate('home');}),{signal:ctx.signal});
  const resize=new ResizeObserver(layout);resize.observe(viewport);
  const overlays=new MutationObserver(layout);overlays.observe(document.documentElement,{attributes:true,subtree:true,attributeFilter:['data-theme','data-immersive','data-module-help-open','data-character-life-open','hidden','class','aria-expanded']});
  let refreshing=false;
  const refreshTimer=setInterval(async()=>{
    if(refreshing||busy||switching||ctx.signal.aborted)return;refreshing=true;
    try{
      const previous=JSON.stringify(state.runtime?.model);state=await ctx.api('/api/modules/companion/state');if(ctx.signal.aborted)return;
      if(state.status==='stopped'&&running){showStartFailure(new Error(state.error||'陪伴运行端已停止，请重新打开工作台。'),state);tabs();}
      else if(previous!==JSON.stringify(state.runtime?.model)){tabs();if(nativeView())await request('window',{view:nativeView(),...(selected==='settings'?{route:detailRoute}:{})});lastArea='';layout();}
    }catch{}finally{refreshing=false;}
  },1000);
  document.addEventListener('toggle',layout,{signal:ctx.signal,capture:true});window.addEventListener('resize',layout,{signal:ctx.signal});document.addEventListener('scroll',layout,{signal:ctx.signal,capture:true,passive:true});document.addEventListener('visibilitychange',layout,{signal:ctx.signal});
  ctx.signal.addEventListener('abort',()=>{startupController?.abort();clearInterval(refreshTimer);cancelAnimationFrame(frame);resize.disconnect();overlays.disconnect();void request('viewport',{visible:false}).catch(()=>{});},{once:true});
  tabs();if(running)await select(selected,detailRoute);else {
    selected='stage';detailRoute='';ctx.ui.companionView='stage';ctx.ui.companionSettingsRoute='';showStartup();tabs();
  }
}
