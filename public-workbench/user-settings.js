import {escape as e,icon,help} from './components.js';

const empty={displayName:'',avatar:'',identity:'',preferences:''};
export const avatarMarkup=(src,name='')=>src&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(src)?`<img src="${e(src)}" alt="" decoding="async">`:`<span aria-hidden="true">${e([...name][0]||'你')}</span>`;
export async function readAvatarFile(file){
  if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  if(file.size>4*1024*1024)throw new Error('头像图片不能超过 4 MiB，请缩小后重试。');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));reader.readAsDataURL(file);});
  const image=new Image();image.src=data;
  try{await image.decode();}catch{throw new Error('这张图片无法显示，请换一张有效图片。');}
  if(Math.max(image.naturalWidth,image.naturalHeight)<=512)return data;
  const ratio=512/Math.max(image.naturalWidth,image.naturalHeight),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/png');
}
export function mountAvatarEditor(root,{avatar='',name='',signal,onChange,onBusy=()=>{}}){
  root.innerHTML=`<div class="profile-avatar-preview" data-avatar-preview>${avatarMarkup(avatar,name)}</div><div class="profile-avatar-actions"><button type="button" class="button small" data-avatar-choose>${icon('upload')}更换头像</button><button type="button" class="text-link" data-avatar-clear ${avatar?'':'disabled'}>移除头像</button><input type="file" data-avatar-file accept="image/png,image/jpeg,image/webp" hidden></div><p class="form-feedback" role="status" data-avatar-feedback></p>`;
  const choose=root.querySelector('[data-avatar-choose]'),clear=root.querySelector('[data-avatar-clear]'),input=root.querySelector('input'),feedback=root.querySelector('[data-avatar-feedback]');let pending=false;
  const change=async value=>{
    if(pending||signal?.aborted)return;pending=true;onBusy(true);choose.disabled=true;clear.disabled=true;feedback.textContent='正在处理…';
    try{const next=typeof value==='string'?value:await readAvatarFile(value);if(signal?.aborted)return;await onChange(next);if(signal?.aborted)return;avatar=next;root.querySelector('[data-avatar-preview]').innerHTML=avatarMarkup(avatar,name);feedback.textContent='';}
    catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}
    finally{pending=false;onBusy(false);choose.disabled=false;clear.disabled=!avatar;input.value='';}
  };
  choose.addEventListener('click',()=>input.click(),{signal});
  clear.addEventListener('click',()=>void change(''),{signal});
  input.addEventListener('change',()=>{if(input.files[0])void change(input.files[0]);},{signal});
}

export async function mountUserSettings(root,ctx){
  root.className='panel glass user-settings-panel';
  root.innerHTML='<h2>用户设置</h2><p role="status">正在读取…</p>';
  let profile;
  try{profile=(await ctx.api('/api/user-profile')).profile;}
  catch(error){if(!ctx.signal.aborted){root.innerHTML=`<h2>用户设置</h2><p class="form-feedback error" role="alert">${e(error.message)}</p><button type="button" class="button" data-profile-retry>重新读取</button>`;root.querySelector('button').addEventListener('click',()=>void mountUserSettings(root,ctx),{signal:ctx.signal});}return;}
  if(ctx.signal.aborted)return;
  const key='user-profile',draft=ctx.drafts.read(key,{...empty,...profile});let avatar=draft.avatar,avatarPending=false;
  root.innerHTML=`<div class="heading-title"><h2>用户设置</h2>${help('填写的用户名、身份和偏好会随角色卡及虚拟陪伴的对话发送给 AI。留空不发送；头像仅用于界面显示。','用户资料用途')}</div><form data-user-profile-form><div class="user-profile-identity"><div class="profile-avatar-editor" data-user-avatar></div><div class="field"><label for="profile-display-name">用户名</label><input id="profile-display-name" name="displayName" maxlength="100" autocomplete="nickname" value="${e(draft.displayName)}"></div></div><div class="user-profile-details"><div class="field"><label for="profile-identity">身份</label><textarea id="profile-identity" name="identity" rows="4" maxlength="12000">${e(draft.identity)}</textarea></div><div class="field"><label for="profile-preferences">偏好</label><textarea id="profile-preferences" name="preferences" rows="4" maxlength="12000">${e(draft.preferences)}</textarea></div></div><div class="form-actions"><p class="form-feedback" data-profile-feedback role="status"></p><button class="button primary" type="submit">保存用户设置</button></div></form>`;
  const form=root.querySelector('form'),feedback=root.querySelector('[data-profile-feedback]');
  const snapshot=()=>({displayName:form.elements.displayName.value,identity:form.elements.identity.value,preferences:form.elements.preferences.value,avatar});
  const remember=()=>ctx.drafts.write(key,snapshot());
  mountAvatarEditor(root.querySelector('[data-user-avatar]'),{avatar,name:draft.displayName,signal:ctx.signal,onBusy:busy=>{avatarPending=busy;},onChange:next=>{avatar=next;remember();}});
  form.addEventListener('input',remember,{signal:ctx.signal});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(avatarPending){feedback.textContent='头像还在处理，请稍候再保存。';return;}const submitted=snapshot(),button=form.querySelector('[type=submit]');remember();button.disabled=true;feedback.textContent='正在保存…';feedback.className='form-feedback';
    try{
      const {profile:saved}=await ctx.api('/api/user-profile',{method:'POST',body:submitted});
      ctx.drafts.reconcile(key,submitted,saved);
      window.dispatchEvent(new CustomEvent('workbench:user-profile-changed',{detail:saved}));
      if(!ctx.signal.aborted){feedback.textContent='已保存';ctx.notify('用户设置已保存。');}
    }catch(error){if(!ctx.signal.aborted){feedback.textContent=error.message;feedback.className='form-feedback error';}}
    finally{button.disabled=false;}
  },{signal:ctx.signal});
}
