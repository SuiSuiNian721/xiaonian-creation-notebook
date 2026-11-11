import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, CARDS, cardDir, safeName, cmdList, cmdCheck, cmdBuild, cmdNew, cmdImport,
  loadCard, parseYaml, TEXT_FIELDS, assertWorkspacePath, assertWorkspaceTree,
} from './card.mjs';
import { listPresets, loadPreset, checkPreset, buildPreset, importPreset } from './presets.mjs';
import { listWorldbooks, loadWorldbook, checkWorldbook, buildWorldbook, importWorldbook } from './worldbooks.mjs';
import { cmdDiagnose } from './diagnose.mjs';
import { generateMvuBundle, DEMO_DEF } from './mvu.mjs';
import { generateEjsController, generateEjsStatusBar, DEMO_CONTROLLER, DEMO_STATUSBAR } from './ejs.mjs';
import { createCodexBridge, getCodexCliStatus, getCodexModels, DEFAULT_CODEX_MODEL, CODEX_REASONING_LEVELS } from './codex-bridge.mjs';
import { normalizeLocalProxyUrl } from './codex-network.mjs';
import { createConversationStore } from './conversations.mjs';
import { withReplyOwners } from './conversation-history.mjs';
import { resetCardTrackState, resolveWorkflowStage } from './studio-directive.mjs';
import { readUserProfile, rememberDisplayName, setWorkbenchUserProfile } from './user-profile.mjs';
import { listPersonas, personaById, personaDisplayName, readPersonaSelection, writePersonaSelection, savePersona, deletePersona } from './personas.mjs';
import { attachPersonaManager } from './persona-ui.mjs';
import { readChatAvatars, saveChatAvatar, readChatAvatar } from './chat-avatars.mjs';
import { chatPresentationParts } from './chat-presentation.mjs';
import { attachChatRecovery } from './chat-recovery-ui.mjs';
import { attachConversationManager } from './conversation-ui.mjs';
import { prepareChatRetry, prepareChatResend, chatDisplayHistory, readChatVersionSelection, writeChatVersionSelection } from './chat-retries.mjs';
import { applyChatEdits, prepareChatEdit, chatEditsFile, getChatContextRevision, prepareChatContextAdvance } from './chat-edits.mjs';
import { prepareChatTaskClose } from './chat-actions.mjs';
import { applyChatDeletions, readChatActionData, chatActionsFile, prepareChatDeletion, prepareChatBranch, listChatDeletions, prepareChatRestoration } from './chat-actions.mjs';
import { readUiDrafts, updateUiDrafts } from './ui-drafts.mjs';
import { listArtifactFiles, readArtifactFile, openArtifactDirectory } from './artifact-files.mjs';
import { attachArtifactAccess } from './artifact-ui.mjs';
import { createChatEventHub } from './chat-events.mjs';
import { attachChatStream } from './chat-stream-ui.mjs';
import { workflowDraftIdentity } from './workflow-write-intent.mjs';
import { CARD_TOOLS, assertSourceFile, generateCardParts, validateSourceChanges, proposalText, isExplicitCardWriteRequest } from './card-tools.mjs';

const PORT = Number(process.env.PORT ?? 8742);
const API_TOKEN = process.env.XIAOXI_API_TOKEN || '';
const chatEvents = createChatEventHub();

function appInfo() {
  if (process.env.XIAOXI_APP_VERSION) return { version: process.env.XIAOXI_APP_VERSION, desktop: true };
  try {
    const packageInfo = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return { version: String(packageInfo.version || '开发版'), desktop: false };
  } catch { return { version: '开发版', desktop: false }; }
}

function artifactInfo(name, targetType) {
  const listing = { card: cmdList, preset: listPresets, book: listWorldbooks };
  if (!Object.hasOwn(listing, targetType)) throw new Error('未知成品类型');
  const status = listing[targetType]().find((item) => item.name === name);
  if (!status) throw new Error('对应内容不存在');
  return listArtifactFiles(ROOT, name, targetType, status);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, maxBytes = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      bytes += c.length;
      if (bytes > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(new Error('请求内容不是有效的 UTF-8 文本')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求已中断')));
  });
}

// 同一保存动作先完成全部验证和临时写入；提交失败时恢复已提交的文件。
function writeFilesAtomically(files) {
  const prepared = [];
  const committed = [];
  try {
    for (const [target, content] of files) {
      if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new Error('保存内容必须是文本');
      const file = assertWorkspacePath(ROOT, target);
      if (fs.existsSync(file) && !fs.statSync(file).isFile()) throw new Error('保存目标不是文件: ' + path.basename(file));
      const item = { file, temp: file + '.' + randomUUID() + '.tmp', previous: fs.existsSync(file) ? fs.readFileSync(file) : null };
      prepared.push(item);
      fs.writeFileSync(item.temp, content, { encoding: 'utf8', flag: 'wx' });
    }
    for (const item of prepared) {
      fs.renameSync(item.temp, item.file);
      committed.push(item);
    }
  } catch (error) {
    const failed = [];
    for (const item of committed.reverse()) {
      try {
        if (item.previous === null) fs.unlinkSync(item.file);
        else { fs.writeFileSync(item.temp, item.previous, { flag: 'wx' }); fs.renameSync(item.temp, item.file); }
      } catch { failed.push(path.relative(ROOT, item.file)); }
    }
    if (failed.length) throw new Error(error.message + '；部分文件未能恢复，请检查：' + failed.join('、'));
    throw error;
  } finally {
    for (const item of prepared) { try { if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp); } catch { /* 原始错误优先 */ } }
  }
}

function writeText(file, content) { writeFilesAtomically([[file, content]]); }

function saveEntryPair(md, yaml, content, side) {
  if (typeof side !== 'string') throw new Error('条目配置必须是文本');
  parseYaml(side);
  const files = [[yaml, side]];
  if (content !== null) files.unshift([md, content]);
  writeFilesAtomically(files);
  LAST_SRC_WRITE = Date.now();
  return { ok: true };
}

function nextEntryBase(directory, suffix, extensions) {
  let index = fs.readdirSync(directory).reduce((max, file) => Math.max(max, Number(/^(\d+)-/.exec(file)?.[1]) || 0), 0) + 1;
  let base;
  do { base = String(index++).padStart(3, '0') + '-' + suffix; }
  while (extensions.some((extension) => fs.existsSync(path.join(directory, base + extension))));
  return base;
}

function assertLocalRequest(req) {
  const host = String(req.headers.host || '');
  let requestOrigin;
  try {
    requestOrigin = new URL('http://' + host);
  } catch {
    throw new Error('非法 Host');
  }
  if (!['127.0.0.1', 'localhost'].includes(requestOrigin.hostname.toLowerCase())) {
    throw new Error('只接受本机访问');
  }
  if (['POST', 'DELETE'].includes(req.method) && API_TOKEN && req.headers['x-xiaoxi-token'] !== API_TOKEN) {
    throw new Error('无效的本机写入令牌');
  }
  const origin = req.headers.origin;
  if (!['POST', 'DELETE'].includes(req.method) || !origin) return;
  let browserOrigin;
  try {
    browserOrigin = new URL(String(origin));
  } catch {
    throw new Error('非法 Origin');
  }
  if (browserOrigin.origin !== requestOrigin.origin) throw new Error('拒绝跨站写请求');
}

function assertPathSegment(value, label) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || /[\\/\0<>:"|?*]/.test(value) || /[. ]$/.test(value)
    || path.basename(value) !== value) {
    throw new Error(`非法${label}: ${value}`);
  }
  return value;
}

function cardTree(name) {
  const dir = cardDir(name);
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const texts = {};
  for (const field of TEXT_FIELDS) texts[field] = read(path.join(src, 'text', field + '.md'));
  const greetings = fs.existsSync(path.join(src, 'greetings'))
    ? fs.readdirSync(path.join(src, 'greetings')).filter((f) => f.endsWith('.md')).sort()
      .map((f) => ({ file: f, content: read(path.join(src, 'greetings', f)) }))
    : [];
  const books = [];
  const wb = path.join(src, 'worldbook');
  if (fs.existsSync(wb)) {
    for (const book of fs.readdirSync(wb).sort()) {
      const bd = path.join(wb, book);
      if (!fs.statSync(bd).isDirectory()) continue;
      const entries = fs.readdirSync(bd).filter((f) => f.endsWith('.md')).sort().map((md) => {
        const base = md.slice(0, -3);
        return { base, content: read(path.join(bd, md)), side: read(path.join(bd, base + '.yaml')) };
      });
      books.push({ book, entries });
    }
  }
  return {
    project: fs.existsSync(path.join(dir, 'project.json')) ? JSON.parse(read(path.join(dir, 'project.json'))) : {},
    index: read(path.join(src, 'index.yaml')),
    texts,
    greetings,
    books,
    extra: read(path.join(src, 'extra.json')),
    note: read(path.join(dir, '创作说明.md')),
  };
}

function assertBookName(book) {
  return assertPathSegment(book, '世界书名');
}

function assertEntryBase(name, book, base) {
  assertBookName(book);
  assertPathSegment(base, '条目名');
  const file = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src', 'worldbook', book, base + '.md'));
  if (!fs.existsSync(file)) throw new Error('条目不存在: ' + book + '/' + base);
  return file;
}

function assertGreetingFile(name, file) {
  assertPathSegment(file, '开场文件名');
  if (!/^\d{3,}-.*\.md$/.test(file)) throw new Error('非法开场文件名: ' + file);
  const p = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src', 'greetings', file));
  if (!fs.existsSync(p)) throw new Error('开场文件不存在: ' + file);
  return p;
}

function presetTree(name) {
  const dir = path.join(ROOT, 'presets', safeName(name));
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const pdir = path.join(src, 'prompts');
  const prompts = fs.existsSync(pdir)
    ? fs.readdirSync(pdir).filter((f) => f.endsWith('.yaml')).sort().map((yml) => {
      const base = yml.slice(0, -5);
      const md = path.join(pdir, base + '.md');
      return { base, content: fs.existsSync(md) ? read(md) : null, side: read(path.join(pdir, yml)) };
    })
    : [];
  return { index: read(path.join(src, 'index.yaml')), extra: read(path.join(src, 'extra.json')), order: read(path.join(src, 'order.json')), prompts };
}

function bookTree(name) {
  const dir = path.join(ROOT, 'worldbooks', safeName(name));
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const edir = path.join(src, 'entries');
  const entries = fs.existsSync(edir)
    ? fs.readdirSync(edir).filter((f) => f.endsWith('.yaml')).sort().map((yml) => {
      const base = yml.slice(0, -5);
      const md = path.join(edir, base + '.md');
      return { base, content: fs.existsSync(md) ? read(md) : null, side: read(path.join(edir, yml)) };
    })
    : [];
  return { index: read(path.join(src, 'index.yaml')), extra: read(path.join(src, 'extra.json')), entries };
}

function assertPromptBase(name, base) {
  assertPathSegment(base, '提示词条目名');
  const file = assertWorkspacePath(ROOT, path.join(ROOT, 'presets', safeName(name), 'src', 'prompts', base + '.yaml'));
  if (!fs.existsSync(file)) throw new Error('提示词条目不存在: ' + base);
  return file;
}

function assertBookEntryBase(name, base) {
  assertPathSegment(base, '世界书条目名');
  const file = assertWorkspacePath(ROOT, path.join(ROOT, 'worldbooks', safeName(name), 'src', 'entries', base + '.yaml'));
  if (!fs.existsSync(file)) throw new Error('世界书条目不存在: ' + base);
  return file;
}

const CHAT_FILE = path.join(ROOT, 'work', 'agent-chat.jsonl');
const LEGACY_CHAT_CARD = '1';
const conversations = createConversationStore(ROOT);
let lastChatTimestamp = 0;
function chatCardName(message) { return String(message.cardName || LEGACY_CHAT_CARD); }
function chatConversationId(message) { return String(message.conversationId || 'main'); }
function appendChatMessage(role, text, cardName = '', conversationId = 'main', personaId = 'neutral', metadata = {}) {
  fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
  const at = new Date(Math.max(Date.now(), lastChatTimestamp + 1)).toISOString();
  lastChatTimestamp = Date.parse(at);
  const message = { role, at, text, personaId, personaName: personaDisplayName(personaId, metadata.personaName || personaById(personaId, ROOT).name) };
  if (cardName) message.cardName = String(cardName);
  message.conversationId = conversationId;
  if (metadata.retryOfAt) message.retryOfAt = String(metadata.retryOfAt);
  if (metadata.retrySourceUserAt) message.retrySourceUserAt = String(metadata.retrySourceUserAt);
  if (metadata.replyToAt) message.replyToAt = String(metadata.replyToAt);
  if (Array.isArray(metadata.replyToAts)) message.replyToAts = [...new Set(metadata.replyToAts.map(String))];
  if (metadata.error) message.error = true;
  if (metadata.error && typeof metadata.partialText === 'string' && metadata.partialText) message.partialText = metadata.partialText.slice(0, 100000);
  if (metadata.module) message.module = String(metadata.module);
  if (metadata.draftReady) message.draftReady = true;
  if (metadata.codexUsage && typeof metadata.codexUsage === 'object' && !Array.isArray(metadata.codexUsage)) {
    const usage = {};
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'cacheWriteInputTokens']) {
      const value = metadata.codexUsage[key];
      usage[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof metadata.codexUsage.complete === 'boolean') usage.complete = metadata.codexUsage.complete;
    message.codexUsage = usage;
  }
  if (typeof metadata.codexThreadId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(metadata.codexThreadId)) {
    message.codexThreadId = metadata.codexThreadId;
  }
  if (typeof metadata.codexThreadReused === 'boolean') message.codexThreadReused = metadata.codexThreadReused;
  fs.appendFileSync(CHAT_FILE, JSON.stringify(message) + '\n');
  chatEvents.refresh(String(cardName || LEGACY_CHAT_CARD), conversationId);
  return at;
}
function selectNewRetryVersion(cardName, conversationId, at) {
  const history = readChat().filter((m) => chatCardName(m) === cardName && chatConversationId(m) === conversationId);
  const selection = readChatVersionSelection(ROOT, cardName, conversationId);
  const group = chatDisplayHistory(history, selection).find((m) => (m.versions || []).some((version) => version.at === at));
  if (group) writeChatVersionSelection(ROOT, cardName, conversationId, { rootReplyAt: group.rootReplyAt, versionAt: at, latestAt: group.latestVersionAt });
}
const codexBridge = createCodexBridge({
  root: ROOT,
  onProgress: (task) => chatEvents.publish(task),
  requestWriteApproval: ({ cardName, conversationId, module, userText, replyToAt, draftIdentity }) => {
    const conversation = requireUnarchivedConversation(cardName, conversationId);
    const currentUser = pendingChat(cardName, conversationId).find((message) => message.at === replyToAt);
    if (!currentUser || currentUser.text !== userText) throw new Error('当前提问已变化或结束，请基于最新内容重新确认');
    const st = readWorkflow(cardName);
    const stage = module || st?.stage;
    if ((conversation.module && conversation.module !== stage)
      || (currentUser.module && currentUser.module !== stage)
      || workflowDraftIdentity(st, conversationId, stage) !== draftIdentity) {
      throw new Error('待确认稿或所属模块已变化，请核对当前完整稿后重新确认写入');
    }
    const approved = approveWorkflowDraft(st, stage, conversationId, cardName);
    approved.writeApproval.source = 'ai-intent';
    approved.writeApproval.replyToAt = replyToAt;
    const approvalIdentity = JSON.stringify(approved.writeApproval);
    const release = () => {
      const current = readWorkflow(cardName, { migrate: false });
      if (current && JSON.stringify(current.writeApproval) === approvalIdentity) {
        current.writeApproval = null;
        writeWorkflow(cardName, current);
      }
    };
    try { writeWorkflow(cardName, approved); }
    catch (error) { try { release(); } catch { /* 保留原始保存错误。 */ } throw error; }
    return release;
  },
  getHistory: (card, conversationId) => applyChatDeletions(ROOT, applyChatEdits(ROOT, withReplyOwners(readRawChat())))
    .filter((message) => chatCardName(message) === card && chatConversationId(message) === conversationId),
  onReply: async (card, text, meta) => {
    if (meta.replyToAt && !pendingChat(card, meta.conversationId).some((message) => message.at === meta.replyToAt)) return;
    const draftReady = /(?:^|\n)@workflow-draft\s*(?:\n|$)/.test(text);
    const completed = /(?:^|\n)@workflow-complete\s*(?:\n|$)/.test(text);
    let visibleText = text.replace(/(?:^|\n)@workflow-(?:draft|complete)\s*(?=\n|$)/g, '').trim();
    const st = readWorkflow(card);
    const stage = meta.module || (st && st.stage) || '';
    let draftRecorded = false;
    try {
      if (st && completed && meta.allowWrite) {
        completeWorkflowStage(card, st, stage, meta.conversationId, meta.changedFiles || []);
      } else if (st && draftReady) {
        writeWorkflow(card, markWorkflowDraft(st, stage, meta.conversationId, visibleText, meta.personaId));
        draftRecorded = true;
      }
    } catch (error) {
      visibleText += '\n\n这次的制作进度未推进：' + error.message + '。请先处理这项问题，已有回复和文件会保留。';
    }
    const at = appendChatMessage('agent', visibleText, card, meta.conversationId, meta.personaId, { ...meta, module: stage, draftReady: draftRecorded });
    if (meta.retryOfAt && !meta.error) selectNewRetryVersion(card, meta.conversationId, at);
    if (meta && meta.changedFiles && meta.changedFiles.length) LAST_SRC_WRITE = Date.parse(at) - 1;
    return { at, text: visibleText, module: stage, draftReady: draftRecorded };
  },
  onFailure: async (card, error, meta) => {
    const currentUser = meta.replyToAt && pendingChat(card, meta.conversationId).find((message) => message.at === meta.replyToAt);
    if (meta.replyToAt && !currentUser) return;
    const nextStep = meta.allowWrite
      ? '写入可能已经部分完成，请先核对“已保存内容”，需要继续时在输入框新发写入要求。'
      : /写入|保存|落盘/.test(currentUser?.text || '')
        ? '可重新发送恢复回复；如果需要写入，请核对完整稿后在输入框新发“确认写入”。'
        : '可重新发送这条消息。';
    appendChatMessage('agent', 'Codex 回复未完成：' + error + '。' + nextStep, card, meta.conversationId, meta.personaId, { ...meta, error: true });
  },
});
// 最近一次 src 条目写入的时间戳，供聊天接口保留兼容信息；导航建议由用户点击。
let LAST_SRC_WRITE = 0;

function readRawChatBytes() {
  const file = assertWorkspacePath(ROOT, CHAT_FILE);
  if (!fs.existsSync(file)) return Buffer.alloc(0);
  return fs.readFileSync(file);
}
function parseRawChat(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { throw Object.assign(new Error('聊天记录不是有效的 UTF-8 JSONL，原文件已保留'), { statusCode: 500 }); }
}
function readRawChat() { return parseRawChat(readRawChatBytes()); }
function readChat() { return applyChatDeletions(ROOT, applyChatEdits(ROOT, readRawChat())); }
function chatActionIdentity(message) { return JSON.stringify([chatCardName(message), chatConversationId(message), message.role, message.at]); }

// 桥接：按卡与对话共同分组，避免不同专用对话的待回复消息互相混入。
function pendingChat(cardName, conversationId = 'main') {
  // 原始回复（包括已删除的回复和错误）仍是任务完成边界，防止删除后重跑旧提问。
  const ms = applyChatEdits(ROOT, readRawChat()).filter((message) => !cardName || (chatCardName(message) === cardName && chatConversationId(message) === conversationId));
  const actions = readChatActionData(ROOT);
  const canConsume = (message) => message.role === 'user' && !message.historyOnly && !message.pinned && !message.pending
    && !Object.hasOwn(actions.deleted, chatActionIdentity(message)) && !Object.hasOwn(actions.closedTasks, chatActionIdentity(message));
  const owners = new Map();
  ms.forEach((message, index) => {
    const owner = chatCardName(message) + '::' + chatConversationId(message);
    if (!owners.has(owner)) owners.set(owner, new Map());
    const outstanding = owners.get(owner);
    if (canConsume(message)) outstanding.set(message.at, { message, index });
    else if (['agent', 'assistant'].includes(message.role)) {
      if (Array.isArray(message.replyToAts)) message.replyToAts.forEach((at) => outstanding.delete(at));
      else if (message.replyToAt) outstanding.delete(message.replyToAt);
      else outstanding.clear(); // 老记录没有任务身份，沿用原来的回复顺序边界。
    }
  });
  const selected = [...owners.values()].filter((items) => items.size)
    .sort((a, b) => [...b.values()].at(-1).index - [...a.values()].at(-1).index)[0];
  return selected ? [...selected.values()].map((item) => item.message) : [];
}

function chatActionsBusy(cardName, conversationId, pending = pendingChat(cardName, conversationId), codexState = codexBridge.status()) {
  return codexState.queuedConversations.includes(cardName + '::' + conversationId) || (!!bridgeProc && pending.length > 0);
}

function requireUnarchivedConversation(cardName, conversationId) {
  const conversation = conversations.get(cardName, conversationId);
  if (conversation.archivedAt) throw Object.assign(new Error('这段对话已归档，请在「对话管理」中恢复后再操作'), { statusCode: 409 });
  return conversation;
}

function chatActionScope(name, body) {
  if (!name || body.targetType !== 'card') throw new Error('请先选择一张角色卡或世界卡，再操作消息');
  const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('目标卡片不存在');
  const conversationId = body.conversationId;
  if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('请指定消息所属对话');
  assertWorkspacePath(ROOT, path.join(ROOT, 'work', 'conversations.json'));
  let conversation;
  try { conversation = requireUnarchivedConversation(name, conversationId); }
  catch (error) { throw Object.assign(error, { statusCode: 409 }); }
  const pending = pendingChat(name, conversationId);
  if (chatActionsBusy(name, conversationId, pending)) {
    throw Object.assign(new Error('当前对话还有回复正在处理，请等它完成后再操作消息'), { statusCode: 409 });
  }
  const bytes = readRawChatBytes();
  const raw = parseRawChat(bytes);
  const selection = readChatVersionSelection(ROOT, name, conversationId);
  return { conversationId, conversation, pending, bytes, raw, selection };
}

function prepareScopedChatRetry(cardName, conversationId, history, replyAt, selection) {
  let retry;
  try { retry = prepareChatRetry(history, replyAt, selection); }
  catch (error) {
    if (/找不到.*原提问/.test(error.message)) error.statusCode = 409;
    throw error;
  }
  const raw = readRawChat().filter((message) => chatCardName(message) === cardName && chatConversationId(message) === conversationId);
  const group = chatDisplayHistory(raw).find((message) => (message.versions || []).some((version) => chatActionIdentity(version) === chatActionIdentity(retry.target)));
  const anchor = raw.findIndex((message) => ['agent', 'assistant'].includes(message.role) && message.at === (group?.rootReplyAt || retry.target.at));
  const source = retry.target.retrySourceUserAt
    ? raw.filter((message) => message.role === 'user' && !message.retryOfAt && message.at === retry.target.retrySourceUserAt)
    : raw.slice(0, Math.max(0, anchor)).filter((message) => message.role === 'user' && !message.retryOfAt).slice(-1);
  // 删除提问后，保留的回答不能改绑到前一轮；已保存编辑及分支历史仍按原身份匹配。
  if (source.length !== 1 || chatActionIdentity(source[0]) !== chatActionIdentity(retry.sourceUser)) {
    throw Object.assign(new Error('这条答复对应的原提问已删除或发生冲突，请基于当前历史发送新消息'), { statusCode: 409 });
  }
  return retry;
}

function chatResendBlockedReason(cardName, conversation, cfg, personaId, pending, codexState) {
  if (conversation.archivedAt) return '这段对话已归档，请在「对话管理」中恢复后再重新发送';
  if (pending.length || codexState.queuedConversations.includes(cardName + '::' + conversation.id)) {
    return '当前对话还有待回复任务，请等待完成，或先停止回复／停止等待后再重新发送';
  }
  if (!cfg.configured) return '请先在「接入设置」启用自动回复并补齐配置，再重新发送';
  if (cfg.backend === 'codex' && !codexState.enabled) return 'Codex 桥已停止，请在「接入设置」重新启用';
  if (cfg.backend === 'openai' && !bridgeProc) return '外部回复服务已停止，请在「接入设置」重新启用';
  return '';
}

// 对话接入配置：work/llm-config.json；Codex 后端通过本机 ChatGPT 登录的 Codex CLI 直连。
const LLM_CFG = path.join(ROOT, 'work', 'llm-config.json');
function normalizeCodexProjectPath(value) {
  if (typeof value !== 'string') throw new Error('Codex 项目目录必须是路径文本');
  const supplied = value.trim();
  if (!supplied) return '';
  if (!path.isAbsolute(supplied)) throw new Error('Codex 项目目录必须是绝对路径');
  const normalized = path.normalize(supplied);
  const resolved = path.resolve(normalized);
  if (path.parse(normalized).root.toLowerCase() !== path.parse(resolved).root.toLowerCase()) {
    throw new Error('Codex 项目目录必须包含完整的盘符或共享目录');
  }
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of ['', ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch { throw new Error('Codex 项目目录不存在或无法读取，请选择已有目录'); }
    if (stat.isSymbolicLink()) throw new Error('Codex 项目目录及其上级不能使用符号链接或目录联接');
    if (!stat.isDirectory()) throw new Error('Codex 项目路径必须指向目录');
  }
  return resolved;
}
function llmStatus() {
  if (!fs.existsSync(LLM_CFG)) return { configured: false, enabled: false, backend: 'codex', baseUrl: '', model: '', codexModel: DEFAULT_CODEX_MODEL, codexReasoningEffort: '', codexProxyUrl: '', codexProjectPath: '', temperature: 0.7, hasKey: false };
  try {
    const c = JSON.parse(fs.readFileSync(LLM_CFG, 'utf8'));
    const supported = ['openai', 'codex'].includes(c.backend);
    const backend = supported ? c.backend : 'codex';
    const enabled = supported && !!c.enabled;
    return {
      configured: enabled && (backend !== 'openai' || !!c.baseUrl),
      enabled,
      backend,
      baseUrl: c.baseUrl || '',
      model: c.model || '',
      codexModel: String(c.codexModel || '').trim() || DEFAULT_CODEX_MODEL,
      codexReasoningEffort: CODEX_REASONING_LEVELS.includes(c.codexReasoningEffort) ? c.codexReasoningEffort : '',
      codexProxyUrl: normalizeLocalProxyUrl(c.codexProxyUrl ?? ''),
      codexProjectPath: normalizeCodexProjectPath(c.codexProjectPath ?? ''),
      temperature: typeof c.temperature === 'number' ? c.temperature : 0.7,
      hasKey: !!c.apiKey,
    };
  } catch { return { configured: false, enabled: false, backend: 'codex', baseUrl: '', model: '', codexModel: DEFAULT_CODEX_MODEL, codexReasoningEffort: '', codexProxyUrl: '', codexProjectPath: '', temperature: 0.7, hasKey: false, error: '配置解析失败或目录不可用' }; }
}
async function writeLlmCfg(body) {
  if (!['openai', 'codex'].includes(body.backend)) throw new Error('请选择 Codex 或 OpenAI 兼容端口');
  const backend = body.backend;
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(LLM_CFG, 'utf8')); } catch { /* 首次保存 */ }
  const suppliedKey = String(body.apiKey || '').trim();
  const reasoningEffort = Object.hasOwn(body, 'codexReasoningEffort') ? body.codexReasoningEffort : (existing.codexReasoningEffort ?? '');
  if (typeof reasoningEffort !== 'string' || (reasoningEffort !== '' && !CODEX_REASONING_LEVELS.includes(reasoningEffort))) {
    throw new Error('Codex 思考档位不合法，请选择跟随 Codex 设置或列表中的档位');
  }
  const c = {
    enabled: !!body.enabled,
    backend,
    baseUrl: String(body.baseUrl || '').trim(),
    apiKey: suppliedKey || String(existing.apiKey || ''),
    model: String(body.model || '').trim(),
    codexModel: String(body.codexModel ?? existing.codexModel ?? '').trim() || DEFAULT_CODEX_MODEL,
    codexReasoningEffort: reasoningEffort,
    codexProxyUrl: normalizeLocalProxyUrl(Object.hasOwn(body, 'codexProxyUrl') ? body.codexProxyUrl : (existing.codexProxyUrl ?? '')),
    codexProjectPath: normalizeCodexProjectPath(Object.hasOwn(body, 'codexProjectPath') ? body.codexProjectPath : (existing.codexProjectPath ?? '')),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
  };
  if (c.enabled && backend === 'openai' && !c.baseUrl) throw new Error('外部端口后端必须填写 baseUrl');
  if (c.enabled && backend === 'codex') {
    const status = await getCodexCliStatus();
    if (!status.installed || !status.authenticated) throw new Error(status.error || '请先登录 Codex');
    if (status.authMethod !== 'ChatGPT') throw new Error('当前 Codex 未使用 ChatGPT 登录，请先切换登录方式');
  }
  fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
  writeText(LLM_CFG, JSON.stringify(c, null, 2) + '\n');
  // 兼容端口由 studio 托管；Codex CLI 按每条面板消息直接调用。
  let br;
  try { br = (c.enabled && backend === 'openai') ? startBridge() : stopBridge(); } catch { br = { running: false }; }
  if (c.enabled && backend === 'codex') codexBridge.enable();
  else codexBridge.stop();
  return Object.assign(llmStatus(), br, { codex: codexBridge.status() });
}

// ---- 自动桥进程托管：studio 拉起/停止 tools/bridge.mjs ----
let bridgeProc = null;
let bridgeLog = '';
const externalReplyTasks = new Map();
function externalReplyKey(cardName, conversationId, replyToAt) { return JSON.stringify([cardName, conversationId, replyToAt]); }
function publicExternalReplyTask(task, ended = false) {
  const { taskId, cardName, conversationId, replyToAt, backend, phase, queuedAt, startedAt, personaId,
    round, partialText, previewRevision, activityRevision, lastActivityAt } = task;
  return { taskId, cardName, conversationId, replyToAt, backend, phase, queuedAt, startedAt, personaId,
    round, partialText, previewRevision, activityRevision, lastActivityAt, canStop: !ended, allowWrite: false, ...(ended ? { ended: true } : {}) };
}
function endExternalReplyTask(key) {
  const task = externalReplyTasks.get(key);
  if (!task) return;
  externalReplyTasks.delete(key);
  task.previewRevision++;
  chatEvents.publish(publicExternalReplyTask(task, true));
}
function clearExternalReplyTasks() {
  for (const key of externalReplyTasks.keys()) endExternalReplyTask(key);
}
function currentReplyTask(cardName, conversationId, pending, cfg, codexState) {
  const owned = (codexState.tasks || []).filter((task) => task.cardName === cardName && task.conversationId === conversationId
    && (task.phase === 'stopping' || pending.some((message) => message.at === task.replyToAt)));
  if (owned.length) return owned.find((task) => task.phase !== 'queued') || owned[0];
  const claimed = [...externalReplyTasks.values()].find((task) => task.cardName === cardName && task.conversationId === conversationId
    && pending.some((message) => message.at === task.replyToAt));
  if (claimed) return publicExternalReplyTask(claimed);
  const target = pending.at(-1);
  if (!target) return null;
  return { cardName, conversationId, replyToAt: target.at, backend: cfg.backend,
    phase: cfg.backend === 'openai' && bridgeProc ? 'queued' : 'waiting-service',
    queuedAt: target.at, startedAt: '', personaId: target.personaId || 'xiaoxi', canStop: true, allowWrite: false };
}
function replyTaskText(task) {
  if (task.stopError) return task.stopError;
  const labels = {
    queued: '已排队，等待开始回复…', 'checking-login': '正在检查本机登录状态…', preparing: '正在读取当前对话与卡片内容…',
    starting: task.backend === 'openai' ? '正在连接模型…' : '正在连接 Codex…', thinking: '正在思考…', reading: '正在读取资料…', summarizing: '正在整理较早的对话…',
    'preparing-write': '已理解写入要求，正在准备保存…',
    'running-tool': '正在处理资料…', generating: '正在生成回复…', reconnecting: '连接中断，正在尝试恢复…',
    recovering: '正在重新建立连接（自动恢复 1/1），已收到的内容已保留…', finalizing: '回复已生成，正在核验…',
    'waiting-model': '正在等待模型回复…',
    'waiting-service': '这条消息目前没有正在运行的回复任务，可停止等待后重新发送。',
    stopping: '正在停止本轮回复，确认相关进程退出后会结束等待…',
  };
  return (task.round > 1 ? '第 ' + task.round + ' 步 · ' : '') + (labels[task.phase] || '正在等待回复…') + (task.allowWrite ? ' 本轮已获准写入，停止不会撤回已经保存的正文。' : '');
}
function bridgeStatus() { return { running: !!bridgeProc, log: bridgeLog.slice(-600) }; }
function startBridge() {
  if (bridgeProc) return bridgeStatus();
  const s = llmStatus();
  if (s.backend !== 'openai') throw new Error('当前后端不是 OpenAI 兼容端口');
  if (!s.configured) throw new Error('先在「接入设置」填 baseUrl 并启用');
  const bridgeFile = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  const proc = spawn(process.execPath, [bridgeFile], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(server.address().port) }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  bridgeProc = proc;
  const push = (b) => { bridgeLog = (bridgeLog + b.toString()).slice(-4000); };
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
  proc.on('error', (error) => { if (bridgeProc === proc) bridgeProc = null; push('\n[桥启动失败] ' + error.message); });
  proc.on('exit', () => {
    if (bridgeProc === proc) { bridgeProc = null; clearExternalReplyTasks(); }
    push('\n[桥已退出]');
  });
  bridgeLog += '\n[桥已启动]';
  return bridgeStatus();
}
function stopBridge() {
  clearExternalReplyTasks();
  if (!bridgeProc) return bridgeStatus();
  const p = bridgeProc;
  bridgeProc = null;
  p.kill();
  bridgeLog += '\n[桥已停止]';
  return bridgeStatus();
}

// 探测本机常见 OpenAI 兼容模型服务端口（Ollama/llama.cpp/LM Studio/vLLM 等）
async function detectLocalModels() {
  const ports = [11434, 8080, 8081, 1234, 8000, 5000];
  const found = [];
  await Promise.all(ports.map(async (port) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 900);
      const r = await fetch('http://127.0.0.1:' + port + '/v1/models', { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return;
      const j = await r.json().catch(() => null);
      const models = (j && Array.isArray(j.data) ? j.data : []).map((m) => m.id).filter(Boolean);
      found.push({ port, baseUrl: 'http://127.0.0.1:' + port + '/v1', models });
    } catch { /* 端口无服务 */ }
  }));
  found.sort((a, b) => a.port - b.port);
  return { found };
}

// ---------- 制卡工作流向导 ----------
const WORKFLOW_DIR = path.join(ROOT, 'workflow');
const GUIDE_DIR = path.join(ROOT, 'docs', '写作参考');
const SEG_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]+$/;

// stage 会变成文件路径，必须挡住 ../ 与任意分隔符越界
function assertStage(stage) {
  const s = String(stage || '');
  if (!s || s.includes('..') || !/^[A-Za-z0-9_\u4e00-\u9fa5/-]+$/.test(s)) throw new Error('非法 stage: ' + s);
  const abs = path.resolve(WORKFLOW_DIR, s + '.md');
  if (abs !== path.resolve(WORKFLOW_DIR) && !abs.startsWith(path.resolve(WORKFLOW_DIR) + path.sep)) throw new Error('stage 越界: ' + s);
  return s;
}

function workflowFile(name) { return assertWorkspacePath(ROOT, path.join(cardDir(name), '.card', 'workflow.json')); }

// 删除旧 03-NSFW 模块后，读取旧进度时映射到连续的新编号。
// 只在下一次正常保存进度时落盘，避免浏览页面改写状态文件。
function migrateWorkflow(st) {
  if (!st) return st;
  if ((st.workflowVersion || 0) < 2 && st.plan?.cardType === '角色卡') {
    const mapStage = (stage) => {
      const match = /^角色卡\/(\d{2})(-.+)$/.exec(stage || '');
      if (!match) return stage;
      if (match[1] === '03' && match[2] === '-NSFW') return null;
      const number = Number(match[1]);
      return number >= 4 && number <= 17
        ? `角色卡/${String(number - 1).padStart(2, '0')}${match[2]}`
        : stage;
    };
    const oldModules = Array.isArray(st.plan.modules) ? st.plan.modules : [];
    st.plan.modules = oldModules.map(mapStage).filter(Boolean);
    st.done = [...new Set((Array.isArray(st.done) ? st.done : []).map(mapStage).filter(Boolean))];
    st.artifacts = Object.fromEntries(Object.entries(st.artifacts || {})
      .map(([stage, value]) => [mapStage(stage), value]).filter(([stage]) => stage));
    if (st.stage === '角色卡/03-NSFW') {
      const next = oldModules.slice(oldModules.indexOf(st.stage) + 1).map(mapStage).find(Boolean);
      st.stage = next || st.plan.modules.find((stage) => !st.done.includes(stage)) || '00-引导';
    } else if (String(st.stage || '').startsWith('完成:')) {
      st.stage = '完成:' + (mapStage(st.stage.slice(3)) || st.plan.modules.at(-1) || '00-引导');
    } else {
      st.stage = mapStage(st.stage);
    }
  }
  st.done = Array.isArray(st.done) ? st.done : [];
  st.plan = st.plan || {};
  st.plan.modules = Array.isArray(st.plan.modules) ? st.plan.modules : [];
  st.artifacts = st.artifacts && typeof st.artifacts === 'object' ? st.artifacts : {};
  if (!('pendingDraft' in st)) st.pendingDraft = null;
  if (!('writeApproval' in st)) st.writeApproval = null;
  st.workflowVersion = 3;
  return st;
}

