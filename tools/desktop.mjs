import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aurora = process.argv.includes('--aurora');
const candidates = [process.env.AI_FUTURE_ELECTRON, resolve(root, 'node_modules/electron/dist/electron.exe'), 'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean);
const executable = candidates.find(existsSync);
if (!executable) throw new Error('未找到 Electron。安装 electron 开发依赖，或将 AI_FUTURE_ELECTRON 设置为 electron.exe 的完整路径。');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AI_FUTURE_VARIANT;
if (process.argv.includes('--qa')) {
  env.AI_FUTURE_QA = '1';
  env.AI_FUTURE_QA_DIR ||= resolve(root, 'qa', new Date().toISOString().replace(/[:.]/g, '-'));
  console.log(`隔离验证目录：${env.AI_FUTURE_QA_DIR}`);
}
const entry = aurora ? resolve(root, 'desktop/main-aurora.cjs') : root;
const child = spawn(executable, [entry], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
