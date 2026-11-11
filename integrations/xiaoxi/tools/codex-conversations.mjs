import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertWorkspacePath, safeName } from './card.mjs';

const VERSION = 1;
const MAP_LIMIT = 4 * 1024 * 1024;
const USAGE_LIMIT = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COUNTERS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'cacheWriteInputTokens'];
const RECORD_KEYS = ['threadId', 'turnId', 'contextFingerprint', 'historyFingerprint', 'projectPath', 'projectId', 'usageTotal', 'updatedAt'];
const USAGE_KEYS = ['taskId', 'cardName', 'conversationId', 'threadId', 'turnId', 'attempt', 'kind', 'model', 'status', 'baselineKnown', 'updatedAt', ...COUNTERS];

function storeError(message, statusCode = 409) {
  return Object.assign(new Error(message), { code: 'CODEX_CONVERSATION_STORE', statusCode });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function identifier(value, nullable = false) {
  return nullable && value === null || typeof value === 'string' && ID.test(value);
}

function timestamp(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function scope(cardName, conversationId) {
  try { safeName(cardName); }
  catch { throw storeError('Codex 对话的卡片身份不正确', 400); }
  if (cardName.length > 256 || typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(conversationId)) {
    throw storeError('Codex 对话的卡片或对话身份不正确', 400);
  }
  return hash(JSON.stringify([cardName, conversationId]));
}

function checkedPath(root, name) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw storeError('Codex 对话存储需要绝对工作区路径', 400);
  const base = path.resolve(root);
  assertWorkspacePath(path.parse(base).root, base);
  return assertWorkspacePath(base, path.join(base, 'work', name));
}

function readBytes(root, file, limit) {
  assertWorkspacePath(path.parse(path.resolve(root)).root, path.resolve(root));
  assertWorkspacePath(root, file);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > limit) throw storeError('Codex 对话记录不是普通文件或超过读取上限，原文件已保留');
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit) throw storeError('Codex 对话记录超过读取上限，原文件已保留');
  return bytes;
}

function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw storeError('Codex 对话记录不是有效的 UTF-8，原文件已保留'); }
}

function counters(value) {
  if (!object(value) || Object.keys(value).some(key => !COUNTERS.includes(key))) throw storeError('Codex 用量字段不正确', 400);
  const result = {};
  for (const key of COUNTERS) {
    const count = value[key] ?? null;
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw storeError('Codex 用量必须是非负整数或未知值', 400);
    result[key] = count;
  }
  return result;
}

function normalizeRecord(record) {
  if (!object(record) || Object.keys(record).some(key => !RECORD_KEYS.includes(key))
    || !identifier(record.threadId) || !identifier(record.turnId)
    || typeof record.contextFingerprint !== 'string' || !HASH.test(record.contextFingerprint)
    || typeof record.historyFingerprint !== 'string' || !HASH.test(record.historyFingerprint)
    || !identifier(record.projectId, true) || !timestamp(record.updatedAt)
    || typeof record.projectPath !== 'string' || !path.isAbsolute(record.projectPath) || /[\0\r\n]/.test(record.projectPath)) {
    throw storeError('Codex 对话映射字段不正确，原文件已保留', 400);
  }
  const projectPath = path.resolve(record.projectPath);
  assertWorkspacePath(path.parse(projectPath).root, projectPath);
  const result = {
    threadId: record.threadId, turnId: record.turnId,
    contextFingerprint: record.contextFingerprint.toLowerCase(), historyFingerprint: record.historyFingerprint.toLowerCase(),
    projectPath, projectId: record.projectId, updatedAt: record.updatedAt,
  };
  if (Object.hasOwn(record, 'usageTotal')) result.usageTotal = record.usageTotal === null ? null : counters(record.usageTotal);
  return result;
}

function readMap(root, file) {
  const bytes = readBytes(root, file, MAP_LIMIT);
  if (bytes === null) return { data: { version: VERSION, conversations: Object.create(null) }, token: null };
  let data;
  try { data = JSON.parse(decode(bytes)); }
  catch { throw storeError('Codex 对话映射不是有效的 UTF-8 JSON，原文件已保留'); }
  if (!object(data) || Object.keys(data).length !== 2 || data.version !== VERSION || !object(data.conversations)) {
    throw storeError('Codex 对话映射结构不正确，原文件已保留');
  }
  const conversations = Object.create(null);
  for (const [key, entry] of Object.entries(data.conversations)) {
    if (!object(entry) || Object.keys(entry).some(field => !['cardName', 'conversationId', 'record'].includes(field))
      || key !== scope(entry.cardName, entry.conversationId)) throw storeError('Codex 对话映射范围不正确，原文件已保留');
    conversations[key] = { cardName: entry.cardName, conversationId: entry.conversationId, record: normalizeRecord(entry.record) };
  }
  return { data: { version: VERSION, conversations }, token: hash(bytes) };
}

function withLock(root, file, operation) {
  const directory = path.dirname(file);
  assertWorkspacePath(root, directory);
  fs.mkdirSync(directory, { recursive: true });
  assertWorkspacePath(root, directory);
  const lock = assertWorkspacePath(root, file + '.lock');
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw storeError('Codex 对话记录正在保存或上次保存未完整结束，请稍后重试；锁文件已保留');
    throw error;
  }
  let written = false;
  try {
    fs.writeFileSync(fd, owner, 'utf8');
    written = true;
    return operation();
  } finally {
    fs.closeSync(fd);
    // 不删除其他进程后来替换的锁；异常遗留锁也不按时间擅自抢占。
    assertWorkspacePath(root, lock);
    if (written && fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock);
  }
}

