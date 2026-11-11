import { join } from 'node:path';
import { WorkbenchError } from './contracts.mjs';
import { prepareMusubiWorkflowDataset } from './training-musubi-dataset.mjs';
import { prepareWorkflowDatasetLayout } from './training-workflow-dataset.mjs';

const supported = new Set(['kohya', 'musubi', 'moss', 'diffsynth', 'ai-toolkit', 'anima-fast']);
const sourceFields = ['train_data_dir', 'dataset_config', 'src', 'source_image_dir', 'resized_image_dir', 'lora_cache_dir', 'cache_dir', 'dataset_base_path', 'dataset_metadata_path', 'dataset_format', 'output_data_dir', 'input_data_dirs', 'control_data_dirs', 'reg_data_dir', 'in_json'];
const repeatFields = ['dataset_repeat', 'dataset_repeats', 'num_repeats', 'repeats', 'repeat'];
const references = value => Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0;

export function assertWorkflowSupported({ type, config = {}, input, plan } = {}) {
  const engine = type?.engine;
  if (!supported.has(engine)) throw new WorkbenchError(400, '当前训练引擎尚未支持一键图集流程，请使用全量参数手动训练。');
  if (['diffsynth', 'ai-toolkit'].includes(engine) && (config.training_task === 'image-edit' || references(config.control_data_dirs) || references(config.input_data_dirs))) throw new WorkbenchError(400, '图像编辑需要目标图与参考图逐一配对；当前一键图集会重新命名，请在全量参数中选择配对图集后手动训练。');
  if (!['kohya', 'musubi'].includes(engine) && (input?.cropMode === 'auto' && input?.purpose !== 'style' || plan?.strategy?.cropMode && plan.strategy.cropMode !== 'preserve')) throw new WorkbenchError(400, '此引擎的一键流程暂不支持裁切图与原图分别设置重复次数，请关闭自动裁切，或使用全量参数手动训练。');
}

export function buildWorkflowTrainingConfig({ config, dataset, summary, plan, engine, preparedDataDir }) {
  assertWorkflowSupported({ type: { engine }, config, plan });
  if (!['kohya', 'musubi'].includes(engine) && dataset.derivedCount > 0) throw new WorkbenchError(400, '此引擎不能在当前一键图集中分别设置原图和裁切图重复次数，请重新创建整图流程。');
  const result = { ...config };
  // A workflow owns its copied image/caption set. An imported preset must not
  // redirect training to an old source, metadata file, or preprocessing cache.
  for (const key of [...sourceFields, ...repeatFields]) delete result[key];
  if (engine === 'moss') {
    // Native MOSS has epochs/max_steps, explicitly no dataset repeats.
    return { ...result, src: dataset.imageDir, run_preprocess: true, cache_dir: join(dataset.workspace, 'moss-cache') };
  }
  result.train_data_dir = dataset.imageDir;
  result.caption_extension = '.txt';
  if (engine === 'kohya') result.dataset_config = summary.datasetPath;
  else if (engine === 'musubi') {
    if (!preparedDataDir) throw new WorkbenchError(409, 'Musubi 图集尚未准备，请通过流程图集准备入口建立副本。');
    result.train_data_dir = preparedDataDir;
  }
  else {
    if (!Number.isSafeInteger(plan.repeats) || plan.repeats < 1) throw new WorkbenchError(400, '一键图集重复次数须为正整数。');
    if (engine === 'diffsynth') { result.dataset_format = 'image_text'; result.dataset_repeat = plan.repeats; }
    else result.dataset_repeats = plan.repeats;
    if (engine === 'anima-fast') {
      if (!preparedDataDir) throw new WorkbenchError(409, 'Anima Fast 图集尚未准备，请通过流程图集准备入口建立副本。');
      result.train_data_dir = preparedDataDir;
      result.source_image_dir = preparedDataDir;
      result.lora_cache_dir = join(dataset.workspace, 'anima-fast-cache', 'lora');
      // An explicit resized directory disables native auto-resize. The unique
      // input basename instead isolates the automatically chosen resize cache.
    }
  }
  return result;
}

export async function prepareWorkflowTrainingConfig(options) {
  options.signal?.throwIfAborted();
  assertWorkflowSupported({ type: { engine: options.engine }, config: options.config, plan: options.plan });
  const preparedDataDir = options.engine === 'musubi' ? await prepareMusubiWorkflowDataset(options) : options.engine === 'anima-fast' ? await prepareWorkflowDatasetLayout(options, 'anima-fast') : undefined;
  return buildWorkflowTrainingConfig({ ...options, preparedDataDir });
}
