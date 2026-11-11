import { escape as e, icon } from './components.js';

export function formatResourceBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '待确定';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const scale = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: scale ? 1 : 0 }).format(bytes / 1024 ** scale)} ${units[scale]}`;
}

const activeTask = task => task && ['queued', 'running'].includes(task.status);
const taskLabel = { queued:'等待安装', running:'正在安装', completed:'安装完成', failed:'安装失败', cancelled:'已取消', interrupted:'上次安装已中断' };
const resourceLabel = { pending:'待接入', available:'未安装', installed:'已安装' };

export function resourceReadiness(state) {
  const required = state.resources.filter(resource => resource.required);
  if (!required.length) return '此页无需安装组件';
  const pending = required.filter(resource => resource.status === 'pending').map(resource => resource.name);
  const available = required.filter(resource => resource.status === 'available').map(resource => resource.name);
  return [pending.length ? '安装包尚未接入：'+pending.join('、') : '',available.length ? '待安装或验证：'+available.join('、') : ''].filter(Boolean).join('；') || '所列组件已安装';
}

export function mountInstallation(root, ctx, moduleId, {getPackage}={}) {
  const base = `/api/modules/${encodeURIComponent(moduleId)}/resources`;
  const queues = ctx.ui.installationQueues ||= {};
  const drafts = ctx.ui.installationSelections ||= {};
  const directoryRequests = ctx.ui.directoryRequests ||= {};
  let state;
  let optionalIds = [];
  let pendingSaves = 0;
  let choosingDirectory = false;
  let pollTimer;
  let plan;
  let disposed = false;
  const live = () => !disposed && !ctx.signal.aborted;
  const api = (path = '', method = 'GET', body) => ctx.api(base + path, { method, body, timeoutMs:path === '/choose-directory' ? 0 : undefined });

  root.innerHTML = '<div class="initial-loading" role="status"><span class="loading-orbit" aria-hidden="true"></span><p>正在读取资源清单…</p></div>';
  const dialog = document.createElement('dialog');
  dialog.id = 'installation-confirm';
  dialog.className = 'installation-dialog';
  dialog.setAttribute('aria-labelledby', 'installation-confirm-title');
  document.body.append(dialog);
  const closeDialog = () => { dialog.close(); if (live()) root.querySelector('#resource-plan-preview')?.focus(); };
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  ctx.signal.addEventListener('abort', () => { disposed = true; clearTimeout(pollTimer); dialog.close(); dialog.remove(); }, { once:true });

  function selectedResources() {
    return state.resources.filter(resource => resource.required || optionalIds.includes(resource.id));
  }
  function total(key) {
    const resources = selectedResources().filter(resource => resource.status !== 'installed');
    return resources.some(resource => !Number.isFinite(resource[key])) ? null : resources.reduce((sum, resource) => sum + resource[key], 0);
  }
  function feedback(message = '', error = false) {
    const node = root.querySelector('#resource-feedback');
    if (node) { node.textContent = message; node.className = `form-feedback${error ? ' error' : ''}`; }
  }
  function updateSummary() {
    if (!live() || !state) return;
    root.querySelector('#resource-download-total').textContent = formatResourceBytes(total('downloadBytes'));
    root.querySelector('#resource-space-total').textContent = formatResourceBytes(total('installedBytes'));
    const selecting = choosingDirectory || state.choosingDirectory;
    root.querySelector('#resource-plan-preview').disabled = pendingSaves > 0 || selecting || Boolean(activeTask(state.task)) || selectedResources().length === 0;
    const directoryButton = root.querySelector('#choose-resource-directory');
    directoryButton.disabled = !state.canChooseDirectory || selecting || Boolean(activeTask(state.task));
    directoryButton.innerHTML = `${icon('folder')}${selecting ? '正在选择…' : '选择文件夹'}`;
    root.querySelectorAll('[data-optional-resource]').forEach(input => { input.disabled = Boolean(activeTask(state.task)); });
  }
  function resourceRows(resources, required) {
    return resources.map(resource => `<div class="resource-row" data-resource-id="${e(resource.id)}">
      <input id="resource-${e(resource.id)}" type="checkbox" ${required ? 'data-required-resource checked disabled' : `data-optional-resource="${e(resource.id)}" ${optionalIds.includes(resource.id) ? 'checked' : ''}`} aria-label="${required ? '必装前置：' : '选择'}${e(resource.name)}">
      <div class="resource-identity"><label for="resource-${e(resource.id)}">${e(resource.name)}</label><div class="resource-details">${required ? '<span class="resource-required">必装</span>' : ''}${resource.version ? `<span>v${e(resource.version)}</span>` : ''}<span class="${resource.status === 'installed' ? 'resource-ready' : ''}">${resourceLabel[resource.status] || '待接入'}</span></div></div>
      <div class="resource-size"><span>${resource.status === 'installed' ? '无需下载' : formatResourceBytes(resource.downloadBytes)}</span><small>${resource.status === 'installed' ? '使用已安装文件' : `占用 ${formatResourceBytes(resource.installedBytes)}`}</small></div>
    </div>`).join('');
  }
  function render() {
    if (!live()) return;
    root.innerHTML = `<section class="panel glass resource-panel">
      <div class="panel-heading"><h2>资源安装</h2><span class="status-chip ${state.prerequisitesReady ? 'good' : ''}">${e(resourceReadiness(state))}</span></div>
      <section class="resource-section"><div class="section-heading"><h3>前置依赖</h3><span class="resource-column-label">下载量 / 占用空间</span></div><div id="resource-prerequisites">${resourceRows(state.resources.filter(resource => resource.required),true) || '<p class="resource-empty">无需额外前置</p>'}</div></section>
      <section class="resource-section"><div class="section-heading"><h3>可选文件</h3></div><div id="resource-optionals">${resourceRows(state.resources.filter(resource => !resource.required),false) || '<p class="resource-empty">暂无可选文件</p>'}</div></section>
      <div class="field resource-directory"><label for="resource-directory">安装位置</label><div class="directory-picker"><input id="resource-directory" value="${e(state.directory)}" readonly spellcheck="false"><button id="choose-resource-directory" type="button" class="button" ${state.canChooseDirectory ? '' : 'disabled title="请在桌面工作台中选择文件夹"'}>${icon('folder')}选择文件夹</button></div>${state.resources.some(resource => resource.status === 'installed') ? '<p class="resource-location-note">更换位置后，已有文件保留在原文件夹，新位置需重新安装。</p>' : ''}</div>
      <div class="resource-summary"><span>本次下载 <strong id="resource-download-total"></strong></span><span>新增占用 <strong id="resource-space-total"></strong></span></div>
      <div class="form-actions"><p id="resource-feedback" class="form-feedback" role="status"></p><button id="resource-plan-preview" type="button" class="button primary">查看安装清单 ${icon('arrow')}</button></div>
    </section><section id="resource-task" class="panel glass resource-task" aria-live="polite" hidden></section>`;
    root.querySelectorAll('[data-optional-resource]').forEach(input => input.addEventListener('change', () => {
      optionalIds = [...root.querySelectorAll('[data-optional-resource]:checked')].map(node => node.dataset.optionalResource);
      drafts[moduleId] = [...optionalIds];
      const snapshot = [...optionalIds]; pendingSaves++; updateSummary();
      const request = (queues[moduleId] || Promise.resolve()).catch(() => {}).then(() => api('/selection','PUT',{optionalIds:snapshot}));
      queues[moduleId] = request;
      request.then(() => { if (live()) feedback(); }, error => { if (live()) feedback(error.message,true); }).finally(() => { pendingSaves--; if (live()) updateSummary(); });
    }, { signal:ctx.signal }));
    root.querySelector('#resource-plan-preview').addEventListener('click', preview, { signal:ctx.signal });
    root.querySelector('#choose-resource-directory').addEventListener('click', chooseDirectory, { signal:ctx.signal });
    updateSummary(); renderTask();
  }
  async function chooseDirectory() {
    choosingDirectory = true; updateSummary(); feedback();
    const request = api('/choose-directory','POST',{});
    directoryRequests[moduleId] = request;
    try {
      const selected = await request;
      if (!live()) return;
      state = selected; plan = null; render();
      if (!selected.cancelled) feedback('安装位置已保存');
      root.querySelector('#choose-resource-directory')?.focus();
    } catch (error) { if (live()) feedback(error.message,true); }
    finally {
      if (directoryRequests[moduleId] === request) delete directoryRequests[moduleId];
      choosingDirectory = false;
      if (live()) { updateSummary(); root.querySelector('#choose-resource-directory')?.focus(); }
    }
  }
  function renderTask() {
    if (!live()) return;
    const container = root.querySelector('#resource-task');
    const task = state.task;
    container.hidden = !task;
    if (!task) return;
    const running = activeTask(task);
    const measured = Number.isFinite(task.totalBytes) && task.totalBytes > 0;
    const totalBytes = task.totalBytes;
    const completedBytes = Math.max(0,task.completedBytes || 0);
    container.innerHTML = `<div class="panel-heading"><h2>${taskLabel[task.status] || '安装状态'}</h2>${running ? '<button type="button" class="button small" id="cancel-resource-task">取消安装</button>' : ''}</div><p class="resource-task-stage">${e(task.stage || taskLabel[task.status])}</p>${running ? `<progress aria-label="安装进度" ${measured ? `max="${totalBytes}" value="${Math.min(completedBytes,totalBytes)}"` : ''}></progress>${measured ? `<p class="resource-task-bytes">${formatResourceBytes(completedBytes)} / ${formatResourceBytes(totalBytes)}</p>` : ''}` : ''}${task.error ? `<p class="form-feedback error">${e(task.error)}</p>` : ''}`;
    container.querySelector('#cancel-resource-task')?.addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try { const response = await api('/cancel','POST',{taskId:task.id}); if (live()) { state.task = response.task; renderTask(); updateSummary(); await refreshTask(); } }
      catch(error) { if (live()) { feedback(error.message,true); button.disabled = false; } }
    }, { signal:ctx.signal });
  }
  async function preview() {
    const button = root.querySelector('#resource-plan-preview');
    button.disabled = true; feedback();
    try {
      const selected = [...optionalIds];
      const save = (queues[moduleId] || Promise.resolve()).catch(() => {}).then(() => api('/selection','PUT',{optionalIds:selected}));
      queues[moduleId] = save;
      await save;
      plan = await api('/plan','POST',{optionalIds:selected});
      if (!live()) return;
      plan.optionalIds = selected;
      plan.importedPackage = getPackage?.()??null;
      dialog.innerHTML = `<div class="installation-dialog-body"><div class="panel-heading"><h2 id="installation-confirm-title">确认安装</h2><button type="button" class="icon-button" id="close-resource-confirm" aria-label="关闭安装清单">${icon('close')}</button></div>
        <div class="installation-plan-list">${plan.resources.map(resource => `<div class="installation-plan-row"><div><strong>${e(resource.name)}</strong><small>${resource.required ? '必装' : '可选'}${resource.version ? ` · v${e(resource.version)}` : ''} · ${e(resource.sourceLabel || '来源待接入')}</small></div><span>${resource.status === 'installed' ? '已安装，复用' : formatResourceBytes(resource.downloadBytes)}</span></div>`).join('')}</div>
        <dl class="installation-totals"><div><dt>本次下载</dt><dd>${formatResourceBytes(plan.downloadBytes)}</dd></div><div><dt>新增占用</dt><dd>${formatResourceBytes(plan.installedBytes)}</dd></div><div class="installation-location"><dt>安装位置</dt><dd>${e(plan.directory)}</dd></div></dl>
        ${plan.reasons.length ? `<ul class="installation-reasons">${plan.reasons.map(reason => `<li>${e(reason)}</li>`).join('')}</ul>` : ''}<p id="installation-confirm-error" class="form-feedback error" role="alert"></p>
        <div class="installation-dialog-actions"><button type="button" class="button" id="cancel-resource-confirm">返回</button><button type="button" class="button primary" id="confirm-resource-install" ${plan.canInstall ? '' : 'disabled'}>确认安装</button></div></div>`;
      dialog.querySelector('#close-resource-confirm').addEventListener('click',closeDialog);
      dialog.querySelector('#cancel-resource-confirm').addEventListener('click',closeDialog);
      dialog.querySelector('#confirm-resource-install').addEventListener('click',install);
      dialog.showModal();
      dialog.querySelector(plan.canInstall ? '#confirm-resource-install' : '#cancel-resource-confirm').focus();
    } catch(error) { if (live()) feedback(error.message,true); }
    finally { if (live()) updateSummary(); }
  }
  async function install() {
    const button = dialog.querySelector('#confirm-resource-install');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = plan.importedPackage
        ? await ctx.api(`/api/modules/${encodeURIComponent(moduleId)}/package`,{method:'POST',body:{package:plan.importedPackage,planId:plan.planId}})
        : await api('/install','POST',{planId:plan.planId,optionalIds:plan.optionalIds});
      if (!live()) return;
      state.task = result.task; closeDialog(); renderTask(); updateSummary(); await refreshTask();
    } catch(error) {
      if (live()) dialog.querySelector('#installation-confirm-error').textContent = `${error.message} 请返回后重新查看安装清单。`;
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (live() && activeTask(state.task)) pollTimer = setTimeout(refreshTask,800);
  }
  async function refreshTask() {
    try {
      const next = await api();
      if (!live()) return;
      state = next;
      if (!activeTask(state.task)) { render(); void ctx.refresh().catch(() => {}); }
      else { renderTask(); updateSummary(); }
      schedulePoll();
    } catch(error) { if (live()) { feedback(error.message,true); schedulePoll(); } }
  }
  async function load() {
    try {
      await (queues[moduleId] || Promise.resolve()).catch(() => {});
      await (directoryRequests[moduleId] || Promise.resolve()).catch(() => {});
      const next = await api();
      if (!live()) return;
      state = next;
      const savedDraft = drafts[moduleId] || state.optionalIds;
      optionalIds = savedDraft.filter(id => state.resources.some(resource => resource.id === id && !resource.required));
      render(); schedulePoll();
    } catch(error) {
      if (!live()) return;
      root.innerHTML = `<section class="panel glass"><h2>资源清单暂时无法读取</h2><p class="form-feedback error">${e(error.message)}</p><button type="button" class="button" id="retry-resources">重试</button></section>`;
      root.querySelector('#retry-resources').addEventListener('click',load,{signal:ctx.signal});
    }
  }
  void load();
}
