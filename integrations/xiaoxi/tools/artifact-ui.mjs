// 独立浏览器控制器，由 studio 序列化；只展示本机生成器实际返回的文件。
export function attachArtifactAccess(options) {
  var buildButton = options.buildButton;
  var exportButton = options.exportButton;
  var viewButton = document.createElement('button');
  viewButton.id = 'btn-artifacts'; viewButton.textContent = '查看成品';
  viewButton.title = '查看当前内容已生成的文件，下载或打开所在文件夹';
  buildButton.parentNode.appendChild(viewButton);
  var dialog = null, building = false, loading = false;

  function current(scope) {
    var now = options.scope();
    return now.name === scope.name && now.targetType === scope.targetType && now.sequence === scope.sequence;
  }
  function focus(node) {
    if (node && document.body.contains(node) && !node.disabled && node.getClientRects().length) node.focus({ preventScroll: true });
  }
  function formatSize(bytes) {
    return bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function show(result, returnFocus) {
    var existingModal = document.querySelector('[aria-modal="true"]');
    if (existingModal && existingModal !== dialog) {
      options.log(result.name + ' 的成品可从工作区的“查看成品”再次打开。', 'okc');
      return false;
    }
    if (dialog) dialog.remove();
    var overlay = document.createElement('div'); overlay.className = 'chat-action-overlay'; overlay.id = 'artifact-dialog';
    overlay.tabIndex = -1; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '成品文件：' + result.name);
    dialog = overlay;
    var panel = document.createElement('div'); panel.className = 'chat-action-panel';
    var header = document.createElement('div'); header.className = 'row';
    var title = document.createElement('strong'); title.style.flex = '1'; title.textContent = result.name + ' · 成品文件';
    var close = document.createElement('button'); close.textContent = '关闭';
    function dismiss() {
      if (dialog !== overlay) return;
      overlay.remove(); dialog = null; focus(returnFocus);
    }
    close.onclick = dismiss; header.appendChild(title); header.appendChild(close);
    var hint = document.createElement('div'); hint.className = 'muted';
    if (!result.files.length) hint.textContent = '这份内容还没有成品文件。先关闭此窗口，再点击“生成成品”。';
    else if (result.warning) hint.textContent = '当前内容读取有异常：' + result.warning + '。以下是磁盘上已有的成品，请核对后再使用。';
    else if (result.needsUpdate) hint.textContent = '正文已改动，以下是上次生成的成品。要带上最新内容，请重新生成成品。';
    else hint.textContent = result.targetType === 'card' ? 'PNG 和 JSON 都可导入酒馆；PNG 同时包含卡片图片。' : '下载 JSON 后即可在酒馆对应的预设或世界书入口导入。';
    var note = document.createElement('div'); note.className = 'muted';
    note.textContent = '成品使用已保存的正文；编辑框中的未保存草稿不会自动写入。生成成功后仍需在酒馆实际验收。';
    var status = document.createElement('div'); status.setAttribute('role', 'status');
    var list = document.createElement('div'); list.className = 'chat-deleted-list';
    result.files.forEach(function (file) {
      var row = document.createElement('div'); row.className = 'chat-deleted-item';
      var description = document.createElement('div');
      var date = new Date(file.modifiedAt);
      description.textContent = file.fileName + ' · ' + formatSize(file.size) + (Number.isFinite(date.getTime()) ? ' · ' + date.toLocaleString() : '');
      var download = document.createElement('button'); download.className = 'primary'; download.textContent = '下载 ' + file.id.toUpperCase();
      download.onclick = async function () {
        if (download.disabled) return;
        download.disabled = true; status.className = 'muted'; status.textContent = '正在准备下载…';
        try {
          var response = await fetch(file.url, { cache: 'no-store' });
          if (!response.ok) {
            var error = await response.json().catch(function () { return {}; });
            throw new Error(error.error || '下载失败（' + response.status + '）');
          }
          var blob = await response.blob();
          var url = URL.createObjectURL(blob);
          var link = document.createElement('a'); link.href = url; link.download = file.downloadName; link.style.display = 'none';
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          status.className = 'okc'; status.textContent = '已开始下载，可在系统下载目录或浏览器下载记录中查看。';
        } catch (error) { status.className = 'err'; status.textContent = '下载失败：' + error.message; }
        finally { download.disabled = false; }
      };
      row.appendChild(description); row.appendChild(download); list.appendChild(row);
    });
    var directory = document.createElement('div'); directory.className = 'muted'; directory.style.overflowWrap = 'anywhere';
    directory.textContent = '所在文件夹：' + result.directory;
    var open = document.createElement('button'); open.textContent = '打开所在文件夹'; open.disabled = !result.canOpenDirectory;
    if (!result.canOpenDirectory) open.title = result.files.length ? '浏览器版请使用下载按钮，桌面版支持直接打开文件夹' : '生成成品后可打开文件夹';
    open.onclick = async function () {
      if (open.disabled) return;
      open.disabled = true; status.className = 'muted'; status.textContent = '正在打开文件夹…';
      try {
        await options.api('POST', '/api/artifacts-open/' + encodeURIComponent(result.name), { targetType: result.targetType });
        status.className = 'okc'; status.textContent = '已打开成品所在文件夹。';
      } catch (error) { status.className = 'err'; status.textContent = '打开失败：' + error.message; }
      finally { open.disabled = !result.canOpenDirectory; }
    };
    overlay.onclick = function (event) { if (event.target === overlay) dismiss(); };
    overlay.onkeydown = function (event) {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (event.key !== 'Tab') return;
      var nodes = Array.from(panel.querySelectorAll('button, a[href]')).filter(function (node) { return !node.disabled && !node.hidden; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); overlay.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    [header, hint, note, list, directory, open, status].forEach(function (node) { panel.appendChild(node); });
    overlay.appendChild(panel); document.body.appendChild(overlay); close.focus();
    return true;
  }
  function busy(value) {
    buildButton.disabled = value; viewButton.disabled = value;
    if (exportButton) exportButton.disabled = value;
    if (options.viewButton) options.viewButton.disabled = value;
  }
  function failure(error) {
    options.log(error.message, 'err');
    // 错误需要在操作位置可见，不能仅藏在页脚日志里。
    var panel = document.getElementById('artifact-error');
    if (!panel) {
      panel = document.createElement('div'); panel.id = 'artifact-error'; panel.className = 'chat-action-overlay';
      panel.setAttribute('role', 'alertdialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '导出失败');
      var inner = document.createElement('div'); inner.className = 'chat-action-panel';
      var text = document.createElement('p'); text.textContent = error.message; text.style.whiteSpace = 'pre-wrap';
      var close = document.createElement('button'); close.textContent = '关闭';
      close.onclick = function () { panel.remove(); focus(exportButton || buildButton); };
      panel.onkeydown = function (event) { if (event.key === 'Escape') close.click(); if (event.key === 'Tab') { event.preventDefault(); close.focus(); } };
      inner.appendChild(text); inner.appendChild(close); panel.appendChild(inner); document.body.appendChild(panel); close.focus();
    }
  }
  viewButton.onclick = async function () {
    var scope = options.scope();
    var returnFocus = document.activeElement;
    if (loading || building) return;
    if (!scope.name) { failure(new Error('请先打开一张角色卡。')); return; }
    loading = true; busy(true);
    try {
      var result = await options.api('GET', '/api/artifacts/' + encodeURIComponent(scope.name) + '?targetType=' + scope.targetType);
      if (current(scope)) show(result, returnFocus);
    } catch (error) { failure(new Error('查看成品失败：' + error.message)); }
    finally { loading = false; busy(false); }
  };
  buildButton.onclick = async function () {
    var scope = options.scope();
    var returnFocus = document.activeElement;
    if (building || loading) return;
    if (!scope.name) { failure(new Error('请先打开一张角色卡。')); return; }
    building = true; busy(true); buildButton.textContent = '正在生成…';
    if (exportButton) exportButton.textContent = '正在导出…';
    try {
      var result = await options.api('POST', scope.buildUrl + encodeURIComponent(scope.name));
      options.log(scope.name + ' 的成品已生成：' + result.out, 'okc');
      if (current(scope)) {
        if (show(result.artifacts, returnFocus)) options.refresh(scope.name);
      }
    } catch (error) { failure(new Error('导出失败：' + error.message)); }
    finally { building = false; busy(false); buildButton.textContent = '生成成品'; if (exportButton) exportButton.textContent = '导出角色卡'; }
  };
  if (exportButton) exportButton.onclick = function () { buildButton.onclick(); };
  if (options.viewButton) options.viewButton.onclick = function () { viewButton.onclick(); };
}
