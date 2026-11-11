import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingControls, applyDrawingAdjustments } from '../framework/drawing-adjustments.mjs';

const info = {
  UNETLoader: { output: ['MODEL'] }, CLIPLoader: { output: ['CLIP'] }, VAELoader: { output: ['VAE'] },
  QwenImage21Cache: { output: ['MODEL'] }, KSampler: { output: ['LATENT'] },
  LoraLoader: { output: ['MODEL', 'CLIP'], input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: ['COMBO', { options: ['characters/a.safetensors', 'style/b.safetensors'] }], strength_model: ['FLOAT', { min: -100, max: 100 }], strength_clip: ['FLOAT', { min: -100, max: 100 }] } } },
  LoadImage: { output: ['IMAGE', 'MASK'], input: { required: { image: [['old.png', 'new.png']] } } },
  TextEncodeQwenImage21: { output: ['CONDITIONING', 'CONDITIONING', 'LATENT'], input: { required: { images: ['COMFY_AUTOGROW_V3', { template: { names: ['image_1', 'image_2'], min: 0, input: { required: { image: ['IMAGE'] } } } }] }, optional: { vae: ['VAE'] } } },
};
const graph = {
  m: { class_type: 'UNETLoader', inputs: {} }, c: { class_type: 'CLIPLoader', inputs: {} }, v: { class_type: 'VAELoader', inputs: {} },
  cache: { class_type: 'QwenImage21Cache', inputs: { model: ['m', 0] } },
  text: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['c', 0], prompt: 'cat' } },
  size: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 768 } },
  sample: { class_type: 'KSampler', inputs: { model: ['cache', 0], positive: ['text', 0], negative: ['text', 1], latent_image: ['size', 0] } },
  decode: { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['v', 0] } },
};

test('controls reflect unique connected model/clip roots, service LoRAs and available Qwen image slots', () => {
  const controls = drawingControls(graph, info);
  assert.equal(controls.lora.available, true);
  assert.equal(controls.lora.supportsClip, true);
  assert.deepEqual(controls.lora.choices, info.LoraLoader.input.required.lora_name[1].options);
  assert.deepEqual({ available: controls.reference.available, maxImages: controls.reference.maxImages }, { available: true, maxImages: 2 });
});

test('LoRA insertion preserves cache and connects both model and clip; original graph stays intact', () => {
  const original = structuredClone(graph);
  const result = applyDrawingAdjustments(graph, { loras: [{ name: 'characters/a.safetensors', modelWeight: 0.7, clipWeight: 0.5 }, { name: 'style/b.safetensors', modelWeight: -0.2, clipWeight: 0 }] }, info);
  const additions = Object.entries(result).filter(([, node]) => node.class_type === 'LoraLoader');
  assert.equal(additions.length, 2);
  assert.deepEqual(additions[0][1].inputs.model, ['m', 0]);
  assert.deepEqual(additions[1][1].inputs.model, [additions[0][0], 0]);
  assert.deepEqual(result.cache.inputs.model, [additions[1][0], 0]);
  assert.deepEqual(result.text.inputs.clip, [additions[1][0], 1]);
  assert.deepEqual(result.sample.inputs.model, ['cache', 0]);
  assert.equal(additions[1][1].inputs.strength_model, -0.2);
  assert.deepEqual(graph, original);
});

test('Qwen reference image additions bind VAE and only append actual free input slots', () => {
  const result = applyDrawingAdjustments(graph, { images: ['new.png'] }, info);
  const load = Object.entries(result).find(([, node]) => node.class_type === 'LoadImage');
  assert.equal(load[1].inputs.image, 'new.png');
  assert.deepEqual(result.text.inputs['images.image_1'], [load[0], 0]);
  assert.deepEqual(result.text.inputs.vae, ['v', 0]);
  assert.deepEqual(result.sample.inputs.latent_image, ['text', 2]);
  assert.equal(graph.text.inputs['images.image_1'], undefined);
});

test('rejects missing models, unlisted images, invalid weights, unknown fields and slot overflow', () => {
  for (const adjustments of [
    { loras: [{ name: 'missing', modelWeight: 1, clipWeight: 1 }] },
    { loras: [{ name: 'characters/a.safetensors', modelWeight: null, clipWeight: 1 }] },
    { loras: [{ name: 'characters/a.safetensors', modelWeight: 101, clipWeight: 1 }] },
    { images: ['missing.png'] }, { images: ['old.png', 'new.png', 'old.png'] }, { arbitrary: true },
  ]) assert.throws(() => applyDrawingAdjustments(graph, adjustments, info));
});

