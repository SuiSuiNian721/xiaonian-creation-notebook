import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, rmdir, symlink, unlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { WorkbenchStore } from '../framework/store.mjs';
import { MAX_BODY_BYTES, characterBundle, importedCharacter, newCharacter } from '../framework/contracts.mjs';
import { CharacterResources } from '../framework/character-resources.mjs';

function png(width = 1, height = 1) {
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); content.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, character = newCharacter({ name: '小汐' })) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workbench-character-resources-'));
  let store = new WorkbenchStore(dataDir);
  store.saveCharacter(character);
  let resources = new CharacterResources({ store, dataDir });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, store, resources, character,
    restart() {
      store.close(); store = new WorkbenchStore(dataDir); resources = new CharacterResources({ store, dataDir });
      return { store, resources };
    },
  };
}

const upload = (bytes = png(), values = {}) => ({ name: '角色立绘.png', kind: 'image', mime: 'image/png', base64: bytes.toString('base64'), ...values });
const status = expected => error => error?.name === 'WorkbenchError' && error.status === expected;

test('角色资源持久保存并进入可往返导入的角色索引，公开记录不暴露内部路径', async t => {
  const app = await fixture(t), bytes = png();
  const record = await app.resources.add(app.character.id, upload(bytes, { sourceModuleId: 'drawing', sourceInstanceId: 'drawing-instance-1' }));
  assert.equal(record.characterId, app.character.id); assert.equal(record.name, '角色立绘.png');
  assert.equal(record.kind, 'image'); assert.equal(record.mime, 'image/png'); assert.equal(record.bytes, bytes.length);
  assert.equal(record.sourceModuleId, 'drawing'); assert.equal(record.sourceInstanceId, 'drawing-instance-1');
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.equal(record.url, `/api/characters/${app.character.id}/resources/${record.id}/file`);
  assert.deepEqual(Object.keys(record).sort(), ['id', 'characterId', 'name', 'kind', 'mime', 'bytes', 'createdAt', 'sourceModuleId', 'sourceInstanceId', 'url'].sort());
  assert.deepEqual(app.resources.list(app.character.id), [record]);
  const bundle = app.store.exportCharacter(app.character.id);
  assert.equal(bundle.character.assets[0].ref, `character-resources/${record.id}`);
  assert.equal(bundle.character.assets[0].moduleId, 'drawing');
  assert.deepEqual(importedCharacter({ document: bundle }).assets, bundle.character.assets);
  const reopened = app.restart();
  assert.deepEqual(reopened.resources.list(app.character.id), [record]);
  assert.deepEqual(await reopened.resources.file(app.character.id, record.id), { bytes, mime: 'image/png', name: record.name });
  assert.equal(reopened.store.character(app.character.id).revision, app.character.revision + 1);
});

test('读取和新增均校验角色存在，文件不能由另一角色读取', async t => {
  const app = await fixture(t), other = app.store.saveCharacter(newCharacter({ name: '另一位角色' }));
  const record = await app.resources.add(app.character.id, upload());
  assert.deepEqual(app.resources.list(other.id), []);
  await assert.rejects(app.resources.file(other.id, record.id), status(404));
  await assert.rejects(app.resources.file(app.character.id, 'missing-resource'), status(404));
  assert.throws(() => app.resources.list('missing-character'), status(404));
  await assert.rejects(app.resources.add('missing-character', upload()), status(404));
});

test('严格限制上传编码和 32 MiB 内容，不产生无效文件', async t => {
  const app = await fixture(t);
  for (const base64 of ['', 'not base64', 'YQ', 'YR==', 'data:image/png;base64,YQ==']) {
    await assert.rejects(app.resources.add(app.character.id, upload(undefined, { base64 })), status(400));
  }
  await assert.rejects(app.resources.add(app.character.id, upload(Buffer.alloc(32 * 1024 * 1024 + 1))), status(413));
  assert.deepEqual(app.resources.list(app.character.id), []);
  assert.deepEqual(await readdir(join(app.dataDir, 'character-resources')), []);
});

