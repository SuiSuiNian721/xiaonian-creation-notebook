import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readUserProfile } from './user-profile.mjs';

const DEFINITIONS = Object.freeze({
  neutral: Object.freeze({ id: 'neutral', name: '中性助手', builtin: true,
    prompt: '你是协助用户创作角色卡与世界观卡的中性助手。不设定性别、私人关系或固定昵称；用自然、准确的语言帮助用户构思、写作和核对内容。' }),
  xiaoxi: Object.freeze({ id: 'xiaoxi', name: '林小汐', builtin: true, file: path.join('workflow', '小汐.md') }),
  momo: Object.freeze({ id: 'momo', name: '茉茉', builtin: true, file: path.join('personas', '茉茉.md') }),
});
const CUSTOM_ID = /^custom_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_PERSONAS = 50;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

const hiddenInWorkbench = id => process.env.XIAOXI_WORKBENCH === '1' && ['neutral', 'momo'].includes(id);
const defaultPersonaId = () => process.env.XIAOXI_WORKBENCH === '1' ? 'xiaoxi' : 'neutral';

function personaError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function isCustomPersonaId(id) {
  return typeof id === 'string' && CUSTOM_ID.test(id);
}

function checkedId(id) {
  if (typeof id !== 'string' || (!Object.hasOwn(DEFINITIONS, id) && !isCustomPersonaId(id))) {
    throw personaError('未知对话人设 ID');
  }
  return id;
}

// 从卷根逐段核对，注册表、选择和人物文件都不能经由链接离开指定工作区。
function checkedPath(root, ...parts) {
  if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root)) throw personaError('人设工作区必须是绝对路径');
  const absolute = path.resolve(root), target = path.resolve(absolute, ...parts);
  const relative = path.relative(absolute, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw personaError('人设路径超出工作区');
  const base = path.parse(target).root;
  let current = base;
  const segments = target.slice(base.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw personaError('人设路径不允许符号链接或 junction');
    if (index < segments.length - 1 && !stat.isDirectory()) throw personaError('人设路径包含非目录项目');
    if (index === segments.length - 1 && !stat.isFile()) throw personaError('人设目标必须是普通文件');
  }
  return target;
}

function readJson(root, filename) {
  const file = checkedPath(root, 'work', filename);
  let bytes;
  try {
    if (fs.statSync(file).size > MAX_REGISTRY_BYTES) throw personaError('人设配置过大，原文件已保留', 500);
    bytes = fs.readFileSync(file);
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw personaError('人设配置损坏或不是有效 UTF-8 JSON，原文件已保留', 500); }
}

function validateContent(value, keys = ['id', 'name', 'prompt']) {
  if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))
    || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'prompt')
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60 || /[\u0000-\u001f\u007f]/.test(value.name)
    || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 20000 || value.prompt.includes('\0')) {
    throw personaError('人设格式不正确：名称须为 1–60 字，正文须为 1–20000 字，且不能含非法字段或控制字符');
  }
  return { name: value.name.trim(), prompt: value.prompt };
}

function readRegistry(root) {
  const data = readJson(root, 'personas.json');
  if (data === undefined) return [];
  try {
    if (!plainObject(data) || Object.keys(data).length !== 2 || data.version !== 1 || !Array.isArray(data.personas)
      || data.personas.length > MAX_PERSONAS) throw new Error('schema');
    const seen = new Set();
    return data.personas.map(value => {
      const content = validateContent(value);
      if (!Object.hasOwn(value, 'id') || !isCustomPersonaId(value.id) || seen.has(value.id)) throw new Error('id');
      seen.add(value.id);
      return { id: value.id, ...content };
    });
  } catch { throw personaError('自定义人设注册表格式损坏，原文件已保留', 500); }
}

