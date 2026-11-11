import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { WorkbenchError, fields, object, text } from './contracts.mjs';
import { buildPipelinePlan, pipelineInput } from './training-plan.mjs';
import { cleanTrainingConfig } from './training-presets.mjs';
import { formDefaults } from './training-schema.mjs';
import { trainingStrategy } from './training-strategies.mjs';
import { trainingPath } from './training-runtime.mjs';
import { baseModelField,modelPathKeys } from '../public-workbench/training-types.js';
import {applyMemoryOptions} from '../public-workbench/training-memory-fields.js';
import {trainingDuration,normalizeTrainingDuration} from '../public-workbench/training-form-fields.js';
import {workflowPolicy} from './training-workflow-parameters.mjs';

const modelKeys = modelPathKeys;
const hostOwned = new Set(['model_train_type', 'model_type', 'lora_type', 'network_module', 'ui_custom_params', 'sample_prompts', 'network_weights', 'resume', 'random_crop', 'color_aug', 'enable_bucket', 'shuffle_caption', 'caption_dropout_rate', 'caption_tag_dropout_rate', 'caption_dropout_every_n_epochs', 'token_warmup_step', 'keep_tokens']);
const rates = new Set(['learning_rate', 'unet_lr', 'text_encoder_lr', 'lr']);
const bounds = { max_train_steps: [10, 10000], max_steps: [0, 10000], max_train_epochs: [1, 1000], num_epochs: [1, 1000], epochs: [0, 1000], network_dim: [1, 128], rank: [1, 128], network_alpha: [1, 128], alpha: [0.000001, 128], train_batch_size: [1, 64], gradient_accumulation_steps: [1, 128] };
const integers = new Set(['max_train_steps', 'max_steps', 'max_train_epochs', 'num_epochs', 'epochs', 'network_dim', 'rank', 'train_batch_size', 'gradient_accumulation_steps', 'blocks_to_swap']);
const blocked = field => hostOwned.has(field.key) || modelKeys.includes(field.key) || /(?:_dir|_path|_args|_args_custom)$/.test(field.key) || field.role === 'filepicker' || field.hidden || field.disabled;
const active = (field, config) => (field.conditions || []).every(condition => Object.is(config[condition.key], condition.value));

function editable(form, config) {
  const fields = form.sections.flatMap(section => section.fields).filter(field => !blocked(field) && active(field, config) && (['number', 'boolean'].includes(field.type) || field.options || rates.has(field.key)));
  // Native Kohya accepts this duration control even where its old UI schema
  // only exposes epochs. The host keeps the two duration modes exclusive.
  if (trainingDuration(form).kind==='choice'&&!fields.some(field => field.key === 'max_train_steps')) fields.push({ key: 'max_train_steps', type: 'number', min: 10, max: 10000, step: 1, conditions: [] });
  return fields;
}

export function assertQuickAI(sharedAI) {
  if (!sharedAI || sharedAI.config?.('training')?.enabled !== true) throw new WorkbenchError(409, '一键训练必须连接 AI，请在右上角“AI 接入”保存并启用训练模块或全局连接。');
}

