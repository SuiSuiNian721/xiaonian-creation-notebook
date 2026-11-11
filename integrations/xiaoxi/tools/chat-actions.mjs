import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applyChatEdits, getChatContextRevision, prepareChatContextAdvance } from './chat-edits.mjs';
import { chatDisplayHistory, isChatRetry } from './chat-retries.mjs';

const ROLES = new Set(['user', 'agent', 'assistant']);

function actionError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentityPart(value) {
  return typeof value === 'string' && !!value.trim();
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validTime(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validKey(key, task = false) {
  let parts;
  try { parts = JSON.parse(key); } catch { return false; }
  return Array.isArray(parts) && parts.length === 4 && parts.every(isIdentityPart)
    && ROLES.has(parts[2]) && (!task || parts[2] === 'user') && JSON.stringify(parts) === key;
}

function messageKey(message) {
  return JSON.stringify([String(message.cardName || '1'), String(message.conversationId || 'main'), message.role, message.at]);
}

function belongsTo(message, cardName, conversationId) {
  return isObject(message) && String(message.cardName || '1') === cardName && String(message.conversationId || 'main') === conversationId;
}

function validateData(data) {
  const legacy = data?.version === 1;
  if (!hasExactKeys(data, legacy ? ['version', 'deleted', 'closedTasks'] : ['version', 'deleted', 'closedTasks', 'deletions'])
    || (!legacy && data.version !== 2) || !isObject(data.deleted) || !isObject(data.closedTasks)
    || (!legacy && !isObject(data.deletions))) throw actionError('聊天操作索引格式不正确', 500);
  for (const [key, value] of Object.entries(data.deleted)) {
    if (!validKey(key) || !hasExactKeys(value, legacy ? ['deletedAt'] : ['deletedAt', 'operationId']) || !validTime(value.deletedAt)
      || (!legacy && !validOperationId(value.operationId))) {
      throw actionError('聊天删除记录格式不正确', 500);
    }
  }
  for (const [key, value] of Object.entries(data.closedTasks)) {
    if (!validKey(key, true) || !hasExactKeys(value, ['closedAt']) || !validTime(value.closedAt)) {
      throw actionError('聊天任务关闭记录格式不正确', 500);
    }
  }
  if (!legacy) {
    for (const [id, operation] of Object.entries(data.deletions)) {
      if (!validOperationId(id) || !hasExactKeys(operation, ['cardName', 'conversationId', 'deletedAt', 'mode', 'anchorKey', 'keys', 'messageCount', 'restoredAt'])
        || ![operation.cardName, operation.conversationId].every(isIdentityPart) || !validTime(operation.deletedAt)
        || !['single', 'from', 'legacy'].includes(operation.mode) || !Array.isArray(operation.keys) || !operation.keys.length
        || operation.keys.some((key) => !validKey(key) || JSON.parse(key)[0] !== operation.cardName || JSON.parse(key)[1] !== operation.conversationId)
        || new Set(operation.keys).size !== operation.keys.length || !operation.keys.includes(operation.anchorKey)
        || !Number.isSafeInteger(operation.messageCount) || operation.messageCount < 1 || operation.messageCount > operation.keys.length
        || (operation.restoredAt !== null && !validTime(operation.restoredAt))) throw actionError('聊天删除操作格式不正确', 500);
      if (!operation.restoredAt && operation.keys.some((key) => !Object.hasOwn(data.deleted, key) || data.deleted[key].operationId !== id)) {
        throw actionError('聊天删除操作与消息索引不一致', 500);
      }
    }
    for (const [key, entry] of Object.entries(data.deleted)) {
      const operation = Object.hasOwn(data.deletions, entry.operationId) ? data.deletions[entry.operationId] : null;
      if (!operation || operation.restoredAt || operation.deletedAt !== entry.deletedAt || !operation.keys.includes(key)) {
        throw actionError('聊天删除消息缺少对应操作', 500);
      }
    }
  }
  return data;
}

function validOperationId(value) {
  return typeof value === 'string' && /^(?:delete|legacy)-[A-Za-z0-9_-]{1,80}$/.test(value);
}

// 旧索引没有操作编号，只能按同一对话中的删除时间归组。迁移仅发生在内存，提交仍由服务层事务负责。
function upgradeActionData(data, rawHistory = []) {
  if (data.version === 2) return data;
  const upgraded = { version: 2, deleted: {}, closedTasks: data.closedTasks, deletions: {} };
  for (const [key, entry] of Object.entries(data.deleted)) {
    const [cardName, conversationId] = JSON.parse(key);
    const id = 'legacy-' + createHash('sha256').update(JSON.stringify([cardName, conversationId, entry.deletedAt])).digest('hex').slice(0, 32);
    if (!Object.hasOwn(upgraded.deletions, id)) {
      upgraded.deletions[id] = { cardName, conversationId, deletedAt: entry.deletedAt, mode: 'legacy', anchorKey: key, keys: [], messageCount: 1, restoredAt: null };
    }
    upgraded.deletions[id].keys.push(key);
    upgraded.deleted[key] = { deletedAt: entry.deletedAt, operationId: id };
  }
  for (const operation of Object.values(upgraded.deletions)) {
    const keys = new Set(operation.keys);
    const visible = chatDisplayHistory(rawHistory.filter((message) => keys.has(messageKey(message)))).filter(actionable);
    operation.messageCount = Math.min(operation.keys.length, Math.max(1, visible.length));
    if (visible.length) operation.anchorKey = messageKey(visible[0]);
  }
  return upgraded;
}

function scopedIdentities(rawHistory, cardName, conversationId) {
  if (!Array.isArray(rawHistory) || rawHistory.some((message) => !isObject(message))
    || ![cardName, conversationId].every(isIdentityPart)) throw actionError('聊天操作请求或历史格式不正确');
  const scoped = rawHistory.filter((message) => belongsTo(message, cardName, conversationId));
  const byIdentity = new Map();
  for (const message of scoped) {
    const identity = messageKey(message);
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity).push(message);
  }
  return { scoped, byIdentity };
}

function closeTasks(data, byIdentity, tasks, cardName, conversationId, now) {
  if (!Array.isArray(tasks)) throw actionError('待关闭任务格式无效');
  let count = 0;
  for (const task of tasks) {
    if (!belongsTo(task, cardName, conversationId) || task.role !== 'user'
      || !isIdentityPart(task.at) || task.historyOnly || task.pinned || task.pending) throw actionError('待关闭任务归属或类型无效');
    const identity = messageKey(task);
    const matches = byIdentity.get(identity) || [];
    if (matches.length !== 1 || matches[0].historyOnly || matches[0].pinned || matches[0].pending) {
      throw actionError('待关闭任务不存在或身份无效，请刷新对话后重试', 409);
    }
    if (!Object.hasOwn(data.closedTasks, identity)) { data.closedTasks[identity] = { closedAt: now }; count++; }
  }
  return count;
}

// 核对整个路径链，避免经符号链接或 Windows junction 操作其他目录。
export function chatActionsFile(root) {
  if (!isIdentityPart(root)) throw actionError('聊天操作工作区路径无效');
  const absolute = path.resolve(root);
  const target = path.join(absolute, 'work', 'chat-actions.json');
  const relative = path.relative(absolute, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw actionError('聊天操作路径超出工作区');
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
    if (stat.isSymbolicLink()) throw actionError('聊天操作路径不允许符号链接或 junction');
    if (index < parts.length - 1 && !stat.isDirectory()) throw actionError('聊天操作路径包含非目录项目');
    if (index === parts.length - 1 && !stat.isFile()) throw actionError('聊天操作索引必须是普通文件');
  }
  return target;
}

export function readChatActionData(root) {
  const file = chatActionsFile(root);
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, deleted: {}, closedTasks: {} };
    throw error;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw actionError('聊天操作索引不是有效 UTF-8 文本', 500); }
  let data;
  try { data = JSON.parse(text); }
  catch { throw actionError('聊天操作索引不是有效 JSON', 500); }
  return validateData(data);
}

