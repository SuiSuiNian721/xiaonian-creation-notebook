import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { QQClient, parseOneBotMessage } from './qq.mjs';
import { AppError, modelReply, synthesize } from './providers.mjs';

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, '请求必须是 JSON 对象。');
  return value;
}

function text(value, label, { max = 8000, empty = false } = {}) {
  if (typeof value !== 'string') throw new AppError(400, `${label}必须是文字。`);
  const result = value.trim();
  if ((!empty && !result) || result.length > max) throw new AppError(400, `${label}${empty ? '' : '不能为空，且'}最多 ${max} 个字符。`);
  return result;
}

function providerUrl(value, label, schemes) {
  const address = text(value, label, { max: 2000, empty: true });
  if (!address) return '';
  let parsed;
  try { parsed = new URL(address); } catch { throw new AppError(400, `${label}不是有效地址。`); }
  if (!schemes.includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new AppError(400, `${label}的协议或格式不受支持。`);
  if (parsed.search) throw new AppError(400, `${label}请勿包含查询参数；密钥请单独填写。`);
  return parsed.href.replace(/\/+$/, '');
}

function ids(value, label) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，\s]+/).filter(Boolean) : null;
  if (!list || list.length > 100 || list.some(id => !/^\d{1,20}$/.test(String(id)))) throw new AppError(400, `${label}应为最多 100 个 QQ 号码。`);
  return [...new Set(list.map(String))];
}

function peer(value) {
  const result = String(value ?? '');
  if (!/^\d{1,20}$/.test(result)) throw new AppError(400, 'QQ 号码应为 1 至 20 位数字。');
  return result;
}

export function publicConfig(config) {
  const { apiKey: llmKey, ...llm } = config.llm;
  const { apiKey: ttsKey, ...tts } = config.tts;
  const { token, ...qq } = config.qq;
  return { llm: { ...llm, hasKey: Boolean(llmKey) }, tts: { ...tts, hasKey: Boolean(ttsKey) }, qq: { ...qq, hasToken: Boolean(token) } };
}

export class Domain {
  constructor({ dataDir, airi }) {
    this.dataDir = dataDir;
    this.airi = airi;
    this.store = new Store(dataDir);
    if (!this.store.getSetting('ui-preferences')) this.store.setSetting('ui-preferences', { theme: 'light' });
    this.queues = new Map();
    this.abort = new AbortController();
    this.qq = new QQClient({ onMessage: event => this.receiveQQ(event), onEvent: (...args) => { if (!this.closing) this.store.event(...args); } });
    this.store.event('system', '角色工作台已启动；QQ 默认离线。');
  }

  state() {
    const config = this.store.getSetting('config');
    const preferences = this.store.getSetting('ui-preferences');
    return {
      character: this.store.getSetting('character'), conversations: this.store.conversations(),
      memories: this.store.memories(), events: this.store.events(), config: publicConfig(config),
      preferences: { theme: preferences?.theme === 'dark' ? 'dark' : 'light' },
      status: {
        model: config.llm.baseUrl && config.llm.model ? 'configured' : 'offline',
        tts: config.tts.baseUrl && config.tts.model && config.tts.voice ? 'configured' : 'unconfigured',
        qq: this.qq.status,
        airi: { available: Boolean(this.airi?.available), url: this.airi?.available ? this.airi.url ?? '/airi/' : null, version: this.airi?.version ?? null, note: this.airi?.note ?? '未找到可用的 AIRI 舞台资源。' },
      },
    };
  }

  updatePreferences(input) {
    object(input);
    if (input.theme !== 'light' && input.theme !== 'dark') throw new AppError(400, '主题只能是 light 或 dark。');
    const preferences = { theme: input.theme };
    this.store.setSetting('ui-preferences', preferences);
    return { preferences };
  }

