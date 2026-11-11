import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LoraTraining, protectDataset } from '../framework/training.mjs';

async function fixture(t, beforeRemove = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'training-dataset-compat-'));
  t.after(async () => { await beforeRemove(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  async function directory(name) { const path = join(root, name); await mkdir(path, { recursive: true }); return path; }
  async function imageSet(name) {
    const path = await directory(name);
    await writeFile(join(path, 'portrait.png'), 'controlled-image-fixture');
    await writeFile(join(path, 'portrait.txt'), 'A portrait of a character.\n');
    return path;
  }
  return { root, directory, imageSet };
}

test('standalone MOSS accepts src and cache-only input without Kohya directory requirements', async t => {
  const f = await fixture(t), src = await f.imageSet('source'), cache = await f.directory('cache');
  await protectDataset({ src, run_preprocess: true }, { engine: 'moss' });
  await protectDataset({ cache_dir: cache, run_preprocess: false }, { engine: 'moss' });
  await protectDataset({ cache_dir: cache, run_preprocess: 'false' }, { engine: 'moss' });
  await assert.rejects(protectDataset({ run_preprocess: true }, { engine: 'moss' }), /src|数据集/);
  await assert.rejects(protectDataset({ run_preprocess: false }, { engine: 'moss' }), /cache_dir|缓存/);
  assert.deepEqual((await readdir(src)).sort(), ['portrait.png', 'portrait.txt']);
  assert.equal(await readFile(join(src, 'portrait.png'), 'utf8'), 'controlled-image-fixture');
});

test('DiffSynth accepts flat image/text and Edit aliases while checking reference directories', async t => {
  const f = await fixture(t), output = await f.imageSet('output'), input = await f.imageSet('input');
  await protectDataset({ train_data_dir: output }, { engine: 'diffsynth' });
  await protectDataset({ training_task: 'image-edit', output_data_dir: output, input_data_dirs: [input] }, { engine: 'diffsynth' });
  await assert.rejects(protectDataset({ training_task: 'image-edit', output_data_dir: output, input_data_dirs: [join(f.root, 'missing')] }, { engine: 'diffsynth' }), /不存在|不可读取/);
  assert.deepEqual((await readdir(output)).sort(), ['portrait.png', 'portrait.txt']);
});

test('DiffSynth metadata supports JSON, JSONL and quoted CSV with relative image and Edit references', async t => {
  const f = await fixture(t), base = await f.imageSet('images');
  await writeFile(join(base, 'reference.png'), 'controlled-reference');
  for (const [extension, text] of [
    ['json', JSON.stringify([{ image: 'portrait.png', prompt: 'A portrait, with a smile.', edit_image: ['reference.png'] }])],
    ['jsonl', '\uFEFF' + JSON.stringify({ image: 'portrait.png', prompt: '', edit_image: 'reference.png' }) + '\n'],
    ['csv', 'image,prompt,edit_image\r\nportrait.png,"A portrait,\nwith a ""smile"".","[""reference.png""]"\r\n'],
  ]) {
    const metadata = join(f.root, 'dataset.' + extension); await writeFile(metadata, text);
    await protectDataset({ dataset_format: 'metadata', training_task: 'image-edit', dataset_base_path: base, dataset_metadata_path: metadata }, { engine: 'diffsynth' });
    assert.equal(await readFile(metadata, 'utf8'), text, 'metadata must stay unchanged');
  }
});

test('DiffSynth metadata cannot bypass path safety through image or Edit reference fields', async t => {
  const f = await fixture(t), base = await f.imageSet('images'), metadata = join(f.root, 'dataset.json');
  const config = { dataset_format: 'metadata', training_task: 'image-edit', dataset_base_path: base, dataset_metadata_path: metadata };
  for (const row of [
    { image: '\\\\server\\dataset\\a.png', prompt: '', edit_image: ['portrait.png'] },
    { image: 'portrait.png', prompt: '', edit_image: ['\\\\?\\C:\\dataset\\a.png'] },
    { image: 'missing.png', prompt: '', edit_image: ['portrait.png'] },
  ]) {
    await writeFile(metadata, JSON.stringify([row]));
    await assert.rejects(protectDataset(config, { engine: 'diffsynth' }), /本地绝对路径|不存在|不可读取|设备/);
  }
  await writeFile(metadata, '{invalid json');
  await assert.rejects(protectDataset(config, { engine: 'diffsynth' }), /元数据|解析/);
});

test('AI Toolkit and Anima Fast accept their ordinary image directories and source aliases', async t => {
  const f = await fixture(t), src = await f.imageSet('source'), controls = await f.imageSet('controls');
  await protectDataset({ train_data_dir: src, control_data_dirs: [controls], training_task: 'image-edit' }, { engine: 'ai-toolkit' });
  await protectDataset({ source_image_dir: src }, { engine: 'anima-fast' });
  await protectDataset({ train_data_dir: src }, { engine: 'anima-fast' });
  assert.deepEqual((await readdir(src)).sort(), ['portrait.png', 'portrait.txt']);
});

test('Kohya and Musubi still reject automatic organization, including Musubi with an ignored dataset_config', async t => {
  const f = await fixture(t), src = await f.imageSet('source'), dataset = join(f.root, 'dataset.toml');
  await writeFile(dataset, `[[datasets]]\n[[datasets.subsets]]\nimage_dir = ${JSON.stringify(src)}\n`);
  for (const engine of ['kohya', 'musubi']) await assert.rejects(protectDataset({ train_data_dir: src }, { engine }), /散图|自动整理/);
  await protectDataset({ train_data_dir: src, dataset_config: dataset }, { engine: 'kohya' });
  await assert.rejects(protectDataset({ train_data_dir: src, dataset_config: dataset }, { engine: 'musubi' }), /散图|自动整理/);
  assert.deepEqual((await readdir(src)).sort(), ['portrait.png', 'portrait.txt']);
  await f.directory('source/10_character');
  await protectDataset({ train_data_dir: src }, { engine: 'kohya' });
  await protectDataset({ train_data_dir: src }, { engine: 'musubi' });
});

test('all engines reject dataset junctions, including nested reference and regularization directories', async t => {
  const f = await fixture(t), src = await f.imageSet('source'), actual = await f.imageSet('actual'), link = join(f.root, 'linked');
  await symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [engine, config] of [
    ['moss', { src: link }], ['diffsynth', { train_data_dir: link }], ['ai-toolkit', { train_data_dir: link }],
    ['anima-fast', { source_image_dir: link }], ['kohya', { train_data_dir: src, reg_data_dir: link }],
    ['diffsynth', { training_task: 'image-edit', output_data_dir: src, input_data_dirs: [link] }],
  ]) await assert.rejects(protectDataset(config, { engine }), /链接|联接/);
  await symlink(actual, join(src, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(protectDataset({ src }, { engine: 'moss' }), /链接|联接/);
});

test('Kohya checks dataset_config references without changing regularization subsets', async t => {
  const f = await fixture(t), src = await f.imageSet('source'), reg = await f.imageSet('regularization'), dataset = join(f.root, 'dataset.toml');
  const content = `[[datasets]]\n[[datasets.subsets]]\nimage_dir = ${JSON.stringify(src)}\nnum_repeats = 3\n[[datasets.subsets]]\nimage_dir = ${JSON.stringify(reg)}\nis_reg = true\nnum_repeats = 1\n`;
  await writeFile(dataset, content);
  await protectDataset({ train_data_dir: src, dataset_config: dataset, reg_data_dir: reg }, { engine: 'kohya' });
  assert.equal(await readFile(dataset, 'utf8'), content);
  const link = join(f.root, 'linked-reg'); await symlink(reg, link, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(dataset, `[[datasets]]\n[[datasets.subsets]]\nimage_dir = ${JSON.stringify(link)}\nis_reg = true\n`);
  await assert.rejects(protectDataset({ train_data_dir: src, dataset_config: dataset }, { engine: 'kohya' }), /链接|联接/);
});

test('Kohya finetune metadata keeps stem keys and rejects links or UNC paths embedded in image keys', async t => {
  const f = await fixture(t), src = await f.imageSet('source'), external = await f.imageSet('external');
  const metadata = join(f.root, 'metadata.json'), dataset = join(f.root, 'dataset.toml'), link = join(f.root, 'linked');
  await writeFile(dataset, `[[datasets]]\n[[datasets.subsets]]\nimage_dir = ${JSON.stringify(src)}\nmetadata_file = ${JSON.stringify(metadata)}\n`);
  await writeFile(metadata, JSON.stringify({ portrait: { caption: 'existing caption' } }));
  const config = { model_train_type: 'sdxl-finetune', train_data_dir: src, dataset_config: dataset };
  await protectDataset(config, { engine: 'kohya', root: f.root });
  await protectDataset({ ...config, in_json: join(f.root, 'ignored.json'), reg_data_dir: join(f.root, 'ignored-reg') }, { engine: 'kohya', root: f.root });
  await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const key of [join(link, 'portrait.png'), join(link, 'portrait'), '\\\\server\\dataset\\portrait.png']) {
    await writeFile(metadata, JSON.stringify({ [key]: { caption: 'existing caption' } }));
    await assert.rejects(protectDataset(config, { engine: 'kohya', root: f.root }), /链接|联接|本地绝对路径/);
    await assert.rejects(protectDataset({ model_train_type: 'sdxl-finetune', train_data_dir: src, in_json: metadata }, { engine: 'kohya', root: f.root }), /链接|联接|本地绝对路径/);
  }
});

test('service preflight routes dataset guards by the validated engine and preserves availability failures', async t => {
  let service;
  const f = await fixture(t, () => service?.close()), src = await f.imageSet('source'), requests = [];
  let engineState = 'ready', engineResult = { ok: true };
  const runtime = {
    async start() {},
    async request(method, path, options) {
      requests.push({ method, path, body: options?.body });
      if (path === '/api/config/validate-import') return { result: 'ok', config: options.body.config };
      if (path.endsWith('/status')) return { state: engineState, reason: 'engine not installed' };
      if (path.endsWith('/preflight')) return engineResult;
      throw new Error('unexpected request: ' + path);
    },
  };
  service = new LoraTraining({ store: { module: () => ({ config: {} }) }, dataDir: join(f.root, 'profile'), runtime });
  const input = { model_train_type: 'moss-image-anima-lora', src, output_dir: join(f.root, 'output') };
  const result = await service.preflight(input);
  assert.equal(result.engine, 'moss'); assert.equal(result.training_started, false);
  assert.equal(requests.at(-1).path, '/api/engines/moss/preflight');
  assert.deepEqual(requests.at(-1).body, input);
  engineState = 'not_installed';
  await assert.rejects(service.preflight(input), /尚未就绪/);
  engineState = 'ready'; engineResult = { ok: false, errors: ['metadata image rejected by actual engine'] };
  await assert.rejects(service.preflight(input), /metadata image rejected/);
  assert.ok(requests.every(request => request.path !== '/api/run'));
});
