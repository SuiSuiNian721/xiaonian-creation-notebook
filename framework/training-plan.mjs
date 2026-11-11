import { WorkbenchError, fields, object } from './contracts.mjs';
import { trainingPath } from './training-runtime.mjs';
import { trainingStrategy } from './training-strategies.mjs';
import {normalizeMemoryOptions} from '../public-workbench/training-memory-fields.js';
import {normalizeTaggerOptions,taggerModels as nativeTaggerModels} from '../public-workbench/training-tagger-options.js';
import {resolveCaptioner} from '../public-workbench/training-captioners.js';

export const taggerModels = ['wd14-convnextv2-v2',...nativeTaggerModels.filter(value=>value!=='wd14-convnextv2-v2')];
const number = (value, fallback, low, high, label, integer = true) => {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < low || result > high || integer && !Number.isInteger(result)) throw new WorkbenchError(400, `${label}须在 ${low} 到 ${high} 之间。`);
  return result;
};
const text = (value, fallback, limit, label) => {
  const result = value ?? fallback;
  if (typeof result !== 'string' || result.length > limit || /[\u0000-\u0008]/.test(result)) throw new WorkbenchError(400, `${label}格式无效或过长。`);
  return result.trim();
};
export function pipelineInput(input) {
  object(input, '一键训练输入');
  fields(input, ['sourcePath', 'goal', 'purpose', 'trigger', 'aiEnabled', 'mode', 'captionPolicy', 'allowDownload', 'taggerModel', 'steps', 'repeats', 'rank', 'learningRate', 'cropMode', 'captionFormat', 'detectorPath', 'captionModelPath', 'planner', 'parameterMode','memoryOptions','captionSource','aiCaptionPrompt','taggerOptions','captioner']);
  for (const key of ['aiEnabled', 'allowDownload']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new WorkbenchError(400, `${key}须为布尔值。`);
  for (const key of ['detectorPath', 'captionModelPath']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new WorkbenchError(400, `${key}须为本地目录路径字符串。`);
  const value = {
    sourcePath: trainingPath(input.sourcePath, '训练图集目录'), goal: text(input.goal, '', 3000, '训练目标'),
    purpose: input.purpose ?? 'character', trigger: text(input.trigger, '', 120, '触发词'), aiEnabled: input.aiEnabled ?? false,
    mode: input.mode ?? 'train', captionPolicy: input.captionPolicy ?? 'fill-missing', allowDownload: input.allowDownload ?? false,
    taggerModel: input.taggerModel ?? taggerModels[0], steps: number(input.steps, 1000, 10, 10000, '训练步数'),
    repeats: number(input.repeats, 5, 1, 100, '图像重复次数'), rank: number(input.rank, 16, 1, 128, 'LoRA 秩'),
    learningRate: number(input.learningRate, 0.0001, 0.000001, 0.01, '学习率', false),
    cropMode: input.cropMode ?? 'none', captionFormat: input.captionFormat ?? 'auto',
    planner: input.planner ?? 'basic', parameterMode: input.parameterMode ?? 'recommended',
    detectorPath: input.detectorPath ? trainingPath(input.detectorPath, '裁切模型目录') : '',
    captionModelPath: input.captionModelPath ? trainingPath(input.captionModelPath, '本地描述模型目录') : '',
  };
  if (!['character', 'style', 'pose'].includes(value.purpose) || !['train', 'tag'].includes(value.mode) || !['fill-missing', 'regenerate', 'existing'].includes(value.captionPolicy) || !taggerModels.includes(value.taggerModel) || !['auto', 'none'].includes(value.cropMode) || !['auto', 'tags', 'natural'].includes(value.captionFormat) || !['basic', 'full'].includes(value.planner) || !['recommended', 'defaults'].includes(value.parameterMode)) throw new WorkbenchError(400, '用途、执行模式、裁切或标注格式方案无效。');
  if (/[\r\n]/.test(value.trigger)) throw new WorkbenchError(400, '触发词不能换行。');
  if(input.memoryOptions!==undefined){
    try{const options=normalizeMemoryOptions(input.memoryOptions);if(Object.keys(options).length)value.memoryOptions=options;}
    catch(error){throw new WorkbenchError(400,error.message);}
  }
  if(input.captionSource!==undefined&&!['local','connected'].includes(input.captionSource))throw new WorkbenchError(400,'打标方式无效。');
  if(input.captionSource==='connected')value.captionSource='connected';
  if(input.captioner!==undefined&&input.captionSource!=='connected'){
    try{resolveCaptioner({captioner:input.captioner,captionFormat:value.captionFormat});value.captioner=input.captioner;}
    catch(error){throw new WorkbenchError(400,error.message);}
  }
  if(input.aiCaptionPrompt!==undefined){const prompt=text(input.aiCaptionPrompt,'',6000,'AI 标注补充');if(prompt)value.aiCaptionPrompt=prompt;}
  if(input.taggerOptions!==undefined&&input.captionSource!=='connected'&&input.captionFormat!=='natural'){
    try{normalizeTaggerOptions(input.taggerOptions,{legacyPolicy:value.captionPolicy});if(Object.keys(input.taggerOptions).length)value.taggerOptions=structuredClone(input.taggerOptions);}
    catch(error){throw new WorkbenchError(400,error.message);}
  }
  return value;
}

export async function buildPipelinePlan(input, sharedAI, config = {}, { strategyVersion = 3, signal } = {}) {
  signal?.throwIfAborted();
  let suggestion = {};
  if (input.aiEnabled) {
    if (!sharedAI) throw new WorkbenchError(409, '请配置训练模块或全局 AI 接入，或关闭 AI 辅助后使用本地方案。');
    const result = await sharedAI.complete([
      { role: 'system', content: '你是 LoRA 训练方案助手。仅返回 JSON 对象，只允许 purpose(character、style 或 pose)、trigger(单行字符串)、steps(10..10000)、repeats(1..100)、rank(1..128)、learningRate(0.000001..0.01)、summary(简短说明)。不返回路径、命令、模型下载地址、标注格式或其他字段。不要声称已分析图片或保证显存与画质。用户没有指定触发词时可以保留空值。' },
      { role: 'user', content: JSON.stringify({ goal: input.goal, purpose: input.purpose, trigger: input.trigger, trainType: config.model_train_type || null, defaults: { steps: input.steps, repeats: input.repeats, rank: input.rank, learningRate: input.learningRate } }) },
    ], { moduleId: 'training', policy: 'chat-only', timeoutMs: 60000, signal });
    signal?.throwIfAborted();
    try { suggestion = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { throw new WorkbenchError(422, 'AI 没有返回有效方案 JSON；请重试或关闭 AI 辅助。'); }
    object(suggestion, 'AI 方案');
    fields(suggestion, ['purpose', 'trigger', 'steps', 'repeats', 'rank', 'learningRate', 'summary']);
  }
  const { summary, ...parameters } = suggestion;
  const normalized = pipelineInput({ ...input, ...parameters, ...(strategyVersion < 3 && input.cropMode === undefined ? { cropMode: 'auto' } : {}) });
  // summary belongs to presentation, never to executable configuration.
  return { purpose: normalized.purpose, trigger: normalized.trigger, steps: normalized.steps, repeats: normalized.repeats, rank: normalized.rank, learningRate: normalized.learningRate, aiUsed: input.aiEnabled, strategy: trainingStrategy(normalized, config, { version: strategyVersion }), summary: text(summary, { style: '画风训练方案', pose: '姿势训练方案', character: '角色训练方案' }[normalized.purpose], 1200, '方案说明') };
}