test('拒绝路径、凭据字段、无效来源和未知类型，名称仅作为显示文字', async t => {
  const app = await fixture(t);
  for (const values of [
    { name: '../outside.png' }, { name: 'C:\\secret.png' }, { name: 'folder/image.png' }, { name: '..' }, { name: 'bad\r\nname.png' },
    { path: 'C:\\secret.png' }, { apiKey: 'credential-must-not-persist' }, { metadata: { apiKey: 'credential-must-not-persist' } },
    { sourceInstanceId: '../instance' }, { kind: 'executable' },
  ]) await assert.rejects(app.resources.add(app.character.id, upload(undefined, values)), status(400));
  await assert.rejects(app.resources.add(app.character.id, upload(undefined, { sourceModuleId: 'unknown-module' })), status(404));
  assert.deepEqual(app.resources.list(app.character.id), []);
});

test('图片采用内容识别的安全 MIME，伪装图片不能预览', async t => {
  const app = await fixture(t);
  const image = await app.resources.add(app.character.id, upload(png(), { mime: 'text/html' }));
  assert.equal(image.mime, 'image/png');
  for (const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from('<html>active</html>'), Buffer.from('not-an-image')]) {
    await assert.rejects(app.resources.add(app.character.id, upload(bytes)), status(400));
  }
});

test('皮肤只接受 64×64 或 64×32 PNG', async t => {
  const app = await fixture(t);
  for (const height of [64, 32]) {
    const record = await app.resources.add(app.character.id, upload(png(64, height), { name: '角色皮肤.png', kind: 'skin' }));
    assert.equal(record.mime, 'image/png'); assert.equal(record.kind, 'skin');
  }
  for (const bytes of [png(1, 1), png(128, 128), Buffer.from([0xff, 0xd8, 0xff, 0xd9])]) {
    await assert.rejects(app.resources.add(app.character.id, upload(bytes, { kind: 'skin' })), status(400));
  }
});

test('工作流必须能解析为 JSON，未知文件和活动文档使用下载 MIME', async t => {
  const app = await fixture(t), workflow = Buffer.from(JSON.stringify({ nodes: [], links: [] }));
  const graph = await app.resources.add(app.character.id, upload(workflow, { name: '角色工作流.json', kind: 'workflow', mime: 'text/html' }));
  assert.equal(graph.mime, 'application/json');
  assert.deepEqual((await app.resources.file(app.character.id, graph.id)).bytes, workflow);
  await assert.rejects(app.resources.add(app.character.id, upload(Buffer.from('{invalid'), { kind: 'workflow' })), status(400));
  for (const [name, bytes, kind, mime] of [
    ['角色模型.vrm', Buffer.from([0, 1, 2, 3]), 'model', 'model/gltf-binary'],
    ['角色说明.html', Buffer.from('<html><script>alert(1)</script></html>'), 'file', 'text/html'],
    ['角色图形.svg', Buffer.from('<svg onload="alert(1)"></svg>'), 'file', 'image/svg+xml'],
  ]) {
    const record = await app.resources.add(app.character.id, upload(bytes, { name, kind, mime }));
    assert.equal(record.mime, 'application/octet-stream');
    assert.equal((await app.resources.file(app.character.id, record.id)).mime, 'application/octet-stream');
  }
});