export function applyChatDeletions(root, history) {
  if (!Array.isArray(history)) throw actionError('聊天历史格式不正确');
  const data = readChatActionData(root);
  const restoredKeys = new Set(data.version === 2
    ? Object.values(data.deletions).filter((operation) => operation.restoredAt).flatMap((operation) => operation.keys) : []);
  return history.filter((message) => !isObject(message) || !Object.hasOwn(data.deleted, messageKey(message)))
    .map((message) => isObject(message) && restoredKeys.has(messageKey(message)) && message.draftReady
      ? { ...message, draftReady: false } : message);
}

export function isChatTaskClosed(root, message) {
  if (!isObject(message)) return false;
  return Object.hasOwn(readChatActionData(root).closedTasks, messageKey(message));
}

function prepareScope(root, rawHistory, selection, request, branching = false) {
  if (!Array.isArray(rawHistory) || rawHistory.some((message) => !isObject(message))
    || !isObject(selection) || !isObject(request)) throw actionError('聊天操作请求或历史格式不正确');
  const { cardName, conversationId, messageAt, role, expectedRevision, contextRevision } = request;
  if (![cardName, conversationId, messageAt, role].every(isIdentityPart) || !ROLES.has(role)) {
    throw actionError('聊天操作消息身份不完整或角色无效');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !Number.isSafeInteger(contextRevision) || contextRevision < 0) throw actionError('聊天操作版本无效');
  const scoped = rawHistory.filter((message) => belongsTo(message, cardName, conversationId));
  const byIdentity = new Map();
  for (const message of scoped) {
    const key = messageKey(message);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(message);
  }
  const identity = JSON.stringify([cardName, conversationId, role, messageAt]);
  const matches = byIdentity.get(identity) || [];
  if (matches.length !== 1) throw actionError('消息不存在或身份重复，请刷新对话后重试', 409);
  const rawTarget = matches[0];
  if (rawTarget.pinned || rawTarget.pending || isChatRetry(rawTarget)) throw actionError('系统说明、处理中记录或隐藏重试不能直接操作');
  if (branching && rawTarget.error) throw actionError('错误正文不能作为分支起点');
  const data = readChatActionData(root);
  const effective = applyChatEdits(root, scoped).filter((message) => !Object.hasOwn(data.deleted, messageKey(message)));
  const display = chatDisplayHistory(effective, selection);
  const targetIndex = display.findIndex((message) => messageKey(message) === identity);
  if (targetIndex < 0) throw actionError('这条消息不是当前显示的版本，请刷新对话后重试', 409);
  const target = display[targetIndex];
  if (branching && (typeof target.text !== 'string' || !target.text.trim())) throw actionError('空正文不能作为分支起点');
  if ((target.editRevision || 0) !== expectedRevision) throw actionError('消息正文已变化，请刷新对话后重试', 409);
  if (getChatContextRevision(root, cardName, conversationId) !== contextRevision) {
    throw actionError('对话上下文已变化，请刷新对话后重试', 409);
  }
  return { scoped, byIdentity, data, display, targetIndex };
}

