import {escape as e,icon,help,moduleIcon} from './components.js';

export const storageBytes=value=>Number.isFinite(value)?value>=1024**3?(value/1024**3).toFixed(2)+' GiB':value>=1024**2?(value/1024**2).toFixed(1)+' MiB':value>=1024?(value/1024).toFixed(1)+' KiB':value+' B':'未统计';
const stages={preparing:'准备安装',downloading:'正在下载',verifying:'正在校验',extracting:'正在解包',completed:'安装完成'};
const statuses={failed:'安装失败',cancelled:'已取消',interrupted:'上次安装已中断'};
const request=ctx=>(path,body)=>(ctx.libraryApi||ctx.api)(path,{...(body===undefined?{}:{method:'POST',body}),signal:ctx.signal,timeoutMs:300000});
function style(){
  if(document.querySelector('link[data-component-storage-style]'))return;
  const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./component-storage.css',import.meta.url).href;link.dataset.componentStorageStyle='';document.head.append(link);
}
const button=(action,label,id='',extra='')=>`<button type="button" class="button small" data-component-action="${action}" data-component-id="${e(id)}" ${extra}>${label}</button>`;

/** A shared panel uses the root API even when opened inside an instance. */
export function mountComponentPackages(root,ctx,{id,onState=()=>{},storage=false}={}){
  style();root.classList.add('component-storage');
  root.innerHTML=`<div class="panel-heading"><h2>${storage?'组件与存储':'运行组件'}</h2><div class="component-actions">${button('refresh','刷新')}${id&&ctx.disableModule?button('remove-entry','移除入口',id,'hidden'):''}</div></div><div data-component-list aria-live="polite"></div>
    ${storage?'<div data-resource-list></div>':''}
    <div data-storage-confirm hidden role="group" aria-label="确认释放空间"></div><p class="form-feedback" data-component-feedback role="status"></p>
    <details class="component-source"><summary>组件下载源</summary><form data-component-source><label>下载地址<input name="url" type="url" aria-label="组件下载地址" placeholder="https://…/components/" autocomplete="off"></label><button class="button small" type="submit">保存地址</button></form></details>`;
  const api=request(ctx),list=root.querySelector('[data-component-list]'),feedback=root.querySelector('[data-component-feedback]'),confirmation=root.querySelector('[data-storage-confirm]');
  const source=root.querySelector('[data-component-source]');
  let busy=false,loading=false,sourceInitialized=false,timer,signature='',resourceSignature='',current,plan;
  source.elements.url.addEventListener('input',()=>{sourceInitialized=true;},{signal:ctx.signal});
  const message=(text,error=false)=>{if(!ctx.signal.aborted){feedback.textContent=text;feedback.className='form-feedback'+(error?' error':'');}};
  const controls=()=>{root.querySelectorAll('button').forEach(node=>node.disabled=busy||node.dataset.unavailable==='true');};
  function draw(state){
    const items=state.components.filter(item=>!id||item.id===id),next=JSON.stringify([items,state.canChooseFile]);
    const remove=root.querySelector('[data-component-action="remove-entry"]');if(remove)remove.hidden=!!items[0]?.ready;
    if(next===signature)return;signature=next;
    const focused=document.activeElement?.closest('[data-component-action]'),focusKey=focused&&root.contains(focused)?[focused.dataset.componentAction,focused.dataset.componentId]:null;
    list.innerHTML=items.map(item=>{
      const running=item.task?.status==='running',status=running?(stages[item.task.stage]||'正在安装'):item.canResumeUninstall?'卸载未完成':item.ready?(item.origin==='existing'?'复用已有环境':'已安装'):'尚未安装';
      const details=item.ready||item.canResumeUninstall?item.version:item.descriptor?`下载 ${storageBytes(item.descriptor.bytes)} · 安装后 ${storageBytes(item.descriptor.installedBytes)}`:'当前发行版没有组件包';
      const unavailable=!item.canInstall?'disabled data-unavailable="true"':'';
      const locked=item.users.length?'disabled data-unavailable="true"':'',update=item.managed&&item.canInstall&&item.version!==item.descriptor.version;
      const upgrades=update?button('install','更新组件',item.id,locked)+(state.canChooseFile?button('import','导入更新包',item.id,locked):''):'';
      const actions=running?button('cancel','取消安装',item.id):item.canResumeUninstall?button('uninstall','继续卸载',item.id,locked):!item.ready?button('install',icon('download')+'安装组件',item.id,unavailable)+(state.canChooseFile?button('import','导入本机包',item.id,unavailable):''):upgrades+(item.managed&&storage?button('uninstall','卸载组件',item.id,locked):'');
      const progress=running?`<div class="component-progress"><progress aria-label="${e(item.name)}安装进度" max="${item.task.totalBytes||1}" value="${Math.min(item.task.completedBytes||0,item.task.totalBytes||1)}"></progress><span>${storageBytes(item.task.completedBytes||0)} / ${storageBytes(item.task.totalBytes||0)}</span></div>`:'';
      const error=item.task?.error?`<p class="form-feedback error">${e(item.task.error)}</p>`:!item.ready&&statuses[item.task?.status]?`<p class="form-feedback">${statuses[item.task.status]}</p>`:'';
      return `<article class="component-row" data-component-row="${e(item.id)}"><div class="component-description"><div class="heading-title"><h3>${e(item.name)}</h3><span class="component-status">${status}</span>${item.path?help(item.path,'组件位置'):''}</div><small>${e(details||'')}${item.users.length?' · 正在使用':''}</small>${progress}${error}</div><div class="component-actions">${actions}</div></article>`;
    }).join('');
    controls();if(focusKey)list.querySelector(`[data-component-action="${focusKey[0]}"][data-component-id="${focusKey[1]}"]`)?.focus();
  }
  async function refreshResources(){
    if(!storage)return;
    const [components,resources]=await Promise.all([api('/api/component-packages/storage'),api('/api/storage')]);if(ctx.signal.aborted)return;
    const next=JSON.stringify([components,resources]);if(next===resourceSignature)return;resourceSignature=next;
    const target=root.querySelector('[data-resource-list]');
    target.innerHTML=`<div class="component-row"><div class="component-description"><h3>组件缓存</h3><small>${storageBytes(components.cacheBytes)}</small></div>${button('cleanup','清理缓存','cache',components.cacheBytes?'':'disabled data-unavailable="true"')}</div>`+
      [...resources.resources,...resources.caches].map(item=>`<article class="component-row"><div class="component-description"><div class="heading-title"><h3>${e(item.name)}</h3>${help([item.path,item.reason].filter(Boolean).join('\n'),'资源位置与状态')}</div><small>${storageBytes(item.bytes)} · ${item.managed?(item.active?'正在使用':'工作台管理'):'复用已有环境'}</small></div><div class="component-actions">${item.actions.map(action=>`<button type="button" class="button small" data-resource-action="${action}" data-resource-id="${e(item.id)}">${action==='cleanup'?'清理缓存':'卸载资源'}</button>`).join('')}</div></article>`).join('');
    controls();
  }
  async function refresh({resources=false}={}){
    if(loading||ctx.signal.aborted)return;loading=true;
    try{
      current=await api('/api/component-packages');if(ctx.signal.aborted)return;draw(current);
      if(!sourceInitialized){source.elements.url.value=current.url;sourceInitialized=true;}
      onState(current.components.find(item=>item.id===id),current);
      if(resources)await refreshResources();
    }catch(error){message(error.message,true);}finally{loading=false;}
  }
  async function run(job){
    if(busy||ctx.signal.aborted)return;busy=true;controls();message('正在处理…');
    const previousPlan=plan;
    try{await job();}catch(error){message(error.message,true);}finally{busy=false;if(!ctx.signal.aborted){controls();if(plan&&plan!==previousPlan)confirmation.querySelector('[data-component-action="dismiss"]')?.focus();await refresh({resources:storage});}}
  }
  async function propose(prefix,id,action){
    message('正在核对资源与占用空间…');const value=await api(prefix+'/plan',{id,action});if(ctx.signal.aborted)return;
    plan={...value,prefix};confirmation.hidden=false;
    confirmation.innerHTML=`<p>${e(value.consequence)}</p><strong>预计释放 ${storageBytes(value.bytes)}</strong><div class="component-actions">${button('dismiss','保留')}${button('confirm','确认'+(action==='uninstall'?'卸载':'清理'))}</div>`;
    message('');controls();confirmation.querySelector('[data-component-action="dismiss"]').focus();
  }
  root.addEventListener('click',event=>{
    const resource=event.target.closest('[data-resource-action]');if(resource){void run(()=>propose('/api/storage',resource.dataset.resourceId,resource.dataset.resourceAction));return;}
    const target=event.target.closest('[data-component-action]');if(!target||target.disabled)return;
    const {componentAction:action,componentId:targetId}=target.dataset;
    if(action==='dismiss'){plan=null;confirmation.hidden=true;return;}
    void run(async()=>{
      if(action==='refresh'){await refresh({resources:storage});message('已刷新');}
      else if(action==='remove-entry'){await ctx.disableModule(targetId);ctx.navigate?.('home');}
      else if(action==='uninstall'||action==='cleanup')await propose('/api/component-packages',targetId,action);
      else if(action==='confirm'&&plan){const confirmed=plan;await api(confirmed.prefix+'/execute',{planId:confirmed.planId,confirmed:true});plan=null;confirmation.hidden=true;message('已释放 '+storageBytes(confirmed.bytes));}
      else if(['install','import','cancel'].includes(action)){const result=await api('/api/component-packages/'+targetId+'/'+action,{});message(result.cancelled?'已取消选择':action==='cancel'?'安装已取消':result.reused?'已复用现有组件':'安装已开始');}
    });
  },{signal:ctx.signal});
  source.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{await api('/api/component-packages/source',{url:source.elements.url.value.trim()});message('下载源已保存');});},{signal:ctx.signal});
  const ready=refresh({resources:storage});
  const poll=()=>{timer=setTimeout(async()=>{if(root.isConnected&&!document.hidden&&!root.closest('[hidden]'))await refresh();if(!ctx.signal.aborted)poll();},current?.components.some(item=>item.task?.status==='running')?800:4000);};poll();
  ctx.signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
  return {refresh,ready};
}