async function resolveConfiguration(service, input, raw, form) {
  if (trainingDuration(form).kind==='choice'&&raw.max_train_steps !== undefined && raw.max_train_epochs !== undefined) throw new WorkbenchError(422, '请只选择训练步数或轮数其中一种。');
  const config = formDefaults(form, { ...raw, ...workflowPolicy(form, { dataset: trainingStrategy(input, raw).dataset }) });
  if (trainingDuration(form).kind==='choice'&&raw.max_train_steps !== undefined && raw.max_train_epochs === undefined) delete config.max_train_epochs;
  const modelComponents = raw.model_train_type === 'moss-image-lora' ? ['text_encoder', 'vae', 'tokenizer_cache_dir'] : ['anima-lora', 'anima-finetune', 'sd3-lora'].includes(raw.model_train_type) ? ['qwen3', 'vae'] : raw.model_train_type.startsWith('flux') ? raw.model_type === 'chroma' ? ['ae', 't5xxl'] : ['ae', 'clip_l', 't5xxl'] : raw.model_train_type.startsWith('lumina') ? ['ae', 'gemma2'] : [];
  const required = [...new Set([...modelComponents, ...form.sections.flatMap(section => section.fields).filter(field => field.required && modelKeys.includes(field.key) && active(field, config)).map(field => field.key)])];
  const modelKey=baseModelField(raw.model_train_type,raw);
  if (!required.includes(modelKey)) required.unshift(modelKey);
  if (input.mode === 'tag') return config;
  const missing = required.filter(key => typeof raw[key] !== 'string' || !isAbsolute(raw[key]));
  if (missing.length && raw[modelKey]) {
    const saved = await service.savedConfigs();
    let environmentRoot;
    const localPath = value => typeof value === 'string' && value ? isAbsolute(value) ? resolve(value) : environmentRoot ? resolve(environmentRoot, value) : null : null;
    const target = trainingPath(raw[modelKey], '训练底模');
    const candidates = [...(service.listPresets?.().presets || []), ...(saved.configs || [])].filter(item => item.config?.model_train_type === raw.model_train_type);
    if (candidates.some(item => !isAbsolute(item.config[modelKey] || ''))) {
      try { environmentRoot = (await service.runtime.configuration(service.config())).environmentRoot; } catch { /* Exact absolute recipes remain usable. */ }
    }
    const matching = candidates.filter(item => localPath(item.config[modelKey])?.toLowerCase() === target.toLowerCase());
    for (const key of missing) {
      const paths = [...new Set(matching.map(item => localPath(item.config[key])).filter(Boolean))];
      if (paths.length === 1) config[key] = paths[0];
    }
  }
  const absent = [];
  for (const key of required) {
    if (typeof config[key] !== 'string' || !config[key].trim() || !isAbsolute(config[key])) { absent.push(key); continue; }
    const path = trainingPath(config[key], key);
    try { const info = await stat(path); if (!info.isFile() && !info.isDirectory()) absent.push(key); else config[key] = path; }
    catch { absent.push(key); }
  }
  if (absent.length) throw new WorkbenchError(422, `模型组件缺少或文件不存在：${absent.join('、')}。请从已有参数载入同一底模的组件，或在“模型组件”中补齐。`);
  return config;
}

function applyPatch(form, config, patch, mode) {
  object(patch, 'AI 参数建议');
  if (mode === 'defaults' && Object.keys(patch).length) throw new WorkbenchError(422, '已选择默认参数，AI 不能修改训练器默认数值。');
  const merged = { ...config, ...patch };
  const allowed = new Map(editable(form, merged).map(field => [field.key, field]));
  for (const [key, value] of Object.entries(patch)) {
    const field = allowed.get(key);
    if (!field) throw new WorkbenchError(422, `AI 不能修改参数 ${key}；模型路径、原始覆盖项和未定义参数由用户控制。`);
    if (rates.has(key)) {
      if (!['string', 'number'].includes(typeof value) || typeof value === 'string' && !/^[+]?\d*\.?\d+(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0.0000001 || Number(value) > 0.01) throw new WorkbenchError(422, `AI 学习率参数 ${key} 不在有效范围。`);
    } else if (field.options) {
      if (!field.options.includes(value)) throw new WorkbenchError(422, `AI 参数 ${key} 不在允许选项内。`);
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new WorkbenchError(422, `AI 参数 ${key} 必须是开关值。`);
    } else {
      const [minimum, maximum] = bounds[key] || [field.min ?? -Infinity, field.max ?? Infinity];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < Math.max(minimum, field.min ?? -Infinity) || value > Math.min(maximum, field.max ?? Infinity) || (integers.has(key) || field.step === 1) && !Number.isInteger(value)) throw new WorkbenchError(422, `AI 参数 ${key} 超过允许范围或类型不正确。`);
    }
  }
  if(trainingDuration(form).kind==='choice'){
    if (patch.max_train_steps !== undefined && patch.max_train_epochs !== undefined) throw new WorkbenchError(422, 'AI 必须只选择训练步数或轮数其中一种。');
    if (patch.max_train_steps !== undefined) delete merged.max_train_epochs;
    if (patch.max_train_epochs !== undefined) delete merged.max_train_steps;
  }
  if (patch.learning_rate !== undefined && patch.unet_lr === undefined && Object.hasOwn(merged, 'unet_lr')) merged.unet_lr = patch.learning_rate;
  return normalizeTrainingDuration(form,merged);
}

