import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { TrainingRuntime } from '../framework/training-runtime.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'training-selection-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return { directory, runtime: new TrainingRuntime({ dataDir: directory, spawnImpl: () => { throw new Error('选择环境不能启动进程'); } }) };
}

test('unselected training environment does not claim that local Python was not found', async t => {
  const { runtime } = await fixture(t);
  const state = await runtime.state({});
  assert.equal(state.status, 'unconfigured');
  assert.match(state.reason, /尚未选择.*Python/);
  assert.doesNotMatch(state.reason, /没有找到|未安装/);
});

test('invalid explicitly selected Python is reported with its path', async t => {
  const { directory, runtime } = await fixture(t);
  const pythonPath = join(directory, 'missing-python.exe');
  await assert.rejects(runtime.configuration({ pythonPath }), error => {
    assert.match(error.message, /配置的.*Python.*不存在|无法读取/);
    assert.ok(error.message.includes(pythonPath));
    return true;
  });
});

test('a selected trainer without its Python has a different actionable reason', async t => {
  const { directory, runtime } = await fixture(t);
  const trainerPath = join(directory, 'Next-Trainer');
  await mkdir(trainerPath);
  await assert.rejects(runtime.configuration({ trainerPath }), error => {
    assert.match(error.message, /所选.*训练环境.*Python/);
    assert.ok(error.message.includes(trainerPath));
    return true;
  });
});

test('selecting an existing portable trainer reuses its sibling Python without launching it', async t => {
  const { directory, runtime } = await fixture(t);
  const trainerPath = join(directory, 'portable', 'Next-Trainer');
  const pythonPath = join(directory, 'portable', 'python_embeded', 'python.exe');
  await mkdir(trainerPath, { recursive: true });
  await mkdir(join(directory, 'portable', 'python_embeded'));
  await writeFile(pythonPath, 'fixture only');
  const selected = await runtime.configuration({ trainerPath });
  assert.equal(selected.environmentRoot, trainerPath);
  assert.equal(selected.pythonPath, pythonPath);
  assert.equal((await runtime.state({ trainerPath })).status, 'stopped');
});
