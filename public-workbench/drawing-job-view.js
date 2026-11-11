import { escape as e, icon } from './components.js';

const active = new Set(['submitting', 'queued', 'running', 'unknown']);
const labels = { submitting: '提交中', queued: '排队中', running: '生成中', unknown: '待核实', completed: '已完成', failed: '失败', cancelled: '已取消' };
const signatures = new WeakMap();

function resultView(result) {
  const media = result.kind === 'video' ? `<video controls preload="metadata" src="${e(result.url)}" aria-label="${e(result.sourceName)}"></video>`
    : result.kind === 'audio' ? `<audio controls preload="metadata" src="${e(result.url)}" aria-label="${e(result.sourceName)}"></audio>`
    : result.kind === 'animation' ? `<img src="${e(result.url)}" alt="${e(result.sourceName)}" loading="lazy">`
    : ['text', 'data'].includes(result.kind) ? `<pre class="drawing-result-text" tabindex="0">${e(result.text)}</pre>` : '';
  const label = { video: '保存视频', audio: '保存音频', animation: '保存动图', text: '下载文本', data: '下载数据', file: '下载文件' }[result.kind] || '下载文件';
  return `<figure class="drawing-result drawing-result-${e(result.kind)}" data-result-id="${e(result.id)}">${media}<figcaption><span class="drawing-result-name">${e(result.sourceName)}</span><div class="drawing-result-actions">${['text', 'data'].includes(result.kind) ? `<button type="button" class="text-link" data-result-copy="${e(result.id)}">复制${result.kind === 'data' ? '数据' : '文本'}</button>` : ''}<a class="text-link" href="${e(result.url)}?download=1" download="${e(result.sourceName || result.filename)}">${icon('download')}${label}</a></div></figcaption>${result.truncated ? '<span class="drawing-result-truncated">仅显示预览，复制或下载可获取完整内容</span>' : ''}<span class="drawing-result-feedback" role="status"></span></figure>`;
}

