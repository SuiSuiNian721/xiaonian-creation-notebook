import { moduleIcon, help, eventList } from './components.js';
import { mountRuntime } from './drawing-runtime-view.js';
import { mountManager } from './drawing-manager-view.js';
import { mountConnection } from './drawing-connection-view.js';

const tabs=[['runtime','启动'],['resources','模型与插件'],['snapshots','快照'],['config','环境配置'],['records','记录']];

export function consumeComfyTarget(ui) {
  const target=ui.moduleTarget;
  delete ui.moduleTarget;
  return target && tabs.some(([id])=>id===target.tab) ? target : null;
}

export function mount(root,ctx) {
  let resourceTarget=consumeComfyTarget(ctx.ui);
  let tab=resourceTarget?.tab || (tabs.some(([id])=>id===ctx.ui.moduleTabs.comfyui)?ctx.ui.moduleTabs.comfyui:'runtime'),controller,generation=0;
  ctx.ui.moduleTabs.comfyui=tab;
  root.innerHTML=`<div class="module-heading">${moduleIcon('comfyui','large')}<div class="heading-title"><h1>ComfyUI 启动器</h1>${help('管理已有 ComfyUI 的启动参数和环境。工作流、MCP 与作品位于角色绘图；两边共用同一环境配置。','启动器说明')}</div><div class="remove-control"><button class="button ghost small" id="remove-module" type="button">移除入口</button><small>保留环境与配置</small></div></div><div class="module-tabs comfyui-tabs" role="tablist" aria-label="启动器页面">${tabs.map(([id,label])=>`<button id="tab-${id}" type="button" role="tab" data-tab="${id}" aria-controls="module-panel">${label}</button>`).join('')}</div><section id="module-panel" role="tabpanel"></section>`;
  const find=selector=>root.querySelector(selector);
  async function draw() {
    controller?.abort();controller=new AbortController();const signal=controller.signal,mine=++generation;
    root.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    find('#module-panel').setAttribute('aria-labelledby','tab-'+tab);
    try {
      if (tab==='runtime') await mountRuntime(find('#module-panel'),{...ctx,signal,openResources:target=>{resourceTarget={tab:'resources',...target};return selectTab('resources');}});
      else if (tab==='resources'||tab==='snapshots') {const target=resourceTarget;resourceTarget=null;await mountManager(find('#module-panel'),{...ctx,signal,openConfiguration:()=>selectTab('config')},tab==='snapshots',target);}
      else if (tab==='config') mountConnection(find('#module-panel'),{...ctx,signal},{launcher:true});
      else find('#module-panel').innerHTML=`<section class="panel glass"><h2>运行记录</h2>${eventList(ctx.state.events.filter(event=>['drawing','comfyui'].includes(event.moduleId)),ctx.state.modules)}</section>`;
    } catch(error) { if (!signal.aborted&&mine===generation) ctx.notify(error.message,true); }
  }
  function selectTab(next) { if (next===tab) return;tab=next;ctx.ui.moduleTabs.comfyui=next;return draw(); }
  root.querySelectorAll('[data-tab]').forEach(button=>{
    button.onclick=()=>selectTab(button.dataset.tab);
    button.onkeydown=event=>{let index=tabs.findIndex(([id])=>id===tab);if(event.key==='ArrowRight')index=(index+1)%tabs.length;else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;event.preventDefault();void selectTab(tabs[index][0]);root.querySelector(`[data-tab="${tabs[index][0]}"]`).focus();};
  });
  find('#remove-module').onclick=event=>ctx.action(event.currentTarget,async()=>{await ctx.disableModule('comfyui');ctx.navigate('home');});
  ctx.signal.addEventListener('abort',()=>{generation++;controller?.abort();},{once:true});
  return draw();
}
