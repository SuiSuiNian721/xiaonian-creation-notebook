import { expandedInputs } from './drawing-schema.mjs';

const link = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
const sampler = node => /Sampler/.test(node?.class_type || '') && !/Select$/.test(node.class_type);
const rewrite = node => /^(?:TextGenerateQwen35(?:MTP)?|QwenImage21_(?:EditPromptRewrite|PromptRewrite))$/.test(node?.class_type || '');
const primitiveText = node => /^PrimitiveString(?:Multiline)?$/.test(node?.class_type || '');
const primitiveNumber = node => /^Primitive(?:Int|Float)$/.test(node?.class_type || '');
const seedInput = name => /(?:^|[._])(?:noise_seed|seed)$/.test(name);
const describe = (label, description, section = 'advanced') => ({ label, description, section, seed: false });

const common = {
  steps: ['采样步数', '图像去噪的迭代次数；增加步数通常会延长生成时间。', 'sampling'],
  cfg: ['提示词引导', '控制图像采样对提示词条件的遵循强度。', 'sampling'],
  sampler_name: ['采样算法', '决定从随机噪声逐步生成图像的计算方法。', 'sampling'],
  scheduler: ['噪声调度', '决定采样过程中各步使用的噪声水平。', 'sampling'],
  denoise: ['重绘幅度', '控制对输入图像或潜空间内容的改动程度；数值越低通常保留越多原始内容。', 'sampling'],
  width: ['宽度', '图像或画布的宽度，单位为像素。', 'size'],
  height: ['高度', '图像或画布的高度，单位为像素。', 'size'],
  batch_size: ['生成张数', '本次潜空间批次包含的图像数量。', 'size'],
  resolution: ['参考图编码尺寸', '参考图送入编码器前使用的目标尺寸，实际长宽仍遵循节点的缩放规则。', 'size'],
  lora_name: ['LoRA 文件', '选择原工作流中使用的附加模型，可用于角色、动作或风格等用途。', 'lora'],
  strength_model: ['模型权重', '附加模型对图像生成的影响强度。', 'lora'],
  strength_clip: ['文本权重', '附加模型对文本编码的影响强度。', 'lora'],
  unet_name: ['绘图模型', '决定图像生成能力和基础风格的主模型。'],
  ckpt_name: ['基础模型', '工作流使用的模型检查点文件。'],
  clip_name: ['文本编码模型', '把提示词转为生成模型能够使用的条件。'],
  vae_name: ['图像编解码模型', '负责图像像素与潜空间表示之间的转换。'],
  weight_dtype: ['模型精度', '模型权重的计算精度，会影响显存使用和兼容性。'],
  device: ['运行设备', '选择此节点使用的计算设备。'],
  dtype: ['缓存精度', '控制缓存数据精度，影响内存占用和数值误差。'],
  filename_prefix: ['文件名前缀', '生成结果在绘图服务中保存时使用的名称前缀。'],
  bit_depth: ['保存位深', '保存图像时每个颜色通道使用的精度。'],
  input_color_space: ['输入色彩空间', '指定保存节点应如何解释输入图像的颜色数值。'],
  crf: ['压缩质量', '控制图像压缩强度；数值越低通常保留更多细节。'],
  max_length: ['改写长度上限', '限制改写模型最多生成的词元数量。'],
  temperature: ['改写随机程度', '控制改写模型选词的随机程度；数值越高，措辞通常越多样。'],
  top_k: ['改写候选词数', '限制每次选词保留的高概率候选数量。'],
  top_p: ['改写累计概率', '保留累计概率达到该阈值的一组候选词。'],
  min_p: ['改写最低概率', '过滤相对最高概率候选过于不可能的词。'],
  repetition_penalty: ['改写重复惩罚', '控制对重复词元的抑制强度。'],
  presence_penalty: ['改写已用词惩罚', '降低已经出现过的词元再次被选择的倾向。'],
  thinking: ['改写思考模式', '决定改写模型是否先进行思考；效果取决于模型及其训练方式。'],
  mtp: ['改写预测加速', '使用模型的多词预测能力加快改写；改变此设置也可能改变相同种子的改写结果。'],
  quant: ['改写模型量化', '选择改写模型的压缩精度，影响内存占用和输出表现。'],
  kv_cache: ['改写缓存精度', '选择改写过程中的上下文缓存精度。'],
  vision_on_cpu: ['处理器运行图像编码', '将改写模型的图像编码部分放到处理器，减少显存占用。'],
  unload_model: ['改写后释放模型', '改写完成后卸载模型，为后续图像生成释放内存或显存。'],
  use_default_template: ['使用默认改写模板', '使用改写模型随附的系统指令与对话模板。'],
  system_prompt: ['改写系统指令', '覆盖改写模型的系统指令；是否生效取决于模板设置。'],
};
const resolutionFields = {
  预设: ['尺寸预设', '选择常用画布尺寸，或使用自定义宽高。'],
  互换宽高: ['互换宽高', '交换尺寸节点输出的宽度和高度。'],
  随机模式: ['随机尺寸', '让尺寸节点随机选择预设尺寸；这个开关不控制图像采样种子。'],
  自定义宽: ['自定义宽度', '使用自定义预设且关闭随机尺寸时生效，单位为像素。'],
  自定义高: ['自定义高度', '使用自定义预设且关闭随机尺寸时生效，单位为像素。'],
  批次数量: ['尺寸节点张数', '仅影响尺寸节点直接输出的潜空间图像批次。'],
};