function actionable(message) {
  return isObject(message) && ROLES.has(message.role) && isIdentityPart(message.at) && !message.pinned && !message.pending && !isChatRetry(message);
}

// 只准备事务数据；原始 JSONL、上下文索引及授权由服务层统一提交。
export function prepareChatDeletion(root, rawHistory, selection, request) {
  if (!isObject(request) || !['single', 'from'].includes(request.mode)
    || (request.closePending !== undefined && !Array.isArray(request.closePending))) throw actionError('删除范围或待回复任务格式无效');
  const { scoped, byIdentity, data: originalData, display, targetIndex } = prepareScope(root, rawHistory, selection, request);
  const data = upgradeActionData(originalData, rawHistory);
  const targets = request.mode === 'from' ? display.slice(targetIndex) : [display[targetIndex]];
  const members = new Map();
  for (const target of targets) {
    if (!actionable(target)) continue;
    for (const message of target.versions || [target]) members.set(messageKey(message), message);
  }
  const replyTimes = new Set([...members.values()].filter((message) => message.role !== 'user').map((message) => message.at));
  const userTimes = new Set([...members.values()].filter((message) => message.role === 'user').map((message) => message.at));
  for (const message of scoped) {
    if ((isChatRetry(message) && (replyTimes.has(message.retryOfAt) || userTimes.has(message.retrySourceUserAt)))
      || (message.error && ['agent', 'assistant'].includes(message.role) && replyTimes.has(message.retryOfAt))) {
      members.set(messageKey(message), message);
    }
  }
  let deletedCount = 0;
  const now = new Date().toISOString();
  const operationId = 'delete-' + randomUUID();
  const keys = [];
  for (const identity of members.keys()) {
    if ((byIdentity.get(identity) || []).length !== 1) {
      throw actionError('待删除消息身份重复，请刷新对话后重试', 409);
    }
    if (!Object.hasOwn(data.deleted, identity)) {
      data.deleted[identity] = { deletedAt: now, operationId }; keys.push(identity); deletedCount++;
    }
  }
  const messageCount = targets.filter(actionable).length;
  if (keys.length) {
    data.deletions[operationId] = { cardName: request.cardName, conversationId: request.conversationId, deletedAt: now,
      mode: request.mode, anchorKey: messageKey(display[targetIndex]), keys, messageCount, restoredAt: null };
  }
  const closedPendingCount = closeTasks(data, byIdentity, request.closePending || [], request.cardName, request.conversationId, now);
  const context = prepareChatContextAdvance(root, request.cardName, request.conversationId);
  return { changed: deletedCount > 0 || closedPendingCount > 0, data, contextData: context.data, revision: context.revision,
    deletedCount, messageCount, closedPendingCount, operationId: keys.length ? operationId : null };
}

