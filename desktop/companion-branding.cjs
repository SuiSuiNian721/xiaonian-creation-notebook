// Shared by the native menu adapter and the isolated renderer preload.
// Keep this function self-contained: Electron serializes it into the main world.
function companionBranding(value,mode='text'){
  const labels=new Map([['Chat','聊天'],['Settings','陪伴设置'],['记忆体','记忆'],['机体模型','角色模型'],['机体模块','声音与感知'],['Data','数据管理'],['服务来源','AI 接入'],['存放记忆的地方，以及策略','查看和管理对话记忆'],['自定义你的舞台外观！','调整界面和显示'],['配置 WebSocket 服务器连接','管理本机连接'],['LLM、语音合成、语音识别服务来源等','配置对话、声音和语音识别']]);
  const text=input=>{
    if(typeof input!=='string'||/copyright|©|licen[sc]e|许可证|版权|署名/i.test(input))return input;
    // Absolute paths and links are references to actual resources, including names
    // containing spaces. Leave the remainder of an unquoted path line intact.
    return input.replace(/(?:https?|file):\/\/[^\s<>"']+|["'](?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?["']|(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n\t<>"']*|\bProject AIRI\b|\bWelcome to AIRI\b|(?<![\w@.\\/-])AIRI[ \t]*(?:官方提供商|Official Providers?\b|Cloud\b|Editor\b|角色卡|Cards?\b)|(?<![\w@.\\/-])AIRI(?![\w.\\/-])/gi,match=>{
      if(/^(?:(?:https?|file):\/\/|["']|[A-Za-z]:[\\/]|\\\\|\/)/i.test(match))return match;
      if(/^Project /i.test(match))return '小念的创作笔记';
      if(/^Welcome /i.test(match))return '虚拟陪伴';
      if(/官方提供商|Official Providers?|Cloud/i.test(match))return '第三方云端服务';
      if(/Editor/i.test(match))return '角色编辑器';
      if(/角色卡|Cards?/i.test(match))return '角色卡';
      return '虚拟陪伴';
    }).replace(/^[\s\S]*$/,result=>labels.get(result)||result);
  };
  const messages=input=>Array.isArray(input)?input.map(messages):input&&typeof input==='object'?Object.fromEntries(Object.entries(input).map(([key,item])=>[key,messages(item)])):text(input);
  if(mode==='text')return text(value);
  if(mode==='messages')return messages(value);
  if(mode!=='install')return;

  const patched=new WeakSet();
  let scheduled=false;
  const refresh=()=>{
    scheduled=false;
    const app=document.querySelector('#app')?.__vue_app__;
    const composer=app?._context.provides[app.__VUE_I18N_SYMBOL__]?.global;
    if(composer&&!patched.has(composer)){
      patched.add(composer);
      for(const locale of composer.availableLocales)composer.setLocaleMessage(locale,messages(composer.getLocaleMessage(locale)));
    }
    const title=text(document.title);
    if(document.title!==title)document.title=title;
    for(const element of document.querySelectorAll('[title],[aria-label],img')){
      if(element.closest('a[href^="https://"],a[href^="http://"],[data-license],[data-copyright],[data-attribution],.license,.copyright,.attribution'))continue;
      for(const name of ['title','aria-label','alt']){
        const current=element.getAttribute(name),next=text(current);
        if(current!==next)element.setAttribute(name,next);
      }
      if(element.tagName==='IMG'&&/\/(?:logo-a0Vre9rB|logo-dark-DEMlZ0m1)\.svg(?:$|\?)/.test(element.src)&&value.brandLogo)element.src=value.brandLogo;
    }
    // About/onboarding contain hard-coded product chrome outside the locale table.
    // Chat text, custom cards, code snippets and editable content remain untouched.
    if(/\/(?:about|onboarding)(?:[/?#]|$)/.test(location.hash)){
      const walker=document.createTreeWalker(document.body||document,NodeFilter.SHOW_TEXT);
      const nodes=[];let node;
      while((node=walker.nextNode()))if(!node.parentElement?.closest('script,style,pre,code,textarea,input,[contenteditable],a[href^="https://"],a[href^="http://"],[data-license],[data-copyright],[data-attribution],.license,.copyright,.attribution'))nodes.push(node);
      for(const item of nodes){const next=text(item.data);if(item.data!==next)item.data=next;}
    }
  };
  const schedule=()=>{if(!scheduled){scheduled=true;queueMicrotask(refresh);}};
  new MutationObserver(schedule).observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','src']});
  addEventListener('hashchange',schedule);
  addEventListener('DOMContentLoaded',schedule,{once:true});
  schedule();
}
module.exports={companionBranding};
