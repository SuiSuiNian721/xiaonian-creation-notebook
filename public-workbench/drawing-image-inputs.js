import {escape as e,icon,help} from './components.js';
import {openCharacterResources,resourceFile} from './character-resources-ui.js';

export const imageAccept='image/png,image/jpeg,image/webp';
const imageName=image=>String(image).split(/[\\/]/).at(-1);
const imageOptions=(images,value='')=>`<option value="">选择服务图片</option>${value&&!images.includes(value)?`<option value="${e(value)}" selected disabled>${e(value)}（当前服务未列出）</option>`:''}${[...new Set(images.filter(Boolean))].map(image=>`<option value="${e(image)}" ${image===value?'selected':''}>${e(image)}</option>`).join('')}`;
const roleLabel=(reference,index)=>reference.mode==='img2img'?'主图':reference.roles?.[index]?.label||`参考图 ${index+1}`;

export function nativeImageMarkup(field,label){
  return `<div data-native-image-preview="${e(field.key)}"></div><div class="drawing-field-actions"><button type="button" class="button small drawing-image-drop" data-image-upload-button="${e(field.key)}" data-image-drop="${e(field.key)}">${icon('upload')}选择或拖入${e(label)}</button><input type="file" accept="${imageAccept}" data-image-field="${e(field.key)}" aria-label="选择${e(label)}" hidden><button type="button" class="text-link" data-image-library-field="${e(field.key)}">角色资料</button></div>`;
}

