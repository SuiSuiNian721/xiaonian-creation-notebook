import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(new URL('../desktop/process-stdio.cjs', import.meta.url));

for (const stream of ['stdout', 'stderr']) {
  test(`启动终端关闭 ${stream} 后，日志收尾仍能完成`, { timeout: 10000 }, async t => {
    const script = `
      const fs = require('node:fs');
      if (fs.existsSync(${JSON.stringify(guardPath)})) require(${JSON.stringify(guardPath)}).installStdioGuards();
      const logger = new (require('node:console').Console)({stdout:process.stdout,stderr:process.stderr,ignoreErrors:false});
      process.send('ready');
      process.once('message', () => {
        logger.${stream === 'stdout' ? 'info' : 'error'}('logger closing');
        setImmediate(() => {
          logger.${stream === 'stdout' ? 'info' : 'error'}('logger closed');
          setImmediate(() => { process.send('survived'); process.disconnect(); });
        });
      });
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let errors = '';
    const diagnosticStream = stream === 'stdout' ? child.stderr : child.stdout;
    diagnosticStream.on('data', bytes => { errors += bytes; });
    const exited = once(child, 'exit');
    assert.equal((await once(child, 'message'))[0], 'ready');
    const pipe = child[stream];
    const closed = once(pipe, 'close');
    pipe.destroy();
    await closed;
    child.send('write');
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, errors || '日志输出到关闭的管道后，进程应正常退出');
  });
}

test('标准输出的其他错误仍保留原来的失败行为', async () => {
  const script = `
    if (require('node:fs').existsSync(${JSON.stringify(guardPath)})) require(${JSON.stringify(guardPath)}).installStdioGuards();
    process.stdout.emit('error', Object.assign(new Error('stdio disk failure'), {code:'EIO'}));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0);
  assert.match(errors, /stdio disk failure/);
});
