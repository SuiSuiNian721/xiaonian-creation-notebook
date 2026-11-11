import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launcher = new URL('../tools/launch-workbench-preview.mjs', import.meta.url).href;

for (const route of ['companion', '']) test(`启动器退出后，${route || '工作台首页'}程序仍能记录日志并保留隔离环境`, { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-future-preview-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const completed = join(directory, 'completed.json');
  const childScript = `
    setTimeout(() => {
      console.info('preview stdout survived');
      console.error('preview stderr survived');
      require('node:fs').writeFileSync(${JSON.stringify(completed)}, JSON.stringify({
        profile:process.env.AI_FUTURE_WORKBENCH_PROFILE_DIR,
        route:process.env.AI_FUTURE_WORKBENCH_INITIAL_ROUTE,
        qa:process.env.AI_FUTURE_WORKBENCH_QA,
        suite:process.env.AI_FUTURE_WORKBENCH_QA_SUITE,
        electronNode:process.env.ELECTRON_RUN_AS_NODE
      }));
    }, 500);
  `;
  const parentScript = `
    const {launchDetachedPreview} = await import(${JSON.stringify(launcher)});
    const result = await launchDetachedPreview({executable:process.execPath,args:['-e',${JSON.stringify(childScript)}],profileDirectory:${JSON.stringify(directory)},initialRoute:${JSON.stringify(route)}});
    console.log(JSON.stringify(result));
  `;
  const parent = spawnSync(process.execPath, ['--input-type=module', '-e', parentScript], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
    env: { ...process.env, AI_FUTURE_WORKBENCH_QA: '1', AI_FUTURE_WORKBENCH_QA_SUITE: 'companion', ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal(parent.status, 0, parent.stderr || parent.error?.message);
  const result = JSON.parse(parent.stdout);
  const deadline = Date.now() + 5000;
  while (!existsSync(completed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(completed), '启动器退出后，子进程必须继续完成工作');
  assert.deepEqual(JSON.parse(readFileSync(completed, 'utf8')), { profile: directory, route });
  assert.match(readFileSync(result.stdout, 'utf8'), /preview stdout survived/);
  assert.match(readFileSync(result.stderr, 'utf8'), /preview stderr survived/);
});
