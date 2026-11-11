import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFields } from '../framework/drawing-workflows.mjs';

// The active MOSS workflow's node IDs, inputs and links. Prompt text/model paths
// are reduced here because semantics must not depend on their contents.
const mossPrompt = () => ({
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'model.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'text.safetensors', type: 'moss_image', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'vae.safetensors' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: ['17', 0], clip: ['2', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '这段内容不决定正负用途', clip: ['2', 0] } },
  '6': { class_type: 'EmptyFlux2LatentImage', inputs: { batch_size: 1, width: ['10', 0], height: ['10', 1] } },
  '7': { class_type: 'KSampler', inputs: { seed: 20261020, steps: 25, cfg: 2.5, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'MOSS', images: ['8', 0] } },
  '10': { class_type: 'ZML_PresetResolutionV2', inputs: { 预设: '自定义', 互换宽高: false, 随机模式: false, 自定义宽: 1024, 自定义高: 1024, 批次数量: 1 } },
  '12': { class_type: 'PrimitiveStringMultiline', inputs: { value: '原始提示词' } },
  '13': { class_type: 'LoadQwenImage21PEMTP', inputs: { model: 't2i', backend: 'llama.cpp', 'backend.quant': 'Q4_K_M', 'backend.kv_cache': 'q8_0', 'backend.vision_on_cpu': true, 'backend.unload_model': true } },
  '14': { class_type: 'TextGenerateQwen35MTP', inputs: { preset: 'Qwen-Image 2.1 PE (t2i)', seed: 42, mtp: 'auto', clip: ['13', 0], prompt: ['12', 0], 'preset.max_length': 4096, 'preset.temperature': 1, 'preset.top_k': 20, 'preset.top_p': 0.95, 'preset.min_p': 0, 'preset.repetition_penalty': 1, 'preset.presence_penalty': 1.5, 'preset.thinking': true } },
  '15': { class_type: 'StringCompare', inputs: { string_b: '', mode: 'Equal', case_sensitive: true, string_a: ['14', 0] } },
  '16': { class_type: 'ComfySwitchNode', inputs: { switch: ['15', 0], on_false: ['14', 0], on_true: ['12', 0] } },
  '17': { class_type: 'ComfySwitchNode', inputs: { switch: true, on_false: ['12', 0], on_true: ['20', 0] } },
  '18': { class_type: 'PreviewAny', inputs: { source: ['17', 0] } },
  '20': { class_type: 'ComfySwitchNode', inputs: { switch: ['14', 5], on_false: ['12', 0], on_true: ['16', 0] } },
});

const outputs = { CLIPTextEncode: ['CONDITIONING'], ConditioningCombine: ['CONDITIONING'], ConditioningZeroOut: ['CONDITIONING'], KSampler: ['LATENT'], PrimitiveStringMultiline: ['STRING'], PrimitiveInt: ['INT'], TextGenerateQwen35MTP: ['STRING', 'STRING', 'STRING', 'STRING', 'STRING', 'BOOLEAN'], TextEncodeQwenImage21: ['CONDITIONING', 'CONDITIONING', 'LATENT'] };
function schemaFor(prompt) {
  const info = {};
  for (const node of Object.values(prompt)) {
    const schema = info[node.class_type] ||= { input: { required: {} }, output: outputs[node.class_type] || [] };
    for (const [input, value] of Object.entries(node.inputs)) {
      const type = input === 'switch' ? 'BOOLEAN' : input === 'seed' ? 'INT' : ['positive', 'negative', 'conditioning', 'conditioning_1', 'conditioning_2'].includes(input) ? 'CONDITIONING' : Array.isArray(value) ? schema.input.required[input]?.[0] || '*' : typeof value === 'number' ? 'INT' : typeof value === 'boolean' ? 'BOOLEAN' : 'STRING';
      schema.input.required[input] = [type];
    }
  }
  return info;
}
const fieldsFor = prompt => new Map(workflowFields(prompt, schemaFor(prompt)).map(field => [field.key, field]));

test('真实 MOSS 路径从改写和开关回溯正向提示词，负向与内部比较文字分开', () => {
  const fields = fieldsFor(mossPrompt());
  assert.equal(fields.get('12:value').presentation?.label, '正向提示词');
  assert.equal(fields.get('12:value').presentation?.section, 'prompts');
  assert.equal(fields.get('5:text').presentation?.label, '负向提示词');
  assert.equal(fields.get('15:string_b').presentation?.section, 'advanced');
  assert.equal(fields.get('15:string_b').presentation?.label, '空文本判断值');
  assert.equal(fields.get('17:switch').presentation?.label, '提示词改写');
  assert.equal(fields.get('17:switch').presentation?.section, 'rewrite');
});

