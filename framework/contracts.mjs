import { randomUUID } from 'node:crypto';
import { moduleDefinition } from './registry.mjs';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 1900 * 1024;

export class WorkbenchError extends Error {
  constructor(status, message) { super(message); this.name = 'WorkbenchError'; this.status = status; }
}

export function object(value, label = '请求') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError(400, `${label}必须是 JSON 对象。`);
  return value;
}

export function fields(value, allowed, label = '请求') {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new WorkbenchError(400, `${label}包含不支持的字段。`);
  return value;
}

export function text(value, label, max, { empty = false, trim = true } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new WorkbenchError(400, `${label}必须是长度不超过 ${max} 的文字。`);
  const result = trim ? value.trim() : value;
  if (!empty && !result) throw new WorkbenchError(400, `${label}不能为空。`);
  return result;
}

export function identifier(value, label = '标识') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new WorkbenchError(400, `${label}格式无效。`);
  return value;
}

export function knownModule(id) {
  const definition = moduleDefinition(id);
  if (!definition) throw new WorkbenchError(404, '找不到这个模块。');
  return definition;
}

export function configValues(definition, input) {
  fields(input, ['values']);
  const values = object(input.values, '配置');
  const allowed = new Map(definition.settings.map(setting => [setting.key, setting]));
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    const setting = allowed.get(key);
    if (!setting) throw new WorkbenchError(400, '配置包含不属于这个模块的字段。');
    result[key] = text(value, setting.label, setting.type === 'path' ? 4096 : setting.type === 'url' ? 2048 : 1000, { empty: true });
    if (setting.type === 'url' && result[key]) {
      let url;
      try { url = new URL(result[key]); } catch { throw new WorkbenchError(400, `${setting.label}不是有效网址。`); }
      const protocols = definition.id === 'qq' ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
      if (!protocols.includes(url.protocol) || !url.hostname) throw new WorkbenchError(400, `${setting.label}的协议不受支持。`);
    }
    if (/[\u0000-\u001f\u007f]/.test(result[key])) throw new WorkbenchError(400, `${setting.label}含有无效控制字符。`);
  }
  return result;
}

export function rawDocument(value) {
  object(value, '原始角色卡');
  let count = 0;
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (++count > 50_000 || current.depth > 64) throw new WorkbenchError(400, '角色卡结构过于复杂。');
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RAW_BYTES) throw new WorkbenchError(400, '原始角色卡过大，请控制在 1900 KiB 以内。');
  return value;
}

function assetRef(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\u0000-\u001f\u007f?#%]/.test(value) || value.startsWith('/')) return undefined;
  if (value.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return value;
}

function assets(value, characterId) {
  if (!Array.isArray(value) || value.length > 500) throw new WorkbenchError(400, '素材索引必须是最多 500 项的数组。');
  const ids = new Set();
  return value.map(entry => {
    object(entry, '素材记录');
    const id = identifier(entry.id, '素材标识');
    if (ids.has(id)) throw new WorkbenchError(400, '素材标识不能重复。');
    ids.add(id);
    if (entry.characterId !== characterId) throw new WorkbenchError(400, '素材所属角色与角色包不一致。');
    const moduleId = entry.moduleId ?? null;
    if (moduleId !== null) knownModule(moduleId);
    const ref = assetRef(entry.ref);
    return { id, kind: text(entry.kind, '素材类型', 64), name: text(entry.name, '素材名称', 240), moduleId, characterId, ...(ref ? { ref } : {}) };
  });
}

export function newCharacter(input) {
  fields(input, ['name', 'description', 'raw']);
  return exportableCharacter({
    id: randomUUID(), name: text(input.name, '角色名字', 120),
    description: text(input.description ?? '', '角色简介', 64_000, { empty: true }), revision: 1,
    raw: rawDocument(input.raw ?? {}), assets: [],
  });
}

export function importedCharacter(input) {
  fields(input, ['document']);
  const document = object(input.document, '导入内容');
  if (document.format === 'ai-future-character') {
    if (document.schemaVersion !== 1) throw new WorkbenchError(400, '不支持这个角色包版本。');
    const character = object(document.character, '角色包中的角色');
    const id = identifier(character.id, '角色标识');
    if (!Number.isSafeInteger(character.revision) || character.revision < 1) throw new WorkbenchError(400, '角色版本必须是正整数。');
    return exportableCharacter({
      id, name: text(character.name, '角色名字', 120),
      description: text(character.description ?? '', '角色简介', 64_000, { empty: true }),
      revision: character.revision, raw: rawDocument(character.raw), assets: assets(character.assets ?? [], id),
    });
  }
  if (document.format && (document.schemaVersion !== undefined || document.character !== undefined)) throw new WorkbenchError(400, '不支持这个角色包格式。');
  rawDocument(document);
  return newCharacter({ name: document.name ?? document.data?.name, description: document.description ?? document.data?.description ?? '', raw: document });
}

export function characterBundle(character) {
  return { format: 'ai-future-character', schemaVersion: 1, character: {
    id: character.id, name: character.name, description: character.description,
    revision: character.revision, raw: character.raw, assets: assets(character.assets, character.id),
  } };
}

function exportableCharacter(character) {
  // 必须按实际导入信封计量：原卡、重复简介、素材及 UTF-8 字节都占用同一预算。
  const bytes = Buffer.byteLength(JSON.stringify({ document: characterBundle(character) }));
  if (bytes > MAX_BODY_BYTES) throw new WorkbenchError(400, '角色资料包超过 2 MiB，请缩减原始卡片、简介或素材索引后重试。');
  return character;
}

export function publicEvent(input) {
  fields(input, ['moduleId', 'characterId', 'kind', 'level', 'message']);
  if (!['module.load.failed', 'module.loaded'].includes(input.kind)) throw new WorkbenchError(400, '不支持这个事件类型。');
  if (!['error', 'info'].includes(input.level)) throw new WorkbenchError(400, '事件级别必须是 error 或 info。');
  if ((input.kind === 'module.loaded' && input.level !== 'info') || (input.kind === 'module.load.failed' && input.level !== 'error')) throw new WorkbenchError(400, '事件类型与级别不一致。');
  const moduleId = input.moduleId ?? null;
  const characterId = input.characterId ?? null;
  if (moduleId !== null) knownModule(moduleId);
  if (characterId !== null) identifier(characterId, '角色标识');
  if (input.kind === 'module.loaded' && moduleId === null) throw new WorkbenchError(400, '模块加载事件必须指定模块。');
  const message = text(input.message, '事件内容', 1000)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, '[本地路径]')
    .replace(/(^|[\s("'=])\/(?:[^/\s]+\/)+[^\s"'<>]*/g, '$1[本地路径]');
  return { moduleId, characterId, kind: input.kind, level: input.level, message };
}
