import {escape as e,icon,moduleIcon,help,eventList} from './components.js';
import {createSkinPreview} from './skin-preview.js';
import {mountEnvironmentDiscovery} from './environment-view.js';
import {mountModulePathPickers} from './path-picker.js';
import {openCharacterResources,resourceFile,saveCharacterResource} from './character-resources-ui.js';
import {mountResourcePreparation,preparationFor,choosePreparedField,pythonInstallCommand} from './resource-preparation.js';

const API='/api/modules/mc-skin/';
const ACTIVE=new Set(['queued','designing','rendering']);
const names={queued:'等待制作',designing:'设计像素中',rendering:'制作与校验中',completed:'已生成候选',failed:'制作失败',cancelled:'已取消',interrupted:'制作已中断'};
const fileBase64=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('无法读取图像文件。'));reader.readAsDataURL(file);});

export function mount(root,ctx){
  if(!document.querySelector('link[data-mc-skin-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./mc-skin.css',import.meta.url).href;link.dataset.mcSkinStyle='';document.head.append(link);}
  const draft=ctx.ui.mcSkin??={name:'',instruction:'',model:'slim',eyeTemplate:'eye_A',references:[],source:null,parentId:null,selectedJobId:null};
  const module=()=>ctx.state.modules.find(item=>item.id==='mc-skin');
  let data={runtime:{available:false},jobs:[],templates:[]},timer=null,refreshing=false,refreshPending=false,submitting=false,tab='create',configGeneration=0,checkConfig=()=>{};
  let configController;
  const uploads=()=>draft.pendingUploads||0;
  const changeUploads=delta=>{draft.pendingUploads=Math.max(0,uploads()+delta);window.dispatchEvent(new Event('mc-skin-draft-updated'));};
  const changeSource=()=>{draft.sourceRevision=(draft.sourceRevision||0)+1;};
  const find=selector=>root.querySelector(selector);
  const api=(path,value)=>ctx.api(API+path,value===undefined?{}:{method:'POST',body:value,timeoutMs:45000});
  const on=(node,event,listener)=>node.addEventListener(event,listener,{signal:ctx.signal});
  root.innerHTML=`<div class="module-heading"><div class="heading-title">${moduleIcon('mc-skin','large')}<h1>MC 皮肤</h1>${help('使用 Minecraft 像素皮肤 Skill 制作原生 64×64 PNG。候选、像素检查、浏览器预览和游戏内效果分别记录。','皮肤制作说明')}</div><div class="remove-control"><button class="button ghost small" type="button" id="remove-module">移除入口</button><small>保留配置与资料</small></div></div>
    <div class="module-tabs" role="tablist" aria-label="皮肤工作区"><button id="tab-overview" type="button" role="tab" data-tab="create" aria-controls="skin-create-panel" aria-selected="true">创作</button><button id="tab-config" type="button" role="tab" data-tab="config" aria-controls="skin-config-panel" aria-selected="false" tabindex="-1">接入配置</button><button id="tab-records" type="button" role="tab" data-tab="records" aria-controls="skin-records-panel" aria-selected="false" tabindex="-1">运行记录</button></div>
    <section id="skin-create-panel" role="tabpanel" aria-labelledby="tab-overview"><div class="skin-workspace">
      <section class="skin-form-panel panel glass"><div class="panel-heading"><h2 id="skin-form-title">制作皮肤</h2><button class="text-link" type="button" id="skin-new">新建</button></div><div id="skin-parent" class="skin-parent" hidden></div>
        <form id="skin-create-form"><div class="field"><label for="skin-name">作品名称</label><input id="skin-name" maxlength="100" required autocomplete="off" placeholder="未命名皮肤"></div>
          <div class="field"><div class="skin-upload-actions"><button class="button" type="button" id="skin-add-reference">${icon('plus')}参考图</button><button class="button" type="button" id="skin-import">${icon('upload')}原皮肤</button>${help('参考图支持 PNG、JPEG、WEBP，最多三张。原皮肤需要 64×64 PNG。每个文件不超过 8 MiB。','参考图与原皮肤要求')}</div><input id="skin-reference-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><input id="skin-source-file" type="file" accept="image/png" hidden><div id="skin-references" class="skin-references"></div><div id="skin-source" class="skin-source" hidden></div></div>
          <div class="skin-choice-row"><div class="field"><label for="skin-model">模型</label><select id="skin-model"><option value="slim">Slim · 细手臂</option><option value="classic">Classic · 标准手臂</option></select></div><div class="field"><label for="skin-eyes">眼型</label><select id="skin-eyes"><option value="eye_A">第一种角色眼睛</option><option value="eye_B">第二种角色眼睛</option><option value="keep" hidden>保持原眼型</option></select></div></div>
          <div class="field"><label for="skin-instruction">制作要求</label><textarea id="skin-instruction" rows="6" maxlength="12000" required placeholder="发型、衣装、配色，或这次需要修改的部位…"></textarea></div>
          <div id="skin-feedback" class="form-feedback" role="status" aria-live="polite"></div><div class="skin-submit-row"><button class="button" type="button" id="skin-cancel" hidden>取消制作</button><button class="button primary" type="submit" id="skin-generate">制作皮肤 ${icon('arrow')}</button></div>
        </form><div class="skin-environment"><span id="skin-runtime-status">正在检查环境…</span><div><button type="button" class="text-link" id="skin-check-runtime">检查环境</button><button type="button" class="text-link" id="skin-ai-settings">AI 设置 ${icon('settings')}</button></div></div><p id="skin-runtime-error" class="form-feedback error" hidden></p>
      </section><section class="skin-result"><div id="skin-preview" class="skin-preview-panel panel glass"></div><section class="skin-history-panel"><div class="section-heading"><h2>作品版本</h2><button class="text-link" type="button" id="skin-refresh">刷新 ${icon('activity')}</button></div><div id="skin-history" class="skin-history"><p class="quiet-empty">暂无作品</p></div></section></section></div></section>
    <section id="skin-config-panel" role="tabpanel" aria-labelledby="tab-config" hidden></section><section id="skin-records-panel" role="tabpanel" aria-labelledby="tab-records" hidden></section>`;
  find('#skin-check-runtime').insertAdjacentHTML('afterend','<button type="button" class="text-link" id="skin-prepare-runtime" hidden>准备制作环境</button>');
  const feedback=(message,error=false)=>{find('#skin-feedback').textContent=message;find('#skin-feedback').className=`form-feedback${error?' error':''}`;};
  const preview=createSkinPreview(find('#skin-preview'),{signal:ctx.signal,notify:message=>feedback(message,true),onSaveResource:job=>void saveCharacterResource(ctx,{url:job.files['skin.png'],name:job.name+'.png',kind:'skin',mime:'image/png'}),onContinue:job=>{remember();changeSource();draft.parentId=job.id;draft.source=null;draft.name=job.name;draft.model=job.model;draft.eyeTemplate=null;draft.instruction='';restore();drawStatus();find('#skin-instruction').focus();},onApprove:async job=>{await api('jobs/'+job.id+'/approve',{});await refreshState();}});
  const resources=document.createElement('button');resources.type='button';resources.className='button';resources.textContent='从角色资料选择';resources.dataset.skinLibrary='';
  resources.onclick=()=>void openCharacterResources(ctx,{accept:['image','skin'],onPick:async resource=>{if(resource.kind==='skin')changeSource();await uploadFiles([await resourceFile(resource)],resource.kind==='skin'?'skin':'reference');}});find('.skin-upload-actions').append(resources);
  function remember(){draft.name=find('#skin-name').value;draft.instruction=find('#skin-instruction').value;draft.model=find('#skin-model').value;draft.eyeTemplate=find('#skin-eyes').value==='keep'?null:find('#skin-eyes').value;}
  function restore(){find('#skin-name').value=draft.name;find('#skin-instruction').value=draft.instruction;find('#skin-model').value=draft.model;drawSources();}
  function drawSources(){
    find('#skin-references').innerHTML=draft.references.map(item=>`<figure class="skin-reference"><img src="${e(item.url)}" alt="${e(item.name)}"><button type="button" data-remove-reference="${e(item.id)}" aria-label="移除参考图 ${e(item.name)}">${icon('close')}</button></figure>`).join('');
    find('#skin-references').querySelectorAll('[data-remove-reference]').forEach(button=>on(button,'click',()=>{draft.references=draft.references.filter(item=>item.id!==button.dataset.removeReference);drawSources();}));
    const source=find('#skin-source');source.hidden=!draft.source;
    if(draft.source){source.innerHTML=`<img src="${e(draft.source.url)}" alt="已导入的原皮肤"><span>${e(draft.source.name)}</span><button class="button ghost small" type="button" id="skin-remove-source" aria-label="移除原皮肤">${icon('close')}</button>`;on(find('#skin-remove-source'),'click',()=>{changeSource();draft.source=null;if(draft.eyeTemplate===null)draft.eyeTemplate='eye_A';drawSources();drawPreview();});}
    const parent=data.jobs.find(job=>job.id===draft.parentId);find('#skin-parent').hidden=!parent;find('#skin-parent').textContent=parent?`正在修改 ${parent.name} · v${parent.version}`:'';find('#skin-form-title').textContent=parent?'继续修改':'制作皮肤';
    find('#skin-model').disabled=!!draft.source||!!draft.parentId||uploads()>0;find('#skin-eyes option[value="keep"]').hidden=!draft.source&&!draft.parentId;find('#skin-eyes').value=draft.eyeTemplate||'keep';
    find('#skin-add-reference').disabled=uploads()>0||draft.references.length>=3;find('#skin-import').disabled=uploads()>0;
  }
  const activeJob=()=>data.jobs.find(job=>ACTIVE.has(job.status));
  function drawStatus(){
    const active=activeJob();find('#skin-generate').disabled=submitting||!!active||uploads()>0||!data.runtime.available;find('#skin-generate').innerHTML=active?`${icon('clock')}${names[active.status]}`:`${draft.parentId?'生成新版本':'制作皮肤'} ${icon('arrow')}`;find('#skin-cancel').hidden=!active;
    const missing=data.runtime.missingComponents?.map(component=>component.name).join('、');
    find('#skin-prepare-runtime').hidden=!!data.runtime.available;
    find('#skin-runtime-status').textContent=data.runtime.available?'MC 皮肤工具已就绪':missing?'缺少 '+missing:'MC 皮肤工具检查未通过';find('#skin-runtime-status').className=data.runtime.available?'skin-runtime-ready':'';find('#skin-runtime-error').hidden=data.runtime.available;find('#skin-runtime-error').textContent=data.runtime.error||'';
  }
  function drawHistory(){
    const history=find('#skin-history');history.innerHTML=data.jobs.length?data.jobs.map(job=>`<button type="button" class="skin-history-item${job.id===draft.selectedJobId?' selected':''}" data-skin-job="${e(job.id)}" aria-pressed="${job.id===draft.selectedJobId}"><span>${icon(job.status==='completed'?'check':ACTIVE.has(job.status)?'clock':'info')}<strong>${e(job.name)}</strong><small>v${e(job.version)}</small></span><span class="${job.status==='failed'?'skin-error-text':''}">${e(job.approved?'已确认':names[job.status]||job.status)}</span></button>`).join(''):'<p class="quiet-empty">暂无作品</p>';
    history.querySelectorAll('[data-skin-job]').forEach(button=>on(button,'click',()=>{draft.selectedJobId=button.dataset.skinJob;drawHistory();drawPreview();}));
  }
  function drawPreview(){const job=data.jobs.find(item=>item.id===draft.selectedJobId);if(job?.error)feedback(job.error,true);else if(job?.status==='completed')feedback(job.warning||'');void preview.show(job,job?null:draft.source);}
  async function refreshState(){
    if(ctx.signal.aborted)return;if(refreshing){refreshPending=true;return;}refreshing=true;
    try{const next=await api('state');if(ctx.signal.aborted)return;data=next;if(!draft.selectedJobId&&!draft.source&&data.jobs.length)draft.selectedJobId=data.jobs[0].id;drawSources();drawStatus();drawHistory();drawPreview();if(tab==='records')drawRecords();}
    catch(error){if(!ctx.signal.aborted)feedback(error.message,true);}
    finally{refreshing=false;clearTimeout(timer);if(!ctx.signal.aborted){if(refreshPending){refreshPending=false;timer=setTimeout(()=>void refreshState(),0);}else if(data.jobs.some(job=>ACTIVE.has(job.status)))timer=setTimeout(()=>void refreshState(),1000);}}
  }
  async function uploadFiles(files,kind){
    if(!files.length||uploads())return;const selected=[...files];if(kind==='reference'&&draft.references.length+selected.length>3){feedback('最多添加三张参考图。',true);return;}const revision=draft.sourceRevision||0;changeUploads(1);feedback('正在读取并检查图像…');
    try{for(const file of selected){if((draft.sourceRevision||0)!==revision)return;if(file.size>8*1024*1024)throw new Error('每张图像不能超过 8 MiB。');const model=draft.model;const item=await api('uploads',{fileName:file.name,base64:await fileBase64(file),kind,...(kind==='skin'?{model}:{})});if((draft.sourceRevision||0)!==revision)return;if(kind==='skin'){draft.source=item;draft.model=model;draft.parentId=null;draft.selectedJobId=null;draft.eyeTemplate=null;}else draft.references.push(item);}if(!ctx.signal.aborted)feedback('');}
    catch(error){if(!ctx.signal.aborted&&(draft.sourceRevision||0)===revision)feedback(error.message,true);}finally{changeUploads(-1);}
  }
  function drawRecords(){find('#skin-records-panel').innerHTML=`<div class="panel glass"><h2>运行记录</h2>${eventList(ctx.state.events.filter(item=>item.moduleId==='mc-skin'),ctx.state.modules)}</div>`;}
  function drawConfig(){
    configController?.abort();configController=new AbortController();
    const generation=++configGeneration;const settings=module().settings,key='module:mc-skin';let saved=module().config;const values=ctx.drafts.read(key,saved);
    find('#skin-config-panel').innerHTML=`<div class="configuration-layout"><section class="panel glass"><div class="panel-heading"><h2>制作环境</h2>${help('Skill、眼型模板和预览组件随工作台提供。需要 Python 3.10+ 与 Pillow。作品目录可选，留空使用工作台数据目录。AI 连接在工作台设置中共用。','皮肤制作环境说明')}</div><form id="module-config-form">${settings.map(field=>`<div class="field"><div class="field-label"><label for="config-${e(field.key)}">${e(field.label)}</label>${help(field.help,field.label+'说明')}</div><input id="config-${e(field.key)}" name="${e(field.key)}" data-setting="${e(field.key)}" value="${e(values[field.key]||'')}" placeholder="${e(field.placeholder)}" maxlength="2048" autocomplete="off"></div>`).join('')}<div class="form-actions"><p id="config-feedback" class="form-feedback" role="status"></p><button class="button" type="button" id="check-paths">检查路径</button><button class="button primary" type="submit" id="save-module-config">保存配置</button></div></form><div id="skin-path-results"></div></section></div>`;
    const form=find('#module-config-form');const importRow=document.createElement('div');importRow.className='skin-config-import';importRow.innerHTML=`<label for="config-skin-model">皮肤模型<select id="config-skin-model"><option value="slim">Slim · 细手臂</option><option value="classic">Classic · 标准手臂</option></select></label><button class="button" type="button" id="skin-import-configured">导入此皮肤</button>`;find('#config-skinPath').after(importRow);find('#config-skin-model').value=draft.model;
    mountModulePathPickers(form,ctx,'mc-skin',settings);
    const preparationRoot=document.createElement('div');form.before(preparationRoot);
    const preparation=mountResourcePreparation(preparationRoot,{...ctx,signal:configController.signal},{...preparationFor('mc-skin'),open:!data.runtime?.available,onTarget:field=>choosePreparedField(form,field),commandFor:()=>pythonInstallCommand(form.elements.pythonPath.value,['Pillow'])});
    const current=()=>Object.fromEntries(settings.map(field=>[field.key,form.elements[field.key].value]));const check=()=>{const dirty=settings.some(field=>(saved[field.key]||'')!==form.elements[field.key].value);find('#check-paths').disabled=dirty;find('#skin-import-configured').disabled=dirty||!saved.skinPath||uploads()>0;};
    checkConfig=check;
    on(form,'input',event=>{if(!event.target.matches('[data-setting]'))return;ctx.drafts.write(key,current());find('#config-feedback').textContent='有未保存的修改';check();});
    const discovery=document.createElement('div');form.before(discovery);
    mountEnvironmentDiscovery(discovery,{...ctx,signal:configController.signal},{moduleId:'mc-skin',onSelect:candidate=>{
      if(!Object.hasOwn(candidate.values,'pythonPath'))return;
      const input=form.elements.pythonPath;input.value=candidate.values.pythonPath;input.dispatchEvent(new Event('input',{bubbles:true}));
    }});
    on(form,'submit',async event=>{event.preventDefault();const snapshot=current();await ctx.action(find('#save-module-config'),async()=>{try{const result=await ctx.api(API+'config',{method:'PUT',body:{values:snapshot}});saved=result.config;ctx.drafts.reconcile(key,snapshot,saved);if(ctx.signal.aborted||generation!==configGeneration)return;for(const field of settings)if(form.elements[field.key].value===snapshot[field.key])form.elements[field.key].value=saved[field.key]||'';find('#config-feedback').textContent='配置已保存';check();await ctx.refresh();await api('runtime/check',{});await refreshState();}catch(error){if(!ctx.signal.aborted&&generation===configGeneration){find('#config-feedback').textContent=error.message;find('#config-feedback').className='form-feedback error';}}});});
    on(find('#check-paths'),'click',()=>ctx.action(find('#check-paths'),async()=>{const result=await api('check-paths',{});if(ctx.signal.aborted)return;find('#skin-path-results').innerHTML=Object.entries(result.checks).map(([field,value])=>`<p class="form-feedback${['missing','wrong-type'].includes(value.status)?' error':''}">${e(settings.find(item=>item.key===field)?.label||field)}：${e(value.message)}</p>`).join('');if(Object.values(result.checks).some(value=>['missing','wrong-type','error'].includes(value.status)))preparation.expand();}));check();
    on(find('#skin-import-configured'),'click',async()=>{
      if(uploads())return;const revision=draft.sourceRevision||0;
      await ctx.action(find('#skin-import-configured'),async()=>{
        changeUploads(1);
        try{
          const model=find('#config-skin-model').value,item=await api('import-configured',{model});
          if((draft.sourceRevision||0)!==revision)return;
          Object.assign(draft,{source:item,model,parentId:null,selectedJobId:null,eyeTemplate:null});
          if(ctx.signal.aborted)return;await selectTab('create');feedback('');
        }catch(error){if(!ctx.signal.aborted&&generation===configGeneration&&(draft.sourceRevision||0)===revision){find('#config-feedback').textContent=error.message;find('#config-feedback').className='form-feedback error';}}
        finally{changeUploads(-1);}
      });
      if(!ctx.signal.aborted&&generation===configGeneration)check();
    });
  }
  async function selectTab(next,focus=false){if(next!=='config')configController?.abort();tab=next;for(const value of ['create','config','records'])find('#skin-'+value+'-panel').hidden=value!==next;root.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===next;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});if(next==='config')drawConfig();if(next==='records'){await ctx.refresh();if(!ctx.signal.aborted)drawRecords();}if(next==='create')preview.resize();if(focus)find(`[data-tab="${next}"]`).focus();}
  root.querySelectorAll('[data-tab]').forEach(button=>{on(button,'click',()=>void selectTab(button.dataset.tab));on(button,'keydown',event=>{const tabs=['create','config','records'];let index=tabs.indexOf(tab);if(event.key==='ArrowRight')index=(index+1)%3;else if(event.key==='ArrowLeft')index=(index+2)%3;else if(event.key==='Home')index=0;else if(event.key==='End')index=2;else return;event.preventDefault();void selectTab(tabs[index],true);});});
  on(find('#skin-create-form'),'input',remember);
  on(find('#skin-create-form'),'submit',async event=>{
    event.preventDefault();if(submitting||activeJob()||uploads())return;remember();
    const values={name:draft.name,instruction:draft.instruction,model:draft.model,eyeTemplate:draft.eyeTemplate,referenceIds:draft.references.map(item=>item.id),...(draft.source?{sourceId:draft.source.id}:{}),...(draft.parentId?{parentId:draft.parentId}:{}),characterId:ctx.state.selectedCharacterId||null};
    const signature=JSON.stringify(values);
    if(draft.submission?.signature!==signature)draft.submission={signature,requestId:crypto.randomUUID()};
    const requestId=draft.submission.requestId;submitting=true;
    try{await ctx.action(find('#skin-generate'),async()=>{try{
      const job=await api('jobs',{requestId,...values});
      if(draft.submission?.requestId===requestId)draft.submission=null;
      draft.selectedJobId=job.id;if(ctx.signal.aborted)return;data.jobs=[job,...data.jobs.filter(item=>item.id!==job.id)];feedback('');drawHistory();drawStatus();drawPreview();await refreshState();
    }catch(error){if(!ctx.signal.aborted){await refreshState();feedback(error.message,true);}}});}
    finally{submitting=false;if(!ctx.signal.aborted)drawStatus();}
  });
  on(find('#skin-add-reference'),'click',()=>find('#skin-reference-file').click());on(find('#skin-import'),'click',()=>find('#skin-source-file').click());
  for(const [id,kind]of [['skin-reference-file','reference'],['skin-source-file','skin']])on(find('#'+id),'change',event=>{const files=[...event.target.files];event.target.value='';void uploadFiles(files,kind);});
  on(find('#skin-cancel'),'click',()=>ctx.action(find('#skin-cancel'),async()=>{const job=activeJob();if(job){await api('jobs/'+job.id+'/cancel',{});await refreshState();}}));
  on(find('#skin-new'),'click',()=>{changeSource();Object.assign(draft,{name:'',instruction:'',model:'slim',eyeTemplate:'eye_A',references:[],source:null,parentId:null,selectedJobId:null,submission:null});restore();feedback('');drawStatus();drawHistory();drawPreview();find('#skin-name').focus();});
  on(find('#skin-ai-settings'),'click',()=>find('[data-module-ai-control]')?.click());on(find('#skin-refresh'),'click',()=>void refreshState());
  on(find('#skin-check-runtime'),'click',()=>ctx.action(find('#skin-check-runtime'),async()=>{await api('runtime/check',{});await refreshState();}));
  on(find('#skin-prepare-runtime'),'click',()=>void selectTab('config',true));
  on(find('#remove-module'),'click',()=>ctx.action(find('#remove-module'),async()=>{await ctx.disableModule('mc-skin');ctx.navigate('home');}));
  on(window,'mc-skin-draft-updated',()=>{restore();drawStatus();drawPreview();if(tab==='config')checkConfig();});
  ctx.signal.addEventListener('abort',()=>{remember();clearTimeout(timer);configController?.abort();},{once:true});restore();void refreshState();
}
