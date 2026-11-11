// EJS 生成器（ST-Prompt-Template 扩展口径）
// 只"生成文本"：多阶段人设控制器 + @@iframe 状态栏 + 一个静态校验器。
// 语法事实依据公开的 EJS 世界书扩展 API（<%_ _%> / getvar / await getwi / 装饰器 /
//   getAllVariables / Mvu 事件）；生成的代码与散文全部本项目自写，不含任何第三方 GPL 代码。
// 本模块不执行任何卡内脚本 / EJS / HTML，只做只读生成与静态检查。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENT = /^[A-Za-z_$\u4e00-\u9fa5][A-Za-z0-9_$\u4e00-\u9fa5]*$/;
const RESERVED = new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval'.split(' '));
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const jsVar = (n, i) => (IDENT.test(String(n)) && !RESERVED.has(String(n)) ? String(n) : `v${i}`);
const jsLiteral = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

// ---------- 一、多阶段人设控制器 ----------
// 控制器条目：蓝灯永久激活、顺序 100、不勾防递归；用 getvar 读变量，按阈值 getwi 加载阶段条目。
// 阶段条目：禁用、顺序 98~800，由控制器按需 getwi 加载（禁用才不会自己常驻）。
// def: { varPath, varName, default, stages:[{ max?, entry }], title }
export function generateEjsController(def) {
  const varPath = def.varPath || 'stat_data.属性.好感度';
  // getvar 读 MVU 变量必须带 stat_data 前缀——缺了就补上，避免生成不可用代码
  const full = /^stat_data\./.test(varPath) ? varPath : `stat_data.${varPath}`;
  const local = jsVar(def.varName || 'goodwill', 0);
  const dflt = def.default ?? 0;
  const stages = Array.isArray(def.stages) && def.stages.length ? def.stages : [{ entry: '角色_阶段01' }];

  stages.forEach((stage, i) => {
    if (typeof stage.entry !== 'string' || !stage.entry.trim()) throw new Error('阶段条目名不能为空');
    if (i < stages.length - 1 && (!Number.isFinite(stage.max) || (i > 0 && stage.max <= stages[i - 1].max))) {
      throw new Error('阶段阈值必须是严格递增的有限数字，最后一项为兜底');
    }
  });
  const L = ['@@private'];
  // 各控制器独立作用域，避免同名局部变量复用另一条目的状态。
  L.push('<%_');
  L.push(`const ${local} = getvar(${jsLiteral(full)}, { defaults: ${jsLiteral(dflt)} });`);
  L.push('_%>');
  stages.forEach((st, i) => {
    const last = i === stages.length - 1;
    let open;
    if (i === 0) open = !last ? `<%_ if (${local} < ${st.max}) { _%>` : '<%_ { _%>';
    else open = (!last && st.max !== undefined) ? `<%_ } else if (${local} < ${st.max}) { _%>` : '<%_ } else { _%>';
    L.push(open);
    L.push(`<%- await getwi(${jsLiteral(st.entry)}) %>`);
  });
  L.push('<%_ } _%>');

  const content = L.join('\n');
  const sidecar = [
    'keys: []',
    'secondary_keys: []',
    'constant: true',
    'insertion_order: 100',
    'enabled: true',
    'position: "before_char"',
    'use_regex: false',
    'selective: false',
    '# 控制器：常驻、顺序 100；目标条目按需读取。',
  ].join('\n');
  const note = [
    '接线要点：',
    '· 控制器条目设为蓝灯（constant）、顺序 100、不勾"防递归(prevent_recursion)"。',
    '· 被 getwi 加载的阶段条目必须设为"禁用"（否则它们会自己常驻），顺序 98~800。',
    '· 装饰器 / EJS 标签每行一个，条目开头不能有空行。',
    '· @@private 隔离局部变量，可使用 const；改名后运行诊断检查 getwi 引用。',
  ].join('\n');
  return { content, sidecar, note };
}

