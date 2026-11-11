import { createHash } from 'node:crypto';
import {drawingJobOutputDirectory} from './drawing-preferences.mjs';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WorkbenchError } from './contracts.mjs';
import { checkedLocalPath, insideDirectory } from './drawing-files.mjs';

export const MAX_DRAWING_RESULT_BYTES = 4 * 1024 ** 3;
const TEXT_PREVIEW_CHARS = 4096;
const FILE_OUTPUT_FIELDS = new Set(['images', 'gifs', 'audio', 'video', 'videos', 'files']);
const types = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.webp': ['image', 'image/webp'],
  '.mp4': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.mkv': ['video', 'video/x-matroska'], '.mov': ['video', 'video/quicktime'],
  '.gif': ['animation', 'image/gif'], '.wav': ['audio', 'audio/wav'], '.mp3': ['audio', 'audio/mpeg'], '.flac': ['audio', 'audio/flac'],
  '.ogg': ['audio', 'audio/ogg'], '.opus': ['audio', 'audio/ogg'], '.m4a': ['audio', 'audio/mp4'], '.aac': ['audio', 'audio/aac'],
};

export function drawingOutputSource(value) {
  const invalid = () => { throw new WorkbenchError(502, '输出文件索引包含无效路径或文件类型。'); };
  if (!value || typeof value.filename !== 'string' || !value.filename || value.filename.length > 255
    || /[\\/:\u0000-\u001f]/.test(value.filename) || ['.', '..'].includes(value.filename)) invalid();
  const subfolder = value.subfolder ?? '', type = value.type ?? 'output';
  if (typeof subfolder !== 'string' || subfolder.length > 2048 || /[:\u0000-\u001f]/.test(subfolder)
    || /^[\\/]/.test(subfolder) || subfolder.split(/[\\/]/).some(part => part === '.' || part === '..')
    || !['output', 'temp'].includes(type)) invalid();
  return { filename: value.filename, subfolder: subfolder.replaceAll('\\', '/'), type };
}

// ComfyUI SaveVideo uses `images`; VHS uses `gifs`. Neither field identifies the file type.
export function drawingOutputs(outputs) {
  const results = [], seen = new Set(); let fileCount = 0;
  const add = result => { if (!seen.has(result.key)) { seen.add(result.key); results.push(result); } };
  function files(value, fileField = false, depth = 0) {
    if (depth > 64) return false;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'filename')
      && (fileField || ['output', 'temp', 'input'].includes(value.type) || Object.hasOwn(value, 'subfolder'))) {
      const source = drawingOutputSource(value), extension = extname(source.filename).toLowerCase();
      fileCount++;
      const [kind, mime] = types[extension] || ['file', 'application/octet-stream'];
      add({ key: 'file:' + JSON.stringify(source), kind, mime, source, extension: /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin' });
      return Object.keys(value).every(name => ['filename', 'subfolder', 'type'].includes(name));
    }
    if (Array.isArray(value)) { let onlyFiles = value.length > 0; for (const nested of value) if (!files(nested, fileField, depth + 1)) onlyFiles = false; return onlyFiles; }
    if (value && typeof value === 'object') { for (const [name, nested] of Object.entries(value)) files(nested, FILE_OUTPUT_FIELDS.has(name), depth + 1); }
    return false;
  }
  for (const [nodeId, output] of Object.entries(outputs || {})) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      add({ key: 'data:' + nodeId, kind: 'data', mime: 'application/json; charset=utf-8', extension: '.json', content: JSON.stringify(output, null, 2), sourceName: `节点 ${nodeId} 数据.json` }); continue;
    }
    const extra = Object.create(null), priorFileCount = fileCount;
    for (const [name, value] of Object.entries(output)) {
      if (FILE_OUTPUT_FIELDS.has(name) && Array.isArray(value) && value.length === 0) continue;
      if (['text', 'string', 'strings'].includes(name) && (typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string'))) {
        if (Array.isArray(value) && value.length === 0) continue;
        add({ key: `text:${nodeId}:${name}`, kind: 'text', mime: 'text/plain; charset=utf-8', extension: '.txt', content: Array.isArray(value) ? value.join('\n') : value, sourceName: `节点 ${nodeId} 文本.txt` });
      } else if (name !== 'animated' && !files(value, FILE_OUTPUT_FIELDS.has(name))) extra[name] = value;
    }
    if (fileCount === priorFileCount && Object.hasOwn(output, 'animated')) extra.animated = output.animated;
    if (Object.keys(extra).length) add({ key: 'data:' + nodeId, kind: 'data', mime: 'application/json; charset=utf-8', extension: '.json', content: JSON.stringify(extra, null, 2), sourceName: `节点 ${nodeId} 数据.json` });
  }
  return results;
}

export const drawingResultId = (job, key) => createHash('sha256').update(job.id + '\0' + key).digest('hex').slice(0, 32);