export function mountComponentModule(root,ctx,id,mount){
  const panel=document.createElement('section');panel.className='panel glass';
  const heading=document.createElement('div');heading.className='module-heading';
  heading.innerHTML=`${moduleIcon(id,'large')}<div class="heading-title"><h1>${e(ctx.state?.modules?.find(item=>item.id===id)?.name||id)}</h1></div>`;
  panel.dataset.componentInstallation=id;
  const content=document.createElement('div');root.replaceChildren(heading,panel,content);let controller,lastReady;
  ctx.signal.addEventListener('abort',()=>controller?.abort(),{once:true});
  const controls=mountComponentPackages(panel,ctx,{id,onState:item=>{
    const ready=!!item?.ready,changed=lastReady!==undefined&&lastReady!==ready;lastReady=ready;
    if(changed&&ctx.rerender){void Promise.resolve(ctx.rerender()).catch(error=>ctx.notify?.(error.message,true));return;}
    if(ready){heading.remove();delete panel.dataset.componentInstallation;}
    else {if(heading.parentNode!==root)root.prepend(heading);panel.dataset.componentInstallation=id;}
    if(item?.ready&&!controller){
      controller=new AbortController();
      const child=Object.defineProperties({}, {...Object.getOwnPropertyDescriptors(ctx),signal:{value:controller.signal,writable:true,enumerable:true,configurable:true}});
      mount(content,child);
    }
    else if(!item?.ready&&controller){controller.abort();controller=null;content.replaceChildren();}
  }});
  return controls.ready.then(()=>controls);
}