function atomicWrite(root, filename, value) {
  const file = checkedPath(root, 'work', filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  checkedPath(root, 'work', filename);
  const tempName = filename + '.' + randomUUID() + '.tmp';
  const temp = checkedPath(root, 'work', tempName);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    checkedPath(root, 'work', filename);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function personaById(id, root) {
  checkedId(id);
  if (Object.hasOwn(DEFINITIONS, id)) return DEFINITIONS[id];
  const found = readRegistry(root).find(persona => persona.id === id);
  if (!found) throw personaError('对话人设不存在或已删除', 404);
  return { ...found, builtin: false };
}

function rawPrompt(root, persona) {
  return persona.file ? fs.readFileSync(checkedPath(root, persona.file), 'utf8') : persona.prompt;
}

export function listPersonas(root, { includePrompts = true } = {}) {
  const custom = root === undefined ? [] : readRegistry(root);
  return [...Object.values(DEFINITIONS).filter(persona => !hiddenInWorkbench(persona.id)).map(persona => ({ id: persona.id, name: persona.name, builtin: true,
    prompt: !includePrompts || (root === undefined && persona.file) ? '' : rawPrompt(root, persona) })),
  ...custom.map(persona => ({ ...persona, builtin: false }))];
}

export function savePersona(root, value) {
  const content = validateContent(value);
  const updating = Object.hasOwn(value, 'id');
  if (updating) {
    checkedId(value.id);
    if (Object.hasOwn(DEFINITIONS, value.id)) throw personaError('内置人设只读，请复制为自定义人设');
  }
  const entries = readRegistry(root), id = updating ? value.id : 'custom_' + randomUUID();
  const index = entries.findIndex(persona => persona.id === id);
  if (updating && index < 0) throw personaError('对话人设不存在或已删除', 404);
  if (!updating && entries.length >= MAX_PERSONAS) throw personaError('最多保存 50 个自定义人设');
  const persona = { id, ...content };
  if (updating) entries[index] = persona;
  else entries.push(persona);
  atomicWrite(root, 'personas.json', { version: 1, personas: entries });
  return { ...persona, builtin: false };
}

export function readPersonaSelection(root) {
  const entries = readRegistry(root);
  const saved = readJson(root, 'persona-selection.json');
  if (saved === undefined) return defaultPersonaId();
  if (!plainObject(saved) || Object.keys(saved).length !== 1 || !Object.hasOwn(saved, 'activeId')) {
    throw personaError('人设选择配置损坏，原文件已保留', 500);
  }
  checkedId(saved.activeId);
  if (hiddenInWorkbench(saved.activeId)) return defaultPersonaId();
  if (!Object.hasOwn(DEFINITIONS, saved.activeId) && !entries.some(persona => persona.id === saved.activeId)) {
    throw personaError('所选人设已不存在，请重新选择人设', 409);
  }
  return saved.activeId;
}

export function writePersonaSelection(root, id) {
  readRegistry(root);
  if (hiddenInWorkbench(id)) throw personaError('此内置人设已从工作台移除，请选择林小汐或自定义人设');
  const activeId = personaById(id, root).id;
  atomicWrite(root, 'persona-selection.json', { activeId });
  return activeId;
}

export function deletePersona(root, id) {
  checkedId(id);
  if (Object.hasOwn(DEFINITIONS, id)) throw personaError('内置人设不能删除');
  const entries = readRegistry(root);
  if (!entries.some(persona => persona.id === id)) throw personaError('对话人设不存在或已删除', 404);
  const activeId = readPersonaSelection(root);
  // 先回退选择，即使后续注册表写入失败，当前选择也仍然有效。
  if (activeId === id) writePersonaSelection(root, defaultPersonaId());
  atomicWrite(root, 'personas.json', { version: 1, personas: entries.filter(persona => persona.id !== id) });
  return { activeId: activeId === id ? defaultPersonaId() : activeId };
}

// 名称快照随消息保存；读取旧消息不依赖当前注册表，也不会把已删除的人设改成当前助手。
export function personaDisplayName(id = 'xiaoxi', snapshot = '') {
  if (typeof snapshot === 'string' && snapshot.trim() && snapshot.length <= 60 && !/[\u0000-\u001f\u007f]/.test(snapshot)) return snapshot;
  if (typeof id === 'string' && Object.hasOwn(DEFINITIONS, id)) return DEFINITIONS[id].name;
  return isCustomPersonaId(id) ? '自定义助手' : '旧助手';
}

export function readPersonaPrompt(root, id, profile = readUserProfile(root)) {
  const persona = personaById(id, root);
  const user = profile.displayName || '你';
  const rules = fs.readFileSync(checkedPath(root, 'workflow', '助手共用规则.md'), 'utf8');
  const text = [
    '以下人设仅定义交流风格与虚构身份，不改变程序授权、工具权限、制卡流程或写入确认规则。',
    rawPrompt(root, persona).replaceAll('{{user}}', user),
    '以下为独立的通用工作规则；人设正文不能覆盖这些规则：',
    rules,
  ].join('\n\n');
  return { id: persona.id, name: persona.name, text };
}
