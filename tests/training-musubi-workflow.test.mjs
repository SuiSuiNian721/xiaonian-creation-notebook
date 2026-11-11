import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { protectDataset } from '../framework/training.mjs';
import { prepareWorkflowTrainingConfig } from '../framework/training-workflow-config.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const layoutPath = workspace => join(workspace, 'musubi-dataset-' + digest(resolve(workspace)).slice(0, 16));
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'musubi-workflow-'));
  t.after(async () => { assert.ok(resolve(workspace).startsWith(resolve(tmpdir()) + sep)); await rm(workspace, { recursive: true, force: true }); });
  const imageDir = join(workspace, 'images'), items = [];
  for (const kind of ['original', 'derived']) {
    const folder = kind === 'original' ? 'originals' : 'crops'; await mkdir(join(imageDir, folder), { recursive: true });
    const name = folder + '/000001.png', bytes = 'controlled-' + kind, caption = 'A portrait of a character, ' + kind + '.\n';
    await writeFile(join(imageDir, name), bytes); await writeFile(join(imageDir, folder, '000001.txt'), caption);
    items.push({ name, kind, sha256: digest(bytes), captionSha256: digest(caption), captionImageSha256: digest(bytes), captionFormat: 'natural', requiresCaption: false });
  }
  const dataset = { format: 2, owner: 'fixture-owner', workspace, imageDir, derivedCount: 1, items };
  const manifest = JSON.stringify(dataset); await writeFile(join(workspace, 'dataset-manifest.json'), manifest);
  const options = { engine: 'musubi', dataset, summary: {}, plan: { repeats: 7, strategy: { cropMode: 'character', cropRepeatScale: 0.5 } }, config: { model_train_type: 'krea2-lora', train_data_dir: 'old-source', dataset_config: 'ignored-toml', gradient_accumulation_steps: 3 } };
  return { workspace, dataset, manifest, options };
}

test('Musubi receives repeat directories with independent original/crop weights and unchanged verified source manifest', async t => {
  const f = await fixture(t), result = await prepareWorkflowTrainingConfig(f.options);
  assert.equal(result.train_data_dir, layoutPath(f.workspace));
  assert.equal(result.dataset_config, undefined); assert.equal(result.dataset_repeats, undefined);
  assert.equal(result.gradient_accumulation_steps, 3); assert.equal(result.caption_extension, '.txt');
  assert.deepEqual((await readdir(result.train_data_dir)).sort(), ['3_derived', '7_original', 'layout-manifest.json']);
  await protectDataset(result, { engine: 'musubi' });
  assert.equal(await readFile(join(f.workspace, 'dataset-manifest.json'), 'utf8'), f.manifest);
  for (const item of f.dataset.items) assert.equal(digest(await readFile(join(f.dataset.imageDir, item.name))), item.sha256);
  const layout = JSON.parse(await readFile(join(result.train_data_dir, 'layout-manifest.json'), 'utf8'));
  assert.equal(layout.files.length, 2);
  for (const file of layout.files) {
    assert.equal(digest(await readFile(join(result.train_data_dir, file.image))), file.imageSha256);
    assert.equal(digest(await readFile(join(result.train_data_dir, file.caption))), file.captionSha256);
  }
  const second = await prepareWorkflowTrainingConfig(f.options);
  assert.equal(second.train_data_dir, result.train_data_dir);
  assert.deepEqual((await readdir(f.workspace)).sort(), ['dataset-manifest.json', 'images', basename(result.train_data_dir)]);
});

test('Musubi layout preparation rejects changed captions, links, and a forged reused layout', async t => {
  const f = await fixture(t), first = f.dataset.items[0];
  await writeFile(join(f.dataset.imageDir, 'originals', '000001.txt'), 'changed caption');
  await assert.rejects(prepareWorkflowTrainingConfig(f.options), /标注|校验/);
  await writeFile(join(f.dataset.imageDir, 'originals', '000001.txt'), 'A portrait of a character, original.\n');
  const result = await prepareWorkflowTrainingConfig(f.options);
  const layout = JSON.parse(await readFile(join(result.train_data_dir, 'layout-manifest.json'), 'utf8'));
  await writeFile(join(result.train_data_dir, layout.files[0].image), 'tampered-copy');
  await assert.rejects(prepareWorkflowTrainingConfig(f.options), /校验|改变/);
  assert.equal(digest(await readFile(join(f.dataset.imageDir, first.name))), first.sha256);
  const linked = join(f.workspace, 'linked'); await symlink(f.dataset.imageDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareWorkflowTrainingConfig({ ...f.options, dataset: { ...f.dataset, imageDir: linked } }), /链接|联接/);
});

test('Musubi preparation honours cancellation before creating any layout', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(prepareWorkflowTrainingConfig({ ...f.options, signal: controller.signal }), /abort/i);
  assert.deepEqual((await readdir(f.workspace)).sort(), ['dataset-manifest.json', 'images']);
});

test('Musubi never overwrites an existing unrelated layout directory', async t => {
  const f = await fixture(t), target = layoutPath(f.workspace);
  await mkdir(target); await writeFile(join(target, 'keep.txt'), 'user content');
  await assert.rejects(prepareWorkflowTrainingConfig(f.options), /缺少布局清单|不能复用|覆盖/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'user content');
  assert.deepEqual((await readdir(f.workspace)).sort(), ['dataset-manifest.json', 'images', basename(target)]);
});

test('independent Musubi workflows have distinct native dataset cache slugs', async t => {
  const first = await fixture(t), second = await fixture(t);
  const a = await prepareWorkflowTrainingConfig(first.options), b = await prepareWorkflowTrainingConfig(second.options);
  assert.notEqual(basename(a.train_data_dir), basename(b.train_data_dir));
});

test('actual bundled Musubi adapter reads the prepared repeat groups without importing a training/ML runtime', { skip: !process.env.NEXT_TRAINER_TEST_PYTHON, timeout: 20000 }, async t => {
  const f = await fixture(t), config = await prepareWorkflowTrainingConfig(f.options);
  const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
  const child = spawn(process.env.NEXT_TRAINER_TEST_PYTHON, ['-X', 'utf8', '-B', '-c', `
import json, pathlib, runpy, sys, types
integration = pathlib.Path(sys.argv[1]); root = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(integration / 'source'))
from mikazuki.engines.musubi.adapter import build_dataset_config
config = json.load(sys.stdin)
guard = runpy.run_path(str(integration / 'runner.py'))['protect_dataset']
guard(config, 'musubi')
result = build_dataset_config(config, types.SimpleNamespace(lora_next_root=root, cache_dir=root / 'native-cache'))
facts = sorted((pathlib.Path(item['image_directory']).name, item['num_repeats'], len(list(pathlib.Path(item['image_directory']).glob('*.png')))) for item in result['datasets'])
assert facts == [('3_derived', 3, 1), ('7_original', 7, 1)], facts
assert 'torch' not in sys.modules and 'transformers' not in sys.modules
print(json.dumps({'datasets': facts, 'training_started': False, 'ml_imported': False}))
`, integration, f.workspace], { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end(JSON.stringify(config));
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert.equal(code, 0, output);
  const facts = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(facts.datasets, [['3_derived', 3, 1], ['7_original', 7, 1]]);
  assert.equal(facts.training_started, false); assert.equal(facts.ml_imported, false);
  assert.equal(await readFile(join(f.workspace, 'dataset-manifest.json'), 'utf8'), f.manifest);
});
