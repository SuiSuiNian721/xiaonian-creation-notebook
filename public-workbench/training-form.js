import {escape as e,help,icon} from './components.js';
import {fieldLabel,fieldHelp,conditionsMatch,fillTrainingDefaults,parseFieldValue,displaySections,clearModelComponents,trainingDuration,trainingSubmission} from './training-form-fields.js';
import {mountPathPicker,syncPathPickers} from './path-picker.js';
import {trainingPathKind} from './path-kinds.js';
import {isTrainingCollection,mountTrainingCollection,validateTrainingCollection} from './training-form-collections.js';

const typeNames={'moss-image-lora':'MOSS-Image','anima-lora':'Anima','sd3-lora':'Anima（兼容配置）','sd-lora':'SD 1.5','sdxl-lora':'SDXL','flux-lora':'Flux','lumina-lora':'Lumina','moss-image-anima-lora':'MOSS · 独立引擎','sd-dreambooth':'SD 1.5 · 全模型微调','sdxl-finetune':'SDXL · 全模型微调','anima-finetune':'Anima · 全模型微调','flux-finetune':'Flux 全量微调 · JSON'};
export const typeName=value=>typeNames[value]||value;
export const emptyConfig=output=>({model_train_type:'moss-image-lora',output_name:'',output_dir:output||'',train_data_dir:'',pretrained_model_name_or_path:'',network_dim:16,network_alpha:16,learning_rate:0.0001,train_batch_size:1,max_train_epochs:8,resolution:'768,768',mixed_precision:'bf16',gradient_checkpointing:true});
export function parseTrainingConfig(text){
  if(text.length>1024*1024)throw new Error('配置超过 1 MiB，请缩减后重试。');
  let value;try{value=JSON.parse(text);}catch{throw new Error('配置不是有效的 JSON，请检查逗号、引号和括号。');}
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.model_train_type!=='string')throw new Error('配置需要是含 model_train_type 的 JSON 对象。');
  return value;
}

