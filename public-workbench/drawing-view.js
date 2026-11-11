import {escape as e,icon,moduleIcon,eventList,help,downloadJson} from './components.js';
import {mountConnection} from './drawing-connection-view.js';
import {mountWorkflowAssistant} from './drawing-assistant-view.js';
import {mountDrawingMcp} from './drawing-mcp-view.js';
import {canImportInspection,inspectionMarkup,bindInspectionActions} from './drawing-preflight-view.js';
import {renderDrawingJobs} from './drawing-job-view.js';
import {saveCharacterResource} from './character-resources-ui.js';
import {mountWorkflowCompletion} from './drawing-completion-view.js';
import {mountDrawingParameters} from './drawing-parameters-view.js';
import {mountWorkflowSearch} from './drawing-workflow-search.js';
import {mountDrawingOutput} from './drawing-output-view.js';

const API='/api/modules/drawing';
const tabs=[['overview','绘图'],['workflows','工作流与 MCP'],['config','连接配置'],['records','运行记录']];

export function mount(root,ctx){
  const find=selector=>root.querySelector(selector);
  let tab=tabs.some(([id])=>id===ctx.ui.moduleTabs.drawing)?ctx.ui.moduleTabs.drawing:'overview',controller,data,workflow,polling,generation=0,tabRequest=0,uploading=0;
  let pending=ctx.drafts.read('drawing:pending',null),submitting=false,workflowLoading=false,parameters,opening=false,savingBrowser=false,openingMode='start',serviceError='';
  function rememberPending(value){pending=value;ctx.drafts.write('drawing:pending',value);}
  function submissionControls(){
    const button=find('#generate-image');if(!button)return;
    button.textContent=pending?'核对上次任务':'运行工作流';
    button.formNoValidate=!!pending;
    button.disabled=submitting||workflowLoading||uploading>0||(!pending&&(!workflow||!data?.connection.connected||parameters?.hasUnavailableAdjustments()));
    parameters?.setDisabled(submitting||workflowLoading);
    const preview=find('#drawing-preview-method');if(preview)preview.disabled=submitting||workflowLoading||uploading>0;
    const selector=find('#drawing-workflow');if(selector)selector.disabled=submitting;
    const fresh=find('#drawing-new-request'),notice=find('#drawing-pending-notice');
    if(fresh){fresh.hidden=!pending;fresh.disabled=submitting||workflowLoading||uploading>0||!workflow||!data?.connection.connected||parameters?.hasUnavailableAdjustments();}
    if(notice){notice.hidden=!pending;notice.textContent=pending?'上次提交尚未确认。核对将使用当时的完整参数；按当前参数新建可能额外运行一次任务。':'';}
  }
  const post=(path,body={},timeoutMs=30000)=>ctx.api(API+path,{method:'POST',body,timeoutMs});
  const load=async()=>{
    data=await ctx.api(API+'/state');
    if(!ctx.signal.aborted){
      serviceControls();
      submissionControls();
    }
    return data;
  };
  const report=(message,error=false)=>{const node=find('#drawing-feedback');if(node){node.textContent=message;node.className='form-feedback'+(error?' error':'');}else ctx.notify(message,error);};
  const run=(button,job)=>{const pageSignal=controller?.signal;return ctx.action(button,async()=>{try{await job();}catch(error){if(!ctx.signal.aborted&&!pageSignal?.aborted)report(error.message,true);}});};
  root.innerHTML=`<div class="module-heading drawing-heading">${moduleIcon('drawing','large')}<div class="heading-title"><h1>角色绘图</h1>${help('制作工作流、通过 MCP 接入外部 AI，并生成和保存角色作品。可以直接在这里启动或连接 ComfyUI，环境维护位于启动器。','绘图说明')}<span class="status-chip" id="drawing-connection" role="status">ComfyUI 未连接</span></div><div class="module-header-actions"><div class="drawing-service-controls"><label class="check-label drawing-browser-choice"><input type="checkbox" id="drawing-open-browser" disabled>打开浏览器前端</label><button type="button" class="button small" id="open-comfy" disabled>${icon('play')}启动 ComfyUI</button></div><button type="button" class="button small" id="open-model-downloads">模型与插件 ${icon('download')}</button><button type="button" class="button small" id="open-launcher">ComfyUI 启动器 ${icon('arrow')}</button><div class="remove-control"><button class="button ghost small" id="remove-module" type="button">移除入口</button><small>保留配置与资料</small></div></div></div><div class="module-tabs drawing-tabs" role="tablist" aria-label="模块页面">${tabs.map(([id,label])=>`<button id="tab-${id}" type="button" role="tab" data-tab="${id}" aria-controls="module-panel">${label}</button>`).join('')}</div><p id="drawing-feedback" class="form-feedback" role="status"></p><section id="module-panel" role="tabpanel"></section>`;

  function serviceControls(){
    const browser=find('#drawing-open-browser'),button=find('#open-comfy'),chip=find('#drawing-connection'),online=data?.connection.connected;
    const progress=openingMode==='connect'?'正在连接':'正在启动';
    if(!opening&&!savingBrowser)browser.checked=data?.preferences?.openBrowser===true;
    browser.disabled=!data||opening||savingBrowser;
    button.disabled=!data||opening||savingBrowser;
    button.innerHTML=opening?`${progress} ComfyUI…`:online?(browser.checked?`打开 ComfyUI ${icon('arrow')}`:`${icon('activity')}重新连接`):`${icon('play')}启动 ComfyUI`;
    button.setAttribute('aria-busy',String(opening));
    chip.textContent=opening?`ComfyUI ${progress}…`:online?'ComfyUI 已连接':serviceError?'ComfyUI 启动失败':'ComfyUI 未连接';
    chip.classList.toggle('good',!opening&&!!online);
  }
  const serviceAction=(button,job)=>ctx.action(button,async()=>{try{await job();}catch(error){if(!ctx.signal.aborted)report(error.message,true);}});
  find('#open-model-downloads').onclick=event=>serviceAction(event.currentTarget,()=>ctx.navigateModule('comfyui',{tab:'resources',section:'downloads'}));
  find('#open-launcher').onclick=event=>serviceAction(event.currentTarget,()=>ctx.navigateModule('comfyui',{tab:'runtime'}));
  const browser=find('#drawing-open-browser');
  browser.onchange=async()=>{
    savingBrowser=true;serviceControls();
    try{const preferences=await post('/preferences',{openBrowser:browser.checked});if(!ctx.signal.aborted)data.preferences=preferences;}
    catch(error){if(!ctx.signal.aborted)report(error.message,true);}
    finally{savingBrowser=false;if(!ctx.signal.aborted)serviceControls();}
  };
  find('#open-comfy').onclick=async event=>{
    if(opening||savingBrowser)return;
    await ctx.action(event.currentTarget,async()=>{
      opening=true;openingMode=data?.connection.connected?'connect':'start';serviceError='';serviceControls();
      try{
        report(openingMode==='connect'?'正在连接 ComfyUI…':'ComfyUI 正在启动…');
        const result=await post('/open-service',{openBrowser:browser.checked},35000);if(ctx.signal.aborted)return;
        if(result.starting){
          openingMode='start';serviceControls();report('ComfyUI 正在启动…');const deadline=Date.now()+5*60*1000;
          while(!ctx.signal.aborted){await load();if(ctx.signal.aborted)return;if(data.startup?.status==='failed')throw new Error(data.startup.error);if(data.connection.connected&&data.startup?.status!=='waiting')break;if(Date.now()>=deadline)throw new Error('ComfyUI 启动仍未完成，请到启动器查看日志。');await new Promise(done=>setTimeout(done,1000));}
        }else await load();
        if(ctx.signal.aborted)return;if(result.openBrowser&&!result.browserManaged)window.open(result.url,'_blank','noopener');
        await draw();if(!ctx.signal.aborted)report('ComfyUI 已连接。');
      }catch(error){if(!ctx.signal.aborted){serviceError=error.message;report(error.message,true);}}
      finally{opening=false;if(!ctx.signal.aborted)serviceControls();}
    });
  };

  function saveDraft(){if(workflow&&parameters&&find('#drawing-parameters')){ctx.drafts.write('drawing:'+workflow.id,parameters.readValuesDraft());ctx.drafts.write('drawing:adjustments:'+workflow.id,parameters.readDraft());ctx.drafts.write('drawing:seed-modes:'+workflow.id,parameters.readSeedModes());}}
  function renderParameters(mine,signal){
    const id=workflow.id,values=ctx.drafts.read('drawing:'+id,Object.fromEntries(workflow.fields.map(field=>[field.key,field.value])));
    parameters=mountDrawingParameters(find('#drawing-parameters'),{ctx,workflow,values,adjustments:ctx.drafts.read('drawing:adjustments:'+id,{}),seedModes:ctx.drafts.read('drawing:seed-modes:'+id,{}),signal,isCurrent:()=>mine===generation,onChange:()=>{saveDraft();submissionControls();},onBusy:value=>{uploading=value;submissionControls();},post,connected:()=>data.connection.connected,report});
  }
  async function chooseWorkflow(id){
    saveDraft();ctx.ui.drawingWorkflow=id;const mine=++generation,signal=controller.signal;uploading=0;
    workflowLoading=!!id;submissionControls();
    if(!id){workflow=null;parameters=null;find('#drawing-parameters').innerHTML='';submissionControls();return;}
    let next;
    try{next=await ctx.api(API+'/workflows/'+id);}
    catch(error){
      if(mine!==generation||signal.aborted)return;
      ctx.ui.drawingWorkflow=workflow?.id||'';find('#drawing-workflow').value=ctx.ui.drawingWorkflow;if(workflow)renderParameters(mine,signal);throw error;
    }finally{if(mine===generation){workflowLoading=false;if(!signal.aborted)submissionControls();}}
    if(mine!==generation||signal.aborted)return;
    workflow=next;renderParameters(mine,signal);
    submissionControls();
  }
  function renderJobs(){
    const node=find('#drawing-jobs');if(!node)return;
    const update=(button,id,action)=>run(button,async()=>{await post(`/jobs/${id}/${action}`);await load();if(!ctx.signal.aborted)renderJobs();});
    const remove=(button,id)=>run(button,async()=>{
      const job=data.jobs.find(item=>item.id===id);await post(`/jobs/${id}/hide`);
      ctx.ui.drawingRemovedJobs=[...(ctx.ui.drawingRemovedJobs||[]).filter(item=>item.id!==id),{id,name:job?.workflowName||'作品'}];
      await load();if(!ctx.signal.aborted)renderJobs();
    });
    const removed=ctx.ui.drawingRemovedJobs?.at(-1),feedback=find('#drawing-history-feedback');feedback.hidden=!removed;
    if(removed){
      feedback.querySelector('span').textContent=`已移除「${removed.name}」的记录，作品文件保留。`;
      find('#drawing-undo-remove').onclick=event=>run(event.currentTarget,async()=>{
        await post(`/jobs/${removed.id}/restore`);ctx.ui.drawingRemovedJobs=ctx.ui.drawingRemovedJobs.filter(item=>item.id!==removed.id);
        await load();if(!ctx.signal.aborted)renderJobs();
      });
    }
    renderDrawingJobs(node,data.jobs,{refresh:(button,id)=>update(button,id,'refresh'),cancel:(button,id)=>update(button,id,'cancel'),remove,save:image=>void saveCharacterResource(ctx,{...image,kind:'image'}),view:url=>{const dialog=document.createElement('dialog');dialog.className='drawing-lightbox';dialog.innerHTML=`<button type="button" class="button">关闭</button><img src="${e(url)}" alt="绘图结果">`;document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();}});
  }
  async function overview(signal){
    find('#module-panel').innerHTML=`<div class="drawing-layout"><section class="drawing-controls panel glass"><div class="panel-heading"><h2>运行工作流</h2><button class="text-link" id="manage-workflows" type="button">工作流与 MCP ${icon('arrow')}</button></div><form id="drawing-generate-form"><div class="field"><label for="drawing-workflow">工作流</label><select id="drawing-workflow"><option value="">选择工作流</option>${data.workflows.map(w=>`<option value="${e(w.id)}">${e(w.name)}</option>`).join('')}</select></div><div id="drawing-parameters"></div><div class="form-actions"><button type="submit" class="button primary" id="generate-image" disabled>${icon('drawing')}运行工作流</button></div></form></section><section class="drawing-results"><div class="section-heading"><h2>作品与任务</h2><button class="text-link" type="button" id="refresh-drawing">${icon('activity')}刷新</button></div><div id="drawing-jobs" aria-live="polite"></div></section></div>`;
    find('#drawing-generate-form .form-actions').insertAdjacentHTML('beforeend','<button type="button" class="button" id="drawing-new-request" hidden>按当前参数新建</button>');
    find('#drawing-generate-form .form-actions').insertAdjacentHTML('beforebegin','<p class="form-feedback" id="drawing-pending-notice" role="status" hidden></p>');
    find('#drawing-jobs').insertAdjacentHTML('beforebegin','<div class="drawing-history-feedback" id="drawing-history-feedback" role="status" hidden><span></span><button type="button" class="text-link" id="drawing-undo-remove">撤销上次移除</button></div>');
    const output=document.createElement('div');find('#drawing-history-feedback').before(output);mountDrawingOutput(output,{...ctx,signal},data.preferences);
    find('#manage-workflows').onclick=()=>selectTab('workflows');find('#refresh-drawing').onclick=event=>run(event.currentTarget,async()=>{await load();renderJobs();});
    find('#drawing-workflow').onchange=event=>chooseWorkflow(event.target.value).catch(error=>report(error.message,true));
    const selected=ctx.ui.drawingWorkflow||data.workflows[0]?.id||'';find('#drawing-workflow').value=selected;if(selected)await chooseWorkflow(selected);if(signal.aborted)return;
    const previewControl=document.createElement('div');previewControl.className='field drawing-preview-control';
    previewControl.innerHTML=`<div class="field-label"><label for="drawing-preview-method">过程预览</label>${help('快速预览开销较低；清晰预览需要匹配当前模型的解码器，且不改变最终成图。','过程预览说明')}</div><select id="drawing-preview-method"><option value="auto">快速（推荐）</option><option value="taesd">清晰</option><option value="none">关闭</option></select><p class="drawing-preview-notice" id="drawing-preview-notice" hidden></p><button type="button" class="text-link" id="drawing-preview-get" hidden>获取预览解码器 ${icon('arrow')}</button>`;
    find('#drawing-generate-form .form-actions').before(previewControl);
    const previewSelect=find('#drawing-preview-method');previewSelect.value=ctx.ui.drawingPreviewMethod??(data.defaultPreviewMethod==='latent2rgb'?'auto':data.defaultPreviewMethod)??'auto';let previewOptions;
    const previewNotice=()=>{const notice=find('#drawing-preview-notice');if(!notice)return;find('#drawing-preview-get').hidden=previewSelect.value!=='taesd';let text='';if(previewOptions?.perPrompt===false)text='此服务的任务预览设置未核实，请通过启动器设置后重启。';else if(previewSelect.value==='taesd'&&previewOptions){const models=previewOptions.models;text=models.status==='missing'?'本机配置目录未找到解码器；远程服务请在服务端核对。不匹配时由 ComfyUI 尝试快速预览。':models.status==='available'?`本机已找到 ${[...new Set(models.decoders.map(item=>item.family))].join('、')} 解码器；仍需匹配当前模型与服务目录。`:'预览解码器尚未核实；不匹配时由 ComfyUI 尝试快速预览。';}notice.textContent=text;notice.hidden=!text;};
    find('#drawing-preview-get').onclick=event=>run(event.currentTarget,()=>ctx.navigateModule('comfyui',{tab:'resources',section:'downloads',previewDecoders:true}));
    previewSelect.onchange=()=>{ctx.ui.drawingPreviewMethod=previewSelect.value;previewNotice();};
    previewNotice();
    void ctx.api(API+'/preview-options').then(value=>{if(!signal.aborted){previewOptions=value;previewNotice();}}).catch(()=>{});
    async function submitDrawing(fresh=false){
      if(signal.aborted||submitting||workflowLoading||uploading||(!pending&&!workflow)||fresh&&!workflow)return;
      saveDraft();const retry=!!pending&&!fresh;
      if(!retry&&(!data.connection.connected||parameters?.hasUnavailableAdjustments()||!find('#drawing-generate-form').reportValidity()))return;
      let snapshot;
      try{
        if(retry)snapshot=structuredClone(pending);
        else{const adjustments=parameters?.readAdjustments(),hasAdjustments=adjustments&&(adjustments.loras.length||adjustments.images.length);snapshot={requestId:crypto.randomUUID(),workflowId:workflow.id,values:parameters.readSubmissionValues(),...(hasAdjustments?{adjustments}:{}),previewMethod:previewSelect.value,characterId:ctx.state.selectedCharacterId||null};}
      }
      catch(error){report(error.message,true);return;}
      saveDraft();
      rememberPending(snapshot);submitting=true;submissionControls();
      try{
        const job=await post('/jobs',structuredClone(snapshot));
        if(pending?.requestId===snapshot.requestId)rememberPending(null);
        if(!signal.aborted)report(job.error||(retry?'已核对上次任务，未重复提交。':'已提交任务。'),job.status==='failed');
        await load();if(!signal.aborted)renderJobs();
      }catch(error){if(!signal.aborted)report(error.message,true);}
      finally{submitting=false;if(!ctx.signal.aborted)submissionControls();}
    }
    find('#drawing-generate-form').addEventListener('submit',event=>{event.preventDefault();void submitDrawing();},{signal});
    find('#drawing-new-request').onclick=()=>submitDrawing(true);submissionControls();
    let pollBusy=false,lastPoll=0;renderJobs();polling=setInterval(async()=>{if(pollBusy||signal.aborted)return;const active=data.jobs.some(job=>['submitting','queued','running','unknown'].includes(job.status));if(!active&&Date.now()-lastPoll<2200)return;pollBusy=true;lastPoll=Date.now();try{await load();if(!signal.aborted)renderJobs();}catch{}finally{pollBusy=false;}},600);
  }
  function workflows(signal){
    let inspectionRequest=0;
    find('#module-panel').innerHTML=`<div class="drawing-workflow-layout"><section class="panel glass"><div class="panel-heading"><h2>工作流</h2><div class="drawing-actions"><button type="button" class="button" id="scan-workflows">扫描本地</button><button type="button" class="button primary" id="import-workflow">${icon('upload')}导入 JSON</button></div></div><input id="workflow-file" type="file" accept=".json" hidden><div id="workflow-inspection" class="drawing-inspection" hidden></div><div id="local-workflows"></div><div class="drawing-workflow-list">${data.workflows.length?data.workflows.map(w=>`<article><div><strong>${e(w.name)}</strong><small>${e(w.nodeCount)} 个节点</small></div><div class="drawing-actions"><button class="button small" type="button" data-use-workflow="${e(w.id)}">用于绘图</button><button class="text-link" type="button" data-inspect-workflow="${e(w.id)}">检查依赖</button><button class="text-link" type="button" data-export-workflow="${e(w.id)}">导出 API</button></div></article>`).join(''):'<p>尚未导入工作流</p>'}</div></section><aside class="drawing-workflow-side"><section id="drawing-workflow-assistant" class="panel glass"></section><section id="drawing-mcp-panel" class="panel glass"></section></aside></div>`;
    mountWorkflowAssistant(find('#drawing-workflow-assistant'),{...ctx,signal},{workflows:data.workflows,onImported:async()=>{await load();if(!signal.aborted)await draw();}});
    void mountDrawingMcp(find('#drawing-mcp-panel'),{...ctx,signal});
    async function inspect(pending,autoImport=false){
      const mine=++inspectionRequest,node=find('#workflow-inspection');node.hidden=false;node.innerHTML='<p class="form-feedback" role="status">正在核对实际节点与模型…</p>';
      const result=await post(pending.key?'/workflows/inspect-file':'/workflows/inspect',pending.key?{key:pending.key}:{document:pending.document});
      if(signal.aborted||mine!==inspectionRequest)return;
      const importNow=async()=>{const item=await post(pending.key?'/workflows/open':'/workflows/import',pending.key?{key:pending.key}:{name:pending.name,document:pending.document});if(signal.aborted||mine!==inspectionRequest)return;ctx.ui.drawingWorkflow=item.id;await selectTab('overview');};
      if(autoImport&&result.valid&&!result.warnings?.length){await importNow();return;}
      node.innerHTML=`<div class="panel-heading"><h2>${e(pending.name)}</h2><button type="button" class="text-link" id="inspection-dismiss">收起</button></div>${inspectionMarkup(result)}<div class="drawing-actions"><button type="button" class="button small" id="inspection-complete">补全依赖</button><button type="button" class="button small" id="inspection-recheck">${result.available?'重新检查':'连接后重新检查'}</button>${pending.existing?'':`<button type="button" class="button primary small" id="inspection-import" ${canImportInspection(result)?'':'disabled'}>继续校验并导入</button>`}<button type="button" class="text-link" id="inspection-export">导出报告</button></div><section id="workflow-completion" class="drawing-completion" hidden></section>`;
      bindInspectionActions(node,{...ctx,signal},result);
      find('#inspection-complete').onclick=event=>run(event.currentTarget,async()=>{const target=find('#workflow-completion');target.hidden=false;await mountWorkflowCompletion(target,{...ctx,signal},pending.key?{name:pending.name,key:pending.key}:{name:pending.name,document:pending.document});});
      find('#inspection-dismiss').onclick=()=>{inspectionRequest++;node.hidden=true;};
      find('#inspection-recheck').onclick=event=>run(event.currentTarget,async()=>{if(!result.available)data=await post('/connect');if(!signal.aborted)await inspect(pending);});
      if(find('#inspection-import'))find('#inspection-import').onclick=event=>run(event.currentTarget,importNow);
      find('#inspection-export').onclick=()=>downloadJson(result,pending.name+'-依赖检查');
    }
    find('#import-workflow').onclick=()=>find('#workflow-file').click();
    find('#workflow-file').onchange=async event=>{const file=event.target.files[0];if(!file)return;event.target.value='';try{if(file.size>2*1024*1024)throw new Error('工作流超过 2 MiB。');const document=JSON.parse((await file.text()).replace(/^\uFEFF/,''));if(!signal.aborted)await inspect({name:file.name.replace(/\.json$/i,''),document},true);}catch(error){if(!signal.aborted)report(error.message,true);}};
    const localSearch=mountWorkflowSearch(find('#local-workflows'),{...ctx,signal},(button,file)=>run(button,()=>inspect({key:file.key,name:file.name},true)));
    find('#scan-workflows').onclick=event=>{
      const button=event.currentTarget;
      return run(button,async()=>{
        button.textContent='正在扫描…';button.setAttribute('aria-busy','true');
        try{
          const result=await post('/workflows/scan');if(signal.aborted)return;
          localSearch.setFiles(result.files);button.title=(result.directories||[]).join('\n');
          report(`扫描完成，找到 ${result.files.length} 个工作流。`);
        }finally{if(button.isConnected){button.textContent='扫描本地';button.removeAttribute('aria-busy');}}
      });
    };
    root.querySelectorAll('[data-use-workflow]').forEach(button=>button.onclick=()=>{ctx.ui.drawingWorkflow=button.dataset.useWorkflow;void selectTab('overview');});
    root.querySelectorAll('[data-inspect-workflow]').forEach(button=>button.onclick=()=>run(button,async()=>{const item=await ctx.api(API+'/workflows/'+button.dataset.inspectWorkflow);if(!signal.aborted)await inspect({name:item.name,document:item.document,existing:true});}));
    root.querySelectorAll('[data-export-workflow]').forEach(button=>button.onclick=()=>run(button,async()=>downloadJson(await ctx.api(API+'/workflows/'+button.dataset.exportWorkflow+'/export'),'ComfyUI-工作流-API')));
  }
  async function draw(){
    saveDraft();controller?.abort();clearInterval(polling);parameters=null;controller=new AbortController();const signal=controller.signal;
    root.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});find('#module-panel').setAttribute('aria-labelledby','tab-'+tab);
    if(!data)await load();if(ctx.signal.aborted||signal.aborted)return;
    if(tab==='overview')await overview(signal);else if(tab==='workflows')workflows(signal);else if(tab==='config')mountConnection(find('#module-panel'),{...ctx,signal});else find('#module-panel').innerHTML=`<section class="panel glass"><h2>运行记录</h2>${eventList(ctx.state.events.filter(event=>event.moduleId==='drawing'),ctx.state.modules)}</section>`;
  }
  async function selectTab(next){if(next===tab)return;saveDraft();const request=++tabRequest;controller?.abort();clearInterval(polling);tab=next;ctx.ui.moduleTabs.drawing=tab;root.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});try{await load();if(request!==tabRequest||ctx.signal.aborted)return;await draw();}catch(error){ctx.notify(error.message,true);}}
  root.querySelectorAll('[data-tab]').forEach(button=>{button.onclick=()=>selectTab(button.dataset.tab);button.onkeydown=event=>{let index=tabs.findIndex(([id])=>id===tab);if(event.key==='ArrowRight')index=(index+1)%tabs.length;else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;event.preventDefault();void selectTab(tabs[index][0]);root.querySelector(`[data-tab="${tabs[index][0]}"]`).focus();};});
  find('#remove-module').onclick=event=>run(event.currentTarget,async()=>{await ctx.disableModule('drawing');ctx.navigate('home');});
  ctx.signal.addEventListener('abort',()=>{saveDraft();controller?.abort();clearInterval(polling);},{once:true});
  return draw();
}