// ---------- 二、@@iframe 状态栏（渲染到消息末尾，不发给 AI） ----------
// 装饰器：@@render_after + @@iframe 标题 + @@if !is_user && !is_system，每行一个、开头无空行。
// 原生 iframe：在 EJS 渲染阶段读取变量并转义输出；不假设 iframe 内有酒馆助手全局。
// 需要实时事件订阅时使用酒馆助手面板，而不是将两种 iframe 环境混用。
export function generateEjsStatusBar(def) {
  const varName = def.varName || 'stat_data';
  const title = def.title || '状态';
  const rows = [];
  for (const g of (def.groups || [])) {
    for (const f of (g.fields || [])) {
      if (String(f.name).startsWith('$')) continue;
      rows.push({ group: g.name, field: f.name, dft: f.default ?? '' });
    }
  }
  const body = rows.map((r, i) =>
    `      <tr><td class="k">${escHtml(r.group)} · ${escHtml(r.field)}</td><td class="v" id="sb-v${i}"><%= (() => { const value = _.get(getvar(${jsLiteral(varName)}) || {}, ${jsLiteral([r.group, r.field])}, ${jsLiteral(r.dft)}); return value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value); })() %></td></tr>`
  ).join('\n') || `      <tr><td class="k" colspan="2">（无字段）</td></tr>`;

  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh">',
    '<head>',
    '<meta charset="utf-8">',
    '<style>',
    '  html,body{margin:0;padding:0}',
    '  .sb{--fg:#1c2430;--mut:#6b7688;--bg:#fff;--line:rgba(0,0,0,.10);',
    '    max-width:520px;margin:10px auto;padding:12px 14px;color:var(--fg);background:var(--bg);',
    '    border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.07);',
    '    font-family:"Noto Sans SC","Microsoft YaHei UI",sans-serif;font-size:13px;line-height:1.6}',
    '  .sb h4{margin:0 0 6px;font-size:13px}',
    '  .sb table{width:100%;border-collapse:collapse}',
    '  .sb td{padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}',
    '  .sb .k{color:var(--mut);white-space:nowrap}',
    '  .sb .v{text-align:right;word-break:break-all}',
    '  @media (prefers-color-scheme:dark){.sb{--fg:#dfe7f2;--mut:#8d9bb0;--bg:#151b26;--line:rgba(255,255,255,.10)}}',
    '</style>',
    '</head>',
    '<body>',
    `  <div class="sb"><h4>${escHtml(title)}</h4>`,
    '  <table>',
    body,
    '  </table></div>',
    '</body>',
    '</html>',
  ].join('\n');

  // 装饰器块（每行一个，开头无空行）+ 完整 HTML 文档
  const content = [
    '@@render_after',
    `@@iframe ${title}`,
    '@@if !is_user && !is_system',
    html,
  ].join('\n');
  const sidecar = [
    'keys: []',
    'secondary_keys: []',
    'constant: true',
    'insertion_order: 300',
    'enabled: true',
    'position: "after_char"',
    'use_regex: false',
    '# 原生 iframe：模板渲染时读取状态，不订阅酒馆助手事件。',
  ].join('\n');
  return { content, html, sidecar };
}

