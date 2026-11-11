import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertWorkflowSupported, buildWorkflowTrainingConfig } from '../framework/training-workflow-config.mjs';

const workspace = join(tmpdir(), 'controlled-workflow-config');
const dataset = { workspace, imageDir: join(workspace, 'images'), derivedCount: 0 };
const summary = { datasetPath: join(workspace, 'dataset.toml') };
const plan = { repeats: 7 };
const original = {
  model_train_type: 'fixture', train_data_dir: 'old-train', dataset_config: 'old-toml', src: 'old-src',
  source_image_dir: 'old-source', resized_image_dir: 'old-resized', lora_cache_dir: 'old-lora-cache', cache_dir: 'old-cache',
  dataset_base_path: 'old-base', dataset_metadata_path: 'old-metadata', dataset_format: 'metadata',
  output_data_dir: 'old-output-images', reg_data_dir: 'old-regularization', in_json: 'old-json',
  dataset_repeat: 22, dataset_repeats: 33, num_repeats: 44, repeats: 55, repeat: 66,
  learning_rate: 0.0002, gradient_accumulation_steps: 4, use_gradient_checkpointing: false,
};

test('Kohya workflow uses the checked managed TOML without mutating the source configuration', () => {
  const result = buildWorkflowTrainingConfig({ config: original, dataset, summary, plan, engine: 'kohya' });
  assert.equal(result.train_data_dir, dataset.imageDir); assert.equal(result.dataset_config, summary.datasetPath);
  assert.equal(result.caption_extension, '.txt');
  assert.equal(result.learning_rate, original.learning_rate); assert.equal(result.gradient_accumulation_steps, 4);
  assert.equal(result.src, undefined); assert.equal(result.dataset_metadata_path, undefined);
  assert.equal(original.train_data_dir, 'old-train'); assert.equal(original.cache_dir, 'old-cache');
});

test('MOSS workflow replaces cache-only input with its managed image source and a fresh private cache', () => {
  const result = buildWorkflowTrainingConfig({ config: { ...original, run_preprocess: false }, dataset, summary, plan, engine: 'moss' });
  assert.equal(result.src, dataset.imageDir); assert.equal(result.run_preprocess, true);
  assert.equal(result.cache_dir, join(workspace, 'moss-cache'));
  for (const key of ['train_data_dir', 'dataset_config', 'dataset_repeat', 'dataset_repeats', 'repeats', 'repeat', 'num_repeats']) assert.equal(result[key], undefined, key);
});

test('DiffSynth workflow chooses image_text and its real singular repeat parameter', () => {
  const result = buildWorkflowTrainingConfig({ config: original, dataset, summary, plan, engine: 'diffsynth' });
  assert.equal(result.dataset_format, 'image_text'); assert.equal(result.train_data_dir, dataset.imageDir);
  assert.equal(result.dataset_repeat, 7); assert.equal(result.dataset_repeats, undefined);
  assert.equal(result.dataset_metadata_path, undefined); assert.equal(result.output_data_dir, undefined);
  assert.equal(result.use_gradient_checkpointing, false);
});

test('AI Toolkit and Anima Fast workflows use their repeat key and cannot retain another source/cache', () => {
  for (const engine of ['ai-toolkit', 'anima-fast']) {
    const preparedDataDir = join(workspace, 'anima-fast-dataset-unique');
    const result = buildWorkflowTrainingConfig({ config: original, dataset, summary, plan, engine, preparedDataDir });
    assert.equal(result.train_data_dir, engine === 'anima-fast' ? preparedDataDir : dataset.imageDir); assert.equal(result.dataset_repeats, 7);
    for (const key of ['dataset_repeat', 'repeat', 'repeats', 'num_repeats', 'dataset_config', 'resized_image_dir', 'cache_dir']) assert.equal(result[key], undefined, `${engine}: ${key}`);
    assert.equal(result.source_image_dir, engine === 'anima-fast' ? preparedDataDir : undefined);
    assert.equal(result.lora_cache_dir, engine === 'anima-fast' ? join(workspace, 'anima-fast-cache', 'lora') : undefined);
  }
});

test('unsupported automatic pairing and mixed crop repeats fail before preparing a dataset', () => {
  assert.doesNotThrow(() => assertWorkflowSupported({ type: { engine: 'musubi' }, config: {}, input: { cropMode: 'auto', purpose: 'character' } }));
  for (const engine of ['diffsynth', 'ai-toolkit']) {
    assert.throws(() => assertWorkflowSupported({ type: { engine }, config: { training_task: 'image-edit' } }), /参考图|配对/);
  }
  assert.throws(() => assertWorkflowSupported({ type: { engine: 'ai-toolkit' }, config: { control_data_dirs: ['references'] } }), /参考图|配对/);
  assert.throws(() => assertWorkflowSupported({ type: { engine: 'diffsynth' }, config: {}, input: { cropMode: 'auto', purpose: 'character' } }), /裁切|重复/);
  assert.doesNotThrow(() => assertWorkflowSupported({ type: { engine: 'diffsynth' }, config: {}, input: { cropMode: 'auto', purpose: 'style' } }));
  assert.throws(() => buildWorkflowTrainingConfig({ config: {}, dataset: { ...dataset, derivedCount: 2 }, summary, plan, engine: 'ai-toolkit' }), /裁切|重复/);
  assert.throws(() => assertWorkflowSupported({ type: { engine: 'unknown' }, config: {} }), /一键/);
});
