import fs from 'node:fs';
import path from 'node:path';

const ROLES = new Set(['user', 'agent', 'assistant']);
const MAX_TEXT_LENGTH = 100000;

function editError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH && !!value.trim();
}

function isIdentityPart(value) {
  return typeof value === 'string' && !!value.trim();
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validStoredKey(key, length) {
  let parts;
  try { parts = JSON.parse(key); } catch { return false; }
  return Array.isArray(parts) && parts.length === length && parts.every(isIdentityPart)
    && (length !== 4 || ROLES.has(parts[2])) && JSON.stringify(parts) === key;
}

function validEditedAt(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateData(data) {
  if (!hasExactKeys(data, ['version', 'edits', 'contexts']) || data.version !== 1
    || !isObject(data.edits) || !isObject(data.contexts)) throw editError('聊天编辑索引格式不正确', 500);
  for (const [key, entry] of Object.entries(data.edits)) {
    if (!validStoredKey(key, 4) || !hasExactKeys(entry, ['text', 'revision', 'editedAt']) || !isText(entry.text)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || !validEditedAt(entry.editedAt)) {
      throw editError('聊天编辑记录格式不正确', 500);
    }
  }
  for (const [key, revision] of Object.entries(data.contexts)) {
    if (!validStoredKey(key, 2) || !Number.isSafeInteger(revision) || revision < 0) {
      throw editError('聊天上下文版本格式不正确', 500);
    }
  }
  return data;
}

// 检查从磁盘根到目标的完整路径链，拒绝符号链接和 Windows junction。
export function chatEditsFile(root) {
  if (typeof root !== 'string' || !root.trim()) throw editError('聊天编辑工作区路径无效');
  const absolute = path.resolve(root);
  const target = path.join(absolute, 'work', 'chat-edits.json');
  const relative = path.relative(absolute, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw editError('聊天编辑路径超出工作区');
  }
  const base = path.parse(target).root;
  let current = base;
  const parts = target.slice(base.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw editError('聊天编辑路径不允许符号链接或 junction');
    if (index < parts.length - 1 && !stat.isDirectory()) throw editError('聊天编辑路径包含非目录项目');
    if (index === parts.length - 1 && !stat.isFile()) throw editError('聊天编辑索引必须是普通文件');
  }
  return target;
}

export function readChatEditData(root) {
  const file = chatEditsFile(root);
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, edits: {}, contexts: {} };
    throw error;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw editError('聊天编辑索引不是有效 UTF-8 文本', 500); }
  let data;
  try { data = JSON.parse(text); }
  catch { throw editError('聊天编辑索引不是有效 JSON', 500); }
  return validateData(data);
}

function messageKey(message) {
  return JSON.stringify([String(message.cardName || '1'), String(message.conversationId || 'main'), message.role, message.at]);
}

function effectiveMessage(message, data) {
  if (!isObject(message)) return message;
  const edit = data.edits[messageKey(message)];
  return { ...message, ...(edit ? { text: edit.text } : {}), editRevision: edit?.revision || 0, editedAt: edit?.editedAt || '' };
}

export function applyChatEdits(root, history) {
  if (!Array.isArray(history)) throw editError('聊天历史格式不正确');
  const data = readChatEditData(root);
  return history.map((message) => effectiveMessage(message, data));
}

export function getChatContextRevision(root, cardName, conversationId = 'main') {
  if (![cardName, conversationId].every(isIdentityPart)) throw editError('聊天上下文归属不完整');
  return readChatEditData(root).contexts[JSON.stringify([cardName, conversationId])] || 0;
}

// 其他历史操作也使用相同版本，旧会话会在下一轮重新读取有效上下文。
export function prepareChatContextAdvance(root, cardName, conversationId) {
  if (![cardName, conversationId].every(isIdentityPart)) throw editError('聊天上下文归属不完整');
  const data = readChatEditData(root);
  const key = JSON.stringify([cardName, conversationId]);
  const current = data.contexts[key] || 0;
  if (current === Number.MAX_SAFE_INTEGER) throw editError('聊天上下文版本已达到上限，无法继续保存', 409);
  const revision = current + 1;
  data.contexts[key] = revision;
  return { data, revision };
}

// 只生成事务所需的数据；服务层将编辑记录与待确认稿失效一同保存。
export function prepareChatEdit(root, history, request) {
  if (!Array.isArray(history) || !isObject(request)) throw editError('聊天编辑请求格式不正确');
  const { cardName, conversationId, messageAt, role, text, expectedRevision } = request;
  if (![cardName, conversationId, messageAt, role].every(isIdentityPart) || !ROLES.has(role)) {
    throw editError('聊天编辑消息身份不完整或角色不可编辑');
  }
  if (!isText(text)) throw editError('消息正文不能为空，且不能超过 100000 字');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw editError('消息编辑版本无效');
  const key = JSON.stringify([cardName, conversationId, role, messageAt]);
  const matches = history.filter((message) => isObject(message) && messageKey(message) === key);
  if (matches.length !== 1) throw editError('消息不存在或身份重复，请刷新对话后重试', 409);
  const target = matches[0];
  if (target.pinned || target.pending || target.error || (role === 'user' && target.retryOfAt)) {
    throw editError('这条系统说明、错误或处理中记录不能编辑');
  }
  const data = readChatEditData(root);
  const effective = effectiveMessage(target, data);
  if (expectedRevision !== effective.editRevision) throw editError('消息已被修改，请刷新后重新编辑', 409);
  if (text === effective.text) {
    return { changed: false, data, message: effective, revision: effective.editRevision, editedAt: effective.editedAt };
  }
  const contextKey = JSON.stringify([cardName, conversationId]);
  const contextRevision = data.contexts[contextKey] || 0;
  if (effective.editRevision === Number.MAX_SAFE_INTEGER || contextRevision === Number.MAX_SAFE_INTEGER) {
    throw editError('聊天编辑版本已达到上限，无法继续保存', 409);
  }
  const revision = effective.editRevision + 1;
  const editedAt = new Date().toISOString();
  data.edits[key] = { text, revision, editedAt };
  data.contexts[contextKey] = contextRevision + 1;
  return { changed: true, data, message: { ...target, text, editRevision: revision, editedAt }, revision, editedAt };
}
