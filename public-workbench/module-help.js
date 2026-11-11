import {escape as e,icon} from './components.js';
import {moduleGuides} from './module-guides.js';
import {closeModuleAIControls} from './module-ai-control.js';

// The server owns durable records. This also prevents repeated prompts if a save fails.
const seenThisSession=new Set();
let activeHelp;
export function closeModuleHelp(){activeHelp?.close(false);}
// The embedded card editor forwards keys without reloading its document.
window.__workbenchHelpKey=event=>activeHelp?.handleKey(event)===true;

export function mountModuleHelp(root,ctx,module){
  const baseGuide=moduleGuides[module.id],actions=root.querySelector('.module-header-actions');
  if(!baseGuide||!actions||ctx.signal.aborted)return;
  const componentInstallation=!!root.querySelector('[data-component-installation]');
  const installation=componentInstallation||!!root.querySelector('[data-package-installation]'),sessionKey=(ctx.instanceId||'library')+':'+module.id+(installation?':install':'');
  const guide=componentInstallation?{...baseGuide,steps:[
    {title:'先准备运行组件',body:'查看组件状态和安装大小。安装完成后会进入模块，安装本身不会启动任务。',targets:['[data-component-row]','[data-component-installation]']},
    {title:'安装组件',body:'从配置的来源安装，也可导入本机组件包。当前发行版没有组件包时，先配置可用的组件下载源。',targets:['[data-component-action="install"]','[data-component-action="import"]','[data-component-installation]']},
    {title:'配置下载来源',body:'需要更换下载源时展开这里，填写组件包目录地址并保存，再刷新组件状态。',targets:['.component-source summary']},
  ]}:installation?{...baseGuide,steps:[
    {title:'先准备组件',body:'查看清单中的来源、体积和公共依赖，再确认安装。安装不会调用 AI。',targets:['#resource-plan-preview','[data-package-installation]']},
    {title:'也可使用本地安装包',body:'可以保存组件包，或选择之前保存的本地包。安装时会核对版本和文件内容。',targets:['[data-package-import]']},
    {title:'安装好后继续',body:'完成安装后点击这里进入模块，接着介绍它的实际用法。',targets:['[data-package-continue]']},
  ]}:baseGuide;
  const button=document.createElement('button');
  button.type='button';button.className='button small module-help-control';button.dataset.moduleHelp=module.id;
  button.innerHTML=icon('info')+'使用说明';
  button.setAttribute('aria-label',module.name+'使用说明');button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
  actions.insertBefore(button,actions.querySelector('[data-module-ai-control]'));

  const manual=document.createElement('dialog');
  manual.className='module-manual';manual.dataset.moduleManual=module.id;manual.id='module-manual-'+module.id;
  manual.setAttribute('aria-labelledby',manual.id+'-title');button.setAttribute('aria-controls',manual.id);
  manual.innerHTML=`<header class="module-manual-header"><h2 id="${manual.id}-title">${e(guide.title)}使用说明</h2><button type="button" class="icon-button" data-manual-close aria-label="关闭使用说明">${icon('close')}</button></header><div class="module-manual-body"><ol>${guide.sections.map(section=>`<li><h3>${e(section.title)}</h3><p>${e(section.body)}</p></li>`).join('')}</ol></div><footer class="module-manual-footer"><button type="button" class="button primary" data-start-tour>${icon('play')}开始引导</button></footer>`;

  const tour=document.createElement('div');
  tour.className='module-tour';tour.dataset.moduleTour=module.id;tour.setAttribute('popover','manual');
  tour.innerHTML=`<div class="module-tour-spotlight" data-tour-spotlight aria-hidden="true" hidden></div><section class="module-tour-card" data-tour-card role="dialog" aria-labelledby="tour-title-${module.id}" aria-describedby="tour-body-${module.id}"><div class="module-tour-progress"><span data-tour-progress></span><button type="button" class="button ghost small" data-tour-skip>跳过</button></div><div aria-live="polite" aria-atomic="true"><h2 id="tour-title-${module.id}" data-tour-title></h2><p id="tour-body-${module.id}" data-tour-body></p></div><p class="module-tour-unavailable" data-tour-unavailable hidden>这个位置暂时未显示，可以先看下一步。</p><footer class="module-tour-footer"><button type="button" class="button small" data-tour-back>上一步</button><button type="button" class="button primary small" data-tour-next>下一步</button></footer></section>`;
  document.body.append(manual,tour);
  const find=selector=>tour.querySelector(selector),card=find('[data-tour-card]'),spot=find('[data-tour-spotlight]');
  let mode=null,index=0,frame=0,target,opener;
  const on=(node,name,handler,options={})=>node.addEventListener(name,handler,{...options,signal:ctx.signal});
  const visible=node=>node?.isConnected&&node.checkVisibility()&&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0;
  const resolveTarget=()=>{
    for(const selector of guide.steps[index].targets){
      // Card studio remains mounted while another module is open; ignore its hidden controls.
      const node=[...document.querySelectorAll(selector)].find(visible);
      if(node)return {node,selector};
    }
    return null;
  };
  function close(restore=true){
    const wasOpen=!!mode;mode=null;
    cancelAnimationFrame(frame);
    if(manual.open)manual.close();
    if(tour.matches(':popover-open'))tour.hidePopover();
    if(activeHelp===controller){activeHelp=undefined;delete document.documentElement.dataset.moduleHelpOpen;}
    button.setAttribute('aria-expanded','false');
    if(restore&&wasOpen){const focus=visible(opener)?opener:button;if(visible(focus))focus.focus({preventScroll:true});}
  }
  function handleKey(event){
    if(mode!=='tour'||event.key!=='Escape')return false;
    event.preventDefault();event.stopImmediatePropagation();close();return true;
  }
  const controller={close,handleKey};
  function activate(next){
    closeModuleHelp();closeModuleAIControls();
    opener=button;
    activeHelp=controller;mode=next;
    document.documentElement.dataset.moduleHelpOpen=next;
    button.setAttribute('aria-expanded','true');
  }
  function position(scroll=false){
    if(mode!=='tour'||ctx.signal.aborted)return;
    const result=resolveTarget(),nextTarget=result?.node,targetChanged=nextTarget!==target;
    target=nextTarget;
    // Async content can replace the loading placeholder after the step has opened.
    if((scroll||targetChanged)&&target)target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    const rect=target?.getBoundingClientRect(),gap=16,pad=16;
    const box=card.getBoundingClientRect(),width=box.width,height=box.height;
    let left=(innerWidth-width)/2,top=(innerHeight-height)/2;
    const anchor=rect&&{left:Math.max(4,rect.left-6),top:Math.max(4,rect.top-6),right:Math.min(innerWidth-4,rect.right+6),bottom:Math.min(innerHeight-4,rect.bottom+6)};
    const inView=anchor&&anchor.right>anchor.left&&anchor.bottom>anchor.top;
    spot.hidden=!inView;find('[data-tour-unavailable]').hidden=!!inView;
    if(inView){
      spot.dataset.target=result.selector;
      Object.assign(spot.style,{left:anchor.left+'px',top:anchor.top+'px',width:(anchor.right-anchor.left)+'px',height:(anchor.bottom-anchor.top)+'px'});
      const candidates=[
        {left:anchor.left,top:anchor.bottom+gap},
        {left:anchor.right-width,top:anchor.bottom+gap},
        {left:anchor.left,top:anchor.top-height-gap},
        {left:anchor.right-width,top:anchor.top-height-gap},
        {left:anchor.right+gap,top:anchor.top},
        {left:anchor.left-width-gap,top:anchor.top},
      ];
      const fit=candidates.find(candidate=>candidate.top>=pad&&candidate.top+height<=innerHeight-pad&&candidate.left>=pad&&candidate.left+width<=innerWidth-pad);
      const chosen=fit||candidates[anchor.bottom+height+gap<=innerHeight-pad?0:2];
      left=chosen.left;top=chosen.top;
    }else delete spot.dataset.target;
    card.style.left=Math.max(pad,Math.min(left,innerWidth-width-pad))+'px';
    card.style.top=Math.max(pad,Math.min(top,innerHeight-height-pad))+'px';
  }
  const layout=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>position());};
  function showStep(){
    const step=guide.steps[index];tour.dataset.step=String(index);
    find('[data-tour-progress]').textContent=`${index+1} / ${guide.steps.length}`;
    find('[data-tour-title]').textContent=step.title;find('[data-tour-body]').textContent=step.body;
    find('[data-tour-back]').disabled=index===0;
    find('[data-tour-next]').textContent=index===guide.steps.length-1?'完成':'下一步';
    position(true);find('[data-tour-next]').focus({preventScroll:true});
    const stepIndex=index;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{if(mode==='tour'&&index===stepIndex&&!ctx.signal.aborted)position(true);}));
  }
  function remember(){
    seenThisSession.add(sessionKey);
    if(installation)return;
    if(ctx.state.moduleGuides?.[module.id]===true)return;
    void ctx.api('/api/module-guides/'+module.id,{method:'POST',body:{}}).then(()=>{
      ctx.state.moduleGuides={...ctx.state.moduleGuides,[module.id]:true};
    }).catch(()=>ctx.notify('引导记录暂时没保存成功，重启后可能再次出现。',true));
  }
  function startTour(){
    if(ctx.signal.aborted||document.documentElement.dataset.immersive)return;
    close(false);activate('tour');index=0;tour.showPopover();showStep();remember();
  }
  on(button,'click',()=>{activate('manual');manual.showModal();manual.querySelector('[data-manual-close]').focus();});
  on(manual.querySelector('[data-manual-close]'),'click',()=>close());
  on(manual.querySelector('[data-start-tour]'),'click',startTour);
  on(manual,'cancel',event=>{event.preventDefault();close();});
  on(find('[data-tour-skip]'),'click',()=>close());
  on(find('[data-tour-back]'),'click',()=>{if(index>0){index--;showStep();}});
  on(find('[data-tour-next]'),'click',()=>{if(index<guide.steps.length-1){index++;showStep();}else close();});
  on(document,'keydown',handleKey,{capture:true});
  on(document,'toggle',event=>{
    if(mode==='tour'&&event.newState==='open'&&event.target.matches('[popover],dialog')&&event.target!==tour&&event.target!==manual)close(false);
  },{capture:true});
  on(window,'resize',layout);on(document,'scroll',layout,{capture:true,passive:true});
  const resize=new ResizeObserver(layout);resize.observe(root);resize.observe(card);
  const changes=new MutationObserver(()=>{
    if(document.documentElement.dataset.immersive){close(false);return;}
    if(mode==='tour')layout();
  });
  changes.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','aria-selected','class','style']});
  changes.observe(document.documentElement,{attributes:true,attributeFilter:['data-immersive']});
  ctx.signal.addEventListener('abort',()=>{close(false);resize.disconnect();changes.disconnect();button.remove();manual.remove();tour.remove();},{once:true});
  if((installation||ctx.state.moduleGuides?.[module.id]!==true)&&!seenThisSession.has(sessionKey))startTour();
}
