import {escape as e,icon,help as sharedHelp} from './components.js';

export const resourceKinds={card:'SillyTavern 角色卡',image:'角色图像',lora:'角色 LoRA',audio:'角色语音',skin:'MC 皮肤'};
const kinds=resourceKinds;
const accepts={card:'.png,.json',image:'image/png,image/jpeg,image/webp,image/gif,image/bmp',audio:'audio/*',skin:'image/png'};
const formats={card:'SillyTavern 角色卡：含角色信息的 PNG 或 JSON，保存不会替换当前人设',image:'角色图像：PNG、JPEG、WebP、GIF、BMP',lora:'角色 LoRA：关联本机权重文件，不复制，不受上传大小限制',audio:'角色语音：已保存的声音或 WAV、MP3、OGG、FLAC 音频',skin:'MC 皮肤：64×64 或 64×32 PNG'};
const formatHelp=accept=>(accept?.length===1&&accept[0]==='lora'?'':'上传文件每个最大 32 MiB；角色卡最多 16 MiB。')+(accept||Object.keys(kinds)).map(kind=>formats[kind]).filter(Boolean).join('；')+'。';
const help=(text,label)=>sharedHelp(text,label).replace('data-help=','data-resource-help=');
const request=ctx=>ctx.libraryApi||ctx.api;
const kindOf=file=>file.type.startsWith('image/')?'image':file.type.startsWith('audio/')?'audio':/\.json$/i.test(file.name)?'card':null;
function dialog(title){
  const node=document.createElement('dialog');node.className='character-resource-dialog';
  node.innerHTML=`<div class="panel-heading"><h2>${e(title)}</h2><button type="button" class="icon-button" data-resource-close aria-label="关闭${e(title)}">${icon('close')}</button></div><div data-resource-content></div><p class="form-feedback" role="status" data-resource-feedback></p>`;
  let helpTrigger,helpPopover;
  const hideHelp=()=>{helpTrigger?.setAttribute('aria-expanded','false');helpTrigger?.removeAttribute('aria-describedby');helpPopover?.remove();helpTrigger=helpPopover=null;};
  const showHelp=control=>{
    if(control===helpTrigger&&helpPopover?.matches(':popover-open'))return;
    hideHelp();helpTrigger=control;helpPopover=document.createElement('div');helpPopover.id='resource-help-'+crypto.randomUUID();helpPopover.className='life-help-tooltip';helpPopover.popover='auto';helpPopover.setAttribute('role','tooltip');helpPopover.textContent=control.dataset.resourceHelp;const current=helpPopover;current.addEventListener('toggle',event=>{if(event.newState==='closed'&&helpPopover===current)hideHelp();});node.append(helpPopover);helpPopover.showPopover();
    const rect=control.getBoundingClientRect(),width=helpPopover.offsetWidth,height=helpPopover.offsetHeight;helpPopover.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';helpPopover.style.top=(rect.bottom+height+12<innerHeight?rect.bottom+8:Math.max(12,rect.top-height-8))+'px';control.setAttribute('aria-expanded','true');control.setAttribute('aria-describedby',helpPopover.id);
  };
  node.addEventListener('focusin',event=>{const control=event.target.closest('[data-resource-help]');if(control)showHelp(control);else hideHelp();});
  node.addEventListener('pointerover',event=>{const control=event.target.closest('[data-resource-help]');if(control)showHelp(control);});
  node.addEventListener('pointerout',event=>{if(event.target.closest('[data-resource-help]')&&document.activeElement!==helpTrigger&&!helpPopover?.contains(event.relatedTarget))hideHelp();});
  node.addEventListener('click',event=>{const control=event.target.closest('[data-resource-help]');if(control)showHelp(control);});
  document.body.append(node);node.querySelector('[data-resource-close]').onclick=()=>node.close();node.addEventListener('close',()=>{hideHelp();node.remove();},{once:true});node.showModal();return node;
}
function defaultCharacter(ctx,characters){
  const current=ctx.characters?.getSelected?.();
  const source=current?.raw?.workbenchProvenance?.sourceCharacterId;
  return characters.find(item=>item.id===current?.id||item.id===source)?.id||(characters.length===1?characters[0].id:'');
}
export async function resourceFile(resource){
  const url=new URL(resource.url,location.href);if(url.origin!==location.origin)throw new Error('角色文件地址无效。');
  const response=await fetch(url);if(!response.ok)throw new Error('无法读取角色文件，请重新选择。');
  return new File([await response.blob()],resource.name,{type:resource.mime});
}
async function fileData(file){
  if(file.size>32*1024*1024)throw new Error('文件超过 32 MiB，请选择较小的文件。');
  const bytes=new Uint8Array(await file.arrayBuffer());let encoded='';
  for(let offset=0;offset<bytes.length;offset+=16384)encoded+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
  return btoa(encoded);
}

