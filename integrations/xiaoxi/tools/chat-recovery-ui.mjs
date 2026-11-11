// 独立浏览器控制器，由 studio 序列化；不读取工作区或执行消息中的代码。
export function attachChatRecovery(options) {
  var api = options.api;
  var disposed = false, busy = false, dialog = null, toast = null;
  var stopErrors = new Map();
  var button = document.createElement('button');
  button.id = 'btn-chat-deleted'; button.textContent = '最近删除';
  button.title = '查看并恢复当前对话删除的消息';
  options.toolbar.appendChild(button);

  function active(scope) {
    var now = options.scope();
    return !disposed && options.isCurrent() && now.cardName === scope.cardName && now.conversationId === scope.conversationId;
  }
  function focus(node) {
    if (node && document.body.contains(node) && !node.disabled && node.getClientRects().length) node.focus({ preventScroll: true });
  }
  function closeDialog(restoreFocus) {
    if (!dialog) return;
    dialog.remove(); dialog = null;
    if (restoreFocus !== false) focus(button);
  }
  function payload(scope) { return { targetType: 'card', conversationId: scope.conversationId }; }
  async function restore(scope, operationId) {
    if (!active(scope) || busy || !options.canOperate()) throw new Error('请等当前操作完成后再恢复');
    busy = true; options.setBusy(true);
    try {
      var result = await api('POST', '/api/chat-restore/' + encodeURIComponent(scope.cardName), Object.assign(payload(scope), { operationId: operationId }));
      if (!result.ok) throw new Error('恢复未完成，请重试');
      if (toast) { toast.remove(); toast = null; }
      options.log(result.alreadyRestored ? '这组消息已经恢复。' : '消息已恢复，旧回复请求不会重新发送。', 'okc');
      if (active(scope)) await options.changed(result);
      return result;
    } finally {
      busy = false;
      if (active(scope)) options.setBusy(false);
    }
  }
  function showDeleted(result) {
    if (disposed || !result.operationId) return;
    var scope = options.scope();
    if (!active(scope)) return;
    if (toast) toast.remove();
    toast = document.createElement('div'); toast.className = 'chat-undo-toast';
    toast.setAttribute('role', 'status');
    var label = document.createElement('span'); label.textContent = '已删除 ' + (result.messageCount || result.deletedCount || 1) + ' 条消息';
    var undo = document.createElement('button'); undo.textContent = '撤销删除'; undo.className = 'primary';
    var dismiss = document.createElement('button'); dismiss.textContent = '×'; dismiss.setAttribute('aria-label', '收起删除提示');
    dismiss.onclick = function () { toast.remove(); toast = null; };
    undo.onclick = async function () {
      if (undo.disabled) return;
      var heldFocus = document.activeElement === undo;
      undo.disabled = true; dismiss.disabled = true;
      try { await restore(scope, result.operationId); }
      catch (error) { label.textContent = '恢复失败：' + error.message; }
      finally {
        undo.disabled = false; dismiss.disabled = false;
        if (heldFocus && active(scope) && document.activeElement === document.body) focus(options.root.querySelector('#chat-input'));
      }
    };
    toast.appendChild(label); toast.appendChild(undo); toast.appendChild(dismiss); document.body.appendChild(toast);
  }
  button.onclick = function () {
    var scope = options.scope();
    if (!scope.conversationId || !active(scope) || dialog || document.getElementById('chat-action-dialog')) return;
    dialog = document.createElement('div'); dialog.className = 'chat-action-overlay'; dialog.id = 'chat-deleted-dialog';
    dialog.tabIndex = -1; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '最近删除');
    var overlay = dialog;
    var panel = document.createElement('div'); panel.className = 'chat-action-panel';
    var header = document.createElement('div'); header.className = 'row';
    var title = document.createElement('strong'); title.textContent = '最近删除'; title.style.flex = '1';
    var close = document.createElement('button'); close.textContent = '关闭'; close.onclick = function () { if (!busy) closeDialog(); };
    header.appendChild(title); header.appendChild(close);
    var hint = document.createElement('div'); hint.className = 'muted';
    hint.textContent = '按每次删除分组。恢复后回到原来的消息位置；旧请求保持结束，待确认稿需要重新确认。';
    var status = document.createElement('div'); status.setAttribute('role', 'status');
    var list = document.createElement('div'); list.className = 'chat-deleted-list';
    var retry = document.createElement('button'); retry.textContent = '重新载入'; retry.hidden = true;
    async function load() {
      status.textContent = '正在载入…'; status.className = 'muted'; retry.hidden = true;
      try {
        var result = await api('GET', '/api/chat-deleted/' + encodeURIComponent(scope.cardName) + '?conversationId=' + encodeURIComponent(scope.conversationId));
        if (dialog !== overlay || !active(scope)) return;
        list.replaceChildren(); status.textContent = result.items.length ? '' : '当前对话没有可恢复的消息。';
        result.items.forEach(function (item) {
          var section = document.createElement('section'); section.className = 'chat-deleted-item';
          var description = document.createElement('div'); description.className = 'muted';
          var date = new Date(item.deletedAt);
          description.textContent = (Number.isFinite(date.getTime()) ? date.toLocaleString() : item.deletedAt) + ' · ' + item.count + ' 条消息';
          var preview = document.createElement('div'); preview.className = 'chat-action-preview'; preview.textContent = item.preview || '（空消息）';
          var recover = document.createElement('button'); recover.textContent = '恢复这组消息';
          recover.onclick = async function () {
            if (busy || recover.disabled) return;
            var controls = Array.from(list.querySelectorAll('button')); controls.forEach(function (node) { node.disabled = true; });
            close.disabled = true; status.textContent = '正在恢复…'; status.className = 'muted';
            try {
              await restore(scope, item.id);
              if (dialog === overlay && active(scope)) { await load(); focus(close); }
            } catch (error) { status.className = 'err'; status.textContent = '恢复失败：' + error.message; }
            finally { close.disabled = false; controls.forEach(function (node) { node.disabled = false; }); }
          };
          section.appendChild(description); section.appendChild(preview); section.appendChild(recover); list.appendChild(section);
        });
      } catch (error) { if (dialog === overlay) { status.className = 'err'; status.textContent = '载入失败：' + error.message; retry.hidden = false; } }
    }
    retry.onclick = load;
    overlay.onclick = function (event) { if (event.target === overlay && !busy) closeDialog(); };
    overlay.onkeydown = function (event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) closeDialog(); }
      if (event.key !== 'Tab') return;
      var nodes = Array.from(panel.querySelectorAll('button')).filter(function (node) { return !node.disabled && !node.hidden; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); overlay.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    [header, hint, status, list, retry].forEach(function (node) { panel.appendChild(node); });
    overlay.appendChild(panel); document.body.appendChild(overlay); close.focus(); load();
  };
  function updateClocks() {
    options.root.querySelectorAll('[data-reply-queued-at]').forEach(function (node) {
      var elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(node.dataset.replyQueuedAt)) / 1000));
      node.textContent = Number.isFinite(elapsed) ? '已等待 ' + (elapsed < 60 ? elapsed + ' 秒' : Math.floor(elapsed / 60) + ' 分 ' + elapsed % 60 + ' 秒') : '';
    });
    options.root.querySelectorAll('.chat-reply-progress').forEach(function (node) {
      var elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(node.dataset.replyActivityAt)) / 1000));
      var waiting = ['queued', 'waiting-service', 'stopping'].includes(node.dataset.replyPhase);
      node.dataset.active = String(!waiting && Number.isFinite(elapsed) && elapsed < 30);
      var label = node.nextElementSibling;
      if (label && label.classList.contains('chat-reply-activity')) {
        label.textContent = Number.isFinite(elapsed) ? '最近活动 ' + (elapsed < 60 ? elapsed + ' 秒前' : Math.floor(elapsed / 60) + ' 分 ' + elapsed % 60 + ' 秒前')
          : node.dataset.replyPhase === 'waiting-service' ? '等待服务' : '尚未开始';
        node.setAttribute('aria-valuetext', label.textContent);
      }
    });
  }
  function updatePendingControls(message, container) {
    var task = message.task;
    if (!task) return;
    var progress = container.querySelector('.chat-reply-progress');
    if (!progress) return;
    progress.dataset.replyActivityAt = task.lastActivityAt || task.startedAt || '';
    progress.dataset.replyPhase = task.phase || '';
  }
  function pendingControls(message, container) {
    var task = message.task;
    if (!task || !task.replyToAt) return;
    var scope = options.scope();
    var progress = document.createElement('div'); progress.className = 'chat-reply-progress';
    progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', '回复进度');
    var indicator = document.createElement('span'); indicator.className = 'chat-reply-progress-indicator'; progress.appendChild(indicator);
    var activity = document.createElement('span'); activity.className = 'chat-reply-activity';
    container.appendChild(progress); container.appendChild(activity);
    updatePendingControls(message, container);
    var controls = document.createElement('div'); controls.className = 'chat-reply-controls';
    var elapsed = document.createElement('span'); elapsed.dataset.replyQueuedAt = task.queuedAt || task.replyToAt;
    controls.appendChild(elapsed);
    if (task.canStop) {
      var stopLabel = task.phase === 'waiting-service' ? '停止等待' : '停止回复';
      var stop = document.createElement('button'); stop.className = 'chat-stop'; stop.textContent = busy ? '正在停止…' : stopLabel;
      stop.dataset.replyToAt = task.replyToAt;
      stop.setAttribute('aria-label', '停止当前这次回复'); stop.disabled = busy || !options.canOperate();
      var error = document.createElement('span'); error.className = 'err'; error.setAttribute('role', 'alert');
      error.textContent = stopErrors.get(task.replyToAt) || '';
      stop.onclick = async function () {
        if (stop.disabled || !active(scope) || busy || !options.canOperate()) return;
        var heldFocus = document.activeElement === stop;
        busy = true; stop.disabled = true; stop.textContent = '正在停止…'; error.textContent = ''; stopErrors.delete(task.replyToAt); options.setBusy(true);
        try {
          var result = await api('POST', '/api/chat-stop/' + encodeURIComponent(scope.cardName), Object.assign(payload(scope), { replyToAt: task.replyToAt }));
          if (!result.ok) throw new Error('停止未完成，请重试');
          options.log('本次回复已停止，已发送的消息保留。' + (task.allowWrite ? ' 已写入的卡片内容不会回退。' : ''), 'okc');
          if (active(scope)) await options.changed(Object.assign({}, result, { sourceMayHaveChanged: !!task.allowWrite }));
        } catch (failure) { error.textContent = '停止失败：' + failure.message; stopErrors.set(task.replyToAt, error.textContent); options.log(error.textContent, 'err'); }
        finally {
          busy = false; stop.disabled = false; stop.textContent = stopLabel;
          if (active(scope)) {
            options.setBusy(false);
            if (heldFocus && document.activeElement === document.body) {
              var replacement = Array.from(options.root.querySelectorAll('.chat-stop')).find(function (node) { return node.dataset.replyToAt === task.replyToAt; });
              focus(replacement || options.root.querySelector('#chat-input'));
            }
          }
        }
      };
      controls.appendChild(stop); controls.appendChild(error);
    }
    container.appendChild(controls);
    if (task.allowWrite) {
      var note = document.createElement('div'); note.className = 'muted'; note.textContent = '本次包含写入操作；停止后，已经写入的内容会保留。';
      container.appendChild(note);
    }
  }
  var timer = setInterval(updateClocks, 1000);
  return {
    showDeleted: showDeleted, pendingControls: pendingControls, updatePendingControls: updatePendingControls, updateClocks: updateClocks,
    dispose: function () { disposed = true; clearInterval(timer); closeDialog(false); if (toast) toast.remove(); }
  };
}
