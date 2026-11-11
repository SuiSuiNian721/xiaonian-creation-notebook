// SSE 只发送当前对话的公开任务快照；缓慢客户端只保留最新状态。
export function createChatEventHub({ throttleMs = 60, heartbeatMs = 15000, maxClients = 64 } = {}) {
  const clients = new Set();
  function dispose(client) {
    if (!clients.delete(client)) return;
    clearTimeout(client.timer); clearInterval(client.heartbeat);
    client.res.off('drain', client.drain);
    client.res.off('error', client.error);
    if (!client.res.destroyed && !client.res.writableEnded) client.res.end();
  }
  function frame(client, event, value) {
    if (client.res.destroyed || client.res.writableEnded) { dispose(client); return false; }
    try { client.blocked = !client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n'); }
    catch { dispose(client); return false; }
    return !client.blocked;
  }
  function flush(client) {
    client.timer = null;
    if (!clients.has(client) || client.blocked) return;
    for (const [id, task] of client.pending) {
      client.pending.delete(id);
      if (!frame(client, 'progress', { task })) return;
    }
    if (client.refresh) { client.refresh = false; frame(client, 'refresh', {}); }
  }
  function schedule(client) {
    if (!client.timer && !client.blocked && clients.has(client)) client.timer = setTimeout(() => flush(client), throttleMs);
  }
  return {
    connect(req, res, scope, tasks) {
      if (clients.size >= maxClients) throw Object.assign(new Error('实时连接过多，请关闭多余窗口后重试'), { statusCode: 429 });
      const client = { ...scope, res, pending: new Map(), refresh: false, blocked: false, timer: null };
      client.drain = () => { client.blocked = false; schedule(client); };
      client.error = () => dispose(client);
      clients.add(client);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      res.flushHeaders?.();
      res.on('drain', client.drain); res.on('error', client.error); res.on('close', () => dispose(client)); req.on('aborted', () => dispose(client));
      frame(client, 'snapshot', { tasks: tasks.slice(0, 64) });
      if (!clients.has(client)) return () => {};
      client.heartbeat = setInterval(() => {
        if (client.blocked) return;
        if (res.destroyed || res.writableEnded) dispose(client);
        else {
          try { client.blocked = !res.write(': connection\n\n'); }
          catch { dispose(client); }
        }
      }, heartbeatMs);
      client.heartbeat.unref?.();
      return () => dispose(client);
    },
    publish(task) {
      for (const client of clients) {
        if (client.cardName !== task.cardName || client.conversationId !== task.conversationId) continue;
        const key = task.taskId || task.replyToAt;
        if (client.pending.size >= 64 && !client.pending.has(key)) client.pending.delete(client.pending.keys().next().value);
        client.pending.set(key, task);
        if (task.ended) client.refresh = true;
        schedule(client);
      }
    },
    refresh(cardName, conversationId) {
      for (const client of clients) if (client.cardName === cardName && client.conversationId === conversationId) { client.refresh = true; schedule(client); }
    },
    close() { for (const client of [...clients]) dispose(client); },
    get size() { return clients.size; },
  };
}
