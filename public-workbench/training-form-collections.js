import {escape as e,icon} from './components.js';
import {mountPathPicker,syncPathPickers} from './path-picker.js';

export const isTrainingCollection=field=>field.type==='array'&&['reference-paths','preview-samples'].includes(field.role);
const newSample=()=>({prompt:'',width:1024,height:1024,seed:42,guidance_scale:4,sample_steps:20,controlImages:[]});
const sampleLabels={width:'宽度',height:'高度',seed:'种子',guidance_scale:'CFG',sample_steps:'采样步数'};

function decodeSamples(value){
  if(!Array.isArray(value))throw new Error('预览样例必须是数组。');
  return value.map((text,index)=>{
    let sample;try{sample=JSON.parse(text);}catch{throw new Error(`第 ${index+1} 个预览样例不是有效 JSON。`);}
    if(!sample||typeof sample!=='object'||Array.isArray(sample)||typeof sample.prompt!=='string')throw new Error(`第 ${index+1} 个预览样例需要提示词。`);
    const result={...newSample(),...sample};
    if(!Array.isArray(result.controlImages)||result.controlImages.some(path=>typeof path!=='string'))throw new Error(`第 ${index+1} 个预览样例的参考图必须是路径数组。`);
    return result;
  });
}

export function validateTrainingCollection(field,value,{editing=false,schemaName=''}={}){
  if(!isTrainingCollection(field)||value===undefined)return;
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new Error('每项必须是字符串。');
  if(field.min!==undefined&&value.length<field.min)throw new Error(`至少需要 ${field.min} 项。`);
  if(field.max!==undefined&&value.length>field.max)throw new Error(`最多添加 ${field.max} 项。`);
  if(field.required&&!value.length)throw new Error('请至少填写一项。');
  if(field.role==='reference-paths'){
    if(value.some(path=>!path.trim()))throw new Error('请填写参考目录，或移除空白项。');
    return;
  }
  if(!value.length)throw new Error('请至少添加一个预览样例。');
  const multiple=Number(field.extra?.dimensionStep||1),minGuidance=Number(field.extra?.minGuidance||0);
  for(const [index,sample] of decodeSamples(value).entries()){
    const toolkit=schemaName.startsWith('ai-toolkit-')||schemaName==='klein-lora';
    if(toolkit&&!sample.prompt.trim())throw new Error(`样例 ${index+1} 需要填写提示词。`);
    if(editing&&(!sample.controlImages.length||sample.controlImages.some(path=>!path.trim())))throw new Error(`样例 ${index+1} 至少需要一张参考图的非空路径。`);
    if(toolkit&&sample.controlImages.length>3)throw new Error(`样例 ${index+1} 最多支持 3 张参考图。`);
    for(const key of ['width','height'])if(!Number.isSafeInteger(sample[key])||sample[key]<multiple||sample[key]%multiple!==0)throw new Error(`样例 ${index+1} 的${sampleLabels[key]}须为 ${multiple} 的正整数倍。`);
    if(!Number.isSafeInteger(sample.seed)||sample.seed<0)throw new Error(`样例 ${index+1} 的种子须为非负整数。`);
    if(!Number.isSafeInteger(sample.sample_steps)||sample.sample_steps<1)throw new Error(`样例 ${index+1} 的采样步数须为正整数。`);
    if(typeof sample.guidance_scale!=='number'||!Number.isFinite(sample.guidance_scale)||sample.guidance_scale<minGuidance)throw new Error(`样例 ${index+1} 的 CFG 须不小于 ${minGuidance}。`);
  }
}

