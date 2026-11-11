import { WorkbenchError } from './contracts.mjs';
import { isLink } from './drawing-workflows.mjs';

const emptyTypes = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage']);
const specs = schema => ({ ...schema?.input?.required, ...schema?.input?.optional });
const choices = spec => Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === 'COMBO' ? spec[1]?.options || [] : [];

// Only adapt a single, explicit initial image sampler. Existing image encoders,
// advanced samplers and ambiguous parallel branches retain their original graph.
export function img2imgPlan(prompt, info, vaeSources) {
  const candidates = Object.entries(prompt).filter(([, node]) => node.class_type === 'KSampler' &&
    isLink(node.inputs.latent_image) && node.inputs.latent_image[1] === 0 && emptyTypes.has(prompt[node.inputs.latent_image[0]]?.class_type));
  const unavailable = { available: false, maxImages: 0, reason: '此工作流没有可明确接入的原图位置；请使用已有图片字段或导入图生图工作流。' };
  if (candidates.length !== 1 || vaeSources.length !== 1 || !info.LoadImage || !info.VAEEncodeTiled || !info.ImageScale || !info.ImageScaleToTotalPixels) return unavailable;
  const [samplerId, sampler] = candidates[0], sourceId = sampler.inputs.latent_image[0], source = prompt[sourceId];
  if (!['width', 'height'].every(key => typeof source.inputs[key] === 'number' || isLink(source.inputs[key])) || typeof sampler.inputs.denoise !== 'number') return unavailable;
  const encoder = { vae: vaeSources[0] };
  for (const [name, spec] of Object.entries(info.VAEEncodeTiled.input?.required || {})) {
    if (['pixels', 'vae'].includes(name)) continue;
    if (spec[1]?.default === undefined) return unavailable;
    encoder[name] = spec[1].default;
  }
  const sizeKeys = ['width', 'height'].map(name => `${sourceId}:${name}`);
  for (const name of ['width', 'height']) {
    const value = source.inputs[name];
    if (isLink(value) && prompt[value[0]]?.class_type === 'ZML_PresetResolutionV2') for (const key of ['预设', '互换宽高', '随机模式', '自定义宽', '自定义高']) sizeKeys.push(`${value[0]}:${key}`);
  }
  return { available: true, mode: 'img2img', maxImages: 1, images: choices(specs(info.LoadImage).image).filter(value => typeof value === 'string'), samplerId, sourceId, encoder,
    denoiseKey: `${samplerId}:denoise`, sizeKeys: [...new Set(sizeKeys)], defaultDenoise: 0.65 };
}

export function applyImg2img(next, original, adjustments, info, plan, nextId) {
  if (adjustments.images.length !== 1) throw new WorkbenchError(400, '原图重绘一次只能选择一张输入图片。');
  const image = adjustments.images[0];
  if (!plan.images.includes(image)) throw new WorkbenchError(400, '输入图片不在当前服务的图片列表中，请重新上传。');
  const denoise = adjustments.imageDenoise ?? plan.defaultDenoise;
  if (typeof denoise !== 'number' || !Number.isFinite(denoise) || denoise < 0 || denoise > 1) throw new WorkbenchError(400, '重绘幅度应在 0 到 1 之间。');
  const source = original[plan.sourceId].inputs, loadId = nextId('image'), scaleId = nextId('resize'), encodeId = nextId('encode');
  next[loadId] = { class_type: 'LoadImage', inputs: { image }, _meta: { title: '工作台输入图片' } };
  if (adjustments.referenceSize === 'workflow') next[scaleId] = { class_type: 'ImageScale', inputs: { image: [loadId, 0], width: source.width, height: source.height, upscale_method: 'lanczos', crop: 'center' } };
  else next[scaleId] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [loadId, 0], upscale_method: 'lanczos', megapixels: 1,
    ...(specs(info.ImageScaleToTotalPixels).resolution_steps ? { resolution_steps: 16 } : {}) } };
  next[encodeId] = { class_type: 'VAEEncodeTiled', inputs: { pixels: [scaleId, 0], ...plan.encoder }, _meta: { title: '工作台原图编码' } };
  let latent = [encodeId, 0];
  const count = source.batch_size ?? 1;
  if (count !== 1) {
    const spec = specs(info.RepeatLatentBatch).amount;
    if (!spec || !isLink(count) && (!Number.isSafeInteger(count) || count < (spec[1]?.min ?? 1) || count > (spec[1]?.max ?? 64))) throw new WorkbenchError(400, '当前服务无法保留这个生成张数，请改为 1 张后重试。');
    const repeatId = nextId('batch');
    next[repeatId] = { class_type: 'RepeatLatentBatch', inputs: { samples: latent, amount: count } }; latent = [repeatId, 0];
  }
  next[plan.samplerId].inputs.latent_image = latent;
  next[plan.samplerId].inputs.denoise = denoise;
}
