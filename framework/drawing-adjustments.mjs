import { WorkbenchError, fields } from './contracts.mjs';
import { isLink } from './drawing-workflows.mjs';
import { img2imgPlan, applyImg2img } from './drawing-img2img.mjs';

const choices = spec => Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === 'COMBO' && Array.isArray(spec[1]?.options) ? spec[1].options : [];
const definitions = schema => ({ ...schema?.input?.required, ...schema?.input?.optional });
const sameLink = (a, b) => isLink(a) && isLink(b) && a[0] === b[0] && a[1] === b[1];

// Only choose a root when every connected branch agrees on the same source.
function roots(prompt, info, type) {
  const connected = new Map();
  for (const node of Object.values(prompt)) for (const value of Object.values(node.inputs || {})) {
    if (!isLink(value)) continue;
    const source = prompt[value[0]];
    if (info[source?.class_type]?.output?.[value[1]] !== type) continue;
    const hasParent = Object.values(source.inputs || {}).some(input => isLink(input) && info[prompt[input[0]]?.class_type]?.output?.[input[1]] === type);
    if (!hasParent) connected.set(JSON.stringify(value), value);
  }
  return [...connected.values()];
}

function loraPlan(prompt, info) {
  const models = roots(prompt, info, 'MODEL'), clips = roots(prompt, info, 'CLIP');
  const loader = clips.length === 1 && info.LoraLoader ? 'LoraLoader' : clips.length === 0 && info.LoraLoaderModelOnly ? 'LoraLoaderModelOnly' : null;
  const options = definitions(info[loader]);
  const names = choices(options.lora_name).filter(item => typeof item === 'string' && item);
  let reason;
  if (models.length !== 1) reason = '工作流有多个模型分支或没有模型连接，请在原工作流中指定 LoRA 接入位置。';
  else if (!loader) reason = '当前工作流没有可明确接入的 LoRA 加载器，请在原工作流中添加 LoRA 节点。';
  else if (!names.length) reason = '当前 ComfyUI 尚未列出可用 LoRA。';
  return { available: !reason, choices: names, supportsClip: loader === 'LoraLoader', ...(reason ? { reason } : {}), loader, model: models[0], clip: clips[0] };
}

function referencePlan(prompt, info, { allowConversion = false } = {}) {
  const nodes = Object.entries(prompt).filter(([, node]) => node.class_type === 'TextEncodeQwenImage21');
  const images = choices(definitions(info.LoadImage).image).filter(item => typeof item === 'string');
  // Converting a text-to-image graph is an explicit adjustment, not an input
  // declared by that workflow. Keep inferred conversions out of its form.
  if (!nodes.length) return allowConversion ? img2imgPlan(prompt, info, roots(prompt, info, 'VAE')) :
    { available: false, maxImages: 0, reason: '此工作流没有可追加的图片输入；如需改图，请使用图生图工作流。' };
  if (nodes.length !== 1 || !info.LoadImage) return { available: false, maxImages: 0, reason: '此工作流没有可直接增加的参考图入口；可使用已有参考图字段或导入图生图工作流。' };
  const [id, node] = nodes[0];
  const samplers = Object.entries(prompt).filter(([, candidate]) => {
    const latent = candidate.inputs?.latent_image;
    const empty = isLink(latent) && latent[1] === 0 && ['EmptyLatentImage', 'EmptySD3LatentImage'].includes(prompt[latent[0]]?.class_type);
    return ['KSampler', 'KSamplerAdvanced'].includes(candidate.class_type) && sameLink(candidate.inputs?.positive, [id, 0]) && sameLink(candidate.inputs?.negative, [id, 1]) && (empty || sameLink(latent, [id, 2]));
  }).map(([key]) => key);
  if (!samplers.length) return { available: false, maxImages: 0, reason: '此工作流的参考图采样分支无法自动确定，请在原工作流中连接。' };
  const spec = definitions(info[node.class_type]).images;
  const names = spec?.[0] === 'COMFY_AUTOGROW_V3' ? spec[1]?.template?.names : null;
  const sources = roots(prompt, info, 'VAE');
  const vae = isLink(node.inputs.vae) ? node.inputs.vae : sources.length === 1 ? sources[0] : null;
  const slots = Array.isArray(names) ? names.filter(name => typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name)).map(name => 'images.' + name).filter(name => !Object.hasOwn(node.inputs, name)) : [];
  const available = Boolean(vae && slots.length);
  const roles = slots.map(slot => { const index = names.indexOf(slot.slice('images.'.length)); return { slot, role: index === 0 ? 'primary' : 'reference', label: index === 0 ? '主图' : `参考图 ${index}` }; });
  return { available, maxImages: slots.length, ...(!available ? { reason: vae ? '参考图输入已全部占用。' : '无法确定参考图使用的 VAE，请在原工作流中连接。' } : {}), id, slots, images, vae, samplers, roles, primarySlot: Array.isArray(names) ? 'images.' + names[0] : null };
}

export function drawingControls(prompt, info) {
  const lora = loraPlan(prompt, info), reference = referencePlan(prompt, info);
  return {
    lora: { available: lora.available, choices: lora.choices, supportsClip: lora.supportsClip, ...(lora.reason ? { reason: lora.reason } : {}) },
    reference: { available: reference.available, maxImages: reference.maxImages, ...(reference.available ? { images: reference.images, roles: reference.mode === 'img2img' ? [{ role: 'primary', label: '主图' }] : reference.roles } : {}),
      ...(reference.mode === 'img2img' ? { mode: reference.mode, denoiseKey: reference.denoiseKey, sizeKeys: reference.sizeKeys, defaultDenoise: reference.defaultDenoise } : {}), ...(reference.reason ? { reason: reference.reason } : {}) },
  };
}