function basicPresentation(field, node) {
  const name = field.input.split('.').at(-1);
  if (field.image) return describe('参考图', '上传或选择这条图像输入使用的参考图片。', 'reference');
  if (node?.class_type === 'ZML_PresetResolutionV2' && resolutionFields[name]) return describe(...resolutionFields[name], 'size');
  if (node?.class_type === 'StringCompare') {
    if (['string_a', 'string_b'].includes(name)) return describe(field.value === '' ? '空文本判断值' : '比较文本', '供流程判断使用的比较文字；这里的空值用于检查改写结果是否为空。');
    if (name === 'mode') return describe('文本比较方式', '决定两段文字按相等、开头或结尾进行比较。');
    if (name === 'case_sensitive') return describe('比较时区分大小写', '决定文本比较是否把大写与小写字母视为不同。');
  }
  if (name === 'type' && node?.class_type === 'CLIPLoader') return describe('文本编码器类型', '选择与绘图模型相匹配的文本编码方式。');
  if (name === 'model' && /^LoadQwen/.test(node?.class_type || '')) return describe('提示词改写模型', '选择用于文生图或图生图提示词改写的模型。');
  if (name === 'backend') return describe('改写运行方式', '选择改写模型使用的推理后端。');
  if (name === 'preset') return describe('改写预设', '选择改写模型使用的指令模板和采样预设。');
  if (common[name]) return describe(...common[name]);
  if (name === 'switch') return describe('分支开关', '控制工作流此处分支使用开启或关闭路径。');
  return describe({ text: '文本参数', number: '数值参数', boolean: '开关参数', select: '选项参数' }[field.type] || '节点参数', '保留原工作流的节点参数；具体用途取决于该节点及其连接。');
}

function dependencyOrder(prompt) {
  const result = []; const seen = new Set();
  const visit = id => {
    if (seen.has(id) || !prompt[id]) return;
    seen.add(id);
    for (const value of Object.values(prompt[id].inputs || {})) if (link(value)) visit(value[0]);
    result.push(id);
  };
  for (const id of Object.keys(prompt)) visit(id);
  return result;
}

