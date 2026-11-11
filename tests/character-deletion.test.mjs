import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchStore } from '../framework/store.mjs';
import { characterBundle, importedCharacter, newCharacter } from '../framework/contracts.mjs';
import { CharacterLife } from '../framework/character-life/service.mjs';
import { CharacterResources } from '../framework/character-resources.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'workbench-character-deletion-'));
  let store, life, resources;
  function open() {
    store = new WorkbenchStore(dataDir);
    life = new CharacterLife({ store, dataDir, sharedAI: { config: () => ({ enabled: false }) } });
    resources = new CharacterResources({ store, dataDir });
  }
  open();
  t.after(async () => {
    await life.close(); store.close();
    const target = resolve(dataDir);
    assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(target, { recursive: true, force: true });
  });
  return {
    dataDir,
    get store() { return store; }, get life() { return life; }, get resources() { return resources; },
    async restart() { await life.close(); store.close(); open(); },
  };
}

const status = expected => error => error?.name === 'WorkbenchError' && error.status === expected;

test('删除当前角色移入可恢复列表，正常读取、选择和导出均不再提供它', async t => {
  const app = await fixture(t), character = app.store.saveCharacter(newCharacter({ name: '小汐', raw: { identity: '原始资料' } }));
  app.store.selectCharacter(character.id);
  assert.deepEqual(app.store.archiveCharacter(character.id), { deleted: true, archived: true, id: character.id });
  assert.equal(app.store.character(character.id), null);
  assert.deepEqual(app.store.state().characters, []);
  assert.equal(app.store.state().selectedCharacterId, null);
  assert.throws(() => app.store.requireCharacter(character.id), status(404));
  assert.throws(() => app.store.selectCharacter(character.id), status(404));
  assert.throws(() => app.store.exportCharacter(character.id), status(404));
  assert.deepEqual(app.store.character(character.id, { includeDeleted: true }), character);
  const [{ deletedAt, ...deleted }] = app.store.deletedCharacters();
  assert.deepEqual(deleted, character);
  assert.ok(Number.isFinite(Date.parse(deletedAt)));
  assert.equal(app.store.events().filter(event => event.kind === 'character.archived' && event.characterId === character.id).length, 1);
});

test('重复删除保持原归档时间和单次事件，不影响其他当前角色；恢复也不切换选择', async t => {
  const app = await fixture(t), first = app.store.saveCharacter(newCharacter({ name: '第一位' }));
  const other = app.store.saveCharacter(newCharacter({ name: '另一位' }));
  app.store.selectCharacter(other.id);
  app.store.archiveCharacter(first.id);
  const deleted = app.store.deletedCharacters(), events = app.store.events();
  assert.deepEqual(app.store.archiveCharacter(first.id), { deleted: true, archived: true, id: first.id });
  assert.deepEqual(app.store.deletedCharacters(), deleted);
  assert.deepEqual(app.store.events(), events);
  assert.equal(app.store.getSetting('selectedCharacterId'), other.id);
  assert.deepEqual(app.store.restoreCharacter(first.id), first);
  assert.deepEqual(app.store.restoreCharacter(first.id), first);
  assert.deepEqual(app.store.deletedCharacters(), []);
  assert.equal(app.store.getSetting('selectedCharacterId'), other.id);
  assert.equal(app.store.events().filter(event => event.kind === 'character.restored').length, 1);
});

test('删除及恢复跨重启持久化，角色设置、记忆、素材索引和资源文件原样保留', async t => {
  const app = await fixture(t), character = app.store.saveCharacter(newCharacter({ name: '小汐', description: '完整保存', raw: { extra: ['中文', { value: 7 }] } }));
  app.life.configure(character.id, { mode: 'full', memory: { autoExtract: false, sharing: 'character' } });
  app.life.saveMemory(character.id, { content: '念念喜欢杏花', kind: 'preference', sourceQuote: '我喜欢杏花', pinned: true });
  const bytes = Buffer.from('不可丢失的角色模型');
  const resource = await app.resources.add(character.id, { name: '角色模型.bin', kind: 'model', base64: bytes.toString('base64'), sourceModuleId: 'drawing' });
  app.store.selectCharacter(character.id);
  const before = app.store.requireCharacter(character.id), lifeBefore = app.life.view(character.id);
  const indexBefore = app.store.db.prepare('SELECT * FROM assets WHERE character_id = ?').all(character.id);
  const settingsBefore = app.life.data.get(character.id, 'settings', 'settings'), memoriesBefore = app.life.data.list(character.id, 'memory');
  app.store.archiveCharacter(character.id);
  await app.restart();
  assert.equal(app.store.character(character.id), null);
  assert.equal(app.store.state().selectedCharacterId, null);
  assert.deepEqual(app.store.character(character.id, { includeDeleted: true }), before);
  assert.equal(app.store.deletedCharacters()[0].id, character.id);
  assert.deepEqual(app.store.db.prepare('SELECT * FROM assets WHERE character_id = ?').all(character.id), indexBefore);
  assert.deepEqual(app.life.data.get(character.id, 'settings', 'settings'), settingsBefore);
  assert.deepEqual(app.life.data.list(character.id, 'memory'), memoriesBefore);
  assert.deepEqual(await readFile(join(app.dataDir, 'character-resources', `${resource.id}.bin`)), bytes);
  assert.throws(() => app.resources.list(character.id), status(404));
  await assert.rejects(app.resources.file(character.id, resource.id), status(404));
  assert.deepEqual(app.store.restoreCharacter(character.id), before);
  assert.equal(app.store.getSetting('selectedCharacterId'), null);
  assert.deepEqual(app.life.view(character.id), lifeBefore);
  assert.deepEqual(app.resources.list(character.id), [resource]);
  assert.deepEqual((await app.resources.file(character.id, resource.id)).bytes, bytes);
  await app.restart();
  assert.deepEqual(app.store.requireCharacter(character.id), before);
  assert.deepEqual(app.store.deletedCharacters(), []);
  assert.deepEqual(app.life.view(character.id), lifeBefore);
});

