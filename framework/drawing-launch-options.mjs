import { WorkbenchError, fields, text } from './contracts.mjs';

const choice = (value, label, flags = [], extra = {}) => ({ value, label, flags, ...extra });
const automatic = choice('auto', '自动选择（推荐）');
const triState = (on, off, onLabel = '开启', offLabel = '关闭') => [automatic, choice('on', onLabel, [on]), choice('off', offLabel, [off])];
const precisionLabels = { fp32: '完整精度（FP32，较占显存）', fp16: '半精度（FP16，较省显存）', bf16: '半精度（BF16，需设备支持）', fp64: '更高精度（FP64，显存开销很大）', fp8_e4m3fn: '8 位精度（FP8 E4M3，更省显存）', fp8_e5m2: '8 位精度（FP8 E5M2，更省显存）', fp8_e8m0fnu: '8 位精度（FP8 E8M0，更省显存）' };
const precisions = (component, values) => [automatic, ...values.map(value => choice(value, precisionLabels[value] || value.toUpperCase(), [`--${value}-${component}`]))];
const fastLabels = { fp16_accumulation: '用较低精度换速度（FP16）', fp8_matrix_mult: '尝试 8 位计算提速（FP8）', cublas_ops: '尝试其他计算方法（cuBLAS）', autotune: '自动调优（首次运行可能更慢）' };

