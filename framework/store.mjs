import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { moduleDefinitions, defaultConfig } from './registry.mjs';
import { characterBundle, importedCharacter, WorkbenchError } from './contracts.mjs';
import { drawingConfig } from './drawing-config.mjs';
import {characterAvatar,validateAvatar} from './user-profile.mjs';
const configurationOwner = id => id === 'comfyui' ? 'drawing' : id;
const deletedCharacterSetting = id => `character.deleted.${id}`;

export class WorkbenchStore {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS modules (
        id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL, checks TEXT NOT NULL DEFAULT '{}',
        config_revision INTEGER NOT NULL DEFAULT 0, last_opened_at TEXT
      );
      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL, raw TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        module_id TEXT REFERENCES modules(id), character_id TEXT NOT NULL REFERENCES characters(id),
        ref TEXT, PRIMARY KEY(character_id, id)
      );
      CREATE INDEX IF NOT EXISTS assets_module ON assets(module_id);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, module_id TEXT REFERENCES modules(id),
        character_id TEXT REFERENCES characters(id), kind TEXT NOT NULL,
        level TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_module ON events(module_id);
    `);
    const hadDrawing = this.db.prepare('SELECT enabled FROM modules WHERE id = ?').get('drawing')?.enabled === 1;
    const insert = this.db.prepare('INSERT INTO modules(id, config) VALUES(?, ?) ON CONFLICT(id) DO NOTHING');
    for (const definition of moduleDefinitions) {
      const config = defaultConfig(definition);
      const inserted = insert.run(definition.id, JSON.stringify(['drawing','comfyui'].includes(definition.id) ? drawingConfig(config) : config));
      if (definition.id === 'comfyui' && inserted.changes && hadDrawing) this.db.prepare('UPDATE modules SET enabled = 1 WHERE id = ?').run('comfyui');
    }
    if (this.getSetting('preferences') === undefined) this.setSetting('preferences', { theme: 'light' });
    if (this.getSetting('moduleGuides') === undefined) this.setSetting('moduleGuides', {});
    if (this.getSetting('selectedCharacterId') === undefined) this.setSetting('selectedCharacterId', null);
  }

  getSetting(name) { const row = this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name); return row ? JSON.parse(row.value) : undefined; }
  setSetting(name, value) { this.db.prepare('INSERT INTO settings VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, JSON.stringify(value)); }

  module(id) {
    const row = this.db.prepare('SELECT * FROM modules WHERE id = ?').get(id);
    if (!row) throw new WorkbenchError(404, '找不到这个模块。');
    const source = id === 'comfyui' ? this.db.prepare('SELECT * FROM modules WHERE id = ?').get('drawing') : row;
    const config = JSON.parse(source.config);
    return { id, enabled: Boolean(row.enabled), config: ['drawing','comfyui'].includes(id) ? drawingConfig(config) : config, checks: JSON.parse(source.checks), lastOpenedAt: row.last_opened_at, configRevision: source.config_revision };
  }

  setEnabled(id, enabled) {
    const current = this.module(id);
    if (current.enabled === enabled) return;
    this.db.prepare('UPDATE modules SET enabled = ? WHERE id = ?').run(Number(enabled), id);
    this.event({ moduleId: id, kind: enabled ? 'module.enabled' : 'module.disabled', message: enabled ? '模块已启用。' : '模块已停用，配置仍然保留。' });
  }

  markModuleGuideSeen(id) {
    this.module(id);
    const moduleGuides = this.getSetting('moduleGuides');
    if (moduleGuides[id] !== true) this.setSetting('moduleGuides', { ...moduleGuides, [id]: true });
    return { seen: true };
  }

  openModule(id) {
    if (!this.module(id).enabled) throw new WorkbenchError(409, '请先启用这个模块。');
    this.db.prepare('UPDATE modules SET last_opened_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    this.event({ moduleId: id, kind: 'module.opened', message: '已打开模块工作区。' });
  }

  saveConfig(id, values) {
    id = configurationOwner(id);
    const current = this.module(id);
    const persisted = id === 'drawing' ? JSON.parse(this.db.prepare('SELECT config FROM modules WHERE id = ?').get(id).config) : current.config;
    if (id === 'drawing') values = drawingConfig({ ...current.config, ...values });
    const changed = Object.entries(values).filter(([key, value]) => persisted[key] !== value);
    if (!changed.length) return;
    for (const [key, value] of changed) { current.config[key] = value; delete current.checks[key]; }
    this.db.prepare('UPDATE modules SET config = ?, checks = ?, config_revision = config_revision + 1 WHERE id = ?')
      .run(JSON.stringify(current.config), JSON.stringify(current.checks), id);
    this.event({ moduleId: id, kind: 'module.config.saved', message: '模块配置已保存。' });
  }

  saveDrawingConfiguration(values, runtimeSettings) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveConfig('drawing', values);
      this.setSetting('drawing.runtime', runtimeSettings);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  applyChecks(id, configRevision, checks) {
    id = configurationOwner(id);
    // 检查期间用户可能已经修改配置，旧结果不能覆盖新的配置状态。
    const result = this.db.prepare('UPDATE modules SET checks = ? WHERE id = ? AND config_revision = ?')
      .run(JSON.stringify(checks), id, configRevision);
    if (result.changes) this.event({ moduleId: id, kind: 'module.paths.checked', message: '路径检查完成；未启动工具或连接服务。' });
    return this.module(id).checks;
  }

  character(id, { includeDeleted = false } = {}) {
    const row = this.db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!row || (!includeDeleted && this.getSetting(deletedCharacterSetting(id)))) return null;
    const assets = this.db.prepare('SELECT * FROM assets WHERE character_id = ? ORDER BY rowid').all(id).map(asset => ({
      id: asset.id, kind: asset.kind, name: asset.name, moduleId: asset.module_id,
      characterId: asset.character_id, ...(asset.ref ? { ref: asset.ref } : {}),
    }));
    const character={ id: row.id, name: row.name, description: row.description, revision: row.revision, updatedAt: row.updated_at, raw: JSON.parse(row.raw), assets };
    return {...character,avatar:characterAvatar(character)};
  }

  requireCharacter(id) {
    const character = this.character(id);
    if (!character) throw new WorkbenchError(404, '找不到这个角色。');
    return character;
  }

  deletedCharacters() {
    return this.db.prepare('SELECT c.id, s.value FROM characters c JOIN settings s ON s.name = ? || c.id ORDER BY s.rowid DESC')
      .all('character.deleted.').map(row => ({ ...this.character(row.id, { includeDeleted: true }), deletedAt: JSON.parse(row.value).deletedAt }));
  }

  archiveCharacter(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.character(id, { includeDeleted: true })) throw new WorkbenchError(404, '找不到这个角色。');
      const setting = deletedCharacterSetting(id);
      if (!this.getSetting(setting)) {
        this.setSetting(setting, { deletedAt: new Date().toISOString() });
        if (this.getSetting('selectedCharacterId') === id) this.setSetting('selectedCharacterId', null);
        this.event({ characterId: id, kind: 'character.archived', message: '角色已移入已删除角色，资料仍保留，可随时恢复。' });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { deleted: true, archived: true, id };
  }

  restoreCharacter(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const character = this.character(id, { includeDeleted: true });
      if (!character) throw new WorkbenchError(404, '找不到这个角色。');
      const restored = this.db.prepare('DELETE FROM settings WHERE name = ?').run(deletedCharacterSetting(id));
      if (restored.changes) this.event({ characterId: id, kind: 'character.restored', message: '角色已恢复到资料库。' });
      this.db.exec('COMMIT');
      return character;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setCharacterAvatar(id,avatar){
    const character=this.requireCharacter(id),raw=structuredClone(character.raw);
    const value=validateAvatar(avatar);
    if(character.avatar===value)return character;
    raw.extensions={...raw.extensions,workbenchAvatar:value};
    const next={...character,raw,revision:character.revision+1};
    try{importedCharacter({document:characterBundle(next)});}
    catch(error){if(error instanceof WorkbenchError)throw new WorkbenchError(400,'头像与人设合计过大或格式无效。请从“更换头像”选择图片以生成缩略图，或缩减角色原始资料。');throw error;}
    this.db.prepare('UPDATE characters SET raw = ?, revision = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(raw),next.revision,new Date().toISOString(),id);
    return this.requireCharacter(id);
  }

  saveCharacter(character, imported = false) {
    const existing = this.character(character.id, { includeDeleted: true });
    if (existing) {
      if (!isDeepStrictEqual(characterBundle(existing).character, characterBundle(character).character)) throw new WorkbenchError(409, '已有相同标识的角色，但内容或版本不同。请先解决冲突，原角色未被覆盖。');
      if (this.getSetting(deletedCharacterSetting(character.id))) {
        if (imported) return this.restoreCharacter(character.id);
        throw new WorkbenchError(409, '这个角色已移入已删除角色，请先恢复，或重新导入相同角色资料包。');
      }
      return existing;
    }
    const at = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO characters VALUES(?, ?, ?, ?, ?, ?)')
        .run(character.id, character.name, character.description, character.revision, at, JSON.stringify(character.raw));
      const insertAsset = this.db.prepare('INSERT INTO assets VALUES(?, ?, ?, ?, ?, ?)');
      for (const asset of character.assets) insertAsset.run(asset.id, asset.kind, asset.name, asset.moduleId, character.id, asset.ref ?? null);
      this.event({ characterId: character.id, kind: imported ? 'character.imported' : 'character.created', message: imported ? '角色资料已导入。' : '角色资料已创建。' });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.character(character.id);
  }

  selectCharacter(id) {
    if (id !== null) this.requireCharacter(id);
    if (this.getSetting('selectedCharacterId') === id) return;
    this.setSetting('selectedCharacterId', id);
    this.event({ characterId: id, kind: 'character.selected', message: id === null ? '已取消当前角色选择。' : '已切换当前角色。' });
  }

  exportCharacter(id) {
    const bundle = characterBundle(this.requireCharacter(id));
    this.event({ characterId: id, kind: 'character.exported', message: '已导出角色资料包。' });
    return bundle;
  }

  event({ moduleId = null, characterId = null, kind, level = 'info', message }) {
    this.db.prepare('INSERT INTO events VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), moduleId, characterId, kind, level, message, new Date().toISOString());
    this.db.exec('DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT 500)');
  }

  events(moduleId) {
    const rows = moduleId === undefined
      ? this.db.prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT 500').all()
      : this.db.prepare('SELECT * FROM events WHERE module_id = ? ORDER BY rowid DESC LIMIT 500').all(moduleId);
    return rows.map(row => ({ id: row.id, moduleId: row.module_id, characterId: row.character_id, kind: row.kind, level: row.level, message: row.message, at: row.at }));
  }

  state() {
    return {
      modules: moduleDefinitions.map(definition => {
        const { configRevision, ...current } = this.module(definition.id);
        return { ...definition, ...current };
      }),
      characters: this.db.prepare('SELECT id FROM characters ORDER BY rowid').all().map(row => this.character(row.id)).filter(Boolean),
      selectedCharacterId: this.getSetting('selectedCharacterId'), preferences: this.getSetting('preferences'),
      moduleGuides: this.getSetting('moduleGuides'),
      events: this.events(), tasks: [],
    };
  }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
