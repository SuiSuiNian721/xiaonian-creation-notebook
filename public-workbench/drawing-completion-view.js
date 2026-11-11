import {escape as e,downloadJson} from './components.js';

const API='/api/modules/drawing/completion';
const ACTIVE=new Set(['queued','running','searching']);
const status=value=>({exists:'存在',missing:'缺失',unverified:'未验证',candidate:'有候选',queued:'等待检查',running:'检查本地与服务',searching:'查询来源',completed:'检查完成',partial:'部分尚未校验',cancelled:'已取消',interrupted:'已中断',failed:'检查失败'})[value]||value;
const bytes=value=>value==null?'未知':value<1024?`${value} B`:`${(value/(value>=1024**3?1024**3:value>=1024**2?1024**2:1024)).toFixed(1)} ${value>=1024**3?'GiB':value>=1024**2?'MiB':'KiB'}`;
const safeLink=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}};

export function loraServiceChoices(resource,choices) {
  const path=resource.reference?.path||'';const filename=path.replaceAll('\\','/').split('/').at(-1)?.toLowerCase();
  return choices.filter(value=>typeof value==='string'&&value.replaceAll('\\','/').split('/').at(-1)?.toLowerCase()===filename);
}

function directoriesMarkup(report) {
  return `<details class="drawing-completion-directories"><summary>额外模型目录</summary>${(report.modelRoots||[]).map(item=>`<p class="drawing-path">${e(item.category)} · ${e(item.path)} · ${e(item.source)}</p>`).join('')}<form data-completion-directory-form><div class="field"><label for="completion-extra-category">模型类别</label><select id="completion-extra-category" name="category">${['checkpoints','unet','diffusion_models','loras','clip','text_encoders','vae','controlnet','upscale_models'].map(value=>`<option value="${value}">${value}</option>`).join('')}</select></div><div class="field"><label for="completion-extra-path">目录绝对路径（支持显式链接目录）</label><input id="completion-extra-path" name="path" type="text" required></div><button class="button small" type="submit" ${ACTIVE.has(report.status)?'disabled':''}>添加并重新检查</button></form><button type="button" class="text-link" data-completion-local-recheck ${ACTIVE.has(report.status)?'disabled':''}>重新检查本地与服务</button></details>`;
}

export function completionModelReplacement(dependency,candidate) {return dependency?.kind==='model'&&candidate?{dependencyId:dependency.id,value:candidate.reuse?.reference||candidate.filename}:null;}

export function completionMarkup(report,selected=new Map(),accepted=new Set()) {
  const reusable=report.dependencies.flatMap(dependency=>dependency.candidates.filter(candidate=>candidate.reuse).map(candidate=>({dependency,candidate})));
  const reuseMarkup=reusable.length?`<details class="drawing-completion-directories"><summary>本地复用 · ${reusable.length}</summary>${reusable.map(({dependency,candidate})=>`<p class="drawing-path">${e(dependency.filename)} → ${e(candidate.reuse.reference)}<br>${e(candidate.reuse.path)}</p>`).join('')}</details>`:'';
  const total=report.totalUsage;const usageMarkup=total?`<details class="drawing-completion-directories"><summary>累计用量 · ${e(total.rounds)} 轮</summary><p class="drawing-path">请求 ${e(total.requests)} 次 · 缓存命中 ${e(total.cacheHits)} 次 · 哈希新读 ${bytes(total.hashBytes)}</p></details>`:'';
  return completionBodyMarkup(report,selected,accepted)+reuseMarkup+usageMarkup+directoriesMarkup(report);
}