function readWorkflow(name, { migrate = true } = {}) {
  const f = workflowFile(name);
  if (!fs.existsSync(f)) return null;
  try {
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!st || typeof st !== 'object' || Array.isArray(st)) throw new Error('进度必须是对象');
    return migrate ? migrateWorkflow(st) : st;
  } catch (error) { throw new Error('制作进度读取失败，原文件已保留：' + error.message); }
}

function writeWorkflow(name, st) {
  const dir = assertWorkspacePath(ROOT, path.join(cardDir(name), '.card'));
  fs.mkdirSync(dir, { recursive: true });
  st.workflowVersion = 3;
  st.updatedAt = new Date().toISOString();
  writeText(workflowFile(name), JSON.stringify(st, null, 2) + '\n');
  return st;
}

function listTracks() {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  return fs.readdirSync(WORKFLOW_DIR)
    .filter((d) => SEG_RE.test(d) && fs.statSync(path.join(WORKFLOW_DIR, d)).isDirectory())
    .sort();
}

// 必/选 从 说明.md 的模块清单解析，避免在代码里重复一份会过期的表。
// 行形如 `| 角色卡/01 | 世界观设定 | 必 |` 或 `| 00 | 引导… | 必经 |`，键含轨道名以免跨轨串味。
function moduleMeta() {
  const map = {};
  const f = path.join(WORKFLOW_DIR, '说明.md');
  if (!fs.existsSync(f)) return map;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const num = /(\d{2})$/.exec(cells[0]);
    if (!num) continue;
    const track = cells[0].includes('/') ? cells[0].split('/')[0] : '';
    map[track + '#' + num[1]] = cells[2];
  }
  return map;
}

function trackModules(track) {
  if (!track || !SEG_RE.test(track)) return [];
  const dir = path.join(WORKFLOW_DIR, track);
  if (!fs.existsSync(dir)) return [];
  const meta = moduleMeta();
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const base = f.slice(0, -3);
    const num = base.slice(0, 2);
    return { stage: track + '/' + base, need: meta[track + '#' + num] || meta['#' + num] || '' };
  });
}

