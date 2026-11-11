import {escape as e,icon,help} from './components.js';
import {openCharacterResources} from './character-resources-ui.js';
import {loraServiceChoices} from './drawing-completion-view.js';
import {isSeedField,inferSeedMode,randomSeed} from './drawing-seeds.js';
import {imageAccept,nativeImageMarkup,mountDrawingImages} from './drawing-image-inputs.js';
import {mountSizePresets} from './drawing-size-presets.js';

const LABELS={text:'提示词',prompt:'提示词',positive_prompt:'正面提示词',negative_prompt:'负面提示词',resolution:'分辨率',width:'宽度',height:'高度',steps:'采样步数',seed:'绘图种子',noise_seed:'绘图种子',cfg:'引导强度',denoise:'重绘强度',sampler_name:'采样器',scheduler:'调度器',image:'参考图',batch_size:'张数',filename_prefix:'文件名前缀',unet_name:'扩散模型',clip_name:'文本编码器',vae_name:'图像编解码器',ckpt_name:'模型',lora_name:'LoRA 文件',strength_model:'模型权重',strength_clip:'文本权重',strength:'权重'};
const CHOICES={default:'默认',auto:'自动',none:'无',normal:'标准',simple:'简单',karras:'卡拉斯',exponential:'指数',sgm_uniform:'均匀噪声',ddim_uniform:'均匀隐式去噪',beta:'贝塔分布',linear_quadratic:'线性二次',kl_optimal:'最优散度',euler:'欧拉',euler_ancestral:'欧拉祖先',heun:'霍恩',heunpp2:'改进霍恩二阶',er_sde:'随机微分采样',lms:'线性多步',ddim:'隐式去噪',dpm_2:'二阶扩散',dpm_2_ancestral:'二阶祖先扩散',dpm_fast:'快速扩散',dpm_adaptive:'自适应扩散',dpmpp_2s_ancestral:'二阶单步祖先扩散',dpmpp_2m:'二阶多步扩散',dpmpp_sde:'随机微分扩散',dpmpp_2m_sde:'二阶多步随机扩散',dpmpp_3m_sde:'三阶多步随机扩散',uni_pc:'统一预测校正',uni_pc_bh2:'统一预测校正二阶',fixed:'固定',random:'随机',randomize:'随机',enabled:'启用',disabled:'关闭',enable:'启用',disable:'关闭',cpu:'处理器',gpu:'显卡',Equal:'相等','Starts With':'以指定文字开头','Ends With':'以指定文字结尾'};
const DESCRIPTIONS={text:'填写绘图内容。',prompt:'填写希望画面呈现的内容。',positive_prompt:'描述希望画面呈现的内容。',negative_prompt:'填写画面中需要避免的内容。',width:'设置输出画面的宽度，单位为像素。',height:'设置输出画面的高度，单位为像素。',steps:'设置生成图片使用的采样步数。',cfg:'调整生成结果遵循提示词的强度。',denoise:'调整重绘幅度，数值越大越容易改变原图。',sampler_name:'选择任务使用的采样方式。',scheduler:'选择采样过程中噪声强度的变化方式。',filename_prefix:'设置生成图片的文件名前缀。',batch_size:'设置一次生成的图片数量。'};
const labelFor=field=>field.presentation?.label||LABELS[field.input]||(/^[^A-Za-z]+$/.test(field.label)?field.label:field.multiline?'文本内容':'其他参数');
const isLora=field=>/^lora(?:_name|_file)?$/i.test(field.input);
const isModel=field=>isLora(field)||field.input==='model'||/^(?:ckpt|unet|clip|vae|model)_name(?:_\d+)?$/.test(field.input);
const options=(choices,value,blank=false,field)=>`${blank?'<option value="">不添加</option>':''}${value!==undefined&&value!==''&&!choices.some(item=>String(item)===String(value))?`<option value="${e(value)}" selected disabled>${e(value)}（当前服务未列出）</option>`:''}${choices.map(option=>`<option value="${e(option)}" ${String(option)===String(value)?'selected':''}>${e(field&&!isModel(field)&&!['sampler_name','scheduler'].includes(field.input)?CHOICES[option]??option:option)}</option>`).join('')}`;
function inputField(field,value,referenceResolution=false,seedMode='fixed'){
  const id='draw-'+field.key.replaceAll(':','-'),attr=`id="${e(id)}" data-parameter="${e(field.key)}"`;
  const label=field.presentation?.label||(referenceResolution?'图片处理尺寸':labelFor(field)),seed=isSeedField(field);
  const description=[field.presentation?.description||DESCRIPTIONS[field.input]||(seed?'这个数字用于控制生成过程中的随机变化。':'调整工作流中的这个参数。'),seed?'固定会重复使用这个数字；随机会在新建任务时更换，核对旧任务时保持不变。':''].filter(Boolean).join('');
  let input;
  if(field.type==='select')input=`<select ${attr} ${isModel(field)?'data-searchable':''}>${options(field.choices,value,false,field)}</select>`;
  else if(field.type==='boolean')input=`<input ${attr} type="checkbox" ${value?'checked':''}>`;
  else if(field.multiline)input=`<textarea ${attr} rows="3" maxlength="100000">${e(value)}</textarea>`;
  else input=`<input ${attr} type="${field.type==='number'?'number':'text'}" value="${e(value)}" ${field.type==='number'?`required step="${e(field.step??'any')}" ${field.min!==undefined?`min="${e(field.min)}"`:''} ${field.max!==undefined?`max="${e(field.max)}"`:''}`:''}>`;
  if(seed)input=`<div class="drawing-seed-control">${input}<select data-seed-mode="${e(field.key)}" data-searchable="false" aria-label="${e(label)}方式"><option value="fixed" ${seedMode==='fixed'?'selected':''}>固定</option><option value="random" ${seedMode==='random'?'selected':''}>随机</option></select></div>`;
  return `<div class="field ${field.multiline||field.image||isModel(field)||seed?'drawing-wide':''} ${field.type==='boolean'?'drawing-boolean':''}"><div class="field-label"><label for="${e(id)}">${e(label)}</label>${help(description,label+'说明')}</div>${input}${field.image?nativeImageMarkup(field,label):''}${isLora(field)?`<button type="button" class="text-link drawing-field-library" data-lora-library-field="${e(field.key)}">选择角色 LoRA</button>`:''}</div>`;
}

