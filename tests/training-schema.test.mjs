import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
const adapter = () => import('../framework/training-schema.mjs');
const fields = form => form.sections.flatMap(section => section.fields);
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, source, shared = '(function () { return { RAW: {} }; })()') {
  const directory = await mkdtemp(join(tmpdir(), 'training-schema-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const schemaDir = join(directory, 'source', 'mikazuki', 'schema');
  await mkdir(schemaDir, { recursive: true });
  const sources = { 'fixture.ts': source, 'shared.ts': shared };
  const files = [];
  for (const [name, content] of Object.entries(sources)) {
    await writeFile(join(schemaDir, name), content, 'utf8');
    files.push({ path: `mikazuki/schema/${name}`, size: Buffer.byteLength(content), sha256: digest(content) });
  }
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({ format: 1, files }), 'utf8');
  return { directory, schemaDir };
}

test('MOSS form retains required model components, native groups and model-specific constraints', async () => {
  const { loadTrainingForm, formDefaults } = await adapter();
  const form = await loadTrainingForm(integration, 'moss-image-lora');
  assert.equal(form.schemaName, 'moss-image-lora');
  assert.match(form.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(form.sections.some(section => section.title === 'MOSS 专用参数'));
  assert.equal(new Set(form.sections.map(section => section.id)).size, form.sections.length);
  const byKey = new Map(fields(form).map(field => [field.key, field]));
  for (const key of ['pretrained_model_name_or_path', 'text_encoder', 'vae', 'tokenizer_cache_dir']) {
    assert.equal(byKey.get(key).required, true, key);
    assert.equal(byKey.get(key).role, 'filepicker', key);
    assert.equal(byKey.get(key).extra.type, key === 'tokenizer_cache_dir' ? 'folder' : 'model-file');
  }
  assert.equal(byKey.get('bucket_reso_steps').defaultValue, 16);
  assert.equal(byKey.get('mixed_precision').type, 'const');
  assert.equal(byKey.get('mixed_precision').constValue, 'bf16');
  assert.equal(byKey.get('model_train_type').hidden, true);
  assert.equal(byKey.get('moss_max_token_length').max, 4096);
  assert.equal(byKey.get('blocks_to_swap').step, 1);
  assert.equal(byKey.get('network_dropout').min, 0);
  assert.equal(byKey.get('network_dropout').max, 1);
  assert.equal(byKey.get('network_dropout').step, 0.01);
  assert.deepEqual(byKey.get('timestep_sampling').options, ['sigma', 'uniform', 'sigmoid', 'shift', 'flux_shift']);
  assert.equal(byKey.get('network_args_custom').type, 'array');
  for (const removed of ['weighted_captions', 'full_fp16', 'full_bf16', 'xformers']) assert.equal(byKey.has(removed), false, removed);
  const defaults = formDefaults(form);
  assert.equal(defaults.model_train_type, 'moss-image-lora');
  assert.equal(defaults.bucket_reso_steps, 16);
  assert.equal(defaults.mixed_precision, 'bf16');
  assert.equal(defaults.network_module, 'networks.lora_generic');
  assert.equal(defaults.pretrained_model_name_or_path, undefined);
});

test('every bundled catalog schema converts without starting a training runtime', async () => {
  const { loadTrainingForm } = await adapter();
  const catalog = JSON.parse(await readFile(join(integration, 'catalog.json'), 'utf8'));
  const names = [...new Set(catalog.training_types.filter(item => item.bundled && item.schema_name).map(item => item.schema_name))];
  assert.equal(names.length, 7);
  for (const name of names) {
    const form = await loadTrainingForm(integration, name);
    assert.equal(form.schemaName, name);
    assert.ok(fields(form).length > 30, name);
    for (const field of fields(form)) {
      assert.ok(['string', 'number', 'boolean', 'array', 'const'].includes(field.type), `${name}: ${field.key}`);
      assert.ok(Array.isArray(field.conditions), `${name}: ${field.key}`);
    }
  }
});

test('EmoSens guidance survives discriminator filtering with its optimizer condition', async () => {
  const { loadTrainingForm, formDefaults } = await adapter();
  for (const name of ['moss-image-lora', 'lora-master', 'sd3-lora', 'flux-lora', 'lumina2-lora']) {
    const form = await loadTrainingForm(integration, name);
    const guidance = form.sections.find(section => section.title.includes('emoPulse'));
    assert.ok(guidance, name);
    assert.match(guidance.title, /学习率.*1\.0/);
    assert.deepEqual(guidance.fields, []);
    assert.deepEqual(guidance.conditions, [{ key: 'optimizer_type', value: 'EmoSens' }]);
    const active = config => guidance.conditions.every(condition => config[condition.key] === condition.value);
    assert.equal(active({ optimizer_type: 'EmoSens' }), true);
    assert.equal(active({ optimizer_type: 'AdamW8bit' }), false);
    assert.equal(active({}), false);
    const generalSection = form.sections.find(section => section.fields.some(field => field.key === 'optimizer_args_custom'));
    assert.deepEqual(generalSection.conditions, [], name);
    assert.equal(formDefaults(form, { optimizer_type: 'AdamW8bit' }).optimizer_type, 'AdamW8bit');
  }
});

test('description-only sections retain nested conditions without absorbing later unconditional fields', async t => {
  const { loadTrainingForm } = await adapter();
  const { directory } = await fixture(t, `Schema.intersect([
    Schema.object({ mode: Schema.union(['lora', 'finetune']).default('lora') }).description('基础设置'),
    Schema.union([
      Schema.intersect([
        Schema.object({ mode: Schema.const('lora') }),
        Schema.union([
          Schema.object({ optimizer_type: Schema.const('EmoSens') }).description('仅 LoRA 的 EmoSens 说明'),
          Schema.object({})
        ])
      ]),
      Schema.object({})
    ]),
    Schema.object({ general: Schema.number().default(1) })
  ])`);
  const form = await loadTrainingForm(directory, 'fixture');
  const guidance = form.sections.find(section => section.title === '仅 LoRA 的 EmoSens 说明');
  assert.ok(guidance);
  assert.deepEqual(guidance.fields, []);
  assert.deepEqual(guidance.conditions, [{ key: 'mode', value: 'lora' }, { key: 'optimizer_type', value: 'EmoSens' }]);
  const generalSection = form.sections.find(section => section.fields.some(field => field.key === 'general'));
  assert.equal(generalSection.title, '基础设置');
  assert.deepEqual(generalSection.conditions, []);
});

test('LoKr defaults stay in their selected branch and explicit advanced parameters always win', async () => {
  const { loadTrainingForm, formDefaults } = await adapter();
  const form = await loadTrainingForm(integration, 'sd3-lora');
  const config = { model_train_type: 'sd3-lora', lora_type: 'lokr', lokr_factor: 8, network_module: 'custom.module', opaque_advanced: { values: [1, 2] } };
  const result = formDefaults(form, config);
  assert.equal(result.model_train_type, 'sd3-lora');
  assert.equal(result.network_module, 'custom.module');
  assert.equal(result.lokr_factor, 8);
  assert.equal(result.lycoris_algo, 'lokr');
  assert.equal(result.pissa_niter, undefined);
  assert.equal(formDefaults(form, { lora_type: 'lokr' }).network_module, 'lycoris.kohya');
  assert.equal(formDefaults(form, { lora_type: 'lora' }).network_module, 'networks.lora_anima');
  assert.equal(formDefaults(form, { lora_type: 'lora' }).lokr_factor, undefined);
  result.opaque_advanced.values.push(3);
  assert.deepEqual(config.opaque_advanced.values, [1, 2]);
});

test('nested conditional fields retain every controlling condition and use only matching defaults', async () => {
  const { loadTrainingForm, formDefaults } = await adapter();
  const form = await loadTrainingForm(integration, 'lora-master');
  const field = fields(form).find(item => item.key === 'flow_logit_std');
  assert.deepEqual(field.conditions, [
    { key: 'model_train_type', value: 'sdxl-lora' },
    { key: 'sdxl_prediction_type', value: 'rectified_flow' },
    { key: 'flow_timestep_distribution', value: 'logit_normal' },
  ]);
  const active = formDefaults(form, { model_train_type: 'sdxl-lora', sdxl_prediction_type: 'rectified_flow' });
  assert.equal(active.flow_timestep_distribution, 'logit_normal');
  assert.equal(active.flow_logit_std, 1);
  assert.equal(formDefaults(form, { model_train_type: 'sd-lora' }).flow_logit_std, undefined);
  assert.equal(formDefaults(form, { model_train_type: 'sdxl-lora', sdxl_prediction_type: 'eps' }).flow_logit_std, undefined);
});

test('facade preserves scalar enums, empty array defaults, disabled metadata and UpdateSchema isolation', async t => {
  const { loadTrainingForm, formDefaults } = await adapter();
  const { directory } = await fixture(t, `Schema.intersect([
    Schema.object(UpdateSchema(SHARED_SCHEMAS.RAW.fields, { replacement: Schema.boolean().default(false) }, ['removed'])).description({'zh-CN': '设置'}),
    Schema.object({
      original: SHARED_SCHEMAS.RAW.fields.removed,
      enabled: Schema.union([true, false]).default(false).disabled(),
      count: Schema.union([1, 2]).default(2),
      rows: Schema.array(String).default([]).role('table', { editable: true }),
    })
  ])`, '(function () { return { RAW: { fields: { removed: Schema.number().default(7) } } }; })()');
  const form = await loadTrainingForm(directory, 'fixture');
  const byKey = new Map(fields(form).map(field => [field.key, field]));
  assert.equal(form.sections[0].title, '设置');
  assert.equal(byKey.has('removed'), false);
  assert.equal(byKey.get('original').defaultValue, 7);
  assert.deepEqual(byKey.get('enabled').options, [true, false]);
  assert.equal(byKey.get('enabled').type, 'boolean');
  assert.equal(byKey.get('enabled').disabled, true);
  assert.deepEqual(byKey.get('count').options, [1, 2]);
  assert.equal(byKey.get('count').type, 'number');
  assert.deepEqual(byKey.get('rows').defaultValue, []);
  const result = formDefaults(form);
  assert.deepEqual(result.rows, []);
  result.rows.push('new');
  assert.deepEqual(byKey.get('rows').defaultValue, []);
});

test('defaults iterate until later controls resolve without adding inactive values or replacing explicit empties', async t => {
  const { loadTrainingForm, formDefaults } = await adapter();
  const { directory } = await fixture(t, `Schema.intersect([
    Schema.union([Schema.object({ second: Schema.const(true), leaf: Schema.number().default(3) }), Schema.object({})]),
    Schema.union([Schema.object({ first: Schema.const(true), second: Schema.boolean().default(true) }), Schema.object({})]),
    Schema.object({ first: Schema.boolean().default(true), text: Schema.string().default('fallback') })
  ])`);
  const form = await loadTrainingForm(directory, 'fixture');
  assert.equal(formDefaults(form).leaf, 3);
  assert.equal(formDefaults(form, { first: false }).leaf, undefined);
  assert.equal(formDefaults(form, { text: '' }).text, '');
  assert.equal(formDefaults(form, { text: null }).text, null);
});

test('schemas execute in a heap without host filesystem, processes, modules or network APIs', async t => {
  const { loadTrainingForm, formDefaults } = await adapter();
  const { directory } = await fixture(t, `Schema.object({ surface: Schema.const([typeof process, typeof require, typeof fetch, typeof Buffer, typeof console, typeof WebSocket].join(',')) })`);
  const form = await loadTrainingForm(directory, 'fixture');
  assert.equal(formDefaults(form).surface, 'undefined,undefined,undefined,undefined,undefined,undefined');
});

test('nonterminating schema execution is interrupted within a bounded time', { timeout: 6000 }, async t => {
  const { loadTrainingForm } = await adapter();
  const { directory } = await fixture(t, '(function () { while (true) {} })()');
  const started = Date.now();
  await assert.rejects(loadTrainingForm(directory, 'fixture'), /执行|超时|interrupt|limit/i);
  assert.ok(Date.now() - started < 5000);
});

test('schema heap memory is limited', { timeout: 6000 }, async t => {
  const { loadTrainingForm } = await adapter();
  const { directory } = await fixture(t, "(function () { const values = []; while (true) values.push('x'.repeat(100000)); })()");
  await assert.rejects(loadTrainingForm(directory, 'fixture'), /内存|执行|超时|memory|limit|interrupt/i);
});

test('schema names cannot escape the bundled schema directory or name unlisted source', async t => {
  const { loadTrainingForm } = await adapter();
  const { directory, schemaDir } = await fixture(t, 'Schema.object({})');
  for (const name of ['../shared', '..\\shared', 'E:\\outside', '/tmp/outside', 'fixture.ts', 'shared']) {
    await assert.rejects(loadTrainingForm(directory, name), /名称|路径|参数定义|清单/);
  }
  await writeFile(join(schemaDir, 'outside.ts'), 'Schema.object({})', 'utf8');
  await assert.rejects(loadTrainingForm(directory, 'outside'), /清单|内置/);
});

test('source or shared hash changes are rejected even after an earlier successful load', async t => {
  const { loadTrainingForm } = await adapter();
  for (const target of ['fixture.ts', 'shared.ts']) {
    const { directory, schemaDir } = await fixture(t, 'Schema.object({ value: Schema.number().default(1) })');
    await loadTrainingForm(directory, 'fixture');
    const path = join(schemaDir, target);
    const content = await readFile(path, 'utf8');
    await writeFile(path, content.replace(target === 'fixture.ts' ? '1' : 'RAW', target === 'fixture.ts' ? '2' : 'BAD'), 'utf8');
    await assert.rejects(loadTrainingForm(directory, 'fixture'), /哈希|校验|hash/i);
  }
});

test('schema directory junctions are rejected even when linked files match the source manifest', async t => {
  const { loadTrainingForm } = await adapter();
  const { directory, schemaDir } = await fixture(t, 'Schema.object({})');
  const redirected = join(directory, 'redirected-schema');
  await rename(schemaDir, redirected);
  await symlink(redirected, schemaDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadTrainingForm(directory, 'fixture'), /普通|链接|路径|目录/);
});

test('schema source paths must be unique ordinary manifest entries', async t => {
  const { loadTrainingForm } = await adapter();
  const { directory } = await fixture(t, 'Schema.object({})');
  const manifestPath = join(directory, 'source-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files.push({ ...manifest.files[0] });
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await assert.rejects(loadTrainingForm(directory, 'fixture'), /清单|重复/);
});
