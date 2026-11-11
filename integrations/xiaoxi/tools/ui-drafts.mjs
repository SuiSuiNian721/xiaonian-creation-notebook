import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_TEXT = 1000000;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length <= MAX_TEXT;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function draftKey(key) {
  let parts;
  try { parts = JSON.parse(key); } catch { throw fail('草稿标识格式不正确'); }
  if (!Array.isArray(parts) || JSON.stringify(parts) !== key || key.length > 4000) throw fail('草稿标识格式不正确');
  const [kind, ...scope] = parts;
  const identity = (part) => typeof part === 'string' && !!part.trim() && part.length <= 1000;
  if (kind === 'editor') {
    if (scope.length !== 3 || !['card', 'preset', 'book'].includes(scope[0]) || !identity(scope[1])
      || !object(scope[2]) || !identity(scope[2].kind) || !Object.values(scope[2]).every(identity)) throw fail('编辑器草稿归属无效');
  } else if (kind === 'chat' || kind === 'send') {
    if (scope.length !== 3 || !['card', 'preset', 'book'].includes(scope[0]) || !scope.every(identity)) throw fail('对话草稿归属无效');
  } else if (kind === 'message') {
    if (scope.length !== 4 || !scope.every(identity) || !['user', 'agent', 'assistant'].includes(scope[2])) throw fail('消息草稿归属无效');
  } else throw fail('不支持的草稿类型');
  return kind;
}

function validateValue(kind, value) {
  if (kind === 'chat') {
    if (!exact(value, ['text']) || !text(value.text)) throw fail('输入草稿格式不正确');
  } else if (kind === 'editor') {
    if (!exact(value, ['values', 'baseValues']) || ![value.values, value.baseValues].every((items) => Array.isArray(items) && items.length > 0 && items.length <= 8 && items.every(text))
      || value.values.length !== value.baseValues.length) throw fail('编辑器草稿格式不正确');
  } else if (kind === 'message') {
    if (!exact(value, ['text', 'revision', 'start', 'end']) || !text(value.text) || !Number.isSafeInteger(value.revision) || value.revision < 0
      || ![value.start, value.end].every((position) => position === null || (Number.isSafeInteger(position) && position >= 0 && position <= value.text.length))) throw fail('消息编辑草稿格式不正确');
  } else if (!Array.isArray(value) || value.length > 100 || !value.every((entry) => exact(entry, ['text', 'reason', 'status'])
    && text(entry.text) && text(entry.reason) && ['submitting', 'failed'].includes(entry.status))) throw fail('未发送记录格式不正确');
}

export function uiDraftsFile(root) {
  const file = path.resolve(root, 'work', 'ui-drafts.json');
  const base = path.parse(file).root;
  let current = base;
  const parts = file.slice(base.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw fail('草稿路径不允许符号链接或 junction');
    if (index < parts.length - 1 && !stat.isDirectory()) throw fail('草稿路径包含非目录项目');
    if (index === parts.length - 1 && !stat.isFile()) throw fail('草稿存储必须是普通文件');
  }
  return file;
}

export function readUiDrafts(root) {
  const file = uiDraftsFile(root);
  let bytes;
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw fail('草稿文件过大，原文件已保留', 500);
    bytes = fs.readFileSync(file);
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, revision: 0, entries: {} }; throw error; }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fail('草稿文件无法读取，原文件已保留，请勿关闭仍有草稿的窗口', 500); }
  try {
    if (!exact(data, ['version', 'revision', 'entries']) || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0
      || !object(data.entries) || Object.keys(data.entries).length > MAX_ENTRIES) throw fail('草稿索引格式不正确');
    for (const [key, entry] of Object.entries(data.entries)) {
      if (!exact(entry, ['updatedAt', 'value']) || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw fail('草稿记录格式不正确');
      validateValue(draftKey(key), entry.value);
    }
  } catch (error) { throw fail(error.message + '，原文件已保留', 500); }
  return data;
}

export function updateUiDrafts(root, request) {
  if (!exact(request, ['expectedRevision', 'changes']) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || !Array.isArray(request.changes) || !request.changes.length || request.changes.length > MAX_ENTRIES) throw fail('草稿保存请求格式不正确');
  const data = readUiDrafts(root);
  if (data.revision !== request.expectedRevision) throw fail('另一窗口已经更新草稿。当前输入仍保留，请先保留当前内容再重新载入窗口', 409);
  if (data.revision === Number.MAX_SAFE_INTEGER) throw fail('草稿版本已达到上限', 409);
  const keys = new Set();
  for (const change of request.changes) {
    if (!exact(change, ['key', 'value']) || typeof change.key !== 'string' || keys.has(change.key)) throw fail('草稿变更格式不正确');
    keys.add(change.key);
    const kind = draftKey(change.key);
    if (change.value === null) delete data.entries[change.key];
    else {
      validateValue(kind, change.value);
      data.entries[change.key] = { updatedAt: new Date().toISOString(), value: change.value };
    }
  }
  if (Object.keys(data.entries).length > MAX_ENTRIES) throw fail('草稿数量已达到上限，请先保存或取消不需要的草稿', 413);
  data.revision++;
  const content = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw fail('草稿空间已满，请先保存或取消不需要的草稿', 413);
  const file = uiDraftsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    uiDraftsFile(root);
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { ok: true, revision: data.revision };
}