export function listChatDeletions(root, rawHistory, { cardName, conversationId }) {
  scopedIdentities(rawHistory, cardName, conversationId);
  const data = upgradeActionData(readChatActionData(root), rawHistory);
  const effective = applyChatEdits(root, rawHistory);
  const messages = new Map(effective.map((message) => [messageKey(message), message]));
  return Object.entries(data.deletions).filter(([, operation]) => !operation.restoredAt
    && operation.cardName === cardName && operation.conversationId === conversationId)
    .sort(([, a], [, b]) => b.deletedAt.localeCompare(a.deletedAt))
    .map(([id, operation]) => {
      const anchor = messages.get(operation.anchorKey);
      return { id, deletedAt: operation.deletedAt, count: operation.messageCount,
        preview: typeof anchor?.text === 'string' ? anchor.text.slice(0, 180) : '原消息暂不可用',
        role: anchor?.role || JSON.parse(operation.anchorKey)[2], mode: operation.mode };
    });
}

// 恢复只撤销本次删除的遮罩。原正文、编辑覆盖及任务关闭记录始终保留。
export function prepareChatRestoration(root, rawHistory, request) {
  if (!isObject(request) || !validOperationId(request.operationId)
    || (request.closePending !== undefined && !Array.isArray(request.closePending))) throw actionError('恢复操作或待回复任务格式无效');
  const { byIdentity } = scopedIdentities(rawHistory, request.cardName, request.conversationId);
  const data = upgradeActionData(readChatActionData(root), rawHistory);
  const operation = Object.hasOwn(data.deletions, request.operationId) ? data.deletions[request.operationId] : null;
  if (!operation || operation.cardName !== request.cardName || operation.conversationId !== request.conversationId) {
    throw actionError('这条删除记录不存在或不属于当前对话，请刷新后重试', 409);
  }
  if (operation.restoredAt) return { changed: false, data, contextData: null,
    revision: getChatContextRevision(root, request.cardName, request.conversationId), restoredCount: 0, restoredRecordCount: 0,
    closedPendingCount: 0, alreadyRestored: true };
  const restored = [];
  for (const identity of operation.keys) {
    const matches = byIdentity.get(identity) || [];
    if (matches.length !== 1) throw actionError('待恢复的原消息不存在或身份重复，原记录已保留', 409);
    if (!Object.hasOwn(data.deleted, identity) || data.deleted[identity].operationId !== request.operationId) {
      throw actionError('这条删除记录已变化，请刷新后重试', 409);
    }
    restored.push(matches[0]);
  }
  const now = new Date().toISOString();
  // 旧版删除可能没有关闭标记；恢复的历史绝不能自动变成新的生成任务。
  const restoredTasks = restored.filter((message) => message.role === 'user' && !message.historyOnly && !message.pinned && !message.pending);
  const closedPendingCount = closeTasks(data, byIdentity, [...restoredTasks, ...(request.closePending || [])], request.cardName, request.conversationId, now);
  for (const identity of operation.keys) delete data.deleted[identity];
  operation.restoredAt = now;
  const context = prepareChatContextAdvance(root, request.cardName, request.conversationId);
  return { changed: true, data, contextData: context.data, revision: context.revision,
    restoredCount: operation.messageCount, restoredRecordCount: operation.keys.length, closedPendingCount, alreadyRestored: false };
}