// Defaults, validation, capability gates and the UI schema all use these definitions.
const definitions = [
  { key: 'pythonPath', label: '启动程序位置', group: '启动程序', type: 'text', default: '', legacy: true,
    effect: '留空会自动选择，通常不需要填写。', help: '这里指定用于启动 ComfyUI 的 Python 可执行文件。留空会使用本体对应的 Python；更换程序也会更换依赖环境。' },
  { key: 'device', label: '用什么来出图', group: '计算设备与省显存', type: 'select', default: 'auto', choices: [automatic, choice('cpu', '用 CPU（很慢）', ['--cpu']), choice('cuda', '用 NVIDIA 显卡（CUDA）', ['--cuda-device'], { cuda: true })], build: settings => settings.device === 'cuda' ? ['--cuda-device', String(settings.cudaDevice)] : settings.device === 'cpu' && settings.vramMode !== 'cpu' ? ['--cpu'] : [],
    effect: '显卡通常更快；CPU 适合没有可用显卡时使用。', help: '自动选择会交给 ComfyUI 决定。显卡选项使用 NVIDIA CUDA，需要当前 Python 中的 PyTorch 支持；CPU 模式将计算放到处理器上。' },
  { key: 'cudaDevice', label: '使用哪张显卡', group: '计算设备与省显存', type: 'number', default: 0, min: 0, max: 1023, step: 1, integer: true, flags: ['--cuda-device'], when: { key: 'device', values: ['cuda'] },
    effect: '只有多张 NVIDIA 显卡时才需要修改。', help: 'CUDA 设备编号从 0 开始。检查环境后会显示检测到的显卡名称；单张显卡一般使用 0。' },
  { key: 'vramMode', label: '省显存程度', group: '计算设备与省显存', type: 'select', default: 'auto', legacy: true, choices: [automatic, choice('lowvram', '更省显存（可能变慢）', ['--lowvram']), choice('novram', '尽量省显存（通常更慢）', ['--novram']), choice('highvram', '尽量保留模型（更占显存）', ['--highvram']), choice('gpu-only', '全部放显卡（需要大显存）', ['--gpu-only'], { advanced: true }), choice('cpu', '全部用 CPU（很慢）', ['--cpu'])],
    effect: '更省显存通常会更慢，显存够用时保持自动。', help: '低显存与极低显存对应 --lowvram、--novram。部分新版 ComfyUI 开启“按需占用显存”后，低显存模式不会再额外起效。全部放显卡对应 GPU-only，需要足够显存；CPU 项保留旧设置兼容。' },
  { key: 'reserveVram', label: '给其他程序留显存（GiB）', group: '计算设备与省显存', type: 'number', default: null, min: 0, max: 64, step: 0.25, nullable: true, legacy: true, flags: ['--reserve-vram'],
    effect: '留得越多，ComfyUI 能用的显存越少。', help: '为系统和其他软件预留显存。留空使用 ComfyUI 默认预留量；较大的预留量可能让模型更频繁地搬到内存中。' },
  { key: 'dynamicVram', label: '按需占用显存', group: '计算设备与省显存', type: 'select', default: 'auto', choices: triState('--enable-dynamic-vram', '--disable-dynamic-vram', '开启（按需装入）', '关闭（使用原有策略）'),
    effect: '根据需要装入模型，减少不必要的显存占用。', help: '对应 Dynamic VRAM。关闭后使用基于估算的模型加载策略；自动跟随当前 ComfyUI 默认。它不控制显卡驱动的共享显存。' },
  { key: 'smartMemory', label: '显存够时保留模型', group: '计算设备与省显存', type: 'boolean', default: true, flags: ['--disable-smart-memory'], flagValue: false,
    effect: '减少模型来回搬运，重复出图可能更快。', help: '这是智能显存管理。关闭后会更主动地把模型放回系统内存，可能降低速度；它不控制驱动层的共享显存。' },
  { key: 'attention', label: '省显存的计算方案', group: '计算加速与黑图排查', type: 'select', default: 'auto', choices: [automatic, choice('xformers', '尝试加速、省显存（xFormers）', [], { guardFlags: ['--disable-xformers'], module: 'xformers' }), choice('pytorch', '内置计算方案（PyTorch）', ['--use-pytorch-cross-attention', '--disable-xformers']), choice('split', '分块计算（Split，降低显存需求）', ['--use-split-cross-attention', '--disable-xformers']), choice('quad', '分块计算（Quad）', ['--use-quad-cross-attention', '--disable-xformers']), choice('sage', '尝试更快计算（SageAttention）', ['--use-sage-attention', '--disable-xformers'], { module: 'sageattention' }), choice('flash', '尝试加速、省显存（FlashAttention）', ['--use-flash-attention', '--disable-xformers'], { module: 'flash_attn' }), choice('ck', '实验计算方案（Comfy Kitchen）', ['--use-ck-attention', '--disable-xformers'], { module: 'comfy_kitchen' })],
    effect: '用不同的计算方法，平衡出图速度与显存占用。', help: '这里选择交叉注意力算法。xFormers 使用 ComfyUI 原生自动尝试机制；依赖存在不代表与当前 GPU、PyTorch 或模型兼容，各方案也不保证一定更快。' },
  { key: 'attentionUpcast', label: '提高精度排查黑图', group: '计算加速与黑图排查', type: 'select', default: 'auto', choices: triState('--force-upcast-attention', '--dont-upcast-attention', '强制提高（排查黑图）', '禁止提高（仅排错）'),
    effect: '可能改善黑图或计算异常，但会增加开销。', help: '对应注意力计算的 upcasting。强制使用较高精度可尝试缓解数值溢出；禁止提高主要用于调试，正常使用建议自动。' },
  { key: 'unetPrecision', label: '绘图模型精度', group: '精度与显存占用', type: 'select', default: 'auto', choices: precisions('unet', ['fp32', 'fp16', 'bf16', 'fp64', 'fp8_e4m3fn', 'fp8_e5m2', 'fp8_e8m0fnu']),
    effect: '较低精度通常更省显存，但可能改变出图结果。', help: '对应 UNet / 扩散模型计算精度。不同精度需要模型和设备支持；数值精度更高不等于画面一定更好，通常保持自动。' },
  { key: 'vaePrecision', label: '图片转换精度', group: '精度与显存占用', type: 'select', default: 'auto', choices: precisions('vae', ['fp32', 'fp16', 'bf16']),
    effect: '影响图片编码、解码；精度不兼容可能出现黑图。', help: '对应 VAE 精度。出现黑图或颜色异常时，可恢复自动或尝试 FP32；具体效果取决于使用的 VAE。' },
  { key: 'textEncoderPrecision', label: '提示词理解精度', group: '精度与显存占用', type: 'select', default: 'auto', choices: precisions('text-enc', ['fp32', 'fp16', 'bf16', 'fp8_e4m3fn', 'fp8_e5m2']),
    effect: '较低精度通常更省显存，也可能改变提示词效果。', help: '对应 CLIP 等文本编码器精度，不会修改提示词原文。压低精度可能改变编码结果，不保证提升速度。' },
  { key: 'cpuVae', label: '用 CPU 处理图片', group: '精度与显存占用', type: 'boolean', default: false, legacy: true, flags: ['--cpu-vae'],
    effect: '降低图片转换时的显存占用，但这一步会变慢。', help: '把 VAE 的图片编码和解码放到 CPU，可能增加系统内存占用；其他绘图计算仍按所选设备运行。' },
  { key: 'cacheMode', label: '复用上次的计算结果', group: '重复出图与内存占用', type: 'select', default: 'auto', choices: [automatic, choice('classic', '保留可复用结果（经典方案）', ['--cache-classic']), choice('lru', '只留最近结果（限制数量）', ['--cache-lru']), choice('none', '每次重新计算（更省缓存内存）', ['--cache-none']), choice('ram', '按剩余内存清理缓存', ['--cache-ram']), choice('high-ram', '多用内存保留结果', ['--high-ram'])], build: settings => settings.cacheMode === 'lru' ? ['--cache-lru', String(settings.cacheLruCount)] : settings.cacheMode === 'ram' ? ['--cache-ram', ...[settings.cacheRamActive, settings.cacheRamInactive].filter(value => value !== null).map(String)] : null,
    effect: '少重复计算可以加快出图，但会占用内存或显存。', help: '缓存的是节点计算结果。最近结果对应 LRU，按剩余内存清理对应 RAM pressure caching；修改相关参数后，失效的节点仍会重新计算。' },
  { key: 'cacheLruCount', label: '最多保留多少份结果', group: '重复出图与内存占用', type: 'number', default: 16, min: 1, max: 100000, step: 1, integer: true, flags: ['--cache-lru'], when: { key: 'cacheMode', values: ['lru'] },
    effect: '保留越多，越容易复用，也会占更多内存。', help: '这是 LRU 缓存允许保留的节点结果数，不是最终图片张数；仅在“只留最近结果”模式下使用。' },
  { key: 'cacheRamActive', label: '计算时预留内存（GiB）', group: '重复出图与内存占用', type: 'number', default: null, min: 0, max: 1048576, step: 0.25, nullable: true, flags: ['--cache-ram'], when: { key: 'cacheMode', values: ['ram'] },
    effect: '可用内存低于这个值时，会更主动清理缓存。', help: '对应 active-cache 内存余量门槛；这是触发清理的目标，不是硬性隔离的内存。留空使用当前 ComfyUI 默认。' },
  { key: 'cacheRamInactive', label: '旧缓存清理门槛（GiB）', group: '重复出图与内存占用', type: 'number', default: null, min: 0, max: 1048576, step: 0.25, nullable: true, flags: ['--cache-ram'], when: { key: 'cacheMode', values: ['ram'] },
    effect: '门槛越高，越早清理暂时用不到的缓存。', help: '对应 inactive-cache / pinned memory 的内存余量门槛，须不小于“计算时预留内存”。留空使用当前 ComfyUI 默认。' },
  { key: 'asyncOffload', label: '边计算边搬运模型', group: '重复出图与内存占用', type: 'select', default: 'auto', choices: triState('--async-offload', '--disable-async-offload', '开启（尝试减少等待）', '关闭（排查兼容问题）'), build: settings => settings.asyncOffload === 'on' ? ['--async-offload', String(settings.asyncOffloadStreams)] : null,
    effect: '尝试减少等待时间，但可能多占一些内存。', help: '对应异步模型权重卸载。能否受益取决于设备、驱动和模型；自动选择跟随当前 ComfyUI 默认。' },
  { key: 'asyncOffloadStreams', label: '同时搬运的通道数', group: '重复出图与内存占用', type: 'number', default: 2, min: 1, max: 64, step: 1, integer: true, flags: ['--async-offload'], when: { key: 'asyncOffload', values: ['on'] },
    effect: '通道更多不一定更快，也可能增加内存开销。', help: '对应异步卸载的 CUDA streams 数量，只在启用“边计算边搬运模型”时使用。默认 2，通常不需要增大。' },
  { key: 'cudaMalloc', label: '尝试改善显存不足报错', group: '兼容性与结果复现', type: 'select', default: 'auto', choices: triState('--cuda-malloc', '--disable-cuda-malloc', '开启（尝试改善分配）', '关闭（排查兼容问题）'),
    effect: '显存还有余量却报不足时，可以尝试这个方案。', help: '对应 cudaMallocAsync 异步显存分配器，可能减少显存碎片。它不会增加显存容量，也不控制共享显存；较新 PyTorch 通常已由 ComfyUI 自动处理。' },
  { key: 'channelsLast', label: '尝试加快部分模型', group: '兼容性与结果复现', type: 'boolean', default: false, flags: ['--force-channels-last'],
    effect: '部分模型可能更快，也可能没有改善或出现报错。', help: '对应 Channels Last 内存布局。主要改变模型数据排列方式，不改变图片尺寸；是否提速取决于模型与设备。' },
  { key: 'deterministic', label: '尽量复现相同结果', group: '兼容性与结果复现', type: 'boolean', default: false, flags: ['--deterministic'],
    effect: '固定种子时更容易重复结果，但出图可能变慢。', help: '使用可用的确定性算法，仍不保证所有工作流、不同设备或不同软件版本生成完全一致的图像。' },
  { key: 'disablePinnedMemory', label: '关闭快速内存传输', group: '兼容性与结果复现', type: 'boolean', default: false, flags: ['--disable-pinned-memory'],
    effect: '排查内存传输异常时可尝试，速度可能下降。', help: '启用此项会禁用 pinned memory（锁页内存），可能影响 CPU 与显卡之间的传输速度；没有相关问题时保持默认。' },
  { key: 'mmapTorchFiles', label: '旧格式模型按需读取', group: '兼容性与结果复现', type: 'boolean', default: false, flags: ['--mmap-torch-files'],
    effect: '可能降低加载时的内存占用，也可能增加读盘等待。', help: '对 ckpt / pt 等 PyTorch 模型文件启用 mmap，按需读取文件内容；不改变 safetensors 的读取选项。' },
  { key: 'disableMmap', label: '直接读入模型（排查读盘问题）', group: '兼容性与结果复现', type: 'boolean', default: false, flags: ['--disable-mmap'],
    effect: '可尝试解决部分读盘问题，但可能占更多内存。', help: '对 safetensors 禁用 mmap，改为直接读入张量数据；不改变 ckpt / pt 的读取选项。' },
  { key: 'previewMethod', label: '生成过程怎么预览', group: '过程预览与插件排查', type: 'select', default: 'auto', legacy: true, always: true, choices: ['none', 'auto', 'latent2rgb', 'taesd'].map(value => choice(value, { none: '不预览（省开销）', auto: '快速预览（推荐）', latent2rgb: '快速粗略预览', taesd: '更清晰的预览（需预览模型）' }[value], ['--preview-method'])), build: settings => ['--preview-method', settings.previewMethod],
    effect: '只影响中途看到的预览图，不改变最终成图。', help: '快速粗略预览对应 Latent2RGB，更清晰的预览对应 TAESD。TAESD 需要相应预览模型，可能增加额外开销。' },
  { key: 'previewSize', label: '过程预览大小（像素）', group: '过程预览与插件排查', type: 'number', default: 512, min: 64, max: 4096, step: 1, integer: true, flags: ['--preview-size'],
    effect: '数值越大预览越清楚，但不改变最终图片尺寸。', help: '限制采样器过程预览的最大尺寸。更大的预览可能增加开销；成图宽高仍由工作流中的参数决定。' },
  { key: 'disableCustomNodes', label: '停用插件节点（排查报错）', group: '过程预览与插件排查', type: 'boolean', default: false, legacy: true, flags: ['--disable-all-custom-nodes'],
    effect: '只加载内置节点；依赖插件的工作流将无法运行。', help: '下一次启动时禁用全部自定义节点，用于定位插件问题。关闭此项并重新启动即可恢复插件节点加载。' },
  { key: 'fastMode', label: '激进提速（实验功能）', group: '激进提速', type: 'select', default: 'off', choices: [choice('off', '关闭（默认）'), choice('all', '尝试全部提速项', ['--fast']), choice('custom', '自行选择提速项', ['--fast'])], build: settings => settings.fastMode === 'custom' ? ['--fast', ...settings.fastFeatures] : null,
    effect: '可能加快出图，也可能损失画质或导致报错。', help: '对应 ComfyUI 的 --fast 实验优化，可能改变数值结果，且需要相应设备与 PyTorch 支持。画面异常或启动报错时可先关闭。' },
  { key: 'fastFeatures', label: '选择实验提速项目', group: '激进提速', type: 'multiselect', default: [], choices: Object.entries(fastLabels).map(([value, label]) => choice(value, label, ['--fast'])), when: { key: 'fastMode', values: ['custom'] },
    effect: '只启用勾选的项目，出图异常时可逐项关闭。', help: 'FP16 累加、FP8 矩阵乘法可能以精度换速度；cuBLAS 使用相应矩阵运算；自动调优会尝试优化运行配置。各项都不保证提速或兼容所有工作流。' },
];

