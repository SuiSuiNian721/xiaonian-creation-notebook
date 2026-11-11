// MVU 生成器（Zod4 口径）
// MVU = 卡内持久变量系统。本模块只"生成文本"，运行时不依赖任何本地库。
// 口径依据：ST-Prompt-Template / MVU 变量框架的公开语法事实（z、_ 全局；registerMvuSchema；
//   JSON Patch 输出；[initvar]/变量列表/[mvu_update] 四类世界书条目；MVU 自动附加占位符）。
// 生成的代码与散文全部本项目自写，不含任何第三方 GPL 代码。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, safeName, assertWorkspacePath, requireObject } from './card.mjs';

const IDENT = /^[A-Za-z_$\u4e00-\u9fa5][A-Za-z0-9_$\u4e00-\u9fa5]*$/;
const key = (k) => (k === '__proto__' ? '["__proto__"]' : IDENT.test(String(k)) ? String(k) : JSON.stringify(String(k)));
const jsonVal = (v) => JSON.stringify(v);
const scriptVal = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const YKEY = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*$/;
const ykey = (k) => (YKEY.test(String(k)) ? String(k) : JSON.stringify(String(k)));

function initialOf(field) {
  const t = field.type || 'string';
  if (field.default !== undefined && field.default !== null) return field.default;
  switch (t) {
    case 'number': return typeof field.min === 'number' ? field.min : 0;
    case 'boolean': return false;
    case 'enum': return Array.isArray(field.values) ? (field.values[0] ?? '') : '';
    case 'array': return [];
    case 'record': return {};
    case 'string':
    default: return '';
  }
}

// 单个字段的 Zod4 表达式；nested=true 时为数组元素 / record 值类型，不带 .prefault()
// Zod4 要点：需要让默认值继续经过校验时使用 .prefault()；
//   约束用 .transform(v => _.clamp(...)) 而非 min/max；record 用 z.record(keySchema, valSchema)。
function zodFor(field, nested) {
  const t = field.type || 'string';
  const d = field.default;
  const pf = (v) => (nested || v === undefined ? '' : `.prefault(${jsonVal(v)})`);
  switch (t) {
    case 'number': {
      const hasMin = typeof field.min === 'number';
      const hasMax = typeof field.max === 'number';
      let s = `z.coerce.number()${pf(d ?? (hasMin ? field.min : 0))}`;
      if (hasMin || hasMax) {
        const lo = hasMin ? field.min : '-Infinity';
        const hi = hasMax ? field.max : 'Infinity';
        s += `.transform((v) => _.clamp(v, ${lo}, ${hi}))`;
      }
      return s;
    }
    case 'boolean':
      return `z.boolean()${pf(d ?? false)}`;
    case 'enum': {
      const vals = Array.isArray(field.values) ? field.values : [];
      return `z.enum([${vals.map(jsonVal).join(', ')}])${pf(d ?? vals[0] ?? '')}`;
    }
    case 'array': {
      const item = field.itemType ? zodFor({ type: field.itemType }, true) : 'z.string()';
      return `z.array(${item})${pf(d ?? [])}`;
    }
    case 'record': {
      const val = field.valueType ? zodFor({ type: field.valueType }, true) : 'z.string()';
      const k = field.keyType ? zodFor({ type: field.keyType }, true) : 'z.string()';
      return `z.record(${k}, ${val})${pf(d ?? {})}`;
    }
    case 'string':
    default:
      return `z.string()${pf(d ?? '')}`;
  }
}

// ---------- 一、变量结构脚本（Zod Schema） ----------
// z 与 _ 已全局可用，勿 import。贴进"角色脚本"（extensions.tavern_helper 引用的脚本体）。
export function generateZodSchema(def) {
  const out = [];
  // 规格（MVU自查·一）要求 import 原封不动在开头，注释放其后
  out.push(`import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource@cadd882d49092355488eda21c611451098436bee/dist/util/mvu_zod.js';`);
  out.push(`// MVU 变量结构（Zod4）。z 与 _ 全局可用，勿 import。`);
  out.push(`// 由角色卡创作区生成；贴进"角色脚本"，随卡载入时注册。`);
  out.push('');
  out.push(`export const Schema = z.object({`);
  for (const g of (def.groups || [])) {
    out.push(`  ${key(g.name)}: z.object({`);
    for (const f of (g.fields || [])) out.push(`    ${key(f.name)}: ${zodFor(f)},`);
    // 每个子字段已有默认输入，缺少整组时让 {} 经过子字段校验并补齐结构。
    out.push(`  }).prefault({}),`);
  }
  out.push(`});`);
  out.push('');
  out.push(`$(() => { registerMvuSchema(Schema); });`);
  return out.join('\n');
}

