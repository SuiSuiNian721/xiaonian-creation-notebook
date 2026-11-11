import { naturalCaptionTypes } from '../public-workbench/training-types.js';
import { WorkbenchError } from './contracts.mjs';
export { naturalCaptionTypes };
export const styleTags = ['watercolor', 'watercolor (medium)', 'oil painting', 'sketch', 'lineart', 'traditional media', 'digital media', 'monochrome', 'greyscale', 'flat color', 'graphite (medium)', 'pencil (medium)', 'ink (medium)', 'photorealistic', 'realistic'];
function datasetPolicy(config) {
  const modern = ['moss-image-lora', 'anima-lora', 'anima-finetune', 'sd3-lora'].includes(config.model_train_type);
  const minimum = modern ? 16 : /^(?:sdxl|flux|lumina)/.test(config.model_train_type || '') ? 32 : 64;
  const step = config.bucket_reso_steps ?? (modern ? 16 : 64);
  if (!Number.isInteger(step) || step < minimum || step > 512 || step % minimum) throw new WorkbenchError(400, `分桶步长须为 ${minimum} 的倍数，且不超过 512。`);
  if (config.bucket_no_upscale !== undefined && typeof config.bucket_no_upscale !== 'boolean') throw new WorkbenchError(400, '分桶不放大图片须为开关值。');
  return { enable_bucket: true, bucket_no_upscale: config.bucket_no_upscale ?? true, bucket_reso_steps: step };
}
export function trainingStrategy(input, config = {}, { version = 3 } = {}) {
  const captionFormat = input.captionFormat && input.captionFormat !== 'auto' ? input.captionFormat : naturalCaptionTypes.has(config.model_train_type) ? 'natural' : 'tags';
  const purpose = input.purpose || 'character';
  const flag = value => value === true || value === 1 || typeof value === 'string' && /^(?:true|1|yes)$/i.test(value);
  const mossDefaults = config.model_train_type === 'moss-image-lora' && (config.cache_text_encoder_outputs === undefined || config.cache_text_encoder_outputs_to_disk === undefined);
  const cachesText = flag(config.cache_text_encoder_outputs) || flag(config.cache_text_encoder_outputs_to_disk) || mossDefaults;
  return {
    version, purpose, captionFormat, captioner: captionFormat === 'natural' ? 'florence2-base' : input.taggerModel,
    cropMode: input.cropMode === 'none' || purpose === 'style' ? 'preserve' : purpose,
    preserveOriginals: true, preserveKeypoints: purpose === 'pose', maxCropsPerImage: purpose === 'character' ? 2 : purpose === 'pose' ? 1 : 0,
    cropRepeatScale: purpose === 'character' ? 0.5 : 1,
    suppressTags: purpose === 'style' ? styleTags : [], suppressCharacterNames: purpose !== 'style',
    ...(version >= 3 ? { dataset: datasetPolicy(config) } : {}),
    training: { shuffle_caption: captionFormat === 'tags' && !cachesText, caption_tag_dropout_rate: 0, caption_dropout_rate: 0, caption_dropout_every_n_epochs: 0, token_warmup_step: 0, keep_tokens: captionFormat === 'tags' && input.trigger ? 1 : 0, color_aug: false, flip_aug: purpose === 'pose' ? false : config.flip_aug === true },
  };
}
