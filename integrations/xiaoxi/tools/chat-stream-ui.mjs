// 函数可序列化到页面；只处理公开任务状态，正文使用 textContent 渲染。
export function attachChatStream(options) {
  var tasks = new Map(), source = null, scopeKey = '', disposed = false, paintTimer = null, refreshTimer = null;
  var EventSourceClass = options.EventSource || window.EventSource;
  var labels = { queued: '正在排队', 'checking-login': '正在核对登录', preparing: '正在读取当前对话与卡片内容', starting: '正在连接模型', thinking: '正在思考',
    reading: '正在读取资料', 'running-tool': '正在处理资料', generating: '正在生成回复', reconnecting: '连接中断，正在尝试恢复',
    recovering: '正在重新建立连接（自动恢复 1/1），已收到的内容已保留',
    finalizing: '回复已生成，正在核验', 'waiting-model': '正在等待模型回复', summarizing: '正在整理较早的对话', 'preparing-write': '已理解写入要求，正在准备保存', stopping: '正在停止回复' };
  function active(key) { return !disposed && options.isCurrent() && scopeKey === key; }
  function repaint() {
    if (!paintTimer) paintTimer = setTimeout(function () { paintTimer = null; if (!disposed && options.isCurrent()) options.changed(); }, 70);
  }
  function refresh() {
    if (!refreshTimer) refreshTimer = setTimeout(function () { refreshTimer = null; if (!disposed && options.isCurrent()) options.refresh(); }, 80);
  }
  function valid(task, scope) {
    return task && task.cardName === scope.cardName && task.conversationId === scope.conversationId
      && typeof task.replyToAt === 'string' && task.replyToAt && typeof task.phase === 'string';
  }
  function update(task, scope) {
    if (!valid(task, scope)) return;
    var old = tasks.get(task.replyToAt);
    if (old && old.taskId === task.taskId && (old.previewRevision || 0) > (task.previewRevision || 0)) return;
    if (task.ended) { if (!old || old.taskId === task.taskId) tasks.delete(task.replyToAt); refresh(); return; }
    tasks.set(task.replyToAt, Object.assign({}, task, { partialText: typeof task.partialText === 'string' ? task.partialText.slice(0, 100000) : '' }));
  }
  function start() {
    if (disposed) return;
    var scope = options.scope();
    var key = JSON.stringify([scope.cardName, scope.conversationId]);
    if (!scope.cardName || !scope.conversationId || key === scopeKey && source) return;
    if (source) source.close(); source = null; tasks.clear(); scopeKey = key;
    if (!EventSourceClass) return;
    source = new EventSourceClass('/api/chat-events/' + encodeURIComponent(scope.cardName) + '?conversationId=' + encodeURIComponent(scope.conversationId));
    source.addEventListener('snapshot', function (event) {
      if (!active(key)) return;
      try {
        var data = JSON.parse(event.data); tasks.clear();
        (Array.isArray(data.tasks) ? data.tasks.slice(0, 64) : []).forEach(function (task) { update(task, scope); });
        repaint(); refresh();
      } catch { refresh(); }
    });
    source.addEventListener('progress', function (event) {
      if (!active(key)) return;
      try { var data = JSON.parse(event.data); update(data.task, scope); if (!data.task?.ended) repaint(); }
      catch { refresh(); }
    });
    source.addEventListener('refresh', function () { if (active(key)) refresh(); });
    source.onerror = function () { if (active(key)) refresh(); }; // EventSource 自行重连，原轮询继续兜底。
  }
  return {
    start: start,
    apply: function (messages) {
      var scope = options.scope();
      return messages.map(function (message) {
        if (!message.pending || !['codex', 'openai'].includes(message.task?.backend)) return message;
        var stored = tasks.get(message.task.replyToAt);
        var task = stored && valid(stored, scope) && stored.taskId === message.task.taskId && (stored.previewRevision || 0) >= (message.task.previewRevision || 0) ? stored : message.task;
        var label = task.stopError || labels[task.phase];
        return Object.assign({}, message, { task: task, partialText: task.partialText || '',
          text: label ? (task.round > 1 ? '第 ' + task.round + ' 步 · ' : '') + label + (task.allowWrite ? ' 本轮已获准写入，停止不会撤回已经保存的正文。' : '') : message.text });
      });
    },
    dispose: function () {
      disposed = true; if (source) source.close(); source = null;
      clearTimeout(paintTimer); clearTimeout(refreshTimer); tasks.clear();
    },
  };
}