// 只提取 EJS 代码内可静态确定的 getwi 引用；不执行表达式或解析动态书名。
export function findWorldbookReferences(text) {
  const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+|null)`;
  const calls = new RegExp(String.raw`\b(?:getwi|getWorldInfo)\s*\(\s*(${literal})\s*(?:,\s*(${literal})\s*)?(?=[,)])`, 'g');
  const decode = token => {
    if (token === 'null') return null;
    if (/^\d+$/.test(token)) return Number(token);
    if (token.startsWith('"')) return JSON.parse(token);
    return token.slice(1, -1).replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_, escape) => {
      if (/^[ux]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' })[escape] ?? escape;
    });
  };
  const refs = [];
  for (const block of String(text).matchAll(/<%[-_=]?([\s\S]*?)[_-]?%>/g)) {
    // 保留字符串，跳过注释和模板字面量，防止示例中的 getwi 被当作调用。
    const code = block[1].replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (all, quoted) => quoted || ' ');
    for (const call of code.matchAll(calls)) {
      // 调用点前若有未闭合字符串则是字符串里的示例，不参与诊断。
      const prefix = code.slice(0, call.index).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
      if (/["']/.test(prefix)) continue;
      const tail = code.slice(call.index + call[0].length);
      if (call[2] === undefined && tail.startsWith(',') && !tail.slice(1).trimStart().startsWith('{')) continue;
      try {
        const first = decode(call[1]);
        const second = call[2] === undefined ? undefined : decode(call[2]);
        if (second === undefined && first !== null) refs.push({ book: null, target: first });
        else if (second !== undefined && second !== null) refs.push({ book: first || null, target: second });
      } catch { /* 无法确定的字面量由运行环境解析，静态检查不猜测 */ }
    }
  }
  return refs;
}

// ---------- 三、静态校验器（只读，不执行） ----------
// 返回 issues:[{severity,title,description}]；供 diagnose.checkEjs 复用。
export function validateEjs(text, label = '条目') {
  const src = String(text || '');
  const issues = [];
  if (!/<%|@@\w/.test(src)) return issues;

  const opens = (src.match(/<%/g) || []).length;
  const closes = (src.match(/%>/g) || []).length;
  if (opens !== closes) {
    issues.push({ severity: 'error', title: `「${label}」EJS 标签不配对`, description: `<% 有 ${opens} 处、%> 有 ${closes} 处；模板残缺会让整条注入内容出错` });
  }
  // getwi 必须 await（漏了会拿到 Promise，注入内容变成 [object Promise]）
  const code = [...src.matchAll(/<%[-_=]?([\s\S]*?)[_-]?%>/g)].map(block => block[1]
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ')).join('\n');
  const getwiSites = [...code.matchAll(/\bgetwi\s*\(/g)].filter(call => !/\bawait\s*$/.test(code.slice(0, call.index)));
  if (getwiSites && getwiSites.length) {
    issues.push({ severity: 'error', title: `「${label}」getwi() 缺少 await`, description: `有 ${getwiSites.length} 处 getwi( 前没有 await；必须写成 await getwi(...) 或 <%- await getwi(...) %>` });
  }
  // 共享作用域用 const 接 getvar → 多条目会重复声明报错
  if (/(?:^|[^.\w])const\s+[\w\u4e00-\u9fa5]+\s*=\s*getvar\s*\(/.test(src) && !/@@private|<%[_\s]*\{/.test(src) && !/typeof\s+[\w\u4e00-\u9fa5]+\s*===\s*'undefined'/.test(src)) {
    issues.push({ severity: 'warning', title: `「${label}」用 const 接 getvar`, description: '多条目共享同名变量时 const 会重复声明报错；改用 `if (typeof x === "undefined") var x = getvar(...)` 或加 @@private' });
  }
  if (/@@iframe\b/.test(src) && /<script\b[\s\S]*?\b(?:waitGlobalInitialized|eventOn|Mvu|getAllVariables)\b/i.test(src)) {
    issues.push({ severity: 'warning', title: `「${label}」原生 iframe 混用酒馆助手接口`, description: '原生 @@iframe 不保证提供这些全局；请在 EJS 阶段渲染数据，或改用酒馆助手前端。' });
  }
  // activewi 只能在 [GENERATE:BEFORE] / @@generate_before 条目里用
  if (/activewi\s*\(/.test(src) && !/@@generate_before|\[GENERATE:BEFORE\]/.test(src)) {
    issues.push({ severity: 'warning', title: `「${label}」activewi 可能不在 generate_before`, description: 'activewi 只能在 @@generate_before 或 [GENERATE:BEFORE] 条目中使用' });
  }
  // @@preprocessing 不能与 generate_before/after 混用
  if (/@@preprocessing/.test(src) && /@@generate_before|@@generate_after|\[GENERATE:BEFORE\]|\[GENERATE:AFTER\]/.test(src)) {
    issues.push({ severity: 'error', title: `「${label}」@@preprocessing 与 generate_before/after 混用`, description: '@@preprocessing 在世界书处理前执行，不能同时声明 @@generate_before/@@generate_after' });
  }
  // 装饰器必须连续排在开头，中间/之前不能有空行或正文
  const lines = src.split(/\r?\n/);
  let seenBlank = false, seenContent = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (/^@@\w/.test(t)) {
      if (seenBlank || seenContent) {
        issues.push({ severity: 'warning', title: `「${label}」装饰器未连续排在开头`, description: '装饰器（@@…）须逐行排在条目最前，中间不能有空行或正文' });
        break;
      }
    } else if (t === '') {
      seenBlank = true;
    } else {
      seenContent = true;
    }
  }
  return issues;
}

// ---------- 示例定义 ----------
export const DEMO_CONTROLLER = {
  varPath: 'stat_data.属性.好感度',
  varName: '好感度',
  default: 0,
  title: '好感度阶段控制器',
  stages: [
    { max: 30, entry: '角色_阶段01' },
    { max: 60, entry: '角色_阶段02' },
    { entry: '角色_阶段03' },
  ],
};
export const DEMO_STATUSBAR = {
  varName: 'stat_data',
  title: '状态',
  groups: [
    { name: '属性', fields: [{ name: '好感度', default: 0 }, { name: '阶段', default: '初醒' }] },
  ],
};

function main(argv) {
  const [arg] = argv;
  if (arg === 'help' || arg === '--help') {
    console.log('用法: node tools/ejs.mjs <controller | statusbar>');
    console.log('  controller  生成多阶段人设控制器条目（getvar + await getwi）');
    console.log('  statusbar   生成 @@iframe 状态栏条目（完整 HTML 文档）');
    return 0;
  }
  if (arg === 'statusbar') {
    const s = generateEjsStatusBar(DEMO_STATUSBAR);
    console.log('===== 状态栏条目正文 =====\n' + s.content);
    console.log('\n===== 侧车 =====\n' + s.sidecar);
    return 0;
  }
  const c = generateEjsController(DEMO_CONTROLLER);
  console.log('===== 控制器条目正文 =====\n' + c.content);
  console.log('\n===== 侧车 =====\n' + c.sidecar);
  console.log('\n===== ' + c.note + ' =====');
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exit(main(process.argv.slice(2)));
