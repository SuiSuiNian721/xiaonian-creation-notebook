import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 桌面快捷方式未必继承终端 PATH；显式指定的 CLI 始终优先。
export function findCodexCli({ env = process.env, platform = process.platform } = {}) {
  if (env.CODEX_CLI_PATH) return env.CODEX_CLI_PATH;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
        const file = join(root, entry.name, 'codex.exe');
        try { const stat = statSync(file); return stat.isFile() ? [{ file, time: stat.mtimeMs }] : []; }
        catch { return []; }
      });
      candidates.sort((a, b) => b.time - a.time);
      if (candidates.length) return candidates[0].file;
    } catch { /* 未安装桌面 CLI 时继续使用 PATH 中的 codex。 */ }
  }
  return 'codex';
}
