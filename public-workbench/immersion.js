import {icon} from './components.js';

export function createImmersion({getModule,notify}){
  const desktop=window.workbenchWindow;
  const toolbar=document.createElement('header');toolbar.id='immersion-toolbar';toolbar.hidden=true;toolbar.setAttribute('aria-label','沉浸模式操作');
  toolbar.innerHTML=`<button type="button" class="button ghost small" id="immersion-exit" aria-keyshortcuts="Escape">${icon('back')}返回工作台</button><button type="button" class="button ghost small" id="immersion-fullscreen" aria-keyshortcuts="F11">${icon('expand')}全屏</button>`;
  document.body.append(toolbar);
  let mode={active:false,moduleId:null,fullscreen:false},opener;
  const apply=value=>{
    const entering=!mode.active&&value.active,leaving=mode.active&&!value.active;
    if(entering)opener=document.activeElement;
    mode=value;
    if(mode.active)document.documentElement.dataset.immersive=mode.moduleId;
    else delete document.documentElement.dataset.immersive;
    toolbar.hidden=!mode.active;
    toolbar.querySelector('#immersion-fullscreen').innerHTML=icon('expand')+(mode.fullscreen?'退出全屏':'全屏');
    if(leaving&&opener?.isConnected)opener.focus({preventScroll:true});
    window.dispatchEvent(new Event('resize'));
  };
  const update=async value=>{
    try{
      if(desktop){apply(await desktop.setImmersive(value));return true;}
      if(value.active&&value.fullscreen===true&&!document.fullscreenElement)await document.documentElement.requestFullscreen();
      else if((!value.active||value.fullscreen===false)&&document.fullscreenElement)await document.exitFullscreen();
      apply({active:value.active,moduleId:value.active?value.moduleId:null,fullscreen:!!document.fullscreenElement});return true;
    }catch(error){notify(error.message,true);return false;}
  };
  const enter=moduleId=>update({active:true,moduleId});
  const exit=()=>update({active:false});
  const fullscreen=()=>update({active:true,moduleId:mode.moduleId||getModule(),fullscreen:!mode.fullscreen});
  toolbar.querySelector('#immersion-exit').addEventListener('click',exit);
  toolbar.querySelector('#immersion-fullscreen').addEventListener('click',fullscreen);
  const handleKey=event=>{
    if(desktop||event.repeat||event.isComposing||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||!['companion','companion-lite','cards'].includes(getModule()))return;
    if(event.key==='F11'){event.preventDefault();void fullscreen();}
    else if(event.key==='Escape'&&mode.active){event.preventDefault();event.stopImmediatePropagation();void exit();}
  };
  document.addEventListener('keydown',handleKey,true);
  window.__workbenchImmersionKey=handleKey;
  if(desktop){desktop.onImmersiveChange(apply);void desktop.getImmersive().then(apply).catch(error=>notify(error.message,true));}
  else document.addEventListener('fullscreenchange',()=>{apply({...mode,fullscreen:!!document.fullscreenElement});});
  return {enter,exit,state:()=>({...mode}),routeChanged(moduleId){if(mode.active&&mode.moduleId!==moduleId)void exit();}};
}