function completionBodyMarkup(report,selected,accepted) {
  const remote=report.scope!=='local';
  return `<div class="panel-heading"><h3>工作流依赖补全</h3><span class="status-chip">${e(status(report.status))}</span></div>${remote?'<p class="drawing-consequence">远程服务：本机下载不能补齐远程 ComfyUI。</p>':''}${report.comfyPath?`<p class="drawing-path">${e(report.comfyPath)}</p>`:''}${report.error?`<p class="form-feedback error">${e(report.error)}</p>`:''}<div class="drawing-completion-list">${report.dependencies.map(dependency=>`<article class="drawing-completion-dependency" data-completion-dependency="${e(dependency.id)}"><div class="drawing-job-title"><strong>${e(dependency.filename||dependency.classType)}</strong><span class="status-chip ${dependency.status==='exists'?'good':''}">${e(status(dependency.status))}</span></div><div class="drawing-completion-evidence"><span>服务：${e(status(dependency.service.status))}</span>${dependency.kind==='model'?`<span>磁盘：${e(status(dependency.local.status))}${dependency.local.status==='exists'?' · '+(dependency.local.identity==='verified'?'身份已校验':'身份未验证'):''}</span>`:''}</div>${dependency.local.files?.length?`<details data-completion-detail="local-${e(dependency.id)}"><summary>本地文件 · ${dependency.local.files.length}</summary>${dependency.local.files.map(file=>`<p class="drawing-path">${e(file.path)} · ${bytes(file.sizeBytes)}</p><code class="drawing-path">SHA256：${e(file.sha256||'尚未校验')}</code>`).join('')}</details>`:''}${dependency.candidates.length?`<details data-completion-detail="candidates-${e(dependency.id)}" open><summary>来源候选 · ${dependency.candidates.length}</summary>${dependency.candidates.map(candidate=>{
      const key=dependency.id+':'+candidate.id;const selectedHere=selected.get(dependency.id)===candidate.id;const source=safeLink(candidate.source);const storage=candidate.storage||{};
      return `<div class="drawing-completion-candidate"><label class="drawing-completion-choice"><input type="checkbox" data-completion-candidate="${e(key)}" ${selectedHere?'checked':''}><strong>${e(candidate.filename||candidate.title)}</strong><span>${e(candidate.platform)}</span></label><div class="drawing-completion-evidence"><span>版本：${e(candidate.version||'未验证')}</span><span>许可：${e(candidate.license||'未验证')}</span></div>${dependency.kind==='model'?`<div class="drawing-completion-space"><span>下载 ${bytes(storage.downloadBytes)}</span><span>新增 ${bytes(storage.incrementalBytes)}</span><span>临时峰值 ${bytes(storage.temporaryPeakBytes)}</span></div><p class="drawing-path">${e(storage.destination||'未选择下载目录')}</p><code class="drawing-path">SHA256：${e(candidate.sha256||'来源未提供可信哈希')}</code>${!candidate.sha256?`<label class="drawing-completion-choice"><input type="checkbox" data-completion-unverified="${e(key)}" ${accepted.has(key)?'checked':''}>接受未验证的来源哈希</label>`:''}`:''}${candidate.requiresAuth?'<p class="form-feedback error">需要来源鉴权或许可</p>':''}${source?`<a class="text-link" href="${e(source)}" target="_blank" rel="noopener noreferrer">查看来源</a>`:''}${dependency.kind==='node'&&candidate.repository?`<button type="button" class="text-link" data-completion-node-plan="${e(key)}">预览节点安装</button>`:''}</div>`;
    }).join('')}</details>`:''}${dependency.issues?.length?`<ul class="drawing-plan-warnings">${dependency.issues.map(issue=>`<li>${e(issue.platform)}：${e(issue.detail)}</li>`).join('')}</ul>`:''}<button type="button" class="text-link" data-completion-advanced="${e(dependency.id)}">${dependency.kind==='model'?'高级直链下载':'高级 Git 安装'}</button></article>`).join('')}</div><p class="drawing-muted">本轮请求 ${report.budget?.requests||0} / 40 · 哈希新读 ${bytes(report.budget?.hashBytes||0)} / 32 GiB · AI 调用 ${report.ai?.calls||0}</p>${report.warnings.length?`<details><summary>未验证与范围 · ${report.warnings.length}</summary><ul class="drawing-plan-warnings">${report.warnings.map(warning=>`<li>${e(warning)}</li>`).join('')}</ul></details>`:''}<div class="drawing-actions"><button type="button" class="button" data-completion-search ${ACTIVE.has(report.status)?'disabled':''}>${report.partial?'继续检查来源':'查询缺失来源'}</button><button type="button" class="button primary" data-completion-download ${remote||ACTIVE.has(report.status)?'disabled':''}>下载所选模型</button><button type="button" class="button" data-completion-copy>另存引用副本</button><button type="button" class="text-link" data-completion-export>导出报告</button>${ACTIVE.has(report.status)?'<button type="button" class="text-link" data-completion-cancel>取消检查</button>':''}</div><p class="form-feedback" data-completion-feedback role="status"></p><section data-completion-node-plan-panel hidden></section>`;
}

