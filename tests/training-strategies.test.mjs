import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineInput, buildPipelinePlan } from '../framework/training-plan.mjs';

const input = (extra = {}) => pipelineInput({ sourcePath: 'E:\\训练图集', purpose: 'character', aiEnabled: false, ...extra });
test('角色、画风与姿势具有可执行的不同裁切、标注和增强策略', async () => {
  const character = await buildPipelinePlan(input({ cropMode: 'auto' }), null, { model_train_type: 'sdxl-lora' });
  assert.equal(character.strategy?.cropMode, 'character');
  assert.equal(character.strategy.captionFormat, 'tags');
  const style = await buildPipelinePlan(input({ purpose: 'style' }), null, { model_train_type: 'sdxl-lora' });
  assert.equal(style.strategy.cropMode, 'preserve'); assert.equal(style.strategy.training.color_aug, false);
  assert.ok(style.strategy.suppressTags.includes('watercolor'));
  const pose = await buildPipelinePlan(input({ purpose: 'pose', cropMode: 'auto' }), null, { model_train_type: 'sdxl-lora' });
  assert.equal(pose.strategy.cropMode, 'pose'); assert.equal(pose.strategy.training.flip_aug, false);
  assert.equal(pose.strategy.preserveKeypoints, true);
});

test('标注格式跟随底模，SDXL 是标签，MOSS 是本地自然语言；允许明确覆盖', async () => {
  for (const [type, format] of [['sd-lora', 'tags'], ['sdxl-lora', 'tags'], ['moss-image-lora', 'natural'], ['flux-lora', 'natural'], ['anima-lora', 'natural']]) {
    const plan = await buildPipelinePlan(input(), null, { model_train_type: type });
    assert.equal(plan.strategy?.captionFormat, format);
    assert.equal(plan.strategy.training.shuffle_caption, format === 'tags');
  }
  const overridden = await buildPipelinePlan(input({ captionFormat: 'tags', cropMode: 'none' }), null, { model_train_type: 'moss-image-lora' });
  assert.equal(overridden.strategy.captionFormat, 'tags'); assert.equal(overridden.strategy.cropMode, 'preserve');
});

test('可选规划 AI 不能改写本地处理模型、文件路径或明确选择的格式', async () => {
  const sharedAI = { complete: async () => ({ text: JSON.stringify({ purpose: 'pose', steps: 100, summary: '姿势方案' }) }) };
  const planned = await buildPipelinePlan(input({ aiEnabled: true, captionFormat: 'tags', cropMode: 'auto' }), sharedAI, { model_train_type: 'moss-image-lora' });
  assert.equal(planned.strategy?.captionFormat, 'tags'); assert.equal(planned.strategy.cropMode, 'pose');
  assert.throws(() => input({ captionFormat: 'cloud' }), /格式|方案|无效/);
  assert.throws(() => input({ detectorPath: '\\\\server\\models' }), /本地|路径/);
});

test('新流程默认整图与分桶，MOSS／Anima 使用 16 步长，小图不放大', async () => {
  for (const purpose of ['character', 'style', 'pose']) {
    const plan = await buildPipelinePlan(input({ purpose }), null, { model_train_type: 'moss-image-lora' });
    assert.equal(plan.strategy.cropMode, 'preserve');
    assert.deepEqual(plan.strategy.dataset, { enable_bucket: true, bucket_no_upscale: true, bucket_reso_steps: 16 });
  }
  const anima = await buildPipelinePlan(input(), null, { model_train_type: 'anima-lora' });
  assert.equal(anima.strategy.dataset.bucket_reso_steps, 16);
  const sdxl = await buildPipelinePlan(input(), null, { model_train_type: 'sdxl-lora' });
  assert.equal(sdxl.strategy.dataset.bucket_reso_steps, 64);
  const explicit = await buildPipelinePlan(input(), null, { model_train_type: 'moss-image-lora', bucket_no_upscale: false, bucket_reso_steps: 64 });
  assert.equal(explicit.strategy.dataset.bucket_no_upscale, false); assert.equal(explicit.strategy.dataset.bucket_reso_steps, 64);
  await assert.rejects(buildPipelinePlan(input(), null, { model_train_type: 'moss-image-lora', bucket_reso_steps: 15 }), /分桶|步长/);
});

test('文本编码缓存保留时不打乱标签；MOSS 默认文本缓存同样适用', async () => {
  const sdxl = await buildPipelinePlan(input(), null, { model_train_type: 'sdxl-lora', cache_text_encoder_outputs: true });
  assert.equal(sdxl.strategy.training.shuffle_caption, false);
  const moss = await buildPipelinePlan(input({ captionFormat: 'tags' }), null, { model_train_type: 'moss-image-lora' });
  assert.equal(moss.strategy.training.shuffle_caption, false);
  const diskDefault = await buildPipelinePlan(input({ captionFormat: 'tags' }), null, { model_train_type: 'moss-image-lora', cache_text_encoder_outputs: false });
  assert.equal(diskDefault.strategy.training.shuffle_caption, false);
  const uncached = await buildPipelinePlan(input({ captionFormat: 'tags' }), null, { model_train_type: 'moss-image-lora', cache_text_encoder_outputs: false, cache_text_encoder_outputs_to_disk: false });
  assert.equal(uncached.strategy.training.shuffle_caption, true);
  assert.equal(moss.strategy.training.token_warmup_step, 0);
  assert.equal(moss.strategy.training.caption_dropout_every_n_epochs, 0);
});