test('可识别的音频可供其他模块读取，未识别音频按普通文件下载', async t => {
  const app = await fixture(t), wav = Buffer.alloc(44); wav.write('RIFF'); wav.writeUInt32LE(36, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  const audio = await app.resources.add(app.character.id, upload(wav, { name: '角色声音.wav', kind: 'audio', mime: 'audio/wav', sourceModuleId: 'voice' }));
  assert.equal(audio.mime, 'audio/wav'); assert.deepEqual((await app.resources.file(app.character.id, audio.id)).bytes, wav);
  const unknown = await app.resources.add(app.character.id, upload(Buffer.from('not-audio'), { name: '声音.bin', kind: 'audio', mime: 'audio/wav' }));
  assert.equal(unknown.mime, 'application/octet-stream');
});

test('并发保存不丢失资源和索引记录', async t => {
  const app = await fixture(t);
  const records = await Promise.all(Array.from({ length: 8 }, (_, i) => app.resources.add(app.character.id, upload(Buffer.from(`model-${i}`), { name: `模型${i}.bin`, kind: 'model' }))));
  assert.equal(app.resources.list(app.character.id).length, 8);
  assert.deepEqual(new Set(app.store.character(app.character.id).assets.map(asset => asset.id)), new Set(records.map(record => record.id)));
});

test('素材索引达到 500 项后拒绝新增，保留现有资料', async t => {
  const character = newCharacter({ name: '索引已满' });
  character.assets = Array.from({ length: 500 }, (_, i) => ({ id: `asset-${i}`, kind: 'file', name: `原有资料${i}`, characterId: character.id, moduleId: null }));
  const app = await fixture(t, importedCharacter({ document: characterBundle(character) }));
  await assert.rejects(app.resources.add(character.id, upload()), status(400));
  assert.equal(app.store.character(character.id).assets.length, 500);
  assert.deepEqual(app.resources.list(character.id), []);
});

test('新增索引不得使原角色资料包超过 2 MiB 导入预算', async t => {
  const character = newCharacter({ name: '资料接近上限', description: '中'.repeat(51_000), raw: { payload: '' } });
  const overhead = Buffer.byteLength(JSON.stringify({ document: characterBundle(character) }));
  character.raw.payload = 'a'.repeat(MAX_BODY_BYTES - overhead - 50);
  const app = await fixture(t, importedCharacter({ document: characterBundle(character) }));
  await assert.rejects(app.resources.add(character.id, upload()), status(400));
  assert.deepEqual(app.store.character(character.id).assets, []);
  assert.deepEqual(await readdir(join(app.dataDir, 'character-resources')), []);
});

test('索引写入失败时回滚数据库且只清理本次新文件', async t => {
  const app = await fixture(t), root = join(app.dataDir, 'character-resources');
  await writeFile(join(root, 'existing-user-file.txt'), '原有用户文件', 'utf8');
  app.store.db.exec("CREATE TRIGGER reject_resource_asset BEFORE INSERT ON assets WHEN NEW.ref LIKE 'character-resources/%' BEGIN SELECT RAISE(ABORT, 'test-index-failure'); END");
  await assert.rejects(app.resources.add(app.character.id, upload()), /test-index-failure/);
  assert.deepEqual(app.resources.list(app.character.id), []); assert.deepEqual(app.store.character(app.character.id).assets, []);
  assert.deepEqual(await readdir(root), ['existing-user-file.txt']);
  assert.equal(await readFile(join(root, 'existing-user-file.txt'), 'utf8'), '原有用户文件');
});

test('资源目录被替换为联接时拒绝读写且不删除目录外文件', async t => {
  const app = await fixture(t), root = join(app.dataDir, 'character-resources'), outside = join(app.dataDir, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), '目录外资料', 'utf8'); await rmdir(root);
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new CharacterResources({ store: app.store, dataDir: app.dataDir }), status(409));
  await assert.rejects(app.resources.add(app.character.id, upload()), status(409));
  assert.deepEqual(await readdir(outside), ['keep.txt']);
});

test('资源文件被替换为符号链接时拒绝读取外部内容', async t => {
  const app = await fixture(t), record = await app.resources.add(app.character.id, upload());
  const path = join(app.dataDir, 'character-resources', `${record.id}.bin`), outside = join(app.dataDir, 'outside-secret.txt');
  await writeFile(outside, '不能作为角色资源读取', 'utf8'); await unlink(path);
  try { await symlink(outside, path, 'file'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('当前 Windows 账户没有创建文件符号链接的权限；目录联接另有测试'); return; } throw error; }
  await assert.rejects(app.resources.file(app.character.id, record.id), status(409));
  assert.equal(await readFile(outside, 'utf8'), '不能作为角色资源读取');
});

test('资源文件被替换为硬链接或损坏后拒绝读取', async t => {
  const app = await fixture(t), record = await app.resources.add(app.character.id, upload());
  const path = join(app.dataDir, 'character-resources', `${record.id}.bin`), outside = join(app.dataDir, 'outside-image.png');
  await writeFile(outside, png()); await unlink(path); await link(outside, path);
  await assert.rejects(app.resources.file(app.character.id, record.id), status(409));
  await unlink(path); await writeFile(path, Buffer.from('已损坏'));
  await assert.rejects(app.resources.file(app.character.id, record.id), status(409));
});
