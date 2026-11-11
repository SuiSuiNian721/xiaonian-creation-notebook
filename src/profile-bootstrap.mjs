import { DatabaseSync, backup } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, copyFile, link, mkdir, realpath, unlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function within(parent, child) {
  const root = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const path = process.platform === 'win32' ? child.toLowerCase() : child;
  return path.startsWith(root + sep);
}

async function copyReferencedMedia(snapshot, sourceDataDir, targetDataDir) {
  const db = new DatabaseSync(snapshot, { readOnly: true });
  let files;
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media'").get()) return 0;
    files = db.prepare('SELECT DISTINCT filename FROM media').all().map(row => row.filename);
  } finally { db.close(); }
  if (!files.length) return 0;
  const sourceRoot = await realpath(sourceDataDir);
  const targetRoot = await realpath(targetDataDir);
  const sourceMedia = join(sourceRoot, 'media');
  const targetMedia = join(targetRoot, 'media');
  await mkdir(targetMedia, { recursive: true });
  if (!within(targetRoot, await realpath(targetMedia))) throw new Error('新版媒体目录超出数据目录。');
  let copied = 0;
  for (const filename of files) {
    if (typeof filename !== 'string' || !filename || basename(filename) !== filename || /[\\/]/u.test(filename) || filename === '.' || filename === '..') throw new Error('旧版媒体文件名无效。');
    const source = join(sourceMedia, filename);
    // 原版已经缺失的附件不阻断对话导入；不读取其他文件或整个旧 profile。
    if (!await exists(source)) continue;
    if (!within(sourceRoot, await realpath(source))) throw new Error('旧版媒体文件超出数据目录。');
    try { await copyFile(source, join(targetMedia, filename), constants.COPYFILE_EXCL); copied++; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return copied;
}

// 只在 Aurora 首次启动使用；源库以只读连接在线备份，WAL 中的已提交数据会进入快照。
export async function bootstrapProfile({ sourceDataDir, targetDataDir, enabled = true }) {
  if (!enabled) return { status: 'disabled', copiedMedia: 0 };
  const sourceDir = resolve(sourceDataDir);
  const targetDir = resolve(targetDataDir);
  const sourcePath = join(sourceDir, 'workspace.sqlite');
  const targetPath = join(targetDir, 'workspace.sqlite');
  if (await exists(targetPath)) return { status: 'existing', copiedMedia: 0 };
  if (!await exists(sourcePath)) return { status: 'missing', copiedMedia: 0 };
  await mkdir(targetDir, { recursive: true });
  const temporary = join(targetDir, `.migration-${randomUUID()}.sqlite`);
  let source;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, temporary);
    source.close(); source = undefined;
    const copiedMedia = await copyReferencedMedia(temporary, sourceDir, targetDir);
    try {
      // 同目录硬链接原子发布完整快照；即使并发首次启动，也绝不替换已存在的新库。
      await link(temporary, targetPath);
      return { status: 'copied', copiedMedia };
    } catch (error) {
      if (error.code === 'EEXIST') return { status: 'existing', copiedMedia: 0 };
      throw error;
    }
  } finally {
    source?.close();
    for (const path of [temporary, temporary + '-wal', temporary + '-shm']) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