export async function buildQuickTrainingPlan(service, input, raw, { signal } = {}) {
  signal?.throwIfAborted();
  assertQuickAI(service.sharedAI);
  const { form } = await service.schema(raw.model_train_type);
  let config = await resolveConfiguration(service, input, raw, form);
  const fixedMemoryOptions=input.memoryOptions||{};
  try{config=applyMemoryOptions(form,config,fixedMemoryOptions);}catch(error){throw new WorkbenchError(422,error.message);}
  signal?.throwIfAborted();
  const options = editable(form, config).filter(field=>!Object.hasOwn(fixedMemoryOptions,field.key)).map(({ key, type, min, max, step, options, description }) => ({ key, type, min, max, step, options, description, current: config[key] }));
  const reply = await service.sharedAI.complete([
    { role: 'system', content: '你是 LoRA 训练参数规划器，只返回 JSON：{summary,configPatch,purpose?,trigger?,repeats?}。configPatch 只能包含 allowedParameters 中的参数，遵守范围与选项。不得返回路径、命令、模型模块或任意覆盖文本。parameterMode=defaults 时 configPatch 必须为空，不改变用途、触发词和重复次数；recommended 时按目标提出保守参数。遵守 duration 的原生参数语义：choice 只选轮数或步数，discriminator 同步对应模式，both 保留轮数和步数上限。没有显存数据时不要声称一定能运行或保证画质。不要声称已查看训练图片。' },
    { role: 'user', content: JSON.stringify({ goal: input.goal, purpose: input.purpose, trigger: input.trigger, parameterMode: input.parameterMode, modelType: config.model_train_type, model: config[baseModelField(config.model_train_type,config)] ? basename(config[baseModelField(config.model_train_type,config)]) : null, duration:trainingDuration(form), repeats:config.model_train_type==='moss-image-anima-lora'?null:input.repeats, fixedMemoryOptions, allowedParameters: options }) },
  ], { moduleId: 'training', policy: 'chat-only', timeoutMs: 90000, signal });
  signal?.throwIfAborted();
  let suggestion;
  try { suggestion = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new WorkbenchError(422, 'AI 没有返回有效训练参数 JSON，请检查接入后继续流程。'); }
  fields(suggestion, ['summary', 'configPatch', 'purpose', 'trigger', 'repeats'], 'AI 一键方案');
  if (input.parameterMode === 'defaults' && ['purpose', 'trigger', 'repeats'].some(key => suggestion[key] !== undefined && suggestion[key] !== input[key])) throw new WorkbenchError(422, '默认参数方案不能由 AI 改变既定用途和数据集设置。');
  object(suggestion.configPatch||{},'AI 参数建议');
  const patch=Object.fromEntries(Object.entries(suggestion.configPatch||{}).filter(([key])=>!Object.hasOwn(fixedMemoryOptions,key)));
  config = applyPatch(form, config, patch, input.parameterMode);
  const normalized = pipelineInput({ ...input, ...Object.fromEntries(['purpose', 'trigger', 'repeats'].filter(key => suggestion[key] !== undefined).map(key => [key, suggestion[key]])), aiEnabled: false });
  const plan = await buildPipelinePlan(normalized, null, config);
  plan.aiUsed = true; plan.parameterMode = input.parameterMode; plan.steps = config[trainingDuration(form).stepKey] || null;
  plan.rank = config.network_dim ?? config.rank ?? plan.rank; plan.learningRate = Number(config.learning_rate ?? config.lr ?? plan.learningRate);
  plan.summary = text(suggestion.summary || (input.parameterMode === 'defaults' ? 'AI 已采用训练器默认参数' : 'AI 推荐参数方案'), 'AI 方案说明', 1200);
  config = cleanTrainingConfig({ ...config, ...workflowPolicy(form,plan.strategy), ...fixedMemoryOptions });
  return { plan, config };
}
