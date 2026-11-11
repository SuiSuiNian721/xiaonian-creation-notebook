import { escape as e, icon, help, downloadJson } from './components.js';

const API = '/api/modules/drawing/manager';
const STATUS = { queued:'等待中', downloading:'下载中', verifying:'校验中', running:'执行中', paused:'已暂停', interrupted:'已中断', completed:'已完成', failed:'失败' };
const ACTIVE = new Set(['queued','downloading','verifying','running']);
const CATEGORIES = ['checkpoints','diffusion_models','unet','loras','vae','vae_approx','clip','text_encoders','controlnet','upscale_models','embeddings'];
const bytes = value => value == null ? '大小未知' : value < 1024 ? value + ' B' : new Intl.NumberFormat('zh-CN', {maximumFractionDigits:1}).format(value / (1024 ** Math.min(3, Math.floor(Math.log(value) / Math.log(1024))))) + [' B',' KiB',' MiB',' GiB'][Math.min(3, Math.floor(Math.log(value) / Math.log(1024)))];
const date = value => new Date(value).toLocaleString('zh-CN');
const changeMarkup = change => `<div><strong>${e(change.label)}</strong>${change.path ? `<p class="drawing-path">${e(change.path)}</p>` : ''}${change.source ? `<p class="drawing-path">${e(change.source)}</p>` : ''}<dl><dt>当前</dt><dd>${e(change.before)}</dd><dt>应用后</dt><dd>${e(change.after)}</dd></dl></div>`;

// Original decoder weights and family mapping: https://github.com/madebyollin/taesd
// ComfyUI selects matching decoder prefixes from models/vae_approx in latent_preview.py.
export const PREVIEW_DECODERS = [
  ['SD1.5 / SD2','taesd_decoder.pth'],['SDXL','taesdxl_decoder.pth'],['SD3','taesd3_decoder.pth'],['FLUX.1','taef1_decoder.pth'],
].map(([family,filename]) => ({family,filename,category:'vae_approx',source:'https://github.com/madebyollin/taesd',url:'https://raw.githubusercontent.com/madebyollin/taesd/main/'+filename}));

export function resourceDownloadDraft(draft, target) {
  if (target?.section !== 'downloads') return draft;
  if (target.previewDecoders) {
    const decoder=PREVIEW_DECODERS.find(item=>item.family===target.family);
    return {url:decoder?.url || '',filename:decoder?.filename || '',category:'vae_approx',sha256:''};
  }
  if (typeof target.filename !== 'string') return draft;
  return {url:'',category:typeof target.category === 'string' ? target.category : '',filename:target.filename.split(/[\\/]/).at(-1),sha256:''};
}

