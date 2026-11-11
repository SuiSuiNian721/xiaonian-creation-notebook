import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matches = (file, pattern) => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*') + '$').test(file);

test('工作台打包包含桌面运行入口的全部静态相对依赖', async () => {
  const config = await import('../tools/workbench-package-config.mjs').catch(() => ({}));
  assert.ok(Array.isArray(config.WORKBENCH_FILES), '需要可独立检查的显式发布文件清单');
  const files = config.WORKBENCH_FILES;
  const pending = ['desktop/workbench.cjs', 'desktop/workbench-preload.cjs', 'desktop/companion-host.cjs'];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    assert.ok(files.some(pattern => !pattern.startsWith('!') && matches(file, pattern)), '打包遗漏桌面运行依赖：' + file);
    const contents = await readFile(resolve(root, file), 'utf8');
    for (const match of contents.matchAll(/(?:require\(\s*|from\s+|import\(\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = relative(root, resolve(root, dirname(file), match[1])).replaceAll('\\', '/');
      if (dependency.startsWith('desktop/') && /\.(?:cjs|mjs)$/.test(dependency)) {
        assert.ok((await stat(resolve(root, dependency))).isFile());
        pending.push(dependency);
      }
    }
  }
  assert.ok(visited.size >= 6);
});

test('基础发布配置只嵌入固定组件目录并排除重组件', async () => {
  const config = await import('../tools/workbench-package-config.mjs').catch(() => ({}));
  assert.equal(typeof config.createWorkbenchBuildConfig, 'function');
  const result = config.createWorkbenchBuildConfig({ root, output: resolve(root, 'dist-test'), electronDist: 'electron', electronVersion: '40.0.0', catalogPath: resolve(root, 'artifacts/optional-components/catalog.json') });
  assert.equal(result.extraMetadata.version, '1.0.0');
  assert.equal(result.extraMetadata.main, 'desktop/workbench.cjs');
  assert.deepEqual(result.extraResources.map(entry => entry.to).sort(), ['character-life-sources.md', 'component-catalog.json']);
  assert.ok(!result.files.some(pattern => !pattern.startsWith('!') && /integrations\/(?:airi-minecraft|next-trainer)/.test(pattern)));
});

test('基础包门禁拒绝重组件、大模型和超过预算的输出', async () => {
  const config = await import('../tools/workbench-package-config.mjs').catch(() => ({}));
  assert.equal(typeof config.assertBasePackage, 'function');
  const directory = await mkdtemp(resolve(tmpdir(), 'workbench-base-'));
  try {
    const app = resolve(directory, 'resources/app');
    await mkdir(app, { recursive: true });
    await writeFile(resolve(app, 'main.mjs'), 'base');
    assert.equal((await config.assertBasePackage({ directory })).bytes, 4);
    await assert.rejects(config.assertBasePackage({ directory, maxBytes: 3 }), /预算/);
    for (const path of ['resources/airi-minecraft/worker.mjs', 'resources/app/integrations/next-trainer/source/main.py', 'resources/model.safetensors', 'resources/extra.afcomponent', 'resources/runtime/node.exe']) {
      const target = resolve(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'forbidden');
      await assert.rejects(config.assertBasePackage({ directory }), /组件|模型|Node/);
      await rm(target);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