test('种子明确区分图像采样与提示词改写，并保留原始参数', () => {
  const prompt = mossPrompt(); const before = structuredClone(prompt); const fields = fieldsFor(prompt);
  assert.deepEqual(fields.get('7:seed').presentation, { label: '采样种子', description: '控制图像采样的随机噪声；保留它有助于复现构图与细节。', section: 'sampling', seed: true });
  assert.equal(fields.get('14:seed').presentation?.label, '提示词改写种子');
  assert.equal(fields.get('14:seed').presentation?.section, 'rewrite');
  assert.equal(fields.get('14:seed').presentation?.seed, true);
  assert.deepEqual(prompt, before);
});

test('正负角色以连接为准，交换连线即交换标签，共用文字明确标注', () => {
  const prompt = mossPrompt(); [prompt['7'].inputs.positive, prompt['7'].inputs.negative] = [prompt['7'].inputs.negative, prompt['7'].inputs.positive];
  prompt['5']._meta = { title: '负向提示词' };
  let fields = fieldsFor(prompt);
  assert.equal(fields.get('5:text').presentation?.label, '正向提示词');
  assert.equal(fields.get('12:value').presentation?.label, '负向提示词');
  prompt['7'].inputs.negative = prompt['7'].inputs.positive;
  fields = fieldsFor(prompt);
  assert.equal(fields.get('5:text').presentation?.label, '共用提示词');
});

test('条件合并沿 CONDITIONING 连接回溯，不把未知文字变换的任意文本当提示词', () => {
  const prompt = mossPrompt();
  prompt['30'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['4', 0], conditioning_2: ['31', 0] } };
  prompt['31'] = { class_type: 'CLIPTextEncode', inputs: { text: '第二组文字', clip: ['2', 0] } };
  prompt['7'].inputs.positive = ['30', 0];
  let fields = fieldsFor(prompt);
  assert.equal(fields.get('31:text').presentation?.label, '正向提示词');
  assert.equal(fields.get('12:value').presentation?.label, '正向提示词');
  prompt['32'] = { class_type: 'UnknownFormatter', inputs: { text: 'positive prompt' } };
  prompt['31'].inputs.text = ['32', 0];
  fields = fieldsFor(prompt);
  assert.equal(fields.get('32:text').presentation?.section, 'advanced');
  assert.equal(fields.get('32:text').presentation?.label, '文本参数');
});

test('同一双输出编码节点的正负文字按输出槽位识别', () => {
  const prompt = { a: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '正向', negative_prompt: '负向' } }, b: { class_type: 'KSampler', inputs: { positive: ['a', 0], negative: ['a', 1], seed: 1 } } };
  const fields = fieldsFor(prompt);
  assert.equal(fields.get('a:prompt').presentation?.label, '正向提示词');
  assert.equal(fields.get('a:negative_prompt').presentation?.label, '负向提示词');
});

test('种子连到数字基础节点时识别真实可编辑来源，多采样按依赖顺序区分阶段', () => {
  const prompt = {
    '3': { class_type: 'KSampler', inputs: { seed: 3, latent_image: ['90', 0] } },
    '80': { class_type: 'PrimitiveInt', inputs: { value: 80 } },
    '81': { class_type: 'ComfySwitchNode', inputs: { switch: true, on_false: ['80', 0], on_true: ['80', 0] } },
    '90': { class_type: 'KSampler', inputs: { seed: ['81', 0] } },
  };
  const fields = fieldsFor(prompt);
  assert.equal(fields.get('80:value').presentation?.seed, true);
  assert.equal(fields.get('80:value').presentation?.label, '采样种子（阶段 1）');
  assert.equal(fields.get('3:seed').presentation?.label, '采样种子（阶段 2）');
  assert.equal(fields.get('81:switch').presentation?.seed, false);
});