export const RUNTIME_DEFAULTS = Object.freeze(Object.fromEntries(definitions.map(field => [field.key, Array.isArray(field.default) ? Object.freeze([...field.default]) : field.default])));
export const runtimeDefaults = () => structuredClone(RUNTIME_DEFAULTS);

function optionDefinitions(capabilities, savedFeatures = []) {
  const discovered = Array.isArray(capabilities?.cli?.fastFeatures) ? capabilities.cli.fastFeatures : [];
  const saved = Array.isArray(savedFeatures) ? savedFeatures : [];
  // Keep saved selections readable for recovery; command construction still checks the current CLI enum.
  const features = [...new Set([...Object.keys(fastLabels), ...discovered, ...saved].filter(value => typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value)))];
  return definitions.map(field => field.key === 'fastFeatures' ? { ...field, choices: features.map(value => choice(value, fastLabels[value] || value, ['--fast'])) } : field);
}

export function validateLaunchSettings(value, previous = RUNTIME_DEFAULTS, { validatePath, capabilities } = {}) {
  const schema = optionDefinitions(capabilities, previous?.fastFeatures); const allowed = schema.map(field => field.key);
  fields(value, allowed, '运行设置'); fields(previous, allowed, '已保存的运行设置');
  const result = { ...runtimeDefaults(), ...previous, ...value };
  for (const field of schema) {
    let current = result[field.key];
    if (field.type === 'text') { current = text(current, field.label, 4096, { empty: true }); if (current && validatePath) current = validatePath(current, field.label); }
    if (field.type === 'boolean' && typeof current !== 'boolean') throw new WorkbenchError(400, `${field.label}须为布尔值。`);
    if (field.type === 'select' && !field.choices.some(option => option.value === current)) throw new WorkbenchError(400, `${field.label}无效。`);
    if (field.type === 'multiselect') {
      if (!Array.isArray(current) || current.length > field.choices.length || new Set(current).size !== current.length || current.some(item => !field.choices.some(option => option.value === item))) throw new WorkbenchError(400, `${field.label}须为不重复的有效选项数组。`);
      current = [...current];
    }
    if (field.type === 'number') {
      if (field.nullable && current === '') current = null;
      if (!(field.nullable && current === null) && (typeof current !== 'number' || !Number.isFinite(current) || current < field.min || current > field.max || field.integer && !Number.isInteger(current))) throw new WorkbenchError(400, `${field.label}须为${field.nullable ? '空或 ' : ''}${field.min}–${field.max} 的${field.integer ? '整数' : '数值'}。`);
    }
    result[field.key] = current;
  }
  if (result.device === 'cuda' && result.vramMode === 'cpu' || result.device === 'cpu' && !['auto', 'cpu'].includes(result.vramMode)) throw new WorkbenchError(400, '设备选择不一致：请将“省显存程度”改回自动，或两处都选择 CPU。');
  if (result.vramMode === 'gpu-only' && result.cpuVae) throw new WorkbenchError(400, '“全部放显卡”不能同时使用“用 CPU 处理图片”，请改为自动模式或关闭 CPU 处理。');
  if (result.fastMode === 'custom' && !result.fastFeatures.length) throw new WorkbenchError(400, '请至少勾选一个提速项目，或将“激进提速”设为关闭。');
  if (result.cacheMode === 'ram' && result.cacheRamInactive !== null && (result.cacheRamActive === null || result.cacheRamInactive < result.cacheRamActive)) throw new WorkbenchError(400, '“旧缓存清理门槛”不能低于“计算时预留内存”，且需要先填写后者。');
  return result;
}

