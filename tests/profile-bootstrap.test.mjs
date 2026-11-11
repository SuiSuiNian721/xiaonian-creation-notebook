import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { bootstrapProfile } from '../src/profile-bootstrap.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-future-profile-'));
  const open = [];
  t.after(async () => {
    for (const db of open) { try { db.close(); } catch {} }
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep));
    await rm(target, { recursive: true, force: true });
  });
  const sourceDataDir = join(root, 'old', 'data');
  const targetDataDir = join(root, 'aurora', 'data');
  async function source() {
    await mkdir(sourceDataDir, { recursive: true });
    const db = new DatabaseSync(join(sourceDataDir, 'workspace.sqlite'));
    open.push(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT NOT NULL); CREATE TABLE media(id TEXT PRIMARY KEY, mime TEXT, filename TEXT);');
    return db;
  }
  return { root, sourceDataDir, targetDataDir, source };
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = async path => stat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });

test('首次启动使用只读SQLite快照，保留尚在WAL中的已提交消息且不改旧库', async t => {
  const f = await fixture(t);
  const source = await f.source();
  source.prepare('INSERT INTO sample VALUES(?)').run('旧版聊天，仍在 WAL 中');
  const sourcePath = join(f.sourceDataDir, 'workspace.sqlite');
  const beforeDb = hash(await readFile(sourcePath));
  const beforeWal = hash(await readFile(sourcePath + '-wal'));
  const result = await bootstrapProfile(f);
  assert.equal(result.status, 'copied');
  const target = new DatabaseSync(join(f.targetDataDir, 'workspace.sqlite'), { readOnly: true });
  try {
    assert.equal(target.prepare('SELECT value FROM sample').get().value, '旧版聊天，仍在 WAL 中');
    assert.equal(target.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { target.close(); }
  assert.equal(hash(await readFile(sourcePath)), beforeDb);
  assert.equal(hash(await readFile(sourcePath + '-wal')), beforeWal);
});

test('新版已有数据库时绝不覆盖或再次导入旧版内容', async t => {
  const f = await fixture(t);
  (await f.source()).prepare('INSERT INTO sample VALUES(?)').run('旧内容');
  await mkdir(f.targetDataDir, { recursive: true });
  const targetPath = join(f.targetDataDir, 'workspace.sqlite');
  await writeFile(targetPath, '新版文件必须保持原样', 'utf8');
  const result = await bootstrapProfile(f);
  assert.equal(result.status, 'existing');
  assert.equal(await readFile(targetPath, 'utf8'), '新版文件必须保持原样');
});

test('未找到旧库时按首次使用处理，不创建伪数据库', async t => {
  const f = await fixture(t);
  assert.equal((await bootstrapProfile(f)).status, 'missing');
  assert.equal(await missing(join(f.targetDataDir, 'workspace.sqlite')), true);
});

test('QA禁用迁移时不读取无效源路径，也不创建用户数据目录', async t => {
  const f = await fixture(t);
  const result = await bootstrapProfile({ sourceDataDir: null, targetDataDir: f.targetDataDir, enabled: false });
  assert.equal(result.status, 'disabled');
  assert.equal(await missing(f.targetDataDir), true);
});

test('随快照只复制数据库引用的语音文件，保留旧媒体原件', async t => {
  const f = await fixture(t);
  const source = await f.source();
  source.prepare('INSERT INTO media VALUES(?,?,?)').run('audio-1', 'audio/wav', 'audio-1.wav');
  const media = join(f.sourceDataDir, 'media');
  await mkdir(media);
  await writeFile(join(media, 'audio-1.wav'), Buffer.from('voice fixture'));
  await writeFile(join(media, 'unrelated.txt'), '不属于数据库的文件');
  const result = await bootstrapProfile(f);
  assert.equal(result.status, 'copied');
  assert.equal(result.copiedMedia, 1);
  assert.equal(await readFile(join(f.targetDataDir, 'media', 'audio-1.wav'), 'utf8'), 'voice fixture');
  assert.equal(await missing(join(f.targetDataDir, 'media', 'unrelated.txt')), true);
  assert.equal(await readFile(join(media, 'audio-1.wav'), 'utf8'), 'voice fixture');
});

test('备份失败不发布残缺的新库，临时数据库会清理', async t => {
  const f = await fixture(t);
  await mkdir(f.sourceDataDir, { recursive: true });
  await writeFile(join(f.sourceDataDir, 'workspace.sqlite'), '不是数据库', 'utf8');
  await assert.rejects(bootstrapProfile(f));
  assert.equal(await missing(join(f.targetDataDir, 'workspace.sqlite')), true);
  const remaining = await readdir(f.targetDataDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.deepEqual(remaining.filter(name => name.includes('migration')), []);
});

test('同时初始化时只发布一个完整数据库，后到者不覆盖', async t => {
  const f = await fixture(t);
  (await f.source()).prepare('INSERT INTO sample VALUES(?)').run('一致的快照');
  const results = await Promise.all([bootstrapProfile(f), bootstrapProfile(f)]);
  assert.equal(results.filter(result => result.status === 'copied').length, 1);
  assert.equal(results.filter(result => result.status === 'existing').length, 1);
  const target = new DatabaseSync(join(f.targetDataDir, 'workspace.sqlite'), { readOnly: true });
  try { assert.equal(target.prepare('SELECT value FROM sample').get().value, '一致的快照'); }
  finally { target.close(); }
});
