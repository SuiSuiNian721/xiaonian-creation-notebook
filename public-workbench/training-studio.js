import {escape as e,icon,moduleIcon,help} from './components.js';
import {mountTrainingForm,emptyConfig,typeName} from './training-form.js';
import {mountTrainingConnection} from './training-connection.js';
import {mountTrainingPipeline} from './training-pipeline.js';
import {mountTrainingModel} from './training-model.js';
import {linkCharacterResource} from './character-resources-ui.js';

const active=new Set(['CREATED','RUNNING','QUEUED','PENDING','SUBMITTING']);
const names={CREATED:'等待执行',RUNNING:'训练中',QUEUED:'排队中',FINISHED:'已结束',FAILED:'失败',TERMINATED:'已停止',PENDING:'等待执行'};
const label=task=>task.name||task.output_name||task.metadata?.output_name||task.id;
const duration=seconds=>Number.isFinite(seconds)?seconds>=3600?`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分钟`:seconds>=60?`${Math.floor(seconds/60)} 分钟 ${Math.round(seconds%60)} 秒`:`${Math.max(0,Math.round(seconds))} 秒`:'估算中';
const bytes=value=>Number.isFinite(value)?(value/1024**3).toFixed(1)+' GB':'—';
const statusName=task=>names[task.status]||task.status||'未知';