test('ambiguous roots disable automatic LoRA insertion and never select a random branch', () => {
  const ambiguous = structuredClone(graph);
  ambiguous.other = { class_type: 'UNETLoader', inputs: {} };
  ambiguous.otherSampler = { class_type: 'KSampler', inputs: { model: ['other', 0] } };
  assert.equal(drawingControls(ambiguous, info).lora.available, false);
  assert.throws(() => applyDrawingAdjustments(ambiguous, { loras: [{ name: 'characters/a.safetensors', modelWeight: 1, clipWeight: 1 }] }, info), /模型/);
});

test('existing reference links and existing generated node IDs are preserved', () => {
  const previous = structuredClone(graph);
  previous.workbench_image_1 = { class_type: 'LoadImage', inputs: { image: 'old.png' } };
  previous.text.inputs['images.image_1'] = ['workbench_image_1', 0];
  const result = applyDrawingAdjustments(previous, { images: ['new.png'] }, info);
  assert.deepEqual(result.text.inputs['images.image_1'], ['workbench_image_1', 0]);
  assert.notDeepEqual(result.text.inputs['images.image_2'], ['workbench_image_1', 0]);
});

test('an empty ComfyUI input folder still offers reference image upload', () => {
  const schema = structuredClone(info);
  schema.LoadImage.input.required.image = [[]];
  assert.equal(drawingControls(graph, schema).reference.available, true);
});

test('model-only workflows use model-only LoRAs without inventing CLIP links', () => {
  const prompt = { m: graph.m, sample: { class_type: 'KSampler', inputs: { model: ['m', 0] } } };
  const schema = { ...info, LoraLoaderModelOnly: { output: ['MODEL'], input: { required: { model: ['MODEL'], lora_name: [['characters/a.safetensors']], strength_model: ['FLOAT', { min: -20, max: 20 }] } } } };
  assert.equal(drawingControls(prompt, schema).lora.supportsClip, false);
  const result = applyDrawingAdjustments(prompt, { loras: [{ name: 'characters/a.safetensors', modelWeight: 0.9, clipWeight: 1 }] }, schema);
  const node = Object.values(result).find(item => item.class_type === 'LoraLoaderModelOnly');
  assert.equal(node.inputs.strength_model, 0.9);
  assert.equal(Object.hasOwn(node.inputs, 'clip'), false);
});

test('explicit workflow dimensions retain the original latent chain and invalid size modes reject', () => {
  const result = applyDrawingAdjustments(graph, { images: ['new.png'], referenceSize: 'workflow' }, info);
  assert.deepEqual(result.sample.inputs.latent_image, ['size', 0]);
  assert.throws(() => applyDrawingAdjustments(graph, { images: ['new.png'], referenceSize: 'unknown' }, info), /尺寸/);
});

test('unrecognized sampling branches do not offer automatic reference wiring', () => {
  const prompt = structuredClone(graph);
  prompt.sample.class_type = 'CustomSampler';
  assert.equal(drawingControls(prompt, info).reference.available, false);
  assert.throws(() => applyDrawingAdjustments(prompt, { images: ['new.png'] }, info), /采样/);
});

test('reference sizing replaces only initial empty latents and preserves later sampling stages', () => {
  const prompt = structuredClone(graph);
  prompt.refiner = { class_type: 'KSampler', inputs: { ...prompt.sample.inputs, latent_image: ['sample', 0] } };
  prompt.decode.inputs.samples = ['refiner', 0];
  const result = applyDrawingAdjustments(prompt, { images: ['new.png'] }, info);
  assert.deepEqual(result.sample.inputs.latent_image, ['text', 2]);
  assert.deepEqual(result.refiner.inputs.latent_image, ['sample', 0]);
});

test('following reference dimensions preserves the selected image batch count', () => {
  const prompt = structuredClone(graph); prompt.size.inputs.batch_size = 3;
  const schema = { ...info, RepeatLatentBatch: { output: ['LATENT'], input: { required: { samples: ['LATENT'], amount: ['INT', { min: 1, max: 64 }] } } } };
  const result = applyDrawingAdjustments(prompt, { images: ['new.png'] }, schema);
  const [id, repeat] = Object.entries(result).find(([, node]) => node.class_type === 'RepeatLatentBatch') || [];
  assert.ok(id);
  assert.equal(repeat.inputs.amount, 3);
  assert.deepEqual(repeat.inputs.samples, ['text', 2]);
  assert.deepEqual(result.sample.inputs.latent_image, [id, 0]);
  assert.throws(() => applyDrawingAdjustments(prompt, { images: ['new.png'] }, info), /张数/);
});
