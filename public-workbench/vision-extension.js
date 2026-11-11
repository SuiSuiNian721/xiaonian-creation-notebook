import {escape as e} from './components.js';
import {formatResourceBytes as bytes} from './installation-view.js';

const activeTask=state=>['queued','running'].includes(state?.task?.status);
const liveRuntime=state=>['starting','running'].includes(state?.runtime?.status);
const stages={preparing:'准备安装',downloading:'下载文件',verifying:'校验文件',extracting:'解压运行端',starting:'加载视觉模型',completed:'安装完成'};

// Only this region is polled. The parent owns the editable connection and its draft.
export function mountVisionExtension(root,{fetchImpl=fetch,signal,draftToken,applyConnection}){
  const controller=new AbortController();
  let state=null,disposed=false,timer=null,busy=false,epoch=0,pendingFill=null,filling=false,discoveryAttempted=false;
  const candidateTargets=new Map();
  const live=()=>!disposed&&!controller.signal.aborted&&root.isConnected;
  root.innerHTML=`<section class="life-vision-package" aria-label="本地视觉模型">
    <div class="life-vision-package-heading"><div><h4>本地视觉模型</h4><p data-vision-model></p></div><div class="life-vision-package-controls"><span data-vision-status role="status">正在读取…</span>
      <div class="life-vision-package-actions">
        <button type="button" class="button small primary" data-vision-action="install" hidden>下载缺失组件</button>
        <button type="button" class="button small primary" data-vision-action="start" hidden>启动并填入</button>
        <button type="button" class="button small primary" data-vision-action="connection" hidden>填入当前角色</button>
        <button type="button" class="button small" data-vision-action="cancel" hidden>取消安装</button>
        <button type="button" class="button small" data-vision-action="stop" hidden>停止服务</button>
        <button type="button" class="button small" data-vision-action="cpu" hidden>使用 CPU 启动</button>
        <button type="button" class="button small" data-vision-action="refresh" hidden>重新读取</button>
      </div>
    </div></div>
    <div class="life-vision-package-size" data-vision-size></div>
    <div class="life-vision-package-directory"><span>安装位置</span><span data-vision-directory></span><button type="button" class="button small" data-vision-action="choose-directory" disabled>更改位置</button></div>
    <button type="button" class="button small" data-vision-action="discover">重新检索本机组件</button><div data-vision-candidates></div>
    <details class="life-vision-package-details"><summary>组件与已有文件</summary><div data-vision-components></div><div data-vision-bindings><label class="field"><span>视觉模型 GGUF</span><input data-vision-field="modelPath"></label><label class="field"><span>视觉投影文件 GGUF</span><input data-vision-field="projectorPath"></label><label class="field"><span>llama-server.exe</span><input data-vision-field="runtimePath"></label><label class="field"><span>检索目录（每行一个）</span><textarea data-vision-field="searchRoots" rows="2"></textarea></label><button class="button small" type="button" data-vision-save-bindings>保存组件路径</button></div></details>
    <details class="life-vision-package-details"><summary>配置要求与来源</summary><div data-vision-requirements></div><p data-vision-space></p><p>下载完成后可单独启动。工作台会恢复你已启动的服务；同一资料目录的角色共用服务，停止会暂停它们的本机识图。</p><div data-vision-links></div></details>
    <div data-vision-progress hidden><p data-vision-stage></p><progress aria-label="千问视觉扩展包安装进度"></progress><span data-vision-progress-bytes></span></div>
    <p class="form-feedback" data-vision-feedback role="status"></p>
    <p class="form-feedback error" data-vision-error role="alert" hidden></p>
  </section>`;
  const find=selector=>root.querySelector(selector);
  const feedback=(message='',error=false)=>{if(!live())return;const node=find('[data-vision-feedback]');node.textContent=message;node.classList.toggle('error',error);};
  const errorText=message=>{if(!live())return;const node=find('[data-vision-error]');node.textContent=message;node.hidden=!message;};
  async function request(action='',body){
    const timeout=new AbortController(),limit=setTimeout(()=>timeout.abort(),action==='choose-directory'?300000:30000);
    try{
      const response=await fetchImpl('/api/vision-extension'+(action?'/'+action:''),{method:body===undefined?'GET':'POST',signal:AbortSignal.any([controller.signal,timeout.signal]),...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||`扩展包请求失败（${response.status}）`);return result;
    }catch(error){if(timeout.signal.aborted)throw new Error('扩展包响应超时，可以重新读取状态。');throw error;}
    finally{clearTimeout(limit);}
  }
  function showAction(action,show,disabled=busy){const button=find(`[data-vision-action="${action}"]`);button.hidden=!show;button.disabled=disabled;}
  function render(){
    if(!live()||!state)return;
    const pack=state.package||{},runtime=state.runtime||{},active=activeTask(state),running=runtime.status==='running',starting=runtime.status==='starting';
    find('[data-vision-model]').textContent=state.bindings?.modelPath?state.bindings.modelPath.split(/[\\/]/).at(-1):[pack.model,pack.quantization].filter(Boolean).join(' · ');
    const external=Object.values(state.bindings||{}).some(Boolean);
    find('[data-vision-status]').textContent=active?'正在安装':starting?'正在启动':running?'服务已启动':runtime.status==='failed'?'启动失败':state.installed?external?'文件已关联 · 待运行验证':'已安装':state.task?.status==='cancelled'?'安装已取消':state.task?.status==='failed'?'安装失败':'可选安装';
    find('[data-vision-size]').textContent=state.installed?external?running?'本机文件已关联':'本机文件已存在；模型与投影文件的兼容性需启动时验证':'已安装文件可直接复用':`下载 ${bytes(pack.downloadBytes)} · 安装后 ${bytes(pack.installedBytes)}`;
    find('[data-vision-directory]').textContent=state.directory||'';
    find('[data-vision-requirements]').textContent=Array.isArray(pack.requirements)?pack.requirements.join('；'):pack.requirements||'Windows x64。内存与显存占用取决于上下文及其他程序。';
    find('[data-vision-space]').textContent=`安装与修复时需预留 ${bytes(pack.peakDiskBytes)}，包含临时解压空间。`;
    find('[data-vision-links]').innerHTML=(pack.links||[]).map(link=>{
      try{const url=new URL(link.url);if(url.protocol==='https:'&&!url.username&&!url.password)return `<a href="${e(url.href)}" target="_blank" rel="noreferrer">${e(link.label)}</a>`;}catch{}return '';
    }).filter(Boolean).join(' · ');
    const measured=Number.isFinite(state.task?.totalBytes)&&state.task.totalBytes>0,progress=find('progress');
    find('[data-vision-progress]').hidden=!active;
    find('[data-vision-stage]').textContent=stages[state.task?.stage]||state.task?.stage||'';
    if(measured){progress.max=state.task.totalBytes;progress.value=Math.min(state.task.completedBytes||0,state.task.totalBytes);}else progress.removeAttribute('value');
    find('[data-vision-progress-bytes]').textContent=measured?`${bytes(state.task.completedBytes||0)} / ${bytes(state.task.totalBytes)}`:'';
    showAction('install',!state.installed&&!active&&!starting,busy||state.supported===false);
    find('[data-vision-action="install"]').textContent=state.task?.status==='failed'?'重试下载组件':'下载缺失组件';
    showAction('start',state.installed&&!active&&!running&&!starting,busy||state.supported===false);
    showAction('connection',running&&!active,busy||filling);
    showAction('cancel',active);
    showAction('stop',!active&&(running||starting||runtime.status==='failed'));
    showAction('cpu',state.installed&&!active&&runtime.status==='failed',busy||state.supported===false);
    showAction('choose-directory',true,busy||active||liveRuntime(state)||!state.canChooseDirectory);
    showAction('refresh',false);
    showAction('discover',true,busy||active);
    find('[data-vision-components]').innerHTML=(state.components||[]).map(item=>`<p><strong>${e(item.label)}</strong> · ${bytes(item.bytes)} · ${item.installed?item.verification==='unverified'?'已存在 · 待运行验证':'已存在':'尚未准备'} <button type="button" class="button small" data-vision-component="${e(item.id)}" ${busy||active||liveRuntime(state)?'disabled':''}>${item.installed?'重新校验并下载':'下载'}</button></p>`).join('');
    for(const field of find('[data-vision-bindings]').querySelectorAll('input,textarea')){const key=field.dataset.visionField;if(!field.dataset.dirty)field.value=key==='searchRoots'?(state.searchRoots||[]).join('\n'):state.bindings?.[key]||'';}
    find('[data-vision-bindings] button').disabled=busy||active||liveRuntime(state);
    find('[data-vision-candidates]').innerHTML=(state.discovery?.result?.candidates||[]).map(item=>{
      const target=item.kind==='runtime'?'runtimePath':candidateTargets.get(item.id)||'';
      return `<p><span class="life-code">${e(item.path)}</span> ${item.kind==='runtime'?'':`<select data-vision-target="${e(item.id)}" aria-label="GGUF 用途：${e(item.path)}" ${busy||active||liveRuntime(state)?'disabled':''}><option value="">选择用途</option><option value="modelPath" ${target==='modelPath'?'selected':''}>视觉模型</option><option value="projectorPath" ${target==='projectorPath'?'selected':''}>视觉投影文件</option></select>`}<button class="button small" type="button" data-vision-adopt="${e(item.id)}" ${busy||active||liveRuntime(state)||!target?'disabled':''}>填入路径</button></p>`;
    }).join('')+(state.discovery?.error?`<p class="form-feedback error">${e(state.discovery.error)}</p>`:'');
    const failure=active?state.task?.error:running||starting?'':runtime.error||state.task?.error;
    errorText(state.supported===false?'这个扩展包需要 Windows x64；也可以在下方接入已有视觉服务。':failure||'');
  }
  function schedule(){clearTimeout(timer);if(live())timer=setTimeout(()=>void refresh(),1000);}
  async function fill(token){
    if(filling||!live())return;const version=epoch;filling=true;render();
    try{
      const result=await request('connection',{});if(!live()||version!==epoch)return;
      if(token!==draftToken()){feedback('连接已就绪；填写内容已变化，未覆盖。需要时可重新填入。');return;}
      applyConnection(result.media);feedback('已填入连接，保存识图与表情后生效。');
    }catch(error){if(live())feedback(error.message,true);}
    finally{filling=false;if(live())render();}
  }
  function maybeFill(){
    if(!pendingFill||!live())return;
    if(activeTask(state))return;
    if(state?.runtime?.status==='failed'||pendingFill.installation&&['failed','cancelled','interrupted'].includes(state?.task?.status)){pendingFill=null;return;}
    if(state?.runtime?.status==='running'&&!activeTask(state)){
      const {token}=pendingFill;pendingFill=null;void fill(token);
    }
  }
  async function refresh(){
    if(!live())return;if(busy){schedule();return;}const version=epoch;
    try{const result=await request();if(!live()||version!==epoch)return;state=result;render();maybeFill();if(state.discovery&&!state.discovery.attempted&&!discoveryAttempted){discoveryAttempted=true;void action('discover-initial');}}
    catch(error){if(live()&&version===epoch){errorText(error.message);showAction('refresh',true,false);}}
    finally{schedule();}
  }
  async function action(name,extra){
    if(busy||!live())return;
    if(name==='refresh'){epoch++;void refresh();return;}
    if(name==='connection'){epoch++;pendingFill=null;void fill(draftToken());return;}
    const fills=['start','cpu'].includes(name);
    const bindingSnapshot=name==='configure'?new Map([...find('[data-vision-bindings]').querySelectorAll('input,textarea')].map(field=>[field,field.value])):null;
    busy=true;epoch++;pendingFill=fills?{token:draftToken(),installation:name==='install'}:null;feedback();render();
    try{
      const route=name==='cpu'?'start':name==='discover-initial'?'discover':name;
      const missing=(state.components||[]).filter(item=>!item.installed).map(item=>item.id);
      const result=await request(route,extra??(name==='cpu'?{device:'cpu'}:name==='start'?{device:'auto'}:name==='install'?{...(missing.length?{components:missing}:{}),startAfter:false}:name.startsWith('discover')?{refresh:name==='discover'}:{}));
      if(!live())return;
      if(bindingSnapshot)for(const [field,value] of bindingSnapshot)if(field.value===value)delete field.dataset.dirty;
      state=result;render();maybeFill();
    }catch(error){pendingFill=null;if(live())feedback(error.message,true);}
    finally{busy=false;if(live()){render();schedule();}}
  }
  root.addEventListener('click',event=>{
    const button=event.target.closest('[data-vision-action]');if(button&&!button.disabled)void action(button.dataset.visionAction);
    const component=event.target.closest('[data-vision-component]');if(component&&!component.disabled)void action('install',{components:[component.dataset.visionComponent],startAfter:false});
    const adopt=event.target.closest('[data-vision-adopt]');if(adopt&&!adopt.disabled){const item=state.discovery.result.candidates.find(item=>item.id===adopt.dataset.visionAdopt),target=item?.kind==='runtime'?'runtimePath':candidateTargets.get(item?.id);if(!item||!target)return;const input=find(`[data-vision-field="${target}"]`);input.value=item.path;input.dataset.dirty='true';input.closest('details').open=true;input.focus();}
  },{signal:controller.signal});
  root.addEventListener('input',event=>{if(event.target.matches('[data-vision-target]')){candidateTargets.set(event.target.dataset.visionTarget,event.target.value);render();}},{signal:controller.signal});
  find('[data-vision-bindings]').addEventListener('input',event=>{if(event.target.dataset.visionField)event.target.dataset.dirty='true';},{signal:controller.signal});
  find('[data-vision-save-bindings]').addEventListener('click',()=>{
    const values=Object.fromEntries([...find('[data-vision-bindings]').querySelectorAll('input,textarea')].map(field=>[field.dataset.visionField,field.value]));values.searchRoots=values.searchRoots.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);void action('configure',values);
  },{signal:controller.signal});
  const dispose=()=>{if(disposed)return;disposed=true;pendingFill=null;clearTimeout(timer);controller.abort();};
  signal?.addEventListener('abort',dispose,{once:true,signal:controller.signal});
  if(signal?.aborted)dispose();else void refresh();
  return dispose;
}
