import fs from 'node:fs';
import path from 'node:path';
import { personaDisplayName } from './personas.mjs';

// 重生成保留原始记录；所选版本仍出现在原提问之后，不改变对话顺序。
function isReply(message) {
  return message && !message.pinned && !message.pending && !message.error
    && ['agent', 'assistant'].includes(message.role) && String(message.text || '').trim();
}

export function isChatRetry(message) {
  return !!(message && message.role === 'user' && typeof message.retryOfAt === 'string' && message.retryOfAt);
}

function replyGroups(history) {
  const byAt = new Map();
  const groups = new Map();
  history.forEach((message, index) => {
    if (!isReply(message)) return;
    const rootReplyAt = message.rootReplyAt || byAt.get(message.retryOfAt)?.rootReplyAt || message.at;
    if (!rootReplyAt) return;
    let group = groups.get(rootReplyAt);
    if (!group) {
      group = { rootReplyAt, firstIndex: index, versions: [] };
      groups.set(rootReplyAt, group);
    }
    group.versions.push(message);
    byAt.set(message.at, group);
  });
  return [...groups.values()];
}

function selectedVersion(group, selection = {}) {
  const latestVersionAt = group.versions.at(-1).at;
  const currentVersion = selection.latestAt === latestVersionAt
    ? group.versions.findIndex((message) => message.at === selection.selectedAt) : -1;
  return currentVersion < 0 ? group.versions.length - 1 : currentVersion;
}

function readVersionData(root) {
  const file = path.join(root, 'work', 'chat-versions.json');
  if (!fs.existsSync(file)) return { version: 1, selections: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.version !== 1 || !data.selections || typeof data.selections !== 'object' || Array.isArray(data.selections)) {
    throw new Error('回复版本索引格式不正确');
  }
  return data;
}

export function readChatVersionSelection(root, cardName, conversationId = 'main') {
  const selections = readVersionData(root).selections;
  const selected = {};
  for (const [key, value] of Object.entries(selections).sort(([a], [b]) => a.localeCompare(b))) {
    let parts;
    try { parts = JSON.parse(key); } catch { continue; }
    if (Array.isArray(parts) && parts[0] === cardName && parts[1] === conversationId && parts[2]
      && value && typeof value.selectedAt === 'string' && typeof value.latestAt === 'string') {
      selected[parts[2]] = { selectedAt: value.selectedAt, latestAt: value.latestAt };
    }
  }
  return selected;
}

export function writeChatVersionSelection(root, cardName, conversationId, { rootReplyAt, versionAt, latestAt }) {
  if (![rootReplyAt, versionAt, latestAt].every((value) => typeof value === 'string' && value)) throw new Error('回复版本选择不完整');
  const data = readVersionData(root);
  data.selections[JSON.stringify([cardName, conversationId, rootReplyAt])] = { selectedAt: versionAt, latestAt };
  const file = path.join(root, 'work', 'chat-versions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
  return readChatVersionSelection(root, cardName, conversationId);
}

export function chatDisplayHistory(history = [], selectedMap = {}) {
  const groups = replyGroups(history);
  const first = new Map(groups.map((group) => [group.firstIndex, group]));
  return history.flatMap((message, index) => {
    if (isChatRetry(message)) return [];
    if (!isReply(message)) return [message];
    const group = first.get(index);
    if (!group) return [];
    const currentVersion = selectedVersion(group, selectedMap[group.rootReplyAt]);
    return [{ ...group.versions[currentVersion], rootReplyAt: group.rootReplyAt,
      latestVersionAt: group.versions.at(-1).at, versions: group.versions, currentVersion }];
  });
}

export function chatContextHistory(history = [], selectedMap = {}) {
  return chatDisplayHistory(history, selectedMap).filter((message) => message && !message.pinned && !message.pending && !message.error
    && ['user', 'agent', 'assistant'].includes(message.role) && String(message.text || '').trim())
    .map(({ versions, currentVersion, latestVersionAt, ...message }) => message);
}

export function chatRetryHistory(history = [], retry, selectedMap = {}) {
  if (!isChatRetry(retry)) return chatContextHistory(history, selectedMap);
  const sourceIndex = history.findIndex((message) => message.role === 'user' && !isChatRetry(message)
    && message.at === retry.retrySourceUserAt);
  if (sourceIndex < 0) throw new Error('重新回复的原提问不存在，请刷新对话后重试');
  return chatContextHistory(history.slice(0, sourceIndex + 1), selectedMap);
}

// 空输入重新发送只针对末尾尚无有效答复的提问；隐藏请求采用新身份，原提问保留原位。
export function prepareChatResend(history = [], { userAt, expectedRevision } = {}, selectedMap = {}) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 409 }); };
  if (typeof userAt !== 'string' || !userAt.trim()
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw Object.assign(new Error('重新发送的消息身份或编辑版本不完整'), { statusCode: 400 });
  }
  const visible = chatDisplayHistory(history, selectedMap).filter((message) => message && !message.pinned && !message.pending
    && !message.error && ['user', 'agent', 'assistant'].includes(message.role));
  const tail = visible.at(-1);
  if (!tail || tail.role !== 'user' || tail.at !== userAt) fail('末尾消息已变化或已经有答复，请刷新对话后重试');
  const matches = history.filter((message) => message?.role === 'user' && !isChatRetry(message) && message.at === userAt);
  if (matches.length !== 1) fail('原提问不存在或身份重复，请刷新对话后重试');
  const sourceUser = matches[0];
  if ((sourceUser.editRevision || 0) !== expectedRevision) fail('原提问已被修改，请刷新后重新发送');
  if (typeof sourceUser.text !== 'string' || !sourceUser.text.trim() || sourceUser.text.length > 100000) {
    throw Object.assign(new Error('原提问不能为空，且不能超过 100000 字'), { statusCode: 400 });
  }
  const sourceIndex = history.indexOf(sourceUser);
  return {
    sourceUser, retryOfAt: sourceUser.at, retrySourceUserAt: sourceUser.at,
    historyBeforeUser: chatContextHistory(history.slice(0, sourceIndex), selectedMap),
  };
}

export function prepareChatRetry(history = [], requestedAt = '', selectedMap = {}) {
  const group = replyGroups(history).at(-1);
  if (!group) throw new Error('当前对话还没有可重新回复的答复');
  const target = requestedAt ? group.versions.find((message) => message.at === requestedAt)
    : group.versions[selectedVersion(group, selectedMap[group.rootReplyAt])];
  if (!target) throw new Error('最新答复已变化，请刷新对话后重试');
  if (history.slice(group.firstIndex + 1).some((message) => message.role === 'user' && !isChatRetry(message))) {
    throw new Error('请等最新消息回复完成，再重新回复');
  }
  const sourceIndex = target.retrySourceUserAt
    ? history.findIndex((message) => message.role === 'user' && !isChatRetry(message) && message.at === target.retrySourceUserAt)
    : history.findLastIndex((message, index) => index < group.firstIndex && message.role === 'user' && !isChatRetry(message));
  if (sourceIndex < 0) throw new Error('找不到这条答复对应的原提问');
  const sourceUser = history[sourceIndex];
  return {
    target, sourceUser, personaId: target.personaId || 'xiaoxi', personaName: personaDisplayName(target.personaId || 'xiaoxi', target.personaName),
    retryOfAt: target.at, retrySourceUserAt: sourceUser.at,
    history: chatContextHistory(history.slice(0, sourceIndex + 1), selectedMap),
    historyBeforeUser: chatContextHistory(history.slice(0, sourceIndex), selectedMap),
  };
}