function writeMap(root, file, data, previousToken) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAP_LIMIT) throw storeError('Codex 对话映射超过保存上限，原文件已保留');
  const temporary = assertWorkspacePath(root, file + '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    if (readMap(root, file).token !== previousToken) throw storeError('Codex 对话映射已被其他操作修改，本次未覆盖');
    assertWorkspacePath(root, temporary);
    assertWorkspacePath(root, file);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    assertWorkspacePath(root, temporary);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function assertExpected(current, options, createOnly = false) {
  if (!object(options) || Object.keys(options).some(key => key !== 'expected')) throw storeError('Codex 对话保存条件不正确', 400);
  if (!Object.hasOwn(options, 'expected')) {
    if (createOnly && current !== null) throw storeError('Codex 对话已有映射，更新时需要传入读取到的原记录');
    return;
  }
  const expected = options.expected === null ? null : normalizeRecord(options.expected);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw storeError('Codex 当前对话映射已变化，本次未覆盖');
}

export function readCodexConversation(root, cardName, conversationId) {
  const key = scope(cardName, conversationId), file = checkedPath(root, 'codex-conversations.json');
  return readMap(root, file).data.conversations[key]?.record ?? null;
}

// expected 是此前 read 返回的记录；null 表示只允许创建，不允许覆盖后来产生的映射。
export function saveCodexConversation(root, cardName, conversationId, record, options = {}) {
  const key = scope(cardName, conversationId), file = checkedPath(root, 'codex-conversations.json');
  const next = normalizeRecord(record);
  return withLock(root, file, () => {
    const snapshot = readMap(root, file), current = snapshot.data.conversations[key]?.record ?? null;
    assertExpected(current, options, true);
    snapshot.data.conversations[key] = { cardName, conversationId, record: next };
    writeMap(root, file, snapshot.data, snapshot.token);
    return structuredClone(next);
  });
}

export function invalidateCodexConversation(root, cardName, conversationId, expectedThreadId = '', options = {}) {
  const key = scope(cardName, conversationId), file = checkedPath(root, 'codex-conversations.json');
  if (expectedThreadId !== '' && !identifier(expectedThreadId)) throw storeError('Codex 待失效线程身份不正确', 400);
  return withLock(root, file, () => {
    const snapshot = readMap(root, file), current = snapshot.data.conversations[key]?.record ?? null;
    assertExpected(current, options);
    if (!current || expectedThreadId && current.threadId !== expectedThreadId) return false;
    delete snapshot.data.conversations[key];
    writeMap(root, file, snapshot.data, snapshot.token);
    return true;
  });
}

function normalizeUsage(record) {
  if (!object(record) || Object.keys(record).some(key => !USAGE_KEYS.includes(key))
    || !identifier(record.taskId) || !identifier(record.threadId, true) || !identifier(record.turnId, true)
    || !Number.isSafeInteger(record.attempt) || record.attempt < 1
    || !['main', 'summary', 'write'].includes(record.kind) || !['completed', 'failed', 'cancelled'].includes(record.status)
    || record.model !== null && (typeof record.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(record.model))
    || !timestamp(record.updatedAt) || Object.hasOwn(record, 'baselineKnown') && record.baselineKnown !== null && typeof record.baselineKnown !== 'boolean') {
    throw storeError('Codex 用量记录字段不正确', 400);
  }
  scope(record.cardName, record.conversationId);
  return {
    taskId: record.taskId, cardName: record.cardName, conversationId: record.conversationId,
    threadId: record.threadId, turnId: record.turnId, attempt: record.attempt, kind: record.kind,
    model: record.model, status: record.status,
    ...counters(Object.fromEntries(COUNTERS.map(key => [key, record[key] ?? null]))),
    ...(Object.hasOwn(record, 'baselineKnown') ? { baselineKnown: record.baselineKnown } : {}), updatedAt: record.updatedAt,
  };
}

function usageIdentity(record) {
  return JSON.stringify([record.cardName, record.conversationId, record.taskId, record.threadId, record.turnId, record.kind, record.attempt]);
}

// 仅收每次调用的最终归一用量；不把 thread 累计快照相加，也不把未知计数补成零。
export function appendCodexUsage(root, record) {
  const next = normalizeUsage(record), identity = usageIdentity(next), file = checkedPath(root, 'codex-usage.jsonl');
  return withLock(root, file, () => {
    const bytes = readBytes(root, file, USAGE_LIMIT);
    const text = bytes === null ? '' : decode(bytes);
    if (text && !text.endsWith('\n')) throw storeError('Codex 用量记录末尾不完整，原文件已保留');
    let existing = null;
    const identities = new Set();
    for (const line of text.split('\n').slice(0, -1)) {
      let item;
      try { item = normalizeUsage(JSON.parse(line)); }
      catch { throw storeError('Codex 用量记录格式不正确，原文件已保留'); }
      const key = usageIdentity(item);
      if (identities.has(key)) throw storeError('Codex 用量记录存在重复调用，原文件已保留');
      identities.add(key);
      if (key === identity) existing = item;
    }
    if (existing) {
      // 重复送达只允许相同最终结果；记录时间不参与幂等判断。
      if (JSON.stringify({ ...existing, updatedAt: '' }) !== JSON.stringify({ ...next, updatedAt: '' })) {
        throw storeError('本次 Codex 调用已保存另一份用量，未重复累计');
      }
      return false;
    }
    const line = JSON.stringify(next) + '\n';
    if ((bytes?.length || 0) + Buffer.byteLength(line, 'utf8') > USAGE_LIMIT) throw storeError('Codex 用量记录超过保存上限，原文件已保留');
    assertWorkspacePath(root, file);
    const fd = fs.openSync(file, 'a');
    try { fs.writeFileSync(fd, line, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return true;
  });
}
