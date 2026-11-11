import {escape as e,help} from './components.js';
import {captionPresets,buildCaptionPrompt} from './training-caption-prompts.js';
import {taggerOptionFields} from './training-tagger-options.js';
import {captionerOptions,resolveCaptioner} from './training-captioners.js';

let instance=0;

export function mountTrainingCaptionSettings(root,ctx,{getValue,onChange,onPrepareCaptioner,onCancelCaptioner}){
  const controller=new AbortController(),prefix='training-caption-'+(++instance),find=selector=>root.querySelector(selector);
  let disabled=false,preparing=null,preparationError=null;
  const label=(id,text,description)=>`<div class="field-label"><label for="${e(id)}">${e(text)}</label>${description?help(description,text+'说明'):''}</div>`;
  const optionMarkup=field=>{
    const id=prefix+'-'+field.key,attributes=`id="${e(id)}" data-caption-option="${e(field.key)}"`;
    if(field.type==='boolean')return `<div class="training-caption-toggle"><label for="${e(id)}"><input ${attributes} type="checkbox">${e(field.label)}</label>${field.tooltip?help(field.tooltip,field.label+'说明'):''}</div>`;
    const control=field.type==='select'?`<select ${attributes}>${field.options.map(item=>{const option=typeof item==='string'?{value:item,label:item}:item;return `<option value="${e(option.value)}">${e(option.label)}</option>`;}).join('')}</select>`:`<input ${attributes} type="${field.type}" ${field.type==='number'?`min="${field.min}" max="${field.max}" step="${field.step}" required`:'maxlength="4000"'}>`;
    return `<div class="field${field.key==='additional_tags'?' training-caption-wide':''}">${label(id,field.label,field.tooltip)}${control}</div>`;
  };
  root.classList.add('training-caption-settings');
  root.innerHTML=`<div class="field training-caption-source">${label(prefix+'-source','打标来源','本地模型在本机处理图片。接入 AI 会逐张发送图集工作副本到训练模块已连接的 AI；原图与原标注保留。')}<select id="${prefix}-source" data-caption-source><option value="local">本地模型</option><option value="connected">接入 AI</option></select></div>
    <div data-caption-local><div class="field">${label(prefix+'-captioner','打标器','自动匹配随底模选择自然语言或标签打标器；也可手动指定。下载只准备选中的打标器，不启动图集处理或训练。')}<div class="training-caption-model-row"><select id="${prefix}-captioner" data-captioner data-caption-tagger><option value="auto">自动匹配</option>${captionerOptions.map(option=>`<option value="${e(option.value)}">${e(option.label)}</option>`).join('')}</select><button type="button" class="button" data-caption-prepare>下载打标器</button><button type="button" class="button ghost" data-caption-cancel hidden>取消下载</button></div><p class="training-caption-download-status" data-caption-download-status role="status" aria-live="polite"></p></div>
    <div data-caption-local-tags><details class="training-caption-native" data-caption-native-options><summary>打标参数</summary><div class="training-caption-options">${['number','select','text'].flatMap(type=>taggerOptionFields.filter(field=>field.type===type)).map(optionMarkup).join('')}<div class="training-caption-toggles">${taggerOptionFields.filter(field=>field.type==='boolean').map(optionMarkup).join('')}</div></div></details></div></div>
    <div data-caption-ai hidden><div class="field">${label(prefix+'-preset','标注预设')}<output id="${prefix}-preset" class="training-caption-value"><span data-caption-preset></span><span data-caption-preset-help></span></output></div><div class="field">${label(prefix+'-supplement','补充提示词','在所选用途的标注规则上补充内容侧重点。标注语言与输出格式由工作台统一处理。')}<textarea id="${prefix}-supplement" data-caption-ai-supplement rows="3" maxlength="4000" placeholder="可留空，使用当前用途的预设"></textarea></div><details class="training-caption-rules"><summary>查看标注规则</summary><pre data-caption-prompt-preview></pre></details></div>`;

  function setDisabled(value=disabled){
    disabled=!!value;
    for(const control of root.querySelectorAll('input,select,textarea'))control.disabled=disabled||!!control.closest('[data-caption-local-tags],[data-caption-local],[data-caption-ai]')?.hidden;
    refreshPreparation();
  }
  function assign(control,value){if(document.activeElement!==control)control.value=value??'';}
  function preparationState(value,captioner){
    const saved=value.captionerPreparation?.id===captioner.id?value.captionerPreparation:{};
    return preparing===captioner.id?{...saved,status:'preparing'}:saved;
  }
  function refreshPreparation(){
    const value=getValue()||{},captioner=resolveCaptioner(value),state=preparationState(value,captioner),active=state.status==='preparing',ready=state.status==='ready';
    if(ready&&preparationError?.id===captioner.id)preparationError=null;
    const error=preparationError?.id===captioner.id?preparationError.message:state.error;
    const button=find('[data-caption-prepare]'),cancel=find('[data-caption-cancel]'),status=find('[data-caption-download-status]');
    button.disabled=disabled||value.captionSource==='connected'||!!preparing||active||ready||typeof onPrepareCaptioner!=='function';
    button.textContent=active?'正在下载…':ready?'打标器已就绪':state.status==='failed'||error?'重试下载':'下载打标器';
    button.setAttribute('aria-busy',String(active));
    cancel.hidden=!active||typeof onCancelCaptioner!=='function';cancel.disabled=disabled||!!preparing;
    const progress=typeof state.progress==='number'&&Number.isFinite(state.progress)?` ${Math.round(Math.max(0,Math.min(100,state.progress)))}%`:'';
    status.textContent=error||state.label||(active?'正在准备 '+captioner.label+progress:state.status==='missing'?'未下载':'');
    status.hidden=!status.textContent;status.classList.toggle('error',!!error);
  }
  function refresh(){
    if(controller.signal.aborted)return;
    const value=getValue()||{},source=value.captionSource==='connected'?'connected':'local',captioner=resolveCaptioner(value),recommended=resolveCaptioner({...value,captioner:'auto',captionFormat:'auto'}),natural=source==='local'?captioner.format==='natural':value.effectiveCaptionFormat==='natural';
    find('[data-caption-source]').value=source;
    find('[data-caption-local]').hidden=source!=='local';
    find('[data-caption-local-tags]').hidden=source!=='local'||natural;
    find('[data-caption-ai]').hidden=source!=='connected';
    find('[data-captioner] option[value=auto]').textContent='自动匹配（'+recommended.label+'）';
    assign(find('[data-captioner]'),value.captioner||'auto');
    for(const field of taggerOptionFields){
      const control=find(`[data-caption-option="${field.key}"]`),options=value.taggerOptions||{};
      const current=Object.hasOwn(options,field.key)?options[field.key]:field.key==='batch_output_action_on_conflict'&&value.captionPolicy==='regenerate'?'copy':field.default;
      if(field.type==='boolean')control.checked=current===true;else assign(control,current);
    }
    const purpose=Object.hasOwn(captionPresets,value.purpose)?value.purpose:'character',preset=captionPresets[purpose];
    find('[data-caption-preset]').textContent=preset.label;
    const presetHelp=find('[data-caption-preset-help]');
    if(presetHelp.dataset.purpose!==purpose){presetHelp.dataset.purpose=purpose;presetHelp.innerHTML=help(preset.focus,'当前标注预设说明');}
    assign(find('[data-caption-ai-supplement]'),value.aiCaptionPrompt||'');
    find('[data-caption-prompt-preview]').textContent=buildCaptionPrompt({purpose,captionFormat:natural?'natural':'tags',trigger:value.trigger||'',supplement:value.aiCaptionPrompt||''});
    setDisabled();
  }
  function edit(event){
    if(disabled||controller.signal.aborted||event.target.disabled)return;
    const control=event.target;
    let patch;
    if(control.hasAttribute('data-caption-source')&&event.type==='change')patch={captionSource:control.value};
    else if(control.hasAttribute('data-captioner')&&event.type==='change')patch={captioner:control.value,...(!['auto','florence2'].includes(control.value)?{taggerModel:control.value}:{})};
    else if(control.hasAttribute('data-caption-ai-supplement')&&event.type==='input')patch={aiCaptionPrompt:control.value};
    else if(control.hasAttribute('data-caption-option')){
      const field=taggerOptionFields.find(field=>field.key===control.dataset.captionOption);
      if(!field||event.type!==(['boolean','select'].includes(field.type)?'change':'input'))return;
      const value=field.type==='boolean'?control.checked:field.type==='number'?Number.isFinite(control.valueAsNumber)?control.valueAsNumber:null:control.value;
      patch={taggerOptions:{...(getValue()?.taggerOptions||{}),[field.key]:value}};
    }
    if(patch){onChange(patch);refresh();}
  }
  for(const name of ['input','change'])root.addEventListener(name,edit,{signal:controller.signal});
  root.addEventListener('click',async event=>{
    const button=event.target.closest('[data-caption-prepare],[data-caption-cancel]');
    if(!button||button.disabled||disabled||controller.signal.aborted)return;
    const captioner=resolveCaptioner(getValue()||{}),cancel=button.hasAttribute('data-caption-cancel'),action=cancel?onCancelCaptioner:onPrepareCaptioner;
    if(typeof action!=='function')return;
    preparing=captioner.id;preparationError=null;refreshPreparation();
    try{await action({captioner:captioner.id});}
    catch(error){if(!controller.signal.aborted)preparationError={id:captioner.id,message:error.message||String(error)};}
    finally{preparing=null;if(!controller.signal.aborted)refreshPreparation();}
  },{signal:controller.signal});
  const dispose=()=>controller.abort();
  if(ctx.signal?.aborted)dispose();else ctx.signal?.addEventListener('abort',dispose,{once:true,signal:controller.signal});
  refresh();
  return {refresh,setDisabled,dispose};
}