export async function saveCharacterResource(ctx,{file,url,name,kind,mime,characterId,onSaved}={}){
  const box=dialog('保存到角色资料'),content=box.querySelector('[data-resource-content]'),feedback=box.querySelector('[data-resource-feedback]'),api=request(ctx);
  feedback.textContent='正在读取角色资料…';
  try{
    const state=await api('/api/state');if(!box.isConnected)return;
    const characters=state.characters;
    if(file&&!kind&&!kindOf(file))throw new Error('请选择角色卡、角色图像、角色语音或 MC 皮肤；LoRA 请使用“关联 LoRA 文件”。');
    if(!characters.length){content.innerHTML='<p>先在角色资料中新建或导入一个角色。</p>';feedback.textContent='';return;}
    content.innerHTML=`<form data-resource-save><div class="field"><label for="resource-target">保存到角色</label><select id="resource-target" name="characterId" required><option value="">选择角色</option>${characters.map(character=>`<option value="${e(character.id)}">${e(character.name)}</option>`).join('')}</select></div><div class="field"><label for="resource-name">文件名称</label><input id="resource-name" name="name" maxlength="240" required value="${e(name||file?.name||kinds[kind]||'角色文件')}"></div>${kind?'':`<div class="field"><label for="resource-kind">类型</label><select id="resource-kind" name="kind">${Object.entries(kinds).filter(([value])=>value!=='lora').map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></div>`}<div class="form-actions">${help(formatHelp(kind?[kind]:undefined),'文件格式与大小限制')}<button type="submit" class="button primary">保存文件</button></div></form>`;
    const form=content.querySelector('form');form.elements.characterId.value=characterId||defaultCharacter(ctx,characters);if(form.elements.kind)form.elements.kind.value=file?kindOf(file):'image';feedback.textContent='';
    form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('[type="submit"]'),close=box.querySelector('[data-resource-close]');button.disabled=true;close.disabled=true;feedback.textContent='正在保存角色文件…';feedback.className='form-feedback';
      try{
        const source=file||await resourceFile({url,name:form.elements.name.value,mime:mime||''});
        const resource=await api('/api/characters/'+encodeURIComponent(form.elements.characterId.value)+'/resources',{method:'POST',body:{name:form.elements.name.value,kind:kind||form.elements.kind.value,mime:source.type||mime||'application/octet-stream',base64:await fileData(source),...(ctx.moduleId?{sourceModuleId:ctx.moduleId}:{}),...(ctx.instanceId?{sourceInstanceId:ctx.instanceId}:{})},timeoutMs:60000});
        await onSaved?.(resource.resource);ctx.notify(`${kinds[resource.resource.kind]||'文件'}「${resource.resource.name}」已保存到「${characters.find(character=>character.id===form.elements.characterId.value)?.name||'所选角色'}」的角色文件。`);box.close();
      }catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}
      finally{button.disabled=false;close.disabled=false;}
    };
  }catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}
}