function weight(value, spec, label) {
  const limits = spec?.[1] || {};
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (limits.min ?? -100) || value > (limits.max ?? 100)) throw new WorkbenchError(400, `${label}超出允许范围。`);
  return value;
}

export function applyDrawingAdjustments(prompt, adjustments = {}, info) {
  fields(adjustments, ['loras', 'images', 'referenceSize', 'imageDenoise', 'imageSlots'], '绘图设置');
  if (adjustments.referenceSize !== undefined && !['reference', 'workflow'].includes(adjustments.referenceSize)) throw new WorkbenchError(400, '请选择有效的参考图尺寸模式。');
  const { loras = [], images = [] } = adjustments;
  if (!Array.isArray(loras) || loras.length > 16 || !Array.isArray(images) || images.length > 16) throw new WorkbenchError(400, 'LoRA 和参考图均不能超过 16 项。');
  if (adjustments.imageSlots !== undefined && (!Array.isArray(adjustments.imageSlots) || adjustments.imageSlots.length !== images.length || adjustments.imageSlots.some(slot => typeof slot !== 'string') || new Set(adjustments.imageSlots).size !== images.length)) throw new WorkbenchError(400, '图片位置与图片数量不匹配，请重新选择主图和参考图。');
  const next = structuredClone(prompt);
  let serial = 0;
  const nextId = kind => { let id; do { id = `workbench_${kind}_${++serial}`; } while (Object.hasOwn(next, id)); return id; };
  if (loras.length) {
    const plan = loraPlan(prompt, info);
    if (!plan.available) throw new WorkbenchError(400, plan.reason);
    let model = plan.model, clip = plan.clip;
    const specs = definitions(info[plan.loader]);
    for (const lora of loras) {
      fields(lora, ['name', 'modelWeight', 'clipWeight'], 'LoRA');
      if (!plan.choices.includes(lora.name)) throw new WorkbenchError(400, '所选 LoRA 不在当前 ComfyUI 的可选列表中，请刷新后重新选择。');
      const id = nextId('lora');
      const inputs = { model, lora_name: lora.name, strength_model: weight(lora.modelWeight, specs.strength_model, 'LoRA 模型权重') };
      if (plan.supportsClip) Object.assign(inputs, { clip, strength_clip: weight(lora.clipWeight, specs.strength_clip, 'LoRA 文本权重') });
      else if (lora.clipWeight !== undefined && lora.clipWeight !== 1) throw new WorkbenchError(400, '此工作流仅支持 LoRA 模型权重。');
      next[id] = { class_type: plan.loader, inputs, _meta: { title: '工作台 LoRA' } };
      model = [id, 0]; if (plan.supportsClip) clip = [id, 1];
    }
    // Rewrite only original consumers so newly inserted loaders cannot point back at themselves.
    for (const id of Object.keys(prompt)) for (const [name, value] of Object.entries(next[id].inputs)) {
      if (sameLink(value, plan.model)) next[id].inputs[name] = model;
      else if (plan.supportsClip && sameLink(value, plan.clip)) next[id].inputs[name] = clip;
    }
  }
  if (images.length) {
    const plan = referencePlan(prompt, info, { allowConversion: true });
    if (!plan.available) throw new WorkbenchError(400, plan.reason);
    if (plan.mode === 'img2img') { if (adjustments.imageSlots !== undefined) throw new WorkbenchError(400, '此工作流仅支持一张主图。'); applyImg2img(next, prompt, adjustments, info, plan, nextId); return next; }
    if (adjustments.imageDenoise !== undefined) throw new WorkbenchError(400, '此工作流由原有采样参数控制重绘幅度。');
    if (images.length > plan.slots.length) throw new WorkbenchError(400, `此工作流还能添加 ${plan.slots.length} 张参考图。`);
    const slots = adjustments.imageSlots ?? plan.slots.slice(0, images.length);
    if (slots.some(slot => !plan.slots.includes(slot))) throw new WorkbenchError(400, '选择的图片位置已被原工作流占用或不存在。');
    if (!Object.hasOwn(prompt[plan.id].inputs, plan.primarySlot) && !slots.includes(plan.primarySlot)) throw new WorkbenchError(400, '请先选择主图，再添加参考图。');
    for (const [index, image] of images.entries()) {
      if (!plan.images.includes(image)) throw new WorkbenchError(400, '参考图不在当前 ComfyUI 的图片列表中，请重新上传。');
      const id = nextId('image');
      next[id] = { class_type: 'LoadImage', inputs: { image }, _meta: { title: '工作台参考图' } };
      next[plan.id].inputs[slots[index]] = [id, 0];
    }
    next[plan.id].inputs.vae = plan.vae;
    // Qwen's edit coordinates use the first reference latent's dimensions.
    // Keep a deliberate alternative for generating a different composition.
    if (adjustments.referenceSize !== 'workflow') for (const id of plan.samplers) {
      const source = prompt[prompt[id].inputs.latent_image[0]];
      const count = source.inputs.batch_size ?? 1;
      let latent = [plan.id, 2];
      if (count !== 1) {
        const spec = definitions(info.RepeatLatentBatch).amount;
        if (!spec || !Number.isSafeInteger(count) || count < (spec[1]?.min ?? 1) || count > (spec[1]?.max ?? 64)) throw new WorkbenchError(400, '当前服务无法在跟随参考图尺寸时保留此张数，请改为 1 张或使用宽高设置。');
        const repeatId = nextId('batch');
        next[repeatId] = { class_type: 'RepeatLatentBatch', inputs: { samples: latent, amount: count }, _meta: { title: '工作台参考图张数' } };
        latent = [repeatId, 0];
      }
      next[id].inputs.latent_image = latent;
    }
  }
  return next;
}