// ---------- 二、初值 ----------
export function generateInitial(def) {
  return Object.fromEntries((def.groups || []).map(g => [g.name,
    Object.fromEntries((g.fields || []).map(f => [f.name, initialOf(f)])),
  ]));
}

// 极简 YAML 序列化（够用于初值 / 更新规则；字符串按需加引号）
function yamlScalar(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '' || /[:#\n]|^\s|\s$|^[-?&*!|>%@`]/.test(s)
    || /^(?:null|~|true|false|yes|no|on|off|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)$/i.test(s)) return JSON.stringify(s);
  return s;
}
function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return pad + '[]';
    return value.map((it) => {
      if (it && typeof it === 'object') {
        const inner = toYaml(it, indent + 1).replace(/^ {2}/, '');
        return `${pad}-\n  ${pad}${inner.trimStart()}`;
      }
      return `${pad}- ${yamlScalar(it)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return pad + '{}';
    return keys.map((k) => {
      const v = value[k];
      const isObj = v && typeof v === 'object';
      const empty = isObj && (Array.isArray(v) ? !v.length : !Object.keys(v).length);
      if (isObj && !empty) return `${pad}${ykey(k)}:\n${toYaml(v, indent + 1)}`;
      if (empty) return `${pad}${ykey(k)}: ${Array.isArray(v) ? '[]' : '{}'}`;
      return `${pad}${ykey(k)}: ${yamlScalar(v)}`;
    }).join('\n');
  }
  return pad + yamlScalar(value);
}

// [initvar] 条目正文：YAML 初始值（该条目须设为"禁用"，只作为开局全量初始化的数据源）
export function generateInitvarYaml(def) {
  return toYaml(generateInitial(def));
}

// 开局消息里的全量初始化块（也可改用 JSONPatch 增量）
export function generateBootstrap(def) {
  return `<UpdateVariable><initvar>\n${generateInitvarYaml(def)}\n</initvar></UpdateVariable>`;
}

// ---------- 三、变量列表（回注当前值，固定内容） ----------
// 条目名"变量列表"（不加 [mvu_update]），D0/D1，顺序 200，常驻。
export function generateVarListEntry(def) {
  const varName = def.varName || 'stat_data';
  // 标签名是提示词包装约定；与更新规则里的引用保持一致。
  return `---\n<status_current_variables>\n{{format_message_variable::${varName}}}\n</status_current_variables>`;
}

// ---------- 四、[mvu_update]变量更新规则（YAML：type / range / check） ----------
// 编写技巧：自明变量省略规则，同类合并，_ 开头只读变量不写。
function ruleType(f) {
  const t = f.type || 'string';
  if (t === 'enum') return `enum(${(f.values || []).join(' | ')})`;
  if (t === 'array') return `array<${f.itemType || 'string'}>`;
  if (t === 'record') return `{ [${f.keyType || 'string'}]: ${f.valueType || 'string'} }`;
  return t;
}
export function generateUpdateRules(def) {
  const lines = ['---', '变量更新规则:'];
  for (const g of (def.groups || [])) {
    const fields = (g.fields || []).filter((f) => !String(f.name).startsWith('_'));
    if (!fields.length) continue;
    lines.push(`  ${ykey(g.name)}:`);
    for (const f of fields) {
      lines.push(`    ${ykey(f.name)}:`);
      lines.push(`      type: ${yamlScalar(ruleType(f))}`);
      if (typeof f.min === 'number' || typeof f.max === 'number') {
        const lo = typeof f.min === 'number' ? f.min : '-∞';
        const hi = typeof f.max === 'number' ? f.max : '+∞';
        lines.push(`      range: ${yamlScalar(`${lo}~${hi}`)}`);
      }
      const checks = Array.isArray(f.check) ? f.check : (f.check ? [f.check] : (f.desc ? [f.desc] : []));
      if (checks.length) {
        lines.push(`      check:`);
        for (const c of checks) lines.push(`        - ${yamlScalar(c)}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------- 五、[mvu_update]变量输出格式（RFC 6902 常用操作） ----------
// 不放含占位符或省略号的伪 JSON，避免模型照抄后输出无效补丁。
export function generateOutputFormat() {
  return [
    '---',
    '变量输出格式:',
    '  rule:',
    '    - 在回复末尾输出一个 <UpdateVariable> 块，内含简短 <Analysis> 和 <JSONPatch>。',
    '    - <JSONPatch> 内必须是合法 JSON 数组；只使用 add、replace、remove、move。',
    '    - add 用于新增对象键或向数组 /- 追加；replace 用于覆盖已有值；remove 用于删除；move 使用 from 与 path。',
    '    - path 从 stat_data 根开始，以 / 分段，不写 stat_data 前缀。',
    '    - 数值变化写计算后的值，用 replace；不输出 delta 或 insert。',
    '    - 只依据本轮剧情和当前变量更新；没有变化时 JSONPatch 写 []。',
    '    - 不更新以 _ 开头的字段；不得输出注释、尾逗号或省略号。',
    '    - 标签顺序：<UpdateVariable>、<Analysis>、</Analysis>、<JSONPatch>、</JSONPatch>、</UpdateVariable>。',
  ].join('\n');
}

// ---------- 五·补、[mvu_update]变量输出格式强调 ----------
// 仅在真机测试发现 AI 经常漏掉变量块时启用。
export function generateOutputEmphasis() {
  return [
    '---',
    '变量输出格式强调:',
    '  rule: 每轮回复末尾保留完整的 <UpdateVariable> 块；<JSONPatch> 必须是合法 JSON 数组，没有变化写 []。',
  ].join('\n');
}

// 合并"更新规则 + 输出格式"，即注入卡内教模型如何更新变量的一段（旧接口名保留）
export function generateUpdateHint(def) {
  return `${generateUpdateRules(def)}\n\n${generateOutputFormat()}`;
}

// ---------- 六、状态面板 HTML（正则替换 <StatusPlaceHolderImpl/> 用） ----------
// 状态栏按所在消息楼层读取 MVU 数据，避免取到别的楼层或作用域的变量。
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function panelHtml(def) {
  const varName = def.varName || 'stat_data';
  const root = def.root || '状态';
  const rows = [];
  for (const g of (def.groups || [])) {
    for (const f of (g.fields || [])) {
      if (String(f.name).startsWith('$')) continue; // $ 前缀：AI/前端不可见
      rows.push({ group: g.name, field: f.name, dft: initialOf(f) });
    }
  }
  const body = rows.map((r, i) =>
    `      <tr><td class="mvu-k">${escHtml(r.group)} · ${escHtml(r.field)}</td><td class="mvu-v" id="mvu-v${i}">—</td></tr>`
  ).join('\n') || `      <tr><td class="mvu-k" colspan="2">（无字段）</td></tr>`;
  const reads = rows.map((r, i) =>
    `        set('mvu-v${i}', _.get(all, ${scriptVal([varName, r.group, r.field])}, ${scriptVal(r.dft ?? '')}));`
  ).join('\n');

  return [
    '<div class="mvu-panel">',
    '  <style>',
    '    html,body{margin:0;padding:0}',
    '    .mvu-panel{--mvu-fg:#1c2430;--mvu-mut:#6b7688;--mvu-bg:#fff;--mvu-line:rgba(0,0,0,.10);',
    '      max-width:520px;margin:10px auto;padding:12px 14px;color:var(--mvu-fg);background:var(--mvu-bg);',
    '      border:1px solid var(--mvu-line);border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.07);',
    '      font-family:"Noto Sans SC","Microsoft YaHei UI",sans-serif;font-size:13px;line-height:1.6}',
    '    .mvu-panel .mvu-h{font-weight:700;margin-bottom:6px}',
    '    .mvu-panel table{width:100%;border-collapse:collapse}',
    '    .mvu-panel td{padding:4px 6px;border-bottom:1px solid var(--mvu-line);vertical-align:top}',
    '    .mvu-panel .mvu-k{color:var(--mvu-mut);white-space:nowrap}',
    '    .mvu-panel .mvu-v{text-align:right;word-break:break-all}',
    '    @media (prefers-color-scheme:dark){.mvu-panel{--mvu-fg:#dfe7f2;--mvu-mut:#8d9bb0;--mvu-bg:#151b26;--mvu-line:rgba(255,255,255,.10)}}',
    '  </style>',
    `  <div class="mvu-h">${escHtml(root)}</div>`,
    '  <table>',
    body,
    '  </table>',
    '  <script type="module">',
    '    const set = (id, v) => {',
    '      const el = document.getElementById(id);',
    '      if (!el) return;',
    '      let t = (v && typeof v === \'object\') ? JSON.stringify(v) : v;',
    '      el.textContent = (t === \'\' || t === null || t === undefined) ? \'—\' : String(t);',
    '    };',
    '    const populateCharacterData = () => {',
    '      if (typeof Mvu === \'undefined\' || typeof _ === \'undefined\') return;',
    '      const id = typeof getCurrentMessageId === \'function\' ? getCurrentMessageId() : \'latest\';',
    '      const all = Mvu.getMvuData({ type: \'message\', message_id: id });',
    reads,
    '    };',
    '    const init = async () => {',
    '      if (typeof waitGlobalInitialized === \'function\') { try { await waitGlobalInitialized(\'Mvu\'); } catch (e) {} }',
    '      populateCharacterData();',
    '      if (typeof Mvu !== \'undefined\' && Mvu.events && typeof eventOn === \'function\') {',
    '        eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, populateCharacterData);',
    '      }',
    '    };',
    '    if (typeof $ === \'function\' && typeof errorCatched === \'function\') { $(errorCatched(init)); } else { init(); }',
    '  </script>',
    '</div>',
  ].join('\n');
}

// ---------- 七、正则脚本（5 条：3 变量更新 + 2 占位符） ----------
const script = (over) => ({
  trimStrings: [], placement: [2], disabled: false, markdownOnly: false,
  promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...over,
});

export function generateRuntimeKit(def) {
  const varName = def.varName || 'stat_data';
  const ph = def.placeholder || 'StatusPlaceHolderImpl';
  const phTag = `<${ph}/>`;
  const varFind = '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm';
  const phFind = `/<${ph}\\s*\\/>/g`;
  const pendingFind = '/<UpdateVariable>(?:(?!<\\/UpdateVariable>)[\\s\\S])*$/g';
  const pill = '<span class="mvu-upd-pill" style="display:inline-block;padding:1px 8px;margin:2px 0;border-radius:999px;background:rgba(120,140,170,.16);color:#6b7688;font-size:12px">🔄 变量更新中</span>';

  return {
    varName,
    placeholder: ph,
    // 常驻世界书条目（变量列表）：每轮把变量当前值注回 prompt，模型才知道面板上的数
    echoEntry: generateVarListEntry(def),
    echoSidecar: `keys: []\nsecondary_keys: []\nconstant: true\ninsertion_order: 200\nenabled: true\nposition: "after_char"\nuse_regex: true\n`,
    panelHtml: panelHtml(def),
    regexScripts: [
      // —— 变量更新（3 条）——
      script({ scriptName: '[不发送]去除变量更新', findRegex: varFind, replaceString: '', promptOnly: true, runOnEdit: false }),
      script({ scriptName: '[美化]变量更新中', findRegex: pendingFind, replaceString: pill, markdownOnly: true }),
      script({ scriptName: '[美化]完整变量更新', findRegex: varFind, replaceString: '', markdownOnly: true }),
      // —— 界面占位符（2 条）——
      script({ scriptName: '[不发送]界面占位符', findRegex: phFind, replaceString: '', promptOnly: true, runOnEdit: false }),
      script({ scriptName: '[界面]状态栏', findRegex: phFind, replaceString: '```html\n' + panelHtml(def) + '\n```', markdownOnly: true }),
    ],
    // MVU 会自动在每条 AI 回复末尾附加占位符，无需在提示词里命令模型手写
    placeholderNote: [
      `MVU 会在每条 AI 回复末尾自动附加 ${phTag}，再由正则脚本渲染成状态面板。`,
      `不要在提示词里要求模型手动输出 ${phTag}，也不要让它手写面板 HTML（面板由脚本接管）。`,
    ].join('\n'),
    phTag,
  };
}

// ---------- 八、酒馆助手角色脚本（extensions.tavern_helper.scripts） ----------
// 角色脚本 = 绑在卡上、随卡载入的 tavern_helper 脚本对象。这里只生成结构与文本，不执行。
const MVU_BUNDLE_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@b13b43bac24d585f2b523c12e423bb803fa9dd7c/artifact/bundle.js';
const thScript = (over) => ({
  id: globalThis.crypto.randomUUID(),
  enabled: true,
  type: 'script',
  info: '',
  button: { enabled: true, buttons: [] },
  data: {},
  export_with: { data: true, button: true },
  ...over,
});

export function generateTavernScripts(def, schema) {
  const scripts = [
    thScript({
      name: 'MVU变量框架',
      content: `import '${MVU_BUNDLE_URL}'\n`,
      button: {
        enabled: true,
        buttons: [
          { name: '重新读取初始变量', visible: true },
          { name: '重新处理变量', visible: true },
          { name: '重试额外模型解析', visible: true },
        ],
      },
    }),
    // schema 自身已含 mvu_zod 的 import 与 registerMvuSchema 调用
    thScript({ name: 'MVU变量结构守门(Zod)', content: schema, info: '约束 stat_data 结构（类型/枚举/默认值），由角色卡创作区生成。' }),
  ];
  for (const im of (def.imports || [])) {
    if (!im || !im.name || !im.url) continue;
    scripts.push(thScript({ name: String(im.name), content: `import ${JSON.stringify(String(im.url))}\n`, info: String(im.info || '') }));
  }
  return scripts;
}

// 默认只补缺项；显式重建时才替换同名生成内容。
function mergeByName(list, gen, keyOf, replaceGenerated) {
  const out = Array.isArray(list) ? list.slice() : [];
  for (const g of gen) {
    const i = out.findIndex((x) => x && keyOf(x) === keyOf(g));
    if (i < 0) { out.push(g); continue; }
    if (!replaceGenerated) continue;
    const old = out[i];
    out[i] = {
      ...old,
      ...g,
      id: old.id || g.id,
      button: old.button || g.button,
      data: old.data || g.data,
      export_with: old.export_with || g.export_with,
      info: old.info || g.info,
      ...(Object.hasOwn(old, 'enabled') ? { enabled: old.enabled } : {}),
      ...(Object.hasOwn(old, 'disabled') ? { disabled: old.disabled } : {}),
    };
  }
  return out;
}

export function mergeRuntimeData(extra, bundle, { replaceGenerated = false } = {}) {
  requireObject(extra, 'extra.json');
  const result = structuredClone(extra);
  result.extensions = result.extensions || {};
  const ext = requireObject(result.extensions, 'extensions');
  ext.regex_scripts = mergeByName(ext.regex_scripts, bundle.runtime.regexScripts, s => s.scriptName, replaceGenerated);
  ext.tavern_helper = ext.tavern_helper || {};
  requireObject(ext.tavern_helper, 'tavern_helper');
  ext.tavern_helper.scripts = mergeByName(ext.tavern_helper.scripts, bundle.tavernScripts, s => s.name, replaceGenerated);
  return result;
}

// 把正则脚本 + 角色脚本合并写进卡的 src/extra.json（src 是允许编辑面；改动经 check/build 生效）。
export function applyRuntimeToCard(cardName, bundle, options = {}) {
  const src = assertWorkspacePath(ROOT, path.join(ROOT, 'cards', safeName(cardName), 'src'));
  if (!fs.existsSync(src)) throw new Error('找不到该卡的 src 目录: ' + cardName);
  const extraFile = assertWorkspacePath(ROOT, path.join(src, 'extra.json'));
  const extra = fs.existsSync(extraFile) ? JSON.parse(fs.readFileSync(extraFile, 'utf8')) : {};
  fs.writeFileSync(extraFile, JSON.stringify(mergeRuntimeData(extra, bundle, options), null, 2) + '\n', 'utf8');
  return extraFile;
}

// 一次性生成全套
export function generateMvuBundle(def) {
  const runtime = generateRuntimeKit(def);
  const schema = generateZodSchema(def);
  return {
    schema,
    initial: generateInitial(def),
    initialYaml: generateInitvarYaml(def),
    bootstrap: generateBootstrap(def),
    varListEntry: generateVarListEntry(def),
    updateRules: generateUpdateRules(def),
    outputFormat: generateOutputFormat(),
    outputEmphasis: generateOutputEmphasis(),
    updateHint: generateUpdateHint(def),
    runtime,
    tavernScripts: generateTavernScripts(def, schema),
  };
}

// 内置示例定义（demo / 无参时用）
export const DEMO_DEF = {
  root: '状态',
  groups: [
    {
      name: '属性',
      fields: [
        { name: '好感度', type: 'number', default: 0, min: 0, max: 100, desc: '对 {{user}} 的好感', check: '根据角色反应调整 ±(3~6)' },
        { name: '信任', type: 'number', default: 10, min: 0, max: 100 },
        { name: '姓名', type: 'string', default: '' },
        { name: '是否觉醒', type: 'boolean', default: false },
        { name: '阶段', type: 'enum', values: ['初醒', '成熟', '失控'], default: '初醒' },
      ],
    },
    {
      name: '背包',
      fields: [
        { name: '道具', type: 'record', valueType: 'number', default: {}, desc: '道具名 → 数量' },
        { name: '金币', type: 'number', default: 0, min: 0 },
      ],
    },
  ],
};

// CLI：node tools/mvu.mjs [gen <定义.json> | demo]
export function cmdMvu(arg, defPath) {
  let def = DEMO_DEF;
  if (arg === 'gen') {
    if (!defPath) throw new Error('用法: node tools/mvu.mjs gen <定义.json>');
    def = JSON.parse(fs.readFileSync(defPath, 'utf8'));
  }
  return generateMvuBundle(def);
}

function main(argv) {
  const args = argv.slice();
  const ri = args.indexOf('--replace-generated');
  const replaceGenerated = ri >= 0;
  if (replaceGenerated) args.splice(ri, 1);
  let cardName = null;
  const ci = args.indexOf('--card');
  if (ci >= 0) { cardName = args[ci + 1]; args.splice(ci, 2); }
  const [arg, defPath] = args;
  if (arg === 'help' || arg === '--help') {
    console.log('用法: node tools/mvu.mjs <gen <定义.json> | demo> [--card <卡名>]');
    console.log('  gen <file>  从变量组定义 JSON 生成 Zod4 schema + 初值 + 世界书条目 + 正则脚本 + 角色脚本');
    console.log('  demo        用内置示例定义演示生成结果');
    console.log('  --card 名   把正则脚本与 tavern_helper 角色脚本合并写入该卡 src/extra.json');
    console.log('  默认只补缺项，保留同名定制；--replace-generated 显式重建同名生成项（先备份并核对差异）。');
    return 0;
  }
  const b = cmdMvu(arg || 'demo', defPath);
  const rt = b.runtime;
  console.log('===== ① 变量结构脚本（Zod4，贴进角色脚本）=====\n' + b.schema);
  console.log('\n===== ② [initvar]变量初始化勿开（世界书条目，禁用；YAML 初值）=====\n' + b.initialYaml);
  console.log('\n     开局全量初始化块（仅不同开场需要全量覆盖时使用）：\n' + b.bootstrap);
  console.log('\n===== ③ 变量列表（常驻世界书条目，D0/D1，顺序 200）=====\n' + b.varListEntry);
  console.log('\n----- 变量列表侧车 -----\n' + rt.echoSidecar.trimEnd());
  console.log('\n===== ④ [mvu_update]变量更新规则（世界书条目，D0，顺序 200）=====\n' + b.updateRules);
  console.log('\n===== ⑤ [mvu_update]变量输出格式（世界书条目，深度按预设测试）=====\n' + b.outputFormat);
  console.log('\n===== ⑤b [mvu_update]变量输出格式强调（仅真机发现 AI 漏块时启用）=====\n' + b.outputEmphasis);
  console.log('\n===== 占位符说明 =====\n' + rt.placeholderNote);
  console.log('\n===== ⑥ 正则脚本（贴进 extra.json 的 extensions.regex_scripts）=====\n' + JSON.stringify(rt.regexScripts, null, 2));
  console.log('\n===== ⑦ 酒馆助手角色脚本（extra.json 的 extensions.tavern_helper.scripts）=====\n' + JSON.stringify(b.tavernScripts, null, 2));
  if (cardName) {
    const f = applyRuntimeToCard(cardName, b, { replaceGenerated });
    console.log('\n===== 已写入 =====\n' + f + '（regex_scripts 与 tavern_helper.scripts 按名合并，未动其它键）');
    console.log(replaceGenerated ? '已显式重建同名生成项；请核对定制差异。' : '同名项已保留；schema/面板如需更新请定向编辑，此命令只补缺项。');
  }
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exit(main(process.argv.slice(2)));
