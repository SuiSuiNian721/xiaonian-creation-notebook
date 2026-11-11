import { escape as e } from './components.js';

export function canImportInspection(result) {
  return result.available && !['missingNodes','missingModels','invalidValues','errors'].some(key => result[key]?.length);
}

export function inspectionMarkup(result) {
  const groups = [['missingNodes','缺失节点'],['missingModels','缺失模型'],['invalidValues','参数问题'],['errors','工作流问题'],['warnings','尚需核实']];
  const lists = groups.filter(([key]) => result[key]?.length).map(([key, label]) => `<section class="drawing-inspection-group"><h3>${e(label)} · ${result[key].length}</h3><ul>${result[key].map((item, index) => {
    const entry = typeof item === 'string' ? {detail:item} : item;
    const location = [entry.nodeId ? `节点 ${entry.nodeId}` : '', entry.classType || '', entry.input || ''].filter(Boolean).join(' · ');
    const actual = Object.hasOwn(entry, 'value') ? `<p class="drawing-path">${key === 'missingModels' ? '缺失文件' : '实际值'}：${e(displayValue(entry.value))}</p>` : '';
    const options = Array.isArray(entry.options) ? `<details><summary>当前允许值 · ${entry.options.length}</summary><p class="drawing-path">${e(entry.options.map(displayValue).join('、') || '暂无可选值')}</p></details>` : entry.options && typeof entry.options === 'object' ? `<p class="drawing-path">${e(Object.entries(entry.options).map(([name,value]) => `${({min:'最小值',max:'最大值',step:'步长'})[name] || name}：${displayValue(value)}`).join(' · '))}</p>` : '';
    const action = key === 'missingNodes' && entry.classType || key === 'missingModels' && typeof entry.value === 'string' ? `<button type="button" class="button small" data-inspection-resource="${key}:${index}">${key === 'missingNodes' ? '准备插件' : '准备模型'}</button>` : '';
    return `<li>${location ? `<strong>${e(location)}</strong>` : ''}<p>${e(entry.detail || entry.message || '请核对该项。')}</p>${actual}${options}${action}</li>`;
  }).join('')}</ul></section>`).join('');
  const summary = !result.available ? '当前环境尚未核实' : result.valid ? '节点与参数检查通过' : canImportInspection(result) ? '部分内容需要进一步校验' : '发现需要处理的缺项';
  return `<div class="drawing-check-heading"><strong>${e(summary)}</strong><span class="status-chip ${result.valid ? 'good' : ''}">${e(result.nodeCount ?? 0)} 个节点</span></div>${lists}`;
}

const displayValue = value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
const modelCategory = input => {
  if (/^(ckpt|checkpoint)(?:_name|_file)?$/i.test(input)) return 'checkpoints';
  if (/^lora(?:_name|_file)?$/i.test(input)) return 'loras';
  if (/^vae(?:_name|_file)?$/i.test(input)) return 'vae';
  if (/^clip(?:_name\d*|_file)?$/i.test(input)) return 'clip';
  if (/^unet(?:_name|_file)?$/i.test(input)) return 'unet';
  if (/^diffusion(?:_name|_file)?$/i.test(input)) return 'diffusion_models';
  if (/^control_net(?:_name|_file)?$/i.test(input)) return 'controlnet';
  return '';
};

export function bindInspectionActions(root, ctx, result) {
  root.querySelectorAll('[data-inspection-resource]').forEach(button => {
    const [group,index] = button.dataset.inspectionResource.split(':');
    const entry = result[group]?.[Number(index)];
    if (!entry) return;
    const target = group === 'missingNodes' ? {tab:'resources',section:'plugins',query:entry.classType} : {tab:'resources',section:'downloads',filename:entry.value,category:modelCategory(entry.input)};
    button.onclick = () => ctx.action(button, async () => {
      try { await ctx.navigateModule('comfyui', target); }
      catch (error) { if (!ctx.signal.aborted) ctx.notify(error.message, true); }
    });
  });
}