export function mount(root,ctx){
  if(!document.querySelector('link[data-training-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./training.css',import.meta.url).href;link.dataset.trainingStyle='';document.head.append(link);}
  const module=()=>ctx.state.modules.find(m=>m.id==='training');
  const draft=ctx.drafts.read('training:editor',{config:emptyConfig(module().config.outputPath),pending:null,selectedTask:null});
  let state={runtime:{status:'stopped'},tasks:[],engines:{},hardware:null},savedConfigs=[],localPresets=[],trainingTypes=[],schemaType='',schemaGeneration=0,tab=ctx.ui.moduleTabs.training||'pipeline',refreshing=false,busy=false,submitting=false,detailGeneration=0,stopConfirmFor=null,deletePresetTarget=null,settingsMounted=false,refreshController=null,timer=null,pipeline,modelSelection;
  let parameterSchema=null,tagging;
  const find=selector=>root.querySelector(selector);
  const remember=()=>ctx.drafts.write('training:editor',draft);
  const api=(path,body,options={})=>ctx.api('/api/training/'+path,{...(body===undefined?{}:{method:'POST',body}),timeoutMs:90000,signal:ctx.signal,...options});
  const on=(node,event,callback)=>node.addEventListener(event,callback,{signal:ctx.signal});
  root.innerHTML=`<div class="module-heading">${moduleIcon('training','large')}<div class="heading-title"><h1>LoRA 训练</h1>${help('APP 内置修改版训练内核，复用已有 Python/CUDA 和模型。预检通过不代表显存足够或画质验收。','训练说明')}</div><div class="training-toolbar"><button type="button" class="button small" id="training-import-json">${icon('upload')}导入预设</button><label class="sr-only" for="training-export-format">导出格式</label><select id="training-export-format"><option value="json">JSON</option><option value="toml">TOML</option></select><button type="button" class="button small" id="training-export-json">导出预设</button><button type="button" class="button ghost small" id="remove-module">移除入口</button></div></div>
    <div class="module-tabs" role="tablist" aria-label="训练工作区"><button type="button" id="tab-tagging" role="tab" data-tab="tagging" aria-controls="training-tagging-panel">图集打标</button><button type="button" id="tab-pipeline" role="tab" data-tab="pipeline" aria-controls="training-pipeline-panel">LoRA 训练</button><button type="button" id="tab-overview" role="tab" data-tab="overview" aria-controls="training-overview-panel">全量调整训练</button><button type="button" id="tab-tasks" role="tab" data-tab="tasks" aria-controls="training-tasks-panel">任务</button><button type="button" id="tab-config" role="tab" data-tab="config" aria-controls="training-config-panel">接入配置</button></div>
    <div class="training-runtime-bar"><div><span class="status-chip" id="training-runtime-status">内核未启动</span><span id="training-runtime-version"></span></div><div><button type="button" class="button" id="training-start-kernel">启动训练内核</button><button type="button" class="button ghost" id="training-refresh" aria-label="刷新任务">${icon('activity')}刷新</button></div></div>
    <p id="training-runtime-reason" class="form-feedback" role="status" hidden></p><div class="training-hardware" id="training-hardware" aria-label="本机硬件状态"></div>
    <section id="training-pipeline-panel" role="tabpanel" aria-labelledby="tab-pipeline"></section>
    <section id="training-tagging-panel" role="tabpanel" aria-labelledby="tab-tagging" hidden></section>
    <section id="training-overview-panel" role="tabpanel" aria-labelledby="tab-overview"><div class="training-workspace"><section class="panel glass training-form-panel"><div class="panel-heading"><h2>训练配置</h2><button type="button" class="text-link" id="training-load-configs">读取已有参数</button></div><div class="training-import-row" id="training-import-row" hidden><label class="sr-only" for="training-saved-config">已有训练配置</label><select id="training-saved-config"></select><button class="button small" id="training-apply-config" type="button">载入参数</button></div><form id="training-create-form"><div id="training-form"></div><div class="training-submit-row"><p id="training-feedback" class="form-feedback" role="status" aria-live="polite"></p><button class="button" type="button" id="training-reconcile" hidden>核对提交</button><button class="button" type="button" id="training-preflight">检查配置与环境</button><button class="button primary" type="submit" id="training-submit">开始训练 ${icon('arrow')}</button></div></form></section><aside class="training-sidebar"><section><div class="section-heading"><h2>最近任务</h2><button class="text-link" id="training-all-tasks" type="button">全部</button></div><div id="training-recent-tasks"></div></section><section><h2>训练引擎</h2><ul class="training-engine-list" id="training-engines"></ul></section></aside></div></section>
    <section id="training-tasks-panel" role="tabpanel" aria-labelledby="tab-tasks" hidden><div class="training-tasks-layout"><nav class="training-job-list" id="training-task-list" aria-label="训练任务"></nav><section class="panel glass training-task-detail" id="training-task-detail"><p class="training-empty">选择一个任务，查看进度和产物。</p></section></div></section>
    <section id="training-config-panel" role="tabpanel" aria-labelledby="tab-config" hidden></section><input type="file" accept="application/json,.json,.toml" id="training-json-file" hidden>`;
  find('#training-import-row').insertAdjacentHTML('afterend',`<div class="training-preset-editor"><div class="field"><label for="training-preset-name">预设名称</label><input id="training-preset-name" maxlength="120" value="${e(draft.presetName||'')}" placeholder="例如：MOSS 角色 LoRA"></div><button type="button" class="button small" id="training-save-preset">保存预设</button><button type="button" class="button ghost small" id="training-save-preset-as">另存预设</button><button type="button" class="button ghost small" id="training-delete-preset" hidden>删除预设</button></div><div id="training-preset-delete-confirm" class="training-stop-confirm" hidden><p>删除此预设将无法撤销，当前参数和训练任务会保留。</p><button type="button" class="button" id="training-delete-preset-confirm">确认删除</button><button type="button" class="button ghost" id="training-delete-preset-cancel">取消</button></div>`);
  const feedback=(message,error=false)=>{if(ctx.signal.aborted)return;find('#training-feedback').textContent=message;find('#training-feedback').className='form-feedback'+(error?' error':'');};
  const form=mountTrainingForm(find('#training-form'),{config:draft.config,rawJson:draft.rawJson??null,signal:ctx.signal,pathContext:ctx,onError:message=>{feedback(message,true);drawControls();},onJsonChange:raw=>{draft.rawJson=raw;remember();feedback('完整参数尚未应用，请先点击“应用参数”。');drawControls();},onChange:config=>{draft.config=config;draft.rawJson=null;remember();if(!submitting)feedback(draft.pending?'上次提交尚未确认，请先核对提交。':'参数已修改');drawControls();void loadSchema(config.model_train_type);}});
  pipeline=mountTrainingPipeline(find('#training-pipeline-panel'),ctx,{getConfig:()=>{if(form.hasUnapplied())throw new Error('完整训练参数尚未应用，请先应用或修正 JSON。');return form.value();},setConfig:config=>form.replace(config),getCatalog:()=>trainingTypes,getSchema:()=>parameterSchema?.type===form.value().model_train_type?parameterSchema.form:null,openParameters:()=>selectTab('overview'),editConfiguration:config=>{form.replace(config);selectTab('overview');}});
  tagging=mountTrainingPipeline(find('#training-tagging-panel'),ctx,{mode:'tag',onUseDataset:(path,format)=>{try{pipeline.useDataset(path,format);selectTab('pipeline',true);}catch(error){ctx.notify(error.message,true);}}});
  const modelRoot=document.createElement('div');find('#training-hardware').after(modelRoot);
  modelSelection=mountTrainingModel(modelRoot,ctx,{getConfig:()=>{if(form.hasUnapplied())throw new Error('请先应用完整参数。');return form.value();},setConfig:config=>form.replace(config,{changeType:true}),onRefresh:refreshState,openConnection:()=>selectTab('config')});
  async function loadSchema(type){
    if(!type||type===schemaType)return;
    schemaType=type;const generation=++schemaGeneration;
    try{const result=await api('schema?type='+encodeURIComponent(type));if(!ctx.signal.aborted&&generation===schemaGeneration){parameterSchema={type,form:result.form};form.schema(result.form);pipeline?.syncConfig();}}
    catch(error){if(!ctx.signal.aborted&&generation===schemaGeneration){schemaType='';feedback(error.message,true);}}
  }
  function drawStopButton(){const button=find('#training-stop-kernel');if(button)button.textContent=state.runtime.status==='starting'?'取消启动':'停止空闲内核';}
  function drawControls(){
    pipeline?.syncConfig();
    modelSelection?.sync();
    const running=state.runtime.status==='running',starting=busy||state.runtime.status==='starting',existing=['configuration_changed','unresponsive'].includes(state.runtime.status);
    const labels={running:'训练内核已启动',configuration_changed:'内核运行中 · 配置已变更',unresponsive:'训练内核暂未响应',offline:'训练内核离线',unconfigured:'训练环境未就绪',failed:'内核启动失败'};
    find('#training-runtime-status').textContent=starting?'正在处理…':labels[state.runtime.status]||'内核未启动';
    find('#training-runtime-status').className='status-chip'+(running||state.runtime.status==='configuration_changed'?' good':'');
    find('#training-runtime-reason').textContent=state.runtime.reason||'';find('#training-runtime-reason').hidden=!state.runtime.reason;
    find('#training-runtime-version').textContent=state.runtime.version?'v'+state.runtime.version:'';
    find('#training-start-kernel').disabled=running||starting||existing;find('#training-start-kernel').textContent=running?'内核已启动':'启动训练内核';
    drawStopButton();
    find('#training-submit').disabled=!running||submitting||!!draft.pending||form.hasUnapplied();find('#training-preflight').disabled=busy||submitting||!!draft.pending||form.hasUnapplied();find('#training-export-json').disabled=busy||form.hasUnapplied();
    find('#training-save-preset').disabled=busy||form.hasUnapplied();find('#training-save-preset-as').disabled=busy||form.hasUnapplied();find('#training-delete-preset').hidden=!draft.presetId||!draft.presetRevision;
    find('#training-reconcile').hidden=!draft.pending;find('#training-reconcile').disabled=submitting;find('#training-reconcile').textContent=draft.pending?.retry?'重试这次提交':'核对提交';
  }
  function drawHardware(){
    const hardware=state.hardware?.data||state.hardware,node=find('#training-hardware');
    if(!hardware){node.textContent='';return;}
    const cpu=hardware.cpu?.percent,memory=hardware.memory?.percent;
    node.innerHTML=`<span>CPU ${Number.isFinite(cpu)?Math.round(cpu)+'%':'—'}</span><span>内存 ${Number.isFinite(memory)?Math.round(memory)+'%':'—'}</span>${(hardware.gpus||[]).map(gpu=>`<span>${e(gpu.name)} ${Number.isFinite(gpu.utilization_percent)?Math.round(gpu.utilization_percent)+'%':'—'}</span><span>显存 ${bytes(gpu.memory?.used_bytes)} / ${bytes(gpu.memory?.total_bytes)}</span><span>${Number.isFinite(gpu.temperature_c)?Math.round(gpu.temperature_c)+' °C':'—'}</span>`).join('')}`;
  }
  function drawEngines(){const engines=Object.entries(state.engines||{}).sort(([a],[b])=>Number(b==='kohya')-Number(a==='kohya'));find('#training-engines').innerHTML=engines.length?engines.map(([id,engine])=>`<li><div class="training-engine-name"><strong>${e(id==='kohya'?'Kohya / sd-scripts':id)}</strong>${engine.reason?help(engine.reason,id+'状态说明'):''}</div><span class="status-chip ${engine.state==='ready'?'good':''}">${engine.state==='ready'?'就绪':engine.state==='not_bundled'||engine.bundled===false?'未内置':engine.state==='not_installed'?'未安装':'未就绪'}</span></li>`).join(''):'<li class="training-empty">启动内核后检查运行环境</li>';}
  const taskRows=tasks=>tasks.length?tasks.map(task=>`<button type="button" class="training-task-row" data-training-task="${e(task.id)}" aria-pressed="${draft.selectedTask===task.id}"><strong>${e(label(task))}</strong><small>${e(typeName(task.trainType||task.metadata?.train_type||''))}</small><span class="status-chip ${task.status==='FINISHED'&&task.returncode===0?'good':''}">${e(statusName(task))}${task.status==='FINISHED'&&task.returncode!==undefined?' · 退出码 '+e(task.returncode):''}</span></button>`).join(''):'<p class="training-empty">暂无训练任务</p>';
  function drawTasks(){find('#training-recent-tasks').innerHTML=taskRows((state.tasks||[]).slice(0,5));find('#training-task-list').innerHTML=taskRows(state.tasks||[]);}
  async function showTask(id,signal=ctx.signal){
    const generation=++detailGeneration;draft.selectedTask=id;remember();drawTasks();
    try{const data=await api('tasks/'+encodeURIComponent(id),undefined,{signal});if(signal.aborted||generation!==detailGeneration)return;drawTaskDetail(data);}
    catch(error){if(!signal.aborted&&generation===detailGeneration)find('#training-task-detail').innerHTML=`<p class="form-feedback error" role="alert">${e(error.message)}</p>`;}
  }
  function drawTaskDetail(data){
    const task=data.task,progress=data.metrics?.progress||{},timing=data.metrics?.timing||{},logs=Array.isArray(data.logs)?data.logs:data.logs?.lines||[];
    const total=progress.total_steps,step=progress.step,percent=Number.isFinite(progress.percent)?Math.min(100,Math.max(0,progress.percent)):Number.isFinite(total)&&total>0?Math.min(100,(step||0)*100/total):null;
    const previews=Array.isArray(data.previews)?data.previews:data.previews?.previews||data.previews?.images||[],outputs=Array.isArray(data.outputs)?data.outputs:data.outputs?.files||[];
    const url=path=>ctx.url?ctx.url(path):path;
    find('#training-task-detail').innerHTML=`<div class="panel-heading"><h2>${e(label(task))}</h2><span class="status-chip">${e(statusName(task))}</span></div><div class="training-progress-label"><span>${Number.isFinite(step)?e(step)+' / '+e(total??'?'):'等待进度'}</span><span>${percent===null?'':Math.round(percent)+'%'}</span></div><progress aria-label="训练进度" max="100" ${percent===null?'':`value="${percent}"`}></progress><div class="training-timing"><span>已用 ${duration(timing.elapsed_seconds)}</span>${active.has(task.status)?`<span>${timing.state==='stale'?'等待进度更新':timing.state==='finishing'?'正在收尾':'剩余 '+duration(timing.remaining_seconds)}</span>`:''}</div>
      ${active.has(task.status)?`<button class="button" type="button" data-training-stop="${e(task.id)}">停止训练</button><div class="training-stop-confirm" ${stopConfirmFor===task.id?'':'hidden'}><p>停止会终止训练及其缓存阶段，不能保证保存当前步骤。</p><div class="training-stop-actions"><button class="button danger" type="button" data-training-stop-confirm="${e(task.id)}">确认停止</button><button class="button" type="button" data-training-stop-cancel>继续训练</button></div></div>`:''}
      <h3>训练日志</h3><pre tabindex="0">${e(logs.map(line=>typeof line==='string'?line:JSON.stringify(line)).join('\n')||'尚无训练日志')}</pre>
      ${previews.length?`<h3>已生成预览</h3><div class="training-preview-grid">${previews.map(item=>{const name=typeof item==='string'?item:item.name||item.filename;return `<figure><img loading="lazy" src="${e(url('/api/training/tasks/'+encodeURIComponent(task.id)+'/previews/'+encodeURIComponent(name)))}" alt="训练预览 ${e(name)}"><figcaption>${e(name)}</figcaption></figure>`;}).join('')}</div>`:''}
      <h3>训练产物</h3>${outputs.length?`<ul class="training-output-list">${outputs.map(item=>`<li><strong>${e(typeof item==='string'?item:item.name||item.filename||item.path)}</strong>${item.path?`<small>${e(item.path)}</small>${/lora/i.test(task.trainType||task.metadata?.train_type||'')&&/\.safetensors$/i.test(item.path)?`<button class="text-link" type="button" data-training-lora-path="${e(item.path)}" data-training-lora-name="${e(item.name||item.filename||'训练 LoRA')}">关联到角色资料</button>`:''}`:''}</li>`).join('')}</ul>`:'<p class="training-empty">尚无已保存的产物</p>'}`;
  }
  async function refreshState(){
    if(refreshing||ctx.signal.aborted)return;refreshing=true;
    refreshController=new AbortController();const signal=AbortSignal.any([ctx.signal,refreshController.signal]);
    try{state=await api('state',undefined,{timeoutMs:20000,signal});if(signal.aborted)return;
      if(!draft.pending&&state.unresolvedSubmissions?.length){const record=state.unresolvedSubmissions[0];draft.pending={requestId:record.requestId||record.request_id};remember();feedback('发现上次尚未确认的提交，请先核对提交。',true);}
      drawControls();drawHardware();drawEngines();drawTasks();modelSelection?.update(state);if(tab==='pipeline')await pipeline.refresh();if(tab==='tagging')await tagging.refresh();if(tab==='tasks'&&draft.selectedTask)await showTask(draft.selectedTask,signal);
    }catch(error){if(!signal.aborted){state={...state,runtime:{...state.runtime,status:'offline'},hardware:null};drawControls();drawHardware();feedback(error.message,true);}}
    finally{refreshing=false;refreshController=null;}
  }
  async function kernelAction(action){busy=true;drawControls();feedback(action==='start'?'正在启动训练内核…':'正在停止空闲内核…');try{await api(action,{});if(!ctx.signal.aborted){feedback(action==='start'?'训练内核已启动':'内核已停止');await refreshState();}}catch(error){feedback(error.message,true);if(!ctx.signal.aborted&&tab!=='overview')ctx.notify(error.message,true);}finally{busy=false;if(!ctx.signal.aborted)drawControls();}}
  function selectTab(next,focus=false){
    if(!['tagging','pipeline','overview','tasks','config'].includes(next))next='pipeline';tab=next;ctx.ui.moduleTabs.training=tab;
    root.querySelectorAll('[data-tab]').forEach(button=>{const selected=button.dataset.tab===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
    for(const id of ['tagging','pipeline','overview','tasks','config'])find('#training-'+id+'-panel').hidden=id!==tab;
    modelRoot.hidden=!['pipeline','overview'].includes(tab);
    find('#training-import-json').hidden=tab!=='overview';find('#training-export-json').hidden=tab!=='overview';find('#training-export-format').hidden=tab!=='overview';
    if(tab==='pipeline'){pipeline.syncConfig();void pipeline.refresh();}
    if(tab==='tagging'){tagging.syncConfig();void tagging.refresh();}
    if(tab==='config'&&!settingsMounted){settingsMounted=true;mountTrainingConnection(find('#training-config-panel'),ctx,{onSaved:()=>refreshState(),onStop:()=>kernelAction('stop')});}
    drawStopButton();
    if(tab==='tasks'&&draft.selectedTask)void showTask(draft.selectedTask);
    if(focus)find('[data-tab="'+tab+'"]').focus();
  }
  async function reconcile(){
    if(!draft.pending||submitting)return;if(draft.pending.retry)return sendPending();submitting=true;drawControls();
    try{const record=await api('submissions/'+encodeURIComponent(draft.pending.requestId));if(ctx.signal.aborted)return;
      const result=record.result||record;
      if(record.state==='submitted'&&result.task_id){draft.pending=null;draft.selectedTask=result.task_id;remember();feedback('训练已提交，任务编号：'+result.task_id);await refreshState();}
      else if(record.state==='failed'){draft.pending=null;remember();feedback('上次提交已明确失败。检查参数后可以重新提交。',true);}
      else if(record.state==='not_found'&&draft.pending.config){draft.pending.retry=true;remember();feedback('服务尚未收到这次提交。可以点击“重试这次提交”，沿用原编号与参数。');}
      else feedback('提交结果仍未确认，请核对任务列表，暂不重复提交。',true);
    }catch(error){feedback(error.message+' 请先核对任务列表。',true);}finally{submitting=false;if(!ctx.signal.aborted)drawControls();}
  }
  async function sendPending(){
    if(!draft.pending?.config||submitting)return;
    const request={requestId:draft.pending.requestId,config:draft.pending.config};delete draft.pending.retry;remember();submitting=true;drawControls();feedback('正在提交训练…');
    try{const result=await api('tasks',request);if(ctx.signal.aborted)return;draft.pending=null;draft.selectedTask=result.task_id;remember();feedback('训练已提交，任务编号：'+result.task_id);await refreshState();}
    catch(error){feedback(error.message+' 请点击“核对提交”。',true);}
    finally{submitting=false;if(!ctx.signal.aborted)drawControls();}
  }
  on(find('#training-start-kernel'),'click',()=>kernelAction('start'));on(find('#training-refresh'),'click',refreshState);on(find('#training-all-tasks'),'click',()=>selectTab('tasks'));on(find('#training-reconcile'),'click',reconcile);
  function drawPresets(){
    const select=find('#training-saved-config'),selected=select.value;
    select.innerHTML=(localPresets.length?`<optgroup label="工作台预设">${localPresets.map(item=>`<option value="${e(item.id)}">${e(item.name)}</option>`).join('')}</optgroup>`:'')+(savedConfigs.length?`<optgroup label="已有训练工具配置">${savedConfigs.map(item=>`<option value="${e(item.id)}">${e(item.name)}</option>`).join('')}</optgroup>`:'');
    if([...select.options].some(option=>option.value===selected))select.value=selected;
    find('#training-import-row').hidden=!select.options.length;
  }
  async function readPresets(original=false){
    const results=await Promise.allSettled([api('presets'),...(original?[api('saved-configs')]:[])]);if(ctx.signal.aborted)return;
    if(results[0].status==='fulfilled')localPresets=results[0].value.presets||[];else feedback(results[0].reason.message,true);
    if(original){if(results[1].status==='fulfilled')savedConfigs=results[1].value.configs||[];else feedback(results[1].reason.message,true);}
    drawPresets();
  }
  on(find('#training-load-configs'),'click',()=>readPresets(true));
  on(find('#training-apply-config'),'click',()=>{const id=find('#training-saved-config').value,value=localPresets.find(item=>item.id===id)||savedConfigs.find(item=>item.id===id);if(value){const own=localPresets.includes(value);draft.presetId=own?value.id:null;draft.presetRevision=own?value.revision:0;draft.presetName=value.name;find('#training-preset-name').value=value.name;form.replace(value.config);feedback('已载入 '+value.name);}});
  on(find('#training-preset-name'),'input',event=>{draft.presetName=event.target.value;remember();});
  async function savePreset(copy=false){
    if(busy||form.hasUnapplied())return;
    try{
      const name=find('#training-preset-name').value.trim();if(!name)throw new Error('请填写预设名称。');
      const config=form.value();if(copy||!draft.presetId){draft.presetId=crypto.randomUUID();draft.presetRevision=0;}draft.presetName=name;remember();busy=true;drawControls();
      const submittedId=draft.presetId,result=await api('presets',{id:submittedId,revision:draft.presetRevision||0,name,config});if(ctx.signal.aborted)return;
      if(draft.presetId===submittedId){draft.presetRevision=result.preset.revision;remember();}
      await readPresets();if(draft.presetId===submittedId)find('#training-saved-config').value=submittedId;feedback('预设已保存');
    }catch(error){feedback(error.message,true);}finally{busy=false;if(!ctx.signal.aborted)drawControls();}
  }
  on(find('#training-save-preset'),'click',()=>savePreset());on(find('#training-save-preset-as'),'click',()=>savePreset(true));
  on(find('#training-delete-preset'),'click',()=>{deletePresetTarget={id:draft.presetId,revision:draft.presetRevision};find('#training-preset-delete-confirm p').textContent=`删除“${draft.presetName}”将无法撤销，当前参数和训练任务会保留。`;find('#training-preset-delete-confirm').hidden=false;});
  on(find('#training-delete-preset-cancel'),'click',()=>{deletePresetTarget=null;find('#training-preset-delete-confirm').hidden=true;});
  on(find('#training-delete-preset-confirm'),'click',async()=>{if(busy||!deletePresetTarget)return;const target=deletePresetTarget;busy=true;drawControls();try{await api('presets/'+encodeURIComponent(target.id)+'/delete',{revision:target.revision});if(ctx.signal.aborted)return;if(draft.presetId===target.id){draft.presetId=null;draft.presetRevision=0;remember();}deletePresetTarget=null;find('#training-preset-delete-confirm').hidden=true;await readPresets();feedback('预设已删除，当前参数已保留。');}catch(error){feedback(error.message,true);}finally{busy=false;if(!ctx.signal.aborted)drawControls();}});
  on(find('#training-preflight'),'click',async()=>{if(!find('#training-create-form').reportValidity())return;busy=true;drawControls();feedback('正在检查配置与环境…');try{const result=await api('preflight',{config:form.submission()});if(ctx.signal.aborted)return;feedback(result.ok?'预检通过，可以开始训练。':'预检未通过，请检查参数。',!result.ok);await refreshState();}catch(error){feedback(error.message,true);}finally{busy=false;if(!ctx.signal.aborted)drawControls();}});
  on(find('#training-create-form'),'submit',async event=>{
    event.preventDefault();if(submitting||draft.pending||form.hasUnapplied())return;
    try{draft.pending={requestId:crypto.randomUUID(),config:form.submission()};remember();await sendPending();}catch(error){feedback(error.message,true);}
  });
  on(root,'click',async event=>{
    const lora=event.target.closest('[data-training-lora-path]');if(lora){await linkCharacterResource(ctx,{kind:'lora',path:lora.dataset.trainingLoraPath,name:lora.dataset.trainingLoraName});return;}
    const task=event.target.closest('[data-training-task]');if(task){selectTab('tasks');await showTask(task.dataset.trainingTask);return;}
    const stop=event.target.closest('[data-training-stop]');if(stop){stopConfirmFor=stop.dataset.trainingStop;find('#training-task-detail .training-stop-confirm').hidden=false;return;}
    if(event.target.closest('[data-training-stop-cancel]')){stopConfirmFor=null;find('#training-task-detail .training-stop-confirm').hidden=true;return;}
    const confirm=event.target.closest('[data-training-stop-confirm]');if(confirm){confirm.disabled=true;try{await api('tasks/'+encodeURIComponent(confirm.dataset.trainingStopConfirm)+'/stop',{});stopConfirmFor=null;await refreshState();}catch(error){feedback(error.message,true);if(!ctx.signal.aborted){confirm.disabled=false;ctx.notify(error.message,true);}}}
  });
  on(find('#training-import-json'),'click',()=>find('#training-json-file').click());
  on(find('#training-json-file'),'change',async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('配置超过 1 MiB。');const value=await api('presets/import',{format:file.name.toLowerCase().endsWith('.toml')?'toml':'json',text:await file.text()});if(!ctx.signal.aborted){draft.presetId=null;draft.presetRevision=0;draft.presetName=value.name||file.name.replace(/\.(json|toml)$/i,'');find('#training-preset-name').value=draft.presetName;form.replace(value.config);feedback('已导入 '+file.name);selectTab('overview');}}catch(error){feedback(error.message,true);}finally{event.target.value='';}});
  on(find('#training-export-json'),'click',async()=>{try{const value=await api('presets/export',{format:find('#training-export-format').value,name:find('#training-preset-name').value.trim()||'训练预设',config:form.value()});if(ctx.signal.aborted)return;const url=URL.createObjectURL(new Blob([value.content],{type:value.mime+';charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=value.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);feedback('请选择预设保存位置');}catch(error){feedback(error.message,true);}});
  on(find('#remove-module'),'click',()=>ctx.action(find('#remove-module'),async()=>{await ctx.disableModule('training');ctx.navigate('home');}));
  root.querySelectorAll('[data-tab]').forEach(button=>{on(button,'click',()=>selectTab(button.dataset.tab));on(button,'keydown',event=>{const tabs=['tagging','pipeline','overview','tasks','config'];let next;if(event.key==='ArrowRight')next=tabs[(tabs.indexOf(tab)+1)%tabs.length];if(event.key==='ArrowLeft')next=tabs[(tabs.indexOf(tab)+tabs.length-1)%tabs.length];if(event.key==='Home')next=tabs[0];if(event.key==='End')next=tabs.at(-1);if(next){event.preventDefault();selectTab(next,true);}});});
  selectTab(tab);drawControls();drawTasks();drawEngines();
  void api('catalog').then(data=>{if(!ctx.signal.aborted){trainingTypes=data.training_types||[];form.catalog(trainingTypes);pipeline.syncConfig();}}).catch(error=>feedback(error.message,true));
  void readPresets();void loadSchema(draft.config.model_train_type);
  function syncPolling(){
    const visible=!ctx.signal.aborted&&!document.hidden&&root.isConnected&&!root.closest('[hidden]');
    if(visible&&!timer){void refreshState();timer=setInterval(refreshState,5000);}
    else if(!visible){clearInterval(timer);timer=null;refreshController?.abort();detailGeneration++;}
  }
  const visibility=new MutationObserver(syncPolling);
  for(let node=root;node;node=node.parentElement)visibility.observe(node,{attributes:true,attributeFilter:['hidden']});
  document.addEventListener('visibilitychange',syncPolling,{signal:ctx.signal});syncPolling();
  ctx.signal.addEventListener('abort',()=>{clearInterval(timer);refreshController?.abort();visibility.disconnect();detailGeneration++;},{once:true});
}
