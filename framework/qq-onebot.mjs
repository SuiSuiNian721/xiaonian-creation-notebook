import { randomUUID } from 'node:crypto';
import { WorkbenchError } from './contracts.mjs';

export function qqId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return (typeof value === 'string' || typeof value === 'number') && /^\d{1,20}$/.test(String(value)) ? String(value) : null;
}

function messageId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return (typeof value === 'string' || typeof value === 'number') && /^-?\d{1,32}$/.test(String(value)) ? String(value) : null;
}

export function normalizeQQChannel(channel) { return channel === 'qq-private' ? 'private' : channel === 'qq-group' ? 'group' : channel; }

export function parseOneBotMessage(event, { selfId, receivedAfter = 0, includeMedia = false } = {}) {
  if (!event || event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  const actualSelf = qqId(event.self_id), userId = qqId(event.user_id), sourceMessageId = messageId(event.message_id);
  if (!actualSelf || !userId || !sourceMessageId || userId === actualSelf || (selfId && actualSelf !== selfId)) return null;
  if (typeof event.time === 'number' && Number.isFinite(event.time) && event.time * 1000 < receivedAfter) return null;
  const channel = event.message_type, peerId = channel === 'group' ? qqId(event.group_id) : userId;
  if (!peerId) return null;
  let text = '', mentioned = false; const attachments = [];
  if (Array.isArray(event.message)) {
    for (const segment of event.message) {
      if (segment?.type === 'text' && typeof segment.data?.text === 'string') text += segment.data.text;
      if (segment?.type === 'at' && String(segment.data?.qq) === actualSelf) mentioned = true;
      if (includeMedia && segment?.type === 'image' && attachments.length < 4 && typeof segment.data?.url === 'string' && segment.data.url.length < 4096 && /^https?:\/\/[^\s\0]+$/i.test(segment.data.url)) attachments.push({ type: 'image', url: segment.data.url });
    }
  } else if (typeof event.message === 'string' || typeof event.raw_message === 'string') {
    text = event.message ?? event.raw_message;
    text = text.replace(/\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]/g, (_match, id) => { if (id === actualSelf) mentioned = true; return ''; })
      .replace(/\[CQ:[^\]]*\]/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
  }
  text = text.trim();
  if (!text && attachments.length) text = '[图片]';
  if (!text || text.length > 8000 || text.includes('\0')) return null;
  return { selfId: actualSelf, channel, peerId, userId,
    userName: String(event.sender?.card || event.sender?.nickname || userId).slice(0, 120),
    text, mentioned, sourceMessageId, dedupId: `${actualSelf}:${channel}:${peerId}:${sourceMessageId}`, ...(attachments.length ? { attachments } : {}) };
}

function failure(message, delivery, status = 502) {
  const error = new WorkbenchError(status, message);
  if (delivery) error.delivery = delivery;
  return error;
}

/** 正向 WS 的通用 RPC；只有 send_* 需要 message_id 确认。 */
export class OneBotTransport {
  constructor({ WebSocketImpl = globalThis.WebSocket, requestTimeoutMs = 8000, connectTimeoutMs = 5000, heartbeatIntervalMs = 30_000, onMessage = () => {}, onDisconnect = () => {} } = {}) {
    this.WebSocketImpl = WebSocketImpl; this.requestTimeoutMs = requestTimeoutMs; this.connectTimeoutMs = connectTimeoutMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs; this.onMessage = onMessage; this.onDisconnect = onDisconnect;
    this.pending = new Map(); this.socket = null; this.info = { status: 'disconnected', selfId: null, nickname: '', connectionId: null, connectedAt: null, lastError: null };
  }

  state() { return { ...this.info }; }

