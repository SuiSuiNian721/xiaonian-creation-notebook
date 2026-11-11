// Serialized into the native renderer by the preload. Keep runtime dependencies
// inside this function; Vue continues to own messages, attachments and sessions.
function installCompanionChat(config){
  if(config.kind!=='chat')return;
  const query=selector=>document.querySelector(selector);
  const setText=(node,value)=>{if(node&&node.textContent!==value)node.textContent=value;};
  const attribute=(node,name,value)=>{if(node&&node.getAttribute(name)!==value)node.setAttribute(name,value);};
  const stores=()=>query('#app')?.__vue_app__?.config.globalProperties?.$pinia?._s;
  const subscribed=new WeakSet();
  const avatarSources=new WeakMap();
  let scheduled=false,composing=false,replayingClear=false;
  const schedule=()=>{if(!scheduled){scheduled=true;queueMicrotask(refresh);}};
  const buttonLabel=(button,label,visible=false)=>{
    if(!button)return;
    attribute(button,'title',label);attribute(button,'aria-label',label);
    if(visible&&!button.querySelector('[data-wb-button-label]')){
      const span=document.createElement('span');span.dataset.wbButtonLabel='';span.textContent=label;button.append(span);
    }
  };
  const iconButton=(label,icon)=>{
    const button=document.createElement('button');button.type='button';
    button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span></span>`;
    button.lastElementChild.textContent=label;return button;
  };
  function avatarFor(wrapper,name,source){
    let avatar=wrapper.querySelector(':scope > [data-wb-chat-avatar]');
    if(!avatar){avatar=document.createElement('span');avatar.dataset.wbChatAvatar='';avatar.setAttribute('aria-hidden','true');wrapper.prepend(avatar);}
    const initials=Array.from(name).slice(0,2).join('');
    const safeSource=typeof source==='string'&&/^data:image\/(?:png|jpeg|webp);base64,/.test(source)?source:'';
    if(avatarSources.get(avatar)!==safeSource){
      avatarSources.set(avatar,safeSource);avatar.replaceChildren();
      if(safeSource){
        const image=document.createElement('img');image.alt='';image.src=safeSource;
        image.addEventListener('error',()=>setText(avatar,initials),{once:true});avatar.append(image);
      }
    }
    if(!safeSource)setText(avatar,initials);
  }
  function confirmClear(button){
    const sessionId=stores()?.get('chat-session')?.activeSessionId;
    const dialog=document.createElement('dialog');dialog.className='wb-chat-confirm';
    dialog.setAttribute('aria-labelledby','wb-clear-title');dialog.setAttribute('aria-describedby','wb-clear-detail');
    dialog.innerHTML='<h2 id="wb-clear-title">清空这段对话？</h2><p id="wb-clear-detail">当前会话的全部消息将被删除，无法撤销。</p><form method="dialog"><button value="cancel" autofocus>取消</button><button value="clear" data-wb-confirm-clear>清空对话</button></form>';
    dialog.addEventListener('close',()=>{
      if(dialog.returnValue==='clear'&&sessionId===stores()?.get('chat-session')?.activeSessionId&&button.isConnected){
        replayingClear=true;try{button.click();}finally{replayingClear=false;}
      }
      dialog.remove();button.focus();
    },{once:true});
    document.body.append(dialog);dialog.showModal();
  }
  function send(){
    const input=query('[data-wb-chat-input]');
    if(!input||composing||query('[data-wb-chat-send]')?.disabled)return;
    const mode=(localStorage.getItem('ui/chat/settings/send-mode')||'enter').replace(/^"|"$/g,'');
    input.focus();
    const enter=()=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true,ctrlKey:mode==='ctrl-enter'}));
    enter();if(mode==='double-enter')enter();
    schedule();
  }
  function refresh(){
    scheduled=false;
    const shell=query('[data-testid="desktop-chat-page-shell"]');
    const composer=query('[data-testid="chat-composer-layer"]');
    const input=composer?.querySelector('textarea');
    if(!shell||!input){document.documentElement?.removeAttribute('data-wb-chat');return;}
    attribute(document.documentElement,'data-wb-chat','');
    if(config.styles&&!query('style[data-wb-chat-style]')){
      const style=document.createElement('style');style.dataset.wbChatStyle='';style.textContent=config.styles;document.head.append(style);
    }
    const state=stores(),session=state?.get('chat-session'),chat=state?.get('chat'),card=state?.get('airi-card');
    for(const store of [session,chat,card])if(store&&!subscribed.has(store)){subscribed.add(store);store.$subscribe(schedule,{detached:true});}
    const name=card?.activeCard?.name?.trim()||'虚拟陪伴';
    let mapping={};try{mapping=JSON.parse(localStorage.getItem('ai-future/workbench-character-cards')||'{}');}catch{}
    const character=config.character&&mapping[config.character.id]===card?.activeCardId?config.character:null;
    const userName=config.userProfile?.displayName?.trim()||'我';
    const busy=!!chat?.sending&&chat.activeSendSessionId===session?.activeSessionId;
    const hasMessages=!!session?.messages?.some(message=>message.role!=='system');
    const titleBar=shell.querySelector('[fixed][top="0"][drag-region]');
    if(titleBar){
      attribute(titleBar,'data-wb-chat-header','');
      let heading=titleBar.querySelector('[data-wb-chat-heading]');
      if(!heading){heading=document.createElement('h1');heading.dataset.wbChatHeading='';titleBar.prepend(heading);}
      setText(heading,name);
      buttonLabel(query('[data-testid="conversation-selector-button"]'),'会话',true);
    }
    attribute(composer.firstElementChild,'data-wb-chat-composer','');
    const previews=composer.querySelector('[data-testid="chat-composer-previews"]');
    const toolbar=previews?.nextElementSibling;
    if(!toolbar)return;
    attribute(toolbar,'data-wb-chat-tools','');
    const tool=(className,label,order,visible=false)=>{
      const button=toolbar.querySelector(`[class*="${className}"]`)?.closest('button');
      buttonLabel(button,label,visible);if(button)button.style.order=String(order);return button;
    };
    tool('camera-add','添加图片',0,true);tool('gallery-bold','相册',1,true);tool('keyboard-bold','发送方式',2);
    const clear=tool('trash-bin-2','清空对话',3);
    if(clear){
      clear.disabled=!hasMessages;
      if(!clear.hasAttribute('data-wb-chat-clear')){
        clear.dataset.wbChatClear='';
        clear.addEventListener('click',event=>{if(replayingClear)return;event.preventDefault();event.stopImmediatePropagation();confirmClear(clear);},true);
      }
    }
    buttonLabel(query('[data-testid="stop-speaking-button"]'),'停止朗读');
    const attachments=previews?.querySelector(':scope > .flex-nowrap');
    for(const button of attachments?.querySelectorAll('button')||[])buttonLabel(button,'移除图片');
    for(const button of previews?.querySelectorAll('button[title="Save to computer"]')||[])buttonLabel(button,'保存图片');
    if(!input.hasAttribute('data-wb-chat-input')){
      input.dataset.wbChatInput='';input.setAttribute('aria-label','消息');
      input.addEventListener('compositionstart',()=>{composing=true;schedule();});
      input.addEventListener('compositionend',()=>{composing=false;schedule();});
      input.addEventListener('input',schedule);
      // Native speech writes the Vue model without a DOM input event. Its
      // textarea watcher updates height for every model change, including clears.
      new MutationObserver(schedule).observe(input,{attributes:true,attributeFilter:['style']});
    }
    attribute(input,'placeholder',`发消息给${name}…`);
    let submit=toolbar.querySelector('[data-wb-chat-send]');
    if(!submit){
      submit=iconButton('发送','<path d="M12 19V5m-6 6 6-6 6 6"/>');
      submit.dataset.wbChatSend='';submit.addEventListener('click',send);toolbar.append(submit);
    }
    submit.disabled=busy||composing||(!input.value.trim()&&!attachments?.querySelector('img[src^="blob:"]'));
    setText(submit.lastElementChild,busy?'回复中':'发送');
    attribute(submit,'aria-label',busy?'正在回复':'发送消息');
    const history=query('[data-testid="chat-history-layer"]');
    let empty=history.querySelector('[data-wb-chat-empty]');
    if(!empty){empty=document.createElement('div');empty.dataset.wbChatEmpty='';empty.innerHTML='<h2></h2><p>从一句问候开始</p>';history.append(empty);}
    empty.hidden=hasMessages||busy;setText(empty.firstElementChild,name);
    for(const row of history.querySelectorAll('.chat-message-item'))attribute(row.parentElement,'data-wb-chat-row','');
    for(const bubble of history.querySelectorAll('.chat-message-item-container')){
      // Production Vue does not expose component props on these elements.
      // Use the native desktop's direction wrappers, never message contents.
      const wrapper=bubble.closest('.ph-no-capture');
      const role=wrapper?.classList.contains('flex-row-reverse')?'user':wrapper?.classList.contains('mr-12')?'assistant':null;
      if(role){
        attribute(bubble,'data-wb-message-role',role);attribute(bubble.closest('.chat-message-item'),'data-wb-message-role',role);attribute(wrapper,'data-wb-message-wrap','');
        const displayName=role==='user'?userName:name;
        avatarFor(wrapper,displayName,role==='user'?config.userProfile?.avatar:character?.avatar);
        const nameLabel=bubble.querySelector(':scope > div > span');
        if(nameLabel){attribute(nameLabel,'data-wb-chat-name','');setText(nameLabel,displayName);}
      }
    }
  }
  addEventListener('workbench:companion-identity',event=>{
    if(Object.hasOwn(event.detail||{},'userProfile'))config.userProfile=event.detail.userProfile;
    if(Object.hasOwn(event.detail||{},'character'))config.character=event.detail.character;
    schedule();
  });
  new MutationObserver(schedule).observe(document,{subtree:true,childList:true,characterData:true});
  addEventListener('DOMContentLoaded',schedule,{once:true});addEventListener('hashchange',schedule);schedule();
}
module.exports={installCompanionChat};