// Keep graph fields and additive controls separate: graph defaults remain unchanged.
export function mountDrawingParameters(root,{ctx,workflow,values,adjustments={},seedModes={},signal,isCurrent,onChange,onBusy,post,connected,report}){
  const find=selector=>root.querySelector(selector),current=()=>!signal.aborted&&root.isConnected&&isCurrent();
  let busy=0,disabled=false,imageControls;
  const lora=workflow.controls?.lora,reference=workflow.controls?.reference,fields=workflow.fields||[];
  const loraNodes=new Set(fields.filter(isLora).map(field=>field.nodeId));
  const referenceResolution=field=>field.input==='resolution'&&workflow.prompt?.[field.nodeId]?.class_type==='TextEncodeQwenImage21';
  const groups={prompts:[],rewrite:[],size:[],sampling:[],lora:[],reference:[],advanced:[]};
  for(const field of fields){
    if(field.presentation?.hidden)continue;
    const group=Object.hasOwn(groups,field.presentation?.section)?field.presentation.section:field.image||referenceResolution(field)?'reference':loraNodes.has(field.nodeId)?'lora':field.multiline?'prompts':['width','height','batch_size','resolution'].includes(field.input)?'size':['seed','noise_seed','steps','cfg','denoise','sampler_name','scheduler'].includes(field.input)?'sampling':'advanced';
    groups[group].push(field);
  }
  groups.prompts.sort((a,b)=>Number(labelFor(a).startsWith('负'))-Number(labelFor(b).startsWith('负')));
  groups.rewrite.sort((a,b)=>Number(b.type==='boolean')-Number(a.type==='boolean'));
  const modeFor=field=>['fixed','random'].includes(seedModes[field.key])?seedModes[field.key]:inferSeedMode(workflow,field);
  const fieldMarkup=items=>`<div class="drawing-fields">${items.map(field=>inputField(field,Object.hasOwn(values,field.key)?values[field.key]:field.value,referenceResolution(field),modeFor(field))).join('')}</div>`;
  const section=(name,title,items,extra='')=>items.length||extra?`<section class="drawing-parameter-group" data-drawing-group="${name}">${name==='prompts'||name==='rewrite'&&items[0]?.type==='boolean'&&labelFor(items[0])===title?'':`<div class="drawing-group-heading"><h3>${title}</h3></div>`}${items.length?fieldMarkup(items):''}${extra}</section>`:'';
  const loraExtra=lora?.available?`<div id="drawing-extra-loras"></div><button type="button" class="text-link" id="drawing-add-lora">${icon('plus')}添加 LoRA</button>`:'';
  const img2img=reference?.mode==='img2img',imageDenoise=Number.isFinite(adjustments.imageDenoise)?adjustments.imageDenoise:reference?.defaultDenoise??0.65;
  const referenceExtra=reference?.available?`<div id="drawing-extra-references"></div><button type="button" class="drawing-image-drop drawing-image-add" id="drawing-add-reference" data-image-drop="reference">${icon('upload')}选择或拖入${img2img?'主图':'参考图'}</button><input type="file" accept="${imageAccept}" data-extra-reference-upload aria-label="选择${img2img?'主图':'参考图'}" ${reference.maxImages>1?'multiple':''} hidden><div class="drawing-field-actions drawing-image-sources" data-reference-sources><select data-reference-existing data-searchable aria-label="从服务已有图片选择"></select><button type="button" class="text-link" id="drawing-reference-library">角色资料</button>${help(`支持 PNG、JPEG、WebP，每张不超过 18 MiB。最多添加 ${reference.maxImages} 张图片。`,'图片格式与数量')}</div><div class="drawing-image-options"><div class="field drawing-reference-size" hidden><div class="field-label"><label for="drawing-reference-size">输出尺寸</label>${help(img2img?'保留主图比例，缩放至约 100 万像素；使用宽高设置会将主图居中裁切。':'跟随主图的宽高比例，并按图片处理尺寸缩放。选择使用宽高设置会改变构图比例。','输出尺寸说明')}</div><select id="drawing-reference-size" data-reference-size><option value="reference">${img2img?'保留主图比例':'跟随主图'}</option><option value="workflow">使用宽高设置</option></select></div>${img2img?`<div class="field" data-image-denoise-field hidden><div class="field-label"><label for="drawing-image-denoise">重绘幅度</label>${help('数值越小越接近主图，越大越容易改变画面。移除主图后恢复原工作流的采样设置。','主图重绘幅度说明')}</div><input id="drawing-image-denoise" data-image-denoise type="number" min="0" max="1" step="any" required value="${e(imageDenoise)}"></div>`:''}</div>`:'';
  const unavailable=()=>!lora?.available&&adjustments.loras?.some(item=>item.name)||!reference?.available&&adjustments.images?.length>0||imageControls?.hasUnavailableImages();
  root.innerHTML=`<fieldset class="drawing-parameter-fields" aria-label="绘图参数">${unavailable()?`<div class="drawing-unavailable-adjustments" id="drawing-unavailable-adjustments" role="status"><span>已保存的附加参数暂不可用</span>${help([lora?.reason,reference?.reason,'连接支持此工作流的 ComfyUI 后，已保存的 LoRA 和参考图会恢复。'].filter(Boolean).join(' '),'附加参数不可用原因')}<button type="button" class="text-link" id="drawing-clear-unavailable">移除不可用参数</button></div>`:''}${section('reference','图片输入',groups.reference,referenceExtra)}${section('prompts','提示词',groups.prompts)}${section('rewrite','提示词改写',groups.rewrite)}${section('size','尺寸',groups.size)}${section('sampling','采样',groups.sampling)}${section('lora','LoRA',groups.lora,loraExtra)}${groups.advanced.length?`<details class="drawing-advanced"><summary>更多参数</summary>${fieldMarkup(groups.advanced)}</details>`:''}</fieldset>`;
  const extraLoras=find('#drawing-extra-loras'),extraImages=find('#drawing-extra-references');
  const sizePresets=mountSizePresets(root,fields);
  let sequence=0;
  function readValues(){const result={};for(const field of fields){const input=find(`[data-parameter="${CSS.escape(field.key)}"]`);result[field.key]=!input?(Object.hasOwn(values,field.key)?values[field.key]:field.value):field.type==='number'?Number(input.value):field.type==='boolean'?input.checked:field.type==='select'?(field.choices.find(value=>String(value)===input.value)??input.value):input.value;}return result;}
  function enabled(field,currentValues=readValues()){return !(field.presentation?.enabledWhen||[]).some(rule=>currentValues[rule.key]!==rule.equals);}
  function validDraft(field,value,input){
    if(input&&!input.validity.valid)return false;
    if(field.type==='number')return input?.value!==''&&Number.isFinite(value)&&(field.min===undefined||value>=field.min)&&(field.max===undefined||value<=field.max)&&(field.step!==1||Number.isInteger(value))&&(!isSeedField(field)||Number.isSafeInteger(value));
    return field.type!=='select'||field.choices.includes(value);
  }
  function readSeedModes(){return {...seedModes,...Object.fromEntries([...root.querySelectorAll('[data-seed-mode]')].map(input=>[input.dataset.seedMode,input.value]))};}
  function readSubmissionValues(){
    const result=readValues();
    for(const field of fields){
      const input=find(`[data-parameter="${CSS.escape(field.key)}"]`),mode=find(`[data-seed-mode="${CSS.escape(field.key)}"]`),active=enabled(field,result);
      // Inactive invalid edits stay in the draft. Submit the valid source value so
      // an uneditable control cannot block the graph's server-side validation.
      if((!active||field.presentation?.hidden||input?.disabled&&!mode)&&!validDraft(field,result[field.key],input))result[field.key]=field.value;
      if(mode?.value==='random'&&active){const value=randomSeed(field);result[field.key]=value;input.value=String(value);input.setCustomValidity('');}
    }
    return result;
  }
  function readDraft(){
    const loras=extraLoras?[...root.querySelectorAll('[data-extra-lora]')].map(row=>({name:row.querySelector('[data-extra-lora-name]').value,modelWeight:Number(row.querySelector('[data-extra-lora-model]').value),clipWeight:Number(row.querySelector('[data-extra-lora-clip]')?.value??1)})):structuredClone(adjustments.loras||[]);
    const images=imageControls?.readImages()||structuredClone(adjustments.images||[]),imageSlots=imageControls?.readSlots()||(!extraImages?adjustments.imageSlots:undefined),denoise=find('[data-image-denoise]');
    return {loras,images,...(images.length?{referenceSize:find('[data-reference-size]')?.value||adjustments.referenceSize||'reference',...(imageSlots?{imageSlots}:{})}:{}),...(denoise?{imageDenoise:denoise.value===''?null:Number(denoise.value)}:Object.hasOwn(adjustments,'imageDenoise')?{imageDenoise:adjustments.imageDenoise}:{})};
  }
  function readAdjustments(){const draft=readDraft();draft.loras=draft.loras.filter(item=>item.name);if(!img2img||!draft.images.length)delete draft.imageDenoise;const primary=reference?.roles?.find(item=>item.role==='primary');if(draft.images.length&&draft.imageSlots&&primary&&!draft.imageSlots.includes(primary.slot))throw new Error('请先选择主图，再添加参考图。');return draft;}
  function sync(){
    find('fieldset').disabled=disabled||busy>0;
    const currentValues=readValues(),hasImages=extraImages?.querySelectorAll('[data-extra-reference]').length>0,referenceSize=hasImages&&find('[data-reference-size]')?.value==='reference';
    for(const field of fields){
      const input=find(`[data-parameter="${CSS.escape(field.key)}"]`);if(!input)continue;
      const active=enabled(field,currentValues),mode=find(`[data-seed-mode="${CSS.escape(field.key)}"]`);
      const imageDenoise=img2img&&hasImages&&field.key===reference.denoiseKey;
      input.disabled=!active||mode?.value==='random'||imageDenoise||referenceSize&&(img2img?(reference.sizeKeys||[]).includes(field.key):['width','height'].includes(field.input));
      if(img2img&&field.key===reference.denoiseKey)input.closest('.field').hidden=Boolean(imageDenoise);
      if(mode)mode.disabled=!active;
    }
    if(extraLoras)find('#drawing-add-lora').disabled=extraLoras.children.length>=16;
    if(extraImages){
      const size=find('[data-reference-size]');size.closest('.field').hidden=!hasImages;size.disabled=!hasImages;
      const denoise=find('[data-image-denoise]');if(denoise){denoise.closest('.field').hidden=!hasImages;denoise.disabled=!hasImages;}
    }
    sizePresets.sync();imageControls?.sync();
  }
  function addLora(value={},focus=false){
    if(extraLoras.children.length>=16)return;
    const row=document.createElement('div'),id='drawing-extra-lora-'+(++sequence);row.className='drawing-extra-lora';row.dataset.extraLora='';
    row.innerHTML=`<div class="field drawing-wide"><label for="${id}">LoRA 文件</label><select id="${id}" data-extra-lora-name data-searchable>${options(lora.choices||[],value.name||'',true)}</select></div><div class="drawing-lora-weights"><div class="field"><label for="${id}-model">模型权重</label><input id="${id}-model" data-extra-lora-model type="number" step="any" min="-100" max="100" required value="${e(value.modelWeight??1)}"></div>${lora.supportsClip===false?'':`<div class="field"><label for="${id}-clip">文本权重</label><input id="${id}-clip" data-extra-lora-clip type="number" step="any" min="-100" max="100" required value="${e(value.clipWeight??1)}"></div>`}<button type="button" class="text-link" data-remove-lora aria-label="移除此附加 LoRA">移除</button></div>`;
    const name=row.querySelector('select'),syncWeights=()=>{row.querySelectorAll('input').forEach(input=>{input.disabled=!name.value;});};name.addEventListener('input',syncWeights);name.addEventListener('change',syncWeights);syncWeights();
    row.querySelector('[data-remove-lora]').onclick=()=>{row.remove();sync();onChange();find('#drawing-add-lora').focus();};extraLoras.append(row);sync();if(focus)row.querySelector('select').focus();
  }
  if(extraLoras){const rows=Array.isArray(adjustments.loras)&&adjustments.loras.length?adjustments.loras:[{}];rows.slice(0,16).forEach(row=>addLora(row));find('#drawing-add-lora').onclick=()=>{addLora({},true);onChange();};}
  if(extraImages){find('[data-reference-size]').value=adjustments.referenceSize==='workflow'?'workflow':'reference';find('[data-reference-size]').addEventListener('change',sync,{signal});}
  if(find('#drawing-clear-unavailable'))find('#drawing-clear-unavailable').onclick=()=>{if(!lora?.available)adjustments.loras=[];if(!reference?.available)adjustments.images=[];find('#drawing-unavailable-adjustments').remove();onChange();onBusy(busy);};
  root.addEventListener('input',event=>{if(event.target.matches('input[type="number"]'))event.target.setCustomValidity('');if(current()){sync();onChange();}},{signal});root.addEventListener('change',()=>{if(current()){sync();onChange();}},{signal});
  root.addEventListener('invalid',event=>{
    const input=event.target;if(!input.matches('input[type="number"]'))return;
    input.setCustomValidity('');const state=input.validity;if(state.valid)return;
    input.setCustomValidity(state.rangeUnderflow?`请输入不小于 ${input.min} 的数字。`:state.rangeOverflow?`请输入不大于 ${input.max} 的数字。`:state.stepMismatch?`请输入符合步长 ${input.step} 的数字。`:'请输入有效数字。');
  },{capture:true,signal});
  imageControls=mountDrawingImages(root,{ctx,workflow,fields,reference,adjustments,signal,current,blocked:()=>disabled||busy>0,connected,post,report,onChange,onBusy:value=>{busy=value?1:0;sync();onBusy(busy);},refresh:sync});
  for(const button of root.querySelectorAll('[data-lora-library-field]'))button.onclick=()=>void openCharacterResources(ctx,{accept:['lora'],onPick:async resource=>{
    if(!connected())throw new Error('请先连接当前 ComfyUI，核对服务可见的 LoRA。');
    const refreshed=await ctx.api('/api/modules/drawing/workflows/'+workflow.id);if(!current()||disabled||busy)return;
    const field=fields.find(item=>item.key===button.dataset.loraLibraryField),next=refreshed.fields.find(item=>item.key===field.key),choices=loraServiceChoices(resource,next?.choices||[]);
    if(!choices.length)throw new Error('当前服务没有列出此 LoRA。请将文件放入该 ComfyUI 的模型目录并重新连接，或使用工作流依赖补全。');
    Object.assign(field,next);const input=find(`[data-parameter="${CSS.escape(field.key)}"]`),previous=input.value;input.innerHTML=options(field.choices,previous);
    if(choices.length>1){input.focus();report('当前服务列出多个同名 LoRA，请在此字段手动选择；文件身份尚未校验。');return;}
    input.value=choices[0];onChange();report('已选择当前服务的同名 LoRA 选项；尚未通过哈希核实文件身份。');
  }});
  sync();
  return {readValues,readSubmissionValues,readSeedModes,readValuesDraft:()=>({...values,...readValues()}),readDraft,readAdjustments,hasUnavailableAdjustments:()=>Boolean(unavailable()),setDisabled(value){disabled=value;sync();}};
}
