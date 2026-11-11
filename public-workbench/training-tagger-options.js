// Native Next Trainer Tagger fields. The workflow already owns model/path.
export const taggerModels = Object.freeze(['cl_tagger_1_01', 'wd-convnext-v3', 'wd-swinv2-v3', 'wd-vit-v3', 'wd14-convnextv2-v2', 'wd14-swinv2-v2', 'wd14-vit-v2', 'wd14-moat-v2', 'wd-eva02-large-tagger-v3', 'wd-vit-large-tagger-v3']);
export const taggerModelOptions = Object.freeze(taggerModels.map(value => ({ value, label: value === 'cl_tagger_1_01' ? 'CLTagger 1.01' : value })));
export const taggerOptionFields = Object.freeze([
  { key: 'download_endpoint', label: '模型下载源', type: 'select', default: '默认', options: ['默认', 'https://hf-mirror.com', 'https://modelscope.cn'], tooltip: '仅在允许下载缺失模型时使用；选择下载源不会开启联网。' },
  { key: 'threshold', label: '标签阈值', type: 'number', min: 0, max: 1, step: 0.01, default: 0.35 },
  { key: 'character_threshold', label: '角色阈值', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6, tooltip: '用于模型单独返回的 character 类别，CLTagger 支持。' },
  { key: 'add_rating_tag', label: '等级标签', type: 'boolean', default: false },
  { key: 'add_model_tag', label: 'AI 模型标签', type: 'boolean', default: false },
  { key: 'additional_tags', label: '附加标签', type: 'text', default: '', tooltip: '使用逗号分隔；触发词仍单独保留。' },
  { key: 'replace_underscore', label: '下划线转空格', type: 'boolean', default: true },
  { key: 'escape_tag', label: '转义括号', type: 'boolean', default: true },
  { key: 'batch_input_recursive', label: '包含子文件夹', type: 'boolean', default: true, tooltip: '控制原图目录扫描；工作副本仅处理已登记的图集。' },
  { key: 'batch_output_action_on_conflict', label: '已有标签', type: 'select', default: 'ignore', options: [{ value: 'ignore', label: '保留已有' }, { value: 'copy', label: '重新生成' }, { value: 'prepend', label: '新标签在前' }, { value: 'append', label: '新标签在后' }] },
]);

export function normalizeTaggerOptions(value, { legacyPolicy } = {}) {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('打标参数须为对象。');
  const input = value || {}, keys = new Set(taggerOptionFields.map(field => field.key));
  if (Object.keys(input).some(key => !keys.has(key))) throw new Error('存在未知打标参数。');
  const result = {};
  for (const field of taggerOptionFields) {
    let item = input[field.key] ?? field.default;
    if (Object.hasOwn(input, field.key) && input[field.key] === null) throw new Error(`打标参数 ${field.label} 无效。`);
    if (field.key === 'batch_output_action_on_conflict' && !Object.hasOwn(input, field.key) && legacyPolicy === 'regenerate') item = 'copy';
    if (field.key === 'download_endpoint' && item === '') item = '默认';
    if (field.type === 'number' && (typeof item !== 'number' || !Number.isFinite(item) || item < field.min || item > field.max) || field.type === 'boolean' && typeof item !== 'boolean' || field.type === 'text' && (typeof item !== 'string' || item.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item)) || field.type === 'select' && !field.options.some(option => (typeof option === 'string' ? option : option.value) === item)) throw new Error(`打标参数 ${field.label} 无效。`);
    result[field.key] = item;
  }
  return result;
}
