import { connectionTypeResolver, expandedInputs } from './drawing-schema.mjs';

const link = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);

export function imageFieldRoles(prompt, fields, info) {
  const pictures = fields.filter(field => field.image);
  if (!pictures.length) return fields;
  const types = connectionTypeResolver(prompt, info), roles = new Map();
  const mark = (key, role) => { const items = roles.get(key) || new Set(); items.add(role); roles.set(key, items); };
  function walkImage(value, role, seen = new Set()) {
    if (!link(value)) return;
    const [id, slot] = value, token = JSON.stringify(value); if (seen.has(token)) return; seen.add(token);
    const node = prompt[id]; if (!node || types.outputType(id, slot) !== 'IMAGE') return;
    const inputs = pictures.filter(field => field.nodeId === id);
    if (inputs.length) { inputs.forEach(field => mark(field.key, role)); return; }
    for (const input of Object.values(node.inputs)) if (link(input) && types.outputType(input[0], input[1]) === 'IMAGE') walkImage(input, role, seen);
  }
  function walkLatent(value, seen = new Set()) {
    if (!link(value)) return;
    const [id] = value; if (seen.has(id)) return; seen.add(id);
    const node = prompt[id]; if (!node) return;
    if (['VAEEncode', 'VAEEncodeTiled', 'VAEEncodeForInpaint'].includes(node.class_type)) { walkImage(node.inputs.pixels, 'primary'); return; }
    for (const input of Object.values(node.inputs)) if (link(input) && types.outputType(input[0], input[1]) === 'LATENT') walkLatent(input, seen);
  }
  for (const node of Object.values(prompt)) {
    if (node.class_type === 'TextEncodeQwenImage21') {
      const names = [...expandedInputs(info[node.class_type], node.inputs).definitions.keys()].filter(name => name.startsWith('images.'));
      names.forEach((name, index) => walkImage(node.inputs[name], index === 0 ? 'primary' : `reference:${index}`));
    }
    if (['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'].includes(node.class_type)) walkLatent(node.inputs.latent_image);
  }
  const labels = new Map();
  for (const field of pictures) {
    const uses = roles.get(field.key) || new Set(), primary = uses.has('primary'), references = [...uses].filter(role => role.startsWith('reference:')).map(role => Number(role.split(':')[1])).sort((a,b) => a-b);
    const role = primary ? 'primary' : references.length ? 'reference' : 'unknown';
    const label = primary ? '主图' : references.length ? `参考图 ${references.join('、')}` : '图片输入';
    const description = primary ? '作为图生图的主要输入画面。' + (references.length ? '这张图片也连接到了参考图输入。' : '') : references.length ? '提供补充外观或内容参考；用途由工作流中的图文连接决定。' : '这是工作流中的图片输入；未能可靠确认主图或参考图用途，请按原工作流选择。';
    labels.set(field.key, { label, description, imageRole: role });
  }
  const counts = new Map(), indices = new Map();
  for (const item of labels.values()) counts.set(item.label, (counts.get(item.label) || 0) + 1);
  return fields.map(field => {
    const image = labels.get(field.key); if (!image) return field;
    let label = image.label;
    if (counts.get(label) > 1) { const index = (indices.get(label) || 0) + 1; indices.set(label, index); label += ` ${index}`; }
    return { ...field, presentation: { ...field.presentation, ...image, label } };
  });
}