function readModule(stage) {
  const s = assertStage(stage);
  const f = path.join(WORKFLOW_DIR, s + '.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

function readCreatorGuide(stage) {
  const safeStage = assertStage(stage);
  const specific = path.join(GUIDE_DIR, safeStage + '.md');
  const commonName = safeStage.split('/').at(-1).replace(/^\d{2}-/, '');
  const common = path.join(GUIDE_DIR, '共用', commonName + '.md');
  const file = [specific, common].find((candidate) => fs.existsSync(candidate));
  return file ? { markdown: fs.readFileSync(file, 'utf8'), source: '创作者参考' }
    : { markdown: readModule(safeStage), source: '模块说明' };
}

// 从模块 md 抽侧栏概括：优先读人工维护的 "> 概括：…" 一行（人话、不带代码字段）；
// 没有才退回 md 的"这一步产出什么 / 何时进入"段，并洗掉文件路径等代码字段。
function moduleSummary(stage) {
  let md = '';
  try { md = readModule(stage); } catch { return ''; }
  if (!md) return '';
  const lines = md.split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith('> 概括：') || t.startsWith('>概括：')) {
      return cleanSummary(t.replace(/^>\s*概括：/, ''));
    }
  }
  const section = (title) => {
    const out = [];
    let on = false;
    for (const ln of lines) {
      if (/^##\s/.test(ln)) {
        if (on) break;
        on = ln.replace(/^##\s*/, '').trim().startsWith(title);
        continue;
      }
      if (on && ln.trim()) out.push(ln.trim());
    }
    return out.join(' ');
  };
  let s = section('这一步产出什么') || section('何时进入');
  if (!s) {
    for (const ln of lines) {
      const t = ln.trim();
      if (!t || t.startsWith('#')) continue;
      s = t;
      break;
    }
  }
  return cleanSummary(s);
}
// 压成单行纯文本：去粗体/反引号、去文件路径与代码字段、压空白、限长。
function cleanSummary(s) {
  s = (s || '').replace(/\*\*/g, '').replace(/`/g, '');
  s = s
    .replace(/[A-Za-z0-9_<>*{}./\\-]+\.(?:md|yaml|yml|json|png|mjs)\b/g, '')
    .replace(/(?:src|cards|dist|presets|worldbooks|workflow|original|imports)[/\\<][\w<>*{}./\\-]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

function blankWorkflow(cardType) {
  const mods = trackModules(cardType).map((m) => m.stage);
  return { workflowVersion: 3, stage: '00-引导', done: [], plan: { cardType, concept: '', worldview: '', outline: '', modules: mods }, artifacts: {}, pendingDraft: null, writeApproval: null, updatedAt: '' };
}

function advanceStage(st) {
  const list = (st.plan && st.plan.modules && st.plan.modules.length)
    ? st.plan.modules
    : trackModules(st.plan && st.plan.cardType).map((m) => m.stage);
  if (!st.done.includes(st.stage)) st.done.push(st.stage);
  const next = list.find((s) => !st.done.includes(s));
  if (next) st.stage = next;
  else st.stage = '完成:' + (list[list.length - 1] || st.stage);
  return st;
}

function assertWorkflowStage(st, stage) {
  const value = assertStage(stage);
  if (value !== '00-引导' && !(st.plan.modules || []).includes(value)) throw new Error('该模块不在当前制作计划中: ' + value);
  return value;
}

function workflowConversationId(value) {
  const id = String(value || 'main');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('非法对话 ID');
  return id;
}

function markWorkflowDraft(st, stage, conversationId, text = '', personaId = 'neutral', personaNameSnapshot = '') {
  const value = assertWorkflowStage(st, stage);
  if (typeof text !== 'string' || !text.trim()) throw new Error('请先展示并登记完整待确认稿');
  const persona = personaNameSnapshot ? { id: personaId, name: personaDisplayName(personaId, personaNameSnapshot) } : personaById(personaId, ROOT);
  st.pendingDraft = { stage: value, conversationId: workflowConversationId(conversationId), at: new Date().toISOString(), text: String(text || ''), personaId: persona.id, personaName: persona.name };
  st.writeApproval = null;
  return st;
}

function snapshotCardSource(name) {
  const src = assertWorkspaceTree(ROOT, path.join(cardDir(name), 'src'));
  const result = Object.create(null);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[path.relative(src, file).split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  visit(src);
  return result;
}

function cardToolSource(name) {
  const paths = Object.keys(snapshotCardSource(name));
  const source = Object.create(null);
  let bytes = 0;
  for (const file of paths) {
    try { assertSourceFile(file); } catch { continue; }
    const content = fs.readFileSync(assertWorkspacePath(ROOT, path.join(cardDir(name), 'src', file)), 'utf8');
    bytes += Buffer.byteLength(content);
    if (bytes > 4 * 1024 * 1024) throw new Error('当前源文件超过工具读取上限，请分模块编辑');
    source[file] = content;
  }
  return source;
}

function cardProposalFile(name, conversationId) {
  return assertWorkspacePath(ROOT, path.join(cardDir(name), '.card', 'tool-proposals', workflowConversationId(conversationId) + '.json'));
}

function currentCardProposal(name, conversationId) {
  const file = cardProposalFile(name, conversationId);
  if (!fs.existsSync(file)) return null;
  const proposal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (proposal.appliedAt || !proposal.shownAt || proposal.contextRevision !== getChatContextRevision(ROOT, name, conversationId)) return null;
  const history = chatDisplayHistory(readChat().filter(message => chatCardName(message) === name && chatConversationId(message) === conversationId), readChatVersionSelection(ROOT, name, conversationId));
  const shown = history.find(message => message.at === proposal.shownAt && !message.editRevision);
  if (!shown || createHash('sha256').update(shown.text).digest('hex') !== proposal.shownHash) return null;
  return proposal;
}

function executeCardTool(task, target, tool, args) {
  const name = task.cardName;
  if (!task.tools.some(item => item.function.name === tool)) throw new Error('本轮不提供该制卡工具');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象');
  const schema = task.tools.find(item => item.function.name === tool).function.parameters;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(args, key))) throw new Error('工具参数缺失或含未知字段');
  if (tool === 'check_card') return cmdCheck(name);
  if (tool === 'diagnose_card') return cmdDiagnose(name);
  if (tool === 'export_card') {
    const result = routes['POST /api/build'](null, name);
    task.toolOutcomes.push('已导出 PNG 和 JSON，可点击“查看成品”下载。');
    return result;
  }
  const source = cardToolSource(name);
  const before = snapshotCardSource(name);
  if (tool === 'read_card') {
    if (args.path) {
      assertSourceFile(args.path);
      if (!Object.hasOwn(source, args.path)) throw new Error('源文件不存在');
      if (Buffer.byteLength(source[args.path]) > 180000) throw new Error('单个源文件过大，请在编辑器查看');
      return { path: args.path, content: source[args.path] };
    }
    const proposal = currentCardProposal(name, task.conversationId);
    return { name, files: Object.entries(source).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content) })), check: cmdCheck(name),
      pendingProposal: proposal ? { id: proposal.id, summary: proposal.summary, files: proposal.files.map(file => file.path) } : null };
  }
  if (tool.startsWith('generate_')) {
    const files = generateCardParts(tool, args, source);
    const generationId = randomUUID();
    task.generations.set(generationId, { files, before });
    return { generationId, saved: false, files, instruction: '生成完成但尚未写入；将 generationId 传给 prepare_card_changes 的 generatedIds 展示完整稿。' };
  }
  if (tool === 'prepare_card_changes') {
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 1000) throw new Error('请简短说明本次修改');
    if (args.generatedIds !== undefined && !Array.isArray(args.generatedIds)) throw new Error('generatedIds 必须是数组');
    if (args.files !== undefined && !Array.isArray(args.files)) throw new Error('files 必须是数组');
    const files = [...(args.files || [])];
    for (const id of args.generatedIds || []) {
      const generated = task.generations.get(id);
      if (!generated || JSON.stringify(generated.before) !== JSON.stringify(before)) throw new Error('生成草稿已过期，请重新读取并生成');
      files.push(...generated.files);
    }
    const validated = validateSourceChanges(files, source);
    const proposal = { id: randomUUID(), summary: args.summary, files: validated, before, requestAt: task.replyToAt, contextRevision: getChatContextRevision(ROOT, name, task.conversationId) };
    if (proposalText(proposal).length > 90000) throw new Error('完整稿过长，请分模块准备');
    task.proposal = proposal;
    return { proposalId: proposal.id, saved: false, replyReady: 'proposal', files: validated.map(file => file.path), instruction: '程序会在最终答复自动附上完整稿。请简短说明并等待用户下一条消息确认，本轮不能 apply。' };
  }
  if (tool === 'apply_card_changes') {
    const proposal = currentCardProposal(name, task.conversationId);
    if (!proposal || proposal.id !== args.proposalId || proposal.requestAt === task.replyToAt || proposal.shownAt >= task.replyToAt || task.proposal) throw new Error('没有上一轮已展示且仍有效的完整稿，请重新准备并让用户确认');
    if (typeof args.confirmation !== 'string' || args.confirmation !== target.text) throw new Error('确认必须来自本轮用户原话');
    if (!isExplicitCardWriteRequest(target.text)) throw new Error('本轮没有明确同意写入这份稿；请先回应用户的疑问或改稿要求。用户确实确认时可说“按这版写入”');
    if (JSON.stringify(proposal.before) !== JSON.stringify(before)) throw new Error('正文在展示稿件后已变化，请重新读取并准备完整稿');
    const files = validateSourceChanges(proposal.files, source);
    const writes = files.map(file => [assertWorkspacePath(ROOT, path.join(cardDir(name), 'src', file.path)), file.content]);
    for (const [file] of writes) fs.mkdirSync(path.dirname(file), { recursive: true });
    const marker = { ...proposal, appliedAt: task.replyToAt };
    writes.push([cardProposalFile(name, task.conversationId), JSON.stringify(marker, null, 2) + '\n']);
    writeFilesAtomically(writes);
    LAST_SRC_WRITE = Date.now();
    task.toolOutcomes.push('已写入确认稿（' + files.length + ' 个文件）。');
    return { saved: true, files: files.map(file => file.path), check: cmdCheck(name), runtimeVerified: false };
  }
  throw new Error('未知制卡工具');
}

function approveWorkflowDraft(st, stage, conversationId, name) {
  const value = assertWorkflowStage(st, stage);
  const id = workflowConversationId(conversationId);
  if (!st.pendingDraft || st.pendingDraft.stage !== value || st.pendingDraft.conversationId !== id) {
    throw new Error('没有与当前模块和对话对应的待确认稿');
  }
  if (!String(st.pendingDraft.text || '').trim()) throw new Error('这份旧草稿没有完整正文，请重新展示后确认');
  st.writeApproval = { stage: value, conversationId: id, at: new Date().toISOString(), draftAt: st.pendingDraft.at, srcBefore: snapshotCardSource(name) };
  return st;
}

function normalizeArtifacts(name, artifacts, srcBefore = {}) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts 必须是数组');
  const src = assertWorkspacePath(ROOT, path.resolve(cardDir(name), 'src'));
  return [...new Set(artifacts.map((item) => String(item || '').replace(/\\/g, '/')).filter(Boolean))].map((relative) => {
    const file = assertWorkspacePath(src, path.resolve(src, relative));
    const normalized = path.relative(src, file).split(path.sep).join('/');
    if (!fs.existsSync(file) && Object.hasOwn(srcBefore, normalized)) return normalized;
    if (file === src || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('产物不是有效文件: ' + relative);
    if (/\.json$/i.test(file)) JSON.parse(fs.readFileSync(file, 'utf8'));
    else if (/\.ya?ml$/i.test(file)) parseYaml(fs.readFileSync(file, 'utf8'));
    return normalized;
  });
}

function completeWorkflowStage(name, st, stage, conversationId, artifacts) {
  const value = assertWorkflowStage(st, stage);
  const id = workflowConversationId(conversationId);
  if (!st.writeApproval || st.writeApproval.stage !== value || st.writeApproval.conversationId !== id) {
    throw new Error('当前模块尚未获得写入确认');
  }
  const before = st.writeApproval.srcBefore;
  if (!before || typeof before !== 'object' || Array.isArray(before) || st.writeApproval.draftAt !== st.pendingDraft?.at) throw new Error('确认记录已过期，请重新确认完整稿');
  const files = normalizeArtifacts(name, artifacts, before);
  const after = snapshotCardSource(name);
  if (value !== '00-引导') {
    if (!files.length) throw new Error('没有已写入的产物，不能标记模块完成');
    if (!files.some((file) => after[file] !== before[file])) throw new Error('尚未检测到确认后的实际写入，模块未完成');
    // 尚未写到的必填模块可以留空；本轮清空或删除的必填正文必须报错。
    const errors = cmdCheck(name).errors.filter((message) => {
      const required = /^src\/(text\/(?:description|first_mes)\.md) 为空/.exec(message)?.[1];
      return !required || before[required] !== after[required];
    });
    if (errors.length) throw new Error('产物检查未通过：' + errors.join('；'));
  }
  st.artifacts[value] = files.filter((file) => Object.hasOwn(after, file));
  st.removedArtifacts ||= {};
  st.removedArtifacts[value] = files.filter((file) => !Object.hasOwn(after, file));
  if (!st.done.includes(value)) st.done.push(value);
  st.pendingDraft = null;
  st.writeApproval = null;
  const list = st.plan.modules || [];
  const next = list.find((item) => !st.done.includes(item));
  st.stage = next || '完成:' + (list.at(-1) || value);
  return writeWorkflow(name, st);
}

function explicitWriteConfirmation(text) {
  const value = String(text || '').trim();
  return value.length <= 80 && /^(?:确认(?:无误)?(?:，|,|。|\s)*(?:可以)?写入|可以写入|按(?:这|此)版写入|就按(?:这|此)版写入|写入吧)[！!。.]?$/.test(value);
}

// 打开工具时的引导开场白：用法 + 各模块一句话 + 重点讲世界书。
// 由模块清单实时生成，不另维护一份会过期的文案；只作为首条 pinned 消息展示，不写 jsonl。
function orientationText(track, displayName = '', profileConfirmed = false, personaName = '中性助手') {
  const lines = [];
  if (displayName) lines.push(displayName + '，你好，我是' + personaName + '，会陪你一起制作角色卡和世界卡。先花半分钟看这里怎么用：');
  else lines.push('你好，我是' + personaName + '，会陪你一起制作角色卡和世界卡。' + (profileConfirmed ? '' : '在开始前，我该怎么称呼你？也可以告诉我你的名字。') + '先花半分钟看这里怎么用：');
  lines.push('・左栏「制作流程」：点某一步＝把它切给我做，并展开这一步在做什么的概括；中间可为整张卡或单个模块新建对话。');
  lines.push('・中间对话：告诉我想写哪一部分，或把已有想法发来（Enter 发送，Shift+Enter 换行）。回复里的「前往」按钮能带你到对应制作步骤。');
  lines.push('・对话上方的「已保存内容」「写作参考」：点开查看已有正文或当前步骤的写法，用完可以收起；要改正文去「修改模式」的层次树。');
  lines.push('・设定先聊清楚，再给你看完整草稿；你确认后才保存。做好的卡还需要你在酒馆里实际试用。');
  if (track === '世界观卡') {
    lines.push('');
    lines.push('世界卡提醒：侧重世界观、具体运转规则、社会行为、普通人生活方式、阶层划分与资源分配；角色与 NPC 字段淡化甚至跳过，确需人物写触发式世界书条目即可。');
  }
  lines.push('');
  lines.push('本轨步骤（点左栏可展开概括）：');
  lines.push('・00-引导：聊清构思、判断卡类型、排好要走哪些步；只出规划不写正文。');
  trackModules(track).forEach((m) => {
    const label = m.stage.replace(/^[^/]+\//, '').replace(/-打包$/, '-生成成品');
    lines.push('・' + label + '：' + (moduleSummary(m.stage) || ''));
  });
  const opt = trackModules(track).filter((m) => m.need === '按需' || m.need === '建议').map((m) => m.stage.replace(/^[^/]+\//, ''));
  if (opt.length) lines.push('提示：' + opt.join('、') + ' 这些是按需 / 建议填写的——用不上就跳过、直接进质检；需要时再回来做。');
  lines.push('');
  if (track === '角色卡') lines.push('角色卡的重心：把一（或两三）个角色写活——人物画像给选择依据，按需世界书承接场景化侧面，MVU 记录变化，开场白给出第一幕。');
  lines.push('重点・确认后写入：每个模块先在对话中整理完整草稿；你明确确认后，' + personaName + '才会把设定写进世界书或其他 src 文件并检查。AI 示例、待定想法和未确认内容不会提前落盘。');
  lines.push('最后：检查通过、成品生成，不等于真机好用，界面与扩展效果请你在酒馆里验收。');
  return lines.join('\n');
}

function personaState() { return { activeId: readPersonaSelection(ROOT), personas: listPersonas(ROOT) }; }
function assertPersonasIdle() {
  if (codexBridge.status().queuedConversations.length || pendingChat().length) {
    throw Object.assign(new Error('还有回复正在处理，请等待完成或停止回复后再修改人设。'), { statusCode: 409 });
  }
}

const routes = {
  'GET /api/app-info': () => appInfo(),
  'GET /api/artifacts': (q, name) => artifactInfo(name, q.get('targetType')),
  'POST /api/artifacts-open': (q, name, body) => openArtifactDirectory(ROOT, name, body.targetType),
  'GET /api/ui-drafts': () => readUiDrafts(ROOT),
  'POST /api/ui-drafts': (q, name, body) => updateUiDrafts(ROOT, body),
  'GET /api/persona': () => personaState(),
  'POST /api/persona': (q, name, body) => { assertPersonasIdle(); writePersonaSelection(ROOT, body.id); return personaState(); },
  'POST /api/personas': (q, name, body) => { assertPersonasIdle(); const persona = savePersona(ROOT, body); return { ...personaState(), persona }; },
  'DELETE /api/personas': (q, name, body) => { assertPersonasIdle(); deletePersona(ROOT, body.id); return personaState(); },
  'GET /api/chat-avatars': () => readChatAvatars(ROOT),
  'POST /api/chat-avatar': (q, id, body) => {
    if (id === 'user' && process.env.XIAOXI_WORKBENCH === '1') throw new Error('请通过工作台用户设置更换你的头像。');
    return saveChatAvatar(ROOT, id, body);
  },
  'GET /api/conversations': (q, name) => {
    if (!name) throw new Error('请先选择一张卡');
    const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('目标卡片不存在');
    const state = conversations.list(name, { includeArchived: q.get('includeArchived') === '1' });
    const query = String(q.get('q') || '').trim();
    if (query.length > 120) throw new Error('搜索词最多 120 个字符');
    if (!query) return state;
    const needle = query.toLocaleLowerCase();
    const byConversation = new Map();
    for (const message of readChat()) {
      if (chatCardName(message) !== name) continue;
      const id = chatConversationId(message);
      if (!byConversation.has(id)) byConversation.set(id, []);
      byConversation.get(id).push(message);
    }
    assertWorkspacePath(ROOT, path.join(ROOT, 'work', 'chat-versions.json'));
    const matches = [];
    for (const conversation of state.conversations) {
      if (conversation.title.toLocaleLowerCase().includes(needle)) {
        matches.push({ ...conversation, match: { type: 'title', preview: conversation.title } });
        continue;
      }
      const selection = readChatVersionSelection(ROOT, name, conversation.id);
      const visible = chatDisplayHistory(byConversation.get(conversation.id) || [], selection);
      for (let index = visible.length - 1; index >= 0; index--) {
        const message = visible[index];
        if (message.pinned || message.pending || !['user', 'agent', 'assistant'].includes(message.role) || typeof message.text !== 'string') continue;
        const plain = message.text.replace(/\s+/g, ' ');
        const position = plain.toLocaleLowerCase().indexOf(needle);
        if (position < 0) continue;
        const start = Math.max(0, position - 45);
        const end = Math.min(plain.length, position + query.length + 100);
        matches.push({ ...conversation, match: { type: 'message', messageAt: message.at, role: message.role,
          preview: (start ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '') } });
        break;
      }
    }
    return { ...state, conversations: matches };
  },
  'POST /api/conversations': (q, name, body) => {
    if (!name) throw new Error('请先选择一张卡');
    const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('目标卡片不存在');
    if (Object.hasOwn(body, 'expectedActiveId') && conversations.list(name).activeId !== body.expectedActiveId) {
      throw Object.assign(new Error('当前选中的对话已变化，请核对后重试'), { statusCode: 409 });
    }
    if (body.action === 'select') {
      return conversations.select(name, String(body.id || ''));
    }
    if (body.action === 'create') {
      const module = String(body.module || '');
      const st = readWorkflow(name);
      const stages = ['00-引导'].concat(st?.plan?.modules || []);
      if (module && !stages.includes(module)) throw new Error('模块不属于当前卡的制作流程');
      return conversations.create(name, { title: body.title, module });
    }
    if (body.action === 'rename') {
      return conversations.rename(name, body.id, body.title, body.expectedTitle);
    }
    if (body.action === 'archive' || body.action === 'unarchive') {
      const conversation = conversations.get(name, body.id);
      if (body.action === 'archive' && !conversation.archivedAt) {
        const pending = pendingChat(name, conversation.id);
        if (chatActionsBusy(name, conversation.id, pending)) {
          throw Object.assign(new Error('这段对话还有回复正在处理，请等它完成或停止回复后再归档'), { statusCode: 409 });
        }
        if (pending.length) {
          throw Object.assign(new Error('这段对话还有待回复消息，请先打开它，点击「停止等待」后再归档'), { statusCode: 409 });
        }
      }
      return conversations.setArchived(name, body.id, body.action === 'archive', body.expectedArchivedAt);
    }
    throw new Error('未知对话操作');
  },
  'GET /api/chat': (q, name) => {
    const personaId = readPersonaSelection(ROOT);
    const conversationId = String(q.get('conversationId') || (name ? conversations.list(name).activeId : 'main'));
    const conversation = name ? conversations.get(name, conversationId) : null;
    const st = name ? readWorkflow(name) : null;
    const track = (st && st.plan && st.plan.cardType) || '角色卡';
    const scoped = readChat().filter((m) => name && chatCardName(m) === name && chatConversationId(m) === conversationId);
    const selection = readChatVersionSelection(ROOT, name, conversationId);
    const hist = chatDisplayHistory(scoped, selection).map((m) => {
      const t = m.at ? Date.parse(m.at) : 0;
      return Object.assign({}, m, { afterWrite: Number.isFinite(t) && t > LAST_SRC_WRITE });
    });
    const profile = readUserProfile(ROOT);
    const out = [{ role: 'agent', at: '', text: orientationText(track, profile.displayName, profile.confirmed, personaById(personaId, ROOT).name), personaId, pinned: true }].concat(hist);
    const cfg = llmStatus();
    const codexState = codexBridge.status();
    const pending = pendingChat(name, conversationId);
    const busy = pending.length > 0 || codexState.queuedConversations.includes(name + '::' + conversationId);
    const actionsBusy = chatActionsBusy(name, conversationId, pending, codexState);
    const contextRevision = name ? getChatContextRevision(ROOT, name, conversationId) : 0;
    for (const m of hist) {
      const actionable = !!m.at && ['user', 'agent', 'assistant'].includes(m.role)
        && !m.pinned && !m.pending && !(m.role === 'user' && m.retryOfAt);
      m.contextRevision = contextRevision;
      m.canDelete = !actionsBusy && actionable;
      m.canBranch = !actionsBusy && actionable && !m.error && typeof m.text === 'string' && !!m.text.trim();
    }
    for (const m of hist) m.canEdit = !busy && !!m.at && ['user', 'agent', 'assistant'].includes(m.role)
      && !m.pinned && !m.pending && !m.error && !(m.role === 'user' && m.retryOfAt);
    const lastReply = hist.filter((m) => ['agent', 'assistant'].includes(m.role) && !m.error).at(-1);
    if (lastReply && !busy && cfg.configured) {
      try { prepareScopedChatRetry(name, conversationId, scoped, lastReply.at, selection); lastReply.canRetry = true; } catch { /* 原提问缺失或未获回复时不提供旧轮重生成 */ }
    }
    const unansweredUser = hist.filter((m) => !m.pinned && !m.pending && !m.error && ['user', 'agent', 'assistant'].includes(m.role)).at(-1);
    if (name && unansweredUser?.role === 'user') {
      let blockedReason = chatResendBlockedReason(name, conversation, cfg, personaId, pending, codexState);
      if (!blockedReason) {
        try { prepareChatResend(scoped, { userAt: unansweredUser.at, expectedRevision: unansweredUser.editRevision || 0 }, selection); }
        catch (error) { blockedReason = error.message; }
      }
      unansweredUser.canResend = !blockedReason;
      unansweredUser.resendBlockedReason = blockedReason;
    }
    const task = name ? currentReplyTask(name, conversationId, pending, cfg, codexState) : null;
    if (task) out.push({ role: 'agent', at: '', text: replyTaskText(task), personaId: task.personaId || personaId, pending: true, task });
    return out;
  },
  'POST /api/chat': (q, name, body) => {
    const text = String(body.text || '');
    if (!text.trim()) throw new Error('空消息');
    if (text.length > 100000) throw new Error('消息过长');
    const conversationId = String(body.conversationId || (name ? conversations.list(name).activeId : 'main'));
    const conversation = requireUnarchivedConversation(name || LEGACY_CHAT_CARD, conversationId);
    const cfg = llmStatus();
    const personaId = personaById(body.personaId ?? readPersonaSelection(ROOT), ROOT).id;
    if (!cfg.configured) {
      throw Object.assign(new Error(!cfg.enabled
        ? '自动回复尚未启用，请在「接入设置」点击「保存并启用」后，再发送消息'
        : '当前后端配置不完整，请在「接入设置」补齐服务地址并保存后，再发送消息'), { requestAccepted: false });
    }
    if (cfg.enabled && cfg.backend === 'openai' && !bridgeProc) {
      throw new Error('外部端口回复服务已停止，请在「接入设置」重新启用并保存，或重新打开程序后，再发送消息');
    }
    if (cfg.enabled && cfg.backend === 'openai' && pendingChat(name || LEGACY_CHAT_CARD, conversationId).length) {
      throw new Error('请等上一条回复完成，再发送下一条消息。你仍可随时切换人设。');
    }
    let allowWrite = false;
    if (cfg.enabled && cfg.backend === 'codex') {
      if (!codexBridge.status().enabled) throw new Error('Codex 桥已停止，请在接入设置中重新启用');
      if (body.targetType !== 'card') throw new Error('Codex 写卡桥只接角色卡/世界卡；请切到「卡」并选中目标卡');
      if (!name) throw new Error('Codex 写卡桥需要先选中一张角色卡');
      codexBridge.validate(name);
      if (explicitWriteConfirmation(text)) {
        const st = readWorkflow(name);
        if (!st) throw new Error('这张卡还没有工作流进度，不能确认写入');
        const stage = conversation.module || st.stage;
        if (st.pendingDraft && (st.pendingDraft.personaId || 'xiaoxi') !== personaId && !st.pendingDraft.text) {
          throw new Error('这份旧草稿未保存完整正文，请切回原人设确认，或先让当前人设重新展示完整稿。');
        }
        writeWorkflow(name, approveWorkflowDraft(st, stage, conversationId, name));
        allowWrite = true;
      }
    }
    fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
    rememberDisplayName(ROOT, text);
    const history = readChat().filter((message) => chatCardName(message) === (name || LEGACY_CHAT_CARD) && chatConversationId(message) === conversationId);
    const effectiveStage = conversation?.module || (name && body.targetType === 'card' ? readWorkflow(name)?.stage : '') || '';
    const replyToAt = appendChatMessage('user', text, name, conversationId, personaId, { module: effectiveStage });
    if (cfg.enabled && cfg.backend === 'codex') {
      codexBridge.enqueue(name, text, cfg.codexModel, conversationId, effectiveStage, allowWrite, personaId, history, cfg.codexReasoningEffort, { replyToAt, codexProxyUrl: cfg.codexProxyUrl, codexProjectPath: cfg.codexProjectPath }).catch(() => {});
      return { ok: true, queued: true };
    }
    return { ok: true };
  },
  'POST /api/chat-stop': async (q, name, body) => {
    if (!name || body.targetType !== 'card') throw new Error('请先选择当前卡片，再停止回复');
    const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('目标卡片不存在');
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || typeof body.replyToAt !== 'string' || !body.replyToAt) throw new Error('请指定要停止的那一轮回复');
    conversations.get(name, conversationId);
    const pending = pendingChat(name, conversationId);
    const codexTasks = codexBridge.status().tasks;
    const codexTask = codexTasks.find((task) => task.cardName === name && task.conversationId === conversationId && task.replyToAt === body.replyToAt);
    const target = pending.find((message) => message.at === body.replyToAt);
    if (!target) {
      if (codexTask?.phase === 'stopping') {
        await codexBridge.cancel(name, conversationId, body.replyToAt);
        return { ok: true, closedPendingCount: 0, workflowInvalidated: false };
      }
      throw Object.assign(new Error('这轮回复已经结束或任务已变化，请刷新对话'), { statusCode: 409 });
    }
    const key = externalReplyKey(name, conversationId, body.replyToAt);
    const externalTask = externalReplyTasks.get(key);
    let tasks = [target];
    if (externalTask) tasks = pending.filter((message) => externalTask.replyToAts.includes(message.at));
    else if (!codexTask && llmStatus().backend !== 'codex') {
      if (pending.at(-1).at !== body.replyToAt) throw Object.assign(new Error('待回复消息已变化，请刷新后停止当前这轮'), { statusCode: 409 });
      tasks = pending;
    }
    const prepared = prepareChatTaskClose(ROOT, readRawChat(), { cardName: name, conversationId, tasks, advanceContext: false });
    const files = [[chatActionsFile(ROOT), JSON.stringify(prepared.data, null, 2) + '\n']];
    const st = readWorkflow(name, { migrate: false });
    let workflowInvalidated = false;
    const otherApprovedTask = codexTasks.some((task) => task.cardName === name && task.conversationId === conversationId
      && task.replyToAt !== body.replyToAt && task.allowWrite);
    if (st?.writeApproval?.conversationId === conversationId && !otherApprovedTask) {
      st.writeApproval = null; st.updatedAt = new Date().toISOString(); workflowInvalidated = true;
      files.push([workflowFile(name), JSON.stringify(st, null, 2) + '\n']);
    }
    // 先持久关闭身份，再中断运行；迟到成功和失败都无法重新落入对话。
    let partialAt = '';
    const partialTask = codexTask?.partialText ? codexTask : externalTask;
    if (partialTask?.partialText) {
      partialAt = new Date(Math.max(Date.now(), lastChatTimestamp + 1)).toISOString();
      const bytes = readRawChatBytes();
      const separator = bytes.length && bytes.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0);
      const partial = { role: 'agent', at: partialAt, text: '本次回复已停止，以下为未完成片段。', cardName: name,
        conversationId, personaId: partialTask.personaId, replyToAt: body.replyToAt, error: true, partialText: partialTask.partialText };
      files.push([CHAT_FILE, Buffer.concat([bytes, separator, Buffer.from(JSON.stringify(partial) + '\n', 'utf8')])]);
    }
    writeFilesAtomically(files);
    if (partialAt) lastChatTimestamp = Date.parse(partialAt);
    chatEvents.refresh(name, conversationId);
    endExternalReplyTask(key);
    await codexBridge.cancel(name, conversationId, body.replyToAt);
    if (bridgeProc?.connected) {
      try { bridgeProc.send({ type: 'cancel-reply', cardName: name, conversationId, replyToAt: body.replyToAt }, () => {}); } catch { /* 身份已关闭，迟到回写仍被拒绝 */ }
    }
    return { ok: true, closedPendingCount: prepared.closedPendingCount, workflowInvalidated };
  },
  'POST /api/chat-edit': (q, name, body) => {
    if (!name || body.targetType !== 'card') throw new Error('请先选择一张角色卡或世界卡，再编辑消息');
    const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('目标卡片不存在');
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new Error('请指定消息所属对话');
    requireUnarchivedConversation(name, conversationId);
    if (pendingChat(name, conversationId).length || codexBridge.status().queuedConversations.includes(name + '::' + conversationId)) {
      throw Object.assign(new Error('当前对话还有待回复消息，回复完成后才能编辑'), { statusCode: 409 });
    }
    const raw = readRawChat().filter((m) => chatCardName(m) === name && chatConversationId(m) === conversationId);
    const history = applyChatDeletions(ROOT, applyChatEdits(ROOT, raw));
    const selection = readChatVersionSelection(ROOT, name, conversationId);
    const visible = chatDisplayHistory(history, selection).some((m) => m.at === body.messageAt && m.role === body.role);
    if (!visible) throw Object.assign(new Error('这条消息不是当前显示的版本，请刷新对话后重试'), { statusCode: 409 });
    const prepared = prepareChatEdit(ROOT, raw, { cardName: name, conversationId, messageAt: body.messageAt,
      role: body.role, text: body.text, expectedRevision: body.expectedRevision });
    let workflowInvalidated = false;
    if (prepared.changed) {
      const st = readWorkflow(name, { migrate: false });
      const files = [[chatEditsFile(ROOT), JSON.stringify(prepared.data, null, 2) + '\n']];
      if (st) {
        if (st.pendingDraft?.conversationId === conversationId) { st.pendingDraft = null; workflowInvalidated = true; }
        if (st.writeApproval?.conversationId === conversationId) { st.writeApproval = null; workflowInvalidated = true; }
        if (workflowInvalidated) {
          st.updatedAt = new Date().toISOString();
          files.push([workflowFile(name), JSON.stringify(st, null, 2) + '\n']);
        }
      }
      writeFilesAtomically(files);
    }
    return { ok: true, changed: prepared.changed, revision: prepared.revision, editedAt: prepared.editedAt,
      contextRevision: getChatContextRevision(ROOT, name, conversationId), workflowInvalidated };
  },
  'POST /api/chat-delete': (q, name, body) => {
    const scope = chatActionScope(name, body);
    const prepared = prepareChatDeletion(ROOT, scope.raw, scope.selection, {
      ...body, cardName: name, conversationId: scope.conversationId, closePending: scope.pending,
    });
    let workflowInvalidated = false;
    if (prepared.changed) {
      const files = [
        [chatActionsFile(ROOT), JSON.stringify(prepared.data, null, 2) + '\n'],
        [chatEditsFile(ROOT), JSON.stringify(prepared.contextData, null, 2) + '\n'],
      ];
      const st = readWorkflow(name, { migrate: false });
      if (st) {
        if (st.pendingDraft?.conversationId === scope.conversationId) { st.pendingDraft = null; workflowInvalidated = true; }
        if (st.writeApproval?.conversationId === scope.conversationId) { st.writeApproval = null; workflowInvalidated = true; }
        if (workflowInvalidated) {
          st.updatedAt = new Date().toISOString();
          files.push([workflowFile(name), JSON.stringify(st, null, 2) + '\n']);
        }
      }
      writeFilesAtomically(files);
    }
    return { ok: true, deletedCount: prepared.deletedCount, messageCount: prepared.messageCount, operationId: prepared.operationId,
      workflowInvalidated, closedPendingCount: prepared.closedPendingCount };
  },
  'GET /api/chat-deleted': (q, name) => {
    if (!name) throw new Error('请先选择一张角色卡或世界卡');
    const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error('目标卡片不存在');
    assertWorkspacePath(ROOT, path.join(ROOT, 'work', 'conversations.json'));
    const conversationId = String(q.get('conversationId') || conversations.list(name).activeId);
    conversations.get(name, conversationId);
    return { items: listChatDeletions(ROOT, readRawChat(), { cardName: name, conversationId }) };
  },
  'POST /api/chat-restore': (q, name, body) => {
    const scope = chatActionScope(name, body);
    const prepared = prepareChatRestoration(ROOT, scope.raw, {
      ...body, cardName: name, conversationId: scope.conversationId, closePending: scope.pending,
    });
    let workflowInvalidated = false;
    if (prepared.changed) {
      const files = [
        [chatActionsFile(ROOT), JSON.stringify(prepared.data, null, 2) + '\n'],
        [chatEditsFile(ROOT), JSON.stringify(prepared.contextData, null, 2) + '\n'],
      ];
      const st = readWorkflow(name, { migrate: false });
      if (st) {
        if (st.pendingDraft?.conversationId === scope.conversationId) { st.pendingDraft = null; workflowInvalidated = true; }
        if (st.writeApproval?.conversationId === scope.conversationId) { st.writeApproval = null; workflowInvalidated = true; }
        if (workflowInvalidated) {
          st.updatedAt = new Date().toISOString();
          files.push([workflowFile(name), JSON.stringify(st, null, 2) + '\n']);
        }
      }
      writeFilesAtomically(files);
    }
    return { ok: true, restoredCount: prepared.restoredCount, alreadyRestored: prepared.alreadyRestored,
      workflowInvalidated, closedPendingCount: prepared.closedPendingCount };
  },
  'POST /api/chat-branch': (q, name, body) => {
    const scope = chatActionScope(name, body);
    const conversation = conversations.prepareCreate(name, { title: body.title, module: scope.conversation.module, activate: false,
      origin: { conversationId: scope.conversationId, title: scope.conversation.title, messageAt: body.messageAt, role: body.role } });
    const prepared = prepareChatBranch(ROOT, scope.raw, scope.selection, {
      ...body, cardName: name, conversationId: scope.conversationId, newConversationId: conversation.item.id,
    });
    const appended = Buffer.from(prepared.messages.map((message) => JSON.stringify(message)).join('\n') + '\n', 'utf8');
    const separator = scope.bytes.length && scope.bytes.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0);
    writeFilesAtomically([
      [conversation.file, JSON.stringify(conversation.data, null, 2) + '\n'],
      [CHAT_FILE, Buffer.concat([scope.bytes, separator, appended])],
    ]);
    return { ok: true, conversationId: conversation.item.id, copiedCount: prepared.messages.length, ...conversation.state };
  },
  'POST /api/chat-resend': (q, name, body) => {
    const scope = chatActionScope(name, body);
    const conversationId = scope.conversationId;
    const cfg = llmStatus();
    const personaId = personaById(body.personaId ?? readPersonaSelection(ROOT), ROOT).id;
    const codexState = codexBridge.status();
    const blockedReason = chatResendBlockedReason(name, scope.conversation, cfg, personaId, scope.pending, codexState);
    if (blockedReason) throw Object.assign(new Error(blockedReason), { statusCode: 409 });
    if (!Number.isSafeInteger(body.contextRevision) || body.contextRevision < 0) throw new Error('重新发送的对话版本不完整');
    if (body.contextRevision !== getChatContextRevision(ROOT, name, conversationId)) {
      throw Object.assign(new Error('对话已变化，或这次重新发送已提交，请刷新后查看当前状态'), { statusCode: 409 });
    }
    if (cfg.backend === 'codex') codexBridge.validate(name);
    const raw = scope.raw.filter((message) => chatCardName(message) === name && chatConversationId(message) === conversationId);
    if (raw.filter((message) => message.role === 'user' && message.at === body.userAt).length !== 1) {
      throw Object.assign(new Error('原提问不存在或身份重复，请刷新对话后重试'), { statusCode: 409 });
    }
    const history = applyChatDeletions(ROOT, applyChatEdits(ROOT, raw));
    const retry = prepareChatResend(history, body, scope.selection);
    const st = readWorkflow(name, { migrate: false });
    const stage = scope.conversation.module || retry.sourceUser.module || st?.stage || '';
    const context = prepareChatContextAdvance(ROOT, name, conversationId);
    const files = [[chatEditsFile(ROOT), JSON.stringify(context.data, null, 2) + '\n']];
    let workflowInvalidated = false;
    if (st) {
      if (st.pendingDraft?.conversationId === conversationId) { st.pendingDraft = null; workflowInvalidated = true; }
      if (st.writeApproval?.conversationId === conversationId) { st.writeApproval = null; workflowInvalidated = true; }
      if (workflowInvalidated) {
        st.updatedAt = new Date().toISOString();
        files.push([workflowFile(name), JSON.stringify(st, null, 2) + '\n']);
      }
    }
    let timestamp = Math.max(Date.now(), lastChatTimestamp + 1);
    const timestamps = new Set(raw.map((message) => message.at));
    while (timestamps.has(new Date(timestamp).toISOString())) timestamp++;
    const replyToAt = new Date(timestamp).toISOString();
    const options = { retryOfAt: retry.retryOfAt, retrySourceUserAt: retry.retrySourceUserAt, replyToAt, module: stage };
    const request = { role: 'user', at: replyToAt, text: retry.sourceUser.text, cardName: name, conversationId, personaId, personaName: personaById(personaId, ROOT).name,
      retryOfAt: retry.retryOfAt, retrySourceUserAt: retry.retrySourceUserAt, module: stage };
    const separator = scope.bytes.length && scope.bytes.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0);
    files.push([CHAT_FILE, Buffer.concat([scope.bytes, separator, Buffer.from(JSON.stringify(request) + '\n', 'utf8')])]);
    // 先原子保存新请求和失效标记；旧请求的关闭身份及原始记录始终不变。
    writeFilesAtomically(files);
    lastChatTimestamp = timestamp;
    if (cfg.backend === 'codex') {
      codexBridge.enqueue(name, retry.sourceUser.text, cfg.codexModel, conversationId, stage, false, personaId,
        retry.historyBeforeUser, cfg.codexReasoningEffort, { ...options, codexProxyUrl: cfg.codexProxyUrl, codexProjectPath: cfg.codexProjectPath }).catch(() => {});
    }
    return { ok: true, queued: true, replyToAt, contextRevision: context.revision, workflowInvalidated };
  },
  'POST /api/chat-retry': (q, name, body) => {
    if (!name || body.targetType !== 'card') throw new Error('请先选择一张角色卡或世界卡，再重新回复');
    const conversationId = String(body.conversationId || conversations.list(name).activeId);
    const conversation = requireUnarchivedConversation(name, conversationId);
    const cfg = llmStatus();
    if (!cfg.configured) throw new Error('请在接入设置中启用自动回复并补齐配置，再重新回复');
    if (cfg.backend === 'openai' && !bridgeProc) throw new Error('外部回复服务已停止，请重新启用接入设置');
    const codexState = codexBridge.status();
    if (pendingChat(name, conversationId).length || codexState.queuedConversations.includes(name + '::' + conversationId)) throw new Error('当前对话还有回复正在处理，请等它完成');
    if (cfg.backend === 'codex') {
      if (!codexState.enabled) throw new Error('Codex 桥已停止，请重新启用接入设置');
      codexBridge.validate(name);
    }
    const history = readChat().filter((m) => chatCardName(m) === name && chatConversationId(m) === conversationId);
    const selection = readChatVersionSelection(ROOT, name, conversationId);
    const retry = prepareScopedChatRetry(name, conversationId, history, String(body.replyAt || ''), selection);
    try { personaById(retry.personaId, ROOT); }
    catch (error) { if (error.statusCode === 404) throw new Error('原回复的人设已删除。请先选择现有人设，再将原问题作为新消息发送。'); throw error; }
    const st = readWorkflow(name);
    const stage = retry.target.module || conversation.module || st?.stage || '';
    if (st) {
      let changed = false;
      if (st.pendingDraft?.conversationId === conversationId && st.pendingDraft.stage === stage) { st.pendingDraft = null; changed = true; }
      if (st.writeApproval?.conversationId === conversationId && st.writeApproval.stage === stage) { st.writeApproval = null; changed = true; }
      if (changed) writeWorkflow(name, st);
    }
    const options = { retryOfAt: retry.retryOfAt, retrySourceUserAt: retry.retrySourceUserAt, module: stage };
    options.replyToAt = appendChatMessage('user', retry.sourceUser.text, name, conversationId, retry.personaId, options);
    if (cfg.backend === 'codex') {
      codexBridge.enqueue(name, retry.sourceUser.text, cfg.codexModel, conversationId, stage, false, retry.personaId, retry.historyBeforeUser, cfg.codexReasoningEffort, { ...options, codexProxyUrl: cfg.codexProxyUrl, codexProjectPath: cfg.codexProjectPath }).catch(() => {});
    }
    return { ok: true, queued: true };
  },
  'POST /api/chat-version': (q, name, body) => {
    if (!name) throw new Error('请先选择一张卡');
    const conversationId = String(body.conversationId || conversations.list(name).activeId);
    const conversation = requireUnarchivedConversation(name, conversationId);
    if (pendingChat(name, conversationId).length || codexBridge.status().queuedConversations.includes(name + '::' + conversationId)) throw new Error('回复还在处理中，完成后才能切换版本');
    const history = readChat().filter((m) => chatCardName(m) === name && chatConversationId(m) === conversationId);
    const selection = readChatVersionSelection(ROOT, name, conversationId);
    const group = chatDisplayHistory(history, selection).find((m) => m.rootReplyAt === String(body.rootReplyAt || ''));
    const versionAt = String(body.versionAt || '');
    const version = group && (group.versions || []).find((item) => item.at === versionAt);
    if (!version) throw new Error('这个回复版本不存在，请刷新对话');
    writeChatVersionSelection(ROOT, name, conversationId, { rootReplyAt: group.rootReplyAt, versionAt, latestAt: group.latestVersionAt });
    const st = readWorkflow(name);
    const effectiveStage = conversation.module || st?.stage || '';
    const draftSelected = !!(st && ((!version.editRevision && version.draftReady) || (st.pendingDraft?.conversationId === conversationId && st.pendingDraft.text === version.text)) && (version.module || st.pendingDraft?.stage || effectiveStage) === effectiveStage);
    if (st && (st.pendingDraft?.conversationId === conversationId || st.writeApproval?.conversationId === conversationId)) {
      if (st.pendingDraft?.conversationId === conversationId) st.pendingDraft = null;
      if (st.writeApproval?.conversationId === conversationId) st.writeApproval = null;
      writeWorkflow(name, st);
    }
    if (draftSelected) writeWorkflow(name, markWorkflowDraft(st, effectiveStage, conversationId, version.text, version.personaId || 'xiaoxi', version.personaName));
    return { ok: true, draftSelected };
  },
  // ---- 桥接路由：接入配置与 OpenAI 兼容回复服务 ----
  'GET /api/bridge': (q, name) => {
    if (name === 'pending') {
      const { displayName, identity = '', preferences = '', confirmed } = readUserProfile(ROOT);
      return { pending: pendingChat(), userProfile: { displayName, identity, preferences, confirmed } };
    }
    if (name === 'llm-status') return Object.assign(llmStatus(), bridgeStatus(), { codex: codexBridge.status() });
    if (name === 'bridge-status') return Object.assign(bridgeStatus(), { codex: codexBridge.status() });
    if (name === 'codex-status') return getCodexCliStatus();
    if (name === 'codex-models') return getCodexModels();
    if (name === 'detect') return detectLocalModels();
    throw new Error('未知桥接动作: ' + name);
  },
  'POST /api/bridge': (q, name, body) => {
    if (name === 'llm-config') return writeLlmCfg(body || {});
    if (name === 'bridge-start') {
      return writeLlmCfg({ ...llmStatus(), enabled: true });
    }
    if (name === 'bridge-stop') {
      return writeLlmCfg({ ...llmStatus(), enabled: false });
    }
    if (['task-start', 'task-state', 'task-finish', 'tool'].includes(name)) {
      const { cardName, conversationId, replyToAt } = body;
      if ([cardName, conversationId, replyToAt].some((value) => typeof value !== 'string' || !value)) throw new Error('回复任务身份不完整');
      conversations.get(cardName, conversationId);
      const key = externalReplyKey(cardName, conversationId, replyToAt);
      const task = externalReplyTasks.get(key);
      if (name === 'task-finish') {
        if (task && task.claimId !== body.claimId) throw Object.assign(new Error('回复任务已变化'), { statusCode: 409 });
        endExternalReplyTask(key);
        chatEvents.refresh(cardName, conversationId);
        return { ok: true };
      }
      const pending = pendingChat(cardName, conversationId);
      if (name === 'task-start') {
        const cfg = llmStatus();
        if (body.backend !== 'openai' || cfg.backend !== 'openai' || !cfg.configured) throw Object.assign(new Error('外部回复接入已停止或变化'), { statusCode: 409 });
        if (pending.at(-1)?.at !== replyToAt || task) throw Object.assign(new Error('回复任务已关闭、变化或已被领取'), { statusCode: 409 });
        const target = pending.at(-1);
        const claimId = randomUUID();
        const startedAt = new Date().toISOString();
        const tools = fs.existsSync(path.join(cardDir(cardName), 'src')) ? CARD_TOOLS.filter(tool => !target.retryOfAt || tool.function.name === 'read_card') : [];
        const claimed = { cardName, conversationId, replyToAt, claimId, taskId: randomUUID(), tools, generations: new Map(), toolResults: new Map(), toolOutcomes: [],
          replyToAts: pending.map((message) => message.at), backend: 'openai', phase: 'preparing', round: 1,
          partialText: '', previewRevision: 1, activityRevision: 0, lastActivityAt: startedAt,
          queuedAt: target.at, startedAt, personaId: target.personaId || 'xiaoxi' };
        externalReplyTasks.set(key, claimed);
        chatEvents.publish(publicExternalReplyTask(claimed));
        return { ok: true, claimId, tools };
      }
      if (!task || !body.claimId || task.claimId !== body.claimId || !pending.some((message) => message.at === replyToAt)) {
        throw Object.assign(new Error('这轮回复已停止或任务已变化'), { statusCode: 409 });
      }
      if (name === 'tool') {
        requireUnarchivedConversation(cardName, conversationId);
        const target = pending.at(-1);
        if (target?.at !== replyToAt) throw Object.assign(new Error('当前提问已变化'), { statusCode: 409 });
        if (typeof body.callId !== 'string' || !body.callId || body.callId.length > 200) throw new Error('工具调用 ID 无效');
        const signature = JSON.stringify([body.tool, body.args]);
        const cached = task.toolResults.get(body.callId);
        if (cached) {
          if (cached.signature !== signature) throw new Error('同一工具调用 ID 的参数已变化');
          return cached.result;
        }
        if (task.toolResults.size >= 40) throw new Error('本轮工具执行次数超过上限');
        const result = executeCardTool(task, target, body.tool, body.args);
        task.toolResults.set(body.callId, { signature, result });
        return result;
      }
      if (body.phase !== undefined) {
        if (!['waiting-model','starting','thinking','reading','running-tool','generating','reconnecting','finalizing'].includes(body.phase)) throw new Error('回复阶段不正确');
      }
      if (body.round !== undefined) {
        if (!Number.isInteger(body.round) || body.round < 1 || body.round > 13) throw new Error('回复步骤不正确');
      }
      if (body.partialText !== undefined && (typeof body.partialText !== 'string' || body.partialText.length > 100000)) throw new Error('回复片段必须是不超过 100000 字的正文');
      if (body.activityRevision !== undefined && (!Number.isSafeInteger(body.activityRevision) || body.activityRevision < 0)) throw new Error('回复活动版本不正确');
      // 空状态只是桥的存活核对；只有递增活动版本可以延长模型/工具的真实活动时间。
      if (body.activityRevision !== undefined && body.activityRevision < task.activityRevision) return { ok: true };
      if (body.round !== undefined && body.round < task.round) throw new Error('回复步骤不能回退');
      const hasActivity = body.activityRevision !== undefined && body.activityRevision > task.activityRevision;
      if (body.partialText !== undefined && body.partialText !== task.partialText && !hasActivity) throw new Error('正文片段更新需要新的活动版本');
      const next = { phase: body.phase ?? task.phase, round: body.round ?? task.round, partialText: body.partialText ?? task.partialText };
      const changed = Object.keys(next).some((key) => task[key] !== next[key]);
      if (changed || hasActivity) {
        Object.assign(task, next);
        if (hasActivity) { task.activityRevision = body.activityRevision; task.lastActivityAt = new Date().toISOString(); }
        task.previewRevision++;
        chatEvents.publish(publicExternalReplyTask(task));
      }
      return { ok: true };
    }
    if (name !== 'reply') throw new Error('未知桥接动作: ' + name);
    let text = String(body.text || '');
    if (!text.trim()) throw new Error('空回复');
    if (text.length > 100000) throw new Error('回复过长');
    if ((!body.cardName || !body.conversationId || !body.replyToAt) && Object.keys(readChatActionData(ROOT).closedTasks).length) {
      throw Object.assign(new Error('已有停止或关闭的任务，回写必须携带 cardName、conversationId 和 replyToAt，避免把迟到答复写入其他对话'), { statusCode: 409 });
    }
    fs.mkdirSync(path.join(ROOT, 'work'), { recursive: true });
    const fallback = pendingChat().at(-1);
    const cardName = String(body.cardName || (fallback && chatCardName(fallback)) || '');
    const conversationId = String(body.conversationId || (fallback && cardName === chatCardName(fallback) ? chatConversationId(fallback) : 'main'));
    const pendingMessages = pendingChat(cardName, conversationId);
    const pending = pendingMessages.at(-1);
    if (!pending) throw new Error('当前对话没有待回复消息');
    if (!body.replyToAt) {
      const hasClosedTask = Object.keys(readChatActionData(ROOT).closedTasks).some((key) => {
        const parts = JSON.parse(key);
        return parts[0] === cardName && parts[1] === conversationId;
      });
      if (hasClosedTask) throw Object.assign(new Error('当前对话曾停止任务，回写必须携带读取到的 replyToAt，避免把旧答复写到新提问'), { statusCode: 409 });
    }
    if (body.replyToAt && body.replyToAt !== pending.at) throw Object.assign(new Error('待回复消息已变化，请重新读取后回复'), { statusCode: 409 });
    const key = externalReplyKey(cardName, conversationId, pending.at);
    const task = externalReplyTasks.get(key);
    if ((task || body.claimId) && (!task || task.claimId !== body.claimId)) throw Object.assign(new Error('这轮回复已停止或领取记录已变化'), { statusCode: 409 });
    if (codexBridge.status().tasks.some((item) => item.cardName === cardName && item.conversationId === conversationId && item.replyToAt === pending.at)) {
      throw Object.assign(new Error('这轮回复正在由 Codex 处理，不能由外部桥覆盖'), { statusCode: 409 });
    }
    if (cardName) conversations.get(cardName, conversationId);
    const personaId = pending.personaId || 'xiaoxi';
    if (body.personaId && body.personaId !== personaId) throw new Error('回复人设与待回复消息不一致');
    if (task?.toolOutcomes.length) text += '\n\n' + task.toolOutcomes.join('\n');
    if (task?.proposal && !body.error) text += '\n\n' + proposalText(task.proposal);
    const at = appendChatMessage('agent', text, cardName, conversationId, personaId, { retryOfAt: pending.retryOfAt, retrySourceUserAt: pending.retrySourceUserAt,
      replyToAt: pending.at, replyToAts: task?.replyToAts || pendingMessages.map((message) => message.at), module: pending.module, personaName: pending.personaName,
      error: !!body.error, partialText: body.error ? task?.partialText : undefined });
    if (task?.proposal && !body.error) {
      const file = cardProposalFile(cardName, conversationId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeText(file, JSON.stringify({ ...task.proposal, shownAt: at, shownHash: createHash('sha256').update(text).digest('hex') }, null, 2) + '\n');
    }
    endExternalReplyTask(key);
    if (pending.retryOfAt && !body.error) selectNewRetryVersion(cardName, conversationId, at);
    return { ok: true };
  },
  'GET /api/presets': () => listPresets(),
  'GET /api/preset': (q, name) => presetTree(name),
  'GET /api/preset-preview': (q, name) => ({ card: loadPreset(path.join(ROOT, 'presets', safeName(name))) }),
  'POST /api/preset-import': (q, name, body) => {
    const tmp = path.join(os.tmpdir(), 'xiaoxi-preset-' + Date.now() + '.json');
    fs.writeFileSync(tmp, Buffer.from(body.base64, 'base64'));
    try {
      return { dir: importPreset(tmp, body.name || undefined) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
  'POST /api/preset-check': (q, name) => checkPreset(name),
  'POST /api/preset-build': (q, name) => ({ out: buildPreset(name), artifacts: listArtifactFiles(ROOT, name, 'preset') }),
  'POST /api/preset-save': (q, name, body) => {
    LAST_SRC_WRITE = Date.now();
    const src = assertWorkspacePath(ROOT, path.join(ROOT, 'presets', safeName(name), 'src'));
    switch (body.kind) {
      case 'index':
        parseYaml(body.content);
        writeText(path.join(src, 'index.yaml'), body.content);
        break;
      case 'extra':
        if (body.content.trim()) JSON.parse(body.content);
        writeText(path.join(src, 'extra.json'), body.content);
        break;
      case 'order':
        JSON.parse(body.content);
        writeText(path.join(src, 'order.json'), body.content);
        break;
      case 'prompt': {
        const yml = assertPromptBase(name, body.base);
        const md = yml.slice(0, -5) + '.md';
        writeText(md, body.content);
        break;
      }
      case 'prompt-side': {
        const yml = assertPromptBase(name, body.base);
        parseYaml(body.content);
        writeText(yml, body.content);
        break;
      }
      case 'prompt-pair': {
        const yml = assertPromptBase(name, body.base);
        return saveEntryPair(yml.slice(0, -5) + '.md', yml, body.content, body.side);
      }
      default:
        throw new Error('非法保存类型: ' + body.kind);
    }
    return { ok: true };
  },
  'GET /api/worldbooks': () => listWorldbooks(),
  'GET /api/worldbook': (q, name) => bookTree(name),
  'GET /api/worldbook-preview': (q, name) => ({ card: loadWorldbook(path.join(ROOT, 'worldbooks', safeName(name))) }),
  'POST /api/worldbook-import': (q, name, body) => {
    const tmp = path.join(os.tmpdir(), 'xiaoxi-book-' + Date.now() + '.json');
    fs.writeFileSync(tmp, Buffer.from(body.base64, 'base64'));
    try {
      return { dir: importWorldbook(tmp, body.name || undefined) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
  'POST /api/worldbook-check': (q, name) => checkWorldbook(name),
  'POST /api/worldbook-build': (q, name) => ({ out: buildWorldbook(name), artifacts: listArtifactFiles(ROOT, name, 'book') }),
  'POST /api/worldbook-save': (q, name, body) => {
    LAST_SRC_WRITE = Date.now();
    const src = assertWorkspacePath(ROOT, path.join(ROOT, 'worldbooks', safeName(name), 'src'));
    switch (body.kind) {
      case 'index':
        parseYaml(body.content);
        writeText(path.join(src, 'index.yaml'), body.content);
        break;
      case 'extra':
        if (body.content.trim()) JSON.parse(body.content);
        writeText(path.join(src, 'extra.json'), body.content);
        break;
      case 'entry': {
        const yml = assertBookEntryBase(name, body.base);
        writeText(yml.slice(0, -5) + '.md', body.content);
        break;
      }
      case 'entry-side': {
        const yml = assertBookEntryBase(name, body.base);
        parseYaml(body.content);
        writeText(yml, body.content);
        break;
      }
      case 'entry-pair': {
        const yml = assertBookEntryBase(name, body.base);
        return saveEntryPair(yml.slice(0, -5) + '.md', yml, body.content, body.side);
      }
      default:
        throw new Error('非法保存类型: ' + body.kind);
    }
    return { ok: true };
  },
  'GET /api/cards': () => cmdList().map((row) => {
    try { return { ...row, cardType: readWorkflow(row.name)?.plan?.cardType || '角色卡' }; }
    catch (error) { return { ...row, cardType: '角色卡', warning: [row.warning, error.message].filter(Boolean).join('；') }; }
  }),
  'GET /api/card': (q, name) => cardTree(name),
  'GET /api/workflow': (q, name) => {
    const st = readWorkflow(name);
    const track = (st && st.plan && st.plan.cardType) || '';
    const stage = (st && st.stage) || '00-引导';
    return {
      state: st,
      tracks: listTracks(),
      track,
      stage,
      modules: track ? trackModules(track).map((m) => ({ stage: m.stage, need: m.need, summary: moduleSummary(m.stage) })) : [],
      leadSummary: moduleSummary('00-引导'),
      moduleMd: stage.startsWith('完成:') ? '' : readModule(stage),
    };
  },
  'GET /api/workflow-guide': (q, name) => {
    if (!name) throw new Error('请先选择一张卡');
    const st = readWorkflow(name);
    const track = (st && st.plan && st.plan.cardType) || '';
    const stage = assertStage(q.get('stage') || (st && st.stage) || '00-引导');
    const allowed = stage === '00-引导' || trackModules(track).some((m) => m.stage === stage);
    if (!allowed) throw new Error('当前卡类型没有这个模块: ' + stage);
    return { stage, ...readCreatorGuide(stage), summary: moduleSummary(stage) };
  },
  'POST /api/workflow': (q, name, body) => {
    const action = String(body.action || '');
    if (action === 'init') {
      const track = String(body.cardType || '');
      if (!SEG_RE.test(track) || !trackModules(track).length) throw new Error('该轨道没有可用模块: ' + track);
      return writeWorkflow(name, blankWorkflow(track));
    }
    if (action === 'initIfMissing') {
      const exist = readWorkflow(name);
      if (exist) return exist;
      const track = String(body.cardType || '');
      if (!SEG_RE.test(track) || !trackModules(track).length) throw new Error('该轨道没有可用模块: ' + track);
      return writeWorkflow(name, blankWorkflow(track));
    }
    const st = readWorkflow(name);
    if (!st) throw new Error('这张卡还没有工作流进度，请先选卡类型并初始化');
    if (action === 'goto') { st.stage = assertWorkflowStage(st, body.stage); return writeWorkflow(name, st); }
    if (action === 'toggle') {
      const s = assertWorkflowStage(st, body.stage);
      if (!st.done.includes(s)) throw new Error('未确认模块不能直接标记完成');
      st.done = st.done.filter((x) => x !== s);
      delete st.artifacts[s];
      if (st.removedArtifacts) delete st.removedArtifacts[s];
      return writeWorkflow(name, st);
    }
    if (action === 'advance') throw new Error('请通过待确认稿、明确确认和产物检查完成模块');
    if (action === 'plan') {
      for (const k of ['concept', 'worldview', 'outline']) {
        if (typeof body[k] === 'string') st.plan[k] = body[k].slice(0, 20000);
      }
      if (body.modules != null) {
        if (!Array.isArray(body.modules)) throw new Error('modules 必须是数组');
        const allowed = new Set(trackModules(st.plan.cardType).map((item) => item.stage));
        const modules = [...new Set(body.modules.map((item) => assertStage(item)))];
        if (!modules.length || modules.some((item) => !allowed.has(item))) throw new Error('modules 含当前轨道不存在的模块');
        st.plan.modules = modules;
        st.done = st.done.filter((item) => item === '00-引导' || modules.includes(item));
        st.artifacts = Object.fromEntries(Object.entries(st.artifacts).filter(([key]) => key === '00-引导' || modules.includes(key)));
        if (st.removedArtifacts) st.removedArtifacts = Object.fromEntries(Object.entries(st.removedArtifacts).filter(([key]) => key === '00-引导' || modules.includes(key)));
        if (st.stage !== '00-引导' && !modules.includes(st.stage)) st.stage = modules.find((item) => !st.done.includes(item)) || '完成:' + modules.at(-1);
        if (st.pendingDraft && !modules.includes(st.pendingDraft.stage)) st.pendingDraft = null;
        if (st.writeApproval && !modules.includes(st.writeApproval.stage)) st.writeApproval = null;
      }
      return writeWorkflow(name, st);
    }
    if (action === 'draft') return writeWorkflow(name, markWorkflowDraft(st, body.stage, body.conversationId, body.text, body.personaId || readPersonaSelection(ROOT)));
    if (action === 'approve') return writeWorkflow(name, approveWorkflowDraft(st, body.stage, body.conversationId, name));
    if (action === 'complete') return completeWorkflowStage(name, st, body.stage, body.conversationId, body.artifacts || []);
    throw new Error('未知操作: ' + action);
  },
  'GET /api/preview': (q, name) => {
    const card = loadCard(cardDir(name));
    const chars = JSON.stringify(card).length;
    return { card, chars };
  },
  'POST /api/new': (q, name, body) => ({ dir: cmdNew(body.name) }),
  'POST /api/import': (q, name, body) => {
    const tmp = path.join(os.tmpdir(), 'xiaoxi-import-' + Date.now() + (body.fileName.toLowerCase().endsWith('.png') ? '.png' : '.json'));
    fs.writeFileSync(tmp, Buffer.from(body.base64, 'base64'));
    try {
      return { dir: cmdImport(tmp, body.name || undefined) };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
  'POST /api/check': (q, name) => cmdCheck(name),
  'POST /api/build': (q, name) => ({ out: cmdBuild(name), artifacts: listArtifactFiles(ROOT, name, 'card') }),
  'GET /api/diagnose': (q, name) => cmdDiagnose(name),
  'POST /api/mvu': (q, name, body) => {
    let def = DEMO_DEF;
    if (body && body.def && String(body.def).trim()) def = JSON.parse(body.def);
    return generateMvuBundle(def);
  },
  'POST /api/ejs': (q, name, body) => {
    const req = (body && body.def) ? JSON.parse(body.def) : {};
    const controller = generateEjsController(req.controller || DEMO_CONTROLLER);
    const statusbar = generateEjsStatusBar({ varName: req.varName || 'stat_data', title: req.title || '状态', groups: req.groups || DEMO_STATUSBAR.groups });
    return { controller, statusbar };
  },
  'POST /api/save': (q, name, body) => {
    LAST_SRC_WRITE = Date.now();
    const src = assertWorkspacePath(ROOT, path.join(cardDir(name), 'src'));
    const write = writeText;
    switch (body.kind) {
      case 'text':
        if (!TEXT_FIELDS.includes(body.key)) throw new Error('非法字段: ' + body.key);
        write(path.join(src, 'text', body.key + '.md'), body.content);
        break;
      case 'index':
        parseYaml(body.content);
        write(path.join(src, 'index.yaml'), body.content);
        break;
      case 'extra':
        if (body.content.trim()) JSON.parse(body.content);
        write(path.join(src, 'extra.json'), body.content);
        break;
      case 'note':
        write(path.join(cardDir(name), '创作说明.md'), body.content);
        break;
      case 'greeting':
        write(assertGreetingFile(name, body.key), body.content);
        break;
      case 'greeting-new': {
        const gdir = assertWorkspacePath(ROOT, path.join(src, 'greetings'));
        fs.mkdirSync(gdir, { recursive: true });
        const file = nextEntryBase(gdir, '备选开场', ['.md']) + '.md';
        write(path.join(gdir, file), body.content || '');
        return { file };
      }
      case 'entry':
        write(assertEntryBase(name, body.book, body.base), body.content);
        break;
      case 'entry-side': {
        const file = assertEntryBase(name, body.book, body.base);
        parseYaml(body.content);
        write(file.slice(0, -3) + '.yaml', body.content);
        break;
      }
      case 'entry-pair': {
        const file = assertEntryBase(name, body.book, body.base);
        return saveEntryPair(file, file.slice(0, -3) + '.yaml', body.content, body.side);
      }
      case 'entry-new': {
        assertBookName(body.book);
        const bd = assertWorkspacePath(ROOT, path.join(src, 'worldbook', body.book));
        fs.mkdirSync(bd, { recursive: true });
        const base = nextEntryBase(bd, '新条目', ['.md', '.yaml']);
        saveEntryPair(path.join(bd, base + '.md'), path.join(bd, base + '.yaml'), body.content || '', 'keys: []\nconstant: false\ninsertion_order: 100\nenabled: true\n');
        return { base };
      }
      default:
        throw new Error('非法保存类型: ' + body.kind);
    }
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  try {
    assertLocalRequest(req);
  } catch (e) {
    json(res, 403, { error: e.message });
    return;
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(HTML);
      return;
    }
    if (parts[0] !== 'api') { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET' && parts[1] === 'ui-font') {
      const filename = parts.length === 3 ? new Map([
        ['regular', 'NotoSans-Regular.woff2'], ['medium', 'NotoSans-Medium.woff2'], ['bold', 'NotoSans-Bold.woff2'],
      ]).get(parts[2]) : undefined;
      if (!filename) { res.writeHead(404); res.end(); return; }
      const font = fs.readFileSync(assertWorkspacePath(ROOT, path.join(ROOT, 'assets', 'fonts', filename)));
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Content-Length': font.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(font);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'chat-avatar' && parts.length === 3) {
      const avatar = readChatAvatar(ROOT, decodeURIComponent(parts[2]));
      if (!avatar) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': avatar.mimeType, 'Cache-Control': url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(avatar.data);
      return;
    }
    const name = parts[2] ? safeName(decodeURIComponent(parts[2])) : undefined;
    if (req.method === 'GET' && parts[1] === 'chat-events' && parts.length === 3) {
      const conversationId = String(url.searchParams.get('conversationId') || '');
      conversations.get(name, conversationId);
      const tasks = codexBridge.status().tasks.filter(task => task.cardName === name && task.conversationId === conversationId);
      const pending = pendingChat(name, conversationId);
      tasks.push(...[...externalReplyTasks.values()].filter(task => task.cardName === name && task.conversationId === conversationId
        && pending.some(message => message.at === task.replyToAt)).map(task => publicExternalReplyTask(task)));
      chatEvents.connect(req, res, { cardName: name, conversationId }, tasks);
      return;
    }
    if (req.method === 'GET' && parts[1] === 'artifact-file' && parts.length === 3) {
      const artifact = readArtifactFile(ROOT, name, url.searchParams.get('targetType'), url.searchParams.get('file'));
      const filename = encodeURIComponent(artifact.downloadName).replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': artifact.data.length,
        'Content-Disposition': "attachment; filename*=UTF-8''" + filename,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      res.end(artifact.data);
      return;
    }
    const key = req.method + ' /' + parts.slice(0, 2).join('/');
    const route = routes[key];
    if (!route) { json(res, 404, { error: '未知接口: ' + key }); return; }
    const body = ['POST', 'DELETE'].includes(req.method) ? JSON.parse(await readBody(req, parts[1] === 'chat-avatar' ? 6 * 1024 * 1024 : undefined) || '{}') : undefined;
    json(res, 200, await route(url.searchParams, name, body));
  } catch (e) {
    if (!res.destroyed && !res.writableEnded) json(res, e.statusCode || 400, { error: e.message, ...(e.requestAccepted === false ? { requestAccepted: false } : {}) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const actualPort = server.address().port;
  process.env.PORT = String(actualPort);
  if (process.send) process.send({ type: 'xiaoxi-ready', port: actualPort });
  console.log('角色卡创作: http://localhost:' + actualPort + '/');
  if (process.platform === 'win32' && !process.env.XIAOXI_NO_OPEN) spawn('cmd', ['/c', 'start', '', 'http://localhost:' + actualPort + '/'], { stdio: 'ignore' });
  // 外部端口后端拉起常驻桥；Codex 后端按消息即时调用本机 CLI。
  try {
    const s0 = llmStatus();
    if (s0.configured && s0.backend === 'openai') startBridge();
    if (s0.configured && s0.backend === 'codex') codexBridge.enable();
  } catch { /* 未配置则不自动回复 */ }
});

let shuttingDown = false;
function shutdownStudio() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref();
  const codexStopped = codexBridge.stop();
  chatEvents.close();
  const proc = bridgeProc;
  const bridgeStopped = new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once('close', resolve);
  });
  stopBridge();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  return Promise.allSettled([codexStopped, bridgeStopped, serverClosed]).then(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdownStudio);
process.on('SIGINT', shutdownStudio);
process.on('disconnect', shutdownStudio);
process.on('message', (message) => {
  if (message?.type === 'xiaoxi-shutdown') shutdownStudio();
  if (message?.type === 'xiaoxi-user-profile' && process.env.XIAOXI_WORKBENCH === '1') {
    setWorkbenchUserProfile(ROOT, message.profile);
    if (process.connected) process.send({ type: 'xiaoxi-user-profile-synced', requestId: message.requestId });
  }
});

const HTML = `<!doctype html>
<html lang="zh-CN" class="dark">
<head>
<meta charset="utf-8">
<title>角色卡创作</title>
<style>
  @font-face { font-family: "Xiaoxi Noto Sans"; src: url('/api/ui-font/regular') format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: "Xiaoxi Noto Sans"; src: url('/api/ui-font/medium') format('woff2'); font-weight: 500; font-style: normal; font-display: swap; }
  @font-face { font-family: "Xiaoxi Noto Sans"; src: url('/api/ui-font/bold') format('woff2'); font-weight: 700; font-style: normal; font-display: swap; }
  :root {
    --reading-font: "Xiaoxi Noto Sans", "Noto Sans SC", "DengXian", sans-serif;
    --reading-bg: #f7fbff; --reading-ink: #263650; --reading-shadow: none;
    --star-bg: #f9fcff; --star-bg-soft: #fff7fb; --star-ink: #172033; --star-muted: #55667e;
    --star-card: rgba(255,255,255,.82); --star-card-strong: rgba(255,255,255,.94);
    --star-border: rgba(143,190,224,.42); --star-blue: #8ec8f6; --star-blue-strong: #3c75b5;
    --star-pink: #f5a4c5; --star-pink-strong: #b35186; --star-gold: #f8d78b;
    --star-shadow: 0 24px 70px rgba(94,141,190,.2); --star-shadow-soft: 0 14px 36px rgba(94,141,190,.14);
    --star-well: rgba(23,32,51,.05); --star-well-border: rgba(143,190,224,.5);
    --star-user: #2f6fae; --star-agent: #8a446f;
    --chat-history-bg: #dce8f8;
    --chat-agent-bg: #fff4fa; --chat-agent-border: #be81a6;
    --chat-user-bg: #dcedff; --chat-user-border: #6f9fc9;
    --chat-bubble-shadow: 0 3px 10px rgba(54,81,128,.12);
    color-scheme: light;
  }
  html.dark {
    --reading-bg: #16243c; --reading-ink: #f6e0a2; --reading-shadow: 0 0 2px rgba(0,0,0,.9);
    --star-bg: #071229; --star-bg-soft: #101b3b; --star-ink: #d7e4f2; --star-muted: #a3b4cc;
    --star-card: rgba(12,26,56,.78); --star-card-strong: rgba(14,30,66,.94);
    --star-border: rgba(149,205,255,.26); --star-blue: #8dcdfd; --star-blue-strong: #3870aa;
    --star-pink: #f3a4c7; --star-pink-strong: #a64c7e; --star-gold: #f4d389;
    --star-shadow: 0 28px 80px rgba(0,0,0,.34); --star-shadow-soft: 0 16px 44px rgba(0,0,0,.28);
    --star-well: rgba(3,9,24,.55); --star-well-border: rgba(149,205,255,.22);
    --star-user: #9fd0ff; --star-agent: #f3afd0;
    --chat-history-bg: #0b1730;
    --chat-agent-bg: #30263f; --chat-agent-border: #896180;
    --chat-user-bg: #1e3a59; --chat-user-border: #5b86ac;
    --chat-bubble-shadow: 0 4px 14px rgba(0,0,0,.24);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--star-ink);
    font: 14px/1.6 var(--reading-font);
    background:
      radial-gradient(circle at 16% 18%, rgba(142,200,246,.34) 0, transparent 26rem),
      radial-gradient(circle at 84% 12%, rgba(245,164,197,.30) 0, transparent 24rem),
      radial-gradient(circle at 70% 85%, rgba(248,215,139,.20) 0, transparent 20rem),
      linear-gradient(135deg, #eef8ff 0%, #f6fbff 45%, #fff0f8 100%);
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  html.dark body {
    background:
      radial-gradient(circle at 16% 18%, rgba(141,205,253,.16) 0, transparent 26rem),
      radial-gradient(circle at 84% 12%, rgba(243,164,199,.14) 0, transparent 24rem),
      radial-gradient(circle at 70% 85%, rgba(244,211,137,.10) 0, transparent 20rem),
      linear-gradient(135deg, #071229 0%, #101b3b 55%, #1b1638 100%);
  }
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .18;
    background-image:
      linear-gradient(color-mix(in srgb, var(--star-blue) 14%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--star-pink) 10%, transparent) 1px, transparent 1px);
    background-size: 44px 44px;
  }
  html.dark body::before {
    opacity: .35;
    background-image:
      radial-gradient(circle at 12% 22%, rgba(255,255,255,.55) 0 1px, transparent 2px),
      radial-gradient(circle at 32% 64%, rgba(141,205,253,.5) 0 1px, transparent 2px),
      radial-gradient(circle at 52% 18%, rgba(243,164,199,.5) 0 1px, transparent 2px),
      radial-gradient(circle at 68% 48%, rgba(255,255,255,.42) 0 1px, transparent 2px),
      radial-gradient(circle at 84% 28%, rgba(141,205,253,.45) 0 1px, transparent 2px),
      radial-gradient(circle at 92% 72%, rgba(243,164,199,.4) 0 1px, transparent 2px);
    background-size: 140px 140px, 180px 180px, 160px 160px, 200px 200px, 170px 170px, 190px 190px;
  }
  header, footer {
    position: relative; z-index: 1; display: flex; gap: 6px; align-items: center;
    border: 1px solid var(--star-border); background: color-mix(in srgb, var(--star-card-strong) 90%, transparent);
    backdrop-filter: blur(20px); box-shadow: var(--star-shadow);
  }
  header { flex: 0 0 40px; min-width: 0; margin: 4px 6px 0; padding: 3px 8px; border-radius: 12px; }
  footer { flex: 0 0 20px; min-width: 0; margin: 0 6px 4px; padding: 0 8px; border-radius: 8px; box-shadow: none; }
  header h1 { flex: 0 0 auto; font-size: 15px; margin: 0; font-weight: 800; }
  header button, header select { font-size: 13px; padding: 3px 8px; border-radius: 8px; white-space: nowrap; }
  #app-version { color: var(--star-muted); font-size: 11px; font-weight: 500; }
  #status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .persona-control { display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; font-size: 12px; color: var(--star-muted); }
  .persona-control select { min-width: 92px; font-size: 13px; }
  #persona-manager { width:min(820px,calc(100% - 32px)); max-height:calc(100vh - 32px); margin:auto; padding:24px; border:1px solid var(--star-border); border-radius:16px; background:var(--star-card-strong); color:var(--star-ink); }
  #persona-manager::backdrop { background:rgba(9,17,39,.45); }
  .persona-manager-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:20px; }
  .persona-manager-heading h2 { margin:0; font-size:20px; }
  .persona-manager-body { display:grid; grid-template-columns:190px minmax(0,1fr); gap:24px; }
  .persona-list-pane, #persona-form { display:flex; flex-direction:column; gap:10px; min-width:0; }
  #persona-list { width:100%; flex:1; min-height:230px; }
  #persona-name, #persona-prompt { width:100%; box-sizing:border-box; }
  #persona-prompt { min-height:220px; resize:vertical; line-height:1.65; }
  #persona-feedback { min-height:20px; margin:0; font-size:12px; }
  .persona-form-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
  #persona-delete-confirm { color:var(--star-ink); }
  #persona-delete-confirm[hidden] { display:none; }
  #persona-manager [hidden] { display:none !important; }
  #persona-manager button:focus-visible, #persona-manager input:focus-visible, #persona-manager textarea:focus-visible, #persona-manager select:focus-visible { outline:2px solid var(--star-blue-strong); outline-offset:3px; }
  @media(max-width:620px) { #persona-manager { padding:16px; } .persona-manager-body { grid-template-columns:1fr; gap:16px; } #persona-list { min-height:100px; max-height:130px; } #persona-prompt { min-height:180px; } }
  select, input, button {
    font: inherit; color: var(--star-ink);
    background: color-mix(in srgb, var(--star-card-strong) 92%, transparent);
    border: 1px solid var(--star-border); border-radius: .85rem; padding: 6px 10px;
  }
  button { cursor: pointer; font-weight: 700; transition: transform .16s ease, box-shadow .16s ease, background .16s ease; }
  button:hover { transform: translateY(-1px); background: color-mix(in srgb, var(--star-blue) 14%, var(--star-card-strong)); }
  button.primary {
    border-color: color-mix(in srgb, var(--star-blue-strong) 64%, white);
    background: linear-gradient(135deg, var(--star-blue-strong), var(--star-pink-strong)); color: #fff;
    box-shadow: 0 14px 32px color-mix(in srgb, var(--star-blue-strong) 34%, transparent);
  }
  html.dark button.primary { color: #fff; }
  main { position: relative; flex: 1; display: flex; min-height: 0; margin: 4px 6px; gap: 8px; }
  #chatmain {
    flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) max-content; grid-template-rows: 34px minmax(0, 1fr) auto auto;
    min-width: 0; min-height: 0; gap: 4px 6px; padding: 6px;
    border: 1px solid var(--star-border); border-radius: 14px;
    background: var(--star-card); box-shadow: var(--star-shadow-soft); backdrop-filter: blur(18px);
  }
  #chatmain strong { font-weight: 800; }
  .chat-history { grid-column: 1 / -1; grid-row: 2; min-width: 0; min-height: 0; overflow: auto; padding: 14px; border: 1px solid var(--star-well-border); border-radius: 10px; background: var(--chat-history-bg); }
  #chatmain .chat-heading, #chat-module-banner { display: none; }
  #chatmain .conversation-bar { grid-column: 1 / -1; grid-row: 1; gap: 6px; flex-wrap: nowrap; min-width: 0; overflow-x: auto; }
  .conversation-bar select { min-width: 120px; flex: 1; width: 0; }
  .conversation-bar button, .conversation-bar select { font-size: 13px; padding: 4px 10px; border-radius: 8px; white-space: nowrap; }
  #chat-input { grid-column: 1; grid-row: 3; flex: none; min-height: 40px; max-height: 160px; height: 40px; padding: 7px 10px; font: 500 15px/23px var(--reading-font); color: var(--reading-ink); background: var(--reading-bg); text-shadow: var(--reading-shadow); overflow-y: hidden; }
  .chat-send-row { grid-column: 2; grid-row: 3; align-self: end; }
  #chat-send { width: 100%; min-width: 76px; height: 40px; border-radius: 10px; padding: 4px 10px; white-space: nowrap; }
  .chat-error { grid-column: 1 / -1; grid-row: 4; max-height: 120px; overflow: auto; white-space: pre-wrap; }
  .chat-message { --message-bg: var(--chat-agent-bg); --message-border: var(--chat-agent-border); display: flex; align-items: flex-start; gap: 9px; margin-bottom: 16px; min-width: 0; }
  .chat-message.user { --message-bg: var(--chat-user-bg); --message-border: var(--chat-user-border); flex-direction: row-reverse; }
  .chat-avatar { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 13px; overflow: hidden; display: grid; place-items: center; background: color-mix(in srgb, var(--star-pink) 20%, var(--star-card-strong)); color: var(--star-agent); border: 1px solid var(--star-border); font-weight: 800; }
  .chat-message.user .chat-avatar { background: color-mix(in srgb, var(--star-blue) 25%, var(--star-card-strong)); color: var(--star-user); }
  .chat-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .chat-content { min-width: 0; max-width: calc(100% - 49px); display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .chat-message.user .chat-content { align-items: flex-end; }
  .chat-meta { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; color: var(--star-muted); font-size: 11px; }
  .chat-message.user .chat-meta { justify-content: flex-end; }
  .chat-sender { font-weight: 700; color: var(--star-agent); font-size: 12px; }
  .chat-message.user .chat-sender { color: var(--star-user); }
  .chat-bubble { min-width: 0; padding: 10px 13px; border: 1px solid var(--message-border); border-radius: 3px 15px 15px 15px; background: var(--message-bg); color: var(--reading-ink); box-shadow: var(--chat-bubble-shadow); }
  .chat-message.user .chat-bubble { border-radius: 15px 3px 15px 15px; }
  .chat-text { white-space: pre-wrap; overflow-wrap: anywhere; font: 500 15px/23px var(--reading-font); color: var(--reading-ink); text-shadow: var(--reading-shadow); }
  .chat-text code { font-family: ui-monospace, monospace; background: var(--star-well); border-radius: 4px; padding: 1px 4px; }
  .chat-text pre { white-space: pre-wrap; margin: 8px 0; padding: 10px; background: var(--star-well); border-radius: 8px; }
  .chat-text pre code { padding: 0; }
  .chat-module-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chat-reply-controls { display: flex; align-items: center; gap: 7px; margin-top: 7px; color: var(--star-muted); font-size: 11px; }
  .chat-reply-controls button { padding: 2px 8px; font-size: 12px; }
  .chat-reply-progress { height: 3px; min-width: 160px; max-width: 320px; overflow: hidden; border-radius: 4px; margin-top: 10px; background: var(--star-well-border); }
  .chat-reply-progress-indicator { display: block; width: 34%; height: 100%; border-radius: inherit; background: var(--star-agent); transform: translateX(100%); opacity: .5; }
  .chat-reply-progress[data-active="true"] .chat-reply-progress-indicator { animation: chat-reply-activity 1.8s ease-in-out infinite; opacity: 1; }
  .chat-reply-activity { display: block; margin-top: 5px; color: var(--star-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  @keyframes chat-reply-activity { from { transform: translateX(-110%); } to { transform: translateX(305%); } }
  @media (prefers-reduced-motion: reduce) { .chat-reply-progress[data-active="true"] .chat-reply-progress-indicator { animation: none; } }
  .chat-usage { max-width: 100%; color: var(--star-muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
  .chat-usage summary { cursor: pointer; }
  .chat-usage div { margin-top: 3px; }
  .chat-message.pending .chat-bubble { color: var(--star-muted); border-style: dashed; }
  .chat-message.pinned .chat-bubble { box-shadow: inset 3px 0 0 var(--star-gold), var(--chat-bubble-shadow); }
  .chat-copy { font-size: 11px; padding: 1px 6px; font-weight: 500; color: var(--star-muted); background: transparent; border-color: transparent; }
  .chat-copy:hover { transform: none; }
  .chat-edit { display: inline-flex; align-items: center; min-height: 30px; opacity: 1; padding: 4px 10px; color: white; border-color: var(--star-blue-strong); background: var(--star-blue-strong); font-size: 13px; font-weight: 700; }
  .chat-edit:hover { color: white; background: color-mix(in srgb, var(--star-blue-strong) 85%, #000); }
  .chat-delete, .chat-branch { min-height: 30px; padding: 4px 9px; border-color: var(--star-border); background: var(--star-well); color: var(--star-ink); font-size: 12px; }
  .chat-delete:hover { background: color-mix(in srgb, var(--star-pink) 35%, var(--star-card-strong)); }
  .chat-action-overlay { position: fixed; inset: 0; z-index: 110; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(9,17,39,.45); }
  .chat-action-panel { width: min(480px,100%); max-height: 90vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 20px; border: 1px solid var(--star-border); border-radius: 16px; background: var(--star-card-strong); box-shadow: var(--star-shadow); }
  .chat-action-preview { max-height: 110px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 8px; background: var(--star-well); font-size: 13px; }
  .chat-action-panel label { display: flex; flex-direction: column; gap: 6px; }
  .chat-action-panel input, .chat-action-panel select { width: 100%; min-width: 0; }
  .chat-deleted-list { display: flex; flex-direction: column; gap: 16px; }
  .chat-deleted-item { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; }
  .chat-deleted-item .chat-action-preview { width: 100%; }
  .chat-undo-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); z-index: 105; display: flex; gap: 10px; align-items: center; padding: 10px 14px; max-width: calc(100vw - 32px); border: 1px solid var(--star-border); border-radius: 12px; background: var(--star-card-strong); box-shadow: var(--star-shadow); }
  .chat-undo-toast span { overflow-wrap: anywhere; }
  .chat-undo-toast button { white-space: nowrap; }
  .chat-stop { font-weight: 700; }
  button:disabled { cursor: default; opacity: .5; transform: none; }
  .chat-content.editing { width: 100%; }
  .chat-content.editing .chat-meta { width: 100%; position: sticky; top: 0; z-index: 2; padding: 2px 0; border-radius: 6px; background: var(--star-well); }
  .chat-message.user .chat-content.editing .chat-meta { justify-content: flex-start; }
  .chat-content.editing .chat-edit { display: none; }
  .chat-content.editing .chat-bubble { width: 100%; padding: 8px; border: 2px solid var(--star-blue-strong); }
  .chat-content.editing .chat-edit-input { display: block; flex: none; width: 100%; min-height: 52px; max-height: none; padding: 0; border: 0; border-radius: 0; outline: none; box-shadow: none; background: transparent; color: var(--reading-ink); font: 500 15px/23px var(--reading-font); text-shadow: var(--reading-shadow); resize: vertical; overflow-y: auto; }
  .chat-edit-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
  .chat-edit-actions button { min-height: 32px; font-size: 13px; padding: 4px 10px; box-shadow: none; }
  .chat-edit-status { flex-basis: 100%; font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
  .chat-edited { font-size: 11px; color: var(--star-muted); }
  .avatar-dialog-row { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; padding: 8px 0; }
  .avatar-dialog-row .avatar-name { flex: 1; min-width: 80px; }
  #pane {
    width: 46%; flex: 0 0 46%; display: none; flex-direction: column; min-width: 0; min-height: 0; gap: 8px; padding: 14px;
    border: 1px solid var(--star-border); border-radius: 1.6rem;
    background: var(--star-card); box-shadow: var(--star-shadow-soft); backdrop-filter: blur(18px);
  }
  #pane.open { display: flex; }
  #pane strong { font-weight: 800; }
  #pane textarea { flex: 1; }
  #flow, #tree, #done, #reference {
    display: none; width: 216px; flex: 0 0 216px; overflow: auto; padding: 10px; flex-direction: column; gap: 2px;
    border: 1px solid var(--star-border); border-radius: 1.5rem;
    background: var(--star-card); box-shadow: var(--star-shadow-soft); backdrop-filter: blur(18px);
  }
  #flow .fhead, #done .fhead, #reference .fhead { font-weight: 800; color: var(--star-muted); font-size: 12px; padding: 2px 10px 6px; }
  #flow .tnode, #tree .tnode, #done .tnode, #reference .tnode {
    display: block; width: 100%; text-align: left; color: var(--star-muted); font-weight: 600;
    background: transparent; border-color: transparent; border-radius: .8rem; padding: 6px 10px;
  }
  #flow .tnode:hover, #tree .tnode:hover, #done .tnode:hover, #reference .tnode:hover { background: color-mix(in srgb, var(--star-blue) 12%, transparent); color: var(--star-ink); transform: none; }
  #flow .tnode.on, #tree .tnode.on {
    background: linear-gradient(135deg, color-mix(in srgb, var(--star-blue) 24%, transparent), color-mix(in srgb, var(--star-pink) 18%, transparent));
    color: var(--star-ink); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--star-blue) 28%, transparent);
  }
  #tree .treewrap { display: flex; flex-direction: column; gap: 2px; }
  #reference .ref-summary { margin: 2px 8px 8px; color: var(--star-muted); font-size: 12px; line-height: 1.55; }
  #done, #reference { width: 288px; flex-basis: 288px; min-height: 0; }
  .sidebar-heading { display: flex; gap: 6px; align-items: center; }
  .sidebar-heading .fhead { flex: 1; }
  .sidebar-heading button { flex: 0 0 auto; font-size: 12px; padding: 4px 8px; }
  .chat-tools { display: flex; gap: 6px; flex-wrap: wrap; }
  .chat-tools button { white-space: nowrap; }
  .chat-tools button[aria-expanded="true"] { background: color-mix(in srgb, var(--star-blue) 25%, var(--star-card-strong)); }
  /* 工具抽屉覆盖对话，打开时不改变历史和输入框的布局。 */
  #drawer-backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(9,17,39,.28); backdrop-filter: blur(2px); }
  #drawer-backdrop[hidden], #workspace-drawer[hidden] { display: none; }
  #workspace-drawer, body.make #flow, body.make #done, body.make #reference {
    position: fixed; top: 50px; bottom: 28px; z-index: 50; width: min(356px, calc(100vw - 24px));
    min-height: 0; max-height: none; overflow: auto; padding: 12px; border: 1px solid var(--star-border); border-radius: 16px;
    background: var(--star-card-strong); box-shadow: var(--star-shadow); backdrop-filter: blur(20px);
  }
  #workspace-drawer { left: 6px; display: flex; flex-direction: column; gap: 14px; }
  #workspace-drawer .drawer-section { display: flex; flex-direction: column; gap: 8px; }
  #workspace-drawer label { font-size: 12px; color: var(--star-muted); }
  #workspace-drawer #cards { width: 100%; }
  #workspace-drawer .drawer-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  #workspace-drawer .drawer-note { color: var(--star-muted); font-size: 12px; }
  body.make #flow { left: 6px; display: none; }
  body.make #done, body.make #reference { right: 6px; }
  body.make #flow.open { display: flex; }
  body.make #done.open, body.make #reference.open { display: flex; }
  body.make #chatmain { flex: 1; }
  /* 修改模式：目录与编辑内容并排，原聊天在返回对话后恢复。 */
  body.edit #tree { display: flex; }
  body.edit #tree { width: clamp(220px, 19vw, 290px); flex-basis: clamp(220px, 19vw, 290px); }
  body.edit #chatmain { display: none; }
  body.edit #pane { display: flex; flex: 1 1 0; width: auto; min-width: 0; overflow: auto; }
  body.edit #pane .row { flex-wrap: wrap; }
  body.edit #pane .row strong, body.edit #pane .row .muted { overflow-wrap: anywhere; }
  #pane .editor-toolbar { display: flex; flex: 0 0 auto; justify-content: space-between; gap: 8px; }
  #pane .editor-toolbar button { font-size: 13px; padding: 4px 10px; }
  #pane .editor-empty { flex: 1; display: grid; place-content: center; padding: 24px; text-align: center; color: var(--star-muted); border: 1px dashed var(--star-border); border-radius: 12px; }
  @media (max-width: 1100px) {
    body.edit #tree { width: 190px; flex-basis: 190px; }
  }
  @media (max-width: 760px) {
    body.edit #tree { width: 156px; flex-basis: 156px; padding: 6px; }
    body.edit #pane { padding: 10px; }
    header h1 { font-size: 13px; }
    header .persona-control { margin-left: auto; }
    #status { display: none; }
    #btn-mode { max-width: 84px; overflow: hidden; text-overflow: ellipsis; }
    .persona-control select { min-width: 74px; }
    #chatmain .conversation-bar { gap: 4px; }
    .conversation-bar button { padding: 4px 7px; }
  }
  /* 只读查看浮层 */
  #viewer {
    position: fixed; inset: 8vh 12vw; z-index: 60; display: flex; flex-direction: column; gap: 8px; padding: 14px;
    border: 1px solid var(--star-border); border-radius: 1.4rem; background: var(--star-card-strong); box-shadow: var(--star-shadow);
  }
  #viewer pre { flex: 1; }
  #viewer.guide-viewer { inset: 4vh 7vw; padding: 20px 24px; }
  #viewer.guide-viewer .guide-header { position: relative; min-height: 44px; padding-right: 105px; align-items: flex-start; }
  #viewer.guide-viewer .guide-close { position: absolute; top: 0; right: 0; }
  #viewer.guide-viewer .guide-body { flex: 1; overflow: auto; padding: 4px 10px 20px; color: var(--star-ink); font-size: 15px; line-height: 1.8; }
  .guide-body h2 { margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--star-border); font-size: 1.2rem; }
  .guide-body h3 { margin: 18px 0 8px; font-size: 1.05rem; }
  .guide-body p { margin: 8px 0; }
  .guide-body ul, .guide-body ol { margin: 8px 0; padding-left: 1.6em; }
  .guide-body li { margin: 4px 0; }
  .guide-body blockquote { margin: 10px 0; padding: 10px 14px; border-left: 3px solid var(--star-gold); border-radius: 6px; background: var(--star-well); }
  .guide-body pre { margin: 10px 0; padding: 12px; white-space: pre-wrap; }
  .guide-body code { padding: 1px 5px; border-radius: 5px; background: var(--star-well); font: .9em ui-monospace, Consolas, monospace; }
  .guide-body .guide-note { color: var(--star-muted); font-size: 12px; }
  #side pre { flex: 0 0 auto; max-height: 260px; }
  #side details { border: 1px solid var(--star-border); border-radius: .8rem; padding: 6px 10px; }
  #side details summary { cursor: pointer; font-weight: 700; }
  #side table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  #side table td { padding: 3px 4px; border-bottom: 1px solid var(--star-border); vertical-align: top; }
  #side input, #side select { width: 100%; padding: 4px 6px; font-size: 12.5px; }
  textarea, pre {
    flex: 1; width: 100%; padding: 10px; color: var(--star-ink);
    border: 1px solid var(--star-border); border-radius: .95rem;
    background: color-mix(in srgb, white 66%, transparent);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.35);
    font: 13px/1.7 ui-monospace, Consolas, "Liberation Mono", monospace; resize: none;
  }
  html.dark textarea, html.dark pre { background: rgba(10,20,44,.5); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
  pre { margin: 0; overflow: auto; }
  .row { display: flex; gap: 8px; align-items: center; }
  .muted { color: var(--star-muted); }
  #log { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; color: var(--star-muted); font: 12px/18px var(--reading-font); }
  #log-popover { position: fixed; left: 6px; right: 6px; bottom: 28px; z-index: 55; padding: 12px; max-height: 55vh; overflow: auto; border: 1px solid var(--star-border); border-radius: 12px; background: var(--star-card-strong); box-shadow: var(--star-shadow); }
  #log-popover[hidden] { display: none; }
  #log-detail { flex: none; white-space: pre-wrap; max-height: 42vh; margin-top: 8px; }
  .err { color: #be123c; } html.dark .err { color: var(--star-pink); }
  .warn { color: #9a5d12; } html.dark .warn { color: var(--star-gold); }
  .okc { color: #047857; } html.dark .okc { color: #9ce8c9; }
  #blocks button { min-width: 52px; }
  #blocks { display: flex; gap: 6px; }
  #cardtabs { display: none; gap: 4px; flex-wrap: wrap; align-items: center; padding: 2px 0 0 6px; }
  #cardtabs::before { content: '└ 卡内分类：'; color: var(--star-muted); font-size: 12px; }
  #cardtabs button { min-width: 84px; font-size: 12px; padding: 3px 12px; border-radius: 999px; }
</style>
</head>
<body>
<header>
  <button id="btn-workspace" aria-controls="workspace-drawer" aria-expanded="false" title="切换卡片、导入、检查和生成成品">☰ 工作区</button>
  <h1>角色卡创作 <span id="app-version"></span></h1>
  <span class="muted" id="status"></span>
  <label class="persona-control" for="persona-select"><select id="persona-select" aria-label="对话人设" title="选择对话人设"></select></label>
  <button id="btn-personas" type="button">管理人设</button>
  <button id="btn-theme" title="切换浅色/深色">☾</button>
  <button id="btn-mode" title="编辑卡片源码；聊天正文可直接点击消息旁的「编辑」">编辑卡片</button>
  <button id="btn-export-card" class="primary" type="button">导出角色卡</button>
  <button id="btn-view-card-artifacts" type="button">查看成品</button>
</header>
<div id="drawer-backdrop" hidden></div>
<aside id="workspace-drawer" class="tool-drawer" role="region" aria-label="工作区工具" hidden>
  <div class="sidebar-heading"><strong style="flex:1">工作区工具</strong><button id="workspace-close" aria-label="收起工作区工具">收起</button></div>
  <div class="drawer-section">
    <span id="blocks"></span>
    <span id="cardtabs"></span>
    <label for="cards">当前卡片或内容</label>
    <select id="cards" aria-label="当前卡片或内容"></select>
    <div class="drawer-actions"><button id="btn-new">新建卡</button><button id="btn-import">导入 PNG/JSON</button></div>
    <input type="file" id="import-file" accept=".png,.json" hidden>
  </div>
  <div class="drawer-section">
    <div class="drawer-actions"><button id="btn-check">检查</button><button id="btn-build" class="primary" title="生成可导入酒馆的成品文件">生成成品</button></div>
    <div class="drawer-note">生成后可直接下载成品或打开所在文件夹，也可通过“查看成品”再次取文件。酒馆实际使用仍需验收。</div>
  </div>
  <div id="workspace-settings" class="drawer-actions"><button id="btn-workspace-settings">接入设置</button><button id="btn-workspace-avatar">头像设置</button></div>
</aside>
<main>
  <div id="flow" class="tool-drawer" role="region" aria-label="制作流程" hidden></div>
  <div id="tree"></div>
  <div id="chatmain"></div>
  <div id="done" class="tool-drawer" role="region" aria-label="已保存内容" hidden></div>
  <div id="reference" class="tool-drawer" role="region" aria-label="写作参考" hidden></div>
  <div id="pane"></div>
</main>
<footer>
  <div id="log" role="status" aria-live="polite" tabindex="0" title="点击查看完整状态">就绪</div>
  <button id="draft-status" style="font-size:12px;line-height:18px;padding:0 4px;border:0;background:transparent;white-space:nowrap" title="草稿保存在当前工作区；点击重试保存" aria-live="polite">正在读取草稿…</button>
</footer>
<div id="log-popover" role="region" aria-label="状态详情" hidden><div class="sidebar-heading"><strong style="flex:1">状态详情</strong><button id="log-close">收起</button></div><pre id="log-detail">就绪</pre></div>
<script>
${resolveWorkflowStage.toString()}
${resetCardTrackState.toString()}
${chatPresentationParts.toString()}
${attachChatRecovery.toString()}
${attachArtifactAccess.toString()}
${attachConversationManager.toString()}
${attachChatStream.toString()}
${attachPersonaManager.toString()}
var state = { block: 'card', name: null, view: null, tree: null, listSeq: 0, treeSeq: 0, mode: 'make', sidebarOpen: '', workspaceOpen: false, wfStage: '', flowOpen: null, flowData: null, flowCard: null, cardTab: 'char', personaId: ${JSON.stringify(process.env.XIAOXI_WORKBENCH === '1' ? 'xiaoxi' : 'neutral')}, personaName: ${JSON.stringify(process.env.XIAOXI_WORKBENCH === '1' ? '林小汐' : '中性助手')}, personaOptions: [] };
var editorSelections = new Map();
var API_TOKEN = ${JSON.stringify(API_TOKEN)};
var DEFAULT_CODEX_MODEL = ${JSON.stringify(DEFAULT_CODEX_MODEL)};
var CODEX_REASONING_LEVELS = ${JSON.stringify(CODEX_REASONING_LEVELS)};
var REASONING_LABELS = { low: '低 · low', medium: '中 · medium', high: '高 · high', xhigh: '很高 · xhigh', max: '最高 · max', ultra: '极致 · ultra' };
var chatAvatars = { user: { url: '', label: '你' }, neutral: { url: '', label: '助' }, xiaoxi: { url: '', label: '汐' }, momo: { url: '', label: '茉' } };
// 内存负责即时输入，工作区文件负责跨刷新、跨端口和跨版本恢复。
var draftPersistence = { revision: null, pending: new Map(), saved: {}, timer: null, flight: null, retryBatch: null, error: '', hydrated: false };
var editorDraftBases = new Map();
var editorDrafts = draftMap('editor'), currentEditorSession = null;
var chatDrafts = draftMap('chat'), failedChatSends = draftMap('send');
var chatEditDrafts = draftMap('message');
var chatReplyWatermarks = new Map();
var flowSeq = 0, guideSeq = 0;
function draftStorageKey(kind, key) { return JSON.stringify([kind].concat(JSON.parse(key))); }
function draftValue(kind, key, value) {
  if (kind === 'chat') return { text: value };
  if (kind === 'editor') return { values: value, baseValues: editorDraftBases.get(key) || value };
  if (kind === 'message') return { text: value.text, revision: value.revision, start: Number.isInteger(value.start) ? Math.min(value.text.length, value.start) : null, end: Number.isInteger(value.end) ? Math.min(value.text.length, value.end) : null };
  return value.map(function (entry) { return { text: entry.text, reason: entry.reason || '', status: entry.status || 'failed' }; });
}
function draftMap(kind) {
  var map = new Map();
  map.set = function (key, value) {
    if ((kind === 'chat' && !value) || (kind === 'send' && !value.length)) { map.delete(key); return map; }
    Map.prototype.set.call(map, key, value);
    queueDraftChange(draftStorageKey(kind, key), draftValue(kind, key, value));
    return map;
  };
  map.delete = function (key) {
    var existed = Map.prototype.delete.call(map, key), storedKey = draftStorageKey(kind, key);
    if (existed || Object.hasOwn(draftPersistence.saved, storedKey) || draftPersistence.pending.has(storedKey)) queueDraftChange(storedKey, null);
    return existed;
  };
  return map;
}
function showDraftStatus() {
  var button = el('draft-status');
  if (!button) return;
  button.textContent = draftPersistence.error ? '草稿保存失败 · 重试' : !draftPersistence.hydrated ? '正在读取草稿…' : draftPersistence.pending.size || draftPersistence.flight ? '正在保存草稿…' : '草稿已保存';
  button.className = draftPersistence.error ? 'err' : 'muted';
  button.title = draftPersistence.error || '草稿保存在当前工作区，刷新或重新打开程序后可恢复。';
}
function lockDraftStartup(locked) {
  document.querySelectorAll('header, main, #workspace-drawer').forEach(function (node) { node.inert = locked; });
}
function queueDraftChange(key, value) {
  var snapshot = value === null ? null : JSON.parse(JSON.stringify(value));
  var existing = draftPersistence.pending.get(key);
  if (existing && JSON.stringify(existing.value) === JSON.stringify(snapshot)) return;
  if (!existing && JSON.stringify(draftPersistence.saved[key] || null) === JSON.stringify(snapshot)) return;
  draftPersistence.pending.set(key, { key: key, value: snapshot });
  clearTimeout(draftPersistence.timer);
  draftPersistence.timer = setTimeout(function () { flushDrafts().catch(function () {}); }, 350);
  showDraftStatus();
}
function hydrateDrafts() {
  return api('GET', '/api/ui-drafts').then(function (data) {
    var maps = { editor: editorDrafts, chat: chatDrafts, message: chatEditDrafts, send: failedChatSends };
    Object.keys(data.entries).forEach(function (storedKey) {
      var parts = JSON.parse(storedKey), kind = parts.shift(), key = JSON.stringify(parts), value = data.entries[storedKey].value;
      draftPersistence.saved[storedKey] = value;
      if (draftPersistence.pending.has(storedKey)) return;
      if (kind === 'editor') { editorDraftBases.set(key, value.baseValues); Map.prototype.set.call(maps[kind], key, value.values); }
      else if (kind === 'chat') Map.prototype.set.call(maps[kind], key, value.text);
      else if (kind === 'message') Map.prototype.set.call(maps[kind], key, Object.assign({}, value, { saving: false, error: '', recovered: true }));
      else Map.prototype.set.call(maps[kind], key, value);
    });
    draftPersistence.revision = data.revision; draftPersistence.hydrated = true; draftPersistence.error = '';
    lockDraftStartup(false);
    showDraftStatus();
  }).catch(function (error) {
    draftPersistence.error = '草稿读取失败：' + error.message + '。当前输入仍保留在窗口中。';
    showDraftStatus(); log(draftPersistence.error, 'err'); throw error;
  });
}
function flushDrafts(keepalive) {
  clearTimeout(draftPersistence.timer);
  if (draftPersistence.flight) return draftPersistence.flight.then(function () { return flushDrafts(keepalive); });
  if (draftPersistence.revision === null) return hydrateDrafts().then(function () { return flushDrafts(keepalive); });
  if (!draftPersistence.pending.size) return Promise.resolve();
  var batch = draftPersistence.retryBatch || { changes: Array.from(draftPersistence.pending.values()), base: JSON.parse(JSON.stringify(draftPersistence.saved)), revision: draftPersistence.revision };
  var changes = batch.changes;
  draftPersistence.retryBatch = batch;
  draftPersistence.error = '';
  var request = { expectedRevision: batch.revision, changes: changes };
  draftPersistence.flight = fetch('/api/ui-drafts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaoxi-Token': API_TOKEN }, body: JSON.stringify(request), keepalive: !!keepalive }).then(function (response) {
    return response.json().then(function (result) { if (!response.ok) throw Object.assign(new Error(result.error || response.status), { statusCode: response.status }); return result; });
  }).catch(function (error) {
    if (error.statusCode === 400 || error.statusCode === 413) draftPersistence.retryBatch = null;
    if (error.statusCode && error.statusCode !== 409) throw error;
    // POST 的响应可能丢失；只认可完整内容恰好等于原批次、且版本只前进一次的提交。
    return api('GET', '/api/ui-drafts').then(function (data) {
      var expected = Object.assign({}, batch.base);
      changes.forEach(function (change) { if (change.value === null) delete expected[change.key]; else expected[change.key] = change.value; });
      var keys = Object.keys(expected);
      if (data.revision !== batch.revision + 1 || Object.keys(data.entries).length !== keys.length || !keys.every(function (key) {
        return Object.hasOwn(data.entries, key) && JSON.stringify(data.entries[key].value) === JSON.stringify(expected[key]);
      })) throw error;
      return { revision: data.revision };
    }).catch(function () { throw error; });
  }).then(function (result) {
    draftPersistence.revision = result.revision;
    draftPersistence.retryBatch = null;
    changes.forEach(function (change) {
      if (change.value === null) delete draftPersistence.saved[change.key]; else draftPersistence.saved[change.key] = change.value;
      if (draftPersistence.pending.get(change.key) === change) draftPersistence.pending.delete(change.key);
    });
  }).catch(function (error) {
    draftPersistence.error = '草稿尚未保存：' + error.message + '。请保留当前窗口并点击重试。';
    log(draftPersistence.error, 'err'); throw error;
  }).finally(function () { draftPersistence.flight = null; showDraftStatus(); });
  showDraftStatus();
  return draftPersistence.flight.then(function () { if (draftPersistence.pending.size) return flushDrafts(keepalive); });
}
window.__flushDrafts = function () { return Promise.resolve().then(function () { if (personaManager) personaManager.checkDraft(); rememberChatDraft(); rememberEditorDraft(); return flushDrafts(); }); };
var draftExitGeneration = 0;
window.__cancelDraftExit = function () { draftExitGeneration++; document.body.inert = false; window.__discardDraftsOnExit = false; };
window.__prepareDraftExit = function () {
  var generation = ++draftExitGeneration;
  document.body.inert = true;
  return window.__flushDrafts().then(function () { if (generation === draftExitGeneration) window.__discardDraftsOnExit = true; }).catch(function (error) { if (generation === draftExitGeneration) window.__cancelDraftExit(); throw error; });
};
window.addEventListener('pagehide', function () { if (window.__discardDraftsOnExit) return; rememberChatDraft(); rememberEditorDraft(); flushDrafts(true).catch(function () {}); });
window.addEventListener('beforeunload', function (event) {
  if (!window.__discardDraftsOnExit && (draftPersistence.error || draftPersistence.pending.size || draftPersistence.flight)) { event.preventDefault(); event.returnValue = ''; }
});
el('draft-status').onclick = function () {
  if (!draftPersistence.hydrated) hydrateDrafts().then(function () { return loadList(); }).catch(function () {});
  else window.__flushDrafts().catch(function () {});
};
function rememberEditorDraft() {
  var session = currentEditorSession;
  if (!session) return;
  var values = session.inputs.map(function (input) { return input.value; });
  if (JSON.stringify(values) === JSON.stringify(session.initial)) editorDrafts.delete(session.key);
  else editorDrafts.set(session.key, values);
}
function bindEditorDraft() {
  var inputs = Array.from(el('pane').querySelectorAll('textarea, input'));
  if (!inputs.length || !state.view) { currentEditorSession = null; return; }
  var key = JSON.stringify([state.block, state.name, state.view]);
  var initial = inputs.map(function (input) { return input.value; });
  var saved = editorDrafts.get(key);
  if (saved && JSON.stringify(saved) === JSON.stringify(initial)) { editorDrafts.delete(key); saved = null; }
  var base = editorDraftBases.get(key);
  var conflict = !!saved && (!base || JSON.stringify(base) !== JSON.stringify(initial) || saved.length !== inputs.length);
  if (!saved) editorDraftBases.set(key, initial);
  if (saved) inputs.forEach(function (input, i) { if (saved[i] !== undefined) input.value = saved[i]; });
  var session = { key: key, name: state.name, block: state.block, inputs: inputs, initial: initial, conflict: conflict };
  currentEditorSession = session;
  inputs.forEach(function (input) { input.addEventListener('input', rememberEditorDraft); });
  if (saved) {
    var notice = document.createElement('div'); notice.className = conflict ? 'warn' : 'muted'; notice.setAttribute('role', 'status');
    notice.textContent = conflict ? '已恢复草稿，但已保存正文也发生了变化。请先核对，再决定是否采用这份草稿。' : '已恢复上次未保存的草稿。';
    if (conflict) {
      var details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre');
      summary.textContent = '查看现在已保存的正文'; content.textContent = initial.join(String.fromCharCode(10, 10)); content.style.whiteSpace = 'pre-wrap';
      details.appendChild(summary); details.appendChild(content); notice.appendChild(details);
      var use = document.createElement('button'); use.textContent = '采用恢复草稿，继续编辑';
      use.onclick = function () { session.conflict = false; editorDraftBases.set(key, initial); rememberEditorDraft(); notice.textContent = '已采用恢复草稿；点击保存后才会更新正文。'; };
      notice.appendChild(use);
    }
    var discard = document.createElement('button'); discard.textContent = '放弃恢复草稿';
    discard.onclick = function () { inputs.forEach(function (input, index) { input.value = initial[index]; }); session.conflict = false; editorDraftBases.set(key, initial); editorDrafts.delete(key); notice.remove(); };
    notice.appendChild(discard); el('pane').appendChild(notice);
  }
}
function saveEditor(button, request, title, closeAfterSave) {
  if (button.disabled) return;
  var session = currentEditorSession;
  if (session && session.conflict) { log('已保存正文发生变化，请先查看正文并决定是否采用恢复草稿。', 'warn'); return; }
  var submitted = session && session.inputs.map(function (input) { return input.value; });
  button.disabled = true;
  return Promise.resolve().then(request).then(function () {
    log('已保存: ' + title, 'okc');
    if (!session) return;
    if (currentEditorSession !== session || state.name !== session.name || state.block !== session.block) return;
    session.initial = submitted;
    editorDraftBases.set(session.key, submitted);
    var values = session.inputs.map(function (input) { return input.value; });
    var changed = JSON.stringify(values) !== JSON.stringify(submitted);
    if (changed) editorDrafts.set(session.key, values); else editorDrafts.delete(session.key);
    if (changed) return;
    if (closeAfterSave) { currentEditorSession = null; state.view = null; state.viewOwner = null; editorSelections.delete(editorSelectionKey(session.block, session.name)); }
    return loadList(session.name);
  }).catch(function (error) { log('保存失败: ' + error.message, 'err'); }).finally(function () { button.disabled = false; });
}
function rememberChatDraft() { if (window.__rememberChatDraft) window.__rememberChatDraft(); }
function autosizeChatInput(input) {
  if (!input) return;
  input.style.height = '40px';
  var height = Math.min(160, Math.max(40, input.scrollHeight + 2));
  input.style.height = height + 'px';
  input.style.overflowY = input.scrollHeight > 158 ? 'auto' : 'hidden';
}
function autosizeMessageEditor(input, force) {
  if (!input) return;
  var visibleWidth = input.getBoundingClientRect().width;
  if (!visibleWidth) return;
  var width = String(visibleWidth);
  if (!force && input.dataset.editWidth === width) return;
  input.dataset.editWidth = width;
  var overflow = input.style.overflowY;
  input.style.overflowY = 'hidden';
  input.style.height = 'auto';
  input.style.height = Math.ceil(input.scrollHeight + input.offsetHeight - input.clientHeight) + 'px';
  input.style.overflowY = overflow;
}
window.addEventListener('resize', function () {
  autosizeChatInput(el('chat-input'));
  document.querySelectorAll('.chat-edit-input').forEach(function (input) { autosizeMessageEditor(input); });
});
var LABELS = {
  description: '描述', personality: '性格', scenario: '场景', first_mes: '开场白',
  mes_example: '对话示例', creator_notes: '作者备注', system_prompt: '系统提示',
  post_history_instructions: '后置指令',
};
function el(id) { return document.getElementById(id); }
function log(msg, cls) {
  var status = el('log'); status.textContent = String(msg); status.className = cls || '';
  status.title = String(msg) + '（点击查看完整状态）';
  el('log-detail').textContent = String(msg);
}
function api(method, path, body) {
  return fetch(path, { method: method, headers: { 'Content-Type': 'application/json', 'X-Xiaoxi-Token': API_TOKEN }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw Object.assign(new Error(j.error || r.status), { requestRejected: j.requestAccepted === false }); return j; }); });
}
function personaName(id) {
  var found = state.personaOptions.find(function (p) { return p.id === id; });
  return found ? found.name : '助手';
}
function applyPersonaState(data) {
    state.personaOptions = data.personas;
    state.personaId = data.activeId;
    state.personaName = personaName(data.activeId);
    var select = el('persona-select');
    select.innerHTML = '';
    data.personas.forEach(function (p) {
      var option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      select.appendChild(option);
    });
    select.value = data.activeId;
    select.onchange = function () {
      if (state.personaSwitching || state.personaBusy) { select.value = state.personaId; return; }
      select.disabled = true;
      state.personaSwitching = true;
      el('btn-personas').disabled = true;
      api('POST', '/api/persona', { id: select.value }).then(function (saved) {
        applyPersonaState(saved);
        log('接下来由' + state.personaName + '回复。已有对话和卡片内容保留。', 'okc');
      }).catch(function (e) {
        select.value = state.personaId;
        log('切换人设失败: ' + e.message, 'err');
      }).finally(function () { state.personaSwitching = false; select.disabled = el('btn-personas').disabled = !!state.personaBusy; });
    };
    if (window.__refreshPersona) window.__refreshPersona();
    else renderChat();
}
var personaManager = attachPersonaManager({ api: api, state: state, applyState: applyPersonaState,
  refreshAvatars: function () { return api('GET', '/api/chat-avatars').then(function (mapping) { chatAvatars = mapping; if (window.__refreshChatAvatars) window.__refreshChatAvatars(); }); } });