test('资料库删除不传播到其他模块资料库中已导入的独立角色副本', async t => {
  const library = await fixture(t), instance = await fixture(t);
  const source = library.store.saveCharacter(newCharacter({ name: '共享来源', raw: { personality: '保留' } }));
  const copy = instance.store.saveCharacter(importedCharacter({ document: characterBundle(source) }), true);
  instance.store.selectCharacter(copy.id);
  instance.life.configure(copy.id, { memory: { autoExtract: false } });
  instance.life.saveMemory(copy.id, { content: '模块自己的记忆' });
  const before = instance.life.view(copy.id), stateBefore = instance.store.state();
  library.store.archiveCharacter(source.id);
  assert.deepEqual(instance.store.requireCharacter(copy.id), copy);
  assert.deepEqual(instance.store.state(), stateBefore);
  assert.deepEqual(instance.life.view(copy.id), before);
  assert.deepEqual(instance.store.deletedCharacters(), []);
  library.store.restoreCharacter(source.id);
  assert.deepEqual(instance.life.view(copy.id), before);
});

test('重新导入相同资料包恢复归档角色；普通保存和冲突版本不覆盖归档内容', async t => {
  const app = await fixture(t), character = app.store.saveCharacter(newCharacter({ name: '小汐', raw: { custom: '保留' } }));
  const bundle = app.store.exportCharacter(character.id);
  app.store.archiveCharacter(character.id);
  assert.throws(() => app.store.saveCharacter(importedCharacter({ document: bundle })), status(409));
  for (const patch of [{ revision: 2 }, { name: '重名冲突' }, { raw: { custom: '被改动' } }]) {
    const changed = importedCharacter({ document: { ...bundle, character: { ...bundle.character, ...patch } } });
    assert.throws(() => app.store.saveCharacter(changed, true), status(409));
  }
  assert.equal(app.store.character(character.id), null);
  assert.deepEqual(app.store.character(character.id, { includeDeleted: true }), character);
  assert.deepEqual(app.store.saveCharacter(importedCharacter({ document: bundle }), true), character);
  assert.deepEqual(app.store.deletedCharacters(), []);
  assert.equal(app.store.getSetting('selectedCharacterId'), null);
  assert.equal(app.store.state().characters.length, 1);
});

test('删除后仍可新建同名角色，恢复时两份身份和原始资料各自独立', async t => {
  const app = await fixture(t), first = app.store.saveCharacter(newCharacter({ name: '小汐', raw: { version: '原角色' } }));
  app.store.archiveCharacter(first.id);
  const second = app.store.saveCharacter(newCharacter({ name: '小汐', raw: { version: '新角色' } }));
  assert.notEqual(first.id, second.id);
  assert.deepEqual(app.store.state().characters, [second]);
  assert.deepEqual(app.store.restoreCharacter(first.id), first);
  assert.deepEqual(app.store.state().characters, [first, second]);
});

test('不存在的角色不能删除或恢复，原有选择与资料不变', async t => {
  const app = await fixture(t), character = app.store.saveCharacter(newCharacter({ name: '保留的角色' }));
  app.store.selectCharacter(character.id);
  const before = app.store.state();
  assert.throws(() => app.store.archiveCharacter('missing-character'), status(404));
  assert.throws(() => app.store.restoreCharacter('missing-character'), status(404));
  assert.deepEqual(app.store.state(), before);
  assert.deepEqual(app.store.deletedCharacters(), []);
});

test('删除事件落盘失败时同时回滚归档标记和当前选择，恢复失败时继续保持归档', async t => {
  const app = await fixture(t), character = app.store.saveCharacter(newCharacter({ name: '事务角色' }));
  app.store.selectCharacter(character.id);
  app.store.db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON events WHEN NEW.kind = 'character.archived' BEGIN SELECT RAISE(ABORT, 'archive-event-failed'); END");
  const before = app.store.state();
  assert.throws(() => app.store.archiveCharacter(character.id), /archive-event-failed/);
  assert.deepEqual(app.store.state(), before);
  assert.deepEqual(app.store.deletedCharacters(), []);
  app.store.db.exec('DROP TRIGGER reject_archive');
  app.store.archiveCharacter(character.id);
  app.store.db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON events WHEN NEW.kind = 'character.restored' BEGIN SELECT RAISE(ABORT, 'restore-event-failed'); END");
  const deleted = app.store.deletedCharacters(), events = app.store.events();
  assert.throws(() => app.store.restoreCharacter(character.id), /restore-event-failed/);
  assert.equal(app.store.character(character.id), null);
  assert.deepEqual(app.store.deletedCharacters(), deleted);
  assert.deepEqual(app.store.events(), events);
});

test('只读角色上下文无需升级数据库即可读取普通和已删除角色', async t => {
  const app = await fixture(t), character = app.store.saveCharacter(newCharacter({ name: '旧版资料' }));
  const reader = Object.create(WorkbenchStore.prototype);
  reader.db = new DatabaseSync(join(app.dataDir, 'workbench.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(reader.requireCharacter(character.id), character);
    assert.deepEqual(reader.deletedCharacters(), []);
    app.store.archiveCharacter(character.id);
    assert.equal(reader.character(character.id), null);
    assert.equal(reader.deletedCharacters()[0].id, character.id);
    assert.deepEqual(reader.character(character.id, { includeDeleted: true }), character);
  } finally { reader.close(); }
});
