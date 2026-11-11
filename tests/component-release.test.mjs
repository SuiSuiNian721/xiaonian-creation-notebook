import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { extractComponentArchive } from '../framework/component-archive.mjs';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'component-release-'));
  const put = async (path, content) => { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content); };
  await put('integrations/airi-minecraft/package.json', JSON.stringify({ type: 'module', version: '0.15.1-test', dependencies: { typescript: '6' } }));
  await put('integrations/airi-minecraft/package-lock.json', '{}');
  await put('integrations/airi-minecraft/source-manifest.json', '{"commit":"minecraft-source"}');
  await put('integrations/airi-minecraft/skin-application.mjs', 'export const skinProtocol = 1;');
  await put('integrations/airi-minecraft/worker.mjs', "import {readFileSync} from 'node:fs'; if(!process.argv.includes('--self-test')) throw Error('self test required'); for(const path of ['node_modules/typescript/lib/typescript.js','node_modules/minecraft-data/minecraft-data/data/bedrock/item.json']) readFileSync(new URL(path,import.meta.url)); console.log(JSON.stringify({ok:true,isolatedPlanner:true}));");
  await put('integrations/airi-minecraft/upstream/src/main.ts', 'export const upstream = true;');
  await put('integrations/airi-minecraft/node_modules/typescript/lib/typescript.js', 'export const compiler = true;');
  await put('integrations/airi-minecraft/node_modules/minecraft-data/minecraft-data/data/bedrock/item.json', '{}');
  await put('integrations/airi-minecraft/node_modules/unused/test/a.js', 'test');
  await put('integrations/airi-minecraft/node_modules/unused/debug.map', '{}');
  await put('integrations/airi-minecraft/node_modules/unused/source.tgz', 'archive');
  const source = Buffer.from('print("training kernel")');
  await put('integrations/next-trainer/source/main.py', source);
  await put('integrations/next-trainer/source-manifest.json', JSON.stringify({ format: 1, version: '3.3.1-test', kernelRevision: 'kernel', source: { commit: 'trainer-source' }, files: [{ path: 'main.py', size: source.length, sha256: createHash('sha256').update(source).digest('hex') }] }));
  await put('integrations/next-trainer/runner.py', 'print("adapter")');
  await put('integrations/next-trainer/source/__pycache__/main.pyc', 'cache');
  return { root, put };
}

test('发布器生成可提取目录，保留运行时依赖，并以实际内容变更组件版本', async () => {
  const release = await import('../tools/package-components.mjs').catch(() => ({}));
  assert.equal(typeof release.buildComponentPackages, 'function', '需要可调用的独立组件发布器');
  const { root, put } = await fixture();
  try {
    const first = await release.buildComponentPackages({ root });
    assert.equal(first.catalog.format, 1);
    assert.deepEqual(Object.keys(first.catalog.components).sort(), ['mc-play', 'training']);
    assert.deepEqual(JSON.parse(await readFile(first.catalogPath, 'utf8')), first.catalog);
    const mc = first.catalog.components['mc-play'];
    const manifest = await extractComponentArchive({ archive: resolve(first.output, mc.file), directory: resolve(root, 'mc-extracted'), descriptor: mc });
    const paths = new Set(manifest.files.map(file => file.path));
    for (const path of ['worker.mjs', 'skin-application.mjs', 'runtime/node.exe', 'upstream/src/main.ts', 'node_modules/typescript/lib/typescript.js', 'node_modules/minecraft-data/minecraft-data/data/bedrock/item.json']) assert.ok(paths.has(path), path);
    assert.ok(![...paths].some(path => /\.tgz$|\.map$|\/test\//.test(path)));
    const training = first.catalog.components.training;
    const trainManifest = await extractComponentArchive({ archive: resolve(first.output, training.file), directory: resolve(root, 'training-extracted'), descriptor: training });
    assert.ok(trainManifest.files.some(file => file.path === 'runner.py'));
    assert.ok(!trainManifest.files.some(file => file.path.includes('__pycache__') || file.path.endsWith('.pyc')));
    const dependencies = resolve(root, 'integrations/airi-minecraft/node_modules');
    await rename(dependencies, resolve(root, 'shared-dependencies'));
    await symlink(resolve(root, 'shared-dependencies'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
    await put('integrations/next-trainer/runner.py', 'print("changed adapter")');
    const second = await release.buildComponentPackages({ root });
    assert.equal(second.catalog.components['mc-play'].version, mc.version);
    assert.notEqual(second.catalog.components.training.version, training.version);
    assert.ok((await readFile(resolve(first.output, training.file))).length > 0, '保留旧发布文件');
    await put('integrations/airi-minecraft/worker.mjs', 'process.exit(9);');
    await assert.rejects(release.buildComponentPackages({ root }), /自检/);
    assert.deepEqual(JSON.parse(await readFile(first.catalogPath, 'utf8')), second.catalog, '失败发布不替换有效目录');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('发布前拒绝与训练来源清单不符的内核', async () => {
  const { buildComponentPackages } = await import('../tools/package-components.mjs');
  const { root, put } = await fixture();
  try {
    await put('integrations/next-trainer/source/main.py', 'changed');
    await assert.rejects(buildComponentPackages({ root }), /哈希校验失败/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('组件构建拒绝 node_modules 内部链接', async () => {
  const release = await import('../tools/package-components.mjs').catch(() => ({}));
  assert.equal(typeof release.buildComponentPackages, 'function');
  const { root } = await fixture();
  try {
    await symlink(resolve(root, 'integrations/next-trainer'), resolve(root, 'integrations/airi-minecraft/node_modules/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(release.buildComponentPackages({ root }), /链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
