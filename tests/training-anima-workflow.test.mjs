import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { protectDataset } from '../framework/training.mjs';
import { prepareWorkflowTrainingConfig } from '../framework/training-workflow-config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, character) {
  const workspace = await mkdtemp(join(tmpdir(), 'anima-workflow-'));
  t.after(async () => { assert.ok(resolve(workspace).startsWith(resolve(tmpdir()) + sep)); await rm(workspace, { recursive: true, force: true }); });
  const imageDir = join(workspace, 'images'); await mkdir(join(imageDir, 'originals'), { recursive: true });
  const name = 'originals/000001.png', caption = 'A portrait of ' + character + '.';
  await writeFile(join(imageDir, name), character); await writeFile(join(imageDir, 'originals/000001.txt'), caption);
  const dataset = { format: 2, workspace, imageDir, derivedCount: 0, items: [{ name, kind: 'original', sha256: hash(character), captionSha256: hash(caption) }] };
  const manifest = JSON.stringify(dataset); await writeFile(join(workspace, 'dataset-manifest.json'), manifest);
  return { workspace, manifest, options: { engine: 'anima-fast', dataset, summary: {}, plan: { repeats: 5, strategy: { cropMode: 'preserve' } }, config: { model_train_type: 'anima-lora-fast', resized_image_dir: 'old-resized', lora_cache_dir: 'old-cache', output_dir: join(workspace, 'output'), output_name: character, resolution: '512,512' } } };
}

test('Anima Fast workflows isolate the source/cache basename while retaining native automatic resizing', async t => {
  const a = await fixture(t, 'character-a'), b = await fixture(t, 'character-b');
  const ca = await prepareWorkflowTrainingConfig(a.options), cb = await prepareWorkflowTrainingConfig(b.options);
  assert.notEqual(basename(ca.source_image_dir), basename(cb.source_image_dir));
  assert.notEqual(ca.lora_cache_dir, cb.lora_cache_dir);
  for (const [f, config] of [[a, ca], [b, cb]]) {
    assert.equal(config.train_data_dir, config.source_image_dir);
    assert.equal(config.resized_image_dir, undefined, 'an explicit resized directory disables native auto-resize');
    assert.equal(config.lora_cache_dir, join(f.workspace, 'anima-fast-cache', 'lora'));
    await protectDataset(config, { engine: 'anima-fast' });
    assert.deepEqual((await readdir(config.source_image_dir)).sort(), ['layout-manifest.json', 'original']);
    assert.equal(await readFile(join(f.workspace, 'dataset-manifest.json'), 'utf8'), f.manifest);
    assert.equal((await prepareWorkflowTrainingConfig(f.options)).source_image_dir, config.source_image_dir);
  }
});

test('actual Anima adapter/preprocess resizes two same-named inputs independently and never reuses the other character', { skip: !process.env.NEXT_TRAINER_TEST_PYTHON, timeout: 20000 }, async t => {
  const a = await fixture(t, 'character-a'), b = await fixture(t, 'character-b');
  const configs = [await prepareWorkflowTrainingConfig(a.options), await prepareWorkflowTrainingConfig(b.options)];
  const integration = fileURLToPath(new URL('../integrations/next-trainer/', import.meta.url));
  const child = spawn(process.env.NEXT_TRAINER_TEST_PYTHON, ['-X', 'utf8', '-B', '-c', `
import json, pathlib, runpy, shutil, sys
integration = pathlib.Path(sys.argv[1]); root = pathlib.Path(sys.argv[2]) / 'kernel'
sys.path.insert(0, str(integration / 'source'))
from mikazuki.engines.anima_fast.settings import RuntimeConfig
from mikazuki.engines.anima_fast.adapter import adapt_config
from mikazuki.engines.anima_fast import preprocess
configs = json.load(sys.stdin)
runtime = RuntimeConfig(anima_root=root / 'anima', python=pathlib.Path(sys.executable), lora_next_root=root,
                        output_dir=root / 'output', logging_dir=root / 'logs', cache_dir=root / '.cache' / 'anima_fast')
resize_calls = []
def copy_resize(runtime, src, dst, resolution):
    resize_calls.append((str(src), str(dst)))
    shutil.copytree(src, dst, dirs_exist_ok=True)
preprocess.run_resize_images = copy_resize
guard = runpy.run_path(str(integration / 'runner.py'))['protect_dataset']
results = []
for index, config in enumerate(configs):
    guard(config, 'anima-fast')
    adapted = adapt_config(config, runtime, f'fixture-{index}')
    assert preprocess.user_left_resized_empty(config)
    prepared = preprocess.prepare_anima_fast_dataset(config, runtime, f'fixture-{index}')
    result = pathlib.Path(prepared.adapted.values['resized_image_dir'])
    results.append({'resized': str(result), 'lora': prepared.adapted.values['lora_cache_dir'],
                    'bytes': next(result.rglob('*.png')).read_text(), 'auto_resized': prepared.auto_resized})
assert len(resize_calls) == 2, resize_calls
assert results[0]['resized'] != results[1]['resized'] and results[0]['lora'] != results[1]['lora'], results
assert [item['bytes'] for item in results] == ['character-a', 'character-b'], results
assert all(item['auto_resized'] for item in results)
assert 'torch' not in sys.modules and 'transformers' not in sys.modules
print(json.dumps({'resize_count': len(resize_calls), 'characters': [item['bytes'] for item in results], 'training_started': False}))
`, integration, a.workspace], { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1' } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  child.stdin.end(JSON.stringify(configs));
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert.equal(code, 0, output);
  const facts = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.equal(facts.resize_count, 2); assert.deepEqual(facts.characters, ['character-a', 'character-b']);
});