export async function linkCharacterResource(ctx,{characterId,kind='lora',path='',name='',baseFamily='unknown',voiceId='',onSaved}={}){
  const box=dialog(kind==='lora'?'关联 LoRA 文件':'关联已保存声音'),content=box.querySelector('[data-resource-content]'),feedback=box.querySelector('[data-resource-feedback]'),api=request(ctx);
  try{
    const state=await api('/api/state');if(!box.isConnected)return;
    const voices=kind==='audio'?(await api('/api/voice-studio/state')).voices??[]:[];
    content.innerHTML=`<form><label class="field"><span>角色</span><select name="characterId" required>${state.characters.map(item=>`<option value="${e(item.id)}">${e(item.name)}</option>`).join('')}</select></label><label class="field"><span>资源名称</span><input name="name" maxlength="240" required value="${kind==='lora'?'角色 LoRA':'角色语音'}"></label>${kind==='lora'?`<label class="field"><span>LoRA 文件路径</span><input name="path" required placeholder="E:\\ComfyUI\\models\\loras\\character.safetensors"></label><label class="field"><span>底模家族</span><input name="baseFamily" value="unknown"></label>`:`<label class="field"><span>已保存声音</span><select name="voiceId" required>${voices.map(voice=>`<option value="${e(voice.id)}">${e(voice.name)}</option>`).join('')}</select></label>`}<div class="form-actions">${help(formats[kind],'关联方式')}<button class="button primary" type="submit" ${!state.characters.length||kind==='audio'&&!voices.length?'disabled':''}>关联到角色</button></div></form>`;
    const form=content.querySelector('form');form.elements.characterId.value=characterId||defaultCharacter(ctx,state.characters);
    if(name)form.elements.name.value=name;
    if(kind==='lora'){form.elements.path.value=path;form.elements.baseFamily.value=baseFamily==='unknown'?'':baseFamily;form.elements.baseFamily.placeholder='可选，例如 SDXL';}else if(voiceId)form.elements.voiceId.value=voiceId;
    form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('button');button.disabled=true;
      try{
        const values=Object.fromEntries(new FormData(form));const target=values.characterId;delete values.characterId;
        const result=await api('/api/characters/'+encodeURIComponent(target)+'/resource-references',{method:'POST',body:{...values,kind},timeoutMs:30000});
        await onSaved?.(result.resource);box.close();
      }catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}finally{button.disabled=false;}
    };
  }catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}
}

