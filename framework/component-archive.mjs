import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readdir, realpath, rename, rm, open, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const COMPONENT_MAGIC = 'AI-FUTURE-COMPONENT/1\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_HEADER = 16 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 ** 3;

export async function hashComponentFile(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export function componentRelativePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1000 || /[\\:\u0000-\u001f]/u.test(path) || path.startsWith('/') || isAbsolute(path)) throw new Error('组件文件路径无效。');
  if (path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('组件文件路径包含父目录或设备名。');
  return path;
}

export function validateComponentManifest(manifest) {
  if (manifest?.format !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || typeof manifest.version !== 'string' || !manifest.version || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100000) throw new Error('组件清单无效。');
  const names = new Set();
  let total = 0;
  for (const file of manifest.files) {
    componentRelativePath(file.path);
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new Error('组件文件路径重名。');
    names.add(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_TOTAL || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('组件文件大小或 SHA256 无效。');
    total += file.size;
    if (total > MAX_TOTAL) throw new Error('组件展开大小超过限制。');
  }
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) throw new Error('组件文件与父目录冲突。');
  }
  return total;
}

export async function assertOrdinaryComponentPath(path, { allowMissing = false } = {}) {
  const absolute = resolve(path);
  if (/^[\\/]{2}/.test(absolute)) throw new Error('组件路径不能位于网络位置。');
  let current = absolute;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('组件路径不允许链接或 junction。'); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

export async function createComponentArchive({ id, name, version, sources, output, platform = process.platform, arch = process.arch, metadata = {}, filter = () => true, signal }) {
  const files = [], origins = new Map();
  async function walk(source, prefix) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error('组件源文件包含链接：' + source);
    if (info.isDirectory()) {
      for (const entry of (await readdir(source)).sort()) {
        const path = prefix ? prefix + '/' + entry : entry;
        if (filter(path)) await walk(join(source, entry), path);
      }
    } else if (info.isFile()) {
      componentRelativePath(prefix);
      files.push({ path: prefix, size: info.size, sha256: await hashComponentFile(source, signal) });
      origins.set(prefix, source);
    } else throw new Error('组件源文件类型无效：' + source);
  }
  for (const source of sources) await walk(await realpath(source.from), source.to || '');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = { format: 1, id, version, platform, arch, ...metadata, files };
  const installedBytes = validateComponentManifest(manifest);
  const header = Buffer.from(JSON.stringify(manifest));
  if (header.length > MAX_HEADER) throw new Error('组件清单过大。');
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  async function* contents() {
    yield Buffer.from(COMPONENT_MAGIC); yield size; yield header;
    for (const file of files) {
      signal?.throwIfAborted();
      for await (const chunk of createReadStream(origins.get(file.path), { signal })) yield chunk;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const temporary = output + '.' + randomUUID() + '.partial';
  try {
    await pipeline(Readable.from(contents()), createGzip({ level: 6 }), createWriteStream(temporary, { flags: 'wx' }), { signal });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  return { id, name: name || id, version, platform, arch, file: output.split(/[\\/]/).at(-1), bytes: (await stat(output)).size, sha256: await hashComponentFile(output, signal), installedBytes, manifestSha256: digest(header) };
}

class ExactReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; this.ended = false; }
  async take(limit) {
    while (this.offset === this.chunk.length) {
      const item = await this.iterator.next();
      if (item.done) { this.ended = true; return null; }
      this.chunk = item.value; this.offset = 0;
    }
    const size = Math.min(limit, this.chunk.length - this.offset);
    const value = this.chunk.subarray(this.offset, this.offset + size); this.offset += size;
    return value;
  }
  async read(size) {
    const chunks = []; let remaining = size;
    while (remaining) {
      const chunk = await this.take(remaining);
      if (!chunk) throw new Error('组件归档截断。');
      chunks.push(chunk); remaining -= chunk.length;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
  }
}

export async function extractComponentArchive({ archive, directory, descriptor, signal, onProgress = () => {}, onManifest = () => {} }) {
  await assertOrdinaryComponentPath(archive);
  const info = await stat(archive);
  if (!info.isFile() || info.size !== descriptor.bytes || await hashComponentFile(archive, signal) !== descriptor.sha256) throw new Error('组件整包 SHA256 校验失败。');
  const source = createReadStream(archive, { signal }), unzip = createGunzip();
  let transferError;
  const transfer = pipeline(source, unzip, { signal }).catch(error => { transferError = error; });
  const reader = new ExactReader(unzip);
  try {
    if ((await reader.read(Buffer.byteLength(COMPONENT_MAGIC))).toString() !== COMPONENT_MAGIC) throw new Error('组件归档格式不支持。');
    const length = (await reader.read(4)).readUInt32BE();
    if (!length || length > MAX_HEADER) throw new Error('组件清单长度无效。');
    const header = await reader.read(length);
    if (digest(header) !== descriptor.manifestSha256) throw new Error('组件清单 SHA256 校验失败。');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header));
    const total = validateComponentManifest(manifest);
    if (total !== descriptor.installedBytes || ['id', 'version', 'platform', 'arch'].some(key => manifest[key] !== descriptor[key])) throw new Error('组件清单与发布目录不符。');
    await onManifest(manifest);
    await assertOrdinaryComponentPath(directory, { allowMissing: true });
    await mkdir(directory);
    let completed = 0;
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const target = resolve(directory, ...file.path.split('/'));
      const rel = relative(directory, target);
      if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error('组件文件路径越界。');
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, 'wx'), hash = createHash('sha256');
      try {
        let remaining = file.size;
        while (remaining) {
          signal?.throwIfAborted();
          const chunk = await reader.take(Math.min(remaining, 1024 * 1024));
          if (!chunk) throw new Error('组件归档截断。');
          hash.update(chunk); await handle.writeFile(chunk);
          remaining -= chunk.length; completed += chunk.length;
          onProgress({ completedBytes: completed, totalBytes: total });
        }
      } finally { await handle.close(); }
      if (hash.digest('hex') !== file.sha256) throw new Error('组件文件 SHA256 校验失败：' + file.path);
    }
    if (await reader.take(1)) throw new Error('组件归档包含额外内容。');
    await transfer;
    if (transferError) throw transferError;
    return manifest;
  } finally {
    source.destroy(); unzip.destroy(); await transfer;
  }
}