export function mountTrainingForm(root,{config,rawJson=null,catalog=[],schema=null,readOnly=false,idPrefix=null,signal,onChange,onJsonChange,onError,pathContext}){
  if(!document.querySelector('link[data-training-parameters-style]')){
    const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./training-parameters.css',import.meta.url).href;link.dataset.trainingParametersStyle='';document.head.append(link);
  }
  const limitFor=value=>value.max_train_epochs!==undefined&&value.max_train_epochs!==null&&value.max_train_epochs!==''?'epochs':Object.hasOwn(value,'max_train_steps')?'steps':'epochs';
  const limitKey=mode=>mode==='steps'?'max_train_steps':'max_train_epochs';
  const prefix=idPrefix||(readOnly?'training-snapshot-':'training-');
  let current=structuredClone(config),types=catalog,descriptor=schema,unapplied=readOnly?null:rawJson,limitMode=limitFor(config),query='',rows=[],sections=[],previousTypeFields=null;
  const omitted=new Set(),errors=new Map(),fieldDrafts=new Map(),expanded=new Map(),defaultOrigins=new Map();let pathPickers=[];
  const sectionKey=section=>(descriptor?.schemaName||current.model_train_type)+':'+section.id;
  const json=()=>root.querySelector('[data-training-json]');
  const updateJson=()=>{const node=json();if(node&&unapplied===null)node.value=JSON.stringify(current,null,2);};
  function reconcileType(){
    if(!previousTypeFields||!descriptor)return;
    const nextFields=displaySections(descriptor,current).flatMap(section=>section.fields),byKey=new Map();
    for(const field of nextFields){const group=byKey.get(field.key)||[];group.push(field);byKey.set(field.key,group);}
    for(const key of new Set(previousTypeFields.map(field=>field.key))){
      if(key==='model_train_type'||!Object.hasOwn(current,key))continue;
      const candidates=byKey.get(key),value=current[key];
      if(!candidates){delete current[key];continue;}
      if(value===null||value==='')continue;
      const accepts=field=>field.type==='const'?value===field.constValue:field.options?field.options.includes(value):field.type==='array'?Array.isArray(value):typeof value===field.type;
      if(candidates.some(accepts))continue;
      if(typeof value==='number'&&candidates.some(field=>field.type==='string'&&!field.options))current[key]=String(value);
      else if(typeof value==='string'&&value.trim()&&Number.isFinite(Number(value))&&candidates.some(field=>field.type==='number'&&!field.options))current[key]=Number(value);
      else delete current[key];
    }
    previousTypeFields=null;
  }
  function applyDefaults(){
    if(readOnly)return;
    for(const [key,origin] of defaultOrigins){
      if(JSON.stringify(current[key])!==JSON.stringify(origin.value)){defaultOrigins.delete(key);continue;}
      if(!conditionsMatch(origin.conditions,current)){delete current[key];defaultOrigins.delete(key);}
    }
    const previous=current;current=fillTrainingDefaults(descriptor,current,{limitMode,omitted});
    for(const field of (descriptor?.sections||[]).flatMap(section=>section.fields||[])){
      if(field.key==='model_train_type'||!conditionsMatch(field.conditions,current)||!Object.hasOwn(current,field.key))continue;
      // Conditional constants are derived from their visible controlling choice.
      // An imported custom override remains explicit when it differs from it.
      if(!Object.hasOwn(previous,field.key)||(field.type==='const'&&field.conditions?.length&&current[field.key]===field.constValue))defaultOrigins.set(field.key,{value:structuredClone(current[field.key]),conditions:field.conditions||[]});
    }
  }
  function notify(){
    if(readOnly)return;
    onChange?.(structuredClone(current));
    if(unapplied!==null)onJsonChange?.(unapplied);
  }
  function typeOptions(){
    const list=types.some(type=>type.train_type===current.model_train_type)?types:[{train_type:current.model_train_type,bundled:true},...types];
    return list.map(type=>`<option value="${e(type.train_type)}" ${type.train_type===current.model_train_type?'selected':''} ${type.control_supported!==true&&type.bundled===false?'disabled':''}>${e(typeName(type.train_type))}${type.control_supported!==true&&type.bundled===false?' · 尚未内置':''}</option>`).join('');
  }
  function fieldMarkup(field,sectionIndex){
    if((field.hidden&&field.role!=='external-control')||field.key==='model_train_type')return '';
    const index=rows.length,label=fieldLabel(field),value=current[field.key],id=prefix+field.key;
    const wide=field.role==='filepicker'||field.role==='textarea'||field.type==='array'||field.key==='ui_custom_params';
    const attributes=`data-training-field="${e(field.key)}" data-training-index="${index}" autocomplete="off"`;
    let control;
    if(field.options){
      const selected=field.options.findIndex(option=>option===value);
      control=`<select id="${e(id)}" ${attributes}><option value="" ${selected<0?'selected':''}>${value===undefined||value===null?'未设置':e(value)}</option>${field.options.map((option,optionIndex)=>`<option value="${e(option)}" data-option-index="${optionIndex}" ${selected===optionIndex?'selected':''}>${e(option)}</option>`).join('')}</select>`;
    }else if(field.type==='boolean')control=`<input id="${e(id)}" type="checkbox" ${attributes} ${value===true?'checked':''}>`;
    else if(field.type==='array'||field.role==='textarea'||field.key==='ui_custom_params'){
      const text=fieldDrafts.get(field.key)??(field.type==='array'?(value===undefined?'':JSON.stringify(value,null,2)):(value??''));
      control=`<textarea id="${e(id)}" ${attributes} rows="${field.type==='array'?3:4}" spellcheck="false" ${readOnly&&!Object.hasOwn(current,field.key)?'placeholder="未提交"':''}>${e(text)}</textarea>`;
    }else control=`<input id="${e(id)}" ${attributes} type="${field.type==='number'?'number':/api_key|password|secret/i.test(field.key)?'password':'text'}" ${field.type==='number'?`step="${e(field.step??'any')}" ${field.min!==undefined?`min="${e(field.min)}"`:''} ${field.max!==undefined?`max="${e(field.max)}"`:''}`:'spellcheck="false"'} value="${e(fieldDrafts.get(field.key)??value??'')}" ${readOnly&&!Object.hasOwn(current,field.key)?'placeholder="未提交"':''}>`;
    if(isTrainingCollection(field))control=`<div data-training-collection="${e(field.key)}" role="group" aria-label="${e(label)}"></div><details class="training-collection-json"><summary>数组 JSON</summary>${control}</details>`;
    const description=[fieldHelp(field),field.type==='array'&&!isTrainingCollection(field)?'每行填写一项，或粘贴 JSON 数组。':null].filter(Boolean).join('\n');
    rows.push({field,sectionIndex,index,search:[label,field.key,field.description||''].join(' ').toLocaleLowerCase()});
    return `<div class="field training-native-field ${wide?'training-native-wide':''} ${field.type==='boolean'&&!field.options?'training-native-toggle':''}" data-training-field-row="${index}"><div class="field-label"><label for="${e(id)}"><span>${e(label)}</span>${field.required?'<span class="sr-only">（必填）</span>':''}</label>${help(description,label+'说明')}</div>${control}<p class="training-field-error" data-training-error id="${e(prefix)}error-${index}" role="alert" hidden></p></div>`;
  }
  function draw(){
    const active=document.activeElement,focus=root.contains(active)?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
    pathPickers.forEach(dispose=>dispose());pathPickers=[];rows.forEach(row=>row.collection?.dispose());
    const jsonOpen=root.querySelector('.training-parameter-json')?.open;
    if(!query)for(const node of root.querySelectorAll('details[data-training-section]')){
      const section=sections[Number(node.dataset.sectionIndex)];if(section)expanded.set(sectionKey(section),node.open);
    }
    rows=[];sections=displaySections(descriptor,current);
    let hasLimitControl=false;
    root.innerHTML=`<div class="training-parameters-tools"><div class="field"><label for="${e(prefix)}model_train_type">训练类型</label><select id="${e(prefix)}model_train_type" data-training-type ${readOnly?'disabled':''}>${typeOptions()}</select></div><div class="field training-parameter-search"><label class="sr-only" for="${e(prefix)}parameter-search">搜索参数</label><div>${icon('search')}<input id="${e(prefix)}parameter-search" data-training-search type="search" value="${e(query)}" placeholder="搜索参数" autocomplete="off" spellcheck="false"></div></div></div><div class="training-native-sections">${sections.map((section,sectionIndex)=>{
      if(!section.fields.length)return `<p class="training-parameter-note" data-training-section="${e(section.id)}" data-section-index="${sectionIndex}" role="note">${e(section.title)}</p>`;
      const open=expanded.get(sectionKey(section))??/训练用模型|数据集设置|保存设置|^训练设置$|^训练时长$/.test(section.title);
      const fields=section.fields.map(field=>{
        let limitControl='';
        if(trainingDuration(descriptor).kind==='choice'&&!hasLimitControl&&['max_train_epochs','max_train_steps'].includes(field.key)){
          hasLimitControl=true;limitControl=`<div class="field training-limit-field"><label for="${e(prefix)}limit-mode">训练时长</label><select id="${e(prefix)}limit-mode" data-training-limit-mode ${readOnly?'disabled':''}><option value="epochs" ${limitMode==='epochs'?'selected':''}>按轮数</option><option value="steps" ${limitMode==='steps'?'selected':''}>按步数</option></select></div>`;
        }
        return limitControl+fieldMarkup(field,sectionIndex);
      }).join('');
      return `<details class="training-parameter-section" data-training-section="${e(section.id)}" data-section-index="${sectionIndex}" ${open?'open':''}><summary><span>${e(section.title)}</span>${icon('chevron')}</summary><div class="training-native-grid">${fields}</div></details>`;
    }).join('')}</div><p class="training-parameter-empty" role="status" hidden>没有匹配的参数</p><details class="training-advanced training-parameter-json"><summary>完整参数 JSON ${help('未知高级参数会保留。编辑 JSON 后点击“应用参数”。','完整参数说明')}</summary><label class="sr-only" for="${e(prefix)}json">完整训练参数</label><textarea id="${e(prefix)}json" data-training-json rows="14" spellcheck="false" ${readOnly?'readonly':''}>${e(unapplied??JSON.stringify(current,null,2))}</textarea><button class="button small" type="button" id="${e(prefix)}apply-json" data-training-apply-json ${readOnly?'disabled':''}>应用参数</button></details>`;
    for(const row of rows){
      row.node=root.querySelector(`[data-training-field-row="${row.index}"]`);row.control=row.node.querySelector('[data-training-field]');row.label=row.node.querySelector('label');
      if(row.field.type==='boolean'&&readOnly&&!Object.hasOwn(current,row.field.key))row.control.indeterminate=true;
      showError(row,errors.get(row.field.key));
      if(isTrainingCollection(row.field))row.collection=mountTrainingCollection(row.node.querySelector('[data-training-collection]'),{field:row.field,value:current[row.field.key],prefix:prefix+'collection-'+row.index,editing:current.training_task==='image-edit',readOnly,pathContext,trainingType:()=>current.model_train_type,signal,onChange:value=>{row.control.value=JSON.stringify(value,null,2);updateField(row.control);}});
    }
    if(pathContext&&!readOnly)for(const row of rows){const kind=row.field.type==='string'&&trainingPathKind(row.field,current.model_train_type);if(kind)pathPickers.push(mountPathPicker(row.control,pathContext,{moduleId:'training',target:'training',field:row.field.key,kind,trainingType:()=>current.model_train_type}));}
    refreshVisibility();
    if(jsonOpen!==undefined)root.querySelector('.training-parameter-json').open=jsonOpen;
    const focused=focus&&root.querySelector('[id="'+CSS.escape(focus.id)+'"]');
    if(focused&&!focused.disabled&&!focused.closest('[hidden]')){
      focused.focus({preventScroll:true});
      if(focus.start!==null&&focus.start!==undefined&&typeof focused.setSelectionRange==='function')focused.setSelectionRange(focus.start,focus.end);
    }
  }
  function showError(row,message){
    const node=row.node.querySelector('[data-training-error]');node.hidden=!message;node.textContent=message||'';
    row.control.setCustomValidity(message||'');
    if(message){row.control.setAttribute('aria-invalid','true');row.control.setAttribute('aria-describedby',node.id);}
    else{row.control.removeAttribute('aria-invalid');row.control.removeAttribute('aria-describedby');}
  }
  function syncValues(source=null){
    for(const row of rows){
      if(row.control===source||fieldDrafts.has(row.field.key))continue;
      const value=current[row.field.key];
      if(row.field.options){
        const optionIndex=row.field.options.findIndex(option=>option===value);
        row.control.selectedIndex=optionIndex+1;
      }else if(row.field.type==='boolean')row.control.checked=value===true;
      else row.control.value=row.field.type==='array'?(value===undefined?'':JSON.stringify(value,null,2)):(value??'');
    }
  }
  function refreshVisibility(){
    const term=query.trim().toLocaleLowerCase(),assigned=new Set(),primaries=new Map();let visibleSections=0;
    for(const row of rows){
      const section=sections[row.sectionIndex],duration=trainingDuration(descriptor).kind==='choice'&&['max_train_epochs','max_train_steps'].includes(row.field.key);
      row.active=conditionsMatch(section.conditions,current)&&conditionsMatch(row.field.conditions,current)&&(!duration||row.field.key===limitKey(limitMode));
      if(row.active&&assigned.has(row.field.key))row.active=false;
      if(row.active)assigned.add(row.field.key);
      if(row.active||!primaries.has(row.field.key))primaries.set(row.field.key,row.index);
      row.node.hidden=!row.active||(!!term&&!row.search.includes(term)&&!section.title.toLocaleLowerCase().includes(term));
      const locked=readOnly||row.field.disabled||row.field.type==='const';
      row.control.disabled=!row.active||!!row.field.disabled||(locked&&(row.control.tagName==='SELECT'||row.field.type==='boolean'));
      row.control.readOnly=!!locked;
      row.control.required=!!row.field.required&&row.active&&!readOnly&&!locked;
      if(row.collection)row.collection.update(current[row.field.key],{editing:current.training_task==='image-edit',disabled:!row.active||!!locked,preserveValue:fieldDrafts.has(row.field.key)});
    }
    syncPathPickers(root);
    for(const row of rows){const id=prefix+row.field.key+(primaries.get(row.field.key)===row.index?'':'--inactive-'+row.index);row.control.id=id;row.label.htmlFor=id;}
    for(const [sectionIndex,section] of sections.entries()){
      const node=root.querySelector(`[data-section-index="${sectionIndex}"]`),matching=rows.some(row=>row.sectionIndex===sectionIndex&&!row.node.hidden);
      const active=conditionsMatch(section.conditions,current);
      node.hidden=!active||(section.fields.length?!matching:(!!term&&!section.title.toLocaleLowerCase().includes(term)));
      if(!node.hidden)visibleSections++;
      if(node.tagName==='DETAILS'&&term&&!node.hidden)node.open=true;
      else if(node.tagName==='DETAILS'&&!term&&expanded.has(sectionKey(section)))node.open=expanded.get(sectionKey(section));
    }
    const mode=root.querySelector('.training-limit-field');if(mode)mode.hidden=!!term&&!['训练时长','max_train_epochs','max_train_steps'].some(text=>text.includes(term));
    root.querySelector('.training-parameter-empty').hidden=!term||visibleSections>0;
  }
  function updateField(node){
    const row=rows[Number(node.dataset.trainingIndex)];
    if(!row||!row.active||readOnly||row.field.disabled||row.field.type==='const')return;
    let value;
    try{
      value=parseFieldValue(node,row.field);
      validateTrainingCollection(row.field,value,{editing:current.training_task==='image-edit',schemaName:descriptor?.schemaName});
    }catch(error){
      const message=fieldLabel(row.field)+'：'+error.message;errors.set(row.field.key,message);fieldDrafts.set(row.field.key,node.value);showError(row,message);onError?.(message);return;
    }
    errors.delete(row.field.key);fieldDrafts.delete(row.field.key);defaultOrigins.delete(row.field.key);showError(row);
    if(value===undefined){delete current[row.field.key];omitted.add(row.field.key);}else{current[row.field.key]=value;omitted.delete(row.field.key);}
    applyDefaults();syncValues(node);refreshVisibility();updateJson();notify();
  }
  root.addEventListener('input',event=>{
    const node=event.target;
    if(node.hasAttribute('data-training-search')){
      if(!query&&node.value)for(const [index,section] of sections.entries()){const sectionNode=root.querySelector(`[data-section-index="${index}"]`);if(sectionNode.tagName==='DETAILS')expanded.set(sectionKey(section),sectionNode.open);}
      query=node.value;refreshVisibility();return;
    }
    if(readOnly)return;
    if(node.hasAttribute('data-training-json')){unapplied=node.value;onJsonChange?.(unapplied);return;}
    if(node.dataset.trainingIndex!==undefined)updateField(node);
  },{signal});
  root.addEventListener('change',event=>{
    if(readOnly)return;
    const node=event.target;
    if(node.hasAttribute('data-training-limit-mode')){
      limitMode=node.value;const discarded=limitKey(limitMode==='steps'?'epochs':'steps');
      delete current[discarded];errors.delete(discarded);fieldDrafts.delete(discarded);
      for(const row of rows)if(row.field.key===discarded)showError(row);
      applyDefaults();syncValues();refreshVisibility();updateJson();notify();return;
    }
    if(node.hasAttribute('data-training-type')){
      previousTypeFields=[...(previousTypeFields||[]),...displaySections(descriptor,current).flatMap(section=>section.fields)];
      for(const [key,origin] of defaultOrigins)if(JSON.stringify(current[key])===JSON.stringify(origin.value))delete current[key];
      defaultOrigins.clear();current=clearModelComponents(current,descriptor);current.model_train_type=node.value;descriptor=null;omitted.clear();errors.clear();fieldDrafts.clear();draw();notify();return;
    }
    if(node.dataset.trainingIndex!==undefined&&(node.type==='checkbox'||node.tagName==='SELECT'))updateField(node);
  },{signal});
  root.addEventListener('toggle',event=>{
    if(query||!event.target.matches('details[data-training-section]'))return;
    const section=sections[Number(event.target.dataset.sectionIndex)];if(section)expanded.set(sectionKey(section),event.target.open);
  },{signal,capture:true});
  root.addEventListener('invalid',event=>{
    if(event.target.dataset.trainingIndex===undefined)return;
    if(query){query='';root.querySelector('[data-training-search]').value='';refreshVisibility();}
    const section=event.target.closest('details[data-training-section]');if(section)section.open=true;
  },{signal,capture:true});
  root.addEventListener('click',event=>{
    if(readOnly||!event.target.closest('[data-training-apply-json]'))return;
    try{replace(parseTrainingConfig(json().value));}catch(error){onError?.(error.message);}
  },{signal});
  function replace(value,{changeType=false}={}){
    if(value.model_train_type!==current.model_train_type){previousTypeFields=changeType?[...(previousTypeFields||[]),...displaySections(descriptor,current).flatMap(section=>section.fields)]:null;descriptor=null;}
    current=structuredClone(value);limitMode=limitFor(current);unapplied=null;omitted.clear();errors.clear();fieldDrafts.clear();defaultOrigins.clear();applyDefaults();draw();notify();
  }
  applyDefaults();draw();
  return {
    value(){const invalid=rows.find(row=>row.active&&errors.has(row.field.key));if(invalid)throw new Error(errors.get(invalid.field.key));if(!readOnly)for(const row of rows)if(row.active)validateTrainingCollection(row.field,current[row.field.key],{editing:current.training_task==='image-edit',schemaName:descriptor?.schemaName});return structuredClone(current);},
    submission(){return trainingSubmission(descriptor,this.value());},
    hasUnapplied:()=>unapplied!==null||rows.some(row=>{if(!row.active)return false;if(errors.has(row.field.key))return true;try{if(!readOnly)validateTrainingCollection(row.field,current[row.field.key],{editing:current.training_task==='image-edit',schemaName:descriptor?.schemaName});return false;}catch{return true;}}),
    replace,
    catalog(value){types=value;root.querySelector('[data-training-type]').innerHTML=typeOptions();},
    schema(value){if(JSON.stringify(descriptor)===JSON.stringify(value))return;const before=JSON.stringify(current);descriptor=value;reconcileType();applyDefaults();draw();if(!readOnly&&unapplied===null&&JSON.stringify(current)!==before)notify();},
  };
}
