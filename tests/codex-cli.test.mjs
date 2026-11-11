import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { findCodexCli } = await import('../framework/codex-cli.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('普通 Windows 启动无需继承终端 PATH，使用已安装的 Codex CLI', async t => {
  assert.equal(typeof findCodexCli, 'function');
  const root = await mkdtemp(join(tmpdir(), 'ai-future-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'OpenAI/Codex/bin/old/codex.exe');
  const recent = join(root, 'OpenAI/Codex/bin/new/codex.exe');
  for (const file of [old, recent]) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'fixture'); }
  await utimes(old, new Date(0), new Date(0));
  assert.equal(findCodexCli({ platform: 'win32', env: { LOCALAPPDATA: root } }), recent);
  assert.equal(findCodexCli({ platform: 'win32', env: { LOCALAPPDATA: root, CODEX_CLI_PATH: 'explicit-cli.exe' } }), 'explicit-cli.exe');
  assert.equal(findCodexCli({ platform: 'win32', env: {} }), 'codex');
  assert.equal(findCodexCli({ platform: 'linux', env: {} }), 'codex');
});
