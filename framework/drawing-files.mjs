import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { WorkbenchError } from './contracts.mjs';

export async function checkedLocalPath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\u0000-\u001f]/.test(value)
    || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value)) throw new WorkbenchError(400, '请使用本地磁盘的绝对路径。');
  const target = resolve(value); let current = parse(target).root;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new WorkbenchError(400, '管理目录不能经过符号链接或目录联接。'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return target;
}

export async function insideDirectory(directory, ...parts) {
  const root = await checkedLocalPath(directory); const target = resolve(root, ...parts); const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new WorkbenchError(400, '操作目标必须位于指定目录内。');
  return checkedLocalPath(target);
}

export function fileName(value) {
  if (typeof value !== 'string' || value.length > 180 || !value || value === '.' || value === '..'
    || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) || value.startsWith('.')
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new WorkbenchError(400, '文件名称不能包含路径、设备名或特殊字符。');
  return value;
}

export async function fileHash(path, signal) {
  const hash = createHash('sha256'); const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
