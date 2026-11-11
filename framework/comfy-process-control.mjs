import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError, fields } from './contracts.mjs';

const script = fileURLToPath(new URL('../tools/ComfyUI-ProcessControl.ps1', import.meta.url));
const identityTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;
const hashPattern = /^[a-f0-9]{64}$/;
const localExecutable = value => typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[\u0000-\u001f\u007f]/.test(value) && !value.slice(2).includes(':') && value.length <= 4096;
const samePath = (left, right) => win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
const validPid = value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
const validTime = value => typeof value === 'string' && identityTime.test(value) && Number.isFinite(Date.parse(value));
const validHash = value => typeof value === 'string' && hashPattern.test(value);

function request(value, action, platform) {
  if (platform !== 'win32') throw new WorkbenchError(503, '当前平台暂不支持核验和停止已连接的本机 ComfyUI 进程。');
  fields(value, action === 'stop' ? ['port', 'executable', 'pid', 'startedAt', 'commandHash'] : ['port', 'executable']);
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new WorkbenchError(400, 'ComfyUI 端口必须为 1 到 65535 的整数。');
  if (!localExecutable(value.executable)) throw new WorkbenchError(400, 'ComfyUI Python 须为普通本地磁盘的绝对路径。');
  if (action === 'stop' && (!validPid(value.pid) || !validTime(value.startedAt) || !validHash(value.commandHash))) throw new WorkbenchError(400, '停止操作需要完整的本机 ComfyUI 进程核验快照。');
  return { action, ...value };
}

function runPowerShell(value) {
  return new Promise((resolveResult, reject) => {
    const child = execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      try { resolveResult(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
      catch { reject(new WorkbenchError(503, error?.killed ? '进程核验超时，尚未确认停止；请刷新服务状态后再核对。' : `无法运行 ComfyUI 进程核验，请确认 PowerShell 7 可用${error?.code === 'ENOENT' ? '。' : '，或当前账户有权读取该进程。'}`)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(value));
  });
}

async function execute(value, action, { runner = runPowerShell, platform = process.platform } = {}) {
  const input = request(value, action, platform);
  let reply;
  try { reply = await runner(input); }
  catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError(503, '无法完成 ComfyUI 进程核验，尚未确认停止。'); }
  if (reply?.ok !== true) {
    const failure = reply?.error;
    throw new WorkbenchError([400, 409, 422, 503].includes(failure?.status) ? failure.status : 503, typeof failure?.message === 'string' ? failure.message.slice(0, 1600) : '操作系统没有返回有效的 ComfyUI 进程核验结果。');
  }
  return reply.result;
}

// Callers must first verify that their loopback URL is the connected ComfyUI service.
// Relative main.py identifies the entry argument, never the process working directory.
export async function inspectLocalComfyProcess(value, options) {
  const result = await execute(value, 'inspect', options);
  if (!validPid(result?.pid) || !localExecutable(result?.executable) || !samePath(result.executable, value.executable) || !validTime(result.startedAt) || !validHash(result.commandHash) || !Array.isArray(result.args) || result.args.length > 1024 || result.args.some(arg => typeof arg !== 'string' || arg.length > 32768)) throw new WorkbenchError(503, '操作系统返回的 ComfyUI 进程身份不完整或解释器不匹配，不能停止。');
  return { pid: result.pid, startedAt: result.startedAt, executable: result.executable, args: result.args, commandHash: result.commandHash };
}

export async function stopLocalComfyProcess(value, options) {
  const result = await execute(value, 'stop', options);
  if (result?.stopped !== true || result.pid !== value.pid) throw new WorkbenchError(503, '操作系统尚未确认指定的 ComfyUI 进程已经退出。');
  return { stopped: true, pid: result.pid };
}