  async connect({ wsUrl, token = '', expectedAccountId } = {}) {
    this.disconnect();
    let address;
    try { address = new URL(wsUrl); } catch { throw failure('OneBot WebSocket 地址无效。', null, 400); }
    if (!['ws:', 'wss:'].includes(address.protocol) || address.username || address.password || address.hash) throw failure('OneBot 需要 ws 或 wss 地址。', null, 400);
    if (expectedAccountId !== undefined && expectedAccountId !== null && !qqId(expectedAccountId)) throw failure('预期 QQ 账号无效。', null, 400);
    if (token) address.searchParams.set('access_token', token);
    this.info = { status: 'connecting', selfId: null, nickname: '', connectionId: randomUUID(), connectedAt: null, lastError: null };
    let socket;
    try { socket = new this.WebSocketImpl(address.toString()); } catch { this.info.status = 'error'; throw failure('无法创建 OneBot 连接。'); }
    this.socket = socket;
    socket.addEventListener('message', event => this.receive(socket, event));
    socket.addEventListener('close', () => this.dropped(socket));
    socket.addEventListener('error', () => { if (this.socket === socket && this.info.status === 'verified') this.dropped(socket); });
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('close', closed); socket.removeEventListener('error', closed);
          error ? reject(error) : resolve();
        };
        const opened = () => this.socket === socket ? finish() : finish(failure('OneBot 连接已取消。'));
        const closed = () => finish(failure('无法连接 OneBot，请检查运行端、地址和令牌。'));
        const timer = setTimeout(() => finish(failure('OneBot 连接超时。')), this.connectTimeoutMs);
        socket.addEventListener('open', opened, { once: true }); socket.addEventListener('close', closed, { once: true }); socket.addEventListener('error', closed, { once: true });
      });
      const login = await this.rpc('get_login_info');
      const status = await this.rpc('get_status');
      const actual = qqId(login?.user_id);
      if (!actual || (expectedAccountId != null && actual !== String(expectedAccountId))) {
        const error = failure('OneBot 实际 QQ 身份与预期身份不符。'); error.identityMismatch = true; throw error;
      }
      if (status?.online !== true || status?.good === false) throw failure('OneBot 尚未提供 QQ 在线证据。');
      if (this.socket !== socket) throw failure('OneBot 连接已取消。');
      this.info = { ...this.info, status: 'verified', selfId: actual, nickname: typeof login.nickname === 'string' ? login.nickname.slice(0, 120) : '', connectedAt: new Date().toISOString() };
      this.startHeartbeat();
      return this.state();
    } catch (error) {
      const connectionId = this.info.connectionId;
      if (this.socket === socket) this.disconnect();
      this.info = { ...this.info, status: error.identityMismatch ? 'identity-mismatch' : 'error', connectionId, lastError: error.message };
      throw error;
    }
  }

  receive(socket, event) {
    if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 256 * 1024) return;
    let value;
    try { value = JSON.parse(event.data); } catch { return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const pending = typeof value.echo === 'string' ? this.pending.get(value.echo) : null;
    if (pending) {
      if (value.status === 'ok' && value.retcode === 0) {
        if (pending.sending && !messageId(value.data?.message_id)) pending.finish(failure('OneBot 没有返回有效发送编号，送达结果未知。', 'unknown'));
        else pending.finish(null, value.data);
      } else pending.finish(failure(`OneBot 拒绝操作（返回码 ${Number.isInteger(value.retcode) ? value.retcode : '未知'}）。`, pending.sending ? 'failed' : null));
      return;
    }
    if (this.info.status === 'verified' && value.post_type === 'message') {
      Promise.resolve().then(() => this.onMessage(value)).catch(() => {});
    }
  }

  rpc(action, params = {}, { signal, sending = false, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.socket || this.socket.readyState !== 1 || !['connecting', 'verified'].includes(this.info.status)) return Promise.reject(failure('OneBot 未连接，消息未发送。', sending ? 'failed' : null));
    if (signal?.aborted) return Promise.reject(failure('OneBot 操作已取消。', sending ? 'failed' : null));
    if (this.pending.size >= 64) return Promise.reject(failure('OneBot 请求过多，请稍后再试。', sending ? 'failed' : null));
    const socket = this.socket, echo = randomUUID();
    return new Promise((resolve, reject) => {
      let attempted = false;
      const finish = (error, result) => { if (!this.pending.has(echo)) return; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(echo); error ? reject(error) : resolve(result); };
      const abort = () => finish(failure('OneBot 操作已取消，发送结果可能未知。', sending && attempted ? 'unknown' : sending ? 'failed' : null));
      const timer = setTimeout(() => finish(failure(sending ? 'OneBot 未确认发送，实际送达结果未知。' : 'OneBot 操作超时。', sending ? 'unknown' : null, 504)), timeoutMs);
      this.pending.set(echo, { finish, sending }); signal?.addEventListener('abort', abort, { once: true });
      try { attempted = true; socket.send(JSON.stringify({ action, params, echo })); }
      catch { finish(failure('OneBot 连接发送异常，结果未知。', sending ? 'unknown' : null)); }
    });
  }

  async send({ channel, peerId, text, actions = [] }, expectedConnectionId, { signal } = {}) {
    channel = normalizeQQChannel(channel);
    if (!['private', 'group'].includes(channel) || !qqId(peerId) || typeof text !== 'string' || text.length > 8000) throw failure('QQ 发送内容或会话无效。', 'failed', 400);
    if (this.info.status !== 'verified' || expectedConnectionId !== this.info.connectionId) throw failure('QQ 连接已改变，此条回复未发送。', 'failed');
    if (!Array.isArray(actions) || actions.length > 12) throw failure('QQ 媒体动作数量无效。', 'failed', 400);
    const message = text.trim() ? [{ type: 'text', data: { text } }] : [];
    for (const action of actions) {
      if (['image', 'meme', 'voice', 'record', 'audio'].includes(action?.type)) {
        const file = action.url || action.file;
        if (typeof file !== 'string' || file.length > 2000000 || !/^(?:https?:\/\/|file:\/\/\/|base64:\/\/)[^\r\n\0]+$/i.test(file)) throw failure('QQ 媒体地址无效。', 'failed', 400);
        message.push({ type: ['image', 'meme'].includes(action.type) ? 'image' : 'record', data: { file } });
      } else if (action?.type === 'face') {
        if (!/^\d{1,5}$/.test(String(action.id))) throw failure('QQ 表情媒体标识无效。', 'failed', 400);
        message.push({ type: 'face', data: { id: String(action.id) } });
      }
    }
    if (!message.length) throw failure('QQ 发送内容没有可用文字或媒体。', 'failed', 400);
    const data = await this.rpc(channel === 'group' ? 'send_group_msg' : 'send_private_msg', {
      [channel === 'group' ? 'group_id' : 'user_id']: String(peerId), message,
    }, { signal, sending: true });
    return { messageId: messageId(data.message_id) };
  }

  startHeartbeat() {
    if (!(this.heartbeatIntervalMs > 0)) return;
    this.heartbeat = setInterval(async () => {
      if (this.heartbeatPending || this.info.status !== 'verified') return;
      this.heartbeatPending = true; const socket = this.socket;
      try { const value = await this.rpc('get_status'); if (value?.online !== true || value?.good === false) this.dropped(socket); }
      catch { this.dropped(socket); }
      finally { this.heartbeatPending = false; }
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  dropped(socket) {
    if (this.socket !== socket) return;
    const wasVerified = this.info.status === 'verified';
    this.socket = null; clearInterval(this.heartbeat);
    this.info = { ...this.info, status: 'disconnected', connectionId: null, lastError: 'OneBot 连接已断开。' };
    for (const pending of [...this.pending.values()]) pending.finish(failure('OneBot 连接已断开，发送结果未知。', pending.sending ? 'unknown' : null));
    try { socket.close(); } catch {}
    if (wasVerified) this.onDisconnect();
  }

  disconnect() {
    const socket = this.socket; this.socket = null; clearInterval(this.heartbeat);
    this.info = { ...this.info, status: 'disconnected', connectionId: null };
    for (const pending of [...this.pending.values()]) pending.finish(failure('OneBot 已主动断开，发送结果未知。', pending.sending ? 'unknown' : null));
    if (socket) { try { socket.close(); } catch {} }
    return this.state();
  }

  close() { return this.disconnect(); }
}
