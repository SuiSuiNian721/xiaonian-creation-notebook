import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoraTraining } from '../framework/training.mjs';

const directory = join(tmpdir(), 'tagger-options-service');
const base = { path: join(directory, 'workflows', 'fixture', 'images'), model: 'cl_tagger_1_01', allowDownload: false, trigger: 'actor(test)', policy: 'fill-missing', captionFormat: 'tags' };
const submit = config => {
  const service = Object.assign(Object.create(LoraTraining.prototype), { directory, reserveSubmission: async value => value });
  return service.submitTag({ requestId: 'native-options', config });
};

test('local tagging accepts CLTagger and passes explicit native thresholds and conflict settings', async () => {
  const result = await submit({ ...base, taggerOptions: { threshold: 0.22, character_threshold: 0.81, add_rating_tag: true, add_model_tag: true, additional_tags: 'blue_hair, custom_(tag)', replace_underscore: false, escape_tag: true, download_endpoint: 'https://modelscope.cn', batch_input_recursive: false, batch_output_action_on_conflict: 'append' } });
  assert.equal(result.config.model, 'cl_tagger_1_01');
  assert.equal(result.config.allowDownload, false);
  assert.equal(result.config.taggerOptions.character_threshold, 0.81);
  assert.equal(result.config.taggerOptions.batch_output_action_on_conflict, 'append');
});

test('tagger options reject unknown settings, arbitrary endpoints, nonboolean toggles and out of range thresholds', async () => {
  for (const taggerOptions of [{ threshold: 1.1 }, { threshold: '0.4' }, { add_model_tag: 'true' }, { download_endpoint: 'https://example.org' }, { extra: true }, { batch_output_action_on_conflict: 'delete' }]) {
    await assert.rejects(submit({ ...base, model: 'wd14-convnextv2-v2', taggerOptions }), /打标|Tagger/);
  }
});

test('shared model registry matches all ten bundled native entries and keeps missing options backward compatible', async () => {
  const { taggerModels, taggerOptionFields, normalizeTaggerOptions } = await import('../public-workbench/training-tagger-options.js');
  assert.equal(taggerModels.length, 10);
  assert.equal(taggerOptionFields.length, 10);
  const schema = await readFile(new URL('../integrations/next-trainer/source/mikazuki/schema/tagger.ts', import.meta.url), 'utf8');
  const native = JSON.parse(schema.match(/interrogator_model: Schema\.union\((\[[^\]]+\])/)[1]);
  assert.deepEqual([...taggerModels].sort(), native.sort());
  for (const model of taggerModels) assert.equal((await submit({ ...base, model })).config.model, model);
  assert.equal(normalizeTaggerOptions(undefined, { legacyPolicy: 'regenerate' }).batch_output_action_on_conflict, 'copy');
  assert.equal(normalizeTaggerOptions(undefined, { legacyPolicy: 'fill-missing' }).batch_output_action_on_conflict, 'ignore');
});

const python = process.env.NEXT_TRAINER_TEST_PYTHON || process.env.AI_FUTURE_TEST_PYTHON;
test('native Tagger CPU contract: postprocessing, local assets, collision policies, hash safety and interrupted retry', { skip: !python, timeout: 30000 }, async () => {
  const child = spawn(python, ['-X', 'utf8', '-B', fileURLToPath(new URL('./test_training_tagger_options.py', import.meta.url))], { windowsHide: true, env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1' } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert.equal(code, 0, output);
  assert.match(output, /OK/);
});
