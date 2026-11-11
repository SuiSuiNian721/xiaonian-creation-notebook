import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaultCharacter = {
  id: 'lin-xiaoli',
  name: '林小璃',
  description: '由星辰与人们的愿力凝聚而生的猫娘，来到人间驱散灾厄、带来温暖、实现心愿。',
  systemPrompt: '你是林小璃，由星辰与人们的愿力凝聚而生的猫娘魂灵。你来到人间，驱散灾厄、带来温暖、实现心愿。以倾听、关怀和帮助他人体现这份设定，使用自然、温暖、坦诚的简体中文。称呼对方时以当前对话提供的信息为准，不为陌生人擅自起名。不确定时坦诚说明，不编造已经执行的现实操作。',
};

export const defaultConfig = {
  llm: { baseUrl: '', model: '', apiKey: '' },
  tts: { baseUrl: '', model: '', voice: 'alloy', apiKey: '' },
  qq: { wsUrl: '', token: '', privateAllow: [], groupAllow: [], requireMention: true },
};

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT NOT NULL,
        peer_id TEXT NOT NULL DEFAULT '', sandbox INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
        delivery TEXT NOT NULL, mode TEXT, audio_url TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL,
        conversation_id TEXT REFERENCES conversations(id), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL,
        message TEXT NOT NULL, level TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS incoming (id TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, filename TEXT NOT NULL);
    `);
    if (!this.getSetting('character')) this.setSetting('character', defaultCharacter);
    if (!this.getSetting('config')) this.setSetting('config', defaultConfig);
    // 上次进程中断时的未确认发送不能继续显示为发送中或已成功。
    this.db.prepare("UPDATE messages SET delivery = 'failed' WHERE delivery = 'sending'").run();
  }

  getSetting(name) { const row = this.db.prepare('SELECT value FROM settings WHERE name = ?').get(name); return row ? JSON.parse(row.value) : null; }
  setSetting(name, value) { this.db.prepare('INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value)); return value; }

  createConversation({ title, channel = 'desktop', peerId = '', sandbox = false }) {
    const id = randomUUID();
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?,?)').run(id, title, channel, peerId, Number(sandbox), at, at);
    return this.conversation(id);
  }

  conversation(id) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) return null;
    const messages = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid').all(id).map(message => ({
      id: message.id, role: message.role, content: message.content, createdAt: message.created_at,
      delivery: message.delivery, ...(message.mode ? { mode: message.mode } : {}),
      ...(message.audio_url ? { audioUrl: message.audio_url } : {}),
    }));
    return { id: row.id, title: row.title, channel: row.channel, peerId: row.peer_id, sandbox: Boolean(row.sandbox), updatedAt: row.updated_at, messages };
  }

  conversations() { return this.db.prepare('SELECT id FROM conversations ORDER BY updated_at DESC, rowid DESC').all().map(row => this.conversation(row.id)); }
  findQQConversation(channel, peerId, sandbox) { const row = this.db.prepare('SELECT id FROM conversations WHERE channel=? AND peer_id=? AND sandbox=? ORDER BY rowid DESC LIMIT 1').get(channel, peerId, Number(sandbox)); return row ? this.conversation(row.id) : null; }

  appendMessage(conversationId, { role, content, delivery, mode = null }) {
    const id = randomUUID();
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO messages(id,conversation_id,role,content,created_at,delivery,mode) VALUES(?,?,?,?,?,?,?)').run(id, conversationId, role, content, at, delivery, mode);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(at, conversationId);
    return this.conversation(conversationId).messages.find(message => message.id === id);
  }

  setDelivery(id, delivery) { this.db.prepare('UPDATE messages SET delivery=? WHERE id=?').run(delivery, id); }
  setAudio(id, audioUrl) { this.db.prepare('UPDATE messages SET audio_url=? WHERE id=?').run(audioUrl, id); }
  memories() { return this.db.prepare('SELECT * FROM memories ORDER BY rowid DESC').all().map(row => ({ id: row.id, content: row.content, conversationId: row.conversation_id, createdAt: row.created_at })); }
  addMemory(content, conversationId = null) { const memory = { id: randomUUID(), content, conversationId, createdAt: new Date().toISOString() }; this.db.prepare('INSERT INTO memories VALUES(?,?,?,?)').run(memory.id, content, conversationId, memory.createdAt); return memory; }
  forgetMemory(id) { return this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0; }

  event(type, message, level = 'info') {
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(randomUUID(), new Date().toISOString(), type, message, level);
    this.db.exec('DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT 200)');
  }
  events() { return this.db.prepare('SELECT * FROM events ORDER BY rowid DESC').all().map(row => ({ ...row })); }
  claimIncoming(id) { return this.db.prepare('INSERT INTO incoming VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(id, new Date().toISOString()).changes > 0; }
  addMedia(id, mime, filename) { this.db.prepare('INSERT INTO media VALUES(?,?,?)').run(id, mime, filename); }
  media(id) { return this.db.prepare('SELECT * FROM media WHERE id=?').get(id); }
  close() { this.db.close(); }
}
