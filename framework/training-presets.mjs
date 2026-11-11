import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { WorkbenchError, fields, identifier, object, text } from './contracts.mjs';

const secret = /password|secret|authorization|credential|api.?key|(?:^|_)(?:access_?|hf_?)?token$/i;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const limit = 1024 * 1024;
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);

export function cleanTrainingConfig(value, { requireType = true } = {}) {
  object(value, '训练参数');
  function visit(item, depth = 0) {
    if (depth > 24) throw new WorkbenchError(400, '训练参数嵌套过深。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return Object.fromEntries(Object.entries(item).filter(([key]) => {
        if (forbidden.has(key)) throw new WorkbenchError(400, '训练参数包含禁止的原型字段。');
        return !secret.test(key);
      }).map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    throw new WorkbenchError(400, '训练参数必须是有效 JSON，数字必须有限。');
  }
  const result = visit(value);
  if (Buffer.byteLength(JSON.stringify(result)) > limit) throw new WorkbenchError(413, '训练预设超过 1 MiB。');
  if (requireType && (typeof result.model_train_type !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(result.model_train_type))) throw new WorkbenchError(400, '训练预设需要有效的 model_train_type 训练类型。');
  return result;
}

export function parseTrainingPreset(value) {
  fields(value, ['format', 'text']);
  if (!['json', 'toml'].includes(value.format)) throw new WorkbenchError(400, '预设格式必须为 JSON 或 TOML。');
  if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > limit) throw new WorkbenchError(413, '训练预设超过 1 MiB。');
  let document;
  try { document = value.format === 'toml' ? parse(value.text, { unsafeKeyBehaviour: 'throw' }) : JSON.parse(value.text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new WorkbenchError(400, `${value.format.toUpperCase()} 预设格式无效：${String(error.message).slice(0, 300)}`); }
  object(document, '训练预设');
  const rawConfig = typeof document.model_train_type === 'string';
  if (!rawConfig && document.format !== undefined && document.format !== 'ai-future-training-preset') throw new WorkbenchError(400, '无法识别这个训练预设格式。');
  if (!rawConfig && document.version !== undefined && document.format && document.version !== 1) throw new WorkbenchError(400, '训练预设版本不支持。');
  const config = cleanTrainingConfig(rawConfig ? document : document.config ?? document.form ?? document);
  return { config, ...(typeof document.name === 'string' ? { name: document.name.slice(0, 120) } : {}) };
}

export function exportTrainingPreset(value) {
  fields(value, ['format', 'name', 'config']);
  if (!['json', 'toml'].includes(value.format)) throw new WorkbenchError(400, '预设格式必须为 JSON 或 TOML。');
  const config = cleanTrainingConfig(value.config), name = text(value.name || '训练预设', '预设名称', 120);
  if (value.format === 'toml') {
    const hasNull = item => item === null || typeof item === 'object' && Object.values(item).some(hasNull);
    if (hasNull(config)) throw new WorkbenchError(422, 'TOML 无法保存 null 参数，请选择 JSON 导出以保留完整配置。');
  }
  const content = value.format === 'toml' ? stringify(config) : JSON.stringify({ format: 'ai-future-training-preset', version: 1, name, config }, null, 2) + '\n';
  return { content, mime: value.format === 'toml' ? 'application/toml' : 'application/json', filename: name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.' + value.format };
}

export class TrainingPresets {
  constructor(db, owner) {
    this.db = db; this.owner = owner;
    db.exec('CREATE TABLE IF NOT EXISTS training_presets(owner TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,config TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,id));');
  }
  row(id) { identifier(id, '预设编号'); return this.db.prepare('SELECT * FROM training_presets WHERE owner=? AND id=?').get(this.owner, id); }
  public(row) { return { id: row.id, name: row.name, config: JSON.parse(row.config), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, source: 'workbench' }; }
  list() { return { presets: this.db.prepare('SELECT * FROM training_presets WHERE owner=? ORDER BY updated_at DESC,id').all(this.owner).map(row => this.public(row)) }; }
  get(id) { const row = this.row(id); if (!row) throw new WorkbenchError(404, '找不到当前实例的训练预设。'); return { preset: this.public(row) }; }
  save(value) {
    fields(value, ['id', 'revision', 'name', 'config']);
    const id = identifier(value.id || randomUUID(), '预设编号'), name = text(value.name, '预设名称', 120);
    const config = cleanTrainingConfig(value.config), serialized = JSON.stringify(config), previous = this.row(id), at = new Date().toISOString();
    if (!previous) {
      if (value.revision !== undefined && value.revision !== 0) throw new WorkbenchError(409, '预设已删除或版本不匹配，请刷新后另存。');
      this.db.prepare('INSERT INTO training_presets VALUES(?,?,?,?,?,?,?)').run(this.owner, id, name, serialized, 1, at, at);
    } else {
      if (value.revision === 0 && previous.name === name && canonical(JSON.parse(previous.config)) === canonical(config)) return { ...this.get(id), reused: true };
      if (!Number.isInteger(value.revision) || value.revision !== previous.revision) throw new WorkbenchError(409, '预设已被修改，请刷新后重新保存。');
      this.db.prepare('UPDATE training_presets SET name=?,config=?,revision=revision+1,updated_at=? WHERE owner=? AND id=? AND revision=?').run(name, serialized, at, this.owner, id, value.revision);
    }
    return this.get(id);
  }
  remove(id, value) {
    fields(value, ['revision']); const { preset } = this.get(id);
    if (value.revision !== preset.revision) throw new WorkbenchError(409, '预设已被修改，请刷新后重新删除。');
    this.db.prepare('DELETE FROM training_presets WHERE owner=? AND id=? AND revision=?').run(this.owner, id, value.revision);
    return { deleted: true, id };
  }
}
