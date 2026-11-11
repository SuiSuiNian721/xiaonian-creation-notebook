import {escape as e,icon} from '../components.js';
import {openCharacterLife} from '../character-life.js';
import {packageHeading,mountPackageInstallation} from './optional-package.js';

export async function mount(root,ctx){
  const installation=await ctx.api('/api/modules/companion-lite/resources');
  if(ctx.signal.aborted)return;
  if(!installation.prerequisitesReady)return mountPackageInstallation(root,ctx,'companion-lite');
  let state=await ctx.api('/api/modules/companion-lite/state'),sending=false;
  if(ctx.signal.aborted)return;
  const character=ctx.characters.getSelected(),draftKey='companion-lite:message:'+(character?.id||'none');
  packageHeading(root,ctx,'companion-lite');
  root.insertAdjacentHTML('beforeend',`<div class="companion-toolbar"><h2>${e(character?.name||'尚未导入人设')}</h2><div class="companion-actions"><button type="button" class="button small" data-lite-life data-module-persona>${icon('person')}人设与记忆</button><button type="button" class="button small" data-lite-immerse>${icon('expand')}沉浸模式</button></div></div><section class="panel glass lite-chat" aria-label="陪伴聊天"><div class="lite-messages" data-lite-messages role="log" aria-label="对话记录" aria-live="polite"></div><form data-lite-form><label class="sr-only" for="lite-message">想说的话</label><textarea id="lite-message" name="message" rows="3" maxlength="12000" placeholder="想说些什么…" ${character?'':'disabled'}>${e(ctx.drafts.read(draftKey,{text:''}).text)}</textarea><div class="form-actions"><p class="form-feedback" data-lite-feedback role="status"></p><button type="submit" class="button primary" data-lite-send ${character?'':'disabled'}>发送 ${icon('arrow')}</button></div></form></section>`);
  const input=root.querySelector('#lite-message'),feedback=root.querySelector('[data-lite-feedback]'),send=root.querySelector('[data-lite-send]');
  function voiceUrl(action){
    if(action?.type!=='record'||typeof action.url!=='string')return '';
    try{
      const url=new URL(action.url,location.origin),prefix=ctx.instanceId?'/instances/'+ctx.instanceId:'';
      if(url.origin!==location.origin||(action.url!==url.pathname&&action.url!==url.origin+url.pathname)||!url.pathname.startsWith(prefix+'/')||!/^\/internal\/voice-audio\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(url.pathname.slice(prefix.length)))return '';
      return url.pathname;
    }catch{return '';}
  }
  function imageUrl(action){
    if(action?.type!=='image'||typeof action.url!=='string')return '';
    try{
      const url=new URL(action.url,location.origin),prefix=ctx.instanceId?'/instances/'+ctx.instanceId:'';
      if(url.origin!==location.origin||(action.url!==url.pathname&&action.url!==url.origin+url.pathname)||!url.pathname.startsWith(prefix+'/')||!/^\/api\/modules\/companion-lite\/images\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[0-7]$/.test(url.pathname.slice(prefix.length)))return '';
      return url.pathname;
    }catch{return '';}
  }
  function draw(keepScroll=false){
    const log=root.querySelector('[data-lite-messages]'),scrollTop=log.scrollTop;
    root.querySelector('[data-lite-messages]').innerHTML=(state.messages||[]).map(message=>{
      const user=message.role==='user',name=(user?state.userProfile?.displayName:state.character?.name)?.trim()||(user?'我':character?.name||'角色'),avatar=user?state.userProfile?.avatar:state.character?.avatar;
      const safeAvatar=typeof avatar==='string'&&/^data:image\/(?:png|jpeg|webp);base64,/.test(avatar)?avatar:'';
      const voices=(message.actions||[]).map(voiceUrl).filter(Boolean);
      const images=(message.actions||[]).flatMap(action=>{const url=imageUrl(action);return url?[`<figure class="lite-message-media"><img class="lite-message-image" src="${e(url)}" alt="${e(action.name||'角色图片')}" loading="lazy" referrerpolicy="no-referrer"><div class="lite-image-error" hidden><span role="status">图片加载失败</span><button type="button" class="button small" data-lite-image-retry aria-label="重新加载${e(action.name||'角色图片')}">重试</button></div></figure>`]:[];});
      const content=message.content??message.text??'';
      return `<article class="lite-message ${user?'from-user':'from-character'}"><div class="lite-message-heading"><span class="lite-avatar" aria-hidden="true">${safeAvatar?`<img src="${e(safeAvatar)}" alt="">`:e(Array.from(name).slice(0,2).join(''))}</span><strong>${e(name)}</strong></div>${content?`<p>${e(content)}</p>`:''}${images.join('')}${voices.map(url=>`<audio controls preload="none" src="${e(url)}" aria-label="角色语音"></audio>`).join('')}</article>`;
    }).join('')||`<div class="quiet-empty"><p>${character?'暂无对话':'在人设与记忆中导入人设'}</p></div>`;
    for(const image of root.querySelectorAll('.lite-avatar img'))image.addEventListener('error',()=>{image.parentElement.textContent=Array.from(image.closest('.lite-message-heading').querySelector('strong').textContent).slice(0,2).join('');},{once:true});
    for(const image of root.querySelectorAll('.lite-message-image')){
      const error=image.parentElement.querySelector('.lite-image-error'),retry=error.querySelector('button');
      image.addEventListener('error',()=>{image.hidden=true;error.hidden=false;retry.disabled=false;});
      image.addEventListener('load',()=>{image.hidden=false;error.hidden=true;retry.disabled=false;});
      retry.addEventListener('click',()=>{retry.disabled=true;image.src=image.getAttribute('src');},{signal:ctx.signal});
    }
    log.scrollTop=keepScroll?scrollTop:log.scrollHeight;
  }
  const saveDraft=()=>ctx.drafts.write(draftKey,{text:input.value});
  input.addEventListener('input',saveDraft,{signal:ctx.signal});
  window.addEventListener('workbench:user-profile-changed',event=>{state.userProfile=event.detail;draw(true);},{signal:ctx.signal});
  window.addEventListener('workbench:character-avatar-changed',event=>{if(event.detail?.character?.id===character?.id){state.character=event.detail.character;draw(true);}},{signal:ctx.signal});
  root.querySelector('[data-lite-life]').addEventListener('click',event=>openCharacterLife(ctx,{moduleId:'companion-lite',conversationId:state.conversationId||'default',trigger:event.currentTarget}),{signal:ctx.signal});
  root.querySelector('[data-lite-immerse]').addEventListener('click',()=>void ctx.immersion.enter('companion-lite'),{signal:ctx.signal});
  root.querySelector('[data-lite-form]').addEventListener('submit',async event=>{
    event.preventDefault();if(sending||!input.value.trim()||!character)return;
    sending=true;send.disabled=true;input.disabled=true;feedback.className='form-feedback';feedback.textContent='正在回复…';
    const text=input.value;saveDraft();
    try{
      const result=await ctx.api('/api/modules/companion-lite/chat',{method:'POST',body:{text,...(state.conversationId?{conversationId:state.conversationId}:{})},timeoutMs:950000,signal:ctx.signal});
      if(ctx.signal.aborted)return;
      state={...state,...result};input.value='';ctx.drafts.commit(draftKey,{text});feedback.textContent=result.observationError||'';draw();
    }catch(error){if(!ctx.signal.aborted){feedback.className='form-feedback error';feedback.textContent=error.message;}}
    finally{sending=false;if(!ctx.signal.aborted){send.disabled=false;input.disabled=false;input.focus();}}
  },{signal:ctx.signal});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();root.querySelector('[data-lite-form]').requestSubmit();}},{signal:ctx.signal});
  draw();
  ctx.signal.addEventListener('abort',()=>{for(const audio of root.querySelectorAll('audio'))audio.pause();},{once:true});
}
