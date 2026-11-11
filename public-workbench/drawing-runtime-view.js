import { escape as e, icon, help, downloadJson } from './components.js';

const API='/api/modules/drawing';
const STATUS={starting:'启动中',running:'运行中',stopping:'停止中',exited:'已退出',failed:'启动失败',unknown:'待核实',stopped:'已停止'};
const IDS={pythonPath:'runtime-python',vramMode:'runtime-vram',previewMethod:'runtime-preview',reserveVram:'runtime-reserve'};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";

export async function mountRuntime(root,ctx) {
  const {signal}=ctx, key='drawing:runtime';
  const logScope = ctx.instanceId === undefined ? '' : '?instance=' + encodeURIComponent(ctx.instanceId);
  const find=selector=>root.querySelector(selector);
  const post=(path,body={},timeoutMs=30000)=>ctx.api(API+path,{method:'POST',body,timeoutMs});
  let state, connection, saved, diagnostics, browserError='', logBusy=false, launchBusy=false, stopBusy=false, saveBusy=false, stopTarget=null;
  root.innerHTML='<p class="form-feedback" role="status">正在读取 ComfyUI 启动设置…</p>';
  [state,connection]=await Promise.all([ctx.api(API+'/runtime'),ctx.api(API+'/state')]);
  if (signal.aborted) return;
  saved=state.settings;
  root.innerHTML=`<section class="panel glass launcher-service">
    <div class="launcher-service-state"><span class="status-chip" id="runtime-connection"></span><span class="drawing-muted" id="runtime-current-path"></span></div>
    <div class="drawing-actions"><button type="button" class="button primary" id="runtime-launch">${icon('play')}启动 ComfyUI</button><button type="button" class="button" id="runtime-stop">停止</button><button type="button" class="button" id="runtime-open">打开 ComfyUI ${icon('arrow')}</button><button type="button" class="text-link" id="runtime-connect">连接</button><button type="button" class="text-link" id="runtime-log-jump">日志</button><button type="button" class="text-link" id="runtime-drawing">角色绘图 ${icon('arrow')}</button></div>
    <p class="form-feedback" role="status" id="runtime-feedback"></p>
    <div id="runtime-stop-confirmation" class="drawing-stop-confirmation" role="group" aria-label="停止 ComfyUI 确认" hidden><p>停止此服务会中断当前生成，未完成的结果可能无法保存。</p><p id="runtime-stop-target" class="drawing-muted"></p><div class="drawing-actions"><button type="button" class="button" id="runtime-stop-confirm">确认停止</button><button type="button" class="button ghost" id="runtime-stop-cancel">取消</button></div></div>
  </section>
  <div class="launcher-runtime-layout"><section class="panel glass launcher-settings">
    <div class="panel-heading"><div class="heading-title"><h2>启动设置</h2>${help('修改后请保存，新设置会在下次启动 ComfyUI 时使用。保存不会自动重启正在运行的服务。','设置何时生效')}</div><div class="drawing-actions"><button type="button" class="text-link" id="runtime-defaults">恢复默认</button><button type="submit" form="drawing-runtime-form" class="button" id="runtime-save">保存设置</button></div></div>
    <p class="drawing-muted" id="runtime-capability-status"></p><form id="drawing-runtime-form"></form>
    <details class="drawing-advanced"><summary>启动命令</summary><pre class="drawing-code" id="runtime-command"></pre></details>
  </section><aside class="launcher-runtime-side">
    <section class="panel glass drawing-runtime-diagnostics"><div class="panel-heading"><h2>环境诊断</h2><button type="button" class="button small" id="runtime-diagnose">${icon('activity')}检查环境</button></div><dl class="launcher-versions" id="runtime-versions" aria-label="组件版本"></dl><div id="runtime-preview-models"></div><div id="runtime-checks"><p class="drawing-muted">尚未检查</p></div><button type="button" class="text-link" id="runtime-export" hidden>${icon('download')}导出诊断</button></section>
    <section class="panel glass drawing-runtime-log"><div class="panel-heading"><h2>启动日志</h2><div class="drawing-actions"><a class="text-link" id="runtime-log-window" href="/process-log.html${logScope}" target="_blank" rel="noopener">独立日志</a><button type="button" class="text-link" id="runtime-log-refresh">刷新</button></div></div><span class="status-chip" id="runtime-process"></span><p class="drawing-muted" id="runtime-process-detail"></p><pre class="drawing-code drawing-log" id="runtime-log" tabindex="0" aria-label="ComfyUI 启动日志">正在读取日志…</pre></section>
  </aside></div>`;
  const form=find('#drawing-runtime-form');
  const fieldNode=field=>find(`[data-runtime-field="${CSS.escape(field.key)}"]`);
  const fields=()=>state.fields || [];
  const read=()=>Object.fromEntries(fields().map(field=>{
    if (field.type==='multiselect') return [field.key,[...root.querySelectorAll(`[data-runtime-multi="${CSS.escape(field.key)}"]:checked`)].map(node=>node.value)];
    const node=fieldNode(field);
    if (!node) return [field.key,saved[field.key]];
    return [field.key,field.type==='boolean'?node.checked:field.type==='number'?(node.value===''?null:Number(node.value)):field.type==='select'?(field.choices.find(choice=>String(choice.value ?? '')===node.value)?.value ?? node.value):node.value];
  }));
  const dirty=()=>Object.entries(read()).some(([name,value])=>!same(value,saved[name]));
  const feedback=(message,error=false)=>{if (!signal.aborted) {const node=find('#runtime-feedback');node.textContent=message;node.className='form-feedback'+(error?' error':'');}};
  const run=(button,job)=>ctx.action(button,async()=>{try{await job();}catch(error){feedback(error.message,true);}});
  const connectedLocally=()=>{try{const url=new URL(connection.connection?.url||ctx.state.modules.find(module=>module.id==='drawing')?.config.serviceUrl);return connection.connection?.connected&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.pathname==='/';}catch{return false;}};
  function updateControls() {
    if (signal.aborted) return;
    const values=read();
    for (const field of fields()) {
      const allowed=field.enabled!==false && (!field.when || field.when.values.some(value=>same(value,values[field.when.key])));
      if (field.type==='multiselect') root.querySelectorAll(`[data-runtime-multi="${CSS.escape(field.key)}"]`).forEach(node=>{const choice=field.choices.find(item=>String(item.value)===node.value);node.disabled=!allowed || choice?.available===false&&!node.checked;});
      else if (fieldNode(field)) fieldNode(field).disabled=!allowed;
      const reset=find(`[data-runtime-reset="${CSS.escape(field.key)}"]`);
      if (reset) reset.hidden=field.enabled!==false || same(values[field.key],state.defaults[field.key]);
    }
    find('#runtime-launch').disabled=launchBusy||stopBusy||saveBusy||!!stopTarget||dirty()||!state.command?.available||!!state.canStop;
    find('#runtime-launch').innerHTML=icon('play')+(state.canStop?'已在运行':connection.connection?.connected?'检查并启动':'启动 ComfyUI');
    find('#runtime-stop').disabled=launchBusy||stopBusy||!!stopTarget||!(state.canStop||connectedLocally());
    find('#runtime-stop-confirm').disabled=stopBusy;find('#runtime-stop-cancel').disabled=stopBusy;
    find('#runtime-open').disabled=!ctx.state.modules.find(module=>module.id==='drawing')?.config.serviceUrl;
  }
  function renderFields(values) {
    const previous=document.activeElement;
    const focused=previous && form.contains(previous)?{key:previous.dataset.runtimeField || previous.dataset.runtimeMulti,value:previous.value,start:previous.selectionStart,end:previous.selectionEnd}:null;
    const openGroups=new Set([...form.querySelectorAll('details[open]')].map(node=>node.dataset.group));
    const initial=!form.children.length;
    const groups=[...new Set(fields().map(field=>field.group))];
    form.innerHTML=groups.map((group,index)=>`<details class="launcher-options-group" data-group="${e(group)}" ${openGroups.has(group)||initial&&index<2?'open':''}><summary>${e(group)}</summary><div>${fields().filter(field=>field.group===group).map(field=>{
      const id=IDS[field.key] || 'runtime-'+field.key;
      const value=values[field.key];
      const describedBy=field.effect?` aria-describedby="${e(id)}-effect"`:'';
      const unavailable=new Map();
      for (const choice of field.choices || []) if (choice.available===false && choice.reason) unavailable.set(choice.reason,[...(unavailable.get(choice.reason) || []),choice.label]);
      const message=[field.help,field.enabled===false?field.reason:'',...[...unavailable].map(([reason,labels])=>labels.join('、')+'：'+reason)].filter(Boolean).join(' ');
      let input;
      if (field.key==='cudaDevice' && state.capabilities?.torch?.devices?.length) {
        const devices=state.capabilities.torch.devices;
        input=`<select id="${e(id)}" data-runtime-field="${e(field.key)}" name="${e(field.key)}"${describedBy}>${devices.some(device=>device.index===value)?'':`<option value="${e(value)}" selected disabled>第 ${e(Number(value)+1)} 张显卡（未发现）</option>`}${devices.map(device=>`<option value="${e(device.index)}" ${device.index===value?'selected':''}>第 ${e(device.index+1)} 张 · ${e(device.name)}${Number.isFinite(device.vramTotal)?` · ${(device.vramTotal/1024**3).toFixed(1)} GiB`:''}</option>`).join('')}</select>`;
      }
      else if (field.type==='select') input=`<select id="${e(id)}" data-runtime-field="${e(field.key)}" name="${e(field.key)}"${describedBy}>${field.choices.map(choice=>`<option value="${e(choice.value ?? '')}" ${same(choice.value,value)?'selected':''} ${choice.available===false?'disabled':''} ${choice.reason?`title="${e(choice.reason)}"`:''}>${e(choice.label)}</option>`).join('')}</select>`;
      else if (field.type==='boolean') input=`<input id="${e(id)}" name="${e(field.key)}" data-runtime-field="${e(field.key)}" type="checkbox"${describedBy} ${value?'checked':''}>`;
      else if (field.type==='multiselect') input=`<div class="launcher-option-checks" id="${e(id)}" role="group" aria-labelledby="${e(id)}-label"${describedBy}>${field.choices.map(choice=>`<label class="check-label"><input type="checkbox" data-runtime-multi="${e(field.key)}" value="${e(choice.value)}" ${(value || []).includes(choice.value)?'checked':''}>${e(choice.label)}</label>`).join('')}</div>`;
      else input=`<input id="${e(id)}" name="${e(field.key)}" data-runtime-field="${e(field.key)}" type="${field.type==='number'?'number':'text'}"${describedBy} value="${e(value ?? '')}" ${field.type==='number'?`${field.min!=null?`min="${field.min}"`:''} ${field.max!=null?`max="${field.max}"`:''} step="${field.step<1?'any':field.step ?? 'any'}"`:''} ${field.key==='pythonPath'?'placeholder="自动选择（一般不用填）" autocomplete="off"':''}>`;
      return `<div class="launcher-option"><div class="launcher-option-copy"><div class="field-label">${field.type==='multiselect'?`<span id="${e(id)}-label">${e(field.label)}</span>`:`<label for="${e(id)}">${e(field.label)}</label>`}${message?help(message,field.label+'详细说明'):''}</div>${field.effect?`<p class="launcher-option-effect" id="${e(id)}-effect">${e(field.effect)}</p>`:''}</div><div class="launcher-option-control ${field.type==='boolean'?'launcher-option-switch':''}">${input}<button type="button" class="text-link" data-runtime-reset="${e(field.key)}" aria-label="还原${e(field.label)}默认值" hidden>还原此项</button></div></div>`;
    }).join('')}</div></details>`).join('') || '<p class="form-feedback error">未读取到启动参数定义，请确认已打开新版工作台。</p>';
    if (focused) {
      const node=find(`[data-runtime-field="${CSS.escape(focused.key)}"]`) || [...root.querySelectorAll(`[data-runtime-multi="${CSS.escape(focused.key)}"]`)].find(item=>item.value===focused.value);
      if (node&&!node.disabled) {node.focus({preventScroll:true});if(focused.start!=null&&['text','search'].includes(node.type))node.setSelectionRange(focused.start,focused.end);}
    }
    updateControls();
  }
  let renderedVersions,renderedModels;
  function renderState() {
    const versions=state.versions || [];
    const versionMarkup=versions.map(item=>`<dt>${e(item.label)}</dt><dd>${e(item.version || '未核实')}${item.status==='stale'?'（待复查）':item.version&&item.status==='unverified'?'（未核实）':''}${help([item.source,item.detail].filter(Boolean).join('；'),item.label+'版本来源')}</dd>`).join('')+`<dt>可用后端</dt><dd>${e(state.backend?.name?.toUpperCase() || '未核实')}${state.backend?.status==='stale'?'（待复查）':state.backend?.name&&state.backend?.status==='unverified'?'（未核实）':''}${help(['这里展示环境检查发现的可用后端，实际运行设备由 ComfyUI 与启动设置决定。',state.backend?.reason].filter(Boolean).join(' '),'计算后端说明')}</dd>`;
    if(versionMarkup!==renderedVersions){find('#runtime-versions').innerHTML=versionMarkup;renderedVersions=versionMarkup;}
    const models=state.previewModels;
    const modelMarkup=models?`<details class="drawing-advanced"><summary>预览解码器 · ${e(models.status==='available'?models.decoders.length+' 个':models.status==='missing'?'本地未找到':'未核实')}</summary><p class="drawing-preview-notice">${e(models.detail)}</p>${models.decoders?.length?`<ul>${models.decoders.map(item=>`<li>${e(item.family)} · ${e(item.name)}</li>`).join('')}</ul>`:''}<p class="drawing-preview-notice">${e(state.previewCompatibility?.detail || '需要匹配当前生成模型。')}</p></details><button type="button" class="button small" id="runtime-preview-get">获取预览解码器</button>`:'';
    if(modelMarkup!==renderedModels){find('#runtime-preview-models').innerHTML=modelMarkup;renderedModels=modelMarkup;const get=find('#runtime-preview-get');if(get)get.onclick=event=>run(event.currentTarget,()=>ctx.openResources ? ctx.openResources({section:'downloads',previewDecoders:true}) : ctx.navigateModule('comfyui',{tab:'resources',section:'downloads',previewDecoders:true}));}
    const command=state.command;
    find('#runtime-command').textContent=command?.available?['& '+quote(command.executable),...(command.args || []).map(quote)].join(' '):command?.error || '请在环境配置中选择 ComfyUI 本体。';
    find('#runtime-current-path').textContent=command?.cwd || ctx.state.modules.find(module=>module.id==='drawing')?.config.comfyPath || '尚未选择本体';
    find('#runtime-capability-status').textContent=state.capabilities?.available||state.capabilities?.status==='current'?'已检查，可用的设置已经解锁。':state.capabilities?.status==='stale'?'ComfyUI 或启动程序已更新，请再点“检查环境”。':'先点“检查环境”，再选择这台电脑支持的设置。';
    const launch=state.launch;
    find('#runtime-process').textContent=launch?(launch.stoppedByWorkbench?'已停止':STATUS[launch.status] || '已有启动记录'):'暂无启动记录';
    find('#runtime-process').className='status-chip'+(launch?.status==='running'?' good':'');
    find('#runtime-process-detail').textContent=launch?[launch.pid?'PID '+launch.pid:'',launch.startedAt?new Date(launch.startedAt).toLocaleString('zh-CN'):'',launch.exitCode!=null?'退出码 '+launch.exitCode:'',launch.error || ''].filter(Boolean).join(' · '):'';
    find('#runtime-connection').textContent=connection.connection?.connected?'ComfyUI 已连接':'ComfyUI 未连接';
    find('#runtime-connection').className='status-chip'+(connection.connection?.connected?' good':'');
    updateControls();
  }
  renderFields({...saved,...ctx.drafts.read(key,{})});renderState();
  if (!state.command?.available) feedback(state.command?.error || '请先保存 ComfyUI 环境配置。',true);
  form.addEventListener('input',()=>{ctx.drafts.write(key,read());feedback('有未保存的修改');updateControls();},{signal});
  form.addEventListener('change',updateControls,{signal});
  form.addEventListener('click',event=>{
    const reset=event.target.closest('[data-runtime-reset]');if (!reset || !form.contains(reset) || reset.hidden) return;
    const fieldKey=reset.dataset.runtimeReset;
    renderFields({...read(),[fieldKey]:state.defaults[fieldKey]});ctx.drafts.write(key,read());feedback('此项已回填默认值，保存后生效。');find('#runtime-save').focus({preventScroll:true});
  },{signal});
  form.addEventListener('submit',event=>{
    event.preventDefault();const submitted=read();saveBusy=true;updateControls();
    void run(find('#runtime-save'),async()=>{
      try {
        const next=await post('/runtime/settings',submitted);
        const draft=ctx.drafts.read(key,submitted);
        for (const [name,value] of Object.entries(submitted)) if (same(draft[name],value)) draft[name]=next.settings[name];
        ctx.drafts.write(key,draft);
        if (signal.aborted) return;
        const current=read();for (const [name,value] of Object.entries(submitted)) if (same(current[name],value)) current[name]=next.settings[name];
        state=next;saved=next.settings;ctx.drafts.write(key,current);
        if (Object.entries(current).every(([name,value])=>same(value,saved[name]))) ctx.drafts.commit(key,current);
        renderFields(current);renderState();feedback(dirty()?'已保存刚才提交的设置，新改动还没保存。':'已保存，下次启动 ComfyUI 时使用。');
      } finally {saveBusy=false;updateControls();}
    });
  },{signal});
  find('#runtime-defaults').onclick=()=>{renderFields(state.defaults);ctx.drafts.write(key,read());feedback('已填入默认设置，保存后用于下次启动。');updateControls();};
  find('#runtime-launch').onclick=async event=>{
    if (launchBusy||stopBusy||saveBusy||dirty()||!state.command?.available) return;
    launchBusy=true;
    try {await run(event.currentTarget,async()=>{updateControls();const result=await post('/launch',{},35000);if(signal.aborted)return;state=await ctx.api(API+'/runtime');if(signal.aborted)return;renderState();feedback(result.logWindowError || (result.connection?.connected?'已连接正在运行的 ComfyUI。':'已请求启动，可查看日志或连接服务。'),!!result.logWindowError);await refreshLogs();});}
    finally {launchBusy=false;updateControls();}
  };
  find('#runtime-stop').onclick=async event=>{
    if(stopBusy||launchBusy||stopTarget||!(state.canStop||connectedLocally()))return;stopBusy=true;
    try {await run(event.currentTarget,async()=>{updateControls();feedback('正在核对本机 ComfyUI 进程…');const result=await post('/runtime/stop-preview',{},35000);if(signal.aborted)return;stopTarget=result.target;find('#runtime-stop-target').textContent=`${stopTarget.scope==='external'?'外部启动的本机服务':'工作台启动的服务'} · PID ${stopTarget.pid} · ${stopTarget.executable}`;find('#runtime-stop-confirmation').hidden=false;feedback('已核对停止目标，请确认。');find('#runtime-stop-confirm').focus({preventScroll:true});});}
    finally {stopBusy=false;updateControls();}
  };
  find('#runtime-stop-cancel').onclick=()=>{stopTarget=null;find('#runtime-stop-confirmation').hidden=true;updateControls();find('#runtime-stop').focus({preventScroll:true});};
  find('#runtime-stop-confirm').onclick=async event=>{
    if(stopBusy||!stopTarget)return;const target=stopTarget;stopBusy=true;
    try{await run(event.currentTarget,async()=>{updateControls();try{await post('/runtime/stop-confirm',{token:target.token},35000);}catch(error){if(error.status>=400&&error.status<500){stopTarget=null;find('#runtime-stop-confirmation').hidden=true;}throw error;}if(signal.aborted)return;stopTarget=null;find('#runtime-stop-confirmation').hidden=true;state=await ctx.api(API+'/runtime');connection={connection:{connected:false}};if(signal.aborted)return;renderState();feedback('ComfyUI 已停止。');await refreshLogs();});}
    finally{stopBusy=false;updateControls();}
  };
  find('#runtime-connect').onclick=event=>run(event.currentTarget,async()=>{const next=await post('/connect');if(signal.aborted)return;connection=next;state=await ctx.api(API+'/runtime');if(signal.aborted)return;renderState();feedback('ComfyUI 已连接。');});
  find('#runtime-open').onclick=event=>run(event.currentTarget,async()=>{if(!connection.connection?.connected)connection=await post('/connect');if(signal.aborted)return;renderState();const result=await post('/open-ui');if(!signal.aborted&&!result.opened)window.open(result.url,'_blank','noopener');});
  find('#runtime-drawing').onclick=event=>run(event.currentTarget,()=>ctx.navigateModule('drawing'));
  find('#runtime-log-jump').onclick=()=>{find('#runtime-log').scrollIntoView({block:'center'});find('#runtime-log').focus({preventScroll:true});};
  find('#runtime-diagnose').onclick=event=>run(event.currentTarget,async()=>{
    find('#runtime-checks').innerHTML='<p class="form-feedback" role="status">正在检查 Python、计算设备、组件版本与预览模型…</p>';
    try {
      const result=await post('/runtime/diagnose',{},150000);if(signal.aborted)return;
      diagnostics=result;const next=await ctx.api(API+'/runtime');if(signal.aborted)return;const current=read();state=next;saved=state.settings;renderFields(current);renderState();
      find('#runtime-checks').innerHTML=`<ul class="drawing-check-list">${(result.checks || []).map(check=>`<li><div class="drawing-check-heading"><strong>${e(check.label)}</strong><span class="status-chip ${check.status==='ok'?'good':''}">${e({ok:'正常',warning:'需留意',error:'异常'}[check.status] || check.status)}</span></div><p class="${check.status==='error'?'form-feedback error':'drawing-muted'}">${e(check.detail)}</p></li>`).join('')}</ul>`;
      find('#runtime-export').hidden=false;
    } catch(error) {if(!signal.aborted)find('#runtime-checks').innerHTML=`<p class="form-feedback error" role="status">${e(error.message)}</p>`;}
  });
  find('#runtime-export').onclick=()=>{if(diagnostics)downloadJson(diagnostics,'ComfyUI-环境诊断');};
  async function refreshLogs() {
    if(signal.aborted||logBusy)return;logBusy=true;
    try {
      const result=await ctx.api(API+'/runtime/logs');if(signal.aborted)return;
      const log=find('#runtime-log'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<36;
      const value=(result.truncated?'…仅显示日志末尾\n':'')+(result.text || '暂无日志。');
      if(log.textContent!==value){log.textContent=value;if(atBottom)log.scrollTop=log.scrollHeight;}
      state.launch=result.launch;
      if(typeof result.canStop==='boolean')state.canStop=result.canStop;
      if(result.connection)connection={connection:result.connection};
      renderState();
      if(result.browser?.status==='failed'&&result.browser.error!==browserError){browserError=result.browser.error;feedback(browserError,true);}
    } finally {logBusy=false;}
  }
  find('#runtime-log-refresh').onclick=event=>run(event.currentTarget,refreshLogs);
  await refreshLogs().catch(error=>feedback(error.message,true));
  const timer=setInterval(()=>{void refreshLogs().catch(()=>{});},2500);
  signal.addEventListener('abort',()=>clearInterval(timer),{once:true});if(signal.aborted)clearInterval(timer);
}
