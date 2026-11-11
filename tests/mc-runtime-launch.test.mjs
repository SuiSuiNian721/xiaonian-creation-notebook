import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep, toNamespacedPath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuildSource = join(root, `integrations/airi-minecraft/node_modules/@esbuild/win32-${process.arch}/esbuild.exe`);

test('MC 启动配置保留短 Node 路径与环境白名单，并固定组件自己的 esbuild', async () => {
  const { minecraftRuntimeLaunch } = await import('../framework/mc-runtime-launch.mjs').catch(() => ({}));
  assert.equal(typeof minecraftRuntimeLaunch, 'function', '需要共用的 MC 启动配置');
  const runtimeRoot = resolve(tmpdir(), 'mc-launch-fixture'), cwd = resolve(tmpdir(), 'mc-profile');
  const environment = { PATH: 'fixture-path', SystemRoot: 'fixture-system', TEMP: 'fixture-temp', TMP: 'fixture-tmp', USERPROFILE: 'fixture-user', NODE_OPTIONS: '--invalid', OPENAI_API_KEY: 'do-not-forward', ESBUILD_BINARY_PATH: 'untrusted-binary' };
  const launch = minecraftRuntimeLaunch({ runtimeRoot, nodePath: process.execPath, cwd, args: ['--self-test'], environment });
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, ['--no-node-snapshot', join(runtimeRoot, 'worker.mjs'), '--self-test']);
  assert.equal(launch.options.cwd, cwd); assert.equal(launch.options.windowsHide, true);
  for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']) assert.equal(launch.options.env[key], environment[key]);
  assert.equal(launch.options.env.NODE_OPTIONS, undefined); assert.equal(launch.options.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.options.env.ESBUILD_BINARY_PATH, process.platform === 'win32' ? toNamespacedPath(join(runtimeRoot, `node_modules/@esbuild/win32-${process.arch}/esbuild.exe`)) : undefined);
});

test('Windows 实际长路径 Node 与 esbuild 子进程能够启动并完成转换', { skip: process.platform !== 'win32' || !existsSync(esbuildSource), timeout: 30000 }, async () => {
  const { minecraftRuntimeLaunch } = await import('../framework/mc-runtime-launch.mjs').catch(() => ({}));
  assert.equal(typeof minecraftRuntimeLaunch, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'mc-long-launch-'));
  try {
    const runtimeRoot = join(directory, 'component-' + 'x'.repeat(140), 'snapshot-' + 'y'.repeat(80));
    const nodePath = join(runtimeRoot, 'runtime/node.exe');
    const esbuild = join(runtimeRoot, `node_modules/@esbuild/win32-${process.arch}/esbuild.exe`);
    assert.ok(nodePath.length > 260); assert.ok(esbuild.length > 260);
    await mkdir(dirname(nodePath), { recursive: true }); await mkdir(dirname(esbuild), { recursive: true });
    await copyFile(process.execPath, nodePath); await copyFile(esbuildSource, esbuild);
    const moduleUrl = pathToFileURL(join(root, 'integrations/airi-minecraft/node_modules/esbuild/lib/main.js')).href;
    await writeFile(join(runtimeRoot, 'worker.mjs'), `import {transform} from ${JSON.stringify(moduleUrl)};\nconst result=await transform('const answer: number = 42',{loader:'ts'});\nif(!result.code.includes('42'))throw Error('transform failed');\nconsole.log('LONG_PATH_TRANSFORM_OK');\n`, 'utf8');
    const launch = minecraftRuntimeLaunch({ runtimeRoot, nodePath, cwd: runtimeRoot, args: ['--self-test'] });
    const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /LONG_PATH_TRANSFORM_OK/);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