// 停止回复只关闭明确领取的用户请求；调用方可选择不改变消息上下文版本。
export function prepareChatTaskClose(root, rawHistory, request) {
  if (!isObject(request) || (request.advanceContext !== undefined && typeof request.advanceContext !== 'boolean')
    || (request.tasks !== undefined && !Array.isArray(request.tasks))) throw actionError('关闭回复请求格式无效');
  const { byIdentity } = scopedIdentities(rawHistory, request.cardName, request.conversationId);
  let tasks = request.tasks;
  if (!tasks) {
    if (!isIdentityPart(request.replyToAt)) throw actionError('请指定需要停止的回复请求');
    const matches = byIdentity.get(JSON.stringify([request.cardName, request.conversationId, 'user', request.replyToAt])) || [];
    if (matches.length !== 1) throw actionError('需要停止的请求不存在或身份重复，请刷新后重试', 409);
    tasks = matches;
  }
  const data = upgradeActionData(readChatActionData(root), rawHistory);
  const closedPendingCount = closeTasks(data, byIdentity, tasks, request.cardName, request.conversationId, new Date().toISOString());
  const context = closedPendingCount > 0 && request.advanceContext !== false
    ? prepareChatContextAdvance(root, request.cardName, request.conversationId) : null;
  return { changed: closedPendingCount > 0, data, contextData: context?.data || null,
    revision: context?.revision ?? getChatContextRevision(root, request.cardName, request.conversationId), closedPendingCount };
}

export function prepareChatBranch(root, rawHistory, selection, request) {
  const { display, targetIndex } = prepareScope(root, rawHistory, selection, request, true);
  const id = request.newConversationId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || id === 'main' || id === request.conversationId) {
    throw actionError('新分支对话身份无效');
  }
  if (rawHistory.some((message) => belongsTo(message, request.cardName, id))) throw actionError('新分支对话身份已存在', 409);
  const copied = display.slice(0, targetIndex + 1).filter((message) => actionable(message) && !message.error && typeof message.text === 'string' && !!message.text.trim());
  const identities = new Set();
  const messages = copied.map((message) => {
    const identity = messageKey(message);
    if (identities.has(identity)) throw actionError('分支历史消息身份重复，请刷新对话后重试', 409);
    identities.add(identity);
    const item = { role: message.role, at: message.at, text: message.text };
    if (typeof message.personaId === 'string') item.personaId = message.personaId;
    if (typeof message.personaName === 'string') item.personaName = message.personaName;
    if (typeof message.module === 'string') item.module = message.module;
    item.cardName = request.cardName;
    item.conversationId = id;
    item.historyOnly = true;
    return item;
  });
  return { messages };
}