  updateConfig(input) {
    object(input);
    const previous = this.store.getSetting('config');
    const next = structuredClone(previous);
    for (const name of ['llm', 'tts']) {
      if (input[name] === undefined) continue;
      const value = object(input[name]);
      if (value.baseUrl !== undefined) next[name].baseUrl = providerUrl(value.baseUrl, '服务地址', ['http:', 'https:']);
      if (value.model !== undefined) next[name].model = text(value.model, '模型名称', { max: 200, empty: true });
      if (name === 'tts' && value.voice !== undefined) next.tts.voice = text(value.voice, '音色', { max: 200, empty: true });
      if (value.apiKey !== undefined) { const key = text(value.apiKey, '密钥', { max: 4096, empty: true }); if (key) next[name].apiKey = key; }
      if (value.clearKey === true) next[name].apiKey = '';
    }
    if (input.qq !== undefined) {
      const value = object(input.qq);
      if (value.wsUrl !== undefined) {
        // 令牌只通过专用字段保存，永不在返回给界面的 URL 中出现。
        let address = text(value.wsUrl, 'WebSocket 地址', { max: 2000, empty: true });
        if (address) {
          let parsed;
          try { parsed = new URL(address); } catch { throw new AppError(400, 'WebSocket 地址不是有效地址。'); }
          const embedded = parsed.searchParams.get('access_token') ?? parsed.searchParams.get('token');
          if (embedded) next.qq.token = text(embedded, '令牌', { max: 4096 });
          parsed.searchParams.delete('access_token'); parsed.searchParams.delete('token');
          address = parsed.href;
        }
        next.qq.wsUrl = providerUrl(address, 'WebSocket 地址', ['ws:', 'wss:']);
      }
      if (value.token !== undefined) { const token = text(value.token, '令牌', { max: 4096, empty: true }); if (token) next.qq.token = token; }
      if (value.clearKey === true) next.qq.token = '';
      if (value.privateAllow !== undefined) next.qq.privateAllow = ids(value.privateAllow, '私聊允许名单');
      if (value.groupAllow !== undefined) next.qq.groupAllow = ids(value.groupAllow, '群聊允许名单');
      if (value.requireMention !== undefined) {
        if (typeof value.requireMention !== 'boolean') throw new AppError(400, '是否需要 @ 必须是布尔值。');
        next.qq.requireMention = value.requireMention;
      }
    }
    this.store.setSetting('config', next);
    if (previous.qq.wsUrl !== next.qq.wsUrl || previous.qq.token !== next.qq.token) this.qq.disconnect(false);
    this.store.event('config', '连接配置已保存；保存配置不会自动建立 QQ 连接。');
    return { config: publicConfig(next) };
  }

  updateCharacter(input) {
    object(input);
    const character = this.store.getSetting('character');
    character.name = text(input.name, '角色名称', { max: 80 });
    character.description = text(input.description, '角色简介', { max: 4000, empty: true });
    character.systemPrompt = text(input.systemPrompt, '角色人设', { max: 16000 });
    this.store.setSetting('character', character);
    this.store.event('character', '角色资料已更新，之后的回复使用新的人设。');
    return { character };
  }

  createConversation(input) {
    object(input);
    const channel = input.channel ?? 'desktop';
    if (!['desktop', 'qq-private', 'qq-group'].includes(channel)) throw new AppError(400, '不支持的会话渠道。');
    const peerId = channel === 'desktop' ? '' : peer(input.peerId);
    const title = input.title === undefined ? channel === 'desktop' ? '新的对话' : `QQ ${peerId}` : text(input.title, '会话标题', { max: 100 });
    return { conversation: this.store.createConversation({ title, channel, peerId }) };
  }

  requireConversation(id) {
    if (typeof id !== 'string') throw new AppError(400, '缺少会话编号。');
    const conversation = this.store.conversation(id);
    if (!conversation) throw new AppError(404, '找不到这个会话。');
    return conversation;
  }

  addMemory(input) {
    object(input);
    const content = text(input.content, '记忆内容', { max: 4000 });
    const conversationId = input.conversationId || null;
    if (conversationId) this.requireConversation(conversationId);
    const memory = this.store.addMemory(content, conversationId);
    this.store.event('memory', '已保存一条由用户明确添加的记忆。');
    return { memory };
  }

