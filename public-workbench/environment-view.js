import { escape as e, icon, help } from './components.js';

const supported = new Set(['qq','comfyui','drawing','training','mc-play','mc-skin','companion']);

// Results and in-flight requests belong to the workbench session, not a tab.
export function mountEnvironmentDiscovery(root, ctx, {moduleId, onSelect, canSelect = () => true}) {
  if (!supported.has(moduleId)) return {update() {}};
  if (!document.querySelector('link[data-environment-style]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = new URL('./environment.css', import.meta.url).href;
    link.dataset.environmentStyle = ''; document.head.append(link);
  }
  const cache = ctx.ui.environmentDiscovery ??= {};
  const family = moduleId === 'drawing' ? 'comfyui' : moduleId;
  const record = cache[family] ??= {attempted:false, result:null, pending:null, error:'', selecting:false, revision:0, listeners:new Set()};
  const minecraft = moduleId === 'mc-play';
  const module = ctx.state.modules.find(item => item.id === moduleId);
  const targetName = module?.discovery?.name || module?.requirements?.join('、') || module?.name || moduleId;
  const candidateLabel=(candidate,index)=>['training','companion'].includes(moduleId)?(moduleId==='training'?'训练环境':'陪伴运行组件')+' '+(index+1):candidate.label;
  const issueName=issue=>moduleId==='training'?'训练环境':moduleId==='companion'?'陪伴运行组件':issue.name;
  const enabled = () => {
    const module = ctx.state.modules.find(item => item.id === moduleId);
    return Boolean(module) && module.enabled !== false;
  };
  const explanation = minecraft
    ? '监听 Minecraft Java 版的局域网公告。单机世界先对局域网开放，再重新扫描；采用只填地址和端口，不加入世界。'
    : '扫描只查找本机组件，采用后填入配置，不会保存或启动服务。' + (moduleId === 'mc-skin' ? '发现 Python 路径不代表版本或 Pillow 已检查通过。' : '');
  root.innerHTML = `<section class="environment-discovery" data-environment-discovery aria-label="查找${e(targetName)}">
    <div class="environment-heading"><div class="heading-title"><h3>${e(targetName)}</h3>${help(explanation, targetName+'扫描说明')}</div><button type="button" class="button small" data-environment-rescan>${icon('search')}重新扫描</button></div>
    <div data-environment-results></div><p class="form-feedback environment-feedback" data-environment-feedback role="status" aria-live="polite" hidden></p>
  </section>`;
  const view = root.firstElementChild;
  const find = selector => view.querySelector(selector);
  let choosing = false;
  const alive = () => !ctx.signal.aborted && root.contains(view) && view.isConnected;
  const feedback = (message = '', error = false) => {
    if (!alive()) return;
    const node = find('[data-environment-feedback]');
    node.textContent = message; node.hidden = !message;
    node.className = 'form-feedback environment-feedback' + (error ? ' error' : '');
  };
  function update() {
    if (!alive()) { record.listeners.delete(changed); return; }
    const busy = Boolean(record.pending) || choosing || record.selecting;
    const rescan = find('[data-environment-rescan]');
    rescan.disabled = busy || !enabled();
    rescan.innerHTML = `${icon('search')}${record.pending ? '正在扫描…' : '重新扫描'}`;
    view.setAttribute('aria-busy', String(Boolean(record.pending) || choosing));
    find('[data-environment-directory]')?.toggleAttribute('disabled', busy || !enabled());
    view.querySelectorAll('[data-environment-select]').forEach(button => {
      const candidate = record.result?.candidates.find(item => item.id === button.dataset.environmentSelect);
      button.disabled = busy || !enabled() || !candidate?.selectable || !canSelect(candidate);
    });
  }
  function render() {
    if (!alive()) { record.listeners.delete(changed); return; }
    const candidates = record.result?.candidates || [];
    const issues = (record.result?.issues || []).filter(issue => !candidates.some(candidate => candidate.selectable) || issue.explicit === true);
    const directory = !minecraft && record.result?.canChooseDirectory;
    find('[data-environment-results]').innerHTML = record.pending
      ? `<p class="environment-empty" role="status">正在查找${e(targetName)}…</p>`
      : candidates.length
        ? `<ul class="environment-candidates">${candidates.map((candidate,index) => `<li class="environment-candidate"><div class="environment-location"><strong>${e(candidateLabel(candidate,index))}</strong><span class="environment-path">${e(candidate.path)}</span>${candidate.reason ? `<span class="environment-reason">${e(candidate.reason)}</span>` : ''}</div><button type="button" class="button small" data-environment-select="${e(candidate.id)}" aria-label="采用 ${e(candidateLabel(candidate,index))}">采用</button></li>`).join('')}</ul>`
        : `<div class="environment-empty" data-environment-empty><span>${e(record.error ? targetName+'扫描未完成' : issues.length ? targetName+(issues.every(issue=>issue.status==='unreadable')?'无法完成检查':'不完整') : minecraft ? '未收到'+targetName+'公告' : '本次扫描未找到'+targetName)}</span>${directory ? `<button type="button" class="text-link" data-environment-directory aria-label="选择${e(targetName)}目录查找">${icon('folder')}选择目录查找</button>` : ''}</div>`;
    if (issues.length) {
      const list = document.createElement('ul');list.className = 'environment-candidates';
      list.innerHTML = issues.map(issue => `<li class="environment-candidate"><div class="environment-location"><strong>${e(issueName(issue))}</strong><span class="environment-path">${e(issue.path)}</span><span class="environment-reason">${e(issue.detail)}</span></div></li>`).join('');
      find('[data-environment-results]').append(list);
    }
    if (!record.pending && (record.result?.partial || record.result?.warnings?.length)) {
      const notice = document.createElement('div'); notice.className = 'environment-notice';
      notice.innerHTML = `<span>${e(targetName)}：部分位置未扫描</span>${help(record.result.warnings?.join('；') || '扫描已达到本次范围上限，可选择更具体的目录再查找。',targetName+'扫描范围说明')}`;
      find('[data-environment-results]').append(notice);
    }
    feedback(record.error, Boolean(record.error));
    update();
  }
  function changed(stateOnly = false) { if (stateOnly) update(); else render(); }
  const publish = (stateOnly = false) => { for (const listener of record.listeners) listener(stateOnly); };
  async function scan(refresh = false, directory, resume = false) {
    if (!alive() || !enabled() || record.selecting) return;
    if (!record.pending && (!record.attempted || refresh || resume)) {
      record.revision++;
      record.attempted = true; record.error = ''; record.result = null;
      record.pending = Promise.resolve().then(() => ctx.api('/api/environment/scan', {
        method:'POST', body:{moduleId, ...(refresh ? {refresh:true} : {}), ...(directory ? {directory} : {})}, timeoutMs:30000,
      })).then(result => { record.result = result;record.error=result.error||''; }, error => { record.error = targetName+'扫描失败：'+(error.message || '请重新扫描。'); })
        .finally(() => { record.pending = null; publish(); });
      publish();
    } else render();
    await record.pending;
  }
  async function chooseDirectory() {
    if (!alive() || !enabled() || choosing || record.pending || record.selecting || minecraft) return;
    choosing = true; feedback(); update();
    try {
      const result = await ctx.api('/api/environment/choose-directory', {method:'POST', body:{moduleId}, timeoutMs:0});
      if (!alive() || result.cancelled || !result.directory) return;
      await scan(true, result.directory);
    } catch (error) { feedback(targetName+'目录选择失败：'+(error.message || '请重试。'), true); }
    finally { choosing = false; update(); }
  }
  async function select(candidate) {
    if (!alive() || !enabled() || record.pending || choosing || record.selecting || !candidate?.selectable || !canSelect(candidate)) { update(); return; }
    record.selecting = true; feedback(); publish(true);
    try { await onSelect(candidate); if (alive()) feedback('已填入配置'); }
    catch (error) { feedback(targetName+'无法采用：'+(error.message || '请重试。'), true); }
    finally { record.selecting = false; publish(true); }
  }
  view.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-environment-rescan')) void scan(true);
    if (button.hasAttribute('data-environment-directory')) void chooseDirectory();
    if (button.hasAttribute('data-environment-select')) void select(record.result?.candidates.find(item => item.id === button.dataset.environmentSelect));
  }, {signal:ctx.signal});
  record.listeners.add(changed);
  ctx.signal.addEventListener('abort', () => record.listeners.delete(changed), {once:true});
  async function restore(){
    if(record.pending)return render();
    const revision=record.revision;
    try{
      const saved=await ctx.api('/api/environment/state?moduleId='+encodeURIComponent(moduleId));
      if(!alive()||record.pending||record.revision!==revision)return;
      if(saved.attempted){
        record.attempted=true;record.result=saved.result;record.error=saved.error||'';
        // A non-refresh request joins the existing scan, or reads its final cache.
        if(saved.status==='running')return scan(false,undefined,true);
        publish();if(!record.error)feedback(saved.stale?'配置已变化；需要更新结果时点击重新扫描。':'已载入上次检索结果，需要更新时点击重新扫描。');
      }
      else await scan();
    }catch(error){if(!alive()||record.pending||record.revision!==revision)return;record.attempted=true;record.error='无法读取检索记录：'+error.message;publish();}
  }
  render(); void restore();
  return {update};
}
