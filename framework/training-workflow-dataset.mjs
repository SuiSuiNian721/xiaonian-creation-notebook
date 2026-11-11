import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WorkbenchError } from './contracts.mjs';
import { regularLocal } from './training-dataset.mjs';

async function sha256(path, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}

function descendant(root, path) {
  const child = relative(resolve(root), resolve(path));
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new WorkbenchError(400, '训练图集必须位于当前流程工作目录内。');
}

export async function prepareWorkflowDatasetLayout({ dataset, plan, signal }, engine) {
  if (!['musubi', 'anima-fast'].includes(engine)) throw new WorkbenchError(400, '此引擎不需要独立图集布局。');
  const label = engine === 'musubi' ? 'Musubi' : 'Anima Fast';
  signal?.throwIfAborted();
  await regularLocal(dataset.workspace, true); await regularLocal(dataset.imageDir, true);
  descendant(dataset.workspace, dataset.imageDir);
  if (!Number.isSafeInteger(plan.repeats) || plan.repeats < 1) throw new WorkbenchError(400, `${label} 图集重复次数须为正整数。`);
  if (!Array.isArray(dataset.items) || !dataset.items.length) throw new WorkbenchError(400, '训练图集没有已验证的图片。');
  const files = [], sources = [], names = new Set();
  for (const [index, item] of dataset.items.entries()) {
    signal?.throwIfAborted();
    if (typeof item.name !== 'string' || /[\\:]/.test(item.name) || isAbsolute(item.name) || item.name.split('/').some(part => !part || part === '.' || part === '..') || names.has(item.name)) throw new WorkbenchError(400, '训练图集原图清单存在无效或重复路径。');
    names.add(item.name);
    const source = join(dataset.imageDir, item.name); await regularLocal(source);
    if (await sha256(source, signal) !== item.sha256) throw new WorkbenchError(409, '训练图集工作副本图片发生变化，校验失败。');
    let caption, captionSha256;
    for (const extension of ['.txt', '.caption']) {
      const path = source.slice(0, -extname(source).length) + extension;
      try {
        const info = await regularLocal(path);
        if (info.size > 128 * 1024) throw new WorkbenchError(400, '训练图集标注超过 128 KiB。');
        if (!(await readFile(path, 'utf8')).trim()) continue;
        caption = path; captionSha256 = await sha256(path, signal); break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!caption || dataset.format >= 2 && captionSha256 !== item.captionSha256) throw new WorkbenchError(409, '训练图集标注缺失或校验失败。');
    const kind = (item.kind || 'original') === 'original' ? 'original' : 'derived';
    const repeats = kind === 'original' ? plan.repeats : Math.max(1, Math.floor(plan.repeats * (plan.strategy?.cropRepeatScale || 1)));
    if (!Number.isSafeInteger(repeats) || repeats < 1) throw new WorkbenchError(400, '训练图集派生图重复次数无效。');
    const group = engine === 'musubi' ? `${repeats}_${kind}` : kind;
    const prefix = `${group}/${String(index + 1).padStart(6, '0')}`;
    files.push({ source: item.name, image: prefix + extname(source).toLowerCase(), caption: prefix + '.txt', imageSha256: item.sha256, captionSha256 });
    sources.push({ image: source, caption });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const manifest = { format: 1, engine, sourceWorkspace: resolve(dataset.workspace), sourceImageDir: resolve(dataset.imageDir), fingerprint, files };
  // Both adapters fall back to the directory basename for cache slugs outside
  // their runtime root. A per-workflow suffix prevents unrelated cache reuse.
  const workflowKey = createHash('sha256').update(resolve(dataset.workspace)).digest('hex').slice(0, 16);
  const directory = join(dataset.workspace, engine + '-dataset-' + workflowKey); descendant(dataset.workspace, directory);

  async function verifyLayout(path) {
    await regularLocal(path, true);
    const manifestPath = join(path, 'layout-manifest.json'), info = await regularLocal(manifestPath);
    if (info.size > 16 * 1024 * 1024 || await readFile(manifestPath, 'utf8') !== JSON.stringify(manifest, null, 2) + '\n') throw new WorkbenchError(409, '训练图集布局清单不匹配，不能复用或覆盖。');
    const allowed = new Set(['layout-manifest.json']);
    for (const file of files) {
      allowed.add(file.image); allowed.add(file.caption); allowed.add(dirname(file.image).replaceAll('\\', '/'));
      for (const [name, expected] of [[file.image, file.imageSha256], [file.caption, file.captionSha256]]) {
        const target = join(path, name); await regularLocal(target);
        if (await sha256(target, signal) !== expected) throw new WorkbenchError(409, '训练图集副本发生变化，校验失败。');
      }
    }
    async function visit(folder) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const target = join(folder, entry.name), name = relative(path, target).replaceAll('\\', '/');
        if (entry.isSymbolicLink() || !allowed.has(name)) throw new WorkbenchError(409, '训练图集含有清单之外的文件或链接，不能继续。');
        if (entry.isDirectory()) await visit(target);
      }
    }
    await visit(path);
  }

  let exists = false;
  try { await regularLocal(directory, true); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Only a missing destination allows materialization. Existing output always
  // requires its original manifest and byte-for-byte integrity.
  if (exists) {
    try { await verifyLayout(directory); }
    catch (error) { if (error.code === 'ENOENT') throw new WorkbenchError(409, '已有训练图集缺少布局清单或素材，不能复用或覆盖。'); throw error; }
    return directory;
  }
  const temporary = await mkdtemp(join(dataset.workspace, '.' + engine + '-dataset-'));
  try {
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted();
      await mkdir(join(temporary, dirname(file.image)), { recursive: true });
      for (const [source, target, expected] of [[sources[index].image, file.image, file.imageSha256], [sources[index].caption, file.caption, file.captionSha256]]) {
        await regularLocal(source);
        await copyFile(source, join(temporary, target), constants.COPYFILE_EXCL);
        if (await sha256(source, signal) !== expected || await sha256(join(temporary, target), signal) !== expected) throw new WorkbenchError(409, '建立训练图集期间图片或标注发生变化。');
      }
    }
    signal?.throwIfAborted();
    await writeFile(join(temporary, 'layout-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await verifyLayout(temporary);
    signal?.throwIfAborted();
    await rename(temporary, directory);
    return directory;
  } finally {
    // This is only the fresh staging folder, never the source or final layout.
    descendant(dataset.workspace, temporary);
    try { await regularLocal(temporary, true); await rm(temporary, { recursive: true, force: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
