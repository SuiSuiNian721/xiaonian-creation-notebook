import { escape as e, help } from './components.js';
import { typeName, mountTrainingForm } from './training-form.js';
import { naturalCaptionTypes, baseModelField, modelPathKeys } from './training-types.js';
import {mountPathPicker,syncPathPickers} from './path-picker.js';
import {trainingPathKind} from './path-kinds.js';
import {mountResourcePreparation,preparationFor,choosePreparedField} from './resource-preparation.js';
import {memoryFields} from './training-memory-fields.js';
import {conditionsMatch,fieldLabel,fieldHelp} from './training-form-fields.js';
import {mountTrainingCaptionSettings} from './training-caption-settings.js';
import {resolveCaptioner} from './training-captioners.js';

const states = { running: '进行中', pausing: '当前阶段结束后暂停', paused: '已暂停', cancelling: '正在取消', blocked: '需要处理', completed: '已完成', cancelled: '已取消' };
const stepNames = { pending: '等待', running: '进行中', completed: '已完成', blocked: '需要处理', skipped: '跳过' };
export function mountTrainingPipeline(root, ctx, { getConfig, setConfig, getCatalog = () => [], getSchema=()=>null, openParameters, editConfiguration, mode='train', onUseDataset }) {
  const tagging=mode==='tag',draftKey=tagging?'training:tagging':'training:pipeline';
  const defaults = { sourcePath: '', goal: '', purpose: 'character', trigger: '', aiEnabled: true, captionPolicy: 'fill-missing',captioner:'auto',captionSource:'local',aiCaptionPrompt:'',taggerOptions:{},cropMode: 'none', captionFormat: 'auto', parameterMode: 'recommended', detectorPath: '', captionModelPath: '', allowDownload: false, taggerModel: 'wd14-convnextv2-v2', steps: 1000, repeats: 5, rank: 16, learningRate: 0.0001, pending: null, selected: null, cropDefaultsVersion: 1, memoryByType:{} };
  const draft = { ...defaults, ...ctx.drafts.read(draftKey, defaults) };
  if(!draft.memoryByType||typeof draft.memoryByType!=='object'||Array.isArray(draft.memoryByType))draft.memoryByType={};
  const savedDraft = ctx.drafts.read(draftKey, defaults);
  const legacyDraft = savedDraft.cropDefaultsVersion !== 1;
  if (legacyDraft) { draft.cropMode = draft.pending ? draft.pending.input.cropMode ?? 'auto' : 'none'; draft.cropDefaultsVersion = draft.pending ? undefined : 1; }
  let jobs = [], busy = false, generation = 0, cancelFor = null, listKey = '', aiReady = false, modelType = '', recipes = [],captionSettings,captionerResources={items:[],task:null};
  const sampleViews = new Map(), configViews = new Map();let modelPickers=[];
  const selectorFor=selector=>tagging?selector.replaceAll('#pipeline-','#tagging-'):selector;
  const find = selector => root.querySelector(selectorFor(selector)), remember = () => ctx.drafts.write(draftKey, draft);
  if(tagging){
    getConfig=()=>({...draft.tagConfig,model_train_type:'sdxl-lora'});
    setConfig=config=>{draft.tagConfig={output_dir:config.output_dir||''};remember();};
    getSchema=()=>null;getCatalog=()=>[];
  }
  const api = (path, body) => ctx.api('/api/training/workflows' + path, { ...(body === undefined ? {} : { method: 'POST', body }), timeoutMs: 30000, signal: ctx.signal });
  const on = (node, event, action) => node.addEventListener(event, action, { signal: ctx.signal });
  root.innerHTML = `<div class="training-pipeline-layout"><section class="panel glass training-pipeline-form"><div class="panel-heading"><h2>${tagging?'图集打标':'模型与训练集'}</h2>${help(tagging?'选择本地模型或接入 AI 打标；接入 AI 会逐张发送图集工作副本。原图与原标注保留。':'使用已有标注图集，AI 规划训练参数。缺少匹配格式的标注时停止，请先到图集打标页处理。',tagging?'图集打标说明':'LoRA 训练说明')}</div>
    <form id="pipeline-form"><div class="training-form-top"><div class="field"><label for="pipeline-train-type">训练类型</label><select id="pipeline-train-type"></select></div><div class="field"><label for="pipeline-parameter-mode">参数方案</label><select id="pipeline-parameter-mode" data-pipeline-field="parameterMode"><option value="recommended" ${draft.parameterMode === 'recommended' ? 'selected' : ''}>AI 推荐参数</option><option value="defaults" ${draft.parameterMode === 'defaults' ? 'selected' : ''}>训练器默认参数</option></select></div></div>
    <div class="field"><div class="field-label"><label for="pipeline-model-path">训练模型</label><button type="button" class="text-link" id="pipeline-load-models">读取已有模型参数</button></div><input id="pipeline-model-path" data-quick-model-field="pretrained_model_name_or_path" placeholder="填写底模路径，或载入已有参数" spellcheck="false"></div>
    <div class="training-import-row" id="pipeline-recipes" hidden><label class="sr-only" for="pipeline-recipe">模型参数</label><select id="pipeline-recipe"></select><button type="button" class="button small" id="pipeline-apply-recipe">载入</button></div>
    <details class="training-advanced" id="pipeline-components"><summary>模型组件 ${help('MOSS 还需文本编码器、VAE 和 tokenizer 等组件。已有同一底模的保存参数可自动补齐；无法确定时请在这里填写，避免选择错误的模型。', '模型组件说明')}</summary><div id="pipeline-component-fields"></div></details>
    <div class="field"><label for="pipeline-source">训练图集</label><div class="training-source-row"><input id="pipeline-source" data-pipeline-field="sourcePath" value="${e(draft.sourcePath)}" placeholder="选择或填写图片文件夹" required><button class="button" id="pipeline-choose" type="button">选择文件夹</button></div></div>
    <div class="field"><label for="pipeline-output">输出目录 ${help(tagging?'每次打标创建独立图集副本，重试沿用原位置。留空使用当前实例的流程目录。':'每次训练创建独立文件夹，重试沿用原位置。留空使用训练设置中的输出目录；未设置时使用流程目录。','输出目录说明')}</label><input id="pipeline-output" data-quick-config-field="output_dir" placeholder="选择产物保存位置" spellcheck="false"></div>
    <details class="training-advanced" id="pipeline-memory"><summary>显存选项 ${help('留空或跟随参数方案时使用规划结果；明确选择的值优先于 AI 推荐。只显示当前训练器支持的选项。','显存选项说明')}</summary><div class="training-form-top" data-memory-fields></div></details>
    <div class="field"><label for="pipeline-goal">想训练什么</label><textarea id="pipeline-goal" data-pipeline-field="goal" rows="2" maxlength="3000" placeholder="例如：学习这个角色的外貌，保留换装能力">${e(draft.goal)}</textarea></div>
    <div class="training-form-top"><div class="field"><label for="pipeline-purpose">用途</label><select id="pipeline-purpose" data-pipeline-field="purpose">${[['character', '角色'], ['style', '画风'], ['pose', '姿势']].map(([value, label]) => `<option value="${value}" ${draft.purpose === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field"><label for="pipeline-trigger">触发词 ${help('可留空。填写后加入工作副本的标注；例如 xiaoxi_character。', '触发词说明')}</label><input id="pipeline-trigger" data-pipeline-field="trigger" maxlength="120" value="${e(draft.trigger)}" placeholder="可选，例如 xiaoxi_character"></div></div>
    <div class="training-form-top"><div class="field"><label for="pipeline-crop">局部裁切增强 ${help('默认使用整图，训练器按长宽比分桶；尺寸对齐仍可能裁边。明确开启增强后才另存主体或特写副本，并重新标注。画风保留完整构图。', '裁切策略说明')}</label><select id="pipeline-crop" data-pipeline-field="cropMode"><option value="none" ${draft.cropMode === 'none' ? 'selected' : ''}>保留整图（默认）</option><option value="auto" ${draft.cropMode === 'auto' ? 'selected' : ''}>按用途增强</option></select></div><div class="field"><label for="pipeline-format">标注格式 ${help('SD 1.5、SDXL 默认标签；MOSS、Flux、Anima、Lumina 默认自然语言。选择图集中已有标注或本次打标需要的格式。', '标注格式说明')}</label><select id="pipeline-format" data-pipeline-field="captionFormat"><option value="auto" ${draft.captionFormat === 'auto' ? 'selected' : ''}>跟随底模</option><option value="tags" ${draft.captionFormat === 'tags' ? 'selected' : ''}>标签</option><option value="natural" ${draft.captionFormat === 'natural' ? 'selected' : ''}>自然语言</option></select></div></div>
    <div class="training-pipeline-base"><span class="status-chip" id="pipeline-ai-status">正在读取 AI 接入</span><button type="button" class="text-link" id="pipeline-ai-connect">AI 接入</button><button type="button" class="text-link" id="pipeline-edit-parameters">全量调整训练</button></div>
    <div data-training-caption-settings></div>
    <details class="training-advanced"><summary>处理与训练方案</summary><div class="field"><label for="pipeline-policy">已有标注 ${help('保留匹配标注、补齐缺失，或在副本中重建；仅使用已有标注时不调用模型。本地标签的显式冲突设置优先于前两项。','已有标注说明')}</label><select id="pipeline-policy" data-pipeline-field="captionPolicy">${[['fill-missing','保留匹配标注，补齐缺失'],['regenerate','在副本中重新打标'],['existing','仅使用已有标注']].map(([value,label])=>`<option value="${value}" ${draft.captionPolicy===value?'selected':''}>${label}</option>`).join('')}</select></div>
    <div class="field" id="pipeline-detector-field"><label for="pipeline-detector">裁切模型目录 ${help('可留空，使用工作台缓存。指定目录应包含 yolox_l.onnx 和 dw-ll_ucoco_384.onnx；可以复用已有 DWPose 权重。', '裁切模型目录说明')}</label><input id="pipeline-detector" data-pipeline-field="detectorPath" value="${e(draft.detectorPath)}" placeholder="使用本地 DWPose 缓存"></div>
    <div class="field" id="pipeline-caption-field"><label for="pipeline-caption">描述模型目录 ${help('可留空，使用工作台缓存。支持原生 florence-community/Florence-2-base，不能填写训练底模。使用本地 Kohya Python 在 CPU 上描述图片。', '描述模型目录说明')}</label><input id="pipeline-caption" data-pipeline-field="captionModelPath" value="${e(draft.captionModelPath)}" placeholder="使用本地 Florence-2 缓存"></div>
    <div class="field" id="pipeline-repeats-field"><label for="pipeline-repeats">图集重复次数</label><input id="pipeline-repeats" data-pipeline-field="repeats" type="number" min="1" max="100" value="${draft.repeats}" required></div>
    <label class="training-checkbox"><input type="checkbox" data-pipeline-field="allowDownload" ${draft.allowDownload?'checked':''}>允许下载缺失的本地处理模型 ${help('为本流程准备选中的标签模型、Florence-2 或 DWPose；首次可能下载数百 MB 至约 1 GB。关闭时只用已有本地模型。此开关不下载训练底模。','本地处理模型下载说明')}</label><div data-pipeline-processing-preparation></div></details>
    <div class="training-submit-row"><p class="form-feedback" id="pipeline-feedback" role="status" aria-live="polite"></p><button class="button primary" id="pipeline-start" type="submit">${tagging?'开始打标':'开始训练'}</button></div></form></section>
    <aside class="training-pipeline-history"><h2>流程记录</h2><div id="pipeline-jobs"></div></aside></div><section id="pipeline-detail" class="training-pipeline-detail" aria-label="流程详情"></section>`;
  // Scope labels and controls when both workspaces are mounted in one document.
  if(tagging)for(const node of root.querySelectorAll('[id],[for]')){
    if(node.id.startsWith('pipeline-'))node.id=node.id.replace('pipeline-','tagging-');
    if(node.getAttribute('for')?.startsWith('pipeline-'))node.setAttribute('for',node.getAttribute('for').replace('pipeline-','tagging-'));
  }
  // The shared model row above the workspace owns normal model selection.
  find('#pipeline-components').append(find('#pipeline-train-type').closest('.field'),find('#pipeline-model-path').closest('.field'));
  find('#pipeline-form > .training-form-top').classList.add('training-pipeline-plan-row');
  root.querySelector('.panel-heading h2').textContent=tagging?'图集打标':'模型与训练集';
  root.querySelector('label[for="'+(tagging?'tagging':'pipeline')+'-source"]').textContent=tagging?'图片文件夹':'已标注图集';
  if(tagging)root.querySelector('label[for="tagging-goal"]').textContent='打标目标';
  function workspaceVisibility(){
    for(const id of ['components','recipes','memory','edit-parameters'])if(tagging)find('#pipeline-'+id).hidden=true;
    if(tagging){find('#pipeline-parameter-mode').closest('.training-form-top').hidden=true;find('#pipeline-repeats-field').hidden=true;}
    else{
      find('#pipeline-crop').closest('.field').hidden=true;
      find('#pipeline-policy').closest('.field').hidden=true;
      find('#pipeline-detector-field').hidden=true;find('#pipeline-caption-field').hidden=true;
      root.querySelector('[data-pipeline-field="allowDownload"]').closest('label').hidden=true;
      find('[data-pipeline-processing-preparation]').hidden=true;
    }
    root.querySelector('[data-training-caption-settings]').hidden=!tagging;
    find('#pipeline-policy').closest('details').querySelector('summary').textContent=tagging?'处理选项':'训练选项';
  }
  function feedback(message, error = false) { if (!ctx.signal.aborted) { find('#pipeline-feedback').textContent = message; find('#pipeline-feedback').className = 'form-feedback' + (error ? ' error' : ''); } }
  for(const [selector,field] of [['#pipeline-detector','detectorPath'],['#pipeline-caption','captionModelPath']])mountPathPicker(find(selector),ctx,{moduleId:'training',target:'pipeline',field,kind:'directory'});
  mountPathPicker(find('#pipeline-output'),ctx,{moduleId:'training',target:'training',field:'output_dir',kind:'directory',trainingType:()=>getConfig().model_train_type});
  mountResourcePreparation(find('[data-pipeline-processing-preparation]'),ctx,{...preparationFor('training-processing'),onTarget:field=>choosePreparedField(root,field)});
  if(tagging)captionSettings=mountTrainingCaptionSettings(find('[data-training-caption-settings]'),ctx,{
    getValue:()=>{let type=modelType;try{type=getConfig().model_train_type;}catch{}const choice=selectedCaptioner(type);return {...draft,modelTrainType:type,effectiveCaptionFormat:draft.captionSource==='connected'?(draft.captionFormat==='auto'?(naturalCaptionTypes.has(type)?'natural':'tags'):draft.captionFormat):choice.format,captionerPreparation:captionerPreparation(choice)};},
    onChange:patch=>{if(Object.hasOwn(patch,'captioner'))patch.captionFormat=patch.captioner==='auto'?'auto':resolveCaptioner({captioner:patch.captioner}).format;Object.assign(draft,patch);remember();syncConfig();},
    onPrepareCaptioner:async({captioner})=>{
      const id=captioner==='florence2'?'florence2-base':captioner;
      captionerResources=await ctx.api('/api/training/captioners/prepare',{method:'POST',body:{captionerId:id,downloadEndpoint:draft.taggerOptions?.download_endpoint||'默认'},signal:ctx.signal});if(!ctx.signal.aborted)captionSettings.refresh();
    },
    onCancelCaptioner:async()=>{const taskId=captionerResources.task?.id;if(!taskId)return;captionerResources=await ctx.api('/api/training/captioners/cancel',{method:'POST',body:{taskId},signal:ctx.signal});if(!ctx.signal.aborted)captionSettings.refresh();},
  });
  function selectedCaptioner(type=modelType){return resolveCaptioner({captioner:draft.captioner||'auto',modelTrainType:type,taggerModel:draft.taggerModel,captionFormat:draft.captionFormat});}
  function captionerPreparation(choice){
    const id=choice.id==='florence2'?'florence2-base':choice.id,item=captionerResources.items?.find(item=>item.id===id),task=captionerResources.task;
    const running=task?.captionerId===id&&task.status==='running';
    const failed=task?.captionerId===id&&task.status==='failed';
    return {id:choice.id,status:running?'preparing':item?.ready?'ready':failed?'failed':item?'missing':'unknown',error:failed?task.error:undefined,label:running?'正在下载…':item?.ready?'本地文件已就绪':failed?'下载失败':item?.reason||'尚未检查'};
  }
  function controls() {
    find('#pipeline-start').disabled = busy || !draft.pending && !aiReady && (!tagging || draft.captionSource==='connected'); find('#pipeline-start').textContent = draft.pending ? '核对本次流程' : tagging?'开始打标':'开始训练';
    root.querySelectorAll(selectorFor('[data-pipeline-field],[data-quick-model-field],[data-quick-config-field],[data-memory-field],#pipeline-train-type,#pipeline-choose,#pipeline-load-models,#pipeline-apply-recipe')).forEach(node => { node.disabled = busy || !!draft.pending || !!node.closest('[hidden]'); });
    if(find('#pipeline-repeats-field').hidden)find('#pipeline-repeats').disabled=true;
    captionSettings?.setDisabled(busy||!!draft.pending);
    syncPathPickers(root);
    find('#pipeline-ai-status').textContent = aiReady ? 'AI 已启用' : '请先连接 AI'; find('#pipeline-ai-status').className = 'status-chip' + (aiReady ? ' good' : '');
  }
  function draw() {
    const nextListKey = JSON.stringify([draft.selected, jobs.map(({ id, goal, mode, state }) => ({ id, goal, mode, state }))]);
    if (nextListKey !== listKey) { listKey = nextListKey; find('#pipeline-jobs').innerHTML = jobs.length ? jobs.map(job => `<button type="button" class="training-task-row" data-pipeline-select="${e(job.id)}" aria-pressed="${draft.selected === job.id}"><strong>${e(job.goal || (job.mode === 'tag' ? '图集打标' : 'LoRA 训练'))}</strong><span class="status-chip">${e(states[job.state] || job.state)}</span></button>`).join('') : '<p class="training-empty">暂无流程</p>'; }
    const job = jobs.find(job => job.id === draft.selected), detail = find('#pipeline-detail');
    if (!job) { detail.innerHTML = ''; return; }
    const renderKey = JSON.stringify([job.id, job.state, job.cancelRequestedAt, job.stage, job.plan, job.configuration, job.steps, job.tasks, job.summary, job.error, job.workspace, job.outputDirectory, job.outputs, cancelFor]);
    if (detail.dataset.renderKey === renderKey) return;
    if (detail.dataset.workflowId) { sampleViews.set(detail.dataset.workflowId, !!detail.querySelector('.training-pipeline-samples')?.open); configViews.set(detail.dataset.workflowId, !!detail.querySelector('.training-pipeline-configuration')?.open); }
    detail.dataset.workflowId = job.id; detail.dataset.renderKey = renderKey;
    detail.innerHTML = `<div class="panel-heading"><h2>${e(job.goal || '图集流程')}</h2><span class="status-chip">${e(states[job.state] || job.state)}</span></div>
      <ol class="training-pipeline-steps">${(job.steps || []).filter(step=>!(job.mode==='tag'&&step.id==='train')&&!(job.mode==='train'&&['crop','tag'].includes(step.id)&&step.status==='skipped')).map(step => `<li data-state="${e(step.status)}"><span>${e(step.label)}</span><small>${e(stepNames[step.status] || step.status)}</small></li>`).join('')}</ol>
      ${job.mode==='tag'&&job.state==='completed'&&job.imageDirectory?'<button type="button" class="button primary" data-use-training-dataset>用于 LoRA 训练</button>':''}
      ${job.plan ? `<p class="training-pipeline-plan">${e(job.plan.summary)}${job.plan.aiUsed ? ' · AI 辅助' : ' · 本地方案'}${job.plan.steps && job.mode !== 'tag' ? ` · ${e(job.plan.steps)} 步` : ''}</p>` : ''}
      ${job.summary ? `<p>${job.summary.originalCount !== undefined ? `${e(job.summary.originalCount)} 张原图 · ${e(job.summary.derivedCount || 0)} 张裁切图` : `${e(job.summary.imageCount)} 张图片`}${job.summary.captioned !== undefined ? ` · ${e(job.summary.captioned)} 张已有标注` : ''}</p>` : ''}
      ${job.stage==='tag'&&job.summary?.captionProgress?`<p role="status">AI 标注 ${e(job.summary.captionProgress.completed)} / ${e(job.summary.captionProgress.total)}</p>`:''}
      ${job.error ? `<p class="form-feedback error" role="alert">${e(job.error)}</p>` : ''}
      <div class="training-pipeline-actions">${job.state === 'running' ? '<button class="button" type="button" data-pipeline-action="pause">阶段结束后暂停</button>' : ['paused', 'blocked'].includes(job.state)&&!job.cancelRequestedAt ? '<button class="button primary" type="button" data-pipeline-action="resume">继续流程</button>' : ''}${!['completed', 'cancelled'].includes(job.state) ? `<button class="button ghost" type="button" data-pipeline-action="cancel">${job.cancelRequestedAt?'继续取消':'取消流程'}</button>` : ''}${Object.entries(job.tasks || {}).filter(([, id]) => id).map(([stage, id]) => `<button type="button" class="text-link" data-training-task="${e(id)}">查看${{ crop: '裁切', tag: '打标', train: '训练' }[stage] || e(stage)}任务</button>`).join('')}</div>
      ${cancelFor === job.id ? '<div class="training-stop-confirm"><p>取消会停止当前阶段；训练不能保证保存当前步骤。</p><div class="training-stop-actions"><button type="button" class="button danger" data-pipeline-action="confirm-cancel">确认取消流程</button><button type="button" class="button" data-pipeline-action="keep">保留流程</button></div></div>' : ''}
      ${job.configuration && !tagging ? `<details class="training-pipeline-configuration"><summary>查看采用参数</summary><button type="button" class="button small" data-pipeline-config>载入全量调整</button><div data-pipeline-configuration></div></details>` : ''}
      ${job.summary?.reviewCount ? `<details class="training-pipeline-reviews"><summary>${e(job.summary.reviewCount)} 张图片需复核</summary><ul>${(job.summary.reviews || []).map(review => `<li><strong>${e(review.image)}</strong><span>${e((review.reasons || []).join('；'))}</span></li>`).join('')}</ul></details>` : ''}
      ${(job.summary?.samples || []).length ? `<details class="training-pipeline-samples"><summary>查看图片与标注</summary>${job.summary.samples.map((sample, index) => `<figure><img src="${e(ctx.url ? ctx.url(`/api/training/workflows/${encodeURIComponent(job.id)}/samples/${index}`) : `/api/training/workflows/${encodeURIComponent(job.id)}/samples/${index}`)}" alt="${e(sample.image)}" loading="lazy"><figcaption><strong>${e({ original: '原图', subject: '角色主体', portrait: '脸部特写', pose: '姿势裁切' }[sample.kind] || '裁切图')} · ${e(sample.image)}</strong><p>${e(sample.caption)}</p></figcaption></figure>`).join('')}</details>` : ''}
      ${job.workspace ? `<p class="training-pipeline-path">工作副本：${e(job.workspace)}</p>` : ''}${job.outputDirectory?`<p class="training-pipeline-path">输出目录：${e(job.outputDirectory)}</p>`:''}${(job.outputs || []).length ? `<h3>训练产物</h3><ul class="training-output-list">${job.outputs.map(file => `<li><strong>${e(file.name)}</strong><small>${e(file.path)}</small></li>`).join('')}</ul>` : ''}`;
    const samples = detail.querySelector('.training-pipeline-samples'); if (samples) samples.open = sampleViews.get(job.id) || false;
    const configuration = detail.querySelector('.training-pipeline-configuration');
    if (configuration) { on(configuration, 'toggle', () => { if (configuration.open) void showConfiguration(job, configuration); }); configuration.open = configViews.get(job.id) || false; }
  }
  async function showConfiguration(job, details) {
    const target = details.querySelector('[data-pipeline-configuration]'); if (target.dataset.loaded) return; target.dataset.loaded = 'true';
    const form = mountTrainingForm(target, { config: job.configuration, readOnly: true, idPrefix: 'pipeline-snapshot-'+job.id+'-', signal: ctx.signal, onChange: () => {}, onError: message => { target.textContent = message; } });
    try { const result = await ctx.api('/api/training/schema?type=' + encodeURIComponent(job.configuration.model_train_type), { signal: ctx.signal }); if (target.isConnected && !ctx.signal.aborted) form.schema(result.form); }
    catch { if (target.isConnected) target.innerHTML = `<pre>${e(JSON.stringify(job.configuration, null, 2))}</pre>`; }
  }
  async function refresh() {
    const current = ++generation;
    try { const [result,connection,resources]=await Promise.all([api(''),ctx.api('/api/ai/modules/training/config',{signal:ctx.signal}),tagging?ctx.api('/api/training/captioners',{signal:ctx.signal}).catch(()=>null):null]); if(ctx.signal.aborted||current!==generation)return;if(resources)captionerResources=resources;aiReady=connection.effective?.enabled===true;controls();captionSettings?.refresh();jobs=(result.jobs||[]).filter(job=>job.mode===mode);if(!jobs.some(job=>job.id===draft.selected)){draft.selected=jobs[0]?.id||null;remember();}draw(); }
    catch (error) { if (!ctx.signal.aborted && current === generation) feedback(error.message, true); }
  }
  function syncConfig() {
    let automatic = 'tags';
    try {
      const config = getConfig(); automatic = naturalCaptionTypes.has(config.model_train_type) ? 'natural' : 'tags';
      find('#pipeline-repeats-field').hidden=config.model_train_type==='moss-image-anima-lora';
      find('#pipeline-repeats').disabled=busy||!!draft.pending||find('#pipeline-repeats-field').hidden;
      if(!tagging)syncMemory(config);
      if(document.activeElement!==find('#pipeline-output'))find('#pipeline-output').value=config.output_dir||'';
      const catalog = getCatalog(), types = catalog.some(item => item.train_type === config.model_train_type) ? catalog : [{ train_type: config.model_train_type, bundled: true }, ...catalog];
      const options = types.filter(item => (item.control_supported===true||item.bundled !== false) && item.schema_name !== null).map(item => `<option value="${e(item.train_type)}" ${item.train_type === config.model_train_type ? 'selected' : ''}>${e(typeName(item.train_type))}</option>`).join('');
      if (find('#pipeline-train-type').dataset.optionsKey !== options) { find('#pipeline-train-type').dataset.optionsKey = options; find('#pipeline-train-type').innerHTML = options; }
      const schema=getSchema(),baseKey=baseModelField(config.model_train_type,config);
      const modelFields=(schema?.sections||[]).flatMap(section=>section.fields).filter(field=>modelPathKeys.includes(field.key)&&field.key!==baseKey&&conditionsMatch(field.conditions,config));
      const modelFieldsKey=JSON.stringify([config.model_train_type,baseKey,modelFields]);
      if (find('#pipeline-component-fields').dataset.renderKey!==modelFieldsKey) {
        find('#pipeline-component-fields').dataset.renderKey=modelFieldsKey;
        modelPickers.forEach(dispose=>dispose());modelPickers=[];
        modelType = config.model_train_type;
        find('#pipeline-model-path').dataset.quickModelField=baseKey;
        find('#pipeline-component-fields').innerHTML = modelFields.map(field => `<div class="field"><label for="pipeline-component-${field.key}">${e(fieldLabel(field))} ${help(fieldHelp(field),fieldLabel(field)+'说明')}</label><input id="pipeline-component-${field.key}" data-quick-model-field="${field.key}" spellcheck="false"></div>`).join('');
        root.querySelectorAll('[data-quick-model-field]').forEach(input=>{const key=input.dataset.quickModelField,field=(schema?.sections||[]).flatMap(section=>section.fields).find(field=>field.key===key&&conditionsMatch(field.conditions,config));modelPickers.push(mountPathPicker(input,ctx,{moduleId:'training',target:'training',field:key,kind:trainingPathKind(field||{key,type:'string',role:'filepicker'},modelType),trainingType:()=>getConfig().model_train_type}));});
      }
      root.querySelectorAll('[data-quick-model-field]').forEach(node => { if (document.activeElement !== node) node.value = config[node.dataset.quickModelField] || ''; });
    }
    catch { /* Keep unapplied full-parameter JSON intact. Submission reports it. */ }
    find('#pipeline-format option[value=auto]').textContent = tagging?'标签（默认）':`跟随底模（${automatic === 'natural' ? '自然语言' : '标签'}）`;
    if(document.activeElement!==find('#pipeline-format'))find('#pipeline-format').value=draft.captionFormat;
    find('#pipeline-crop option[value=auto]').textContent = { character: '主体与脸部细节', style: '保留完整构图', pose: '保留完整动作与关节' }[draft.purpose];
    const format = draft.captionFormat === 'auto' ? automatic : draft.captionFormat;
    find('#pipeline-caption-field').hidden = draft.captionSource==='connected'||format !== 'natural';
    find('#pipeline-detector-field').hidden = draft.cropMode === 'none' || draft.purpose === 'style';
    find('[data-pipeline-processing-preparation]').hidden=draft.captionSource==='connected'&&find('#pipeline-detector-field').hidden;
    captionSettings?.refresh();
    workspaceVisibility();controls();
  }
  function syncMemory(config){
    const target=find('[data-memory-fields]'),form=getSchema(),all=memoryFields(form),saved=draft.memoryByType[config.model_train_type]||{};
    const key=JSON.stringify([config.model_train_type,all,saved,all.map(field=>(field.conditions||[]).map(condition=>config[condition.key]))]);
    if(target.dataset.renderKey===key)return;target.dataset.renderKey=key;
    target.innerHTML=all.length?all.map(field=>{
      const id='pipeline-memory-'+field.key,value=saved[field.key],visible=conditionsMatch(field.conditions,{...config,...saved});
      return `<div class="field" ${visible?'':'hidden'}><label for="${id}">${e(field.label)} ${help(field.description,field.label+'说明')}</label>${field.type==='boolean'?`<select id="${id}" data-memory-field="${field.key}"><option value="" ${value===undefined?'selected':''}>跟随参数方案</option><option value="true" ${value===true?'selected':''}>开启</option><option value="false" ${value===false?'selected':''}>关闭</option></select>`:`<input id="${id}" data-memory-field="${field.key}" type="number" min="${field.min??1}" ${field.max!==undefined?`max="${field.max}"`:''} step="1" value="${value??''}" placeholder="跟随参数方案">`}</div>`;
    }).join(''):`<p class="form-feedback" role="status">${form?'当前训练器没有可调整的显存选项':'正在读取显存选项…'}</p>`;
    controls();
  }
  async function start(mode) {
    if (busy) return;
    if (!draft.pending && !find('#pipeline-form').reportValidity()) return;
    try {
      if (!draft.pending) {
        const config = getConfig();
        if (mode === 'train' && !config[baseModelField(config.model_train_type,config)]) throw new Error('请填写底模路径，或读取已有模型配置。');
        const { pending, selected, memoryByType, tagConfig, ...input } = draft;
        if(mode==='train'){
          Object.assign(input,{captionPolicy:'existing',captionSource:'local',cropMode:'none',allowDownload:false});
          for(const key of ['captioner','taggerOptions','taggerModel','aiCaptionPrompt','captionModelPath','detectorPath'])delete input[key];
        }
        if(input.captionSource==='connected'||(input.captionFormat==='auto'?naturalCaptionTypes.has(config.model_train_type):input.captionFormat==='natural'))delete input.taggerOptions;
        const memoryOptions=memoryByType[config.model_train_type]||{};
        if(Object.keys(memoryOptions).length)input.memoryOptions=memoryOptions;
        delete input.cropDefaultsVersion;
        draft.pending = { requestId: crypto.randomUUID(), input: { ...input, aiEnabled:mode==='train',mode },config,endpoint:mode==='train'?'quick-start':'workflows' }; remember();
      }
      busy = true; controls(); feedback('正在创建流程…');
      const { endpoint, ...request } = draft.pending;
      const result = await ctx.api('/api/training/' + (endpoint === 'quick-start' ? 'quick-start' : 'workflows'), { method: 'POST', body: request, timeoutMs: 30000, signal: ctx.signal }); if (ctx.signal.aborted) return;
      draft.selected = result.job.id; clearPending(); feedback('流程已创建，可以随时查看阶段状态。'); await refresh();
    } catch (error) {
      if (error.status >= 400 && error.status < 500) clearPending();
      feedback(error.message + (draft.pending ? ' 再次点击核对将沿用同一编号与参数。' : ''), true);
    } finally { busy = false; if (!ctx.signal.aborted) controls(); }
  }
  function clearPending() {
    draft.pending = null;
    if (legacyDraft && draft.cropDefaultsVersion !== 1) { draft.cropMode = 'none'; draft.cropDefaultsVersion = 1; find('#pipeline-crop').value = 'none'; syncConfig(); }
    remember();
  }
  for (const event of ['input', 'change']) on(find('#pipeline-form'), event, event => {
    const node = event.target, key = node.dataset.pipelineField; if (!key) return;
    draft[key] = node.type === 'checkbox' ? node.checked : node.type === 'number' ? node.valueAsNumber : node.value; remember();
    if(key==='captionFormat'&&draft.captionSource!=='connected')draft.captioner=draft.captionFormat==='auto'?'auto':draft.captionFormat==='natural'?'florence2':draft.taggerModel;
    if (['purpose', 'cropMode', 'captionFormat'].includes(key)) syncConfig();
  });
  on(find('#pipeline-form'), 'submit', event => { event.preventDefault(); void start(mode); });
  on(find('[data-memory-fields]'),'change',event=>{
    const key=event.target.dataset.memoryField;if(!key)return;
    try{
      const config=getConfig(),options={...(draft.memoryByType[config.model_train_type]||{})};
      if(event.target.value==='')delete options[key];else options[key]=event.target.type==='number'?event.target.valueAsNumber:event.target.value==='true';
      const fields=memoryFields(getSchema()),effective={...config,...options};
      for(const field of fields)if(!conditionsMatch(field.conditions,effective))delete options[field.key];
      draft.memoryByType[config.model_train_type]=options;remember();syncMemory(config);
    }catch(error){feedback(error.message,true);}
  });
  on(find('#pipeline-edit-parameters'), 'click', openParameters);
  on(find('#pipeline-ai-connect'), 'click', () => { const control = root.closest('.instance-panel')?.querySelector('[data-module-ai-control="training"]'); if (control) control.click(); else ctx.notify('请在右上角“AI 接入”连接并启用训练模型。'); });
  on(find('#pipeline-train-type'), 'change', event => { try { const previous = getConfig(), type = event.target.value; setConfig({ model_train_type: type, output_dir: previous.output_dir || '' }); syncConfig(); } catch (error) { feedback(error.message, true); syncConfig(); } });
  on(find('#pipeline-form'), 'input', event => { const key = event.target.dataset.quickModelField||event.target.dataset.quickConfigField; if (!key) return; try { setConfig({ ...getConfig(), [key]: event.target.value }); } catch (error) { feedback(error.message, true); } });
  on(find('#pipeline-load-models'), 'click', async () => {
    try {
      const [local, original] = await Promise.allSettled([ctx.api('/api/training/presets', { signal: ctx.signal }), ctx.api('/api/training/saved-configs', { signal: ctx.signal })]);
      recipes = [...(local.status === 'fulfilled' ? local.value.presets || [] : []), ...(original.status === 'fulfilled' ? original.value.configs || [] : [])].filter(item => item.config?.[baseModelField(item.config.model_train_type,item.config)]);
      find('#pipeline-recipes').hidden = !recipes.length; find('#pipeline-recipe').innerHTML = recipes.map((item, index) => `<option value="${index}">${e(item.name)} · ${e(typeName(item.config.model_train_type))}</option>`).join('');
      if (!recipes.length) feedback('没有找到模型参数，请填写模型路径和所需组件。');
    } catch (error) { feedback(error.message, true); }
  });
  on(find('#pipeline-apply-recipe'), 'click', () => { const recipe = recipes[Number(find('#pipeline-recipe').value)]; if (recipe) { setConfig(recipe.config); syncConfig(); feedback('已载入模型及组件。'); } });
  on(find('#pipeline-choose'), 'click', async () => { const node = find('#pipeline-choose'); node.disabled = true; try { const result = await api('/choose-dataset', {}); if (!ctx.signal.aborted && result.directory) { draft.sourcePath = result.directory; find('#pipeline-source').value = result.directory; remember(); } } catch (error) { feedback(error.message, true); } finally { if (!ctx.signal.aborted) controls(); } });
  on(root, 'click', async event => {
    if(event.target.closest('[data-use-training-dataset]')){const job=jobs.find(job=>job.id===draft.selected);if(job?.state==='completed'&&job.imageDirectory)onUseDataset?.(job.imageDirectory,job.plan?.strategy?.captionFormat);return;}
    if (event.target.closest('[data-pipeline-config]')) { const job = jobs.find(job => job.id === draft.selected); if (job?.configuration) editConfiguration?.(job.configuration); return; }
    const selection = event.target.closest('[data-pipeline-select]'); if (selection) { draft.selected = selection.dataset.pipelineSelect; cancelFor = null; remember(); draw(); return; }
    const action = event.target.closest('[data-pipeline-action]')?.dataset.pipelineAction; if (!action || busy) return;
    if (action === 'cancel' || action === 'keep') { cancelFor = action === 'cancel' ? draft.selected : null; draw(); return; }
    busy = true; controls();
    try { await api('/' + encodeURIComponent(draft.selected) + '/' + (action === 'confirm-cancel' ? 'cancel' : action), {}); cancelFor = null; await refresh(); }
    catch (error) { feedback(error.message, true); }
    finally { busy = false; if (!ctx.signal.aborted) controls(); }
  });
  controls(); syncConfig(); draw();
  return { refresh, syncConfig, useDataset(path,format){
    if(busy||draft.pending)throw new Error('请先核对当前训练提交，再切换图集。');
    draft.sourcePath=path;if(['tags','natural'].includes(format))draft.captionFormat=format;
    find('#pipeline-source').value=path;remember();syncConfig();feedback('已带入标注图集，选择底模并检查参数后可开始训练。');
  } };
}