  forgetMemory(id) {
    if (!this.store.forgetMemory(id)) throw new AppError(404, '找不到这条记忆。');
    this.store.event('memory', '已删除指定记忆，之后的模型请求不再附带它。');
    return { ok: true };
  }

  enqueue(id, work) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.queues.set(id, current);
    void current.finally(() => { if (this.queues.get(id) === current) this.queues.delete(id); }).catch(() => {});
    return current;
  }

  async reply(conversationId) {
    const conversation = this.requireConversation(conversationId);
    return this.replyMessages(conversation.messages.slice(-60).map(message => ({ role: message.role, content: message.content })), conversationId);
  }

  async replyMessages(history, conversationId = null) {
    const character = this.store.getSetting('character');
    const config = this.store.getSetting('config').llm;
    if (!config.baseUrl || !config.model) {
      const last = history.at(-1).content;
      return { mode: 'demo', content: `【离线演示】${character.name}：我听到你说“${last.slice(0, 180)}”。这里已经保存了我们的对话；连接模型后，我会按照你设置的人设认真回应。` };
    }
    const memories = this.store.memories().filter(memory => !memory.conversationId || memory.conversationId === conversationId).slice(0, 40);
    const system = `角色名称：${character.name}\n角色简介：${character.description}\n${character.systemPrompt}${memories.length ? `\n\n用户明确保存的记忆：\n${memories.map(memory => `- ${memory.content}`).join('\n')}` : ''}`;
    const messages = [{ role: 'system', content: system }, ...history];
    return { mode: 'model', content: await modelReply(config, messages, this.abort.signal) };
  }

  async compatibleCompletion(input) {
    object(input);
    if (input.stream === true) throw new AppError(400, '当前 Demo 的兼容接口仅支持 stream:false。');
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 60) throw new AppError(400, 'messages 应包含 1 至 60 条消息。');
    const history = input.messages.map(message => {
      object(message);
      if (!['system', 'user', 'assistant'].includes(message.role)) throw new AppError(400, '兼容接口仅接受 system、user 和 assistant 消息。');
      return { role: message.role, content: text(message.content, '消息内容') };
    });
    if (!history.some(message => message.role === 'user')) throw new AppError(400, '请提供至少一条用户消息。');
    // 兼容入口沿用工作台人设和全局记忆；历史由调用方提供，不创建另一份角色。
    const reply = await this.replyMessages(history);
    return {
      id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: this.store.getSetting('config').llm.model || 'ai-future-demo', mode: reply.mode,
      choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: 'stop' }],
    };
  }

  async generate(conversationId, inputText, { sandbox = false, live = false, connectionId, qqMessage } = {}) {
    this.store.appendMessage(conversationId, { role: 'user', content: inputText, delivery: sandbox ? 'simulated' : live ? 'received' : 'local' });
    let reply;
    try { reply = await this.reply(conversationId); }
    catch (error) { this.store.event('model', error instanceof AppError ? error.message : '模型生成失败。', 'error'); throw error; }
    const message = this.store.appendMessage(conversationId, { role: 'assistant', content: reply.content, mode: reply.mode, delivery: sandbox ? 'simulated' : live ? 'sending' : 'generated' });
    if (live) {
      const conversation = this.requireConversation(conversationId);
      try {
        const reason = this.allowedQQ(qqMessage);
        if (reason) throw new AppError(409, `QQ 回复尚未发送：当前规则已不再允许此消息。${reason}`);
        await this.qq.send(conversation.channel, conversation.peerId, reply.content, connectionId);
        this.store.setDelivery(message.id, 'sent');
        this.store.event('qq', 'QQ 服务已确认发送一条回复。');
      } catch (error) {
        this.store.setDelivery(message.id, 'failed');
        this.store.event('qq', error instanceof AppError ? error.message : 'QQ 发送失败。', 'error');
      }
    }
    return { conversation: this.requireConversation(conversationId), mode: reply.mode };
  }

  chat(input) {
    object(input);
    const conversation = this.requireConversation(input.conversationId);
    const content = text(input.text, '消息内容');
    // 工作台的“生成回复”仅在本地生成，不隐式向 QQ 转发。
    return this.enqueue(conversation.id, () => this.generate(conversation.id, content, { sandbox: conversation.sandbox }));
  }

  allowedQQ(message) {
    const config = this.store.getSetting('config').qq;
    if (message.channel === 'qq-private' && !config.privateAllow.includes(message.peerId)) return '此用户不在私聊允许名单中。';
    if (message.channel === 'qq-group' && !config.groupAllow.includes(message.peerId)) return '此群不在群聊允许名单中。';
    if (message.channel === 'qq-group' && config.requireMention && !message.mentioned) return '此群消息没有 @ 当前机器人。';
    return null;
  }

  qqConversation(message, sandbox) {
    return this.store.findQQConversation(message.channel, message.peerId, sandbox) ?? this.store.createConversation({
      title: `${sandbox ? '沙盒 · ' : ''}${message.channel === 'qq-group' ? 'QQ群' : 'QQ私聊'} ${message.peerId}`,
      channel: message.channel, peerId: message.peerId, sandbox,
    });
  }

  async simulate(input) {
    object(input);
    if (!['qq-private', 'qq-group'].includes(input.channel)) throw new AppError(400, '沙盒只接受 QQ 私聊或群聊渠道。');
    const message = { channel: input.channel, peerId: peer(input.peerId), userId: input.userId === undefined ? undefined : peer(input.userId), text: text(input.text, '消息内容'), mentioned: input.mentioned === true };
    const reason = this.allowedQQ(message);
    if (reason) { this.store.event('sandbox', `沙盒已忽略消息：${reason}`); return { accepted: false, reason }; }
    const conversation = this.qqConversation(message, true);
    const content = message.channel === 'qq-group' ? `[群成员 ${message.userId ?? '沙盒用户'}] ${message.text}` : message.text;
    const reply = await this.enqueue(conversation.id, () => this.generate(conversation.id, content, { sandbox: true }));
    this.store.event('sandbox', '沙盒回复已生成；没有调用 QQ 发送接口。');
    return { accepted: true, ...reply };
  }

  async receiveQQ(event) {
    const message = parseOneBotMessage(event);
    if (!message || this.allowedQQ(message)) return;
    if (!this.store.claimIncoming(message.dedupId)) return;
    const conversation = this.qqConversation(message, false);
    const connectionId = this.qq.connectionId;
    const content = message.channel === 'qq-group' ? `[群成员 ${message.userId}] ${message.text}` : message.text;
    await this.enqueue(conversation.id, () => this.generate(conversation.id, content, { live: true, connectionId, qqMessage: message }));
  }

  async speech(input) {
    object(input);
    const conversation = this.requireConversation(input.conversationId);
    const message = conversation.messages.find(message => message.id === input.messageId && message.role === 'assistant');
    if (!message) throw new AppError(404, '找不到可合成语音的角色回复。');
    const config = this.store.getSetting('config').tts;
    if (!config.baseUrl || !config.model || !config.voice) throw new AppError(400, '请先配置语音服务地址、模型与音色。');
    try {
      const audio = await synthesize(config, message.content, this.abort.signal);
      const id = randomUUID();
      const filename = `${id}.${audio.extension}`;
      await mkdir(join(this.dataDir, 'media'), { recursive: true });
      await writeFile(join(this.dataDir, 'media', filename), audio.bytes, { flag: 'wx' });
      this.store.addMedia(id, audio.mime, filename);
      const audioUrl = `/media/${id}`;
      this.store.setAudio(message.id, audioUrl);
      this.store.event('speech', '语音已生成并保存；等待用户主动播放。');
      return { audioUrl };
    } catch (error) { this.store.event('speech', error instanceof AppError ? error.message : '语音保存失败。', 'error'); throw error; }
  }

  async close() {
    this.closing = true;
    this.abort.abort();
    this.qq.disconnect(false);
    await Promise.allSettled(this.queues.values());
    this.store.close();
  }
}
