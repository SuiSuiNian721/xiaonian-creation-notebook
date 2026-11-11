import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function launchDetachedPreview({ executable, args = [], profileDirectory, initialRoute = 'companion' }) {
  const profile = resolve(profileDirectory);
  const logs = join(profile, 'logs');
  mkdirSync(logs, { recursive: true });
  const session = `preview-${Date.now()}-${process.pid}`;
  const stdout = join(logs, `${session}-stdout.log`);
  const stderr = join(logs, `${session}-stderr.log`);
  const env = { ...process.env, AI_FUTURE_WORKBENCH_PROFILE_DIR: profile, AI_FUTURE_WORKBENCH_INITIAL_ROUTE: initialRoute };
  for (const key of ['AI_FUTURE_WORKBENCH_QA', 'AI_FUTURE_WORKBENCH_QA_SUITE', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const descriptors = [];
  try {
    descriptors.push(openSync(stdout, 'a'));
    descriptors.push(openSync(stderr, 'a'));
    // 子进程直接继承文件句柄，启动终端关闭后不再依赖它转发日志。
    const child = spawn(resolve(executable), args, {
      cwd: dirname(resolve(executable)), env, detached: true, windowsHide: true,
      stdio: ['ignore', ...descriptors],
    });
    await new Promise((ready, reject) => { child.once('spawn', ready); child.once('error', reject); });
    child.unref();
    return { pid: child.pid, stdout, stderr };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [executable, profileDirectory] = process.argv.slice(2);
  if (!executable || !profileDirectory) throw new Error('请指定预览程序和隔离资料目录。');
  console.log(JSON.stringify(await launchDetachedPreview({ executable, profileDirectory })));
}