export function mountTrainingCollection(root,{field,value,prefix,editing=false,readOnly=false,pathContext,trainingType,signal,onChange}){
  const controller=new AbortController();let current=structuredClone(value??[]),isEditing=editing,disabled=readOnly,pathPickers=[];
  let entries=[],parseError='';
  const emit=()=>onChange(field.role==='preview-samples'?entries.map(sample=>JSON.stringify(sample)):[...entries]);
  const removeButton=(attributes,label)=>`<button type="button" class="button ghost small training-collection-remove" ${attributes} aria-label="${e(label)}">${icon('close')}</button>`;
  function pathRows(paths,sampleIndex){
    return (paths.length?paths:['']).map((path,index)=>{
      const id=`${prefix}-path-${sampleIndex??'list'}-${index}`,sampleAttr=sampleIndex===undefined?'':`data-reference-sample="${sampleIndex}"`;
      return `<div class="training-collection-path-row"><label class="sr-only" for="${e(id)}">${sampleIndex===undefined?'参考图目录':'预览参考图'} ${index+1}</label><input id="${e(id)}" type="text" spellcheck="false" autocomplete="off" data-collection-path="${index}" ${sampleAttr} value="${e(path)}">${removeButton(`data-remove-path="${index}" ${sampleAttr}`,`移除${sampleIndex===undefined?'目录':'参考图'} ${index+1}`)}</div>`;
    }).join('');
  }
  function setDisabled(){
    for(const control of root.querySelectorAll('input,textarea,button'))control.disabled=disabled||!!parseError;
    const add=root.querySelector('[data-collection-add]');if(add&&field.max!==undefined&&entries.length>=field.max)add.disabled=true;
    syncPathPickers(root);
  }
  function render(){
    pathPickers.forEach(dispose=>dispose());pathPickers=[];parseError='';
    try{entries=field.role==='preview-samples'?decodeSamples(current):[...current];if(!Array.isArray(current)||entries.some(item=>field.role==='reference-paths'&&typeof item!=='string'))throw new Error('参考目录必须是字符串数组。');}
    catch(error){entries=[];parseError=error.message;}
    if(parseError){root.innerHTML=`<p class="training-field-error" role="alert">${e(parseError)} 请在下方数组 JSON 中修正。</p>`;return;}
    if(field.role==='reference-paths')root.innerHTML=`<div class="training-reference-list">${pathRows(entries)}</div><button type="button" class="button small" data-collection-add>${icon('plus')}添加目录</button>`;
    else root.innerHTML=entries.map((sample,index)=>`<fieldset class="training-preview-sample" data-sample-index="${index}"><legend>样例 ${index+1}</legend><div class="training-sample-heading">${removeButton(`data-remove-sample="${index}"`,`移除样例 ${index+1}`)}</div><label for="${e(prefix)}-sample-${index}-prompt">${isEditing?'编辑指令':'提示词'}</label><textarea id="${e(prefix)}-sample-${index}-prompt" data-sample-key="prompt" data-sample-index="${index}" rows="2" spellcheck="false">${e(sample.prompt)}</textarea><div class="training-sample-settings">${Object.entries(sampleLabels).map(([key,label])=>{
      const dimension=key==='width'||key==='height',min=dimension?field.extra?.dimensionStep||1:key==='guidance_scale'?field.extra?.minGuidance||0:key==='seed'?0:1,step=dimension?field.extra?.dimensionStep||1:key==='guidance_scale'?0.1:1;
      return `<div><label for="${e(prefix)}-sample-${index}-${key}">${label}</label><input id="${e(prefix)}-sample-${index}-${key}" data-sample-key="${key}" data-sample-index="${index}" type="number" min="${e(min)}" step="${e(step)}" value="${e(sample[key]??'')}"></div>`;
    }).join('')}</div>${isEditing?`<div class="training-sample-references"><span>参考图</span>${pathRows(sample.controlImages,index)}<button type="button" class="button small" data-add-path="${index}">${icon('plus')}添加参考图</button></div>`:''}</fieldset>`).join('')+`<button type="button" class="button small" data-collection-add>${icon('plus')}添加样例</button>`;
    if(pathContext&&!readOnly)for(const input of root.querySelectorAll('[data-collection-path]'))pathPickers.push(mountPathPicker(input,pathContext,{moduleId:'training',target:'training',field:field.key,kind:field.role==='reference-paths'?'directory':'file',trainingType}));
    setDisabled();
  }
  function save({redraw=false}={}){
    current=field.role==='preview-samples'?entries.map(sample=>JSON.stringify(sample)):[...entries];
    if(redraw)render();
    emit();
  }
  root.addEventListener('input',event=>{
    if(disabled)return;const node=event.target;
    if(node.dataset.sampleKey!==undefined){const sample=entries[Number(node.dataset.sampleIndex)];if(!sample)return;sample[node.dataset.sampleKey]=node.dataset.sampleKey==='prompt'?node.value:Number.isFinite(node.valueAsNumber)?node.valueAsNumber:null;save();}
    else if(node.dataset.collectionPath!==undefined){
      const paths=node.dataset.referenceSample===undefined?entries:entries[Number(node.dataset.referenceSample)]?.controlImages;
      if(!paths)return;paths[Number(node.dataset.collectionPath)]=node.value;save();
    }
  },{signal:controller.signal});
  root.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled||disabled)return;
    if(button.hasAttribute('data-collection-add')){entries.push(field.role==='preview-samples'?newSample():'');save({redraw:true});}
    else if(button.hasAttribute('data-remove-sample')){entries.splice(Number(button.dataset.removeSample),1);save({redraw:true});}
    else if(button.hasAttribute('data-add-path')){entries[Number(button.dataset.addPath)].controlImages.push('');save({redraw:true});}
    else if(button.hasAttribute('data-remove-path')){const paths=button.dataset.referenceSample===undefined?entries:entries[Number(button.dataset.referenceSample)].controlImages;paths.splice(Number(button.dataset.removePath),1);save({redraw:true});}
  },{signal:controller.signal});
  const dispose=()=>{controller.abort();pathPickers.forEach(fn=>fn());pathPickers=[];};
  signal?.addEventListener('abort',dispose,{once:true,signal:controller.signal});
  render();
  return {dispose,update(next,{editing=isEditing,disabled:nextDisabled=disabled,preserveValue=false}={}){const value=preserveValue?current:next??[],changed=JSON.stringify(current)!==JSON.stringify(value)||editing!==isEditing;current=structuredClone(value);isEditing=editing;disabled=nextDisabled;if(changed)render();else setDisabled();}};
}