// All image sources share validation, upload ordering and lifecycle guards.
export function mountDrawingImages(root,{ctx,workflow,fields,reference,adjustments,signal,current,blocked,connected,post,report,onChange,onBusy,refresh}){
  const find=selector=>root.querySelector(selector),extra=find('#drawing-extra-references'),names=new Map(),previews=new Map();
  const slots=reference?.mode!=='img2img'&&reference?.roles?.every(item=>item.slot)?reference.roles:[];
  let uploading=false,replacement=null;
  const role=(index,slot)=>slots.length?slots.find(item=>item.slot===slot)?.label||'原图片位置不可用':roleLabel(reference,index);
  const editable=()=>current()&&!blocked()&&!uploading&&connected();
  const rows=()=>[...(extra?.querySelectorAll('[data-extra-reference]')||[])];
  const imageInput=field=>find(`[data-parameter="${CSS.escape(field.key)}"]`);
  const fieldEditable=field=>editable()&&!imageInput(field)?.matches(':disabled');
  const displayName=image=>names.get(image)||imageName(image);
  const emptySlots=()=>slots.filter(item=>!rows().some(row=>row.dataset.imageSlot===item.slot));
  const unavailable=()=>Boolean(extra&&(rows().length>reference.maxImages||slots.length&&(rows().some(row=>!slots.some(item=>item.slot===row.dataset.imageSlot))||new Set(rows().map(row=>row.dataset.imageSlot)).size!==rows().length)));
  function preview(button,image,label){
    button.setAttribute('aria-label',`更换${label} ${displayName(image)}`);
    button.innerHTML=`${icon('drawing')}<span class="drawing-image-preview-status">正在读取预览…</span>`;
    if(!connected()){button.querySelector('span').textContent='连接后显示预览';return;}
    if(!previews.has(image))previews.set(image,ctx.api('/api/modules/drawing/input-preview',{method:'POST',body:{image}}).then(result=>{
      if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(result?.src||''))throw new Error('图片预览不可用。');return result.src;
    }));
    void previews.get(image).then(src=>{if(!current()||!button.isConnected)return;button.innerHTML=`<img src="${e(src)}" alt="${e(label+'：'+displayName(image))}">`;}).catch(()=>{if(current()&&button.isConnected)button.querySelector('span').textContent='预览暂不可用';});
  }
  function renderNative(field){
    const container=find(`[data-native-image-preview="${CSS.escape(field.key)}"]`),image=imageInput(field).value,label=field.presentation?.label||field.label||'图片';
    container.replaceChildren();if(!image)return;
    container.innerHTML=`<button type="button" class="drawing-image-preview drawing-image-drop" data-image-drop="${e(field.key)}"></button><div class="drawing-image-caption"><span title="${e(image)}">${e(displayName(image))}</span><button type="button" class="text-link" aria-label="移除${e(label)}" data-remove-native-image>移除</button></div>`;
    const button=container.querySelector('button');button.onclick=()=>{if(fieldEditable(field))find(`[data-image-field="${CSS.escape(field.key)}"]`).click();};preview(button,image,label);
    container.querySelector('[data-remove-native-image]').onclick=()=>{if(!fieldEditable(field))return;imageInput(field).value='';renderNative(field);refresh();onChange();};
  }
  function addImage(image,name,target,slot){
    if(name)names.set(image,name);
    const row=target||document.createElement('div');row.className='drawing-reference-row';row.dataset.extraReference=image;
    if(slots.length)row.dataset.imageSlot=target?.dataset.imageSlot||slot||emptySlots()[0]?.slot;
    row.innerHTML=`<div class="field-label drawing-image-role"><span data-image-role></span></div><button type="button" class="drawing-image-preview drawing-image-drop" data-image-drop="reference"></button><div class="drawing-image-caption"><span title="${e(image)}">${e(displayName(image))}</span><button type="button" class="text-link" data-replace-reference>更换</button><button type="button" class="text-link" data-remove-reference>移除</button></div>`;
    if(!target)(slots.length?find(`[data-reference-slot="${CSS.escape(row.dataset.imageSlot)}"]`)||extra:extra).append(row);
    const button=row.querySelector('[data-image-drop]'),choose=()=>{if(!editable())return;replacement={row};find('[data-extra-reference-upload]').multiple=false;find('[data-extra-reference-upload]').click();};button.onclick=choose;row.querySelector('[data-replace-reference]').onclick=choose;
    row.querySelector('[data-remove-reference]').onclick=()=>{if(!editable())return;row.remove();refresh();onChange();find('#drawing-add-reference')?.focus();};
    preview(button,image,role(rows().indexOf(row),row.dataset.imageSlot));refresh();
  }
  function syncSlots(){
    const nextSlot=emptySlots()[0]?.slot;
    for(const slot of slots){
      const container=find(`[data-reference-slot="${CSS.escape(slot.slot)}"]`),row=container.querySelector('[data-extra-reference]'),empty=container.querySelector('[data-reference-empty-slot]');
      container.hidden=!row&&slot.slot!==nextSlot;
      if(container.hidden){empty?.remove();continue;}
      if(row){empty?.remove();continue;}if(empty)continue;
      const node=document.createElement('div');node.dataset.referenceEmptySlot=slot.slot;
      node.innerHTML=`<div class="field-label drawing-image-role"><span>${e(slot.label)}</span></div><button type="button" class="drawing-image-drop drawing-image-add" data-image-drop="reference" data-image-slot="${e(slot.slot)}">${icon('upload')}<span>选择或拖入${e(slot.label)}</span></button><div class="drawing-field-actions drawing-image-sources"><select data-reference-existing data-searchable aria-label="选择${e(slot.label)}的服务图片">${imageOptions(reference.images||[])}</select><button type="button" class="text-link" data-reference-library>角色资料</button>${help('支持 PNG、JPEG、WebP，每张不超过 18 MiB。','图片格式与大小')}</div>`;
      node.querySelector('[data-image-drop]').onclick=()=>{if(!editable())return;replacement={slot:slot.slot};const file=find('[data-extra-reference-upload]');file.multiple=emptySlots().length>1;file.click();};
      node.querySelector('select').onchange=event=>{const image=event.target.value;if(image&&editable()){addImage(image,undefined,undefined,slot.slot);onChange();}};
      node.querySelector('[data-reference-library]').onclick=()=>library(undefined,slot.slot);container.append(node);
    }
    const emptyButtons=[...extra.querySelectorAll('[data-reference-empty-slot] [data-image-drop]')];emptyButtons.forEach((button,index)=>{if(index===0)button.id='drawing-add-reference';else button.removeAttribute('id');});
    const missingPrimary=rows().length>0&&slots.some(item=>item.role==='primary'&&!rows().some(row=>row.dataset.imageSlot===item.slot));
    const notice=find('[data-image-primary-notice]');notice.hidden=!missingPrimary&&!unavailable();notice.textContent=unavailable()?'已保存图片的位置已变更，请移除后重新选择。':'请先选择主图，再添加参考图。';
  }
  function sync(){
    const unavailable=!editable();
    if(slots.length)syncSlots();
    for(const control of root.querySelectorAll('[data-image-drop],[data-image-library-field],[data-image-field],[data-remove-native-image],[data-replace-reference],[data-remove-reference],[data-reference-existing],[data-reference-library]')){
      const key=control.dataset.imageDrop||control.dataset.imageLibraryField||control.dataset.imageField||control.closest('[data-native-image-preview]')?.dataset.nativeImagePreview,field=fields.find(item=>item.key===key);control.disabled=unavailable||Boolean(field&&!fieldEditable(field));
    }
    if(!extra)return;
    const count=rows().length,full=count>=reference.maxImages,add=find('#drawing-add-reference');
    rows().forEach((row,index)=>{const label=role(index,row.dataset.imageSlot);row.querySelector('[data-image-role]').textContent=label;row.querySelector('[data-image-drop]').setAttribute('aria-label',`更换${label} ${displayName(row.dataset.extraReference)}`);row.querySelector('img')?.setAttribute('alt',`${label}：${displayName(row.dataset.extraReference)}`);row.querySelector('[data-remove-reference]').setAttribute('aria-label','移除'+label);});
    if(!slots.length){add.hidden=full;add.innerHTML=`${icon('upload')}<span>选择或拖入${e(role(count))}</span>`;add.disabled=unavailable||full;}
    const controls=find('[data-reference-sources]');controls.hidden=full;
    if(slots.length)controls.hidden=true;
    for(const control of controls.querySelectorAll('button,input,select'))control.disabled=unavailable||full;
    find('[data-extra-reference-upload]').disabled=unavailable;
    root.querySelector('[data-drawing-group="reference"]')?.setAttribute('aria-busy',String(uploading));
  }
  async function refreshChoices(){
    const refreshed=await ctx.api('/api/modules/drawing/workflows/'+workflow.id);if(!current())return;
    for(const field of fields.filter(item=>item.image)){
      const next=refreshed.fields?.find(item=>item.key===field.key);if(!next)continue;
      const input=imageInput(field);if(!input)continue;const previous=input.value;Object.assign(field,next);
      if(field.type==='select')input.innerHTML=imageOptions(field.choices||[],previous);input.value=previous;
    }
    if(extra){reference.images=refreshed.controls?.reference?.images||reference.images||[];for(const input of root.querySelectorAll('[data-reference-existing]'))input.innerHTML=imageOptions(reference.images);}
  }
  async function upload(files,field,target,requestedSlot){
    if(!current()||blocked()||uploading||!files.length)return;
    if(field&&!fieldEditable(field))return;
    if(!connected()){report('请先连接 ComfyUI 再上传图片。',true);return;}
    const available=field||target?1:reference.maxImages-rows().length;
    if(files.length>available){report(`最多添加 ${field||target?1:reference.maxImages} 张图片，请减少本次选择的图片。`,true);return;}
    // Validate the whole batch before sending any file.
    for(const file of files){
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)&&!(file.type===''&&/\.(?:png|jpe?g|webp)$/i.test(file.name))){report('请选择 PNG、JPEG 或 WebP 图片。',true);return;}
      if(file.size>18*1024*1024){report('图片超过 18 MiB，请选择较小的图片。',true);return;}
      if(!file.size){report('图片为空，请重新选择。',true);return;}
    }
    uploading=true;onBusy(true);refresh();
    try{
      const destinations=slots.length?[...emptySlots().filter(item=>item.slot===requestedSlot),...emptySlots().filter(item=>item.slot!==requestedSlot)]:[];
      for(const file of files){
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('图片读取失败，请重新选择。'));reader.readAsDataURL(file);});if(!current())return;
        const result=await post('/uploads',{name:file.name,data});if(!current())return;
        if(typeof result.image!=='string'||!result.image)throw new Error('服务未返回上传图片，请重新选择。');
        await refreshChoices();if(!current())return;
        names.set(result.image,file.name);
        if(field){
          if(field.type==='select'&&!field.choices.includes(result.image))throw new Error('已上传，但此节点尚未列出图片，请重新连接后选择。');
          imageInput(field).value=result.image;renderNative(field);
        }else addImage(result.image,file.name,target,destinations.shift()?.slot);
        onChange();
      }
      report('图片已上传。');
    }catch(error){if(current())report(error.message,true);}
    finally{uploading=false;if(current()){onBusy(false);refresh();}}
  }
  function library(field,slot){
    if(!editable()||field&&!fieldEditable(field))return;
    void openCharacterResources(ctx,{accept:['image','skin'],onPick:async resource=>{const file=await resourceFile(resource);if(editable())await upload([file],field,undefined,slot);}});
  }
  for(const field of fields.filter(item=>item.image)){
    const input=imageInput(field),file=find(`[data-image-field="${CSS.escape(field.key)}"]`);
    if(!input||!file)continue;
    input.required=true;if(field.type==='select')input.innerHTML=imageOptions(field.choices||[],input.value);input.setAttribute('data-searchable','');
    input.addEventListener('change',()=>{renderNative(field);sync();},{signal});
    file.onchange=()=>{const files=[...file.files];file.value='';void upload(files,field);};
    find(`[data-image-upload-button="${CSS.escape(field.key)}"]`).onclick=()=>{if(fieldEditable(field))file.click();};find(`[data-image-library-field="${CSS.escape(field.key)}"]`).onclick=()=>library(field);renderNative(field);
  }
  if(extra){
    const file=find('[data-extra-reference-upload]');file.onchange=()=>{const files=[...file.files],target=replacement;file.value='';replacement=null;void upload(files,undefined,target?.row,target?.slot);};
    find('#drawing-add-reference').onclick=()=>{if(!editable())return;replacement=null;file.multiple=reference.maxImages>1;file.click();};
    find('#drawing-reference-library').onclick=()=>library();
    const existing=find('[data-reference-existing]');existing.innerHTML=imageOptions(reference.images||[]);existing.onchange=()=>{const image=existing.value;if(image&&editable()&&rows().length<reference.maxImages){addImage(image);onChange();}existing.value='';};
    if(slots.length){
      find('#drawing-add-reference').id='drawing-add-reference-legacy';find('#drawing-add-reference-legacy').hidden=true;
      extra.innerHTML=slots.map(item=>`<div class="drawing-reference-slot" data-reference-slot="${e(item.slot)}"></div>`).join('');
      const notice=document.createElement('p');notice.className='form-feedback';notice.dataset.imagePrimaryNotice='';notice.textContent='请先选择主图，再添加参考图。';notice.hidden=true;extra.after(notice);
    }
    for(const [index,image] of (adjustments.images||[]).entries())addImage(image,undefined,undefined,slots.length?(adjustments.imageSlots?adjustments.imageSlots[index]||`unavailable:${index}`:slots[index]?.slot||`unavailable:${index}`):undefined);
  }
  const hasFiles=event=>[...(event.dataTransfer?.types||[])].includes('Files');
  const zoneFor=event=>event.target.closest?.('[data-image-drop]');
  root.addEventListener('dragover',event=>{if(!hasFiles(event))return;event.preventDefault();const zone=zoneFor(event);event.dataTransfer.dropEffect=zone&&editable()&&!zone.disabled?'copy':'none';if(zone&&editable()&&!zone.disabled)zone.classList.add('is-dragging');},{signal});
  root.addEventListener('dragleave',event=>{const zone=zoneFor(event);if(zone&&!zone.contains(event.relatedTarget))zone.classList.remove('is-dragging');},{signal});
  root.addEventListener('drop',event=>{if(!hasFiles(event))return;event.preventDefault();root.querySelectorAll('.is-dragging').forEach(node=>node.classList.remove('is-dragging'));const zone=zoneFor(event);if(!zone||!editable()||zone.disabled)return;const field=fields.find(item=>item.key===zone.dataset.imageDrop);void upload([...event.dataTransfer.files],field,zone.closest('[data-extra-reference]'),zone.dataset.imageSlot);},{signal});
  // A file dropped elsewhere must never navigate the Electron window away.
  for(const type of ['dragover','drop'])document.addEventListener(type,event=>{if(current()&&hasFiles(event))event.preventDefault();},{signal});
  sync();
  return {readImages:()=>extra?rows().map(row=>row.dataset.extraReference):structuredClone(adjustments.images||[]),readSlots:()=>slots.length?rows().map(row=>row.dataset.imageSlot):undefined,hasUnavailableImages:unavailable,sync};
}