export async function mountManager(root, ctx, snapshots = false, target = null) {
  const { signal } = ctx;
  const logScope = ctx.instanceId === undefined ? '' : '&instance=' + encodeURIComponent(ctx.instanceId);
  const find = selector => root.querySelector(selector);
  const post = (path, body = {}, timeoutMs = 90000) => ctx.api(API + path, {method:'POST', body, timeoutMs});
  let state, plan, planRequest = 0, polling = false, repositoryId = null, listSignature = '', taskSignature = '';
  let section = snapshots ? 'snapshots' : ['models','plugins','downloads'].includes(target?.section) ? target.section : ctx.ui.drawingManagerSection || 'models';
  const draftKey = snapshots ? 'drawing:snapshot' : 'drawing:download';
  root.innerHTML = '<p class="form-feedback" role="status">正在读取管理记录…</p>';
  state = await ctx.api(API + '/state');
  if (signal.aborted) return;
  const config=ctx.state.modules.find(module=>module.id==='drawing')?.config || {};
  let remote=true;
  try {const url=new URL(config.serviceUrl);remote=!['localhost','127.0.0.1','[::1]'].includes(url.hostname);} catch {}
  const scopeNotice=remote ? '当前服务地址为远程或尚未核实。本页下载与插件安装只修改本机目录，不会安装到远程 ComfyUI；请在服务端安装，或选择该服务实际使用的环境配置。' : '下载与插件安装使用本机所选 ComfyUI 目录。请确认正在连接的服务使用同一目录。';
  root.innerHTML = `<section class="panel glass drawing-manager">
    <div class="panel-heading"><h2>${snapshots ? '环境快照' : '模型与插件'}</h2><div class="drawing-actions">${snapshots ? help('保存本体与插件 Git 版本、启用状态、运行设置及选定配置。模型文件不复制；Python 仅保存版本和依赖清单。','快照范围') : '<button type="button" class="button" id="manager-scan">重新索引</button>'}<button type="button" class="text-link" id="manager-refresh">刷新记录</button><button type="button" class="text-link" id="manager-drawing">返回角色绘图 ${icon('arrow')}</button></div></div>
    ${snapshots ? `<form id="manager-snapshot-form" class="drawing-inline-form"><div class="field"><label for="snapshot-name">快照名称</label><input id="snapshot-name" name="name" maxlength="120" placeholder="环境快照"></div><button class="button primary" type="submit" id="snapshot-create">创建快照</button></form>` : `<div class="drawing-manager-nav" role="group" aria-label="资源类别"><button type="button" class="button small" data-section="models">模型</button><button type="button" class="button small" data-section="plugins">插件与本体</button><button type="button" class="button small" data-section="downloads">下载</button></div><p class="drawing-muted" id="manager-index-detail"></p>`}
    <p class="form-feedback" id="manager-feedback" role="status"></p>
    ${snapshots ? '' : `<p class="drawing-preview-notice" id="manager-local-scope">${e(scopeNotice)}<span class="drawing-path"> 本体：${e(config.comfyPath || '未选择')} · 服务：${e(config.serviceUrl || '未配置')}</span> <button type="button" class="text-link" id="manager-config">环境配置</button></p>`}
    <div id="manager-models" ${snapshots ? 'hidden' : ''}><div class="drawing-inline-form"><div class="field"><label for="model-search">查找模型</label><input id="model-search" type="search" placeholder="名称或类别"></div></div><div id="manager-model-list"></div></div>
    <div id="manager-plugins" hidden>${target?.section==='plugins' && target.query ? `<p class="drawing-path">缺失节点：${e(target.query)}</p><p class="drawing-preview-notice">请从工作流作者或<a class="text-link" href="https://registry.comfy.org/" target="_blank" rel="noopener">Comfy Registry</a>核对节点对应的插件，再填写插件 Git 地址。</p>` : ''}<form id="plugin-install-form" class="drawing-install-form"><div class="field"><label for="plugin-url">插件 Git 地址</label><input id="plugin-url" name="url" type="url" placeholder="https://github.com/owner/repository" required></div><div class="field"><label for="plugin-name">目录名（选填）</label><input id="plugin-name" name="name" maxlength="100"></div><button type="submit" class="button" id="plugin-preview-install">预览安装</button></form><div id="manager-plugin-list"></div><div id="manager-repository" hidden></div></div>
    <div id="manager-downloads" hidden><details id="preview-decoder-picker" class="drawing-advanced" ${target?.previewDecoders ? 'open' : ''}><summary>获取预览解码器</summary><div class="field"><label for="preview-decoder-family">当前生成模型家族</label><select id="preview-decoder-family"><option value="">请选择模型家族</option>${PREVIEW_DECODERS.map(item=>`<option value="${e(item.family)}">${e(item.family)} · ${e(item.filename)}</option>`).join('')}</select></div><p class="drawing-preview-notice">只需对应家族的 decoder，保存到 models/vae_approx。其他模型家族与旧版 ComfyUI 请先核对兼容性。<a class="text-link" href="https://github.com/madebyollin/taesd" target="_blank" rel="noopener">官方来源与兼容说明</a></p></details><form id="model-download-form"><div class="field"><div class="field-label"><label for="model-url">模型直链</label>${help('从模型官方页面或工作流作者提供的来源取得文件直链；预填文件名不会推测下载地址。','模型来源说明')}</div><input id="model-url" name="url" type="url" required placeholder="https://…/model.safetensors"></div><div class="drawing-setting-grid"><div class="field"><label for="model-category">模型类别</label><input id="model-category" name="category" list="model-categories" pattern="[A-Za-z](?:[A-Za-z0-9_]|-){0,63}" required><datalist id="model-categories">${CATEGORIES.map(x => `<option value="${x}"></option>`).join('')}</datalist></div><div class="field"><label for="model-filename">文件名</label><input id="model-filename" name="filename" required placeholder="model.safetensors"></div></div><div class="field"><div class="field-label"><label for="model-sha">SHA256（选填）</label>${help('填写来源提供的 SHA256 才能核对文件完整性；留空只计算本地哈希。下载完成前不会放入模型目录。','下载校验说明')}</div><input id="model-sha" name="sha256" pattern="[a-fA-F0-9]{64}" maxlength="64" autocomplete="off"></div><div class="form-actions"><button type="submit" class="button primary" id="model-download">${icon('download')}开始下载</button></div></form><div id="manager-download-list" class="drawing-manager-list"></div></div>
    <div id="manager-snapshot-list" ${snapshots ? '' : 'hidden'}></div>
    <section id="manager-plan" class="drawing-plan" aria-label="待应用计划" tabindex="-1" hidden></section>
  </section>
  <section class="panel glass drawing-manager-tasks"><h2>管理任务</h2><div id="manager-task-list"></div></section>`;
  if (!snapshots && target?.section==='downloads' && typeof target.filename==='string' && /[\\/]/.test(target.filename)) find('#manager-downloads').insertAdjacentHTML('afterbegin',`<p class="drawing-preview-notice" id="manager-requested-file">缺失路径：<span class="drawing-path">${e(target.filename)}</span>。此缺项包含子目录；下载器保存基础文件名，下载后请在工作流中重新选择文件，或将文件放入对应子目录。</p>`);
  const feedback = (message, error = false) => { if (!signal.aborted) { const node = find('#manager-feedback'); node.textContent = message; node.className = 'form-feedback' + (error ? ' error' : ''); } };
  const run = (button, job) => ctx.action(button, async () => { try { await job(); } catch (error) { feedback(error.message, true); } });
  const refresh = async () => { if (signal.aborted || polling) return; polling = true; try { const next = await ctx.api(API + '/state'); if (!signal.aborted) { state = next; render(); } } finally { polling = false; } };
  function showSection(next) {
    section = next; if (!snapshots) ctx.ui.drawingManagerSection = next;
    for (const name of ['models','plugins','downloads']) find('#manager-' + name).hidden = name !== next;
    root.querySelectorAll('[data-section]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.section === next)));
  }
  async function preview(value) {
    const mine = ++planRequest; plan = null;
    const node = find('#manager-plan'); node.hidden = false; node.innerHTML = '<p class="form-feedback" role="status">正在核对目标与版本…</p>';
    try {
      const result = await post('/plan', value);
      if (signal.aborted || mine !== planRequest) return;
      plan = result;
      node.innerHTML = `<div class="panel-heading"><h3>${e(plan.title)}</h3><button type="button" class="text-link" id="plan-dismiss">取消计划</button></div><p class="drawing-path">${e(plan.comfyPath)}</p><div class="drawing-plan-changes">${plan.changes.map(changeMarkup).join('')}</div><p class="drawing-consequence">应用将修改上述目录中的环境。请先退出 ComfyUI；执行前会自动创建快照。</p>${plan.warnings.length ? `<ul class="drawing-plan-warnings">${plan.warnings.map(warning => `<li>${e(warning)}</li>`).join('')}</ul>` : ''}<div class="drawing-actions"><button type="button" class="button primary" id="plan-apply">应用：${e(plan.title)}</button><button type="button" class="text-link" id="plan-export">导出计划</button></div>`;
      find('#plan-dismiss').onclick = () => { planRequest++; plan = null; node.hidden = true; };
      find('#plan-export').onclick = () => downloadJson(plan, 'ComfyUI-操作计划');
      find('#plan-apply').onclick = event => { const selected = plan; return run(event.currentTarget, async () => { const task = await post('/apply', {planId:selected.id}); if (signal.aborted) return; if (plan?.id === selected.id) { plan = null; node.hidden = true; } feedback(task.logWindowError || '已提交：' + task.title,!!task.logWindowError); await refresh(); }); };
      node.scrollIntoView({block:'nearest'}); node.focus({preventScroll:true});
    } catch (error) { if (!signal.aborted && mine === planRequest) node.innerHTML = `<p class="form-feedback error" role="status">${e(error.message)}</p>`; }
  }
  function renderModels() {
    const query = find('#model-search').value.trim().toLowerCase();
    const models = (state.inventory?.models || []).filter(item => `${item.name} ${item.category}`.toLowerCase().includes(query));
    find('#manager-model-list').innerHTML = !state.inventory ? '<div class="drawing-manager-empty">点击“重新索引”读取当前模型与插件。</div>' : models.length ? `<div class="drawing-table-wrap"><table class="drawing-resource-table"><thead><tr><th>模型</th><th>类别</th><th>大小</th></tr></thead><tbody>${models.slice(0,500).map(item => `<tr><td><strong>${e(item.name)}</strong><details><summary>路径与来源</summary><p class="drawing-path">${e(item.path)}</p><p class="drawing-path">${e(item.source || '未记录来源')}</p>${item.sha256 ? `<code class="drawing-path">${e(item.sha256)}</code>` : ''}</details></td><td>${e(item.category)}</td><td class="drawing-size">${bytes(item.size)}</td></tr>`).join('')}</tbody></table></div>${models.length > 500 ? '<p class="drawing-muted">显示前 500 项，请输入名称缩小范围。</p>' : ''}` : '<div class="drawing-manager-empty">没有匹配的模型</div>';
  }
  function selectRepository(id) {
    repositoryId = id; const repo = state.inventory?.repositories.find(item => item.id === id); const node = find('#manager-repository');
    if (!repo) { node.hidden = true; return; }
    node.hidden = false;
    node.innerHTML = `<div class="panel-heading"><h3>${e(repo.name)}</h3><button type="button" class="text-link" id="repository-close">收起</button></div><p class="drawing-path">${e(repo.path)}</p><p class="drawing-path">${e(repo.git?.remote || '未记录 Git 来源')}</p>${repo.git ? `<p class="drawing-path">${e(repo.git.head)} · ${e(repo.git.branch || '分离 HEAD')}</p>` : ''}${repo.git?.dirty ? '<p class="form-feedback error">存在本地修改；更新或恢复前需要先处理这些改动。</p>' : ''}<div class="field"><div class="field-label"><label for="repository-revision">目标分支或标签（选填）</label>${help('留空检查当前分支的快进更新；指定远端分支、标签或其完整提交 SHA 时切换到分离 HEAD，保留原分支。','版本选择说明')}</div><input id="repository-revision" value="${e(ctx.ui.drawingRevisions?.[id] || '')}" placeholder="沿用当前分支"></div><div class="drawing-actions">${repo.git?.remote ? '<button type="button" class="button" id="repository-update">检查版本并预览</button>' : ''}${repo.kind === 'plugin' ? `<button type="button" class="button" id="repository-toggle">预览${repo.enabled ? '停用' : '启用'}</button>${repo.requirements ? '<button type="button" class="button" id="repository-dependencies">预览依赖安装</button>' : ''}` : ''}</div>`;
    find('#repository-close').onclick = () => { repositoryId = null; node.hidden = true; };
    find('#repository-revision').closest('.field').hidden = !repo.git?.remote;
    find('#repository-revision').oninput = event => { (ctx.ui.drawingRevisions ||= {})[id] = event.target.value; };
    if (find('#repository-update')) find('#repository-update').onclick = event => run(event.currentTarget, () => preview({operation:'update', repositoryId:id, revision:find('#repository-revision').value.trim()}));
    if (find('#repository-toggle')) find('#repository-toggle').onclick = event => run(event.currentTarget, () => preview({operation:repo.enabled ? 'disable-plugin' : 'enable-plugin', repositoryId:id}));
    if (find('#repository-dependencies')) find('#repository-dependencies').onclick = event => run(event.currentTarget, () => preview({operation:'dependencies', repositoryId:id}));
    node.scrollIntoView({block:'nearest'});
  }
  function renderDownloads() {
    find('#manager-download-list').innerHTML = state.downloads.length ? state.downloads.map(item => `<article class="drawing-resource-row"><div class="drawing-job-title"><strong>${e(item.filename)}</strong><span class="status-chip ${item.status === 'completed' ? 'good' : ''}">${e(STATUS[item.status] || item.status)}</span></div><p class="drawing-muted">${e(item.category)} · ${bytes(item.downloadedBytes)}${item.totalBytes != null ? ' / ' + bytes(item.totalBytes) : ''}</p>${ACTIVE.has(item.status) ? `<progress aria-label="${e(item.filename)} 下载进度" ${item.totalBytes ? `max="${item.totalBytes}" value="${item.downloadedBytes}"` : ''}></progress>` : ''}${item.error ? `<p class="form-feedback error">${e(item.error)}</p>` : ''}${item.status === 'completed' ? `<p class="drawing-muted">${item.expectedSha256 ? '已匹配预期 SHA256' : '仅计算本地哈希，未提供预期 SHA256'}</p>` : ''}<details><summary>下载记录</summary><p class="drawing-path">${e(item.source)}</p><p class="drawing-path">${e(item.target)}</p>${item.actualSha256 ? `<code class="drawing-path">${e(item.actualSha256)}</code>` : ''}</details>${item.requiresRestart && !ACTIVE.has(item.status) && item.status !== 'completed' ? '<p class="drawing-consequence">继续操作将丢弃此任务的部分下载文件，从头下载。</p>' : ''}<div class="drawing-actions">${ACTIVE.has(item.status) ? `<button type="button" class="button small" data-download-pause="${e(item.id)}">暂停</button>` : item.status !== 'completed' ? `<button type="button" class="button small" data-download-resume="${e(item.id)}">${item.requiresRestart ? '重新下载' : '继续下载'}</button>` : ''}</div></article>`).join('') : '<div class="drawing-manager-empty">暂无下载任务</div>';
    root.querySelectorAll('[data-download-pause],[data-download-resume]').forEach(button => button.onclick = () => run(button, async () => { const id = button.dataset.downloadPause || button.dataset.downloadResume; await post(`/downloads/${id}/${button.dataset.downloadPause ? 'pause' : 'resume'}`); await refresh(); }));
  }
  // Progress updates may replace rows, but must preserve the user's expanded record and keyboard position.
  function rememberListState() {
    const lists = [['#manager-download-list',state.downloads],['#manager-snapshot-list',state.snapshots],['#manager-task-list',state.tasks.slice(0,30)]];
    const opened = new Set(); let focus = null;
    for (const [selector] of lists) {
      for (const row of find(selector).querySelectorAll('article[data-record]')) {
        if (row.querySelector('details[open]')) opened.add(selector + ':' + row.dataset.record);
        if (row.contains(document.activeElement)) {
          const active = document.activeElement;
          const action = [...active.attributes].find(attribute => attribute.name.startsWith('data-'));
          if (active.tagName === 'SUMMARY' || action) focus = {selector,id:row.dataset.record,action:action?.name};
        }
      }
    }
    return () => {
      for (const [selector,items] of lists) find(selector).querySelectorAll(':scope > article').forEach((row,index) => {
        row.dataset.record = items[index].id;
        const details = row.querySelector('details'); if (details && opened.has(selector + ':' + row.dataset.record)) details.open = true;
        if (focus?.selector === selector && focus.id === row.dataset.record) (row.querySelector(focus.action ? `[${focus.action}]` : 'summary') || row.querySelector('button:not(:disabled)') || row.querySelector('summary'))?.focus({preventScroll:true});
      });
    };
  }
  function render() {
    const signature = JSON.stringify(state.inventory);
    if (signature !== listSignature) {
      listSignature = signature;
      if (!snapshots) {
        find('#manager-index-detail').textContent = state.inventory ? `${state.inventory.comfyPath} · ${date(state.inventory.at)}${state.inventory.partial ? ' · 仅下载记录' : ''}` : '尚未建立本地索引';
        renderModels();
        find('#manager-plugin-list').innerHTML = (state.inventory?.repositories || []).map(repo => `<article class="drawing-resource-row drawing-repository-row"><div><strong>${e(repo.name)}</strong><p class="drawing-muted">${e(repo.kind === 'core' ? 'ComfyUI 本体' : repo.enabled ? '启用' : '停用')} · ${e(repo.git ? (repo.git.branch || '分离 HEAD') + ' · ' + repo.git.head.slice(0,10) + (repo.git.dirty ? ' · 有修改' : '') : '非 Git 目录')}</p></div><button type="button" class="button small" data-repository="${e(repo.id)}">管理</button></article>`).join('') || '<div class="drawing-manager-empty">点击“重新索引”读取插件与本体。</div>';
        if (state.inventory?.warnings.length) find('#manager-plugin-list').insertAdjacentHTML('beforeend', `<details class="drawing-index-warnings"><summary>索引提示 · ${state.inventory.warnings.length}</summary><ul>${state.inventory.warnings.map(w => `<li>${e(w)}</li>`).join('')}</ul></details>`);
        root.querySelectorAll('[data-repository]').forEach(button => button.onclick = () => selectRepository(button.dataset.repository));
        if (repositoryId) selectRepository(repositoryId);
      }
    }
    const dynamic = JSON.stringify([state.downloads,state.snapshots,state.tasks]); if (dynamic === taskSignature) return; taskSignature = dynamic;
    const restoreListState = rememberListState();
    renderDownloads();
    if (snapshots) {
      find('#manager-snapshot-list').innerHTML = state.snapshots.length ? state.snapshots.map(item => `<article class="drawing-resource-row"><div class="drawing-job-title"><strong>${e(item.name)}</strong><time class="drawing-muted">${e(date(item.createdAt))}</time></div><p class="drawing-path">${e(item.comfyPath)}</p>${item.warnings?.length ? `<details><summary>记录提示 · ${item.warnings.length}</summary><ul>${item.warnings.map(w => `<li>${e(w)}</li>`).join('')}</ul></details>` : ''}<div class="drawing-actions"><button type="button" class="button small" data-snapshot-restore="${e(item.id)}">预览恢复</button><button type="button" class="text-link" data-snapshot-export="${e(item.id)}">导出快照</button></div></article>`).join('') : '<div class="drawing-manager-empty">暂无环境快照</div>';
      root.querySelectorAll('[data-snapshot-restore]').forEach(button => button.onclick = () => run(button, () => preview({operation:'restore',snapshotId:button.dataset.snapshotRestore})));
      root.querySelectorAll('[data-snapshot-export]').forEach(button => button.onclick = () => run(button, async () => { const result = await ctx.api(API + '/snapshots/' + button.dataset.snapshotExport); if (!signal.aborted) downloadJson(result, 'ComfyUI-环境快照'); }));
    }
    find('#manager-task-list').innerHTML = state.tasks.length ? state.tasks.slice(0,30).map(item => `<article class="drawing-resource-row"><div class="drawing-job-title"><strong>${e(item.title)}</strong><span class="status-chip ${item.status === 'completed' ? 'good' : ''}">${e(STATUS[item.status] || item.status)}</span></div><p class="drawing-path">${e(item.comfyPath)}</p>${item.error ? `<p class="form-feedback error">${e(item.error)}</p>` : ''}<a class="text-link" href="/process-log.html?task=${encodeURIComponent(item.id)}${logScope}" target="_blank" rel="noopener" aria-label="${e(item.title)}独立日志">独立日志</a><details><summary>日志 · ${e(date(item.createdAt))}</summary><pre class="drawing-code">${e(item.log || '暂无输出')}</pre></details></article>`).join('') : '<p class="drawing-muted">暂无管理任务</p>';
    restoreListState();
  }
  find('#manager-refresh').onclick = event => run(event.currentTarget, refresh);
  find('#manager-drawing').onclick = event => run(event.currentTarget, () => ctx.navigateModule('drawing'));
  if (!snapshots) find('#manager-config').onclick = event => run(event.currentTarget, () => ctx.openConfiguration ? ctx.openConfiguration() : ctx.navigateModule('comfyui',{tab:'config'}));
  if (snapshots) {
    const form = find('#manager-snapshot-form'); form.elements.name.value = ctx.drafts.read(draftKey,{name:''}).name;
    form.oninput = () => ctx.drafts.write(draftKey,{name:form.elements.name.value});
    form.onsubmit = event => { event.preventDefault(); const submitted = {name:form.elements.name.value}; void run(find('#snapshot-create'), async () => { await post('/snapshots',submitted); feedback('快照已保存。'); await refresh(); }); };
  } else {
    root.querySelectorAll('[data-section]').forEach(button => button.onclick = () => showSection(button.dataset.section));
    find('#manager-scan').onclick = event => run(event.currentTarget, async () => { feedback('正在索引当前目录…'); await post('/inventory',{},180000); feedback('索引已更新。'); await refresh(); });
    find('#model-search').value = ctx.ui.drawingModelQuery || ''; find('#model-search').oninput = event => { ctx.ui.drawingModelQuery = event.target.value; renderModels(); };
    const form = find('#model-download-form'); const values = resourceDownloadDraft(ctx.drafts.read(draftKey,{url:'',category:'checkpoints',filename:'',sha256:''}),target);
    for (const [key,value] of Object.entries(values)) if (form.elements[key]) form.elements[key].value = value;
    const read = () => Object.fromEntries(['url','category','filename','sha256'].map(key => [key,form.elements[key].value.trim()]));
    form.oninput = () => ctx.drafts.write(draftKey,read());
    if (target?.section==='downloads') ctx.drafts.write(draftKey,read());
    const decoderFamily=find('#preview-decoder-family');
    decoderFamily.value=PREVIEW_DECODERS.find(item=>item.url===values.url && item.filename===values.filename)?.family || '';
    decoderFamily.onchange=()=>{
      const decoder=PREVIEW_DECODERS.find(item=>item.family===decoderFamily.value);
      if (!decoder) return;
      for (const [name,value] of Object.entries(resourceDownloadDraft(read(),{section:'downloads',previewDecoders:true,family:decoder.family}))) form.elements[name].value=value;
      ctx.drafts.write(draftKey,read());
      feedback(`已填写 ${decoder.family} 解码器；核对后点击“开始下载”。`);
    };
    form.onsubmit = event => { event.preventDefault(); const value = read(); const fingerprint = JSON.stringify(value); const previous = ctx.ui.drawingDownloadRequest; const request = previous?.fingerprint === fingerprint ? previous : {fingerprint,id:crypto.randomUUID()}; ctx.ui.drawingDownloadRequest = request; void run(find('#model-download'), async () => { await post('/downloads',{...value,requestId:request.id}); feedback('下载任务已建立。'); await refresh(); }); };
    const install = find('#plugin-install-form'); const pluginKey = 'drawing:plugin-install'; const plugin = target?.section==='plugins' ? {url:'',name:''} : ctx.drafts.read(pluginKey,{url:'',name:''});
    install.elements.url.value = plugin.url; install.elements.name.value = plugin.name;
    if (target?.section==='plugins') ctx.drafts.write(pluginKey,plugin);
    install.oninput = () => ctx.drafts.write(pluginKey,{url:install.elements.url.value,name:install.elements.name.value});
    install.onsubmit = event => { event.preventDefault(); void run(find('#plugin-preview-install'), () => preview({operation:'install-plugin',url:install.elements.url.value.trim(),name:install.elements.name.value.trim()})); };
  }
  showSection(section); render();
  if (target && !snapshots) find(target.previewDecoders ? '#preview-decoder-family' : section==='downloads' ? '#model-url' : section==='plugins' ? '#plugin-url' : '#model-search')?.focus({preventScroll:true});
  const timer = setInterval(() => { void refresh().catch(() => {}); },2200);
  signal.addEventListener('abort', () => clearInterval(timer), {once:true});
}