export function renderDrawingJobs(node, allJobs, actions) {
  const jobs = allJobs.slice(0, 30);
  const signature = JSON.stringify(jobs.map(({ preview, progress, ...job }) => ({ ...job, hasProgress: !!progress })));
  if (signatures.get(node) !== signature) {
    const expandedSeeds = new Set([...node.querySelectorAll('[data-job-seeds][open]')].map(item => item.dataset.jobSeeds));
    const previousResults = new Map([...node.querySelectorAll('[data-result-id]')].map(item => [item.dataset.resultId, { node: item, playing: [...item.querySelectorAll('video,audio')].some(media => !media.paused) }]));
    signatures.set(node, signature);
    node.innerHTML = jobs.length ? jobs.map(job => `<article class="drawing-job">
      <div class="drawing-job-title"><strong>${e(job.workflowName)}</strong><div class="drawing-job-tools"><span class="status-chip ${job.status === 'completed' ? 'good' : ''}">${e(job.cancelRequestedAt && active.has(job.status) ? '正在取消' : labels[job.status] || job.status)}</span>${actions.remove&&['completed','failed','cancelled'].includes(job.status)?`<button type="button" class="text-link" data-job-remove="${e(job.id)}" aria-label="移除 ${e(job.workflowName)} 的记录" title="仅从列表移除，保留作品文件">移除</button>`:''}</div></div>
      <div class="drawing-job-meta">${job.characterName ? `<span>${e(job.characterName)}</span>` : ''}<time>${e(new Date(job.createdAt).toLocaleString('zh-CN'))}</time></div>
      ${job.seeds?.length ? `<details class="drawing-job-seeds" data-job-seeds="${e(job.id)}" ${expandedSeeds.has(job.id)?'open':''}><summary>本次种子</summary><dl>${job.seeds.map(seed=>`<dt>${e(seed.label)}</dt><dd>${e(seed.value)}</dd>`).join('')}</dl></details>` : ''}
      ${job.progress && job.status === 'running' ? '<div class="drawing-progress"><progress aria-label="生成进度"></progress><span></span></div>' : ''}
      ${job.error ? `<p class="form-feedback error">${e(job.error)}</p>` : ''}
      ${active.has(job.status) && job.previewMethod !== 'none' ? '<figure class="drawing-live-preview" hidden><img alt="正在生成的过程预览" decoding="async"><figcaption>生成预览</figcaption></figure>' : ''}
      ${job.previewNotice && active.has(job.status) ? `<p class="drawing-preview-notice">${e(job.previewNotice)}</p>` : ''}
      ${job.warning ? `<p class="form-feedback error">${e(job.warning)}</p>` : ''}
      ${job.images?.length ? `<div class="drawing-gallery">${job.images.map(image => `<figure><button class="drawing-image-button" type="button" data-image-view="${e(image.url)}" aria-label="放大查看 ${e(image.sourceName)}"><img src="${e(image.url)}" alt="${e(image.sourceName)}" loading="lazy"></button><figcaption><a class="text-link" href="${e(image.url)}?download=1" download="${e(image.filename)}">${icon('download')}保存图片</a>${actions.save?`<button type="button" class="text-link" data-image-library="${e(image.url)}" data-image-name="${e(image.filename||image.sourceName)}">保存到角色资料</button>`:''}</figcaption></figure>`).join('')}</div>` : ''}
      ${job.results?.length ? `<div class="drawing-job-results">${job.results.map(resultView).join('')}</div>` : ''}
      ${active.has(job.status) ? `<div class="drawing-actions"><button type="button" class="button small" data-job-refresh="${e(job.id)}">核实状态</button><button type="button" class="button small" data-job-cancel="${e(job.id)}" ${job.cancelRequestedAt ? 'disabled' : ''}>取消任务</button></div>` : ''}
    </article>`).join('') : '<div class="drawing-empty">暂无工作流结果</div>';
    node.querySelectorAll('[data-job-refresh]').forEach(button => { button.onclick = () => actions.refresh(button, button.dataset.jobRefresh); });
    node.querySelectorAll('[data-job-cancel]').forEach(button => { button.onclick = () => actions.cancel(button, button.dataset.jobCancel); });
    node.querySelectorAll('[data-job-remove]').forEach(button => { button.onclick = () => actions.remove(button, button.dataset.jobRemove); });
    node.querySelectorAll('[data-image-view]').forEach(button => { button.onclick = () => actions.view(button.dataset.imageView); });
    node.querySelectorAll('[data-image-library]').forEach(button=>{button.onclick=()=>actions.save({url:button.dataset.imageLibrary,name:button.dataset.imageName});});
    node.querySelectorAll('[data-result-id]').forEach(item => {
      const previous = previousResults.get(item.dataset.resultId);
      if (previous) { item.replaceWith(previous.node); if (previous.playing) previous.node.querySelector('video,audio')?.play().catch(() => {}); }
    });
    node.querySelectorAll('.drawing-result video,.drawing-result audio').forEach(media => { media.onerror = () => { media.closest('.drawing-result').querySelector('.drawing-result-feedback').textContent = '浏览器无法播放，请下载查看。'; }; });
    node.querySelectorAll('[data-result-copy]').forEach(button => { button.onclick = async () => {
      const result = jobs.flatMap(job => job.results || []).find(item => item.id === button.dataset.resultCopy);
      const feedback = button.closest('.drawing-result').querySelector('.drawing-result-feedback'); button.disabled = true;
      try {
        let content = result.text || '';
        if (result.truncated) { const response = await fetch(result.url); if (!response.ok) throw new Error('读取失败'); content = await response.text(); }
        await navigator.clipboard.writeText(content); feedback.textContent = '已复制';
      } catch { feedback.textContent = '复制失败，请下载文件。'; }
      finally { button.disabled = false; }
    }; });
  }
  node.querySelectorAll('.drawing-job').forEach((article, index) => {
    const job = jobs[index], progress = article.querySelector('progress');
    if (progress && job.progress) {
      progress.max = job.progress.max; progress.value = job.progress.value;
      progress.nextElementSibling.textContent = `${job.progress.value} / ${job.progress.max}`;
    }
    const figure = article.querySelector('.drawing-live-preview'); if (!figure) return;
    const image = figure.querySelector('img');
    if (!job.preview?.url) { figure.hidden = true; image.onload = null; image.onerror = null; image.removeAttribute('src'); return; }
    if (image.getAttribute('src') !== job.preview.url) {
      image.onload = () => { figure.hidden = false; };
      image.onerror = () => { figure.hidden = true; };
      image.src = job.preview.url;
    }
  });
}
