import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

async function fixture(t, downloadImpl) {
  const { TrainingCaptionerResources } = await import('../framework/training-captioner-resources.mjs');
  const root = await mkdtemp(join(tmpdir(), 'captioner-resources-')), settings = new Map(), calls = [];
  const service = { directory: join(root, 'training'), owner: 'fixture-owner', config: () => ({ trainerPath: join(root, 'external') }), assertOpen() {}, store: { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, structuredClone(value)), module: () => ({ enabled: true }) }, runtime: { configuration: async () => ({ pythonPath: join(root, 'python.exe'), environmentRoot: join(root, 'external') }), acquireComponent: async () => ({ path: join(root, 'component'), release: () => calls.push('release') }), start: () => assert.fail('download must not start training kernel') } };
  const resource = new TrainingCaptionerResources(service, { downloadImpl: async context => { calls.push(context.descriptor.id); return downloadImpl(context); } });
  t.after(async () => { await resource.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  return { root, service, resource, settings, calls };
}

async function assets({ descriptor, directory }) {
  for (const name of descriptor.files) {
    const path = join(directory, name); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name.endsWith('.csv') ? 'tag_id,name,category,count\n1,cat,0,1\n' : name.endsWith('tag_mapping.json') ? '{"0":{"tag":"cat","category":"General"}}' : name.endsWith('config.json') ? '{"model_type":"florence2","image_token_id":512}' : name.endsWith('.json') ? '{}' : Buffer.alloc(2048, 8));
  }
}

test('chosen captioner prepares only its fixed assets through Installations without starting a kernel', async t => {
  const f = await fixture(t, assets), before = await f.resource.state();
  assert.equal(before.items.length, 11); assert.equal(before.task, null); assert.deepEqual(f.calls, []);
  const started = await f.resource.prepare({ captionerId: 'cl_tagger_1_01', downloadEndpoint: '默认' });
  assert.equal(started.task.captionerId, 'cl_tagger_1_01');
  await f.resource.wait();
  const after = await f.resource.state();
  assert.equal(after.task.status, 'completed'); assert.equal(after.task.captionerId, 'cl_tagger_1_01');
  const cl = after.items.find(item => item.id === 'cl_tagger_1_01'); assert.equal(cl.ready, true);
  assert.equal(await readFile(join(cl.modelPath, 'cl_tagger_1_01', 'tag_mapping.json'), 'utf8'), '{"0":{"tag":"cat","category":"General"}}');
  assert.equal((await f.resource.prepare({ captionerId: 'cl_tagger_1_01' })).alreadyReady, true);
  assert.deepEqual(f.calls, ['cl_tagger_1_01', 'release']);
  assert.equal(after.training_started, false); assert.equal(after.tagging_started, false);
});

test('existing external models are reused and no selected download can specify arbitrary repositories or paths', async t => {
  const f = await fixture(t, () => assert.fail('existing model must not download'));
  const directory = join(f.root, 'external', 'tagger-models', 'wd14', 'wd-vit-v3');
  await assets({ directory, descriptor: { files: ['model.onnx', 'selected_tags.csv'] } });
  assert.equal((await f.resource.prepare({ captionerId: 'wd-vit-v3' })).alreadyReady, true);
  for (const value of [{ captionerId: '../custom' }, { captionerId: 'wd-vit-v3', repo: 'someone/custom' }, { captionerId: 'wd-vit-v3', downloadEndpoint: 'https://example.com' }]) await assert.rejects(f.resource.prepare(value), /打标|参数|字段/);
  assert.deepEqual(f.calls, []);
});

test('cancel signals the adapter and blocks removal until preparation has unwound', async t => {
  let entered;
  const ready = new Promise(done => { entered = done; });
  const f = await fixture(t, ({ signal }) => new Promise((done, fail) => { entered(); signal.addEventListener('abort', () => fail(signal.reason), { once: true }); }));
  const started = await f.resource.prepare({ captionerId: 'wd14-convnextv2-v2' }); await ready;
  assert.throws(() => f.resource.assertRemovable(), /打标.*准备|下载/);
  const stopped = await f.resource.cancel({ taskId: started.task.id }); assert.equal(stopped.task.status, 'cancelled');
  await f.resource.wait(); assert.doesNotThrow(() => f.resource.assertRemovable());
  assert.equal((await f.resource.state()).items.find(item => item.id === 'wd14-convnextv2-v2').ready, false);
});