function availability(field, selected, capabilities) {
  if (field.legacy && !selected?.advanced || field.type === 'select' && selected?.value === field.default) return null;
  if (capabilities?.status !== 'current') return capabilities?.reason || '请先执行环境诊断，核实当前 ComfyUI 的启动参数。';
  if (capabilities.torch?.error && !capabilities.torch?.version) return `当前 Python 的 PyTorch 不可用：${capabilities.torch.error}`;
  const required = [...(selected?.flags || field.flags || []), ...(selected?.guardFlags || [])];
  const missing = required.find(flag => !capabilities.cli.flags.includes(flag));
  if (missing) return `当前 ComfyUI CLI 未声明 ${missing}，无法使用${field.label}。`;
  if (selected?.module) {
    const present = capabilities.optionalModules?.[selected.module]?.present;
    if (present !== true) return present === false ? `当前 Python 缺少依赖 ${selected.module}。` : `尚未核实依赖 ${selected.module}，请重新诊断。`;
  }
  if (selected?.cuda && capabilities.torch?.cudaAvailable !== true) return '当前 Python 的 PyTorch 未检测到可用 CUDA 设备。';
  if (field.key === 'fastMode' && selected?.value !== 'off' && !capabilities.cli.fastFeatures.length) return '未能静态读取当前 CLI 的 PerformanceFeature，无法核实实验优化。';
  if (field.key === 'fastFeatures' && selected && !capabilities.cli.fastFeatures.includes(selected.value)) return `当前 CLI 的 PerformanceFeature 未声明 ${selected.value}。`;
  return null;
}

