import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { WorkbenchError } from './contracts.mjs';
import { trainingPath } from './training-runtime.mjs';

const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
export function compatibleCaption(text, format) {
  const parts = text.split(',').map(value => value.trim()).filter(Boolean);
  const tags = parts.length >= 3 && parts.filter(value => value.split(/\s+/).length <= 4).length >= parts.length * 0.75 && !/\b(?:is|are|wearing|depicts|shows)\b/i.test(text);
  // Format detection is deliberately modest: comma-separated tags versus a
  // descriptive phrase. This does not validate the model's semantic accuracy.
  const sentence = text.trim().split(/\s+/).length >= 5 && (/\b(?:a|an|the|is|are|with|in|on|at|of|beside)\b/i.test(text) || /[.!?]$/.test(text.trim())) || /[\u4e00-\u9fff]{6,}/.test(text);
  return !!text.trim() && (format === 'natural' ? sentence && !tags : !sentence || tags);
}
export async function regularLocal(path, directory = false) {
  const absolute = trainingPath(path, directory ? '图集目录' : '素材文件');
  if (process.platform === 'win32' && absolute.slice(2).includes(':')) throw new WorkbenchError(400, '素材不支持设备或数据流路径。');
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    if (info.isSymbolicLink()) throw new WorkbenchError(400, '图集及素材不能经过链接或目录联接，请选择实际本地目录。');
  }
  const info = await lstat(absolute);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new WorkbenchError(400, directory ? '训练图集必须是目录。' : '素材必须是普通文件。');
  return info;
}
async function sha256(path) {
  const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part); return hash.digest('hex');
}
async function captionFor(path) {
  for (const suffix of ['.txt', '.caption']) {
    const candidate = path.slice(0, -extname(path).length) + suffix;
    try {
      const info = await regularLocal(candidate); if (info.size > 128 * 1024) throw new WorkbenchError(400, '原标注超过 128 KiB。');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(candidate)).trim();
      if (value) return { path: candidate, text: value };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}
export async function preparePipelineDataset({ root, sourcePath, owner, input, plan }) {
  await regularLocal(sourcePath, true); const images = [];
  const nested = relative(sourcePath, root);
  if (!nested || nested !== '..' && !nested.startsWith('..' + sep) && !parse(nested).root) throw new WorkbenchError(400, '请选择独立的原图目录，图集不能包含工作台的流程工作目录。');
  async function visit(directory, depth = 0) {
    if (depth > 16) throw new WorkbenchError(400, '图集子目录超过 16 层。');
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new WorkbenchError(400, '图集中存在链接，请移出链接或选择实际图片目录。');
      if (entry.isDirectory()&&(input.captionSource==='connected'||input.taggerOptions?.batch_input_recursive!==false)) await visit(path, depth + 1);
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        const info = await regularLocal(path);
        if (info.size === 0 || info.size > 100 * 1024 * 1024) throw new WorkbenchError(400, `图片为空或超过 100 MiB：${entry.name}`);
        images.push(path); if (images.length > 5000) throw new WorkbenchError(400, '单次图集最多支持 5000 张图片。');
      }
    }
  }
  await visit(sourcePath);
  if (!images.length) throw new WorkbenchError(400, '图集中没有 PNG、JPEG、WebP 或 BMP 图片。');
  await mkdir(root, { recursive: true }); await regularLocal(root, true);
  const workspace = join(root, 'dataset-' + randomUUID()), imageDir = join(workspace, 'images');
  await mkdir(join(imageDir, 'originals'), { recursive: true }); const items = []; let captioned = 0;
  for (let index = 0; index < images.length; index++) {
    const source = images[index], name = 'originals/' + String(index + 1).padStart(6, '0') + extname(source).toLowerCase(), destination = join(imageDir, name);
    const before = await sha256(source); await copyFile(source, destination);
    if (await sha256(destination) !== before || await sha256(source) !== before) throw new WorkbenchError(409, '复制期间原图发生变化，请停止修改图集后继续。');
    const original = await captionFor(source);
    const format = plan.strategy?.captionFormat || 'tags';
    const explicitConflict=input.captionSource!=='connected'&&format==='tags'&&input.taggerOptions?.batch_output_action_on_conflict!==undefined;
    const reuse = original && (input.captionPolicy !== 'regenerate'||explicitConflict) && compatibleCaption(original.text, format);
    if (reuse) {
      const prefix = format === 'natural' ? plan.trigger + '.' : plan.trigger + ',';
      const text = plan.trigger && original.text !== plan.trigger && !original.text.startsWith(prefix) ? `${plan.trigger}${format === 'natural' ? '.' : ','} ${original.text}` : original.text;
      await writeFile(join(imageDir, name.slice(0, -extname(name).length) + '.txt'), text + '\n', 'utf8'); captioned++;
    }
    items.push({ name, source: relative(sourcePath, source), sha256: before, kind: 'original', requiresCaption: !reuse, captionFormat: reuse ? format : null, captionImageSha256: reuse ? before : null, captionSha256: reuse ? await sha256(destination.slice(0, -extname(destination).length) + '.txt') : null, originalCaption: original ? { source: relative(sourcePath, original.path), sha256: await sha256(original.path) } : null });
  }
  const manifest = { format: 2, owner, workspace, imageDir, sourcePath, imageCount: items.length, originalCount: items.length, derivedCount: 0, captioned, missing: items.length - captioned, items };
  await writeFile(join(workspace, 'dataset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}
export async function readProcessedDataset(dataset, owner, requestId, { captionRequestId, captionFormat } = {}) {
  const path = join(dataset.workspace, 'dataset-manifest.json'); await regularLocal(path);
  if ((await lstat(path)).size > 16 * 1024 * 1024) throw new WorkbenchError(413, '裁切清单超过限制。');
  const result = JSON.parse(await readFile(path, 'utf8'));
  if (result.owner !== owner || result.workspace !== dataset.workspace || result.imageDir !== dataset.imageDir || !Array.isArray(result.items) || result.items.length > 15000 || requestId && (result.processing?.complete !== true || result.processing.requestId !== requestId)) throw new WorkbenchError(409, '处理结果未完整提交或不属于当前流程。');
  if (captionRequestId && (result.captions?.complete !== true || result.captions.requestId !== captionRequestId || result.captions.format !== captionFormat)) throw new WorkbenchError(409, '标注阶段未提交匹配当前任务的完整结果。');
  const original = dataset.items.filter(item => (item.kind || 'original') === 'original');
  const actual = result.items.filter(item => (item.kind || 'original') === 'original');
  const identity = items => JSON.stringify(items.map(item => ({ name: item.name, source: item.source, sha256: item.sha256, originalCaption: item.originalCaption })));
  if (identity(original) !== identity(actual)) throw new WorkbenchError(409, '处理改变了原图清单。');
  const names = new Set(); let missing = 0;
  for (const item of result.items) {
    if (typeof item.name !== 'string' || /[\\:]/.test(item.name) || isAbsolute(item.name) || item.name.split('/').some(part => !part || part === '.' || part === '..') || names.has(item.name)) throw new WorkbenchError(409, '裁切结果存在无效或重复的图像路径。');
    names.add(item.name); const image = join(dataset.imageDir, item.name); await regularLocal(image);
    if (await sha256(image) !== item.sha256) throw new WorkbenchError(409, '裁切图像文件校验失败。');
    const caption = await captionFor(image);
    if (captionRequestId && (item.requiresCaption || item.captionImageSha256 !== item.sha256 || item.captionFormat !== captionFormat || !caption || !item.captionSha256 || await sha256(caption.path) !== item.captionSha256)) throw new WorkbenchError(409, '标注文件已改变或未通过当前图像的完整性校验。');
    if (item.requiresCaption || !caption) missing++;
  }
  return { ...result, imageCount: result.items.length, originalCount: original.length, derivedCount: result.items.length - original.length, missing, captioned: result.items.length - missing };
}
export async function verifyPipelineDataset(dataset, config, plan) {
  await regularLocal(dataset.imageDir, true);
  const samples = [];
  for (const item of dataset.items) {
    const image = join(dataset.imageDir, item.name); await regularLocal(image);
    if (await sha256(image) !== item.sha256) throw new WorkbenchError(409, '工作副本的图片发生变化，请重新建立流程。');
    const caption = await captionFor(image);
    if (!caption) throw new WorkbenchError(422, `图片缺少非空标注：${item.name}。已阻止后续训练。`);
    if (dataset.format >= 2 && (!item.captionSha256 || await sha256(caption.path) !== item.captionSha256)) throw new WorkbenchError(409, `标注文件已改变或校验失败：${item.name}`);
    if (plan.strategy && !compatibleCaption(caption.text, plan.strategy.captionFormat)) throw new WorkbenchError(422, `标注与当前${plan.strategy.captionFormat === 'natural' ? '自然语言' : '标签'}策略不符：${item.name}`);
    if ((item.kind || 'original') !== 'original' && (item.requiresCaption || item.captionImageSha256 !== item.sha256 || item.captionFormat !== plan.strategy?.captionFormat)) throw new WorkbenchError(422, `裁切图尚未针对新画面重新标注：${item.name}`);
    samples.push({ image: item.name, kind: item.kind || 'original', caption: caption.text.slice(0, 1200) });
  }
  const resolution = String(config.resolution || '512,512').split(',').map(Number);
  if (resolution.length === 1) resolution.push(resolution[0]);
  if (resolution.length !== 2 || resolution.some(n => !Number.isInteger(n) || n < 64 || n > 4096)) throw new WorkbenchError(400, '训练分辨率格式无效。');
  const datasetPath = join(dataset.workspace, 'dataset.toml');
  const options = plan.strategy?.training || {};
  const flags = Object.entries(options).map(([key, value]) => `${key} = ${typeof value === 'boolean' ? value : JSON.stringify(value)}`).join('\n');
  const groups = new Map();
  for (const item of dataset.items) { const group = dirname(item.name); groups.set(group, (item.kind || 'original') === 'original' ? plan.repeats : Math.max(1, Math.floor(plan.repeats * (plan.strategy?.cropRepeatScale || 1)))); }
  const subsets = [...groups].map(([folder, repeats]) => `[[datasets.subsets]]\nimage_dir = ${JSON.stringify(join(dataset.imageDir, folder))}\nnum_repeats = ${repeats}\n`).join('\n');
  const buckets = Object.entries(plan.strategy?.dataset || { enable_bucket: true }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
  const toml = `[general]\ncaption_extension = ".txt"\nrandom_crop = false\n${flags}\n\n[[datasets]]\nresolution = [${resolution.join(', ')}]\nbatch_size = ${Number.isInteger(config.train_batch_size) ? config.train_batch_size : 1}\n${buckets}\n\n${subsets}`;
  await writeFile(datasetPath, toml, 'utf8');
  const originals = samples.filter(item => item.kind === 'original'), derived = samples.filter(item => item.kind !== 'original');
  const selected = [...originals.slice(0, derived.length ? 6 : 12), ...derived.slice(0, 6)];
  return { datasetPath, imageCount: dataset.items.length, originalCount: originals.length, derivedCount: derived.length, captioned: dataset.items.length, captionFormat: plan.strategy?.captionFormat || 'tags', reviewCount: dataset.processing?.reviewCount || 0, reviews: dataset.processing?.reviews || [], samples: selected };
}
