import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertWorkspacePath, safeName } from './card.mjs';

// 输出位置由内容类型决定。客户端只能选择 PNG/JSON，不能传入磁盘路径。
function artifactTarget(root, name, targetType) {
  safeName(name);
  const sources = { card: 'cards', preset: 'presets', book: 'worldbooks' };
  if (!Object.hasOwn(sources, targetType)) throw new Error('未知成品类型');
  const source = assertWorkspacePath(root, path.join(root, sources[targetType], name));
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('对应内容不存在');
  const directory = assertWorkspacePath(root, path.join(root, 'dist', targetType === 'card' ? name : sources[targetType]));
  const files = targetType === 'card'
    ? [{ id: 'png', fileName: 'card.png' }, { id: 'json', fileName: 'card.json' }]
    : [{ id: 'json', fileName: name + '.json' }];
  return { directory, files };
}

export function listArtifactFiles(root, name, targetType, status = {}) {
  const target = artifactTarget(root, name, targetType);
  const files = target.files.flatMap((item) => {
    const file = assertWorkspacePath(root, path.join(target.directory, item.fileName));
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('成品路径不是文件：' + item.fileName);
    return [{
      ...item, downloadName: name + '.' + item.id, size: stat.size, modifiedAt: stat.mtime.toISOString(),
      url: '/api/artifact-file/' + encodeURIComponent(name) + '?targetType=' + targetType + '&file=' + item.id,
    }];
  });
  return {
    name, targetType, directory: target.directory, files,
    generatedAt: status.lastBuild || null,
    needsUpdate: status.drift === true,
    warning: status.warning || '',
    canOpenDirectory: !!process.send && process.connected === true && files.length > 0,
  };
}

export function readArtifactFile(root, name, targetType, fileId) {
  const target = artifactTarget(root, name, targetType);
  const item = target.files.find((file) => file.id === fileId);
  if (!item) throw new Error('未知成品文件');
  const file = assertWorkspacePath(root, path.join(target.directory, item.fileName));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('成品文件不存在，请先生成成品');
  return { data: fs.readFileSync(file), downloadName: name + '.' + item.id };
}

export function openArtifactDirectory(root, name, targetType) {
  const listing = listArtifactFiles(root, name, targetType);
  if (!listing.files.length) throw new Error('还没有成品文件，请先生成成品');
  if (!listing.canOpenDirectory) throw new Error('请在桌面版中打开文件夹；浏览器中可以直接下载成品');
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
      if (error) reject(error); else resolve({ ok: true });
    };
    const onMessage = (message) => {
      if (message?.type !== 'xiaoxi-artifacts-opened' || message.requestId !== requestId) return;
      finish(message.error ? new Error(String(message.error)) : null);
    };
    const onDisconnect = () => finish(new Error('桌面窗口已断开连接'));
    const timeout = setTimeout(() => finish(new Error('打开文件夹超时，请重试')), 8000);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    try {
      process.send({ type: 'xiaoxi-open-artifacts', requestId, targetType, name }, (error) => { if (error) finish(error); });
    } catch (error) { finish(error); }
  });
}
