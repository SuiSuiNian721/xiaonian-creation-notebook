import { randomUUID } from 'node:crypto';
import { AppError } from './providers.mjs';

export class QQClient {
  constructor({ onMessage, onEvent }) {
    this.onMessage = onMessage;
    this.onEvent = onEvent;
    this.status = 'disconnected';
    this.pending = new Map();
    this.socket = null;
    this.connectionId = null;
  }

  async connect(config) {
    if (this.status === 'connecting') throw new AppError(409, 'QQ 正在连接，请稍后重试。');
    this.disconnect(false);
    if (!config.wsUrl) throw new AppError(400, '请先配置 OneBot 正向 WebSocket 地址。');
    const address = new URL(config.wsUrl);
    if (config.token) address.searchParams.set('access_token', config.token);
    const socket = new WebSocket(address);
    this.socket = socket;
    this.connectionId = randomUUID();
    this.status = 'connecting';
    this.onEvent('qq', '正在连接 OneBot 服务。');
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 128 * 1024) return;
      let value;
      try { value = JSON.parse(event.data); } catch { this.onEvent('qq', '忽略了无法解析的 OneBot 数据。', 'warning'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        this.onEvent('qq', '忽略了格式无效的 OneBot 数据。', 'warning');
        return;
      }
      const pending = this.pending.get(value.echo);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(value.echo);
        if (value.status === 'ok' && value.retcode === 0 && value.data?.message_id != null) pending.resolve(value.data);
        else pending.reject(new AppError(502, `QQ 服务拒绝或未确认此次发送（返回码 ${Number.isInteger(value.retcode) ? value.retcode : '未知'}）。`));
        return;
      }
      if (value.post_type === 'message') Promise.resolve(this.onMessage(value)).catch(() => this.onEvent('qq', 'QQ 消息处理失败，请查看会话中的发送状态。', 'error'));
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null; this.connectionId = null; this.status = 'disconnected';
      this.rejectPending();
      this.onEvent('qq', 'OneBot 连接已断开。', 'warning');
    });
    await new Promise((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer);
        if (this.socket === socket) this.disconnect(false);
        reject(new AppError(502, '无法连接 OneBot 服务，请检查地址、令牌和服务状态。'));
      };
      const timer = setTimeout(fail, 5000);
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('close', fail, { once: true });
      socket.addEventListener('open', () => {
        if (this.socket !== socket) { fail(); return; }
        clearTimeout(timer);
        socket.removeEventListener('error', fail);
        socket.removeEventListener('close', fail);
        socket.addEventListener('error', () => { if (this.socket === socket) this.onEvent('qq', 'OneBot 连接发生错误。', 'error'); });
        this.status = 'connected';
        this.onEvent('qq', 'OneBot 已连接；只有允许名单内的消息会触发回复。');
        resolve();
      }, { once: true });
    });
  }

  rejectPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AppError(502, 'QQ 连接已断开，发送结果未确认。')); }
    this.pending.clear();
  }

  disconnect(log = true) {
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
    this.status = 'disconnected';
    this.rejectPending();
    if (socket) { try { socket.close(); } catch {} }
    if (log) this.onEvent('qq', 'QQ 已断开连接。');
  }

  async send(channel, peerId, text, expectedConnectionId) {
    if (!this.socket || this.status !== 'connected') throw new AppError(502, 'QQ 未连接，此次回复尚未发送。');
    if (expectedConnectionId !== this.connectionId) throw new AppError(502, 'QQ 连接已改变，此次旧连接的回复尚未发送。');
    const echo = randomUUID();
    const params = { [channel === 'qq-group' ? 'group_id' : 'user_id']: peerId, message: [{ type: 'text', data: { text } }] };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new AppError(502, 'QQ 未在时限内确认发送，实际送达情况未知。')); }, 8000);
      this.pending.set(echo, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ action: channel === 'qq-group' ? 'send_group_msg' : 'send_private_msg', params, echo })); }
      catch { clearTimeout(timer); this.pending.delete(echo); reject(new AppError(502, 'QQ 发送失败。')); }
    });
  }
}

export function parseOneBotMessage(event) {
  if (!['private', 'group'].includes(event.message_type) || event.message_id == null || event.user_id == null) return null;
  if (!/^\d{1,20}$/.test(String(event.user_id))) return null;
  if (String(event.user_id) === String(event.self_id)) return null;
  const channel = event.message_type === 'group' ? 'qq-group' : 'qq-private';
  const peerId = String(channel === 'qq-group' ? event.group_id ?? '' : event.user_id);
  if (!/^\d{1,20}$/.test(peerId)) return null;
  let text = '';
  let mentioned = false;
  if (Array.isArray(event.message)) {
    for (const item of event.message) {
      if (item.type === 'text' && typeof item.data?.text === 'string') text += item.data.text;
      if (item.type === 'at' && String(item.data?.qq) === String(event.self_id)) mentioned = true;
    }
  } else if (typeof event.message === 'string' || typeof event.raw_message === 'string') {
    text = event.message ?? event.raw_message;
    text = text.replace(/\[CQ:at,qq=(\d+)(?:,[^\]]*)?\]/g, (_, id) => { if (id === String(event.self_id)) mentioned = true; return ''; });
    text = text.replace(/\[CQ:[^\]]*\]/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
  }
  text = text.trim();
  if (!text || text.length > 8000) return null;
  return { channel, peerId, userId: String(event.user_id), text, mentioned, dedupId: `${event.self_id}:${channel}:${peerId}:${event.message_id}` };
}