el('btn-personas').onclick = function () { personaManager.open(); };
function loadPersona() {
  return api('GET', '/api/persona').then(applyPersonaState).catch(function (e) { log('读取人设失败: ' + e.message, 'err'); });
}
var BLOCKS = [{ id: 'card', label: '卡' }, { id: 'preset', label: '预设' }, { id: 'book', label: '世界书' }];
function listUrl() { return state.block === 'card' ? '/api/cards' : state.block === 'preset' ? '/api/presets' : '/api/worldbooks'; }
function treeUrl() { return state.block === 'card' ? '/api/card/' : state.block === 'preset' ? '/api/preset/' : '/api/worldbook/'; }
function checkUrl() { return state.block === 'card' ? '/api/check/' : state.block === 'preset' ? '/api/preset-check/' : '/api/worldbook-check/'; }
function buildUrl() { return state.block === 'card' ? '/api/build/' : state.block === 'preset' ? '/api/preset-build/' : '/api/worldbook-build/'; }
function renderBlocks() {
  var wrap = el('blocks');
  wrap.innerHTML = '';
  BLOCKS.forEach(function (b) {
    var btn = document.createElement('button');
    btn.textContent = b.label;
    if (state.block === b.id) btn.className = 'primary';
    btn.onclick = function () { rememberChatDraft(); rememberEditorDraft(); state.block = b.id; state.name = null; state.tree = null; state.flowData = null; state.flowCard = null; state.view = null; renderBlocks(); loadList(); };
    wrap.appendChild(btn);
  });
  var tabs = el('cardtabs');
  tabs.innerHTML = '';
  if (state.block === 'card') {
    tabs.style.display = 'inline-flex';
    [{ id: 'char', label: '角色卡' }, { id: 'world', label: '世界卡' }].forEach(function (t) {
      var tb = document.createElement('button');
      tb.textContent = t.label;
      if (state.cardTab === t.id) tb.className = 'primary';
      tb.onclick = function () {
        if (state.cardTab === t.id) return;
        rememberChatDraft(); rememberEditorDraft();
        resetCardTrackState(state, t.id);
        renderBlocks();
        renderFlow();
        renderDone();
        el('chatmain').innerHTML = '<p class="muted">正在载入' + (t.id === 'world' ? '世界卡' : '角色卡') + '流程…</p>';
        el('status').textContent = '';
        loadList();
      };
      tabs.appendChild(tb);
    });
  } else {
    tabs.style.display = 'none';
  }
  el('import-file').accept = state.block === 'card' ? '.png,.json' : '.json';
  el('btn-new').style.display = state.block === 'card' ? '' : 'none';
  el('btn-import').textContent = state.block === 'card' ? '导入 PNG/JSON' : '导入 JSON';
}
function loadList(keep) {
  if (!draftPersistence.hydrated) return Promise.resolve();
  rememberChatDraft(); rememberEditorDraft();
  setSidebar('', false);
  var my = ++state.listSeq;
  ++state.treeSeq; ++flowSeq;
  return api('GET', listUrl()).then(function (list) {
    if (my !== state.listSeq) return undefined;
    if (state.block === 'card') {
      if (keep) {
        var kc = list.filter(function (c) { return c.name === keep; })[0];
        var want = (kc && kc.cardType === '世界观卡') ? 'world' : 'char';
        if (state.cardTab !== want) { state.cardTab = want; renderBlocks(); }
      }
      var isWorld = state.cardTab === 'world';
      list = list.filter(function (c) { return (c.cardType === '世界观卡') === isWorld; });
    }
    var sel = el('cards');
    sel.innerHTML = '';
    list.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.name;
      o.textContent = c.name + (c.warning ? '（读取异常）' : '') + (c.drift ? (c.lastBuild ? '（成品待更新）' : '（待生成成品）') : '');
      o.title = c.warning || '';
      o.dataset.warning = c.warning || '';
      sel.appendChild(o);
    });
    if (!list.length) { state.name = null; state.tree = null; state.flowData = null; state.flowCard = null; state.wfStage = ''; var emptyMessage = state.block === 'card' ? '这个分类下还没有卡。新建或导入后它会出现在这里。' : '当前块还没有内容。导入或新建开始。'; closeModule(emptyMessage); renderTree(); renderFlow(); renderDone(); renderReference(); el('chatmain').innerHTML = '<p class="muted">' + emptyMessage + '</p>'; el('status').textContent = ''; return; }
    state.name = keep && list.some(function (c) { return c.name === keep; }) ? keep : list[0].name;
    sel.value = state.name;
    return openCurrent();
  }).catch(function (error) {
    if (my !== state.listSeq) return;
    state.name = null; el('cards').innerHTML = '';
    clearLoadedContent('列表载入失败，请重试或重新选择分类。');
    log('列表载入失败: ' + error.message, 'err');
  });
}
function clearLoadedContent(message) {
  state.tree = null; state.flowData = null; state.flowCard = null; state.wfStage = ''; ++flowSeq;
  closeModule(message); renderTree(); renderDone();
  var flow = el('flow'); flow.innerHTML = ''; flow.appendChild(flowHead()); flow.appendChild(mutedLine(message));
  var reference = el('reference'); reference.innerHTML = ''; sidebarHeading(reference, '写作参考', 'reference'); reference.appendChild(mutedLine(message));
  resetChatPanel(message);
  el('status').textContent = '';
}
function openCurrent() {
  rememberChatDraft(); rememberEditorDraft();
  setSidebar('', false);
  var my = ++state.treeSeq;
  var cardName = state.name, block = state.block;
  var view = state.viewOwner && state.viewOwner.block === block && state.viewOwner.name === cardName ? state.view : null;
  clearLoadedContent('正在载入内容…');
  return api('GET', treeUrl() + encodeURIComponent(cardName)).then(function (tree) {
    if (my !== state.treeSeq || state.name !== cardName || state.block !== block) return undefined;
    state.tree = tree;
    if (state.mode === 'edit') { ensureEditPane(view); renderTree(); revealEditorSelection(); }
    else { closeModule(); renderFlow(); renderDone(); }
    renderChat();
    el('status').textContent = BLOCKS.find(function (b) { return b.id === state.block; }).label + ' · ' + state.name;
    var selected = el('cards').selectedOptions[0];
    if (selected && selected.value === cardName && selected.dataset.warning) log('当前项目读取异常：' + selected.dataset.warning, 'warn');
  }).catch(function (error) {
    if (my !== state.treeSeq || state.name !== cardName || state.block !== block) return;
    clearLoadedContent('内容载入失败，旧内容已收起；未保存草稿仍保留在当前页面。');
    log('内容载入失败: ' + error.message, 'err');
  });
}
function dualEditor(title, content, side, onSave) {
  var pane = el('pane');
  pane.innerHTML = '';
  var h = document.createElement('div');
  h.className = 'row';
  var strong = document.createElement('strong');
  strong.textContent = title;
  h.appendChild(strong);
  var ta1 = document.createElement('textarea');
  ta1.value = content == null ? '' : content;
  ta1.style.flex = '3';
  if (content == null) ta1.placeholder = '（无正文的标记条目）填写后将为其添加 content 字段';
  var lab = document.createElement('div');
  lab.className = 'muted';
  lab.textContent = '侧车（元数据 yaml）';
  var ta2 = document.createElement('textarea');
  ta2.value = side;
  ta2.style.flex = '1';
  var row = document.createElement('div');
  row.className = 'row';
  var save = document.createElement('button');
  save.className = 'primary';
  save.textContent = '保存';
  save.onclick = function () {
    var content = ta1.value, side = ta2.value;
    saveEditor(save, function () { return onSave(content, side); }, title);
  };
  row.appendChild(save);
  pane.appendChild(h); pane.appendChild(ta1); pane.appendChild(lab); pane.appendChild(ta2); pane.appendChild(row);
}
function previewPane(url) {
  var pane = el('pane');
  pane.innerHTML = '';
  var h = document.createElement('div');
  h.className = 'row';
  h.innerHTML = '<strong>组装预览</strong><span class="muted" id="pv-chars"></span>';
  var count = h.querySelector('span');
  var pre = document.createElement('pre');
  pane.appendChild(h); pane.appendChild(pre);
  api('GET', url).then(function (pv) {
    var s = JSON.stringify(pv.card, null, 2);
    count.textContent = s.length + ' 字符（约 ' + Math.round(s.length / 2) + ' token 量级，仅供感觉）';
    pre.textContent = s;
  }).catch(function (e) { pre.textContent = '预览失败: ' + e.message; });
}
function editor(title, value, onSave, hint) {
  var pane = el('pane');
  pane.innerHTML = '';
  var h = document.createElement('div');
  h.className = 'row';
  var strong = document.createElement('strong');
  strong.textContent = title;
  var cnt = document.createElement('span');
  cnt.className = 'muted';
  cnt.textContent = value.length + ' 字符';
  h.appendChild(strong);
  if (hint) {
    var hs = document.createElement('span');
    hs.className = 'muted';
    hs.textContent = hint;
    h.appendChild(hs);
  }
  h.appendChild(cnt);
  var ta = document.createElement('textarea');
  ta.value = value;
  ta.oninput = function () { cnt.textContent = ta.value.length + ' 字符'; };
  var row = document.createElement('div');
  row.className = 'row';
  var save = document.createElement('button');
  save.className = 'primary';
  save.textContent = '保存';
  save.onclick = function () { var content = ta.value; saveEditor(save, function () { return onSave(content); }, title); };
  row.appendChild(save);
  pane.appendChild(h); pane.appendChild(ta); pane.appendChild(row);
}
function renderPane() {
  rememberEditorDraft(); currentEditorSession = null;
  var v = state.view, t = state.tree;
  var targetName = state.name;
  if (v.kind === 'text') return editor(LABELS[v.key] || v.key, t.texts[v.key], function (c) { return api('POST', '/api/save/' + encodeURIComponent(targetName), { kind: 'text', key: v.key, content: c }); }, v.key);
  if (v.kind === 'note') return editor('创作说明', t.note, function (c) { return api('POST', '/api/save/' + encodeURIComponent(targetName), { kind: 'note', content: c }); }, '创作说明.md');
  if (v.kind === 'index') return editor('卡片信息', t.index, function (c) { return api('POST', '/api/save/' + encodeURIComponent(targetName), { kind: 'index', content: c }); }, 'src/index.yaml');
  if (v.kind === 'extra') return editor('扩展字段', t.extra, function (c) { return api('POST', '/api/save/' + encodeURIComponent(targetName), { kind: 'extra', content: c }); }, 'src/extra.json');
  if (v.kind === 'greeting') {
    var g = t.greetings.find(function (x) { return x.file === v.key; });
    return editor('备选开场 · ' + v.key, g ? g.content : '', function (c) { return api('POST', '/api/save/' + encodeURIComponent(targetName), { kind: 'greeting', key: v.key, content: c }); });
  }
  if (v.kind === 'greeting-new') {
    return editor('新备选开场（保存后创建）', '', function (c) { return api('POST', '/api/save/' + encodeURIComponent(targetName), { kind: 'greeting-new', content: c }); });
  }
  if (v.kind === 'entry') {
    var bk = t.books.find(function (b) { return b.book === v.book; });
    var e = bk && bk.entries.find(function (x) { return x.base === v.base; });
    var pane = el('pane');
    pane.innerHTML = '';
    var h = document.createElement('div'); h.className = 'row'; var title = document.createElement('strong'); title.textContent = v.book + ' / ' + v.base; h.appendChild(title);
    var ta1 = document.createElement('textarea'); ta1.value = e ? e.content : ''; ta1.style.flex = '3';
    var lab = document.createElement('div'); lab.className = 'muted'; lab.textContent = '侧车 yaml（keys / constant / insertion_order / enabled …）';
    var ta2 = document.createElement('textarea'); ta2.value = e ? e.side : ''; ta2.style.flex = '1';
    var row = document.createElement('div'); row.className = 'row';
    var save = document.createElement('button'); save.className = 'primary'; save.textContent = '保存条目';
    save.onclick = function () {
      var payload = { kind: 'entry-pair', book: v.book, base: v.base, content: ta1.value, side: ta2.value };
      saveEditor(save, function () { return api('POST', '/api/save/' + encodeURIComponent(targetName), payload); }, v.base);
    };
    row.appendChild(save);
    pane.appendChild(h); pane.appendChild(ta1); pane.appendChild(lab); pane.appendChild(ta2); pane.appendChild(row);
    return;
  }
  if (v.kind === 'entry-new-any') {
    var pane3 = el('pane');
    pane3.innerHTML = '';
    var h3 = document.createElement('div');
    h3.className = 'row';
    h3.innerHTML = '<strong>新建世界书条目</strong>';
    var lab3 = document.createElement('span');
    lab3.className = 'muted';
    lab3.textContent = '世界书名（不存在则新建）';
    var bi = document.createElement('input');
    bi.value = (t.books[0] && t.books[0].book) || '默认世界书';
    bi.style.width = '220px';
    var ta3 = document.createElement('textarea');
    ta3.placeholder = '条目正文：只写事实，一段一个主题…';
    var row3 = document.createElement('div');
    row3.className = 'row';
    var sv3 = document.createElement('button');
    sv3.className = 'primary';
    sv3.textContent = '创建条目';
    sv3.onclick = function () {
      var payload = { kind: 'entry-new', book: bi.value, content: ta3.value };
      saveEditor(sv3, function () { return api('POST', '/api/save/' + encodeURIComponent(targetName), payload); }, bi.value, true);
    };
    row3.appendChild(sv3);
    pane3.appendChild(h3); pane3.appendChild(lab3); pane3.appendChild(bi); pane3.appendChild(ta3); pane3.appendChild(row3);
    return;
  }
  if (v.kind === 'p-index') return editor('参数 index.yaml', t.index, function (c) { return api('POST', '/api/preset-save/' + encodeURIComponent(targetName), { kind: 'index', content: c }); }, 'src/index.yaml');
  if (v.kind === 'p-extra') return editor('扩展 extra.json', t.extra, function (c) { return api('POST', '/api/preset-save/' + encodeURIComponent(targetName), { kind: 'extra', content: c }); }, 'src/extra.json');
  if (v.kind === 'p-order') return editor('顺序 order.json', t.order, function (c) { return api('POST', '/api/preset-save/' + encodeURIComponent(targetName), { kind: 'order', content: c }); }, '按角色分组的结构，慎改');
  if (v.kind === 'p-prompt') {
    var pp = t.prompts.find(function (x) { return x.base === v.base; });
    return dualEditor('提示词条目 · ' + v.base, pp ? pp.content : null, pp ? pp.side : '', function (content, side) {
      return api('POST', '/api/preset-save/' + encodeURIComponent(targetName), { kind: 'prompt-pair', base: v.base, content: pp && pp.content == null && content === '' ? null : content, side: side });
    });
  }
  if (v.kind === 'p-preview') return previewPane('/api/preset-preview/' + encodeURIComponent(state.name));
  if (v.kind === 'b-index') return editor('参数 index.yaml', t.index, function (c) { return api('POST', '/api/worldbook-save/' + encodeURIComponent(targetName), { kind: 'index', content: c }); }, 'src/index.yaml');
  if (v.kind === 'b-extra') return editor('扩展 extra.json', t.extra, function (c) { return api('POST', '/api/worldbook-save/' + encodeURIComponent(targetName), { kind: 'extra', content: c }); }, 'src/extra.json');
  if (v.kind === 'b-entry') {
    var be = t.entries.find(function (x) { return x.base === v.base; });
    return dualEditor('世界书条目 · ' + v.base, be ? be.content : null, be ? be.side : '', function (content, side) {
      return api('POST', '/api/worldbook-save/' + encodeURIComponent(targetName), { kind: 'entry-pair', base: v.base, content: content, side: side });
    });
  }
  if (v.kind === 'b-preview') return previewPane('/api/worldbook-preview/' + encodeURIComponent(state.name));
  if (v.kind === 'preview') return previewPane('/api/preview/' + encodeURIComponent(state.name));
  if (v.kind === 'diagnose') return diagnosePane();
}
// ---------- 模块单开：picker（用户手操）；@open 负责定位左侧制作阶段 ----------
function resolveView(token) {
  var t = state.tree;
  if (!t || !token) return null;
  token = String(token).trim();
  if (state.block === 'card') {
    var keys = Object.keys(t.texts || {});
    for (var i = 0; i < keys.length; i++) if (keys[i] === token || (LABELS[keys[i]] || '') === token) return { kind: 'text', key: keys[i] };
    if (token === '创作说明') return { kind: 'note' };
    if (token === '卡片信息') return { kind: 'index' };
    if (token === '扩展字段' || token === '扩展') return { kind: 'extra' };
    if (token === '内容诊断' || token === '诊断') return { kind: 'diagnose' };
    if (token === '预览' || token === '预览成品') return { kind: 'preview' };
    for (var g = 0; g < (t.greetings || []).length; g++) if (t.greetings[g].file === token || ('备选开场 · ' + t.greetings[g].file) === token) return { kind: 'greeting', key: t.greetings[g].file };
    if (token === '新备选开场' || token === '＋ 备选开场') return { kind: 'greeting-new' };
    for (var b = 0; b < (t.books || []).length; b++) for (var e = 0; e < t.books[b].entries.length; e++) {
      var en = t.books[b].entries[e];
      if (en.base === token || (t.books[b].book + ' · ' + en.base) === token) return { kind: 'entry', book: t.books[b].book, base: en.base };
    }
    if (token === '新建世界书条目' || token === '＋ 新建世界书条目') return { kind: 'entry-new-any' };
  } else if (state.block === 'preset') {
    if (token === '参数 index.yaml' || token === 'index') return { kind: 'p-index' };
    if (token === '扩展 extra.json' || token === 'extra') return { kind: 'p-extra' };
    if (token === '顺序 order.json' || token === 'order') return { kind: 'p-order' };
    for (var p = 0; p < (t.prompts || []).length; p++) if (t.prompts[p].base === token) return { kind: 'p-prompt', base: t.prompts[p].base };
    if (token === '预览成品' || token === '预览') return { kind: 'p-preview' };
  } else {
    if (token === '参数 index.yaml' || token === 'index') return { kind: 'b-index' };
    if (token === '扩展 extra.json' || token === 'extra') return { kind: 'b-extra' };
    for (var q = 0; q < (t.entries || []).length; q++) if (t.entries[q].base === token) return { kind: 'b-entry', base: t.entries[q].base };
    if (token === '预览成品' || token === '预览') return { kind: 'b-preview' };
  }
  return null;
}
function pickerOptions() {
  var t = state.tree, out = [];
  if (!t) return out;
  if (state.block === 'preset') {
    out.push({ label: '参数 index.yaml', view: { kind: 'p-index' } });
    out.push({ label: '扩展 extra.json', view: { kind: 'p-extra' } });
    out.push({ label: '顺序 order.json', view: { kind: 'p-order' } });
    (t.prompts || []).forEach(function (p) { out.push({ label: p.base, view: { kind: 'p-prompt', base: p.base } }); });
    out.push({ label: '预览成品', view: { kind: 'p-preview' } });
    return out;
  }
  if (state.block === 'book') {
    out.push({ label: '参数 index.yaml', view: { kind: 'b-index' } });
    out.push({ label: '扩展 extra.json', view: { kind: 'b-extra' } });
    (t.entries || []).forEach(function (e) { out.push({ label: e.base, view: { kind: 'b-entry', base: e.base } }); });
    out.push({ label: '预览成品', view: { kind: 'b-preview' } });
    return out;
  }
  out.push({ label: '创作说明', view: { kind: 'note' } });
  Object.keys(t.texts || {}).forEach(function (f) { out.push({ label: LABELS[f] || f, view: { kind: 'text', key: f } }); });
  (t.greetings || []).forEach(function (g) { out.push({ label: '备选开场 · ' + g.file, view: { kind: 'greeting', key: g.file } }); });
  out.push({ label: '＋ 备选开场', view: { kind: 'greeting-new' } });
  (t.books || []).forEach(function (bk) { bk.entries.forEach(function (e) { out.push({ label: bk.book + ' · ' + e.base, view: { kind: 'entry', book: bk.book, base: e.base } }); }); });
  out.push({ label: '＋ 新建世界书条目', view: { kind: 'entry-new-any' } });
  out.push({ label: '卡片信息', view: { kind: 'index' } });
  out.push({ label: '扩展字段', view: { kind: 'extra' } });
  out.push({ label: '✦ 内容诊断', view: { kind: 'diagnose' } });
  out.push({ label: '预览成品', view: { kind: 'preview' } });
  return out;
}
function editorSelectionKey(block, name) { return JSON.stringify([block, name]); }
function editorViewAvailable(view) {
  return !!view && pickerOptions().some(function (option) { return JSON.stringify(option.view) === JSON.stringify(view); });
}
function appendEditorToolbar(pane, closable) {
  var toolbar = document.createElement('div'); toolbar.className = 'editor-toolbar';
  var pick = document.createElement('button'); pick.id = 'btn-edit-picker'; pick.textContent = '打开模块 ▾';
  pick.disabled = !state.name || !state.tree;
  pick.onclick = function () { showPicker(pick); };
  toolbar.appendChild(pick);
  if (closable) {
    var close = document.createElement('button'); close.textContent = '✕ 关闭模块';
    close.onclick = function () { closeModule(); };
    toolbar.appendChild(close);
  }
  pane.insertBefore(toolbar, pane.firstChild);
}
function showEditorEmpty(message) {
  var pane = el('pane'); pane.innerHTML = '';
  appendEditorToolbar(pane, false);
  var empty = document.createElement('div'); empty.className = 'editor-empty';
  empty.textContent = message || (state.name && state.tree ? '从左侧目录选择要编辑的内容，或使用“打开模块”。' : '请先从工作区选择或新建内容。');
  pane.appendChild(empty);
}
function ensureEditPane(view) {
  if (!state.name || !state.tree) { closeModule(); return; }
  var key = editorSelectionKey(state.block, state.name);
  var active = state.viewOwner && state.viewOwner.block === state.block && state.viewOwner.name === state.name ? state.view : null;
  var selected = [view, active, editorSelections.get(key)].find(editorViewAvailable);
  if (!selected) {
    if (state.block === 'card') {
      var fields = Object.keys(state.tree.texts || {});
      selected = fields.length ? { kind: 'text', key: fields.indexOf('description') >= 0 ? 'description' : fields[0] } : { kind: 'index' };
    } else if (state.block === 'preset') {
      var prompt = (state.tree.prompts || [])[0];
      selected = prompt ? { kind: 'p-prompt', base: prompt.base } : { kind: 'p-index' };
    } else {
      var entry = (state.tree.entries || [])[0];
      selected = entry ? { kind: 'b-entry', base: entry.base } : { kind: 'b-index' };
    }
  }
  openModule(selected);
}
function editorSourceValues(view, tree) {
  var kind = view.kind, item;
  if (kind === 'text') return [tree.texts[view.key]];
  if (kind === 'note') return [tree.note];
  if (kind === 'index' || kind === 'p-index' || kind === 'b-index') return [tree.index];
  if (kind === 'extra' || kind === 'p-extra' || kind === 'b-extra') return [tree.extra];
  if (kind === 'p-order') return [tree.order];
  if (kind === 'greeting') { item = tree.greetings.find(function (row) { return row.file === view.key; }); return [item.content]; }
  if (kind === 'entry') { var book = tree.books.find(function (row) { return row.book === view.book; }); item = book.entries.find(function (row) { return row.base === view.base; }); return [item.content, item.side]; }
  if (kind === 'p-prompt' || kind === 'b-entry') {
    item = (kind === 'p-prompt' ? tree.prompts : tree.entries).find(function (row) { return row.base === view.base; });
    return [item.content == null ? '' : item.content, item.side];
  }
  return null;
}
function refreshEditPane() {
  if (state.mode !== 'edit' || !state.view) return;
  if (!editorViewAvailable(state.view)) { ensureEditPane(); revealEditorSelection(); return; }
  var session = currentEditorSession, values = editorSourceValues(state.view, state.tree);
  if (values) values = values.map(function (value) { return String(value == null ? '' : value).replace(/\\r\\n?/g, '\\n'); });
  if (!session || !values || JSON.stringify(values) === JSON.stringify(session.initial)) return;
  var focused = session.inputs.indexOf(document.activeElement);
  var input = focused >= 0 ? session.inputs[focused] : null;
  var start = input && input.selectionStart, end = input && input.selectionEnd, scroll = input && input.scrollTop;
  openModule(state.view);
  var restored = focused >= 0 && currentEditorSession && currentEditorSession.inputs[focused];
  if (restored) { restored.focus({ preventScroll: true }); if (typeof start === 'number') restored.setSelectionRange(start, end); restored.scrollTop = scroll; }
}
function openModule(view) {
  if (!view || !state.tree || !state.name) return;
  rememberEditorDraft();
  state.view = view;
  state.viewOwner = { block: state.block, name: state.name };
  editorSelections.set(editorSelectionKey(state.block, state.name), Object.assign({}, view));
  renderPane();
  bindEditorDraft();
  var pane = el('pane');
  pane.classList.add('open');
  appendEditorToolbar(pane, true);
  revealEditorSelection();
}
function closeModule(message) {
  rememberEditorDraft(); currentEditorSession = null;
  state.view = null; state.viewOwner = null;
  var picker = el('picker-pop'); if (picker) picker.remove();
  var pane = el('pane');
  pane.classList.remove('open');
  pane.innerHTML = '';
  if (state.mode === 'edit') showEditorEmpty(typeof message === 'string' ? message : '');
  updateEditorTreeSelection();
}
function refreshChip() {
  var chip = document.getElementById('llm-chip');
  if (!chip) return;
  api('GET', '/api/bridge/llm-status').then(function (s) {
    if (!s.configured) chip.textContent = '未启用自动回复 · 打开接入设置';
    else if (s.backend === 'codex') chip.textContent = 'Codex 对话桥：' + (s.codexModel || DEFAULT_CODEX_MODEL) + ' · ' + (REASONING_LABELS[s.codexReasoningEffort] || '跟随 Codex 设置');
    else chip.textContent = 'API 自动回复：' + (s.model || '已配置模型') + (s.running ? '（运行中）' : '（未运行）');
    chip.title = chip.textContent;
    var button = el('btn-chat-settings');
    if (button) button.title = chip.textContent || '选择本机 Codex 账号额度或 OpenAI 兼容端口';
  }).catch(function () { chip.textContent = ''; });
}
var llmCfgRequestSeq = 0, llmCfgReturnFocus = null;
function restoreVisibleToolFocus(target, fallback) {
  var candidates = [target, fallback, el('chat-input'), el('btn-workspace')];
  for (var i = 0; i < candidates.length; i++) {
    var node = candidates[i];
    if (!node || node === document.body || node === document.documentElement || !document.body.contains(node) || node.disabled || !node.getClientRects().length) continue;
    node.focus();
    if (document.activeElement === node) return;
  }
}
function closeLlmCfg(moveFocus) {
  ++llmCfgRequestSeq;
  var old = el('llm-cfg-pop'); if (old) old.remove();
  if (moveFocus !== false) restoreVisibleToolFocus(llmCfgReturnFocus, el('btn-chat-settings'));
  llmCfgReturnFocus = null;
}
function openLlmCfg() {
  var old = document.getElementById('llm-cfg-pop');
  if (old) { closeLlmCfg(); return; }
  llmCfgReturnFocus = document.activeElement;
  closeViewer(false);
  setSidebar('', false);
  var requestSeq = ++llmCfgRequestSeq;
  api('GET', '/api/bridge/llm-status').then(function (s) {
    if (requestSeq !== llmCfgRequestSeq) return;
    var pop = document.createElement('div');
    pop.id = 'llm-cfg-pop';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'true'); pop.setAttribute('aria-label', '接入设置');
    pop.style.cssText = 'position:fixed;z-index:60;top:64px;right:16px;width:min(390px,calc(100vw - 32px));max-height:calc(100vh - 80px);overflow:auto;padding:14px;border:1px solid var(--star-border);border-radius:12px;background:var(--star-card-strong);box-shadow:var(--star-shadow);display:flex;flex-direction:column;gap:8px;';
    var heading = document.createElement('div'); heading.className = 'sidebar-heading';
    var title = document.createElement('strong'); title.textContent = '接入设置'; title.style.flex = '1';
    var close = document.createElement('button'); close.id = 'llm-cfg-close'; close.textContent = '收起'; close.onclick = function () { closeLlmCfg(); };
    heading.appendChild(title); heading.appendChild(close); pop.appendChild(heading);
    pop.onkeydown = function (event) {
      if (event.key === 'Escape') { event.preventDefault(); closeLlmCfg(); }
      if (event.key === 'Tab') {
        var nodes = Array.from(pop.querySelectorAll('button, input, select')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
        var first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    function row(label, input) {
      var d = document.createElement('label');
      d.style.cssText = 'display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--star-muted);';
      d.appendChild(document.createTextNode(label));
      d.appendChild(input);
      pop.appendChild(d);
      return input;
    }
    var bkWrap = document.createElement('div');
    bkWrap.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;';
    function radio(val, label, checked) {
      var l = document.createElement('label');
      l.style.cssText = 'display:flex;gap:4px;align-items:center;';
      var r = document.createElement('input');
      r.type = 'radio'; r.name = 'llm-backend'; r.value = val; r.checked = checked;
      l.appendChild(r);
      l.appendChild(document.createTextNode(label));
      bkWrap.appendChild(l);
      return r;
    }
    var rc = radio('codex', 'ChatGPT / Codex', s.backend !== 'openai');
    var ro = radio('openai', '外部 OpenAI 端口', s.backend === 'openai');
    pop.appendChild(bkWrap);
    var bu = row('baseUrl（OpenAI 兼容端口；留空 = 不自动回复）', document.createElement('input'));
    bu.value = s.baseUrl || ''; bu.placeholder = 'http://127.0.0.1:11434/v1';
    var buRow = bu.parentNode;
    var kk = row('apiKey（可留空）', document.createElement('input'));
    kk.type = 'password'; kk.placeholder = s.hasKey ? '已保存（重填以覆盖）' : '可留空';
    var kkRow = kk.parentNode;
    var mo = row('model', document.createElement('input')); mo.value = s.model || '';
    var moRow = mo.parentNode;
    var tp = row('temperature', document.createElement('input')); tp.type = 'number'; tp.step = '0.1'; tp.value = String(s.temperature);
    var tpRow = tp.parentNode;
    var cm = row('Codex 模型', document.createElement('select'));
    var cmCustom = document.createElement('input');
    cmCustom.type = 'text'; cmCustom.value = s.codexModel || DEFAULT_CODEX_MODEL; cmCustom.placeholder = '输入模型 ID，如 ' + DEFAULT_CODEX_MODEL;
    cmCustom.autocomplete = 'off'; cmCustom.style.display = 'none';
    cm.parentNode.appendChild(cmCustom);
    var codexModelsLoaded = false;
    var codexModelCatalog = [];
    var codexCatalogReady = false;
    var cr = row('Codex 思考档位', document.createElement('select'));
    var crRow = cr.parentNode;
    var reasoningHint = document.createElement('div');
    reasoningHint.className = 'muted';
    reasoningHint.style.cssText = 'font-size:11.5px;';
    crRow.appendChild(reasoningHint);
    var cp = row('本地代理地址', document.createElement('input'));
    cp.id = 'llm-codex-proxy'; cp.type = 'url'; cp.value = s.codexProxyUrl || '';
    cp.placeholder = 'http://127.0.0.1:7890'; cp.autocomplete = 'off';
    var cpRow = cp.parentNode;
    var proxyHint = document.createElement('div');
    proxyHint.className = 'muted'; proxyHint.style.cssText = 'font-size:11.5px;';
    proxyHint.textContent = '留空自动选择代理；填写后优先使用此本地地址，保存后对新请求生效。';
    cpRow.appendChild(proxyHint);
    var project = row('Codex 项目目录', document.createElement('input'));
    project.id = 'llm-codex-project'; project.type = 'text'; project.value = s.codexProjectPath || '';
    project.placeholder = '现有项目的绝对路径'; project.autocomplete = 'off';
    var projectRow = project.parentNode;
    var projectHint = document.createElement('div');
    projectHint.className = 'muted'; projectHint.style.cssText = 'font-size:11.5px;';
    projectHint.textContent = '填写后为每段创作对话保留归属该项目的 Codex 长对话；留空使用临时对话。卡片与聊天数据位置不变。';
    projectRow.appendChild(projectHint);
    function selectedCodexModel() { return cm.value === '__custom__' ? cmCustom.value.trim() : cm.value; }
    function setReasoningChoices(chosen) {
      var previous = typeof chosen === 'string' ? chosen : cr.value;
      var selectedModel = selectedCodexModel();
      var model = codexModelCatalog.find(function (entry) { return entry.id === selectedModel; });
      var levels = model && Array.isArray(model.reasoningLevels) ? model.reasoningLevels : selectedModel === DEFAULT_CODEX_MODEL || !codexCatalogReady ? CODEX_REASONING_LEVELS : [];
      cr.innerHTML = '';
      var follow = document.createElement('option');
      follow.value = ''; follow.textContent = '跟随 Codex 设置'; cr.appendChild(follow);
      CODEX_REASONING_LEVELS.forEach(function (level) {
        if (levels.indexOf(level) < 0) return;
        var option = document.createElement('option');
        option.value = level; option.textContent = REASONING_LABELS[level]; cr.appendChild(option);
      });
      var unsupported = previous && levels.indexOf(previous) < 0;
      cr.value = unsupported ? '' : previous;
      cr.disabled = !levels.length;
      reasoningHint.textContent = unsupported ? '当前模型未列出“' + (REASONING_LABELS[previous] || previous) + '”的支持，已改为跟随 Codex 设置。保存后生效。' : !levels.length ? '没有读到这个模型支持的思考档位，暂时跟随 Codex 设置。' : '仅影响本程序的新请求，高档位通常需要更多时间。';
    }
    function setCodexModelChoices(models) {
      var selected = cmCustom.value || (cm.value !== '__custom__' ? cm.value : '') || DEFAULT_CODEX_MODEL;
      codexModelCatalog = Array.isArray(models) ? models : [];
      cm.innerHTML = '';
      var defaultOption = document.createElement('option');
      defaultOption.value = DEFAULT_CODEX_MODEL; defaultOption.textContent = 'GPT-6.1 Sol（默认）';
      cm.appendChild(defaultOption);
      var modelIds = new Set([DEFAULT_CODEX_MODEL]);
      (Array.isArray(models) ? models : []).forEach(function (model) {
        if (!model || !model.id || modelIds.has(model.id)) return;
        modelIds.add(model.id);
        var option = document.createElement('option');
        option.value = model.id; option.textContent = model.label || model.id;
        cm.appendChild(option);
      });
      var customOption = document.createElement('option');
      customOption.value = '__custom__'; customOption.textContent = '自选模型 ID…';
      cm.appendChild(customOption);
      if (selected && Array.prototype.some.call(cm.options, function (option) { return option.value === selected; })) {
        cm.value = selected;
      } else if (selected) {
        cm.value = '__custom__'; cmCustom.value = selected;
      } else {
        cm.value = DEFAULT_CODEX_MODEL;
      }
      cmCustom.style.display = cm.value === '__custom__' ? '' : 'none';
      cm.disabled = false;
    }
    cm.onchange = function () {
      cmCustom.style.display = cm.value === '__custom__' ? '' : 'none';
      if (cm.value !== '__custom__') cmCustom.value = cm.value;
      setReasoningChoices();
    };
    cmCustom.onchange = cmCustom.oninput = function () { setReasoningChoices(); };
    setCodexModelChoices([]);
    setReasoningChoices(s.codexReasoningEffort || '');
    var cmRow = cm.parentNode;
    var hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:11.5px;';
    hint.textContent = '使用本机 ChatGPT 登录的 Codex CLI 额度；不会读取密钥或调用 API key 计费。写卡代理的可写范围仅为当前选中卡片 src。';
    pop.appendChild(hint);
    var stRow = document.createElement('div');
    stRow.className = 'muted';
    stRow.id = 'llm-bridge-state';
    stRow.style.cssText = 'font-size:11.5px;';
    pop.appendChild(stRow);
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;';
    var det = document.createElement('button');
    det.textContent = '探测本机模型服务';
    det.title = '扫 11434/8080/8081/1234/8000/5000 的 /v1/models，找到就一键填入';
    det.onclick = function () {
      det.disabled = true;
      det.textContent = '探测中…';
      api('GET', '/api/bridge/detect').then(function (r) {
        det.disabled = false;
        det.textContent = '探测本机模型服务';
        if (!r.found || !r.found.length) { log('本机没发现 OpenAI 兼容模型服务（11434/8080/8081/1234/8000/5000）；请先起一个（如 ollama serve）或手填远程端口', 'warn'); return; }
        var f = r.found[0];
        bu.value = f.baseUrl;
        if (f.models && f.models.length) mo.value = f.models[0];
        log('已填入：' + f.baseUrl + (f.models && f.models.length ? ' / ' + f.models[0] : '') + '（探测到 ' + r.found.length + ' 个服务）', 'okc');
      }).catch(function (e) {
        det.disabled = false;
        det.textContent = '探测本机模型服务';
        log('探测失败: ' + e.message, 'err');
      });
    };
    btnRow.appendChild(det);
    pop.appendChild(btnRow);
    var codexCheck = document.createElement('button');
    codexCheck.textContent = '检查 Codex 登录';
    codexCheck.onclick = function () {
      codexCheck.disabled = true;
      api('GET', '/api/bridge/codex-status').then(function (c) {
        codexCheck.disabled = false;
        var ok = c.authenticated && c.authMethod === 'ChatGPT';
        stRow.textContent = !c.installed || !c.authenticated ? c.error : ok ? '已检测到 ChatGPT 登录' : '当前是 ' + c.authMethod + ' 登录；此桥仅接受 ChatGPT 登录';
        log(stRow.textContent, ok ? 'okc' : 'warn');
      }).catch(function (e) { codexCheck.disabled = false; log('检查失败: ' + e.message, 'err'); });
    };
    pop.appendChild(codexCheck);
    function pullState() {
      if (rc.checked) {
        Promise.all([api('GET', '/api/bridge/codex-status'), api('GET', '/api/bridge/bridge-status')]).then(function (v) {
          var c = v[0], b = v[1].codex || {};
          stRow.textContent = !c.installed || !c.authenticated ? c.error : c.authMethod !== 'ChatGPT' ? 'Codex 当前使用 ' + c.authMethod + ' 登录；请改用 ChatGPT 登录' : b.enabled ? (b.running ? 'Codex · 正在回复 · 排队 ' + b.queued : 'Codex · 已启用') : '已检测到 ChatGPT 登录 · 自动回复未启用';
        }).catch(function () {});
      } else {
        api('GET', '/api/bridge/bridge-status').then(function (b) {
          stRow.textContent = '桥状态：' + (b.running ? '运行中（自动回复已接管）' : '未运行');
        }).catch(function () {});
      }
    }
    function refreshBackendForm() {
      var backend = rc.checked ? 'codex' : 'openai';
      buRow.style.display = kkRow.style.display = moRow.style.display = tpRow.style.display = backend === 'openai' ? '' : 'none';
      cmRow.style.display = backend === 'codex' ? '' : 'none';
      crRow.style.display = backend === 'codex' ? '' : 'none';
      cpRow.style.display = backend === 'codex' ? '' : 'none';
      projectRow.style.display = backend === 'codex' ? '' : 'none';
      hint.textContent = backend === 'codex'
        ? '使用本机 ChatGPT 登录的 Codex CLI 额度；不会读取密钥或调用 API key 计费。写卡代理的可写范围仅为当前选中卡片 src。'
        : '使用你填写的 OpenAI 兼容 API。';
      btnRow.style.display = backend === 'openai' ? 'flex' : 'none';
      codexCheck.style.display = backend === 'codex' ? '' : 'none';
      if (backend === 'codex' && !codexModelsLoaded) {
        codexModelsLoaded = true;
        cm.disabled = true;
        api('GET', '/api/bridge/codex-models').then(function (models) {
          codexCatalogReady = true;
          setCodexModelChoices(models);
          setReasoningChoices();
          if (!Array.isArray(models) || !models.length) log('没读到本机 Codex 模型目录；仍可选择 GPT-6.1 Sol 或自选模型 ID', 'warn');
        }).catch(function () {
          codexCatalogReady = true;
          setCodexModelChoices([]);
          setReasoningChoices();
          log('读取 Codex 模型目录失败；仍可选择 GPT-6.1 Sol 或自选模型 ID', 'warn');
        });
      }
      pullState();
    }
    ro.onchange = rc.onchange = refreshBackendForm;
    refreshBackendForm();
    var sv = document.createElement('button');
    sv.id = 'llm-save-enable'; sv.className = 'primary'; sv.textContent = '保存并启用';
    var disable = document.createElement('button'); disable.id = 'llm-disable'; disable.textContent = '停用自动回复'; disable.hidden = !s.enabled;
    var configError = document.createElement('div'); configError.id = 'llm-config-error'; configError.className = 'err'; configError.setAttribute('role', 'alert');
    function saveConfig(enabled) {
      var backend = rc.checked ? 'codex' : 'openai';
      if (enabled && backend === 'codex' && !codexCatalogReady) { configError.textContent = '正在读取 Codex 模型，请稍后保存。'; return; }
      var codexModel = selectedCodexModel();
      var temperature = Number(tp.value);
      var config = { enabled: enabled, backend: backend, baseUrl: bu.value, apiKey: kk.value, model: mo.value, codexModel: codexModel, codexProxyUrl: cp.value, codexProjectPath: project.value, temperature: tp.value.trim() && Number.isFinite(temperature) ? temperature : 0.7 };
      if (backend === 'codex') config.codexReasoningEffort = cr.value;
      sv.disabled = disable.disabled = true; configError.textContent = '';
      api('POST', enabled ? '/api/bridge/llm-config' : '/api/bridge/bridge-stop', enabled ? config : {})
        .then(function (st) { if (document.body.contains(pop)) closeLlmCfg(); log(st.configured ? ('已启用：' + (st.backend === 'codex' ? 'ChatGPT / Codex' : st.model + (st.running ? '（运行中）' : ''))) : '已停用自动回复', 'okc'); if (window.__refreshPersona) window.__refreshPersona(); else refreshChip(); })
        .catch(function (e) { configError.textContent = '保存失败：' + e.message; log(configError.textContent, 'err'); })
        .finally(function () { sv.disabled = disable.disabled = false; });
    }
    sv.onclick = function () { saveConfig(true); };
    disable.onclick = function () { saveConfig(false); };
    // 表单独立滚动，保存操作固定可见，避免小窗口漏掉启用步骤。
    var fields = document.createElement('div'); fields.style.cssText = 'overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px;';
    Array.from(pop.children).filter(function (node) { return node !== heading; }).forEach(function (node) { fields.appendChild(node); });
    var actions = document.createElement('div'); actions.style.cssText = 'display:flex;flex-direction:column;gap:8px;flex-shrink:0;';
    actions.appendChild(configError); actions.appendChild(sv); actions.appendChild(disable);
    pop.style.overflow = 'hidden'; heading.style.flexShrink = '0';
    pop.appendChild(fields); pop.appendChild(actions);
    document.body.appendChild(pop);
    if (window.__workbenchRevealDialog) window.__workbenchRevealDialog();
    close.focus();
  }).catch(function (error) { if (requestSeq === llmCfgRequestSeq) log('接入设置载入失败：' + error.message, 'err'); });
}
function makeChatAvatar(id, name) {
  var entry = chatAvatars[id] || { url: '', label: id === 'user' ? '你' : Array.from(name || '助手')[0] };
  var avatar = document.createElement('div');
  avatar.className = 'chat-avatar';
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', name + '的头像');
  if (entry.url) {
    var img = document.createElement('img');
    img.alt = ''; img.src = entry.url;
    img.onerror = function () { img.remove(); avatar.textContent = entry.label; };
    avatar.appendChild(img);
  } else avatar.textContent = entry.label;
  return avatar;
}
function openChatAvatarSettings() {
  var old = document.getElementById('chat-avatar-dialog');
  if (old) { old.remove(); return; }
  var overlay = document.createElement('div');
  overlay.id = 'chat-avatar-dialog';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '聊天头像设置');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(9,17,39,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
  var panel = document.createElement('div');
  panel.style.cssText = 'width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;display:flex;flex-direction:column;gap:9px;padding:18px;border:1px solid var(--star-border);border-radius:16px;background:var(--star-card-strong);box-shadow:var(--star-shadow);';
  var title = document.createElement('strong'); title.textContent = '聊天头像';
  var hint = document.createElement('div'); hint.className = 'muted';
  hint.textContent = 'PNG、JPEG 或 WebP，每张不超过 4 MiB。图片保存在本机，仅用于聊天显示。';
  var status = document.createElement('div'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  var avatarRows = document.createElement('div');
  var close = document.createElement('button'); close.textContent = '完成'; close.onclick = function () { overlay.remove(); };
  panel.appendChild(title); panel.appendChild(hint); panel.appendChild(avatarRows); panel.appendChild(status); panel.appendChild(close);
  overlay.appendChild(panel); document.body.appendChild(overlay); close.focus();
  overlay.onclick = function (event) { if (event.target === overlay) overlay.remove(); };
  overlay.onkeydown = function (event) { if (event.key === 'Escape') overlay.remove(); };
  function paintRows() {
    avatarRows.innerHTML = '';
    [{ id: 'user', name: chatAvatars.user && chatAvatars.user.name || '你' }].concat(state.personaOptions).forEach(function (person) {
      var row = document.createElement('div'); row.className = 'avatar-dialog-row';
      row.appendChild(makeChatAvatar(person.id, person.name));
      var label = document.createElement('span'); label.className = 'avatar-name'; label.textContent = person.name; row.appendChild(label);
      var upload = document.createElement('button'); upload.textContent = '更换头像';
      var reset = document.createElement('button'); reset.textContent = '恢复默认';
      var input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
      function setBusy(busy) { upload.disabled = reset.disabled = busy; }
      function save(body) {
        setBusy(true); status.className = 'muted'; status.textContent = '正在保存' + person.name + '的头像…';
        var request = person.id === 'user' && window.__workbenchSaveUserAvatar
          ? window.__workbenchSaveUserAvatar(body) : api('POST', '/api/chat-avatar/' + person.id, body);
        request.then(function (mapping) {
          chatAvatars = mapping; status.className = 'okc'; status.textContent = person.name + '的头像已更新。';
          paintRows();
          if (window.__refreshChatAvatars) window.__refreshChatAvatars();
        }).catch(function (e) { setBusy(false); status.className = 'err'; status.textContent = '头像未更换：' + e.message; });
      }
      upload.onclick = function () { input.click(); };
      reset.onclick = function () { save({ reset: true }); };
      input.onchange = function () {
        var file = input.files[0]; input.value = '';
        if (!file) return;
        if (['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) < 0) { status.className = 'err'; status.textContent = '请选择 PNG、JPEG 或 WebP 图片。'; return; }
        if (file.size > 4 * 1024 * 1024) { status.className = 'err'; status.textContent = '这张图片超过 4 MiB，请先缩小后再上传。'; return; }
        setBusy(true);
        var reader = new FileReader();
        reader.onerror = function () { setBusy(false); status.className = 'err'; status.textContent = '无法读取这张图片，已有头像已保留。'; };
        reader.onload = function () { save({ mimeType: file.type, base64: String(reader.result).split(',')[1] }); };
        try { reader.readAsDataURL(file); } catch (e) { setBusy(false); status.className = 'err'; status.textContent = '无法读取这张图片：' + e.message; }
      };
      row.appendChild(upload); row.appendChild(reset); row.appendChild(input); avatarRows.appendChild(row);
    });
  }
  paintRows();
  api('GET', '/api/chat-avatars').then(function (mapping) { chatAvatars = mapping; if (document.body.contains(overlay)) paintRows(); }).catch(function (e) { status.className = 'err'; status.textContent = '头像设置读取失败：' + e.message; });
}
function copyChatText(text, button) {
  var copy = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text)
    : new Promise(function (resolve, reject) {
      var temporary = document.createElement('textarea'); temporary.value = text; temporary.style.cssText = 'position:fixed;left:-10000px;';
      document.body.appendChild(temporary); temporary.select();
      try { if (document.execCommand('copy')) resolve(); else reject(new Error('浏览器未允许复制，请手动选择文本复制')); }
      catch (e) { reject(e); }
      finally { temporary.remove(); }
    });
  copy.then(function () { button.textContent = '已复制'; }).catch(function (e) { log('复制失败：' + e.message, 'err'); });
}
function resetChatPanel(message) {
  rememberChatDraft();
  if (window.__chatStream) { window.__chatStream.dispose(); window.__chatStream = null; }
  if (window.__conversationManager) { window.__conversationManager.dispose(); window.__conversationManager = null; }
  if (window.__chatRecovery) { window.__chatRecovery.dispose(); window.__chatRecovery = null; }
  if (window.__chatTimer) clearInterval(window.__chatTimer);
  window.__rememberChatDraft = null; window.__refreshChat = null; window.__refreshChatStage = null;
  window.__refreshPersona = null; window.__refreshChatAvatars = null; window.__refreshFailedSends = null;
  el('chatmain').innerHTML = '';
  el('chatmain').appendChild(mutedLine(message));
}
function renderChat(focusConversationId, locateMessage) {
  rememberChatDraft();
  if (window.__chatStream) { window.__chatStream.dispose(); window.__chatStream = null; }
  if (window.__conversationManager) { window.__conversationManager.dispose(); window.__conversationManager = null; }
  if (window.__chatRecovery) { window.__chatRecovery.dispose(); window.__chatRecovery = null; }
  var previousActionDialog = el('chat-action-dialog');
  if (previousActionDialog && previousActionDialog.__close) previousActionDialog.__close(false);
  if (state.block !== 'card') {
    resetChatPanel('预设和独立世界书目前通过左侧内容编辑；对话与流程仅支持角色卡和世界卡。');
    return;
  }
  if (!state.name || !state.tree) { resetChatPanel('请先选择并载入一张角色卡或世界卡。'); return; }
  var root = el('chatmain');
  var chatCard = state.name;
  var chatBlock = state.block;
  function isChatCurrent() { return state.name === chatCard && state.block === chatBlock && document.body.contains(box); }
  root.innerHTML = '';
  var h = document.createElement('div');
  h.className = 'row chat-heading';
  var heading = document.createElement('strong');
  heading.textContent = state.personaName;
  h.appendChild(heading);
  var headingHint = document.createElement('span');
  headingHint.className = 'muted';
  headingHint.textContent = '同一张卡可保留多条对话；新对话会读取卡片已有的进度和内容。';
  h.appendChild(headingHint);
  var pick = document.createElement('button');
  pick.id = 'btn-chat-picker';
  pick.textContent = '打开模块 ▾';
  pick.onclick = function () { showPicker(pick); };
  if (state.mode === 'edit') h.appendChild(pick);
  var chip = document.createElement('span');
  chip.className = 'muted';
  chip.id = 'llm-chip';
  chip.style.cssText = 'margin-left:auto;font-size:12px;';
  h.appendChild(chip);
  var cfgBtn = document.createElement('button');
  cfgBtn.id = 'btn-chat-settings';
  cfgBtn.textContent = '接入设置';
  cfgBtn.title = '选择本机 Codex 账号额度或 OpenAI 兼容端口';
  cfgBtn.onclick = function () { openLlmCfg(); };
  h.appendChild(cfgBtn);
  refreshChip();
  var conversationBar = document.createElement('div');
  conversationBar.className = 'row conversation-bar';
  var conversationSelect = document.createElement('select');
  conversationSelect.style.cssText = 'min-width:0;flex:1;';
  conversationSelect.disabled = true;
  var newConversation = document.createElement('button');
  newConversation.textContent = '＋ 新对话';
  newConversation.title = '开启独立上下文，原有对话和卡片内容都会保留';
  conversationBar.appendChild(conversationSelect);
  conversationBar.appendChild(newConversation);
  conversationBar.appendChild(cfgBtn);
  if (state.mode === 'edit') conversationBar.appendChild(pick);
  var flowButton = null;
  if (state.mode === 'make') {
    var tools = document.createElement('div');
    tools.className = 'chat-tools';
    [{ id: 'flow', label: '制作流程' }, { id: 'done', label: '已保存内容' }, { id: 'reference', label: '写作参考' }].forEach(function (item) {
      var button = document.createElement('button');
      button.id = 'btn-chat-' + item.id;
      button.textContent = item.label;
      button.setAttribute('aria-controls', item.id);
      button.setAttribute('aria-expanded', String(state.sidebarOpen === item.id));
      button.onclick = function () { setSidebar(state.sidebarOpen === item.id ? '' : item.id); };
      if (item.id === 'flow') flowButton = button;
      tools.appendChild(button);
    });
    conversationBar.appendChild(tools);
  }
  var banner = document.createElement('div');
  banner.id = 'chat-module-banner';
  banner.className = 'muted';
  function setChatBanner(text) {
    banner.textContent = text; banner.title = text;
    if (flowButton) flowButton.title = text + '；点击查看制作流程';
    pick.title = text;
    conversationSelect.title = text;
  }
  setChatBanner('正在载入对话…');
  var box = document.createElement('div');
  box.className = 'chat-history';
  box.setAttribute('aria-label', '聊天记录');
  var ta = document.createElement('textarea');
  ta.id = 'chat-input'; ta.rows = 1;
  ta.setAttribute('aria-label', '发送给' + state.personaName + '的消息');
  ta.disabled = true;
  ta.placeholder = (state.personaId === 'neutral' ? '这次想写什么…' : '告诉' + state.personaName + '这次想写什么…') + '（Enter 发送，Shift+Enter 换行）';
  var chatError = document.createElement('div');
  chatError.className = 'err chat-error';
  chatError.setAttribute('role', 'alert');
  chatError.hidden = true;
  var chatErrorKind = '';
  var row = document.createElement('div');
  row.className = 'row chat-send-row';
  var sv = document.createElement('button');
  sv.id = 'chat-send';
  sv.className = 'primary';
  sv.textContent = '发送';
  sv.disabled = true;
  var conversationId = '';
  var draftKey = '', sending = false, replyActionPending = false, messageActionPending = false, refreshSeq = 0;
  var lastMessages = [], messageRows = new Map(), chatBusy = false, sendMode = '', inputComposing = false, personaRevision = 0;
  function resendMessage() {
    for (var index = lastMessages.length - 1; index >= 0; index--) {
      var message = lastMessages[index];
      if (message.pinned || message.pending || message.error) continue;
      if (message.role === 'user' && !message.retryOfAt) return message;
      if (message.role === 'agent' || message.role === 'assistant') return null;
    }
    return null;
  }
  function updateSendControls() {
    var message = !ta.value.trim() && resendMessage();
    var draft = message && chatEditDrafts.get(editKey(message));
    var savingEdit = Array.from(messageRows.values()).some(function (item) { return item.draft && item.draft.saving; });
    var waiting = lastMessages.some(function (item) { return item.pending; });
    sv.disabled = sending || replyActionPending || messageActionPending || savingEdit || ta.disabled || (chatBlock === 'card' && conversationSelect.disabled);
    if (!ta.value.trim() && waiting) sv.disabled = true;
    sv.textContent = sending ? (sendMode === 'resend' ? '重新发送中…' : '发送中…') : message && message.canResend ? (draft ? '保存并重新发送' : '重新发送') : '发送';
    sv.title = waiting && !ta.value.trim() ? '当前对话正在等待回复，请等待完成或先停止回复。'
      : message && message.canResend ? (draft ? '先保存上面这条消息的修改，再请求回复；不会新增重复的消息。' : '输入框为空，重新请求回复最后一条用户消息；不会新增重复的消息。')
      : message && message.resendBlockedReason ? message.resendBlockedReason : '发送输入框里的消息；空输入只重发尚未得到正常答复的最后一条用户消息。';
    sv.setAttribute('aria-label', sv.textContent);
  }
  function showResendError(message) {
    chatError.textContent = message; chatError.hidden = false; chatErrorKind = 'resend'; log(message, 'warn');
  }
  var stream = attachChatStream({
    scope: function () { return { cardName: chatCard, conversationId: conversationId }; }, isCurrent: isChatCurrent,
    changed: function () {
      if (!isChatCurrent()) return;
      if (lastMessages.some(function (message) { return message.pending; })) paintChat(lastMessages);
      else refreshChat();
    },
    refresh: function () { refreshChat(); }
  });
  window.__chatStream = stream;
  var recovery = attachChatRecovery({
    root: root, toolbar: conversationBar, api: api, log: log, isCurrent: isChatCurrent,
    scope: function () { return { cardName: chatCard, conversationId: conversationId }; },
    canOperate: function () { return !!conversationId && !sending && !replyActionPending && !messageActionPending && !state.personaSwitching; },
    setBusy: function (value) { messageActionPending = value; sv.disabled = value || sending || replyActionPending || conversationSelect.disabled; paintChat(lastMessages); },
    changed: function (result) {
      if (result.sourceMayHaveChanged) refreshWrittenContent();
      else if (result.workflowInvalidated) renderFlow();
      return refreshChat();
    }
  });
  window.__chatRecovery = recovery;
  function updateConversations(data) {
    conversationSelect.replaceChildren();
    data.conversations.filter(function (item) { return !item.archivedAt; }).forEach(function (item) {
      var option = document.createElement('option'); option.value = item.id;
      option.textContent = item.title + (item.origin ? ' · 分支' : '') + (item.module ? ' · ' + workflowStageCaption(item.module) : '');
      conversationSelect.appendChild(option);
    });
    conversationSelect.value = conversationId;
    var active = data.conversations.find(function (item) { return item.id === conversationId; });
    boundConversationTitle = active && active.title || '';
    conversationSelect.title = active && active.origin ? '分支来自「' + active.origin.title + '」；在对话管理中查看来源时间。' : banner.textContent;
  }
  window.__conversationManager = attachConversationManager({
    toolbar: conversationBar, api: api, log: log, isCurrent: isChatCurrent,
    scope: function () { return { cardName: chatCard, conversationId: conversationId }; },
    canOperate: function () {
      return !!conversationId && !sending && !replyActionPending && !messageActionPending && !state.personaSwitching
        && !Array.from(messageRows.values()).some(function (item) { return item.draft && item.draft.saving; });
    },
    beforeChange: function () { storeChatDraft(); return flushDrafts(); },
    updated: updateConversations, stageCaption: workflowStageCaption,
    changed: function (data, match) { if (isChatCurrent()) renderChat(data.activeId, match); }
  });
  function showFailedSends() {
    var failed = failedChatSends.get(draftKey) || [];
    if (!failed.length) {
      if (chatErrorKind === 'send') { chatError.textContent = ''; chatError.hidden = true; chatErrorKind = ''; }
      return;
    }
    chatError.textContent = '';
    failed.forEach(function (entry) {
      var item = document.createElement('div'), content = document.createElement('div');
      content.style.whiteSpace = 'pre-wrap';
      content.textContent = (entry.status === 'submitting' ? '发送结果未确认' + (entry.reason ? '：' + entry.reason : '') + '。请先查看聊天记录再决定是否重发。原内容已保留：' : '消息未发送：' + entry.reason + '。未发送内容已保留：') + String.fromCharCode(10) + entry.text;
      item.appendChild(content);
      var restore = document.createElement('button'); restore.textContent = '放回输入框';
      restore.disabled = sending || (!!ta.value && ta.value !== entry.text);
      restore.title = restore.disabled ? '请先处理输入框里的新草稿；恢复不会覆盖它。' : '放回输入框，不会自动发送';
      restore.onclick = function () { if (sending || (ta.value && ta.value !== entry.text)) return; ta.value = entry.text; storeChatDraft(); autosizeChatInput(ta); updateSendControls(); ta.focus(); showFailedSends(); };
      var dismiss = document.createElement('button'); dismiss.textContent = '已核对，移除记录'; dismiss.disabled = sending;
      dismiss.title = '只移除这条发送提示，不删除聊天消息或输入框内容';
      dismiss.onclick = function () {
        if (sending) return;
        failedChatSends.set(draftKey, (failedChatSends.get(draftKey) || []).filter(function (current) { return current !== entry; }));
        showFailedSends();
      };
      item.appendChild(restore); item.appendChild(dismiss); chatError.appendChild(item);
    });
    chatError.hidden = false; chatErrorKind = 'send';
  }
  function restoreChatDraft() {
    draftKey = JSON.stringify([chatBlock, chatCard, conversationId]);
    ta.value = chatDrafts.get(draftKey) || '';
    ta.disabled = false;
    autosizeChatInput(ta);
    if (ta.value) log('已恢复这个对话上次未发送的草稿。', 'okc');
    showFailedSends();
  }
  function storeChatDraft() { if (draftKey) chatDrafts.set(draftKey, ta.value); }
  ta.oninput = function () { storeChatDraft(); autosizeChatInput(ta); updateSendControls(); if ((failedChatSends.get(draftKey) || []).length) showFailedSends(); };
  window.__rememberChatDraft = storeChatDraft;
  window.__refreshFailedSends = function (key) {
    if (key !== draftKey || !isChatCurrent()) return;
    if (!ta.value) ta.value = chatDrafts.get(key) || '';
    autosizeChatInput(ta);
    updateSendControls();
    showFailedSends();
  };
  var boundModule = '', boundConversationTitle = '';
  var lastChatSignature = '';
  var avatarReadFailed = false;
  function refreshWrittenContent() {
    var cardName = chatCard;
    var treeRequestSeq = ++state.treeSeq, flowRequestSeq = ++flowSeq;
    Promise.all([api('GET', '/api/card/' + encodeURIComponent(cardName)), api('GET', '/api/workflow/' + encodeURIComponent(cardName))]).then(function (result) {
      if (state.block !== 'card' || state.name !== cardName) return;
      if (treeRequestSeq === state.treeSeq) { state.tree = result[0]; refreshEditPane(); renderTree(); revealEditorSelection(); renderDone(); }
      if (flowRequestSeq === flowSeq) {
        state.flowData = result[1]; state.flowCard = cardName;
        if (!result[1].state) state.flowOpen = null;
        state.wfStage = result[1].stage || '';
        paintFlow();
      }
    }).catch(function (e) {
      if (state.block === 'card' && state.name === cardName && (treeRequestSeq === state.treeSeq || flowRequestSeq === flowSeq)) log('助手回复已收到，但源码和流程同步失败，请重新载入卡片：' + e.message, 'warn');
    });
  }
  function syncNewReply(ms) {
    var latest = null, latestAt = chatReplyWatermarks.get(draftKey) || 0;
    ms.forEach(function (m) {
      if ((m.role !== 'agent' && m.role !== 'assistant') || m.pending || m.pinned || m.error) return;
      var at = Date.parse(m.at);
      if (Number.isFinite(at) && at > latestAt) { latestAt = at; latest = m; }
    });
    if (!latest) return;
    chatReplyWatermarks.set(draftKey, latestAt);
    if (latest.afterWrite) refreshWrittenContent();
  }
  function replyAction(action, payload, button) {
    var cardName = chatCard;
    var activeConversationId = conversationId;
    if (chatBlock !== 'card' || !cardName || !activeConversationId || !isChatCurrent() || replyActionPending || messageActionPending || sending) return;
    if (state.personaSwitching) { log('人设正在切换，请稍后操作。', 'warn'); return; }
    button.disabled = true; replyActionPending = true; sv.disabled = true; paintChat(lastMessages);
    api('POST', '/api/chat-' + action + '/' + encodeURIComponent(cardName), Object.assign({ conversationId: activeConversationId, targetType: 'card' }, payload)).then(function (result) {
      if (!isChatCurrent() || conversationId !== activeConversationId) return;
      if (chatErrorKind === 'action') { chatError.hidden = true; chatError.textContent = ''; chatErrorKind = ''; }
      if (action === 'version') log(result.draftSelected ? '已切换回复；这版完整稿仍需你明确确认后才写入。' : '已切换回复版本，后续交流使用当前显示的一版。', 'okc');
    }).catch(function (e) {
      if (isChatCurrent()) { chatError.textContent = e.message; chatError.hidden = false; chatErrorKind = 'action'; }
      log('回复操作失败：' + e.message, 'err');
    }).finally(function () { replyActionPending = false; lastChatSignature = ''; if (isChatCurrent()) { sv.disabled = sending || conversationSelect.disabled; refreshChat(); } });
  }
  newConversation.onclick = function () {
    if (!chatCard || !isChatCurrent()) return;
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(9,17,39,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
    var panel = document.createElement('div');
    panel.style.cssText = 'width:min(440px,100%);display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--star-border);border-radius:16px;background:var(--star-card-strong);box-shadow:var(--star-shadow);';
    var title = document.createElement('strong');
    title.textContent = '新建对话';
    var hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = '旧记录仍可打开；新对话会从这张卡的最新文件接续。';
    var nameInput = document.createElement('input');
    nameInput.placeholder = '对话名称（可留空）';
    var scope = document.createElement('select');
    var whole = document.createElement('option');
    whole.value = ''; whole.textContent = '整张卡讨论'; scope.appendChild(whole);
    var currentStage = state.flowCard === state.name ? state.wfStage : '';
    if (currentStage && !currentStage.startsWith('完成:')) {
      var current = document.createElement('option');
      current.value = currentStage; current.textContent = '专写当前模块：' + workflowStageCaption(currentStage);
      scope.appendChild(current);
      scope.value = currentStage;
    }
    var actions = document.createElement('div');
    actions.className = 'row';
    actions.style.justifyContent = 'flex-end';
    var cancel = document.createElement('button');
    cancel.textContent = '取消'; cancel.onclick = function () { overlay.remove(); };
    var create = document.createElement('button');
    create.className = 'primary'; create.textContent = '创建并打开';
    create.onclick = function () {
      create.disabled = true;
      api('POST', '/api/conversations/' + encodeURIComponent(chatCard), { action: 'create', title: nameInput.value, module: scope.value })
        .then(function () { overlay.remove(); if (isChatCurrent()) { renderChat(); log('已开启新对话，原有记录仍可在列表里打开。', 'okc'); } })
        .catch(function (e) { create.disabled = false; log('新建对话失败: ' + e.message, 'err'); });
    };
    actions.appendChild(cancel); actions.appendChild(create);
    panel.appendChild(title); panel.appendChild(hint); panel.appendChild(nameInput); panel.appendChild(scope); panel.appendChild(actions);
    overlay.onclick = function (ev) { if (ev.target === overlay) overlay.remove(); };
    overlay.appendChild(panel); document.body.appendChild(overlay); nameInput.focus();
  };
  conversationSelect.onchange = function () {
    if (!isChatCurrent()) return;
    storeChatDraft(); conversationSelect.disabled = true; sv.disabled = true; ta.disabled = true;
    api('POST', '/api/conversations/' + encodeURIComponent(chatCard), { action: 'select', id: conversationSelect.value })
      .then(function () { if (isChatCurrent()) renderChat(); })
      .catch(function (e) { if (isChatCurrent()) { log('切换对话失败: ' + e.message, 'err'); renderChat(); } });
  };
  function editKey(m) { return JSON.stringify([chatCard, conversationId, m.role, m.at]); }
  function actionableMessage(m) {
    return ['user', 'agent', 'assistant'].indexOf(m.role) >= 0 && !!m.at && !m.pending && !m.pinned
      && !(m.role === 'user' && m.retryOfAt) && typeof m.text === 'string';
  }
  function canMessageAction(rowState, action) {
    var m = rowState.message;
    return actionableMessage(m) && (action !== 'branch' || (!m.error && !!m.text.trim()))
      && !sending && !replyActionPending && !messageActionPending && !state.personaSwitching
      && !(rowState.draft && rowState.draft.saving) && m[action === 'delete' ? 'canDelete' : 'canBranch'] !== false;
  }
  function updateMessageActionControls(rowState) {
    ['delete', 'branch'].forEach(function (action) {
      var button = rowState[action + 'Button'];
      if (!button) return;
      button.disabled = !canMessageAction(rowState, action);
      button.title = button.disabled ? '当前操作尚未完成，请稍后再试' : action === 'delete' ? '删除这条消息，先确认范围' : '复制截至这条消息的对话，创建新分支';
    });
  }
  function openMessageAction(rowState, action) {
    if (!isChatCurrent() || !box.contains(rowState.node) || !canMessageAction(rowState, action) || el('chat-action-dialog')) return;
    var message = rowState.message;
    var sourceConversation = conversationId;
    var frozen = { targetType: 'card', conversationId: sourceConversation, messageAt: message.at, role: message.role,
      expectedRevision: message.editRevision || 0, contextRevision: message.contextRevision || 0 };
    var sourceIndex = Array.from(box.children).indexOf(rowState.node);
    var overlay = document.createElement('div');
    overlay.id = 'chat-action-dialog'; overlay.className = 'chat-action-overlay';
    overlay.tabIndex = -1;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', action === 'delete' ? '删除消息' : '创建分支');
    var panel = document.createElement('div'); panel.className = 'chat-action-panel';
    var title = document.createElement('strong'); title.textContent = action === 'delete' ? '删除消息' : '创建分支';
    var preview = document.createElement('div'); preview.className = 'chat-action-preview';
    preview.textContent = rowState.name + '：' + message.text.slice(0, 180) + (message.text.length > 180 ? '…' : '');
    var field = document.createElement('label');
    var input;
    if (action === 'delete') {
      field.textContent = '删除范围'; input = document.createElement('select'); input.id = 'chat-delete-mode';
      [{ value: 'single', text: '只删除这条消息' }, { value: 'from', text: '从这条消息开始，删除后续' }].forEach(function (item) {
        var option = document.createElement('option'); option.value = item.value; option.textContent = item.text; input.appendChild(option);
      });
    } else {
      field.textContent = '分支名称'; input = document.createElement('input'); input.id = 'chat-branch-title'; input.maxLength = 80;
      input.value = (boundConversationTitle + ' · 分支').slice(0, 80); input.placeholder = '分支名称（可留空）';
    }
    field.appendChild(input);
    var hint = document.createElement('div'); hint.className = 'muted';
    function updateHint() {
      if (action === 'branch') {
        hint.textContent = '包含这条消息及此前已保存的内容，采用当前回复版本；后续消息不复制。原对话和未保存草稿保留，卡片正文共用。';
      } else {
        hint.textContent = (input.value === 'from' ? '删除这条消息及后续消息。' : '只删除这条消息，后续消息保留。')
          + ((message.versions || []).length > 1 ? ' 这条助手消息的全部回复版本会一起删除。' : '')
          + ' 已写入的卡片正文保留；本对话的待确认稿需重新确认。'
          + ' 删除后可撤销，也可从「最近删除」恢复。'
          + (lastMessages.some(function (m) { return m.pending; }) ? ' 尚未回复的请求会结束，需要时可重新发送。' : '');
      }
    }
    input.onchange = updateHint; updateHint();
    var error = document.createElement('div'); error.className = 'err'; error.hidden = true; error.setAttribute('role', 'alert');
    var actions = document.createElement('div'); actions.className = 'row'; actions.style.justifyContent = 'flex-end';
    var cancel = document.createElement('button'); cancel.id = 'chat-action-cancel'; cancel.textContent = '取消';
    var confirm = document.createElement('button'); confirm.id = 'chat-action-confirm'; confirm.className = 'primary';
    var confirmLabel = action === 'delete' ? '确认删除' : '创建并打开'; confirm.textContent = confirmLabel;
    var submitted = false, focusAfterDelete = false, createdBranchId = '';
    function close(restoreFocus) {
      overlay.remove();
      if (restoreFocus !== false && isChatCurrent() && conversationId === sourceConversation) {
        var currentRow = messageRows.get(rowState.key);
        var entry = currentRow && currentRow[action + 'Button'];
        restoreVisibleToolFocus(entry, ta);
      }
    }
    overlay.__close = close;
    cancel.onclick = function () { if (!submitted) close(); };
    overlay.onclick = function (event) { if (event.target === overlay && !submitted) close(); };
    overlay.onkeydown = function (event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!submitted) close(); }
      else if (event.key === 'Tab') {
        var focusable = Array.from(panel.querySelectorAll('button, input, select')).filter(function (node) { return !node.disabled; });
        if (!focusable.length) { event.preventDefault(); overlay.focus(); return; }
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    confirm.onclick = function () {
      if (submitted || !document.body.contains(overlay)) return;
      if (!isChatCurrent() || conversationId !== sourceConversation) { close(false); return; }
      var currentRow = messageRows.get(rowState.key);
      if (!createdBranchId && (!currentRow || !box.contains(currentRow.node))) {
        error.hidden = false; error.textContent = '这条消息已不在当前显示内容中，请取消后重新选择。'; return;
      }
      if (!createdBranchId && !canMessageAction(currentRow, action)) { error.hidden = false; error.textContent = '当前操作尚未完成，请稍后再试。'; return; }
      var payload = Object.assign({}, frozen, action === 'delete' ? { mode: input.value } : { title: input.value });
      storeChatDraft(); submitted = true; messageActionPending = true;
      confirm.disabled = true; cancel.disabled = true; input.disabled = true; confirm.textContent = '处理中…';
      error.hidden = true; sv.disabled = true; paintChat(lastMessages);
      overlay.focus({ preventScroll: true });
      var request = createdBranchId ? Promise.resolve({ ok: true, conversationId: createdBranchId })
        : api('POST', '/api/chat-' + action + '/' + encodeURIComponent(chatCard), payload);
      request.then(function (result) {
        if (!result.ok) throw new Error('操作未完成，请重试');
        if (action === 'branch' && result.conversationId) createdBranchId = result.conversationId;
        if (!isChatCurrent() || conversationId !== sourceConversation) {
          close(false); log(action === 'branch' ? '分支已创建，可在来源卡片的对话列表中打开。' : '原对话的消息已删除。', 'okc'); return;
        }
        if (action === 'branch') {
          if (!result.conversationId) throw new Error('分支未返回对话编号，请在对话列表中查看');
          storeChatDraft();
          return api('POST', '/api/conversations/' + encodeURIComponent(chatCard), { action: 'select', id: result.conversationId, expectedActiveId: sourceConversation }).then(function () {
            close(false);
            if (isChatCurrent() && conversationId === sourceConversation) { renderChat(result.conversationId); log('已打开分支，原对话与草稿仍然保留。', 'okc'); }
          });
        }
        close(false);
        if (result.workflowInvalidated) renderFlow();
        log('消息已删除。' + (result.closedPendingCount ? ' 尚未回复的请求已结束。' : ''), 'okc');
        recovery.showDeleted(result);
        return Promise.resolve(refreshChat()).then(function () {
          if (!isChatCurrent() || conversationId !== sourceConversation) return;
          focusAfterDelete = true;
        });
      }).catch(function (e) {
        if (!isChatCurrent() || conversationId !== sourceConversation || !document.body.contains(overlay)) { close(false); log('消息操作失败：' + e.message, 'err'); return; }
        error.hidden = false; error.textContent = (createdBranchId ? '分支已创建，但打开失败：' : '操作失败：') + e.message;
      }).finally(function () {
        submitted = false; messageActionPending = false;
        confirm.disabled = false; cancel.disabled = false; input.disabled = !!createdBranchId; confirm.textContent = createdBranchId ? '打开已创建的分支' : confirmLabel;
        if (isChatCurrent() && conversationId === sourceConversation) {
          sv.disabled = sending || replyActionPending || conversationSelect.disabled;
          paintChat(lastMessages); lastChatSignature = '';
          if (document.body.contains(overlay)) cancel.focus();
          else if (focusAfterDelete) {
            var neighbour = box.children[Math.min(sourceIndex, box.children.length - 1)];
            var target = neighbour && neighbour.querySelector('button:not(:disabled)');
            restoreVisibleToolFocus(target, ta);
          }
        }
      });
    };
    actions.appendChild(cancel); actions.appendChild(confirm);
    [title, preview, field, hint, error, actions].forEach(function (node) { panel.appendChild(node); });
    overlay.appendChild(panel); document.body.appendChild(overlay); cancel.focus();
  }
  function editableMessage(m) {
    return ['user', 'agent', 'assistant'].indexOf(m.role) >= 0 && !!m.at && !m.pending && !m.pinned && !m.error
      && !(m.role === 'user' && m.retryOfAt) && typeof m.text === 'string' && !!m.text.trim();
  }
  function canSaveMessage(m) { return editableMessage(m) && !chatBusy && m.canEdit !== false; }
  function updateEditedLabel(rowState) {
    if (rowState.message.editedAt) {
      if (!rowState.edited) { rowState.edited = document.createElement('span'); rowState.edited.className = 'chat-edited'; rowState.meta.appendChild(rowState.edited); }
      rowState.edited.textContent = '已编辑';
      var at = new Date(rowState.message.editedAt);
      rowState.edited.title = Number.isFinite(at.getTime()) ? '编辑于 ' + at.toLocaleString() : '这条消息已编辑';
    } else if (rowState.edited) { rowState.edited.remove(); rowState.edited = null; }
  }
  function updateEditControls(rowState) {
    updateMessageActionControls(rowState);
    if (rowState.editButton) {
      rowState.editButton.disabled = !editableMessage(rowState.message);
      rowState.editButton.hidden = !!rowState.draft;
      rowState.editButton.title = canSaveMessage(rowState.message) ? '直接在这条消息正文上修改' : '可以先修改编辑草稿，回复完成后再保存';
    }
    var draft = rowState.draft;
    if (!draft || !rowState.editor) return;
    var draftConflict = draft.revision !== (rowState.message.editRevision || 0);
    rowState.save.disabled = draft.saving || draftConflict || !canSaveMessage(rowState.message) || !draft.text.trim();
    rowState.cancel.disabled = !!draft.saving;
    rowState.save.textContent = draft.saving ? '保存中…' : '✓ 保存';
    rowState.status.className = 'chat-edit-status ' + (draft.error ? 'err' : 'muted');
    rowState.status.textContent = draft.error || (draftConflict ? '原消息已经更新，恢复的草稿仍保留在此。请先复制需要的内容，再取消编辑查看新消息。' : chatBusy ? '当前对话正在等待回复，可先修改草稿，回复完成后保存。' : !canSaveMessage(rowState.message) ? '这条消息暂时无法保存，编辑草稿已保留。' : draft.recovered ? '已恢复上次未保存的消息修改。' : '');
    rowState.status.hidden = !rowState.status.textContent;
  }
  function saveMessageDraft(rowState, draft) {
    if (!isChatCurrent() || !box.contains(rowState.node) || chatEditDrafts.get(rowState.key) !== draft) return Promise.reject(new Error('对话已切换，请回到原对话处理编辑草稿。'));
    if (draft.saving) return Promise.reject(new Error('这条消息正在保存，请稍后再试。'));
    if (draft.revision !== (rowState.message.editRevision || 0)) return Promise.reject(new Error('原消息已经更新，编辑草稿已保留。请先处理版本冲突后再发送。'));
    if (!canSaveMessage(rowState.message)) return Promise.reject(new Error('当前暂时无法保存消息，请等待正在进行的操作完成。'));
    if (!draft.text.trim()) return Promise.reject(new Error('修改后的消息不能为空，编辑草稿已保留。'));
    var submitted = draft.text, savedConversation = conversationId, savedPersonaRevision = personaRevision;
    draft.saving = true; draft.error = ''; updateEditControls(rowState); updateSendControls();
    return api('POST', '/api/chat-edit/' + encodeURIComponent(chatCard), { targetType: 'card', conversationId: savedConversation, messageAt: rowState.message.at, role: rowState.message.role, text: submitted, expectedRevision: draft.revision }).then(function (result) {
      if (!result.ok) throw new Error('保存未完成，请重试');
      draft.revision = result.revision;
      rowState.message.text = submitted; rowState.message.editRevision = result.revision; rowState.message.editedAt = result.editedAt;
      rowState.message.contextRevision = result.contextRevision;
      (rowState.message.versions || []).forEach(function (version) { if (version.at === rowState.message.at && version.role === rowState.message.role) { version.text = submitted; version.editRevision = result.revision; version.editedAt = result.editedAt; } });
      if (chatEditDrafts.get(rowState.key) === draft) {
        if (draft.text === submitted) chatEditDrafts.delete(rowState.key);
        else chatEditDrafts.set(rowState.key, draft);
      }
      if (isChatCurrent() && conversationId === savedConversation && personaRevision === savedPersonaRevision) {
        log(result.changed ? '消息已保存。' + (result.workflowInvalidated ? ' 本对话的待确认稿已清除，需要重新确认完整稿。' : '') : '正文没有变化。', 'okc');
        if (result.workflowInvalidated) renderFlow();
      }
      return { result: result, submitted: submitted, draft: draft };
    }).catch(function (e) {
      draft.error = '保存失败：' + e.message;
      if (isChatCurrent() && conversationId === savedConversation && personaRevision === savedPersonaRevision) log('消息编辑保存失败：' + e.message, 'err');
      throw e;
    }).finally(function () {
      draft.saving = false;
      if (isChatCurrent() && conversationId === savedConversation) { paintChat(lastMessages); lastChatSignature = ''; }
    });
  }
  function showMessageEditor(rowState, draft) {
    rowState.draft = draft;
    rowState.content.classList.add('editing');
    rowState.bubble.innerHTML = '';
    var input = document.createElement('textarea'); input.className = 'chat-edit-input';
    input.setAttribute('aria-label', '编辑' + rowState.name + '的消息正文');
    input.value = draft.text;
    if (Number.isInteger(draft.start) && Number.isInteger(draft.end)) input.setSelectionRange(draft.start, draft.end);
    else input.setSelectionRange(0, 0);
    input.rows = 2;
    input.oninput = function () { if (chatEditDrafts.get(rowState.key) !== draft) return; draft.text = input.value; draft.start = input.selectionStart; draft.end = input.selectionEnd; chatEditDrafts.set(rowState.key, draft); autosizeMessageEditor(input, true); updateEditControls(rowState); updateSendControls(); };
    input.onselect = function () { if (chatEditDrafts.get(rowState.key) !== draft) return; draft.start = input.selectionStart; draft.end = input.selectionEnd; chatEditDrafts.set(rowState.key, draft); };
    input.oncompositionstart = function () { draft.composing = true; };
    input.oncompositionend = function () { draft.composing = false; };
    var actions = document.createElement('div'); actions.className = 'chat-edit-actions';
    var save = document.createElement('button'); save.className = 'primary chat-edit-save'; save.textContent = '✓ 保存';
    save.setAttribute('aria-label', '保存这条消息的修改'); save.title = '保存这条消息的修改';
    var cancel = document.createElement('button'); cancel.className = 'chat-edit-cancel'; cancel.textContent = '✕ 取消';
    cancel.setAttribute('aria-label', '取消这条消息的修改'); cancel.title = '取消修改，恢复原消息';
    var status = document.createElement('div'); status.className = 'chat-edit-status'; status.setAttribute('role', 'status');
    rowState.editor = input; rowState.save = save; rowState.cancel = cancel; rowState.status = status;
    save.onclick = function () { saveMessageDraft(rowState, draft).catch(function (e) { draft.error = '保存失败：' + e.message; updateEditControls(rowState); }).finally(function () { if (isChatCurrent()) refreshChat(); }); };
    cancel.onclick = function () {
      if (draft.saving || !isChatCurrent() || chatEditDrafts.get(rowState.key) !== draft) return;
      chatEditDrafts.delete(rowState.key); paintChat(lastMessages);
      var restored = messageRows.get(rowState.key);
      if (restored && restored.editButton) restored.editButton.focus({ preventScroll: true });
    };
    input.onkeydown = function (ev) { if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); cancel.onclick(); } };
    actions.appendChild(save); actions.appendChild(cancel);
    rowState.bubble.appendChild(input); rowState.meta.appendChild(actions); rowState.meta.appendChild(status);
    autosizeMessageEditor(input, true);
    updateEditControls(rowState);
    updateSendControls();
    return input;
  }
  function paintChat(ms) {
    ms = stream.apply(ms);
    chatBusy = sending || replyActionPending || messageActionPending || ms.some(function (m) { return m.pending; });
    state.personaBusy = chatBusy;
    el('persona-select').disabled = chatBusy || !!state.personaSwitching;
    el('btn-personas').disabled = chatBusy || !!state.personaSwitching;
    var workflowStages = availableWorkflowStages(state.flowCard === state.name ? state.flowData : null);
    // 使用消息身份保留已打开编辑器；轮询更新其他行时不移动焦点和光标。
    var firstPaint = !box.childElementCount;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    var previousScrollTop = box.scrollTop;
    var nextRows = new Map(), nodes = [];
    ms.forEach(function (m, mi) {
      var key = m.at ? editKey(m) : JSON.stringify([chatCard, conversationId, m.role, 'temporary', mi]);
      var draft = chatEditDrafts.get(key);
      var rowSignature = JSON.stringify([m, chatAvatars, workflowStages, chatBusy, messageActionPending]);
      var cached = messageRows.get(key);
      var streamControls = m.pending && JSON.stringify([m.personaId, m.task && m.task.replyToAt, m.task && m.task.canStop,
        m.task && m.task.phase === 'stopping', m.task && m.task.stopError, m.task && m.task.allowWrite, sending, replyActionPending, messageActionPending, chatAvatars]);
      if (cached && !draft && m.pending && cached.streamControls === streamControls && cached.streamStatus && cached.streamPreview) {
        cached.message = m; cached.signature = rowSignature;
        if (cached.streamStatus.textContent !== String(m.text || '')) cached.streamStatus.textContent = String(m.text || '');
        var value = String(m.partialText || '');
        var previous = cached.streamPreview.textContent;
        if (previous !== value) {
          if (cached.streamPreview.firstChild && value.indexOf(previous) === 0) cached.streamPreview.firstChild.appendData(value.slice(previous.length));
          else cached.streamPreview.textContent = value;
        }
        cached.streamPreview.hidden = !value; cached.streamLabel.hidden = !value;
        recovery.updatePendingControls(m, cached.bubble);
        nextRows.set(key, cached); nodes.push(cached.node); return;
      }
      if (cached && cached.draft === draft && (draft || cached.signature === rowSignature)) {
        cached.message = m; cached.signature = rowSignature;
        updateEditedLabel(cached); updateEditControls(cached);
        nextRows.set(key, cached); nodes.push(cached.node); return;
      }
      var d = document.createElement('div');
      var isUser = m.role === 'user';
      var name = isUser ? chatAvatars.user && chatAvatars.user.name || '你' : m.personaName || personaName(m.personaId || 'xiaoxi');
      var avatarId = isUser ? 'user' : m.personaId || 'xiaoxi';
      d.className = 'chat-message ' + (isUser ? 'user' : 'agent') + (m.pinned ? ' pinned' : '') + (m.pending ? ' pending' : '');
      d.dataset.messageAt = m.at || ''; d.dataset.messageRole = m.role;
      d.appendChild(makeChatAvatar(avatarId, name));
      var content = document.createElement('div'); content.className = 'chat-content';
      var meta = document.createElement('div'); meta.className = 'chat-meta';
      var sender = document.createElement('span'); sender.className = 'chat-sender';
      sender.textContent = name + (m.pinned ? ' · 使用说明' : m.pending ? ' · 处理中' : ''); meta.appendChild(sender);
      var timestamp = new Date(m.at);
      if (m.at && Number.isFinite(timestamp.getTime())) {
        var time = document.createElement('time'); time.dateTime = m.at;
        time.textContent = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        time.title = timestamp.toLocaleString(); meta.appendChild(time);
      }
      if (!m.pending) {
        var copy = document.createElement('button'); copy.className = 'chat-copy'; copy.textContent = '复制';
        copy.setAttribute('aria-label', '复制' + name + '的这条消息');
        copy.onclick = function () { copyChatText(String(rowState.message.text || ''), copy); }; meta.appendChild(copy);
      }
      content.appendChild(meta);
      var bubble = document.createElement('div'); bubble.className = 'chat-bubble';
      var rowState = { key: key, node: d, content: content, meta: meta, bubble: bubble, message: m, name: name, signature: rowSignature, draft: undefined, streamControls: streamControls };
      updateEditedLabel(rowState);
      if (actionableMessage(m)) {
        ['delete', 'branch'].forEach(function (action) {
          if (action === 'branch' && (m.error || !m.text.trim())) return;
          var button = document.createElement('button'); button.className = 'chat-copy chat-' + action;
          button.textContent = action === 'delete' ? '删除' : '分支';
          button.setAttribute('aria-label', (action === 'delete' ? '删除' : '从这里分支：') + name + '的这条消息');
          rowState[action + 'Button'] = button; button.onclick = function () { openMessageAction(rowState, action); };
          meta.appendChild(button);
        });
      }
      if (editableMessage(m)) {
        var edit = document.createElement('button'); edit.className = 'chat-copy chat-edit'; edit.textContent = '✎ 编辑';
        edit.setAttribute('aria-label', '编辑' + name + '的这条消息'); rowState.editButton = edit;
        edit.onclick = function () {
          if (!editableMessage(rowState.message) || !isChatCurrent() || !box.contains(rowState.node) || rowState.draft) return;
          var current = { text: String(rowState.message.text), revision: rowState.message.editRevision || 0, saving: false, error: '' };
          chatEditDrafts.set(key, current); var editor = showMessageEditor(rowState, current); editor.focus({ preventScroll: true });
        };
        meta.appendChild(edit);
      }
      if (draft) showMessageEditor(rowState, draft);
      else {
        var text = document.createElement('div'); text.className = 'chat-text';
        var directives = [];
        if (isUser || m.pending || m.pinned) text.textContent = String(m.text || '');
        else chatPresentationParts(m.text).forEach(function (part) {
          if (part.kind === 'open') {
            var stage = resolveWorkflowStage(part.token, workflowStages);
            if (stage) { if (directives.indexOf(stage) < 0) directives.push(stage); return; }
          }
          if (part.kind === 'code') {
            var code = document.createElement('code'); code.textContent = part.text;
            if (part.block) { var pre = document.createElement('pre'); pre.appendChild(code); text.appendChild(pre); }
            else text.appendChild(code);
          } else text.appendChild(document.createTextNode(part.text));
        });
        if (m.pending) { text.setAttribute('role', 'status'); text.setAttribute('aria-live', 'polite'); }
        bubble.appendChild(text);
        if (m.pending) {
          rowState.streamStatus = text;
          var streamLabel = document.createElement('div'); streamLabel.className = 'muted'; streamLabel.textContent = '正在生成 · 未完成';
          var streamPreview = document.createElement('div'); streamPreview.className = 'chat-text chat-stream-preview';
          streamPreview.textContent = String(m.partialText || ''); streamPreview.style.marginTop = '8px';
          streamLabel.hidden = streamPreview.hidden = !m.partialText;
          rowState.streamLabel = streamLabel; rowState.streamPreview = streamPreview;
          bubble.appendChild(streamLabel); bubble.appendChild(streamPreview);
        }
        if (m.error && m.partialText) {
          var partial = document.createElement('details'); partial.className = 'chat-partial'; partial.open = true;
          var partialTitle = document.createElement('summary'); partialTitle.textContent = '已收到的未完成片段';
          var partialText = document.createElement('div'); partialText.className = 'chat-text'; partialText.textContent = String(m.partialText);
          var copyPartial = document.createElement('button'); copyPartial.className = 'chat-copy'; copyPartial.textContent = '复制片段';
          copyPartial.onclick = function () { copyChatText(String(rowState.message.partialText || ''), copyPartial); };
          partial.appendChild(partialTitle); partial.appendChild(partialText); partial.appendChild(copyPartial); bubble.appendChild(partial);
        }
        if (m.pending) recovery.pendingControls(m, bubble);
        if (directives.length) {
          var actions = document.createElement('div'); actions.className = 'chat-module-actions';
          directives.forEach(function (stage) {
            (function (token, cardName) {
              var chip = document.createElement('button');
              chip.textContent = '前往「' + workflowStageLabel(token) + '」';
              chip.onclick = function () { openFromDirective(token, cardName); };
              actions.appendChild(chip);
            })(stage, chatCard);
          });
          bubble.appendChild(actions);
        }
        if (!isUser && !m.pending && !m.pinned && !m.error && ((m.versions || []).length > 1 || m.canRetry)) {
          var controls = document.createElement('div'); controls.className = 'chat-reply-controls';
          var versions = m.versions || [m];
          var currentVersion = Number.isInteger(m.currentVersion) ? m.currentVersion : versions.length - 1;
          var previous = document.createElement('button'); previous.textContent = '‹'; previous.setAttribute('aria-label', '上一版回复');
          previous.disabled = chatBusy || currentVersion <= 0;
          previous.onclick = function () { replyAction('version', { rootReplyAt: m.rootReplyAt, versionAt: versions[currentVersion - 1].at }, previous); };
          var count = document.createElement('span'); count.textContent = (currentVersion + 1) + ' / ' + versions.length;
          count.setAttribute('aria-label', '回复版本 ' + count.textContent);
          var next = document.createElement('button'); next.textContent = '›'; next.setAttribute('aria-label', '下一版回复');
          next.disabled = chatBusy || currentVersion >= versions.length - 1;
          next.onclick = function () { replyAction('version', { rootReplyAt: m.rootReplyAt, versionAt: versions[currentVersion + 1].at }, next); };
          controls.appendChild(previous); controls.appendChild(count); controls.appendChild(next);
          if (m.canRetry) {
            var regenerate = document.createElement('button'); regenerate.textContent = '重新回复';
            regenerate.setAttribute('aria-label', '重新生成' + name + '的这条回复');
            regenerate.disabled = chatBusy;
            regenerate.onclick = function () { replyAction('retry', { replyAt: m.at }, regenerate); };
            controls.appendChild(regenerate);
          }
          bubble.appendChild(controls);
        }
      }
      updateEditControls(rowState);
      content.appendChild(bubble);
      if (!isUser && !m.pending && !m.pinned && m.codexUsage && typeof m.codexUsage === 'object') {
        var usage = m.codexUsage;
        function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '未知'; }
        var inputKnown = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0;
        var cacheKnown = Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens >= 0;
        var ratio = inputKnown && cacheKnown && usage.cachedInputTokens <= usage.inputTokens
          ? usage.inputTokens > 0 ? (100 * usage.cachedInputTokens / usage.inputTokens).toFixed(1) + '%' : '不适用'
          : '未知';
        var usageDetails = document.createElement('details'); usageDetails.className = 'chat-usage';
        usageDetails.open = !!(cached && cached.usageDetails && cached.usageDetails.open);
        var usageSummary = document.createElement('summary');
        usageSummary.textContent = 'Token 用量 · 缓存 ' + tokenCount(usage.cachedInputTokens) + ' / 输入 ' + tokenCount(usage.inputTokens) + '（' + ratio + '）'
          + (usage.complete === false ? ' · 统计不完整' : '');
        var outputUsage = document.createElement('div');
        outputUsage.textContent = '输出 ' + tokenCount(usage.outputTokens) + '，其中推理 ' + tokenCount(usage.reasoningOutputTokens) + ' Token';
        var usageNote = document.createElement('div');
        usageNote.textContent = '缓存占比是已报告输入 Token 的比例，不代表账号额度节省比例。'
          + (usage.complete === false ? ' 尚有请求未返回完整统计。' : '');
        usageDetails.appendChild(usageSummary); usageDetails.appendChild(outputUsage);
        if (typeof m.codexThreadReused === 'boolean') {
          var threadUsage = document.createElement('div');
          threadUsage.textContent = m.codexThreadReused ? 'Codex 对话：继续已有对话' : 'Codex 对话：新建对话';
          usageDetails.appendChild(threadUsage);
        }
        usageDetails.appendChild(usageNote); content.appendChild(usageDetails); rowState.usageDetails = usageDetails;
      }
      d.appendChild(content);
      nextRows.set(key, rowState); nodes.push(d);
    });
    var retainedNodes = new Set(nodes);
    Array.from(box.children).forEach(function (node) { if (!retainedNodes.has(node)) node.remove(); });
    var cursor = box.firstChild;
    nodes.forEach(function (node) {
      if (node === cursor) cursor = cursor.nextSibling;
      else box.insertBefore(node, cursor);
    });
    while (cursor) { var unused = cursor; cursor = cursor.nextSibling; unused.remove(); }
    messageRows = nextRows;
    updateSendControls();
    recovery.updateClocks();
    nextRows.forEach(function (rowState) { if (rowState.editor) autosizeMessageEditor(rowState.editor); });
    if (firstPaint || nearBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = previousScrollTop;
    if (locateMessage && locateMessage.messageAt) {
      var found = Array.from(box.children).find(function (node) {
        return node.dataset.messageAt === locateMessage.messageAt && node.dataset.messageRole === locateMessage.role;
      });
      locateMessage = null;
      if (found) {
        found.scrollIntoView({ block: 'center' }); found.tabIndex = -1; found.focus({ preventScroll: true });
        found.style.outline = '2px solid var(--star-blue)'; found.style.outlineOffset = '-2px';
        setTimeout(function () { found.style.outline = ''; found.style.outlineOffset = ''; }, 3500);
      } else log('对话已打开；匹配的消息可能已被修改、删除或切换版本。', 'warn');
    }
  }
  function refreshChat() {
    if (!conversationId || !isChatCurrent()) return;
    stream.start();
    var requestSeq = ++refreshSeq;
    var avatarRequest = api('GET', '/api/chat-avatars').then(function (mapping) { avatarReadFailed = false; return mapping; }).catch(function (e) {
      if (!avatarReadFailed) log('头像暂时无法载入，聊天记录仍正常显示：' + e.message, 'warn');
      avatarReadFailed = true;
      return chatAvatars;
    });
    return Promise.all([api('GET', '/api/chat/' + encodeURIComponent(chatCard || '') + '?conversationId=' + encodeURIComponent(conversationId)), avatarRequest]).then(function (result) {
      if (!isChatCurrent() || requestSeq !== refreshSeq) return;
      var ms = result[0]; chatAvatars = result[1];
      syncNewReply(ms);
      lastMessages = ms;
      if (chatErrorKind === 'refresh') { chatError.textContent = ''; chatError.hidden = true; chatErrorKind = ''; }
      var workflowStages = availableWorkflowStages(state.flowCard === state.name ? state.flowData : null);
      var signature = JSON.stringify([result, workflowStages, replyActionPending, sending]);
      if (signature === lastChatSignature) { paintChat(ms); return; }
      lastChatSignature = signature;
      paintChat(ms);
    }).catch(function (e) {
      if (!isChatCurrent() || requestSeq !== refreshSeq) return;
      var message = '对话刷新失败，暂时无法显示最新回复：' + e.message;
      if (chatErrorKind !== 'send') { chatError.textContent = message; chatError.hidden = false; chatErrorKind = 'refresh'; }
      log(message, 'err');
    });
  }
  function resendLastMessage() {
    if (chatBlock !== 'card') { showResendError('请在输入框中填写新消息；重新发送目前仅支持角色卡和世界卡对话。'); return; }
    var message = resendMessage();
    if (lastMessages.some(function (item) { return item.pending; })) { showResendError('当前对话正在等待回复，请等待完成或先停止回复，再重新发送。'); return; }
    if (!message) { showResendError('输入框为空。请填写新消息；若要替换已有答复，请使用答复下方的“重新回复”。'); return; }
    if (!message.canResend) { showResendError(message.resendBlockedReason || '这条消息暂时不能重新发送，请刷新对话后再试。'); refreshChat(); return; }
    var rowState = messageRows.get(editKey(message)), draft = rowState && rowState.draft;
    var sourceConversation = conversationId, sourcePersona = state.personaId, sourcePersonaRevision = personaRevision;
    var userAt = message.at, sourceKey = editKey(message), dispatched = false;
    function sameScope() { return isChatCurrent() && conversationId === sourceConversation && state.personaId === sourcePersona && personaRevision === sourcePersonaRevision && !state.personaSwitching && !conversationSelect.disabled; }
    // 保存开始时仍允许校验编辑条件；随后锁住重复发送，编辑框继续保留用户的新输入。
    var ready = draft ? saveMessageDraft(rowState, draft) : Promise.resolve({ result: { revision: message.editRevision || 0, contextRevision: message.contextRevision || 0 } });
    sending = true; sendMode = 'resend'; ++refreshSeq; paintChat(lastMessages);
    ready.then(function (saved) {
      if (!sameScope()) return null;
      if ((saved.draft && saved.draft.text !== saved.submitted) || chatEditDrafts.has(sourceKey)) throw new Error('保存期间又有新的消息修改，最新草稿已保留。请确认内容后再次点击“保存并重新发送”。');
      if (ta.value.trim()) throw new Error('输入框已有新草稿，本次重新发送已暂停。请先决定是否发送新消息。');
      return flushDrafts().then(function () {
        if (!sameScope()) return null;
        if ((saved.draft && saved.draft.text !== saved.submitted) || chatEditDrafts.has(sourceKey)) throw new Error('消息又有新的修改，草稿已保留，请确认后再次重新发送。');
        if (ta.value.trim()) throw new Error('输入框已有新草稿，本次重新发送已暂停。');
        dispatched = true;
        return api('POST', '/api/chat-resend/' + encodeURIComponent(chatCard), { targetType: 'card', conversationId: sourceConversation, userAt: userAt,
          expectedRevision: saved.result.revision, contextRevision: saved.result.contextRevision, personaId: sourcePersona });
      });
    }).then(function (result) {
      if (!result || !sameScope()) return;
      lastMessages.forEach(function (item) { if (item.role === 'user' && item.at === userAt) item.canResend = false; });
      if (chatErrorKind === 'resend') { chatError.textContent = ''; chatError.hidden = true; chatErrorKind = ''; }
      log('已重新发送这条消息，正在等待' + personaName(sourcePersona) + '回复。', 'okc');
      if (result.workflowInvalidated) renderFlow();
    }).catch(function (e) {
      if (!sameScope()) return;
      showResendError((dispatched && !e.requestRejected ? '重新发送未确认，请先查看最新对话：' : '未重新发送：') + e.message);
    }).finally(function () { sending = false; sendMode = ''; if (isChatCurrent()) { paintChat(lastMessages); refreshChat(); } });
  }
  sv.onclick = function () { sendMsg(); };
  function sendMsg() {
    if (!isChatCurrent() || sending || replyActionPending || messageActionPending || ta.disabled || inputComposing) return;
    var text = ta.value;
    if (!conversationId) return;
    if (state.personaSwitching) { log('人设正在切换，请稍后发送。草稿已保留。', 'warn'); return; }
    if (Array.from(messageRows.values()).some(function (item) { return item.draft && item.draft.saving; })) { showResendError('消息修改正在保存，请稍后发送。草稿已保留。'); return; }
    if (!text.trim() && Array.from(messageRows.values()).some(function (item) { return item.draft && item.draft.composing; })) { showResendError('请先完成输入法选字，再重新发送修改后的消息。'); return; }
    if (!text.trim()) { resendLastMessage(); return; }
    var sentKey = draftKey;
    var sentConversation = conversationId, sentPersonaRevision = personaRevision;
    function isSendCurrent() { return isChatCurrent() && conversationId === sentConversation && personaRevision === sentPersonaRevision && !state.personaSwitching; }
    sending = true; sendMode = 'new'; sv.disabled = true; paintChat(lastMessages);
    var unconfirmed = (failedChatSends.get(sentKey) || []).filter(function (entry) { return entry.text !== text; });
    unconfirmed.push({ text: text, reason: '', status: 'submitting' }); failedChatSends.set(sentKey, unconfirmed);
    ta.value = ''; storeChatDraft(); autosizeChatInput(ta);
    var chatPath = '/api/chat' + (chatCard ? '/' + encodeURIComponent(chatCard) : '');
    var sendPayload = { text: text, targetType: chatBlock, conversationId: conversationId, personaId: state.personaId };
    var sendDispatched = false;
    flushDrafts().then(function () { sendDispatched = true; return api('POST', chatPath, sendPayload); }).then(function () {
      var failed = (failedChatSends.get(sentKey) || []).filter(function (entry) { return entry.text !== text; });
      if (failed.length) failedChatSends.set(sentKey, failed); else failedChatSends.delete(sentKey);
      if (isSendCurrent()) {
        if ((!failed.length && chatErrorKind === 'send') || chatErrorKind === 'resend') { chatError.textContent = ''; chatError.hidden = true; chatErrorKind = ''; }
        else showFailedSends();
        refreshChat();
      }
    }).catch(function (e) {
      var failed = (failedChatSends.get(sentKey) || []).filter(function (entry) { return entry.text !== text; });
      failed.push({ text: text, reason: e.message, status: sendDispatched && !e.requestRejected ? 'submitting' : 'failed' }); failedChatSends.set(sentKey, failed);
      if (!chatDrafts.get(sentKey)) chatDrafts.set(sentKey, text);
      if (window.__refreshFailedSends) window.__refreshFailedSends(sentKey);
      if (isSendCurrent()) log('发送失败: ' + e.message, 'err');
    }).finally(function () { sending = false; sendMode = ''; if (isChatCurrent()) { paintChat(lastMessages); if (isSendCurrent()) showFailedSends(); } });
  }
  ta.oncompositionstart = function () { inputComposing = true; };
  ta.oncompositionend = function () { inputComposing = false; };
  ta.onkeydown = function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !inputComposing && ev.keyCode !== 229) { ev.preventDefault(); sendMsg(); }
  };
  row.appendChild(sv);
  root.appendChild(h); root.appendChild(conversationBar); root.appendChild(banner); root.appendChild(box); root.appendChild(ta); root.appendChild(chatError); root.appendChild(row);
  window.__refreshPersona = function () {
    if (!document.body.contains(h)) { renderChat(); return; }
    personaRevision++;
    heading.textContent = state.personaName;
    ta.placeholder = (state.personaId === 'neutral' ? '这次想写什么…' : '告诉' + state.personaName + '这次想写什么…') + '（Enter 发送，Shift+Enter 换行）';
    ta.setAttribute('aria-label', '发送给' + state.personaName + '的消息');
    refreshChip();
    refreshChat();
  };
  window.__refreshChatAvatars = function () { if (document.body.contains(box)) refreshChat(); };
  window.__refreshChat = refreshChat;
  window.__refreshChatStage = function () {
    if (!document.body.contains(banner)) return '';
    setChatBanner(boundModule ? '本对话专写：' + workflowStageCaption(boundModule) + '；切换卡片步骤不会改变本对话的绑定模块。' : '当前制作模块：' + workflowStageCaption(state.wfStage || '00-引导'));
    return boundModule;
  };
  if (window.__chatTimer) clearInterval(window.__chatTimer);
  window.__chatTimer = setInterval(function () {
    if (document.body.contains(box)) refreshChat();
    else clearInterval(window.__chatTimer);
  }, 4000);
  if (state.name && state.block === 'card') {
    api('GET', '/api/conversations/' + encodeURIComponent(chatCard)).then(function (data) {
      if (!isChatCurrent()) return;
      conversationId = data.activeId;
      if (locateMessage && focusConversationId !== conversationId) {
        locateMessage = null; log('当前对话选择已变化，已同步实际选择；可重新搜索并定位消息。', 'warn');
      }
      updateConversations(data);
      restoreChatDraft();
      conversationSelect.value = conversationId;
      conversationSelect.disabled = false;
      sv.disabled = false;
      var active = data.conversations.find(function (item) { return item.id === conversationId; });
      boundModule = active && active.module || '';
      boundConversationTitle = active && active.title || '';
      var displayedStage = state.flowCard === state.name ? state.wfStage : '';
      setChatBanner(active && active.module ? '本对话专写：' + workflowStageCaption(active.module) + '；卡片其他已完成内容仍会供 AI 参考。' : (displayedStage ? '当前制作模块：' + workflowStageCaption(displayedStage) : '整张卡讨论；可打开制作流程选择模块。'));
      if (active && active.origin) conversationSelect.title = '分支来自「' + active.origin.title + '」；在对话管理中查看来源时间。';
      refreshChat();
      if (focusConversationId === conversationId) ta.focus();
    }).catch(function (e) { setChatBanner('对话载入失败：' + e.message); log(banner.textContent, 'err'); });
  } else {
    newConversation.disabled = true;
    if (state.name) {
      conversationId = 'main';
      restoreChatDraft();
      var original = document.createElement('option');
      original.value = 'main'; original.textContent = '原有对话';
      conversationSelect.appendChild(original);
      sv.disabled = false;
      setChatBanner('当前项目讨论');
      refreshChat();
    } else setChatBanner('请先选择一个项目');
  }
  refreshChip();
}
function showPicker(anchor) {
  var old = document.getElementById('picker-pop');
  if (old) { old.remove(); return; }
  var pop = document.createElement('div');
  pop.id = 'picker-pop';
  pop.style.cssText = 'position:fixed;z-index:50;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:2px;padding:8px;border:1px solid var(--star-border);border-radius:1rem;background:var(--star-card-strong);box-shadow:var(--star-shadow);';
  var r = anchor.getBoundingClientRect();
  var pickerBlock = state.block, pickerName = state.name;
  pop.style.left = r.left + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  pickerOptions().forEach(function (o) {
    var b = document.createElement('button');
    b.textContent = o.label;
    b.style.cssText = 'text-align:left;background:transparent;border-color:transparent;white-space:normal;overflow-wrap:anywhere;';
    b.onclick = function () { pop.remove(); if (state.block === pickerBlock && state.name === pickerName && editorViewAvailable(o.view)) openModule(o.view); };
    pop.appendChild(b);
  });
  document.body.appendChild(pop);
  pop.style.left = Math.max(12, Math.min(r.left, innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.style.top = Math.max(12, Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 12)) + 'px';
  setTimeout(function () {
    var off = function (ev) { if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener('click', off); } };
    document.addEventListener('click', off);
  }, 0);
}
// ---------- 修改模式：按层次（懒展开）浏览并修改内容 ----------
function workflowStageCaption(stage) {
  return String(stage || '').replace(/-打包$/, '-生成成品');
}
function workflowStageLabel(stage) {
  if (stage === '角色卡/01-世界观') return '世界观简介';
  if (stage === '角色卡/02-角色') return '角色（基础＋性格）';
  return workflowStageCaption(stage).replace(/^[^/]+\\//, '').replace(/^\\d{2}-/, '');
}
function availableWorkflowStages(data) {
  if (!data || !data.state) return [];
  var planned = data.state.plan && data.state.plan.modules || [];
  return ['00-引导'].concat((data.modules || []).map(function (m) { return m.stage; }).filter(function (stage) { return planned.indexOf(stage) >= 0; }));
}
function treeModel() {
  var t = state.tree, roots = [];
  if (!t) return roots;
  if (state.block === 'card') {
    roots.push({ label: '基础字段', children: function () { return Object.keys(t.texts || {}).map(function (f) { return { label: LABELS[f] || f, view: { kind: 'text', key: f } }; }); } });
    roots.push({ label: '备选开场', children: function () { var a = (t.greetings || []).map(function (g) { return { label: g.file, view: { kind: 'greeting', key: g.file } }; }); a.push({ label: '＋ 新备选开场', view: { kind: 'greeting-new' } }); return a; } });
    roots.push({ label: '世界书', children: function () { return (t.books || []).map(function (bk) { return { label: bk.book, children: function () { return bk.entries.map(function (e) { return { label: e.base, view: { kind: 'entry', book: bk.book, base: e.base } }; }); } }; }); } });
    roots.push({ label: '配置', children: function () { return [{ label: '卡片信息', view: { kind: 'index' } }, { label: '扩展字段', view: { kind: 'extra' } }]; } });
    roots.push({ label: '工具', children: function () { return [{ label: '内容诊断', view: { kind: 'diagnose' } }, { label: '预览成品', view: { kind: 'preview' } }]; } });
  } else if (state.block === 'preset') {
    roots.push({ label: '配置', children: function () { return [{ label: 'index.yaml', view: { kind: 'p-index' } }, { label: 'extra.json', view: { kind: 'p-extra' } }, { label: 'order.json', view: { kind: 'p-order' } }]; } });
    roots.push({ label: '提示词条目', children: function () { return (t.prompts || []).map(function (p) { return { label: p.base, view: { kind: 'p-prompt', base: p.base } }; }); } });
    roots.push({ label: '工具', children: function () { return [{ label: '预览成品', view: { kind: 'p-preview' } }]; } });
  } else {
    roots.push({ label: '配置', children: function () { return [{ label: 'index.yaml', view: { kind: 'b-index' } }, { label: 'extra.json', view: { kind: 'b-extra' } }]; } });
    roots.push({ label: '条目', children: function () { return (t.entries || []).map(function (e) { return { label: e.base, view: { kind: 'b-entry', base: e.base } }; }); } });
    roots.push({ label: '工具', children: function () { return [{ label: '预览成品', view: { kind: 'b-preview' } }]; } });
  }
  return roots;
}
function buildTree(nodes, container, depth) {
  nodes.forEach(function (node) {
    var b = document.createElement('button');
    b.className = 'tnode';
    b.style.paddingLeft = (10 + depth * 14) + 'px';
    var leaf = !node.children;
    b.dataset.treeLabel = node.label;
    if (leaf) b.dataset.view = JSON.stringify(node.view);
    else b.setAttribute('aria-expanded', 'false');
    b.textContent = (leaf ? '· ' : '▸ ') + node.label;
    container.appendChild(b);
    var childBox = null;
    b.onclick = function () {
      if (leaf) { openModule(node.view); return; }
      if (!childBox) {
        childBox = document.createElement('div');
        childBox.className = 'treewrap';
        buildTree(node.children(), childBox, depth + 1);
        container.insertBefore(childBox, b.nextSibling);
        b.setAttribute('aria-expanded', 'true');
        b.textContent = '▾ ' + node.label;
      } else {
        var openNow = childBox.style.display !== 'none';
        childBox.style.display = openNow ? 'none' : '';
        b.setAttribute('aria-expanded', String(!openNow));
        b.textContent = (openNow ? '▸ ' : '▾ ') + node.label;
      }
    };
  });
}
function updateEditorTreeSelection() {
  var selected = JSON.stringify(state.view);
  el('tree').querySelectorAll('button[data-view]').forEach(function (button) {
    var current = button.dataset.view === selected;
    button.classList.toggle('on', current);
    if (current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  });
}
function revealEditorSelection() {
  var view = state.view, path = [];
  if (view) {
    if (state.block === 'card') {
      if (view.kind === 'text') path = ['基础字段'];
      else if (view.kind === 'greeting' || view.kind === 'greeting-new') path = ['备选开场'];
      else if (view.kind === 'entry') path = ['世界书', view.book];
      else if (view.kind === 'index' || view.kind === 'extra') path = ['配置'];
      else if (view.kind === 'diagnose' || view.kind === 'preview') path = ['工具'];
    } else if (state.block === 'preset') path = [view.kind === 'p-prompt' ? '提示词条目' : view.kind === 'p-preview' ? '工具' : '配置'];
    else path = [view.kind === 'b-entry' ? '条目' : view.kind === 'b-preview' ? '工具' : '配置'];
  }
  var container = el('tree');
  path.forEach(function (label) {
    if (!container) return;
    var button = Array.from(container.children).find(function (child) { return child.tagName === 'BUTTON' && child.dataset.treeLabel === label; });
    if (!button) { container = null; return; }
    if (button.getAttribute('aria-expanded') === 'false') button.click();
    container = button.nextElementSibling;
  });
  updateEditorTreeSelection();
}
function renderTree() {
  var tree = el('tree');
  tree.innerHTML = '';
  buildTree(treeModel(), tree, 0);
  updateEditorTreeSelection();
}
// ---------- 制卡模式：对话全宽，工作区与写作工具按需覆盖 ----------
var drawerReturnFocus = null;
function syncDrawerBackdrop() {
  el('workspace-drawer').hidden = !state.workspaceOpen;
  el('btn-workspace').setAttribute('aria-expanded', String(state.workspaceOpen));
  el('drawer-backdrop').hidden = !state.workspaceOpen && !state.sidebarOpen;
}
function syncSidebar() {
  ['flow', 'done', 'reference'].forEach(function (id) {
    var open = state.mode === 'make' && state.sidebarOpen === id;
    el(id).classList.toggle('open', open);
    el(id).hidden = !open;
    var button = el('btn-chat-' + id);
    if (button) button.setAttribute('aria-expanded', String(open));
  });
  syncDrawerBackdrop();
}
function restoreDrawerFocus(fallback) {
  var target = drawerReturnFocus;
  drawerReturnFocus = null;
  restoreVisibleToolFocus(target, fallback);
}
function setWorkspaceDrawer(open, moveFocus) {
  var focusBefore = document.activeElement;
  if (open) { closeViewer(false); closeLlmCfg(false); }
  if (open && !state.workspaceOpen && !state.sidebarOpen) drawerReturnFocus = focusBefore;
  state.workspaceOpen = !!open;
  if (open) state.sidebarOpen = '';
  syncSidebar();
  if (moveFocus !== false) {
    if (open) el('workspace-close').focus();
    else restoreDrawerFocus(el('btn-workspace'));
  } else if (!open) drawerReturnFocus = null;
}
function setSidebar(id, moveFocus) {
  var previous = state.sidebarOpen;
  var opening = state.mode === 'make' && ['flow', 'done', 'reference'].indexOf(id) >= 0;
  var focusBefore = document.activeElement;
  closeViewer(false);
  if (opening) closeLlmCfg(false);
  if (opening && !previous && !state.workspaceOpen) drawerReturnFocus = focusBefore;
  state.sidebarOpen = opening ? id : '';
  state.workspaceOpen = false;
  syncSidebar();
  if (moveFocus !== false) {
    if (state.sidebarOpen) { var target = el(state.sidebarOpen + '-close'); if (target) target.focus(); }
    else restoreDrawerFocus(el('btn-chat-' + previous));
  } else if (!state.sidebarOpen) drawerReturnFocus = null;
}
function sidebarHeading(box, title, id) {
  var head = document.createElement('div');
  head.className = 'sidebar-heading';
  var label = document.createElement('div');
  label.className = 'fhead';
  label.textContent = title;
  head.appendChild(label);
  var close = document.createElement('button');
  close.id = id + '-close';
  close.textContent = '收起';
  close.setAttribute('aria-label', '收起' + title);
  close.onclick = function () { setSidebar(''); };
  head.appendChild(close);
  box.appendChild(head);
}
document.addEventListener('keydown', function (event) {
  if (event.defaultPrevented || el('viewer') || document.querySelector('[aria-modal="true"]')) return;
  if (event.key === 'Escape' && !el('log-popover').hidden) {
    event.preventDefault(); el('log-popover').hidden = true; el('log').focus(); return;
  }
  var drawer = state.workspaceOpen ? el('workspace-drawer') : state.sidebarOpen ? el(state.sidebarOpen) : null;
  if (!drawer) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (state.workspaceOpen) setWorkspaceDrawer(false); else setSidebar('');
  } else if (event.key === 'Tab') {
    var focusable = Array.from(drawer.querySelectorAll('button, select, input, [tabindex="0"]')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
}, true);
el('btn-workspace').onclick = function () { setWorkspaceDrawer(!state.workspaceOpen); };
el('workspace-close').onclick = function () { setWorkspaceDrawer(false); };
el('drawer-backdrop').onclick = function () { if (el('viewer')) closeViewer(); else if (state.workspaceOpen) setWorkspaceDrawer(false); else setSidebar(''); };
el('btn-workspace-settings').onclick = function () { setWorkspaceDrawer(false); openLlmCfg(); };
el('btn-workspace-avatar').onclick = function () { setWorkspaceDrawer(false); openChatAvatarSettings(); };
function toggleLogDetails() {
  var popup = el('log-popover'); popup.hidden = !popup.hidden;
  if (!popup.hidden) el('log-close').focus(); else el('log').focus();
}
el('log').onclick = toggleLogDetails;
el('log').onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleLogDetails(); } };
el('log-close').onclick = function () { el('log-popover').hidden = true; el('log').focus(); };
function setMode(m) {
  rememberChatDraft(); rememberEditorDraft();
  state.mode = m;
  setSidebar('', false);
  document.body.classList.toggle('make', m === 'make');
  document.body.classList.toggle('edit', m === 'edit');
  el('btn-mode').textContent = m === 'edit' ? '返回对话' : '编辑卡片';
  if (m === 'edit') { ensureEditPane(); renderTree(); revealEditorSelection(); }
  else { closeModule(); renderFlow(); renderDone(); renderReference(); }
  renderChat();
}
var workflowNavigationPending = false;
function openFromDirective(token, expectedCard) {
  if (state.block !== 'card' || !state.name) { log('请先选择一张角色卡或世界卡', 'warn'); return; }
  var cardName = expectedCard || state.name;
  if (state.name !== cardName) { log('卡片已切换，请使用当前卡片的跳转建议。', 'warn'); return; }
  if (workflowNavigationPending) { log('正在切换模块，请稍等。', 'warn'); return; }
  workflowNavigationPending = true;
  var navigationScope = ++flowSeq;
  function isCurrent() { return state.block === 'card' && state.name === cardName && flowSeq === navigationScope; }
  return api('GET', '/api/workflow/' + encodeURIComponent(cardName)).then(function (r) {
    if (!isCurrent()) return;
    var stage = resolveWorkflowStage(token, availableWorkflowStages(r));
    if (!stage) { log('当前制作计划里没有“' + token + '”，请和助手确认后续步骤。', 'warn'); return; }
    var apply = function () {
      if (!isCurrent()) return;
      r.stage = stage;
      if (r.state) r.state.stage = stage;
      state.flowData = r; state.flowCard = cardName; state.flowOpen = stage;
      state.wfStage = stage;
      var boundModule = window.__refreshChatStage ? window.__refreshChatStage() : '';
      if (state.mode !== 'make') {
        var oldInput = el('chat-input');
        var draft = oldInput ? oldInput.value : '';
        setMode('make');
        var newInput = el('chat-input');
        if (newInput) { newInput.value = draft; autosizeChatInput(newInput); }
      }
      paintFlow();
      setSidebar('flow');
      var target = document.querySelector('#flow [data-stage="' + stage.replace(/"/g, '') + '"]');
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      log('当前制作模块 → ' + workflowStageCaption(stage) + (boundModule ? '；本对话仍专写「' + workflowStageCaption(boundModule) + '」，继续此阶段请使用整卡对话或新建专用对话。' : '；下一条消息会按这个阶段继续。'), 'okc');
    };
    if (stage === r.stage) apply();
    else return api('POST', '/api/workflow/' + encodeURIComponent(cardName), { action: 'goto', stage: stage }).then(apply);
  }).catch(function (e) { if (isCurrent()) log('切换模块失败: ' + e.message, 'err'); }).finally(function () { workflowNavigationPending = false; });
}
function renderFlow() {
  var requestSeq = ++flowSeq;
  var flow = el('flow');
  flow.innerHTML = '';
  flow.appendChild(flowHead());
  if (state.block !== 'card') { flow.appendChild(mutedLine('对话与流程仅支持角色卡和世界卡；预设和独立世界书请进入修改模式，从左侧编辑内容。')); return; }
  if (!state.name) { flow.appendChild(mutedLine('先选一张卡')); return; }
  var cardName = state.name;
  api('GET', '/api/workflow/' + encodeURIComponent(cardName)).then(function (r) {
    if (state.name !== cardName || state.block !== 'card' || requestSeq !== flowSeq) return;
    state.flowData = r;
    state.flowCard = cardName;
    if (!r.state) state.flowOpen = null;
    paintFlow();
  }).catch(function (e) {
    if (state.name !== cardName || state.block !== 'card' || requestSeq !== flowSeq) return;
    var f = el('flow'); f.innerHTML = ''; f.appendChild(flowHead()); f.appendChild(mutedLine('流程读取失败: ' + e.message));
  });
}
function flowHead() {
  var head = document.createElement('div');
  head.className = 'sidebar-heading';
  var label = document.createElement('div'); label.className = 'fhead';
  var track = state.flowData && state.flowData.track ? state.flowData.track : (state.cardTab === 'world' ? '世界观卡' : '角色卡');
  label.textContent = track + '制作流程';
  label.title = '点选可查看概括，并切换当前制作目标';
  head.appendChild(label);
  var close = document.createElement('button'); close.id = 'flow-close'; close.textContent = '收起'; close.setAttribute('aria-label', '收起制作流程');
  close.onclick = function () { setSidebar(''); }; head.appendChild(close);
  return head;
}
function paintFlow() {
  var flow = el('flow');
  var restoreFocus = document.activeElement === el('flow-close');
  flow.innerHTML = '';
  flow.appendChild(flowHead());
  if (restoreFocus) el('flow-close').focus();
  var r = state.flowData;
  if (!r) return;
  renderReference();
  var st = r.state;
  if (!st) {
    var init = document.createElement('button');
    init.className = 'tnode';
    init.textContent = '＋ 初始化制卡流程';
    init.onclick = function () {
      api('POST', '/api/workflow/' + encodeURIComponent(state.name), { action: 'init', cardType: state.cardTab === 'world' ? '世界观卡' : '角色卡' }).then(function () { log('已初始化制卡流程', 'okc'); renderFlow(); });
    };
    flow.appendChild(init);
    flow.appendChild(mutedLine('尚未初始化 workflow.json'));
    return;
  }
  state.wfStage = r.stage;
  if (window.__refreshChatStage) window.__refreshChatStage();
  if (window.__refreshChat) window.__refreshChat();
  if (String(r.stage).startsWith('完成:')) flow.appendChild(mutedLine('计划中的模块已完成。仍可选择模块继续调整，或检查并生成成品。'));
  var all = [{ stage: '00-引导', need: '必', summary: r.leadSummary }].concat(r.modules || []);
  all.forEach(function (m) {
    var open = state.flowOpen === m.stage;
    var b = document.createElement('button');
    b.className = 'tnode' + (m.stage === r.stage ? ' on' : '');
    b.setAttribute('data-stage', m.stage);
    var doneMark = (st.done || []).indexOf(m.stage) >= 0 ? '✓ ' : '';
    var stageLabel = m.stage.replace(/^[^/]+\\//, '');
    stageLabel = workflowStageCaption(stageLabel);
    if (m.stage === '角色卡/01-世界观') stageLabel = '01-世界观简介';
    if (m.stage === '角色卡/02-角色') stageLabel = '02-角色（基础＋性格）';
    b.textContent = (open ? '▾ ' : '▸ ') + doneMark + stageLabel;
    b.title = '点开看这一步在做什么，并把当前目标切到「' + workflowStageCaption(m.stage) + '」';
    b.onclick = function () {
      if (workflowNavigationPending) { log('正在切换模块，请稍等。', 'warn'); return; }
      var cardName = state.name;
      function isCurrent() { return state.block === 'card' && state.name === cardName && state.flowData === r; }
      var wasOpen = state.flowOpen === m.stage;
      state.flowOpen = wasOpen ? null : m.stage;
      if (m.stage !== r.stage) {
        workflowNavigationPending = true; ++flowSeq;
        api('POST', '/api/workflow/' + encodeURIComponent(cardName), { action: 'goto', stage: m.stage })
          .then(function () { if (!isCurrent()) return; r.stage = m.stage; st.stage = m.stage; state.wfStage = m.stage; paintFlow(); log('当前制作模块 → ' + workflowStageCaption(m.stage), 'okc'); })
          .catch(function (e) { if (isCurrent()) { log('切换失败: ' + e.message, 'err'); paintFlow(); } })
          .finally(function () { workflowNavigationPending = false; });
      } else {
        paintFlow();
      }
    };
    flow.appendChild(b);
    if (open) {
      var p = document.createElement('div');
      p.style.cssText = 'margin:2px 0 6px 20px;padding:8px 10px;font-size:12px;line-height:1.65;color:var(--star-ink);background:var(--star-well);border-left:2px solid var(--star-gold);border-radius:4px;white-space:pre-wrap;';
      p.textContent = m.summary || '（这一步暂无概括，可用「修改模式」查看模块文件）';
      flow.appendChild(p);
    }
  });
}
function renderDone() {
  var done = el('done');
  var restoreFocus = document.activeElement === el('done-close');
  done.innerHTML = '';
  sidebarHeading(done, '已保存内容', 'done');
  if (restoreFocus) el('done-close').focus();
  var t = state.tree;
  if (!t) { done.appendChild(mutedLine('先选一张卡')); return; }
  var items = [];
  Object.keys(t.texts || {}).forEach(function (f) { if ((t.texts[f] || '').trim()) items.push({ label: LABELS[f] || f, text: t.texts[f] }); });
  (t.greetings || []).forEach(function (g) { if ((g.content || '').trim()) items.push({ label: '备选开场 · ' + g.file, text: g.content }); });
  (t.books || []).forEach(function (bk) { bk.entries.forEach(function (e) { if ((e.content || '').trim()) items.push({ label: bk.book + ' · ' + e.base, text: e.content }); }); });
  (t.prompts || []).forEach(function (p) { if ((p.content || '').trim()) items.push({ label: '提示词 · ' + p.base, text: p.content }); });
  (t.entries || []).forEach(function (e) { if ((e.content || '').trim()) items.push({ label: '条目 · ' + e.base, text: e.content }); });
  if (!items.length) { done.appendChild(mutedLine('还没有完成的部分')); return; }
  items.forEach(function (it) {
    var b = document.createElement('button');
    b.className = 'tnode';
    b.textContent = '· ' + it.label;
    b.onclick = function () { openViewer(it.label, it.text); };
    done.appendChild(b);
  });
}
function renderReference() {
  var box = el('reference');
  if (!box) return;
  var restoreFocus = document.activeElement === el('reference-close');
  box.innerHTML = '';
  sidebarHeading(box, '写作参考', 'reference');
  if (restoreFocus) el('reference-close').focus();
  if (state.block !== 'card') { box.appendChild(mutedLine('角色卡与世界观卡的分步参考在这里查看。')); return; }
  if (!state.name) { box.appendChild(mutedLine('先选一张卡')); return; }
  var stage = (state.flowData && state.flowData.stage) || state.wfStage || '00-引导';
  if (stage.startsWith('完成:')) {
    box.appendChild(mutedLine('当前制作计划已完成。选择左侧模块后，可以继续查看对应的写作参考。'));
    return;
  }
  var module = (state.flowData && state.flowData.modules || []).find(function (m) { return m.stage === stage; });
  var summary = stage === '00-引导' ? (state.flowData && state.flowData.leadSummary) : module && module.summary;
  var note = document.createElement('div');
  note.className = 'ref-summary';
  note.textContent = summary || '打开说明查看本模块的写法、步骤和例子。';
  box.appendChild(note);
  var open = document.createElement('button');
  open.className = 'tnode';
  open.textContent = '📖 查看「' + workflowStageCaption(stage.split('/').slice(-1)[0]) + '」详细写法';
  open.onclick = function () { openGuide(stage); };
  box.appendChild(open);
  var hint = mutedLine('按步骤说明这一部分写什么、怎么写，并配不同的小例子；独立弹出，不会写入对话。');
  box.appendChild(hint);
}
function mutedLine(s) { var d = document.createElement('div'); d.className = 'muted'; d.style.cssText = 'padding:4px 10px;font-size:12px;'; d.textContent = s; return d; }
function appendGuideInline(parent, text) {
  parent.textContent = String(text).split('**').join('').split(String.fromCharCode(96)).join('');
}
function renderGuideMarkdown(root, markdown) {
  var lines = String(markdown || '').split(String.fromCharCode(10)), skipped = false, fence = String.fromCharCode(96).repeat(3);
  for (var i = 0; i < lines.length;) {
    var line = lines[i], trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    var depth = 0;
    while (trimmed.charAt(depth) === '#') depth++;
    if (depth && trimmed.charAt(depth) === ' ') {
      var sectionTitle = trimmed.slice(depth + 1);
      if (depth === 2) skipped = sectionTitle.indexOf('红线') >= 0 || sectionTitle.indexOf('下一模块') >= 0;
      if (!skipped && depth > 1) { var h = document.createElement(depth === 2 ? 'h2' : 'h3'); h.textContent = sectionTitle; root.appendChild(h); }
      i++; continue;
    }
    if (skipped) { i++; continue; }
    if (trimmed.indexOf(fence) === 0) {
      var codeLines = []; i++;
      while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) codeLines.push(lines[i++]);
      i++;
      var pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = codeLines.join(String.fromCharCode(10)); pre.appendChild(code); root.appendChild(pre); continue;
    }
    if (trimmed.indexOf('>') === 0) {
      var quote = document.createElement('blockquote');
      appendGuideInline(quote, trimmed.slice(1).trimStart()); root.appendChild(quote); i++; continue;
    }
    var first = trimmed.slice(0, 2), firstDot = trimmed.indexOf('.'), numbered = firstDot > 0 && Number.isFinite(Number(trimmed.slice(0, firstDot)));
    var isList = first === '- ' || first === '* ' || numbered;
    if (isList) {
      var ordered = numbered, list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        var itemText = lines[i].trim(), dot = itemText.indexOf('.');
        var itemNumbered = dot > 0 && Number.isFinite(Number(itemText.slice(0, dot)));
        var bullet = itemText.slice(0, 2) === '- ' || itemText.slice(0, 2) === '* ';
        if ((ordered && !itemNumbered) || (!ordered && !bullet)) break;
        var li = document.createElement('li'); appendGuideInline(li, itemNumbered ? itemText.slice(dot + 1).trim() : itemText.slice(2)); list.appendChild(li); i++;
      }
      root.appendChild(list); continue;
    }
    var para = document.createElement('p'), parts = [];
    while (i < lines.length && lines[i].trim()) {
      var next = lines[i].trim(), nextDot = next.indexOf('.');
      var nextNumbered = nextDot > 0 && Number.isFinite(Number(next.slice(0, nextDot)));
      var headingDepth = 0; while (next.charAt(headingDepth) === '#') headingDepth++;
      if ((headingDepth && next.charAt(headingDepth) === ' ') || next.indexOf('>') === 0 || next.indexOf(fence) === 0 || next.slice(0, 2) === '- ' || next.slice(0, 2) === '* ' || nextNumbered) break;
      parts.push(next); i++;
    }
    appendGuideInline(para, parts.join(' ')); root.appendChild(para);
  }
}
var viewerReturnFocus = null;
function bindViewerKeys(viewer) {
  viewer.tabIndex = -1;
  viewer.onkeydown = function (event) {
    if (event.key === 'Escape') { event.preventDefault(); closeViewer(); return; }
    if (event.key !== 'Tab') return;
    var nodes = Array.from(viewer.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
    if (!nodes.length) { event.preventDefault(); viewer.focus(); return; }
    var first = nodes[0], last = nodes[nodes.length - 1];
    var outsideControls = nodes.indexOf(document.activeElement) < 0;
    if (event.shiftKey && (document.activeElement === first || outsideControls)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || outsideControls)) { event.preventDefault(); first.focus(); }
  };
}
function openGuide(stage) {
  var focusBefore = document.activeElement;
  closeViewer(false); closeLlmCfg(false);
  var cardName = state.name;
  var requestSeq = ++guideSeq;
  api('GET', '/api/workflow-guide/' + encodeURIComponent(cardName) + '?stage=' + encodeURIComponent(stage)).then(function (guide) {
    if (state.name !== cardName || state.block !== 'card' || requestSeq !== guideSeq) return;
    viewerReturnFocus = focusBefore;
    var v = document.createElement('div');
    v.id = 'viewer'; v.className = 'guide-viewer'; v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true');
    var head = document.createElement('div'); head.className = 'row guide-header';
    var guideTitle = workflowStageCaption(guide.stage.split('/').slice(-1)[0]);
    if (guide.stage === '角色卡/01-世界观') guideTitle = '01-世界观简介';
    var title = document.createElement('strong'); title.textContent = '写作参考 · ' + guideTitle; head.appendChild(title);
    var source = document.createElement('span'); source.className = 'muted'; source.textContent = guide.source + ' · 只读'; head.appendChild(source);
    var close = document.createElement('button'); close.className = 'guide-close'; close.textContent = '✕ 关闭'; close.onclick = closeViewer; head.appendChild(close);
    var body = document.createElement('div'); body.className = 'guide-body';
    if (guide.source === '模块说明' && guide.summary) { var intro = document.createElement('blockquote'); intro.textContent = guide.summary; body.appendChild(intro); }
    renderGuideMarkdown(body, guide.markdown);
    v.appendChild(head); v.appendChild(body); document.body.appendChild(v); close.focus();
    bindViewerKeys(v); v.focus();
  }).catch(function (e) { if (state.name === cardName && state.block === 'card' && requestSeq === guideSeq) log('参考说明读取失败: ' + e.message, 'err'); });
}
function openViewer(title, text) {
  var focusBefore = document.activeElement;
  closeViewer(false); closeLlmCfg(false);
  viewerReturnFocus = focusBefore;
  var v = document.createElement('div');
  v.id = 'viewer';
  v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true');
  var h = document.createElement('div');
  h.className = 'row';
  var label = document.createElement('strong'); label.textContent = title;
  var hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = '只读查看';
  h.appendChild(label); h.appendChild(hint);
  var x = document.createElement('button');
  x.textContent = '✕ 关闭';
  x.onclick = closeViewer;
  h.appendChild(x);
  var pre = document.createElement('pre');
  pre.textContent = text;
  v.appendChild(h); v.appendChild(pre);
  document.body.appendChild(v);
  bindViewerKeys(v);
  x.focus();
}
function closeViewer(moveFocus) {
  ++guideSeq;
  var v = document.getElementById('viewer');
  if (v) v.remove();
  if (v && moveFocus !== false) restoreVisibleToolFocus(viewerReturnFocus, state.sidebarOpen ? el(state.sidebarOpen + '-close') : el('chat-input'));
  viewerReturnFocus = null;
}
el('btn-mode').onclick = function () {
  setMode(state.mode === 'edit' ? 'make' : 'edit');
  log(state.mode === 'edit' ? '编辑卡片：左侧选择内容，右侧直接修改；需要聊天时点击“返回对话”。' : '对话模式：制作流程、已保存内容与写作参考可从对话上方按需打开。', 'okc');
};
el('cards').onchange = function () { rememberChatDraft(); rememberEditorDraft(); ++state.listSeq; state.name = el('cards').value; state.view = null; openCurrent(); };
el('btn-new').onclick = function () {
  var creationBlock = state.block, creationTab = state.cardTab;
  var creationScope = state.treeSeq;
  var overlay = document.createElement('div');
  overlay.id = 'new-card-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(9,17,39,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
  var panel = document.createElement('div');
  panel.style.cssText = 'width:min(440px,100%);display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid var(--star-border);border-radius:16px;background:var(--star-card-strong);box-shadow:var(--star-shadow);';
  var title = document.createElement('strong');
  title.textContent = state.cardTab === 'world' ? '新建世界卡' : '新建角色卡';
  var hint = document.createElement('div');
  hint.className = 'muted';
  hint.textContent = '给这张卡起个名字，稍后还可以继续填写设定。';
  var nameInput = document.createElement('input');
  nameInput.placeholder = '卡名';
  nameInput.setAttribute('aria-label', '卡名');
  var error = document.createElement('div');
  error.className = 'err';
  error.setAttribute('role', 'alert');
  var actions = document.createElement('div');
  actions.className = 'row';
  actions.style.justifyContent = 'flex-end';
  var cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.onclick = function () { overlay.remove(); };
  var create = document.createElement('button');
  create.className = 'primary';
  create.textContent = '创建';
  create.onclick = function () {
    var name = nameInput.value.trim();
    if (!name) { error.textContent = '先写下卡名。'; nameInput.focus(); return; }
    create.disabled = true;
    error.textContent = '';
    api('POST', '/api/new', { name: name })
      .then(function () { return tabInit(name, creationBlock, creationTab).then(function () { if (state.block === creationBlock && state.cardTab === creationTab && state.treeSeq === creationScope) return loadList(name); }); })
      .then(function () { overlay.remove(); log('已新建: ' + name, 'okc'); })
      .catch(function (e) { create.disabled = false; error.textContent = e.message; log('新建失败: ' + e.message, 'err'); });
  };
  nameInput.onkeydown = function (event) {
    if (event.key === 'Enter') { event.preventDefault(); create.click(); }
    if (event.key === 'Escape') overlay.remove();
  };
  overlay.onclick = function (event) { if (event.target === overlay) overlay.remove(); };
  actions.appendChild(cancel); actions.appendChild(create);
  panel.appendChild(title); panel.appendChild(hint); panel.appendChild(nameInput); panel.appendChild(error); panel.appendChild(actions);
  overlay.appendChild(panel); document.body.appendChild(overlay); nameInput.focus();
};
// 在世界卡栏新建/导入的卡，按世界卡轨初始化流程，否则会被分类过滤掉、选不中
function tabInit(name, block, cardTab) {
  if (block !== 'card' || cardTab !== 'world') return Promise.resolve();
  return api('POST', '/api/workflow/' + encodeURIComponent(name), { action: 'initIfMissing', cardType: '世界观卡' });
}
el('btn-import').onclick = function () { el('import-file').click(); };
el('import-file').onchange = function () {
  var f = el('import-file').files[0];
  if (!f) return;
  var importBlock = state.block, importTab = state.cardTab, importScope = state.treeSeq;
  var reader = new FileReader();
  reader.onload = function () {
    var b64 = String(reader.result).split(',')[1];
    var url = importBlock === 'card' ? '/api/import' : importBlock === 'preset' ? '/api/preset-import' : '/api/worldbook-import';
    var dot = f.name.lastIndexOf('.');
    api('POST', url, { fileName: f.name, name: dot > 0 ? f.name.slice(0, dot) : f.name, base64: b64 })
      .then(function (r) { log('已导入: ' + f.name, 'okc'); var nm = r.dir.split(String.fromCharCode(92)).join('/').split('/').pop(); return tabInit(nm, importBlock, importTab).then(function () { if (state.block === importBlock && state.cardTab === importTab && state.treeSeq === importScope) return loadList(nm); }); })
      .catch(function (e) { log('导入失败: ' + e.message, 'err'); });
  };
  reader.onerror = function () { log('无法读取导入文件，请重新选择。', 'err'); };
  reader.readAsDataURL(f);
  el('import-file').value = '';
};
el('btn-check').onclick = function () {
  if (!state.name) return;
  api('POST', checkUrl() + encodeURIComponent(state.name)).then(function (r) {
    var lines = r.errors.map(function (e) { return '错误: ' + e; }).concat(r.warnings.map(function (w) { return '警告: ' + w; }));
    lines.push(r.errors.length ? 'CHECK FAILED' : 'CHECK OK');
    log(lines.join('\\n'), r.errors.length ? 'err' : 'okc');
  }).catch(function (e) { log('检查失败: ' + e.message, 'err'); });
};
attachArtifactAccess({
  api: api, log: log, buildButton: el('btn-build'), exportButton: el('btn-export-card'), viewButton: el('btn-view-card-artifacts'), refresh: loadList,
  scope: function () { return { name: state.name, targetType: state.block, sequence: state.treeSeq, buildUrl: buildUrl() }; },
});
(function () {
  var saved = null;
  try { saved = localStorage.getItem('xiaoxi-theme'); } catch (e) {}
  document.documentElement.classList.toggle('dark', saved !== 'light');
  var sync = function () { el('btn-theme').textContent = document.documentElement.classList.contains('dark') ? '☀ 白天' : '☾ 夜晚'; };
  el('btn-theme').onclick = function () {
    document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('xiaoxi-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); } catch (e) {}
    sync();
  };
  sync();
})();
document.body.classList.add('make');
api('GET', '/api/app-info').then(function (info) {
  el('app-version').textContent = 'v' + info.version;
  el('app-version').title = (info.desktop ? '当前桌面程序版本：' : '当前工具版本：') + info.version;
}).catch(function () { el('app-version').textContent = '开发版'; });
renderBlocks();
lockDraftStartup(true);
hydrateDrafts().then(function () { return loadList(); }).catch(function () {});
loadPersona();
</script>
</body>
</html>`;