export async function mountWorkflowCompletion(root,ctx,pending) {
  let report=null,polling=false;const selected=new Map(),accepted=new Set();const {signal}=ctx;
  const feedback=(message,error=false)=>{const node=root.querySelector('[data-completion-feedback]');if(node){node.textContent=message;node.className='form-feedback'+(error?' error':'');}else ctx.notify(message,error);};
  const post=(path,value={})=>ctx.api(API+path,{method:'POST',body:value,timeoutMs:180000});
  const run=(button,job)=>ctx.action(button,async()=>{try{await job();}catch(error){if(!signal.aborted)feedback(error.message,true);}});
  const choices=()=>[...selected].map(([dependencyId,candidateId])=>({dependencyId,candidateId,acceptUnverifiedHash:accepted.has(dependencyId+':'+candidateId)}));
  function render() {
    if(signal.aborted)return;
    const active=root.contains(document.activeElement)?document.activeElement:null;
    const attribute=active?[...active.attributes].find(item=>item.name.startsWith('data-completion-')||item.name==='name'):null;
    const focus=attribute?`[${attribute.name}="${CSS.escape(attribute.value)}"]`:null;
    const formDraft=root.querySelector('[data-completion-directory-form]');const directoryDraft=formDraft?{path:formDraft.elements.path.value,category:formDraft.elements.category.value}:null;
    const open=new Map([...root.querySelectorAll('[data-completion-detail]')].map(node=>[node.dataset.completionDetail,node.open]));
    root.innerHTML=completionMarkup(report,selected,accepted);
    root.querySelector('[data-completion-search]').disabled=ACTIVE.has(report.status)||report.canContinue===false;
    root.querySelectorAll('[data-completion-detail]').forEach(node=>{if(open.has(node.dataset.completionDetail))node.open=open.get(node.dataset.completionDetail);});
    root.querySelectorAll('[data-completion-candidate]').forEach(input=>input.onchange=()=>{const [dependencyId,candidateId]=input.dataset.completionCandidate.split(':');if(input.checked)selected.set(dependencyId,candidateId);else selected.delete(dependencyId);render();});
    root.querySelectorAll('[data-completion-unverified]').forEach(input=>input.onchange=()=>{if(input.checked)accepted.add(input.dataset.completionUnverified);else accepted.delete(input.dataset.completionUnverified);});
    const recheck=async explicitDirectories=>{report=await post('',{...pending,explicitDirectories,requestId:crypto.randomUUID()});if(!signal.aborted){selected.clear();accepted.clear();render();}};
    const directoryForm=root.querySelector('[data-completion-directory-form]');
    if(directoryDraft){directoryForm.elements.path.value=directoryDraft.path;directoryForm.elements.category.value=directoryDraft.category;}
    directoryForm.onsubmit=event=>{event.preventDefault();void run(directoryForm.querySelector('button'),()=>recheck([...(report.explicitDirectories||[]),{category:directoryForm.elements.category.value,path:directoryForm.elements.path.value.trim()}]));};
    root.querySelector('[data-completion-local-recheck]').onclick=event=>run(event.currentTarget,()=>recheck(report.explicitDirectories||[]));
    root.querySelector('[data-completion-search]').onclick=event=>run(event.currentTarget,async()=>{const next=await post('/'+report.id+'/search');if(!signal.aborted){report=next;render();}});
    root.querySelector('[data-completion-download]').onclick=event=>run(event.currentTarget,async()=>{
      const selections=choices().filter(item=>report.dependencies.find(dependency=>dependency.id===item.dependencyId)?.kind==='model');
      if(!selections.length)throw new Error('请先勾选模型候选。');
      const fingerprint=JSON.stringify(selections);const previous=ctx.ui.drawingCompletionDownload;const request=previous?.fingerprint===fingerprint?previous:{fingerprint,id:crypto.randomUUID()};ctx.ui.drawingCompletionDownload=request;
      const result=await post('/'+report.id+'/downloads',{requestId:request.id,selections});if(signal.aborted)return;
      const failures=result.tasks.filter(task=>task.error),reused=result.tasks.filter(task=>task.status==='reused').length;feedback(failures.length?failures.map(task=>task.error).join('；'):reused===result.tasks.length?'已复用本地文件；可另存引用副本。':`已交给下载管理${reused?`，其中 ${reused} 项复用本地文件`:''}，可在 ComfyUI 资源管理中查看进度。`,!!failures.length);
    });
    root.querySelector('[data-completion-copy]').onclick=event=>run(event.currentTarget,async()=>{
      const replacements=choices().map(selection=>{const dependency=report.dependencies.find(item=>item.id===selection.dependencyId);const candidate=dependency?.candidates.find(item=>item.id===selection.candidateId);return completionModelReplacement(dependency,candidate);}).filter(Boolean);
      const result=await post('/'+report.id+'/copy',{replacements});if(signal.aborted)return;downloadJson(result.document,result.name);feedback('已另存副本：'+result.path);
    });
    root.querySelector('[data-completion-export]').onclick=()=>downloadJson(report,report.name+'-依赖补全报告');
    root.querySelector('[data-completion-cancel]')?.addEventListener('click',event=>run(event.currentTarget,async()=>{const next=await post('/'+report.id+'/cancel');if(!signal.aborted){report=next;render();}}));
    root.querySelectorAll('[data-completion-advanced]').forEach(button=>button.onclick=()=>run(button,()=>{const dependency=report.dependencies.find(item=>item.id===button.dataset.completionAdvanced);return ctx.navigateModule('comfyui',{tab:'resources',section:dependency.kind==='model'?'downloads':'plugins',...(dependency.kind==='model'?{filename:dependency.filename,category:dependency.category}:{query:dependency.classType})});}));
    root.querySelectorAll('[data-completion-node-plan]').forEach(button=>button.onclick=()=>run(button,async()=>{
      const [dependencyId,candidateId]=button.dataset.completionNodePlan.split(':');const plan=await post('/'+report.id+'/node-plan',{dependencyId,candidateId});if(signal.aborted)return;
      const panel=root.querySelector('[data-completion-node-plan-panel]');panel.hidden=false;
      panel.innerHTML=`<h3>${e(plan.title)}</h3><p class="drawing-path">${e(plan.comfyPath)}</p><pre class="drawing-code">${e(JSON.stringify(plan.changes,null,2))}</pre><p class="drawing-consequence">应用将修改此 ComfyUI 环境。执行前会创建快照；请先退出 ComfyUI。</p><button type="button" class="button" data-completion-apply-plan>应用节点安装计划</button>`;
      panel.querySelector('button').onclick=event=>run(event.currentTarget,async()=>{const task=await ctx.api('/api/modules/drawing/manager/apply',{method:'POST',body:{planId:plan.id}});feedback('已提交节点安装：'+task.title);panel.hidden=true;});
    }));
    if(focus)root.querySelector(focus)?.focus({preventScroll:true});
  }
  root.innerHTML='<p class="form-feedback" role="status">正在提取工作流依赖…</p>';
  try {
    const fingerprint=JSON.stringify(pending);const previous=ctx.ui.drawingCompletionRequest;const request=previous?.fingerprint===fingerprint?previous:{fingerprint,id:crypto.randomUUID()};ctx.ui.drawingCompletionRequest=request;
    report=await post('',{...pending,requestId:request.id});if(signal.aborted)return;render();
    const timer=setInterval(async()=>{if(signal.aborted||polling||!ACTIVE.has(report.status))return;polling=true;try{const next=await ctx.api(API+'/'+report.id);if(!signal.aborted&&JSON.stringify(next)!==JSON.stringify(report)){report=next;render();}}catch(error){if(!signal.aborted)feedback(error.message,true);}finally{polling=false;}},700);
    signal.addEventListener('abort',()=>clearInterval(timer),{once:true});
  }catch(error){if(!signal.aborted)root.innerHTML=`<p class="form-feedback error" role="status">${e(error.message)}</p>`;}
}
