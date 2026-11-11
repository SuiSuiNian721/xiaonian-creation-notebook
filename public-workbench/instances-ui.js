import {escape as e,icon} from './components.js';
import {Drafts} from './drafts.js';
import {mountModuleAIControl,closeModuleAIControls} from './module-ai-control.js';
import {mountModuleHelp,closeModuleHelp} from './module-help.js';
import {openCharacterLife,closeCharacterLife} from './character-life.js';
import {moduleFamilyId,moduleVariants,defaultInstanceModule} from './module-families.js';
import {openCharacterResources} from './character-resources-ui.js';

// A mounted view keeps its own context for its entire lifetime, including asynchronous replies.
export function createInstanceViews({container,api,baseContext,getModules,loadModule,refreshLibrary,notify,immersion}){
  const panels=new Map(),selected=new Map(),viewData=new Map(),stopped=new Set(),pendingCreates=new Map(),tabBar=document.createElement('div');
  tabBar.className='instance-bar';container.append(tabBar);
  const statusPanel=document.createElement('section');statusPanel.className='panel glass instance-status';statusPanel.hidden=true;container.append(statusPanel);
  // Keep inactive views in a separate ID scope. Atomic moves preserve iframe editors,
  // their JS state and pending drafts while the active view retains normal page styles.
  const parkingHost=document.createElement('div');parkingHost.hidden=true;container.append(parkingHost);
  const parking=document.createElement('div');parkingHost.attachShadow({mode:'open'}).append(parking);
  const move=(parent,node)=>{if(node.parentNode===parent)return;if(node.isConnected&&typeof parent.moveBefore==='function')parent.moveBefore(node,null);else parent.append(node);};
  let records=[],module=null,generation=0,listGeneration=0;
  const request=(id,action='',body,method='POST')=>api('/api/instances/'+id+(action?'/'+action:''),{method,body,timeoutMs:60000});
  const list=async()=>{const version=++listGeneration,next=(await api('/api/instances')).instances;if(version===listGeneration)records=next;return records;};
  const family=id=>moduleFamilyId(getModules(),id),belongs=(record,id=module?.id)=>family(record.moduleId)===family(id);
  const active=()=>records.find(record=>record.id===selected.get(family(module?.id)));
  function conceal(panel){panel.chromeController?.abort();panel.chromeController=null;panel.node.hidden=true;move(parking,panel.node);}
  function hide(){generation++;container.hidden=true;statusPanel.hidden=true;closeCharacterLife();closeModuleHelp();closeModuleAIControls();for(const panel of panels.values())conceal(panel);window.dispatchEvent(new Event('resize'));}
  async function flush(id){await panels.get(id)?.hooks?.flush?.();}
  async function discard(id){const panel=panels.get(id);if(!panel)return;await flush(id);conceal(panel);panel.controller.abort();panel.node.remove();panels.delete(id);}
  function showStopped(record){
    for(const panel of panels.values())conceal(panel);
    statusPanel.innerHTML=`<h2>${e(record.name)}已停止</h2><button type="button" class="button primary" data-instance-resume>打开实例</button>`;statusPanel.hidden=false;
    statusPanel.querySelector('[data-instance-resume]').onclick=event=>run(event.currentTarget,()=>activate(record.id));
  }
  function tabs(){
    if(!module)return;
    const current=active(),open=records.filter(record=>belongs(record)&&record.tabOpen),variants=moduleVariants(getModules(),module.id);
    tabBar.innerHTML=`<div class="instance-tabs" role="tablist" aria-label="${e(module.name)}实例">${open.map(record=>`<div class="instance-tab"><button type="button" role="tab" data-instance-select="${record.id}" aria-selected="${record.id===current?.id}" tabindex="${record.id===current?.id?0:-1}">${e(record.name)}</button><button type="button" class="instance-tab-close" data-instance-close="${record.id}" aria-label="关闭 ${e(record.name)} 的标签" title="关闭标签后实例继续在后台运行；需要停止时，请在「管理实例」中操作。">${icon('close')}</button></div>`).join('')}</div>${variants.length?`<label class="instance-mode"><span>陪伴模式</span><select data-instance-variant aria-label="陪伴模式" ${current?'':'disabled'}>${variants.map(variant=>`<option value="${e(variant.variant)}" ${variant.id===current?.moduleId?'selected':''}>${variant.variant==='lite'?'精简版':'完整版'}</option>`).join('')}</select></label>`:''}<button type="button" class="button small" data-instance-new>${icon('plus')}新建实例</button><button type="button" class="button ghost small" data-instance-manage>管理实例</button>`;
    tabBar.querySelectorAll('[data-instance-select]').forEach(button=>button.onclick=()=>run(button,()=>activate(button.dataset.instanceSelect)));
    tabBar.querySelectorAll('[data-instance-close]').forEach(button=>button.onclick=()=>run(button,async()=>{const id=button.dataset.instanceClose,version=generation,definition=module;await flush(id);await request(id,'',{tabOpen:false},'PATCH');await list();if(version!==generation)return;if(current?.id===id)selected.delete(family(definition.id));await show(definition);}));
    tabBar.querySelector('[data-instance-new]').onclick=event=>run(event.currentTarget,async()=>{const version=generation,count=records.filter(record=>belongs(record)).length+1;const {instance}=await api('/api/instances',{method:'POST',body:{moduleId:defaultInstanceModule(getModules(),module.id),name:module.name+' '+count},timeoutMs:60000});await list();if(version===generation)await activate(instance.id);});
    const variant=tabBar.querySelector('[data-instance-variant]');
    if(variant)variant.onchange=()=>run(variant,async()=>{
      const record=active(),moduleId=module.id;if(!record)return;
      try{
        await flush(record.id);await request(record.id,'variant',{variant:variant.value});
        await discard(record.id);await list();
        if(module?.id===moduleId&&active()?.id===record.id)await activate(record.id);
        notify('已切换陪伴模式，人设与记录保留在当前实例。');
      }finally{await list();if(module?.id===moduleId){tabs();if(active()?.id===record.id&&!document.documentElement.dataset.moduleHelpOpen)tabBar.querySelector('[data-instance-variant]')?.focus({preventScroll:true});}}
    });
    tabBar.querySelector('[data-instance-manage]').onclick=manage;
    tabBar.onkeydown=event=>{const buttons=[...tabBar.querySelectorAll('[role="tab"]')],index=buttons.indexOf(event.target);if(index<0)return;let next;if(event.key==='ArrowRight')next=buttons[(index+1)%buttons.length];if(event.key==='ArrowLeft')next=buttons[(index+buttons.length-1)%buttons.length];if(event.key==='Home')next=buttons[0];if(event.key==='End')next=buttons.at(-1);if(next){event.preventDefault();next.focus();next.click();}};
  }
  async function run(button,job){if(button.disabled)return;button.disabled=true;try{await job();}catch(error){notify(error.message,true);}finally{if(button.isConnected)button.disabled=false;}}
  async function makePanel(record){
    const controller=new AbortController(),node=document.createElement('section'),body=document.createElement('div');
    node.className='instance-panel';node.hidden=true;node.dataset.instanceId=record.id;node.setAttribute('aria-label',record.name);body.className='instance-module';node.append(body);parking.append(node);
    const panel={record,node,body,controller,hooks:null,state:null,ctx:null};panels.set(record.id,panel);
    const prefix='/instances/'+record.id,scoped=(path,options)=>api(prefix+path,options);
    if(!viewData.has(record.id))viewData.set(record.id,{ui:{moduleTabs:{}},drafts:new Drafts()});
    const base=baseContext(controller.signal),{ui,drafts}=viewData.get(record.id);
    const refresh=async()=>{const next=await scoped('/api/state');if(!controller.signal.aborted)panel.state=next;return next;};
    const ctx={...base,get state(){return panel.state;},instanceId:record.id,moduleId:record.moduleId,libraryApi:api,ui,drafts,api:scoped,url:path=>prefix+path,fetch:(path,options)=>fetch(prefix+path,options),refresh,
      navigateModule:async(moduleId,target)=>{
        if(['drawing','comfyui'].includes(record.moduleId)&&moduleId===(record.moduleId==='drawing'?'comfyui':'drawing')){
          await flush(record.id);
          const {instance}=await request(record.id,'related',{moduleId});
          if(controller.signal.aborted||panel.node.hidden)return;
          return base.navigateModule(moduleId,{...target,instanceId:instance.id});
        }
        return base.navigateModule(moduleId,target);
      },
      selectCharacter:async id=>{await scoped('/api/characters/select',{method:'POST',body:{id:id||null}});await refresh();await remount(record.id);},
      rerender:()=>remount(record.id),registerDraftHooks:hooks=>{panel.hooks=hooks;},
      characters:{getSelected:()=>panel.state?.characters.find(character=>character.id===panel.state.selectedCharacterId)||null},
      assets:{list:()=>ctx.characters.getSelected()?.assets||[]},tasks:{list:()=>panel.state?.tasks||[]},
      ai:{complete:(moduleId,messages)=>scoped('/api/ai/chat',{method:'POST',body:{moduleId,messages},timeoutMs:185000})},
      instancePersona:{
        import:options=>personaDialog(panel,options),
        export:async characterId=>{await request(record.id,'export-persona',{characterId});await refreshLibrary();},
        resources:characterId=>openCharacterResources({...ctx,characters:{getSelected:()=>panel.state.characters.find(item=>item.id===characterId)||null}}),
      },
    };panel.ctx=ctx;
    panel.ready=(async()=>{
      await refresh();const view=await loadModule(record.moduleId);if(controller.signal.aborted)return;
      await view.mount(body,ctx);if(controller.signal.aborted)return;
      mountPersonaEntry(panel);
      await scoped('/api/modules/'+record.moduleId+'/open',{method:'POST',body:{}});
    })();
    await panel.ready;
    return panel;
  }
  function mountPersonaEntry(panel){
    const definition=panel.state?.modules.find(item=>item.id===panel.record.moduleId);
    if(panel.controller.signal.aborted||definition?.usesCharacterContext===false||panel.body.querySelector('[data-module-persona]'))return;
    const heading=panel.body.querySelector('.module-heading');if(!heading)return;
    const button=document.createElement('button');button.type='button';button.className='button small';button.dataset.modulePersona='';button.innerHTML=icon('person')+'人设与记忆';
    const actions=heading.querySelector('.module-header-actions');
    if(actions)actions.prepend(button);else heading.insertBefore(button,heading.querySelector('.remove-control'));
    button.addEventListener('click',()=>openCharacterLife(panel.ctx,{trigger:button}),{signal:panel.controller.signal});
  }
  async function activate(id,{version=++generation}={}){
    const record=records.find(item=>item.id===id);if(!record)return;
    const current=()=>version===generation&&belongs(record)&&!container.hidden;
    await flush(active()?.id);if(!current())return;
    closeCharacterLife();closeModuleHelp();closeModuleAIControls();await immersion.exit();if(!current())return;
    selected.set(family(record.moduleId),id);if(!record.tabOpen){await request(id,'',{tabOpen:true},'PATCH');record.tabOpen=true;}
    if(!current())return;
    for(const panel of panels.values())conceal(panel);tabs();
    if(!stopped.has(id)){statusPanel.innerHTML='<p role="status">正在打开实例…</p>';statusPanel.hidden=false;}
    if(record.status==='stopped'){await request(id,'start',{});record.status='running';}
    if(!current())return;
    let panel=panels.get(id);
    try{if(!panel)panel=await makePanel(record);else await panel.ready;}catch(error){await discard(id);throw error;}
    if(!current()||panel.controller.signal.aborted)return;
    stopped.delete(id);statusPanel.hidden=true;move(container,panel.node);panel.node.hidden=false;panel.hooks?.cancelExit?.();tabs();window.dispatchEvent(new Event('resize'));
    panel.chromeController=new AbortController();
    const ctx=Object.create(panel.ctx);ctx.signal=AbortSignal.any([panel.controller.signal,panel.chromeController.signal]);
    const definition=panel.state.modules.find(item=>item.id===record.moduleId);
    mountModuleAIControl(panel.body,ctx,definition);mountModuleHelp(panel.body,ctx,definition);
  }
  async function remount(id){if(!panels.has(id))return;await discard(id);const record=records.find(item=>item.id===id);if(record){if(active()?.id===id)await activate(id);else await makePanel(record);}}
  async function show(definition,{preferredModuleId,target}={}){
    const {instanceId:preferredInstanceId,...viewTarget}=target||{};
    target=Object.keys(viewTarget).length?viewTarget:null;
    const version=++generation,current=()=>version===generation;
    module=definition;await list();if(!current())return;container.hidden=false;
    if(!records.some(record=>belongs(record))){
      const familyId=family(definition.id);
      if(!pendingCreates.has(familyId))pendingCreates.set(familyId,api('/api/instances',{method:'POST',body:{moduleId:defaultInstanceModule(getModules(),definition.id)},timeoutMs:60000}));
      const pending=pendingCreates.get(familyId);let instance;
      try{({instance}=await pending);}finally{if(pendingCreates.get(familyId)===pending)pendingCreates.delete(familyId);}
      if(!current())return;if(!records.some(record=>record.id===instance.id))records.push(instance);selected.set(familyId,instance.id);
    }
    const preferred=preferredInstanceId?records.find(record=>record.id===preferredInstanceId&&belongs(record)):preferredModuleId&&records.find(record=>record.moduleId===preferredModuleId);
    if(preferredInstanceId&&!preferred)throw new Error('关联实例已不存在，请从来源模块重新打开。');
    const record=preferred||(active()?.tabOpen?active():records.find(record=>belongs(record)&&record.tabOpen))||(target?records.find(record=>belongs(record)):null);
    if(record){
      if(target){
        await discard(record.id);
        if(!current())return;
        const data=viewData.get(record.id)||{ui:{moduleTabs:{}},drafts:new Drafts()};data.ui.moduleTarget=target;viewData.set(record.id,data);
      }
      if(stopped.has(record.id)&&record.status==='stopped'){selected.set(family(record.moduleId),record.id);showStopped(record);tabs();return;}
      return activate(record.id,{version});
    }
    for(const panel of panels.values())conceal(panel);statusPanel.hidden=true;tabs();
  }
  function dialog(title){const box=document.createElement('dialog');box.className='instance-dialog';box.innerHTML=`<form method="dialog"><div class="panel-heading"><h2>${e(title)}</h2><button type="submit" class="icon-button" aria-label="关闭">${icon('close')}</button></div></form><div data-dialog-content></div><p class="form-feedback" role="status"></p>`;document.body.append(box);box.addEventListener('close',()=>box.remove(),{once:true});box.showModal();return box;}
  async function personaDialog(panel,{signal}={}){
    if(panel.controller.signal.aborted||signal?.aborted)return;
    const box=dialog('导入到 '+panel.record.name),content=box.querySelector('[data-dialog-content]'),feedback=box.querySelector('[role="status"]');
    const lifetime=new AbortController();
    box.addEventListener('close',()=>lifetime.abort(),{once:true});
    for(const owner of [panel.controller.signal,signal])owner?.addEventListener('abort',()=>box.close(),{once:true,signal:lifetime.signal});
    try{
      const library=await api('/api/state');await list();
      if(lifetime.signal.aborted)return;
      content.innerHTML=`<div class="instance-import-file"><button type="button" class="button primary" data-import-file>${icon('upload')}选择人设文件</button><input type="file" accept=".json,.png" hidden><span>JSON / PNG</span></div><div class="field"><label for="instance-library">从角色资料复制</label><select id="instance-library"><option value="">选择角色</option>${library.characters.map(character=>`<option value="${e(character.id)}">${e(character.name)}</option>`).join('')}</select><button type="button" class="button" data-copy-library>导入这份人设</button></div><div class="field"><label for="instance-source">从其他实例复制</label><select id="instance-source"><option value="">选择实例</option>${records.filter(record=>record.id!==panel.record.id&&record.personaId).map(record=>`<option value="${record.id}">${e(record.name)}</option>`).join('')}</select><button type="button" class="button" data-copy-instance>复制人设</button></div><p class="life-note">只复制人设与规则。账号、聊天记录、记忆和当前关系进展留在原实例。</p>`;
      const submit=async(button,value)=>{button.disabled=true;feedback.textContent='正在导入…';try{await request(panel.record.id,'persona',value);if(panels.get(panel.record.id)===panel)await remount(panel.record.id);box.close();notify('人设已导入当前实例。');}catch(error){if(!lifetime.signal.aborted)feedback.textContent=error.message;}finally{button.disabled=false;}};
      content.querySelector('[data-copy-library]').onclick=event=>{const id=content.querySelector('#instance-library').value;if(!id){feedback.textContent='先选择一份人设。';return;}void submit(event.currentTarget,{source:'library',characterId:id});};
      content.querySelector('[data-copy-instance]').onclick=event=>{const id=content.querySelector('#instance-source').value;if(!id){feedback.textContent='先选择一个实例。';return;}void submit(event.currentTarget,{source:'instance',sourceInstanceId:id});};
      const input=content.querySelector('input[type="file"]'),button=content.querySelector('[data-import-file]');button.onclick=()=>input.click();input.onchange=async()=>{const file=input.files[0];if(!file)return;try{if(file.size>8*1024*1024)throw new Error('人设文件超过 8 MiB。');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));await submit(button,{source:'file',name:file.name,base64:btoa(binary)});}catch(error){feedback.textContent=error.message;}finally{input.value='';}};
    }catch(error){feedback.textContent=error.message;}
  }
  async function manage(){
    const box=dialog('管理 '+module.name),content=box.querySelector('[data-dialog-content]'),feedback=box.querySelector('[role="status"]'),moduleId=module.id;
    const draw=async()=>{await list();content.innerHTML=records.filter(record=>belongs(record,moduleId)).map(record=>`<div class="instance-manage-row" data-record="${record.id}"><label><span class="sr-only">实例名称</span><input value="${e(record.name)}" maxlength="120"></label><span>${record.status==='running'?'已打开':'已停止'}${moduleVariants(getModules(),moduleId).length?' · '+(getModules().find(item=>item.id===record.moduleId)?.variant==='lite'?'精简版':'完整版'):''}</span><button type="button" class="button small" data-rename>改名</button><button type="button" class="button small" data-open>打开</button><button type="button" class="button small" data-stop ${record.status==='stopped'?'disabled':''}>停止</button><button type="button" class="button ghost small" data-delete>移除</button></div>`).join('');};
    content.onclick=async event=>{const button=event.target.closest('button'),row=button?.closest('[data-record]');if(!row)return;const id=row.dataset.record;button.disabled=true;try{
      if(button.hasAttribute('data-rename'))await request(id,'',{name:row.querySelector('input').value},'PATCH');
      if(button.hasAttribute('data-open')){box.close();await activate(id);return;}
      if(button.hasAttribute('data-stop')){await flush(id);await request(id,'stop',{});await discard(id);stopped.add(id);}
      if(button.hasAttribute('data-delete')){if(!row.querySelector('[data-confirm-remove]')){row.insertAdjacentHTML('beforeend','<div data-confirm-remove role="alert"><p>将停止并移除这个实例。资料会归档保留，界面不再显示；关闭标签请使用标签上的关闭按钮。</p><button type="button" class="button" data-delete-confirm>确认移除</button></div>');return;}}
      if(button.hasAttribute('data-delete-confirm')){await flush(id);await request(id,'',undefined,'DELETE');await discard(id);if(active()?.id===id)selected.delete(moduleId);}
      await draw();tabs();if(active()?.id===id&&stopped.has(id))showStopped(active());
    }catch(error){feedback.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}};
    await draw();
  }
  const allHooks=async name=>{for(const panel of panels.values())await panel.hooks?.[name]?.();};
  window.__workbenchFlushDrafts=()=>allHooks('flush');
  window.__workbenchPrepareExit=async()=>{document.body.inert=true;try{await allHooks('prepareExit');}catch(error){window.__workbenchCancelExit();throw error;}};
  window.__workbenchCancelExit=()=>{document.body.inert=false;for(const panel of panels.values())panel.hooks?.cancelExit?.();};
  return {show,hide,active,remount,flush:()=>allHooks('flush'),async stopModule(id){for(const record of records.filter(record=>belongs(record,id))){await flush(record.id);await request(record.id,'stop',{});await discard(record.id);}},get panels(){return panels;}};
}
