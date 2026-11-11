import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createComponentArchive, extractComponentArchive, COMPONENT_MAGIC } from '../framework/component-archive.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-components-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('真实归档流式往返二进制、中文路径和点文件，清单记录准确大小', async t => {
  const directory = await fixture(t), source = join(directory, 'source');
  await mkdir(join(source, '子目录'), { recursive: true });
  const binary = Buffer.from([0, 255, 1, 2, 0, 128]);
  await writeFile(join(source, '子目录', '数据.bin'), binary);
  await writeFile(join(source, '.gitignore'), '可读中文\n');
  const archive = join(directory, 'training.afcomponent');
  const descriptor = await createComponentArchive({ id: 'training', version: '1.0.0', sources: [{ from: source }], output: archive });
  assert.equal(descriptor.bytes, (await stat(archive)).size);
  assert.equal(descriptor.sha256, hash(await readFile(archive)));
  const manifest = await extractComponentArchive({ archive, directory: join(directory, 'installed'), descriptor });
  assert.equal(manifest.files.length, 2);
  assert.equal(descriptor.installedBytes, binary.length + Buffer.byteLength('可读中文\n'));
  assert.deepEqual(await readFile(join(directory, 'installed', '子目录', '数据.bin')), binary);
  assert.equal(await readFile(join(directory, 'installed', '.gitignore'), 'utf8'), '可读中文\n');
});

test('整包 SHA 不符时不创建安装目录', async t => {
  const directory = await fixture(t), source = join(directory, 'source');
  await mkdir(source); await writeFile(join(source, 'file'), 'protected');
  const archive = join(directory, 'one.afcomponent');
  const descriptor = await createComponentArchive({ id: 'training', version: '1', sources: [{ from: source }], output: archive });
  await assert.rejects(extractComponentArchive({ archive, directory: join(directory, 'install'), descriptor: { ...descriptor, sha256: '0'.repeat(64) } }), /SHA|校验/);
  await assert.rejects(stat(join(directory, 'install')), { code: 'ENOENT' });
});

async function crafted(directory, files, payload = Buffer.alloc(0)) {
  const manifest = { format: 1, id: 'training', version: '1', platform: 'win32', arch: 'x64', files };
  const json = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  const bytes = gzipSync(Buffer.concat([Buffer.from(COMPONENT_MAGIC), length, json, payload]));
  const archive = join(directory, 'crafted.afcomponent'); await writeFile(archive, bytes);
  return { archive, descriptor: { id: 'training', version: '1', platform: 'win32', arch: 'x64', sha256: hash(bytes), bytes: bytes.length, installedBytes: files.reduce((sum, file) => sum + file.size, 0), manifestSha256: hash(json) } };
}

test('提取拒绝路径穿越、Windows 设备名及大小写重名', async t => {
  for (const paths of [['../outside'], ['C:/outside'], ['CON.txt'], ['a', 'A'], ['a/file', 'a']]) {
    const directory = await fixture(t);
    const input = await crafted(directory, paths.map(path => ({ path, size: 0, sha256: hash('') })));
    await assert.rejects(extractComponentArchive({ ...input, directory: join(directory, 'install') }), /路径|重名|父|设备|冲突/);
  }
});

test('逐文件 SHA、截断和额外内容均不能通过提取', async t => {
  for (const payload of ['b', '', 'aextra']) {
    const directory = await fixture(t);
    const input = await crafted(directory, [{ path: 'file', size: 1, sha256: hash('a') }], Buffer.from(payload));
    await assert.rejects(extractComponentArchive({ ...input, directory: join(directory, 'install') }), /SHA|截断|额外|校验/);
  }
});
