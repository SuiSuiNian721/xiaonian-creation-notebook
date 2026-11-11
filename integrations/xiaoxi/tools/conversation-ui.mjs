// 按需打开的对话管理面板，由 studio 序列化到浏览器。
export function attachConversationManager(options) {
  var disposed = false, dialog = null, busy = false, timer = null, sequence = 0;
  var button = document.createElement('button');
  button.id = 'btn-conversations'; button.textContent = '对话管理';
  button.title = '搜索记录、重命名、归档或恢复对话，查看分支来源';
  options.toolbar.insertBefore(button, options.toolbar.children[2] || null);
  function current() { return !disposed && options.isCurrent(); }
  function focus(node) { if (node && node.isConnected && !node.disabled) node.focus({ preventScroll: true }); }
  function close(restore) {
    clearTimeout(timer); sequence++;
    if (dialog) dialog.remove(); dialog = null;
    if (restore !== false) focus(button);
  }
  button.onclick = function () {
    if (!current() || !options.scope().conversationId || dialog || document.querySelector('[aria-modal="true"]')) return;
    var scope = options.scope(), endpoint = '/api/conversations/' + encodeURIComponent(scope.cardName);
    dialog = document.createElement('div'); dialog.className = 'chat-action-overlay'; dialog.id = 'conversation-manager';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '对话管理');
    dialog.tabIndex = -1;
    var overlay = dialog, panel = document.createElement('div'); panel.className = 'chat-action-panel';
    panel.style.width = 'min(700px,100%)';
    var header = document.createElement('div'); header.className = 'row';
    var heading = document.createElement('strong'); heading.textContent = '对话管理'; heading.style.flex = '1';
    var dismiss = document.createElement('button'); dismiss.textContent = '关闭'; dismiss.onclick = function () { if (!busy) close(); };
    header.append(heading, dismiss);
    var hint = document.createElement('div'); hint.className = 'muted';
    hint.textContent = '搜索本卡的对话名称和已保存消息。归档会保留消息与草稿，可随时恢复。';
    var searchRow = document.createElement('div'); searchRow.className = 'row';
    var search = document.createElement('input'); search.type = 'search'; search.maxLength = 120;
    search.placeholder = '搜索对话名称或消息…'; search.setAttribute('aria-label', '搜索对话名称或消息'); search.style.cssText = 'flex:1;min-width:0';
    var filter = document.createElement('select'); filter.setAttribute('aria-label', '对话范围'); filter.style.width = 'auto';
    [['active', '使用中'], ['archived', '已归档'], ['all', '全部']].forEach(function (pair) {
      var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; filter.appendChild(option);
    });
    searchRow.append(search, filter);
    var status = document.createElement('div'); status.setAttribute('role', 'status');
    var list = document.createElement('div'); list.className = 'chat-deleted-list';
    var retry = document.createElement('button'); retry.textContent = '重新载入'; retry.hidden = true;
    var loaded = null;
    function active() { return current() && dialog === overlay && options.scope().conversationId === scope.conversationId; }
    function controls(locked) {
      busy = locked; dismiss.disabled = locked; search.disabled = locked; filter.disabled = locked; retry.disabled = locked;
      list.querySelectorAll('button,input').forEach(function (node) { node.disabled = locked; });
      if (locked) focus(overlay);
    }
    async function change(action, item, extra) {
      if (!active() || busy) return;
      if (!options.canOperate()) { status.className = 'err'; status.textContent = '请等当前消息操作完成后再管理对话。'; return; }
      clearTimeout(timer); sequence++;
      controls(true); status.className = 'muted'; status.textContent = '正在保存…';
      try {
        await options.beforeChange();
        if (!active()) return;
        var data = await options.api('POST', endpoint, Object.assign({ action: action, id: item.id, expectedActiveId: scope.conversationId, expectedArchivedAt: item.archivedAt || '' }, extra || {}));
        if (!active()) return;
        if (action === 'select' || data.activeId !== scope.conversationId) {
          close(false); options.changed(data, action === 'select' ? item.match : null);
        } else {
          options.updated(data);
          await load();
        }
        options.log(action === 'rename' ? '对话名称已保存。' : action === 'archive' ? '对话已归档，消息与草稿仍然保留。' : action === 'unarchive' ? '对话已恢复，可重新打开。' : '已打开对话。', 'okc');
      } catch (error) { if (active()) { status.className = 'err'; status.textContent = '操作失败：' + error.message; retry.hidden = false; } }
      finally {
        controls(false);
        if (active() && (document.activeElement === overlay || !overlay.contains(document.activeElement) || document.activeElement.disabled)) focus(dismiss);
      }
    }
    function render() {
      list.replaceChildren();
      var items = (loaded && loaded.conversations || []).filter(function (item) {
        return filter.value === 'all' || (filter.value === 'archived' ? !!item.archivedAt : !item.archivedAt);
      });
      status.className = 'muted'; status.textContent = items.length ? items.length + ' 条对话' : search.value.trim() ? '没有找到匹配的对话。' : '这里暂时没有对话。';
      items.forEach(function (item) {
        var section = document.createElement('section'); section.className = 'chat-deleted-item';
        var title = document.createElement('strong'); title.textContent = item.title + (item.id === scope.conversationId ? ' · 当前' : '') + (item.archivedAt ? ' · 已归档' : '');
        var details = document.createElement('div'); details.className = 'muted';
        details.textContent = item.module ? '专写模块：' + options.stageCaption(item.module) : '整张卡讨论';
        section.append(title, details);
        if (item.origin) {
          var origin = document.createElement('div'); origin.className = 'muted';
          var date = new Date(item.origin.messageAt);
          origin.textContent = '分支来自「' + item.origin.title + '」 · ' + (item.origin.role === 'user' ? '用户消息' : '助手回复') + ' · ' + (Number.isFinite(date.getTime()) ? date.toLocaleString() : item.origin.messageAt);
          section.appendChild(origin);
        }
        if (item.match && item.match.type === 'message') {
          var preview = document.createElement('div'); preview.className = 'chat-action-preview'; preview.textContent = item.match.preview; section.appendChild(preview);
        }
        var actions = document.createElement('div'); actions.className = 'row';
        var open = document.createElement('button'); open.textContent = item.archivedAt ? '恢复对话' : item.match && item.match.type === 'message' ? '打开匹配消息' : '打开对话';
        open.onclick = function () { change(item.archivedAt ? 'unarchive' : 'select', item); };
        var rename = document.createElement('button'); rename.textContent = '重命名';
        rename.onclick = function () {
          if (busy) return;
          actions.style.display = 'none';
          var edit = document.createElement('div'); edit.className = 'row';
          var input = document.createElement('input'); input.value = item.title; input.maxLength = 80; input.style.cssText = 'flex:1;min-width:0'; input.setAttribute('aria-label', '对话新名称');
          var save = document.createElement('button'); save.textContent = '保存名称';
          var cancel = document.createElement('button'); cancel.textContent = '取消';
          cancel.onclick = function () { if (!busy) { edit.remove(); actions.style.display = ''; focus(rename); } };
          save.onclick = function () {
            if (!input.value.trim()) { status.className = 'err'; status.textContent = '请填写对话名称。'; focus(input); return; }
            change('rename', item, { title: input.value, expectedTitle: item.title });
          };
          input.onkeydown = function (event) { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save.click(); } };
          edit.append(input, save, cancel); section.appendChild(edit); focus(input); input.select();
        };
        actions.append(open, rename);
        if (!item.archivedAt) {
          var archive = document.createElement('button'); archive.textContent = '归档';
          archive.onclick = function () { change('archive', item); }; actions.appendChild(archive);
        }
        section.appendChild(actions); list.appendChild(section);
      });
    }
    async function load() {
      if (list.contains(document.activeElement) || document.activeElement === retry) focus(busy ? overlay : search);
      var seq = ++sequence; status.className = 'muted'; status.textContent = '正在载入…'; retry.hidden = true;
      list.replaceChildren();
      try {
        var data = await options.api('GET', endpoint + '?includeArchived=1&q=' + encodeURIComponent(search.value.trim()));
        if (!active() || seq !== sequence) return;
        if (data.activeId !== scope.conversationId) {
          if (!options.canOperate()) { status.className = 'err'; status.textContent = '当前对话选择已变化，请等消息操作完成后重新载入。'; retry.hidden = false; return; }
          var wasBusy = busy;
          controls(true);
          try {
            await options.beforeChange();
            if (active()) { close(false); options.changed(data, null); options.log('当前对话选择已变化，已保留原草稿并同步。', 'warn'); }
          } finally { if (!wasBusy) controls(false); }
          return;
        }
        loaded = data; render();
      } catch (error) {
        if (active() && seq === sequence) { status.className = 'err'; status.textContent = '载入失败：' + error.message; retry.hidden = false; }
      }
    }
    search.oninput = function () { clearTimeout(timer); sequence++; loaded = null; list.replaceChildren(); status.textContent = '正在搜索…'; timer = setTimeout(load, 250); };
    search.oncompositionend = search.oninput;
    filter.onchange = function () { if (loaded) render(); };
    retry.onclick = load;
    overlay.onclick = function (event) { if (event.target === overlay && !busy) close(); };
    overlay.onkeydown = function (event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close(); }
      if (event.key !== 'Tab') return;
      var nodes = Array.from(panel.querySelectorAll('button,input,select')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); overlay.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    panel.append(header, hint, searchRow, status, list, retry); overlay.appendChild(panel); document.body.appendChild(overlay); focus(search); load();
  };
  return { dispose: function () { disposed = true; close(false); } };
}
