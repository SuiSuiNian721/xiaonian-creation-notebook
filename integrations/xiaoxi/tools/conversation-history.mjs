import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, assertWorkspacePath, safeName } from './card.mjs';
import { applyChatEdits } from './chat-edits.mjs';
import { applyChatDeletions } from './chat-actions.mjs';
import { chatContextHistory, isChatRetry, readChatVersionSelection } from './chat-retries.mjs';
import { personaDisplayName } from './personas.mjs';

// 旧记录与分支可能没有 replyToAt；先在未删减的原始顺序上确定归属，再应用删除。
export function withReplyOwners(raw) {
  const latestUsers = new Map(), replyOwners = new Map(), requests = new Map();
  const scope = item => JSON.stringify([String(item.cardName || '1'), String(item.conversationId || 'main')]);
  for (const item of raw) if (isChatRetry(item)) requests.set(scope(item) + '::' + item.at, item.retrySourceUserAt);
  return raw.map(item => {
    if (!item || typeof item !== 'object') return item;
    const key = scope(item);
    if (item.role === 'user' && !isChatRetry(item) && !item.pending && !item.pinned) {
      latestUsers.set(key, item.at); return item;
    }
    if (!['agent', 'assistant'].includes(item.role) || item.pinned || item.pending) return item;
    const explicit = item.retrySourceUserAt || item.replyToAt || (Array.isArray(item.replyToAts) ? item.replyToAts.at(-1) : '');
    const owner = (explicit ? requests.get(key + '::' + explicit) || explicit : '')
      || replyOwners.get(key + '::' + (item.rootReplyAt || item.retryOfAt)) || latestUsers.get(key) || '';
    replyOwners.set(key + '::' + item.at, owner);
    return { ...item, replyToAt: owner, historyOwnerKnown: true };
  });
}

// 输入已经应用编辑与删除；迟到的答复按原提问归位，当前提问及未来消息不进入历史。
export function buildTurnHistory(raw, { cardName, conversationId = 'main', userAt, selectedMap = {} }) {
  if (!Array.isArray(raw) || typeof userAt !== 'string' || !userAt) throw new Error('当前提问身份不完整');
  const scoped = raw.filter(item => item && (!item.cardName || item.cardName === cardName)
    && (!item.conversationId || item.conversationId === conversationId));
  const sourceUsers = scoped.filter(item => item.role === 'user' && !isChatRetry(item) && !item.pending && !item.error && !item.pinned);
  const matches = sourceUsers.filter(item => item.at === userAt);
  if (matches.length !== 1 || typeof matches[0].text !== 'string' || !matches[0].text.trim()) {
    throw new Error('当前原提问已删除或身份不唯一，请刷新后重新发送');
  }
  const visible = chatContextHistory(scoped, selectedMap);
  const users = visible.filter(item => item.role === 'user');
  const boundary = users.findIndex(item => item.at === userAt);
  if (boundary < 0) throw new Error('找不到当前原提问，请刷新后重新发送');
  const usersByAt = new Map(users.map(item => [item.at, item]));
  const hiddenRequests = new Map(scoped.filter(isChatRetry).map(item => [item.at, item.retrySourceUserAt]));
  const replies = new Map();
  let previousUserAt = '';
  for (const message of visible) {
    if (message.role === 'user') { previousUserAt = message.at; continue; }
    const explicitOwner = message.retrySourceUserAt || message.replyToAt || (Array.isArray(message.replyToAts) ? message.replyToAts.at(-1) : '');
    const owner = explicitOwner ? (hiddenRequests.get(explicitOwner) || explicitOwner) : message.historyOwnerKnown ? '' : previousUserAt;
    // 有明确归属但原提问已删除的答复不能附着到前一条问题。
    if (!owner || !usersByAt.has(owner)) continue;
    if (!replies.has(owner)) replies.set(owner, []);
    replies.get(owner).push(message);
  }
  return { currentUser: matches[0], history: users.slice(0, boundary).flatMap(user => [user, ...(replies.get(user.at) || [])]) };
}

export function readConversationHistory(root, { cardName, conversationId = 'main', userAt }) {
  safeName(cardName);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(conversationId)) throw new Error('非法对话 ID');
  const file = assertWorkspacePath(root, path.join(root, 'work', 'agent-chat.jsonl'));
  let rows;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch { throw new Error('聊天原文不是有效的 UTF-8 JSONL，未修改原文件'); }
  const effective = applyChatDeletions(root, applyChatEdits(root, withReplyOwners(rows)))
    .filter(item => String(item?.cardName || '1') === cardName && String(item?.conversationId || 'main') === conversationId);
  return buildTurnHistory(effective, { cardName, conversationId, userAt, selectedMap: readChatVersionSelection(root, cardName, conversationId) }).history;
}

// 只读查询的分页是显式的：给出原文长度与下一段偏移，避免把摘录冒充全文。
export function queryConversationHistory(history, { query = '', messageAt = '', offset = 0, skip = 0, limit = 5 } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(skip) || skip < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('原文查询分页参数不合法');
  if (!query.trim() && !messageAt) throw new Error('请提供查询关键词或消息时间');
  const selected = history.filter(item => (!messageAt || item.at === messageAt) && (!query || item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const page = selected.slice(skip, skip + limit);
  return { matches: selected.length, returned: page.length, nextSkip: skip + page.length < selected.length ? skip + page.length : null, messages: page.map(item => {
    const start = offset || (query && !messageAt ? Math.max(0, item.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 400) : 0);
    const end = Math.min(item.text.length, start + 5000);
    return { role: item.role, personaId: item.personaId || 'xiaoxi', personaName: personaDisplayName(item.personaId || 'xiaoxi', item.personaName), at: item.at, totalChars: item.text.length,
      startOffset: start, nextOffset: end < item.text.length ? end : null, text: item.text.slice(start, end) };
  }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    const allowed = new Set(['card', 'conversation', 'before', 'query', 'message', 'offset', 'skip', 'limit']);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index].replace(/^--/, '');
      if (!args[index].startsWith('--') || !allowed.has(key) || args[index + 1] == null || Object.hasOwn(options, key)) throw new Error('原文查询参数不合法');
      options[key] = args[index + 1];
    }
    const history = readConversationHistory(ROOT, { cardName: options.card, conversationId: options.conversation || 'main', userAt: options.before });
    process.stdout.write(JSON.stringify(queryConversationHistory(history, { query: options.query || '', messageAt: options.message || '',
      offset: Number(options.offset || 0), skip: Number(options.skip || 0), limit: Number(options.limit || 5) }), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