test('MOSS 常用尺寸及高级改写参数都有中文用途说明，未知字段保留为高级参数', () => {
  const prompt = mossPrompt(); const fields = fieldsFor(prompt);
  for (const input of ['预设', '互换宽高', '随机模式', '自定义宽', '自定义高', '批次数量']) assert.equal(fields.get(`10:${input}`).presentation?.section, 'size');
  for (const field of fields.values()) {
    assert.match(field.presentation?.label || '', /[\u4e00-\u9fff]/);
    assert.match(field.presentation?.description || '', /[\u4e00-\u9fff]/);
    assert.equal(field.presentation?.description.includes(field.group + '.' + field.input), false);
  }
  assert.equal(fields.get('14:preset.temperature').presentation?.label, '改写随机程度');
  assert.equal(fields.get('13:backend.vision_on_cpu').presentation?.label, '处理器运行图像编码');
  assert.equal(fields.get('14:preset.thinking').presentation?.label, '改写思考模式');
});

test('改写开关和尺寸条件以字段键表达，未接入的尺寸节点张数隐藏但保留', () => {
  const prompt = mossPrompt(); let fields = fieldsFor(prompt);
  assert.deepEqual(fields.get('14:seed').presentation?.enabledWhen, [{ key: '17:switch', equals: true }]);
  assert.deepEqual(fields.get('14:preset.temperature').presentation?.enabledWhen, [{ key: '17:switch', equals: true }]);
  assert.deepEqual(fields.get('10:自定义宽').presentation?.enabledWhen, [{ key: '10:预设', equals: '自定义' }, { key: '10:随机模式', equals: false }]);
  assert.equal(fields.get('10:批次数量').presentation?.hidden, true);
  assert.equal(fields.get('10:批次数量').value, 1);
  assert.notEqual(fields.get('6:batch_size').presentation?.hidden, true);
  prompt['7'].inputs.latent_image = ['10', 2]; fields = fieldsFor(prompt);
  assert.notEqual(fields.get('10:批次数量').presentation?.hidden, true);
});

test('改写还有独立使用路径时，不用某一条分支开关禁用全部改写种子', () => {
  const prompt = mossPrompt();
  prompt['21'] = { class_type: 'CLIPTextEncode', inputs: { text: ['14', 0], clip: ['2', 0] } };
  prompt['7'].inputs.negative = ['21', 0];
  const fields = fieldsFor(prompt);
  assert.equal(fields.get('14:seed').presentation?.enabledWhen, undefined);
});

test('倒置改写开关以开启实际用途命名，保持原始布尔值', () => {
  const prompt = mossPrompt();
  [prompt['17'].inputs.on_false, prompt['17'].inputs.on_true] = [prompt['17'].inputs.on_true, prompt['17'].inputs.on_false];
  const fields = fieldsFor(prompt);
  assert.equal(fields.get('17:switch').presentation?.label, '使用原始提示词');
  assert.equal(fields.get('17:switch').value, true);
  assert.deepEqual(fields.get('14:seed').presentation?.enabledWhen, [{ key: '17:switch', equals: false }]);
});

test('多个随机噪声节点沿下游采样器区分阶段，同一基础种子共享时不会误禁用', () => {
  const prompt = {
    '2': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['20', 0], latent_image: ['90', 0] } },
    '10': { class_type: 'RandomNoise', inputs: { noise_seed: 10 } },
    '20': { class_type: 'RandomNoise', inputs: { noise_seed: 20 } },
    '90': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['10', 0] } },
  };
  let fields = fieldsFor(prompt);
  assert.equal(fields.get('10:noise_seed').presentation?.label, '采样种子（阶段 1）');
  assert.equal(fields.get('20:noise_seed').presentation?.label, '采样种子（阶段 2）');
  const shared = mossPrompt(); shared['80'] = { class_type: 'PrimitiveInt', inputs: { value: 42 } };
  shared['7'].inputs.seed = ['80', 0]; shared['14'].inputs.seed = ['80', 0]; fields = fieldsFor(shared);
  assert.equal(fields.get('80:value').presentation?.label, '共用随机种子');
  assert.equal(fields.get('80:value').presentation?.enabledWhen, undefined);
});

test('未知高级字段用稳定的中文编号区分，保留所有值且不猜提示词用途', () => {
  const prompt = { '1': { class_type: 'UnknownNode', inputs: { foo: 1, bar: 2, text: 'negative prompt', another_text: 'positive prompt' } } };
  const fields = [...fieldsFor(prompt).values()];
  assert.equal(new Set(fields.map(field => field.presentation?.label)).size, 4);
  assert.ok(fields.every(field => field.presentation?.section === 'advanced' && field.presentation?.hidden !== true));
});
