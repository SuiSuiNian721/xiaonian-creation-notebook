import {icon} from './components.js';
import {mountAISettings} from './ai-settings.js';

export function closeModuleAIControls(){
  document.querySelectorAll('[data-module-ai-popover]').forEach(panel=>{if(panel.matches(':popover-open'))panel.hidePopover();});
}

export function mountModuleAIControl(root,ctx,module){
  const heading=root.querySelector('.module-heading');if(!heading||ctx.signal.aborted)return;
  let actions=heading.querySelector('.module-header-actions');
  if(!actions){
    actions=document.createElement('div');actions.className='module-header-actions';
    const remove=heading.querySelector('.remove-control');if(remove)actions.append(remove);heading.append(actions);
  }
  const button=document.createElement('button');button.type='button';button.className='button small module-ai-control';
  button.dataset.moduleAiControl=module.id;button.innerHTML=icon('settings')+'AI 接入';
  button.setAttribute('aria-label',module.name+' AI 接入');button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
  const panel=document.createElement('section');panel.id='module-ai-popover-'+module.id+(ctx.instanceId?'-'+ctx.instanceId:'');panel.className='panel glass ai-connection-popover';
  panel.setAttribute('popover','auto');panel.setAttribute('role','dialog');panel.setAttribute('aria-label',module.name+' AI 接入');panel.dataset.moduleAiPopover=module.id;
  panel.innerHTML=`<div class="ai-popover-bar"><button type="button" class="icon-button" data-ai-close aria-label="关闭 AI 接入">${icon('close')}</button></div><div data-ai-editor></div>`;
  button.setAttribute('popovertarget',panel.id);button.setAttribute('aria-controls',panel.id);
  const persona=actions.querySelector('[data-module-persona]');if(persona)persona.after(button);else actions.prepend(button);heading.append(panel);
  let editing;
  const position=()=>{
    if(!panel.matches(':popover-open'))return;
    const anchor=button.getBoundingClientRect(),width=panel.getBoundingClientRect().width;
    const top=Math.min(anchor.bottom+8,Math.max(12,innerHeight-180));
    panel.style.top=top+'px';panel.style.left=Math.max(12,Math.min(anchor.right-width,innerWidth-width-12))+'px';panel.style.maxHeight=Math.max(120,innerHeight-top-12)+'px';
  };
  panel.addEventListener('toggle',async event=>{
    const open=event.newState==='open';button.setAttribute('aria-expanded',String(open));editing?.abort();
    if(!open){panel.querySelector('[data-ai-editor]').replaceChildren();return;}
    editing=new AbortController();const signal=editing.signal;position();
    // Instance controls inherit their API and drafts; retain that context while scoping the editor lifetime.
    const editorContext=Object.create(ctx);editorContext.signal=signal;
    await mountAISettings(panel.querySelector('[data-ai-editor]'),editorContext,{moduleId:!ctx.instanceId&&module.id.startsWith('character-')?null:module.id});
    if(!signal.aborted&&panel.matches(':popover-open')){position();panel.querySelector('select')?.focus();}
  },{signal:ctx.signal});
  panel.querySelector('[data-ai-close]').addEventListener('click',()=>{panel.hidePopover();button.focus();},{signal:ctx.signal});
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();panel.hidePopover();button.focus({preventScroll:true});}},{signal:ctx.signal});
  window.addEventListener('resize',position,{signal:ctx.signal});document.addEventListener('scroll',position,{signal:ctx.signal,capture:true,passive:true});
  ctx.signal.addEventListener('abort',()=>{editing?.abort();if(panel.matches(':popover-open'))panel.hidePopover();panel.remove();button.remove();},{once:true});
}
