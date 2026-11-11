// 只整理助手消息的显示；原消息与复制内容保持原样，不接受 HTML。
// 函数独立于模块环境，供 studio 序列化到浏览器使用。
export function chatPresentationParts(value) {
  var parts = [];
  var prose = '';
  var code = '';
  var fence = null;
  function inline(text) {
    // 先保护代码和转义字符，再移除成对强调；代码里的 ** 不参与配对。
    var tokens = [];
    var pattern = /(`+)([^`]*?)\1|\\([*`\\])/g;
    var match;
    var start = 0;
    while ((match = pattern.exec(text))) {
      if (match.index > start) tokens.push({ kind: 'text', text: text.slice(start, match.index), omit: [] });
      tokens.push({ kind: match[1] ? 'code' : 'text', text: match[1] ? match[2] : match[3], literal: true });
      start = pattern.lastIndex;
    }
    if (start < text.length) tokens.push({ kind: 'text', text: text.slice(start), omit: [] });
    var opening = null;
    tokens.forEach(function (token) {
      if (token.literal) { if (token.text.indexOf('\n') >= 0) opening = null; return; }
      for (var i = 0; i < token.text.length; i++) {
        if (token.text[i] === '\n') opening = null;
        if (token.text.slice(i, i + 2) !== '**') continue;
        if (opening) {
          opening.token.omit.push(opening.at, opening.at + 1);
          token.omit.push(i, i + 1); opening = null; i++; continue;
        }
        var next = token.text[i + 2];
        if (next && next !== '*' && !/\s/.test(next)) { opening = { token: token, at: i }; i++; }
      }
    });
    tokens.forEach(function (token) {
      var skipped = new Set(token.omit || []);
      var content = token.omit && token.omit.length
        ? token.text.split('').filter(function (_, i) { return !skipped.has(i); }).join('')
        : token.text;
      if (content) parts.push({ kind: token.kind, text: content });
    });
  }
  function flush() { if (prose) { inline(prose); prose = ''; } }
  var lines = String(value || '').match(/[^\n]*\n|[^\n]+$/g) || [];
  lines.forEach(function (line) {
    if (fence) {
      var close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
      if (close && close[1].length >= fence.length && close[1][0] === fence.marker) {
        parts.push({ kind: 'code', text: code, block: true });
        code = ''; fence = null;
      } else code += line;
      return;
    }
    var opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n?$/.exec(line);
    if (opening) {
      flush(); fence = { marker: opening[1][0], length: opening[1].length }; return;
    }
    var directive = /^@open[:：][ \t]*([^\s@，。；]+)[ \t]*\r?\n?$/.exec(line);
    if (directive) {
      flush(); parts.push({ kind: 'open', token: directive[1], text: line }); return;
    }
    prose += line;
  });
  flush();
  if (fence) parts.push({ kind: 'code', text: code, block: true });
  // 只把回复末尾、代码外的独立导航行作为按钮建议。
  var atEnd = true;
  for (var i = parts.length - 1; i >= 0; i--) {
    var part = parts[i];
    if (part.kind === 'open') { if (!atEnd) part.kind = 'text'; }
    else if (part.kind !== 'text' || part.text.trim()) atEnd = false;
  }
  return parts;
}