test('an invalid downloaded model never receives an installed record or a ready state', async t => {
  const f = await fixture(t, async ({ directory }) => { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'model.onnx'), 'missing tag list'); });
  await f.resource.prepare({ captionerId: 'wd-vit-v3' }); await f.resource.wait();
  const result = await f.resource.state(); assert.equal(result.task.status, 'failed');
  assert.equal(result.items.find(item => item.id === 'wd-vit-v3').ready, false);
});

test('closing waits for child exit after cancellation before releasing the component lease', async t => {
  const { downloadCaptionerAssets } = await import('../framework/training-captioner-resources.mjs');
  let child, started;
  const ready = new Promise(done => { started = done; });
  const f = await fixture(t, context => downloadCaptionerAssets({ ...context, spawnImpl: (python, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(args[2].endsWith('prepare_captioner.py'));
    child = Object.assign(new EventEmitter(), { pid: 24680, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', 1)); return true; } });
    started(); return child;
  } }));
  await f.resource.prepare({ captionerId: 'wd-vit-v3' }); await ready;
  await f.resource.close();
  assert.deepEqual(f.calls, ['wd-vit-v3', 'release']);
  assert.equal((await f.resource.state()).task.status, 'interrupted');
  assert.equal(f.resource.installations.active.size, 0);
});

test('a retain failure terminates and awaits the spawned child before returning the failure', async t => {
  const { downloadCaptionerAssets } = await import('../framework/training-captioner-resources.mjs');
  const root = await mkdtemp(join(tmpdir(), 'captioner-retain-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  let killed = false, closed = false, child;
  const controller = new AbortController();
  const spawnImpl = () => {
    child = Object.assign(new EventEmitter(), { pid: 24680, stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed = true; setTimeout(() => { closed = true; child.emit('close', 1); }, 10); return true; } });
    return child;
  };
  await assert.rejects(downloadCaptionerAssets({ descriptor: { id: 'wd-vit-v3' }, directory: join(root, 'assets'), pythonPath: 'fixture', integrationDir: root, downloadEndpoint: '默认', signal: controller.signal, report() {}, spawnImpl, onProcess() { throw new Error('retain failed'); } }), /retain failed/);
  assert.equal(killed, true); assert.equal(closed, true);
  assert.equal(child.listenerCount('error'), 0); assert.equal(child.listenerCount('close'), 0);
});

test('a spawn error without a close event rejects without hanging', { timeout: 1500 }, async t => {
  const { downloadCaptionerAssets } = await import('../framework/training-captioner-resources.mjs');
  const root = await mkdtemp(join(tmpdir(), 'captioner-spawn-error-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { return false; } });
    queueMicrotask(() => child.emit('error', new Error('spawn failed')));
    return child;
  };
  await assert.rejects(downloadCaptionerAssets({ descriptor: { id: 'wd-vit-v3' }, directory: join(root, 'assets'), pythonPath: 'fixture', integrationDir: root, signal: new AbortController().signal, report() {}, spawnImpl }), /spawn failed/);
});

test('filling a partial model preserves conflicting existing files instead of overwriting them', async t => {
  const f = await fixture(t, assets), target = join(f.service.directory, 'tagger-models', 'wd14', 'wd-vit-v3');
  await mkdir(target, { recursive: true }); await writeFile(join(target, 'model.onnx'), 'keep my data');
  await f.resource.prepare({ captionerId: 'wd-vit-v3' }); await f.resource.wait();
  assert.equal((await f.resource.state()).task.status, 'failed');
  assert.equal(await readFile(join(target, 'model.onnx'), 'utf8'), 'keep my data');
});

const python = process.env.NEXT_TRAINER_TEST_PYTHON || process.env.AI_FUTURE_TEST_PYTHON;
test('Python preparation uses fixed native asset names and Florence allowlist without model loading', { skip: !python, timeout: 20000 }, async () => {
  const child = spawn(python, ['-X', 'utf8', '-B', fileURLToPath(new URL('./test_prepare_captioner.py', import.meta.url))], { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', HF_HUB_OFFLINE: '1' } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
  assert.equal(code, 0, output); assert.match(output, /OK/);
});