function checkMediaPrefix(prefix, extension, kind) {
  if (!['video', 'audio', 'animation'].includes(kind)) return;
  const begins = text => prefix.subarray(0, text.length).toString('ascii') === text;
  const mp4 = prefix.subarray(4, 8).toString('ascii') === 'ftyp';
  const valid = ['.mp4', '.m4a'].includes(extension) ? mp4
    : extension === '.mov' ? mp4 || ['moov', 'mdat', 'wide'].includes(prefix.subarray(4, 8).toString('ascii'))
    : ['.mkv', '.webm'].includes(extension) ? prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : extension === '.wav' ? begins('RIFF') && prefix.subarray(8, 12).toString('ascii') === 'WAVE'
    : extension === '.mp3' ? begins('ID3') || prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0
    : extension === '.flac' ? begins('fLaC')
    : ['.opus', '.ogg'].includes(extension) ? begins('OggS')
    : extension === '.aac' ? prefix[0] === 0xff && (prefix[1] & 0xf0) === 0xf0
    : extension === '.gif' ? begins('GIF87a') || begins('GIF89a') : false;
  if (!valid) throw new WorkbenchError(502, '输出文件内容与视频、音频或动图格式不符，请检查节点实际保存的文件。');
}

async function downloadResult({ job, output, target, fetchImpl, requests, closed }) {
  if (closed()) throw new WorkbenchError(503, '绘图服务已关闭。');
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
  try {
    const query = new URLSearchParams(output.source);
    const response = await fetchImpl(job.serviceUrl + '/view?' + query, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new WorkbenchError(502, `ComfyUI 输出文件读取失败（HTTP ${response.status}）。`); }
    const expected = response.headers.get('content-length');
    if (expected !== null && Number(expected) > MAX_DRAWING_RESULT_BYTES) { await response.body.cancel(); throw new WorkbenchError(413, '输出文件超过 4 GiB 归档上限。'); }
    async function* measured() {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_DRAWING_RESULT_BYTES) throw new WorkbenchError(413, '输出文件超过 4 GiB 归档上限。');
        if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
        hash.update(chunk); yield chunk;
      }
    }
    await pipeline(measured(), createWriteStream(target, { flags: 'wx' }), { signal: controller.signal });
    if (!bytes) throw new WorkbenchError(502, 'ComfyUI 返回的输出文件为空。');
    checkMediaPrefix(prefix, output.extension, output.kind);
    return { bytes, sha256: hash.digest('hex') };
  } catch (error) {
    controller.abort();
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(503, `输出文件归档中断：${closed() ? '工作台已关闭' : error.name === 'AbortError' ? '下载超时' : error.message}`);
  } finally { clearTimeout(timer); requests.delete(controller); }
}

export async function archiveDrawingResult({ job, output, directory, fetchImpl, requests, closed, db }) {
  const id = drawingResultId(job, output.key);
  const prior = db.prepare('SELECT data FROM drawing_results WHERE id=?').get(id);
  if (prior) return JSON.parse(prior.data);
  const root = await checkedLocalPath(join(directory, 'results')); await mkdir(root, { recursive: true });
  const filename = id + output.extension, target = await insideDirectory(root, filename), temporary = target + '.part';
  let details;
  try {
    // A previous interrupted archive can leave only this task's deterministic temporary file.
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (output.source) details = await downloadResult({ job, output, target: temporary, fetchImpl, requests, closed });
    else {
      const content = Buffer.from(output.content, 'utf8');
      await writeFile(temporary, content, { flag: 'wx' }); details = { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  let archived = '', archiveError = '';
  if (job.outputPath) {
    try {
      const destination = await checkedLocalPath(drawingJobOutputDirectory(job)); await mkdir(destination, { recursive: true });
      archived = await insideDirectory(destination, filename); await copyFile(target, archived);
    } catch (error) { archived = ''; archiveError = `作品目录复制失败：${error.code || error.message}`; }
  }
  const result = { id, jobId: job.id, sourceKey: output.key, kind: output.kind, filename, sourceName: output.source?.filename || output.sourceName,
    ...(output.source ? { source: output.source } : { text: output.content.slice(0, TEXT_PREVIEW_CHARS), truncated: output.content.length > TEXT_PREVIEW_CHARS }),
    mime: output.mime, ...details, url: `/api/modules/drawing/results/${id}`, archived, ...(archiveError ? { archiveError } : {}) };
  db.prepare('INSERT INTO drawing_results VALUES(?,?)').run(id, JSON.stringify(result));
  return result;
}

export async function serveDrawingResult(req, res, result, download = false) {
  const info = await stat(result.path), size = info.size;
  const attachment = download || result.kind === 'file';
  // Raw JSON is an artifact, not an API response: keep instance proxies from rewriting its URLs.
  const mime = result.kind === 'data' ? download ? 'application/octet-stream' : 'text/plain; charset=utf-8' : result.mime;
  const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
    ...(attachment ? { 'content-disposition': `attachment; filename="${result.filename}"; filename*=UTF-8''${encodeURIComponent(result.sourceName).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16))}` } : {}) };
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
      else { const suffix = Number(match[2]); start = suffix > 0 ? Math.max(size - suffix, 0) : size; }
    }
    if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' }); res.end(); return;
    }
    status = 206; headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = String(Math.max(end - start + 1, 0));
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  try { await pipeline(createReadStream(result.path, { start, end }), res); }
  catch (error) { if (!res.destroyed) res.destroy(error); }
}
