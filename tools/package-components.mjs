import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { assertOrdinaryComponentPath, createComponentArchive, extractComponentArchive, hashComponentFile } from '../framework/component-archive.mjs';
import { verifyKernel } from '../framework/training-runtime.mjs';
import { minecraftRuntimeLaunch } from '../framework/mc-runtime-launch.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pythonFilter = path => !path.split('/').includes('__pycache__') && !path.endsWith('.pyc');
const minecraftFilter = path => !path.split('/').some(part => ['.git', 'test', 'tests', '__tests__'].includes(part)) && !/\.(?:map|tgz)$|\.test\.ts$/.test(path);

// Explicit source roots may be junctions (the worktrees share node_modules).
// Descendants must be ordinary files/directories, including during hashing.
async function contentRevision(sources, filter) {
  const entries = [];
  async function walk(source, path) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error('组件源文件包含链接：' + source);
    if (info.isDirectory()) {
      for (const name of (await readdir(source)).sort()) {
        const child = path ? path + '/' + name : name;
        if (filter(child)) await walk(resolve(source, name), child);
      }
    } else if (info.isFile()) entries.push([path, info.size, await hashComponentFile(source)]);
    else throw new Error('组件源文件类型无效：' + source);
  }
  for (const source of sources) await walk(await realpath(source.from), source.to || '');
  entries.sort((first, second) => first[0].localeCompare(second[0], 'en'));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function minecraftSources(root, nodePath) {
  const directory = resolve(root, 'integrations/airi-minecraft');
  const names = ['worker.mjs', 'skin-application.mjs', 'package.json', 'package-lock.json', 'source-manifest.json', 'upstream', 'node_modules'];
  for (const name of await readdir(directory)) if (['adaptations.json', 'README.md'].includes(name) || /^LICENSE(?:\.|$)/.test(name)) names.push(name);
  return [...names.map(name => ({ from: resolve(directory, name), to: name })), { from: nodePath, to: 'runtime/node.exe' }];
}

export async function buildComponentPackages({ root = projectRoot, output, nodePath = process.execPath } = {}) {
  root = resolve(root);
  output = resolve(root, output || 'artifacts/optional-components');
  await assertOrdinaryComponentPath(output, { allowMissing: true });
  nodePath = resolve(nodePath);
  const trainingRoot = resolve(root, 'integrations/next-trainer');
  const trainingManifest = await verifyKernel(trainingRoot);
  const minecraftPackage = JSON.parse(await readFile(resolve(root, 'integrations/airi-minecraft/package.json'), 'utf8'));
  const minecraftSource = JSON.parse(await readFile(resolve(root, 'integrations/airi-minecraft/source-manifest.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(resolve(output, '.build-'));
  const components = {};
  try {
    const definitions = [
      { id: 'mc-play', name: 'Minecraft 陪玩运行端', baseVersion: minecraftPackage.version,
        sources: await minecraftSources(root, nodePath), filter: minecraftFilter,
        metadata: { sourceCommit: minecraftSource.commit } },
      { id: 'training', name: '训练源码组件', baseVersion: trainingManifest.version,
        sources: [{ from: trainingRoot, to: '' }], filter: pythonFilter,
        metadata: { sourceCommit: trainingManifest.source?.commit, kernelRevision: trainingManifest.kernelRevision } },
    ];
    for (const definition of definitions) {
      if (typeof definition.baseVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,98}$/.test(definition.baseVersion)) throw new Error('组件基础版本无效：' + definition.id);
      const contentSha256 = await contentRevision(definition.sources, definition.filter);
      const version = `${definition.baseVersion.replaceAll('+', '-')}-${contentSha256.slice(0, 20)}`;
      const filename = `${definition.id}-${version}-${process.platform}-${process.arch}.afcomponent`;
      const archive = resolve(staging, filename);
      const descriptor = await createComponentArchive({ ...definition, version, output: archive, metadata: { ...definition.metadata, contentSha256 } });
      const extracted = resolve(staging, definition.id);
      const manifest = await extractComponentArchive({ archive, directory: extracted, descriptor });
      const packedRevision = createHash('sha256').update(JSON.stringify(manifest.files.map(file => [file.path, file.size, file.sha256]))).digest('hex');
      if (packedRevision !== contentSha256) throw new Error('组件源文件在发布过程中发生变化，请重试：' + definition.id);
      if (definition.id === 'mc-play') {
        const launch = minecraftRuntimeLaunch({ runtimeRoot: extracted, nodePath: resolve(extracted, 'runtime/node.exe'), args: ['--self-test'] });
        const check = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8', timeout: 60000 });
        if (check.status !== 0) throw new Error('组件包内 AIRI Minecraft 自检失败：' + (check.stderr || check.error?.message || check.stdout || check.status));
      } else await verifyKernel(extracted);
      components[definition.id] = descriptor;
    }
    // Publish immutable archives only after both extracted components validate.
    for (const descriptor of Object.values(components)) {
      const destination = resolve(output, descriptor.file);
      try {
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink() || await hashComponentFile(destination) !== descriptor.sha256) throw new Error('已发布组件文件冲突：' + destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await rename(resolve(staging, descriptor.file), destination);
      }
    }
    const catalog = { format: 1, components };
    const catalogPath = resolve(output, 'catalog.json');
    const temporary = resolve(staging, `catalog-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(temporary, catalogPath);
    return { catalog, catalogPath, output };
  } finally {
    // mkdtemp owns this new child; no source or previous release is removed.
    const child = relative(output, staging);
    if (!child.startsWith('.build-') || child.includes(sep) || isAbsolute(child)) throw new Error('组件构建暂存目录超出输出范围。');
    await assertOrdinaryComponentPath(staging);
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' }, node: { type: 'string' } } });
  const result = await buildComponentPackages({ root: values.root || projectRoot, output: values.output || process.env.AI_FUTURE_COMPONENT_OUTPUT, nodePath: values.node || process.execPath });
  console.log(JSON.stringify(result, null, 2));
}
