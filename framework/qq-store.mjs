import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchError, text } from './contracts.mjs';

const now = () => new Date().toISOString();
const messageStatuses = new Set(['received', 'queued', 'generating', 'generated', 'sending', 'confirmed', 'failed', 'unknown', 'simulated', 'skipped']);

function message(row) {
  return row ? { id: String(row.id), sequence: row.id, conversationId: row.conversation_id,
    role: row.role, content: row.content, userId: row.user_id, userName: row.user_name,
    sourceMessageId: row.source_message_id, replyTo: row.reply_to === null ? null : String(row.reply_to),
    status: row.status, delivery: row.status, gatewayMessageId: row.gateway_message_id, error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function conversation(row) {
  return row ? { id: row.id, selfId: row.self_id, bindingId: row.binding_id, channel: row.channel, peerId: row.peer_id,
    storyId: row.story_id, sandbox: Boolean(row.sandbox), active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function memory(row) {
  return row ? { id: row.id, conversationId: row.conversation_id, content: row.content, sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
    sourceQuote: row.source_quote, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

/** QQ 拥有自己的数据库；不导入或迁移虚拟陪伴、旧 QQ 项目的数据。 */
export class QQStore {
  constructor(dataDir) {
    const directory = join(dataDir, 'qq'); mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'qq.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new WorkbenchError(409, 'QQ 数据库版本高于当前程序，未修改数据。'); }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, self_id TEXT NOT NULL, binding_id TEXT NOT NULL REFERENCES bindings(id),
        channel TEXT NOT NULL CHECK(channel IN ('private','group')), peer_id TEXT NOT NULL,
        story_id TEXT NOT NULL, sandbox INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(self_id,binding_id,channel,peer_id,story_id,sandbox)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_route ON conversations(self_id,binding_id,channel,peer_id,sandbox) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        user_id TEXT, user_name TEXT, source_message_id TEXT, reply_to INTEGER REFERENCES messages(id),
        status TEXT NOT NULL, gateway_message_id TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS message_context ON messages(conversation_id,id);
      CREATE TABLE IF NOT EXISTS inbound_events (
        dedup_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        source_message_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summaries (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), content TEXT NOT NULL,
        through_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), content TEXT NOT NULL,
        source_message_id INTEGER REFERENCES messages(id), source_quote TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_context ON memories(conversation_id,created_at);
      PRAGMA user_version = 1;
    `);
    // 重启只恢复可查询记录，不恢复发信任务。sending 可能已送达，绝不能重试。
    const at = now();
    this.db.prepare("UPDATE messages SET status = 'unknown', error = ?, updated_at = ? WHERE role = 'assistant' AND status = 'sending'").run('工作台在发送确认前关闭，送达结果未知。', at);
    this.db.prepare("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE role = 'assistant' AND status IN ('queued','generating','generated')").run('工作台已重启，旧回复未发送。', at);
    this.db.prepare("UPDATE inbound_events SET status = 'abandoned', error = ?, updated_at = ? WHERE status IN ('queued','generating','generated','sending')").run('工作台已重启，此入站不会追发。', at);
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getSetting(name) { const row = this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name); return row ? JSON.parse(row.value) : undefined; }
  setSetting(name, value) { this.db.prepare('INSERT INTO settings VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, JSON.stringify(value)); }

  binding(id = this.getSetting('bindingId')) {
    if (!id) return null;
    const row = this.db.prepare('SELECT snapshot FROM bindings WHERE id = ?').get(id);
    return row ? JSON.parse(row.snapshot) : null;
  }

  saveBinding(card) {
    if (card === null) { this.setSetting('bindingId', null); return null; }
    const current = this.binding();
    if (current?.hash === card.hash && current.characterId === card.characterId && current.revision === card.revision) return current;
    const snapshot = { ...structuredClone(card), id: randomUUID(), createdAt: now() };
    this.transaction(() => {
      this.db.prepare('INSERT INTO bindings VALUES(?, ?, ?)').run(snapshot.id, JSON.stringify(snapshot), snapshot.createdAt);
      this.setSetting('bindingId', snapshot.id);
    });
    return snapshot;
  }

  requireConversation(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new WorkbenchError(400, 'QQ 会话标识无效。');
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) throw new WorkbenchError(404, '找不到这个 QQ 会话。');
    return conversation(row);
  }

  ensureConversation({ selfId, bindingId, channel, peerId, sandbox = false }) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE self_id = ? AND binding_id = ? AND channel = ? AND peer_id = ? AND sandbox = ? AND active = 1')
      .get(selfId, bindingId, channel, peerId, Number(sandbox));
    if (row) return conversation(row);
    const id = randomUUID(), at = now();
    this.db.prepare('INSERT INTO conversations VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(id, selfId, bindingId, channel, peerId, randomUUID(), Number(sandbox), at, at);
    return this.requireConversation(id);
  }

  newStory(id) {
    const prior = this.requireConversation(id);
    return this.transaction(() => {
      this.db.prepare('UPDATE conversations SET active = 0 WHERE self_id = ? AND binding_id = ? AND channel = ? AND peer_id = ? AND sandbox = ? AND active = 1')
        .run(prior.selfId, prior.bindingId, prior.channel, prior.peerId, Number(prior.sandbox));
      return this.ensureConversation(prior);
    });
  }

  conversations() {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC').all().map(row => {
      const value = conversation(row), binding = this.binding(row.binding_id);
      const last = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(row.id);
      const count = this.db.prepare('SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?').get(row.id).total;
      return { ...value, characterId: binding?.characterId ?? null, characterName: binding?.name ?? '', revision: binding?.revision ?? null,
        messageCount: count, lastMessage: last ? { content: last.content.slice(0, 200), role: last.role, status: last.status } : null };
    });
  }

  claimInbound(conversationId, event) {
    const current = this.requireConversation(conversationId);
    return this.transaction(() => {
      const at = now();
      const claimed = this.db.prepare("INSERT OR IGNORE INTO inbound_events VALUES(?, ?, ?, 'queued', NULL, ?, ?)").run(event.dedupId, conversationId, event.sourceMessageId, at, at);
      if (!claimed.changes) return null;
      const user = this.db.prepare('INSERT INTO messages(conversation_id,role,content,user_id,user_name,source_message_id,status,created_at,updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(conversationId, 'user', event.text, event.userId, event.userName ?? event.userId, event.sourceMessageId, current.sandbox ? 'simulated' : 'received', at, at);
      const reply = this.db.prepare("INSERT INTO messages(conversation_id,role,content,reply_to,status,created_at,updated_at) VALUES(?, 'assistant', '', ?, 'queued', ?, ?)")
        .run(conversationId, Number(user.lastInsertRowid), at, at);
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, conversationId);
      return { user: this.message(String(user.lastInsertRowid)), reply: this.message(String(reply.lastInsertRowid)) };
    });
  }

  claimOutgoing(conversationId, sourceId, content) {
    this.requireConversation(conversationId);
    return this.transaction(() => {
      const at = now();
      const claimed = this.db.prepare("INSERT OR IGNORE INTO inbound_events VALUES(?, ?, ?, 'queued', NULL, ?, ?)").run(sourceId, conversationId, sourceId, at, at);
      if (!claimed.changes) return null;
      const reply = this.db.prepare("INSERT INTO messages(conversation_id,role,content,source_message_id,status,created_at,updated_at) VALUES(?, 'assistant', ?, ?, 'queued', ?, ?)").run(conversationId, content, sourceId, at, at);
      return { user: null, reply: this.message(String(reply.lastInsertRowid)) };
    });
  }

  inboundState(dedupId) {
    const row = this.db.prepare('SELECT * FROM inbound_events WHERE dedup_id = ?').get(dedupId);
    return row ? { dedupId: row.dedup_id, conversationId: row.conversation_id, status: row.status, error: row.error } : null;
  }

  updateInbound(dedupId, status, error = null) { this.db.prepare('UPDATE inbound_events SET status = ?, error = ?, updated_at = ? WHERE dedup_id = ?').run(status, error, now(), dedupId); }

  message(id) {
    if (!/^\d+$/.test(String(id))) return null;
    return message(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(String(id)));
  }

  updateMessage(id, { status, content, gatewayMessageId, error } = {}) {
    const current = this.message(id);
    if (!current) throw new WorkbenchError(404, '找不到这条 QQ 消息。');
    if (status !== undefined && !messageStatuses.has(status)) throw new WorkbenchError(400, 'QQ 消息状态无效。');
    this.db.prepare('UPDATE messages SET status = ?, content = ?, gateway_message_id = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status ?? current.status, content ?? current.content, gatewayMessageId ?? current.gatewayMessageId, error === undefined ? current.error : error, now(), String(id));
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), current.conversationId);
    return this.message(id);
  }

  messages(conversationId) {
    this.requireConversation(conversationId);
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId).map(message);
  }

  history(conversationId, throughSequence = Number.MAX_SAFE_INTEGER) {
    this.requireConversation(conversationId);
    return this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND id <= ? AND (role = 'user' OR status IN ('confirmed','simulated')) ORDER BY id")
      .all(conversationId, throughSequence).map(message);
  }

  summary(conversationId) {
    this.requireConversation(conversationId);
    const row = this.db.prepare('SELECT * FROM summaries WHERE conversation_id = ?').get(conversationId);
    return row ? { content: row.content, throughSequence: row.through_sequence, updatedAt: row.updated_at } : { content: '', throughSequence: 0, updatedAt: null };
  }

  saveSummary(conversationId, { content, throughSequence }) {
    const prior = this.summary(conversationId);
    if (!Number.isSafeInteger(throughSequence) || throughSequence < prior.throughSequence || throughSequence < 1) throw new WorkbenchError(400, '摘要水位无效或发生倒退。');
    const source = this.message(String(throughSequence));
    if (!source || source.conversationId !== conversationId || (source.role === 'assistant' && !['confirmed', 'simulated'].includes(source.status))) throw new WorkbenchError(400, '摘要水位必须属于这个会话的已确认历史。');
    this.db.prepare('INSERT INTO summaries VALUES(?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET content = excluded.content, through_sequence = excluded.through_sequence, updated_at = excluded.updated_at')
      .run(conversationId, text(content, 'QQ 摘要', 12000), throughSequence, now());
    return this.summary(conversationId);
  }

  memories(conversationId) {
    this.requireConversation(conversationId);
    return this.db.prepare('SELECT * FROM memories WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId).map(memory);
  }

  saveMemory({ conversationId, id, content, sourceMessageId } = {}) {
    this.requireConversation(conversationId);
    content = text(content, '长期记忆', 4000);
    let prior;
    if (id !== undefined) {
      if (typeof id !== 'string') throw new WorkbenchError(400, '记忆标识无效。');
      prior = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (!prior || prior.conversation_id !== conversationId) throw new WorkbenchError(404, '这个会话中没有该条记忆。');
    }
    const sourceId = sourceMessageId === undefined ? prior?.source_message_id ?? null : sourceMessageId;
    let source = null;
    if (sourceId !== null) {
      source = this.message(sourceId);
      if (!source || source.conversationId !== conversationId || (source.role === 'assistant' && !['confirmed', 'simulated'].includes(source.status))) throw new WorkbenchError(400, '记忆来源必须属于这个会话的已确认消息。');
    }
    const key = prior?.id ?? randomUUID(), at = now();
    this.db.prepare('INSERT INTO memories VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, source_message_id = excluded.source_message_id, source_quote = excluded.source_quote, updated_at = excluded.updated_at')
      .run(key, conversationId, content, source ? Number(source.id) : null, source?.content ?? null, prior?.created_at ?? at, at);
    return memory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(key));
  }

  deleteMemory(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new WorkbenchError(400, '记忆标识无效。');
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes === 1;
  }

  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