export function runtimeFields(settings, capabilities) {
  return optionDefinitions(capabilities, settings.fastFeatures).map(field => {
    const result = { key: field.key, label: field.label, group: field.group, type: field.type };
    for (const key of ['effect', 'help', 'min', 'max', 'step', 'when']) if (field[key] !== undefined) result[key] = structuredClone(field[key]);
    const unsupported = field.type === 'select' ? null : availability(field, null, capabilities);
    result.enabled = !unsupported;
    if (!result.enabled) result.reason = unsupported;
    if (field.choices) result.choices = field.choices.map(option => { const reason = availability(field, option, capabilities); return { value: option.value, label: option.label, available: !reason, ...(reason ? { reason } : {}) }; });
    return result;
  });
}

export function launchOptionArguments(settings, capabilities) {
  const args = [];
  for (const field of optionDefinitions(capabilities)) {
    const value = settings[field.key];
    if (field.type === 'text' || field.type === 'multiselect' || field.when || !field.always && JSON.stringify(value) === JSON.stringify(field.default)) continue;
    const selected = field.choices?.find(option => option.value === value);
    const reason = availability(field, selected, capabilities);
    if (reason) throw new WorkbenchError(409, `${field.label}：${reason}`);
    if (field.key === 'device' && value === 'cuda' && !capabilities.torch.devices?.some(device => device.index === settings.cudaDevice)) throw new WorkbenchError(409, `当前诊断没有发现 CUDA 设备 ${settings.cudaDevice}，请重新选择设备或诊断。`);
    if (field.key === 'fastMode' && value === 'custom') for (const feature of settings.fastFeatures) {
      const reason = availability(definitions.find(item => item.key === 'fastFeatures'), { value: feature, flags: ['--fast'] }, capabilities);
      if (reason) throw new WorkbenchError(409, reason);
    }
    const built = field.build?.(settings);
    if (built) args.push(...built);
    else if (field.type === 'select') args.push(...selected.flags);
    else if (field.type === 'number' && value !== null) args.push(...field.flags, String(value));
    else if (field.type === 'boolean' && value === (field.flagValue ?? true)) args.push(...field.flags);
  }
  return args;
}