export async function openCharacterResources(ctx,{characterId,accept,onPick,title='角色文件'}={}){
  const box=dialog(title),content=box.querySelector('[data-resource-content]'),feedback=box.querySelector('[data-resource-feedback]'),api=request(ctx);let generation=0,migrated=false;
  feedback.textContent='正在读取角色资料…';
  try{
    const state=await api('/api/state');if(!box.isConnected)return;
    const characters=state.characters;
    content.innerHTML=`<div class="resource-library-toolbar"><label class="field"><span>角色</span><select data-resource-character><option value="">选择角色</option>${characters.map(character=>`<option value="${e(character.id)}">${e(character.name)}</option>`).join('')}</select></label><label class="field"><span>类型</span><select data-resource-kind-filter><option value="">全部类型</option>${Object.entries(kinds).filter(([kind])=>!accept||accept.includes(kind)).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><div class="heading-title"><button type="button" class="button" data-resource-add>${icon('upload')}添加文件</button><button type="button" class="button" data-resource-voice hidden>关联已保存声音</button>${help(formatHelp(accept),'文件格式与大小限制')}</div><input type="file" data-resource-upload accept=".png,.json,.jpg,.jpeg,.webp,.gif,.bmp,.wav,.mp3,.ogg,.flac" hidden></div><div class="character-resource-grid" data-resource-list></div><details data-resource-legacy hidden><summary>旧版资源导出</summary><div data-resource-legacy-links></div></details>`;
    const select=content.querySelector('select'),list=content.querySelector('[data-resource-list]'),upload=content.querySelector('input');
    select.value=characterId||defaultCharacter(ctx,characters);if(accept?.length===1){upload.accept=accepts[accept[0]]||'';content.querySelector('[data-resource-kind-filter]').value=accept[0];content.querySelector('[data-resource-kind-filter]').closest('label').hidden=true;}
    const draw=async()=>{
      const mine=++generation;feedback.textContent='';list.replaceChildren();content.querySelector('[data-resource-add]').disabled=!select.value;
      if(!select.value){feedback.textContent=characters.length?'选择一个角色查看文件。':'先在角色资料中新建或导入一个角色。';return;}
      try{
        if(!migrated){await api('/api/characters/'+encodeURIComponent(select.value)+'/resources-migrate',{method:'POST',body:{}});migrated=true;}
        const data=await api('/api/characters/'+encodeURIComponent(select.value)+'/resources');if(mine!==generation||!box.isConnected)return;
        const filter=content.querySelector('[data-resource-kind-filter]').value;
        const resources=data.resources.filter(resource=>Object.hasOwn(kinds,resource.kind)&&(!accept||accept.includes(resource.kind))&&(!filter||resource.kind===filter));
        const add=content.querySelector('[data-resource-add]');add.innerHTML=filter==='lora'?`${icon('folder')}关联 LoRA 文件`:`${icon('upload')}添加文件`;content.querySelector('[data-resource-voice]').hidden=filter!=='audio';
        const legacy=data.resources.filter(resource=>!Object.hasOwn(kinds,resource.kind));content.querySelector('[data-resource-legacy]').hidden=!legacy.length;
        content.querySelector('[data-resource-legacy-links]').innerHTML=legacy.map(resource=>`<p><a class="text-link" href="${e(resource.url)}?download=1" download="${e(resource.name)}">${e(resource.name)}</a></p>`).join('');
        list.innerHTML=resources.length?resources.map(resource=>`<article class="character-resource"><div class="character-resource-preview">${['image','skin'].includes(resource.kind)?`<img src="${e(resource.url)}" alt="${e(resource.name)}" loading="lazy">`:resource.kind==='audio'&&resource.url?`<audio src="${e(resource.url)}" controls preload="none" aria-label="${e(resource.name)}"></audio>`:icon('folder')}</div><strong>${e(resource.name)}</strong>${resource.reference?.path?`<span class="environment-path">${e(resource.reference.path)}</span>`:''}<div class="character-resource-actions">${resource.url?`<a class="text-link" href="${e(resource.url)}?download=1" download="${e(resource.name)}">${icon('download')}保存文件</a>`:''}${onPick?`<button type="button" class="button small" data-resource-pick="${e(resource.id)}">选用</button>`:''}</div></article>`).join(''):'<p class="quiet-empty">暂无可用资源</p>';
        for(const button of list.querySelectorAll('[data-resource-pick]'))button.onclick=()=>void ctx.action(button,async()=>{await onPick(resources.find(resource=>resource.id===button.dataset.resourcePick));box.close();});
      }catch(error){if(box.isConnected){feedback.textContent=error.message;feedback.className='form-feedback error';}}
    };
    select.onchange=draw;content.querySelector('[data-resource-kind-filter]').onchange=draw;content.querySelector('[data-resource-add]').onclick=()=>content.querySelector('[data-resource-kind-filter]').value==='lora'?void linkCharacterResource(ctx,{characterId:select.value,onSaved:draw}):upload.click();
    content.querySelector('[data-resource-voice]').onclick=()=>void linkCharacterResource(ctx,{characterId:select.value,kind:'audio',onSaved:draw});
    upload.onchange=()=>{const file=upload.files[0];upload.value='';if(file)void saveCharacterResource(ctx,{file,characterId:select.value,...(accept?.length===1?{kind:accept[0]}:{}),onSaved:draw});};
    await draw();
  }catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}
}