/** Presentation is additive: graph values, editable keys and constraints stay intact. */
export function enrichWorkflowFields(prompt, fields, info = {}) {
  const byKey = new Map(fields.map(field => [field.key, field]));
  const roles = new Map(); const seedRoles = new Map(); const visited = new Set(); const promptSwitches = new Set();
  const definitions = new Map(Object.entries(prompt).map(([id, node]) => [id, expandedInputs(info[node.class_type], node.inputs).definitions]));
  const mark = (map, key, role) => { const values = map.get(key) || new Set(); values.add(role); map.set(key, values); };

  // Follow only data paths with known semantics. A switch's boolean condition,
  // a string comparator and an unknown formatter are not prompt text paths.
  const walkInput = (id, name, role, mode) => {
    const value = prompt[id]?.inputs?.[name];
    if (link(value)) walkOutput(value[0], value[1], role, mode);
    else if (byKey.has(`${id}:${name}`)) {
      const field = byKey.get(`${id}:${name}`);
      if (mode === 'text' && field.type === 'text') mark(roles, field.key, role);
      if (mode === 'seed' && field.type === 'number') mark(seedRoles, field.key, role);
    }
  };
  const walkOutput = (id, slot, role, mode) => {
    const token = JSON.stringify([id, slot, role, mode]); if (visited.has(token)) return; visited.add(token);
    const node = prompt[id]; if (!node) return;
    if (node.class_type === 'ComfySwitchNode' && slot === 0) {
      if (mode === 'text') promptSwitches.add(id);
      for (const name of ['on_false', 'on_true']) walkInput(id, name, role, mode);
    } else if (mode === 'seed') {
      if (primitiveNumber(node) && slot === 0) walkInput(id, 'value', role, mode);
    } else if (primitiveText(node) && slot === 0) {
      walkInput(id, 'value', role, mode);
    } else if (rewrite(node) && slot === 0) {
      walkInput(id, 'prompt', role, mode);
    } else if (/^CLIPTextEncode/.test(node.class_type)) {
      for (const name of ['text', 'text_g', 'text_l']) if (Object.hasOwn(node.inputs, name)) walkInput(id, name, role, mode);
    } else if (node.class_type === 'TextEncodeQwenImage21' && slot < 2) {
      walkInput(id, slot === 0 ? 'prompt' : 'negative_prompt', role, mode);
    } else {
      const schema = info[node.class_type];
      const conditioning = [...(definitions.get(id) || [])].filter(([, entry]) => entry.spec[0] === 'CONDITIONING').map(([name]) => name);
      if (schema?.output?.[slot] !== 'CONDITIONING') return;
      const outputName = schema.output_name?.[slot];
      const inputs = conditioning.includes(outputName) ? [outputName] : schema.output.filter(type => type === 'CONDITIONING').length === 1 ? conditioning : [];
      for (const name of inputs) walkInput(id, name, role, mode);
    }
  };

  const order = dependencyOrder(prompt);
  const samplers = order.filter(id => sampler(prompt[id]));
  const rewriters = order.filter(id => rewrite(prompt[id]));
  const noiseConsumers = new Map();
  const traceNoise = (value, target, seen = new Set()) => {
    if (!link(value)) return;
    const [id, slot] = value; if (seen.has(id) || slot !== 0) return; seen.add(id);
    if (prompt[id]?.class_type === 'RandomNoise') mark(noiseConsumers, id, target);
    else if (prompt[id]?.class_type === 'ComfySwitchNode') for (const name of ['on_false', 'on_true']) traceNoise(prompt[id].inputs[name], target, seen);
  };
  for (const id of samplers) traceNoise(prompt[id].inputs.noise, id);
  for (const [id, node] of Object.entries(prompt)) {
    const schema = info[node.class_type];
    if (sampler(node) || /Guider$/.test(node.class_type) || schema?.output?.includes('GUIDER')) {
      for (const name of ['positive', 'negative']) if (Object.hasOwn(node.inputs, name)) walkInput(id, name, name, 'text');
      if (node.class_type === 'BasicGuider') walkInput(id, 'conditioning', 'positive', 'text');
    }
    for (const name of Object.keys(node.inputs)) if (seedInput(name)) {
      const purpose = sampler(node) || node.class_type === 'RandomNoise' ? 'sampling' : rewrite(node) ? 'rewrite' : 'other';
      for (const target of noiseConsumers.get(id) || [id]) walkInput(id, name, JSON.stringify([purpose, target]), 'seed');
    }
  }

  // Identify editable switches that choose between raw and rewritten versions
  // of the same source. Only these switches control rewrite-specific fields.
  const textBranch = (value, seen = new Set()) => {
    const result = { sources: new Set(), rewriters: new Set() };
    if (!link(value)) return result;
    const [id, slot] = value; const key = JSON.stringify(value);
    if (seen.has(key)) return result; seen.add(key);
    const node = prompt[id]; if (!node || slot !== 0) return result;
    const merge = other => { other.sources.forEach(item => result.sources.add(item)); other.rewriters.forEach(item => result.rewriters.add(item)); };
    if (primitiveText(node)) result.sources.add(`${id}:value`);
    else if (rewrite(node)) { result.rewriters.add(id); if (link(node.inputs.prompt)) merge(textBranch(node.inputs.prompt, seen)); else result.sources.add(`${id}:prompt`); }
    else if (node.class_type === 'ComfySwitchNode') for (const name of ['on_false', 'on_true']) merge(textBranch(node.inputs[name], seen));
    return result;
  };
  const rewriteControls = new Map(); const enabledWhen = new Map();
  const outputs = order.filter(id => info[prompt[id].class_type]?.output_node);
  const usedWithoutSwitch = (target, blocked) => {
    const pending = [...(outputs.length ? outputs : samplers)]; const seen = new Set();
    while (pending.length) {
      const id = pending.pop(); if (id === blocked || seen.has(id)) continue;
      if (id === target) return true;
      seen.add(id);
      for (const value of Object.values(prompt[id]?.inputs || {})) if (link(value)) pending.push(value[0]);
    }
    return false;
  };
  for (const id of promptSwitches) {
    const key = `${id}:switch`; if (byKey.get(key)?.type !== 'boolean') continue;
    const left = textBranch(prompt[id].inputs.on_false); const right = textBranch(prompt[id].inputs.on_true);
    if (!([...left.sources].some(source => right.sources.has(source))) || Boolean(left.rewriters.size) === Boolean(right.rewriters.size)) continue;
    const enabled = Boolean(right.rewriters.size); const branch = enabled ? right : left;
    rewriteControls.set(key, enabled);
    for (const target of branch.rewriters) {
      if (usedWithoutSwitch(target, id)) continue;
      const conditions = enabledWhen.get(target) || []; conditions.push({ key, equals: enabled }); enabledWhen.set(target, conditions);
    }
  }

  const result = fields.map(field => {
    const node = prompt[field.nodeId]; let presentation = basicPresentation(field, node);
    const promptRoles = roles.get(field.key);
    if (promptRoles?.size) {
      const shared = promptRoles.size > 1; const positive = promptRoles.has('positive');
      presentation = describe(shared ? '共用提示词' : positive ? '正向提示词' : '负向提示词', shared ? '这段文字同时进入正向与负向条件；修改会影响两条分支。' : positive ? '描述希望生成的主体、场景和细节；工作流可能先改写，再送入图像采样。' : '描述希望减少或避免的内容；是否生效及作用强弱取决于模型和引导设置。', 'prompts');
    }
    const seeds = [...(seedRoles.get(field.key) || [])].map(value => JSON.parse(value));
    if (seeds.length) {
      const purposes = new Set(seeds.map(([purpose]) => purpose)); const purpose = purposes.size === 1 ? seeds[0][0] : 'shared';
      const targets = new Set(seeds.map(([, id]) => id)); const target = seeds[0][1];
      const phases = purpose === 'sampling' ? samplers : rewriters;
      const suffix = targets.size === 1 && phases.length > 1 && phases.includes(target) ? `（阶段 ${phases.indexOf(target) + 1}）` : '';
      if (purpose === 'sampling') presentation = describe((targets.size > 1 ? '共用采样种子' : '采样种子') + suffix, '控制图像采样的随机噪声；保留它有助于复现构图与细节。', 'sampling');
      else if (purpose === 'rewrite') presentation = describe((targets.size > 1 ? '共用改写种子' : '提示词改写种子') + suffix, '控制提示词改写时的随机选词；相同输入、种子与改写设置有助于复现改写结果。', 'rewrite');
      else presentation = describe(purpose === 'shared' ? '共用随机种子' : '随机种子', purpose === 'shared' ? '同一个数值同时控制不同节点的随机过程。' : '控制此节点的随机过程；保留数值有助于复现结果。', 'advanced');
      presentation.seed = true;
      if (purpose === 'rewrite' && targets.size === 1 && enabledWhen.has(target)) presentation.enabledWhen = enabledWhen.get(target);
    }
    if (enabledWhen.has(field.nodeId)) presentation.enabledWhen = enabledWhen.get(field.nodeId);
    if (rewriteControls.has(field.key)) presentation = describe(rewriteControls.get(field.key) ? '提示词改写' : '使用原始提示词', rewriteControls.get(field.key) ? '开启后先改写提示词；关闭后使用原始文字。' : '开启后使用原始文字；关闭后使用改写结果。', 'rewrite');
    if (node?.class_type === 'ZML_PresetResolutionV2') {
      if (['自定义宽', '自定义高'].includes(field.input)) presentation.enabledWhen = [{ key: `${field.nodeId}:预设`, equals: '自定义' }, { key: `${field.nodeId}:随机模式`, equals: false }].filter(condition => byKey.has(condition.key));
      if (field.input === '批次数量' && !Object.values(prompt).some(item => Object.values(item.inputs || {}).some(value => link(value) && value[0] === field.nodeId && value[1] === 2))) {
        presentation.hidden = true;
        presentation.description = '尺寸节点的潜空间输出没有接入当前工作流，因此这个张数不影响生成结果。';
      }
    }
    return { ...field, presentation };
  });
  const generic = new Set(['文本参数', '数值参数', '开关参数', '选项参数', '节点参数']);
  const counts = new Map(); const indices = new Map();
  for (const { presentation } of result) if (generic.has(presentation.label)) counts.set(presentation.label, (counts.get(presentation.label) || 0) + 1);
  for (const { presentation } of result) if (counts.get(presentation.label) > 1) {
    const index = (indices.get(presentation.label) || 0) + 1; indices.set(presentation.label, index);
    presentation.label += ` ${index}`;
  }
  return result;
}
