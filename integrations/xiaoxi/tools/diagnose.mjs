// 内容诊断层 —— 在结构校验（card.mjs cmdCheck）之上，增加"写得好不好"的内容体检。
// 纯函数、零依赖；规则思路为通用制卡经验，代码与词表全部本项目自写，不含任何第三方 GPL 代码。
// 每个 check 返回统一结构：
//   { key, name, passed, summary, stats?, issues:[{ severity:'error'|'warning'|'info', title, description, location, fixable, fixId? }] }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCard, cardDir } from './card.mjs';
import { scanBagua } from './bagua-rules.mjs';
import { validateEjs, findWorldbookReferences } from './ejs.mjs';

const TOKEN_PER_CHAR = 1.3; // 中文粗估：1 字 ≈ 1.3 token
const BASE_TOKEN_LIMIT = 4000; // 基础字段合计 token 上限（超了挤占世界书）
const CONSTANT_TOKEN_LIMIT = 8000; // 常驻(蓝灯)条目 token 上限

// 过度通用的触发词：几乎每条消息都出现，会让条目常驻白烧 token
const COMMON_KEYS = new Set([
  '的', '了', '是', '在', '有', '和', '就', '都', '而', '及', '与', '着', '或', '也', '很',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '一个', '没有', '这个', '那个',
  '什么', '怎么', '现在', '时候', '东西', '世界', '人物', '系统', '等级', '修炼', '时间', '地方',
]);

const est = (text) => Math.round((text || '').length * TOKEN_PER_CHAR);
const entryLabel = (e, i) => e.name || (Array.isArray(e.keys) && e.keys[0]) || `#${i + 1}`;
const errCount = (issues) => issues.filter((i) => i.severity === 'error').length;

// 1. 基础字段体检：必填字数下限 + token 估算
export function checkBasicFields(data) {
  const issues = [];
  const required = [
    { key: 'name', label: '角色名 (name)', min: 1 },
    { key: 'description', label: '角色描述 (description)', min: 50 },
    { key: 'first_mes', label: '开场白 (first_mes)', min: 30 },
  ];
  for (const f of required) {
    const v = (data[f.key] || '').trim();
    if (!v) issues.push({ severity: 'error', title: `${f.label} 为空`, description: `必填字段 ${f.key} 没填写`, location: f.key, fixable: false });
    else if (v.length < f.min) issues.push({ severity: 'warning', title: `${f.label} 字数过少 (${v.length}/${f.min})`, description: `当前 ${v.length} 字，建议至少 ${f.min} 字，模型才能充分理解角色`, location: f.key, fixable: false });
  }
  const optional = [
    { key: 'personality', label: '性格 (personality)', min: 10 },
    { key: 'scenario', label: '场景 (scenario)', min: 0 },
    { key: 'mes_example', label: '对话示例 (mes_example)', min: 0 },
  ];
  for (const f of optional) {
    const v = (data[f.key] || '').trim();
    if (!v) issues.push({ severity: 'info', title: `${f.label} 为空`, description: '可选字段，但填了有助于角色一致性', location: f.key, fixable: false });
    else if (f.min && v.length < f.min) issues.push({ severity: 'info', title: `${f.label} 偏短 (${v.length}/${f.min})`, description: '建议再充实一些', location: f.key, fixable: false });
  }
  const totalChars = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt']
    .reduce((s, k) => s + ((data[k] || '').length), 0);
  const tokenEst = Math.round(totalChars * TOKEN_PER_CHAR);
  if (tokenEst > BASE_TOKEN_LIMIT) issues.push({ severity: 'warning', title: `基础字段总 token 偏多 (~${tokenEst})`, description: `description+personality+scenario+first_mes+mes_example+system_prompt 合计超过 ${BASE_TOKEN_LIMIT} token，可能挤占世界书空间`, location: '基础字段', fixable: false });
  return { key: 'basic_fields', name: '基础字段体检', passed: errCount(issues) === 0, summary: issues.length ? `${issues.length} 处问题（基础字段 ~${tokenEst} token）` : `基础字段齐全（~${tokenEst} token）`, stats: { totalChars, tokenEst }, issues };
}

// 2. 世界书结构：孤立条目 / 空正文 / 空名 / 空 key
export function checkWorldbook(data) {
  const entries = data.character_book?.entries || [];
  const issues = [];
  if (!entries.length) return { key: 'worldbook', name: '世界书结构', passed: true, summary: '世界书为空（如不需要可忽略）', stats: { total: 0 }, issues };
  const enabled = entries.filter((e) => e.enabled !== false);
  const constant = enabled.filter((e) => e.constant === true);
  const triggered = enabled.filter((e) => e.constant !== true);
  entries.forEach((e, i) => {
    const label = entryLabel(e, i);
    const validKeys = (Array.isArray(e.keys) ? e.keys : []).filter((k) => k && String(k).trim());
    if (e.enabled !== false && e.constant !== true && !validKeys.length) {
      issues.push({ severity: 'error', title: `条目「${label}」是绿灯却没有触发词`, description: '非常驻条目靠关键词触发，没有 keys 就永远不会被注入（等于白写）', location: label, fixable: true, fixId: 'make_constant_or_add_keys' });
    }
    if (!(e.content || '').trim()) {
      issues.push({ severity: 'error', title: `条目「${label}」正文 (content) 为空`, description: '空条目即使触发也不注入任何内容', location: label, fixable: true, fixId: 'delete_entry' });
    }
    if (Array.isArray(e.keys) && e.keys.some((k) => !k || !String(k).trim())) {
      issues.push({ severity: 'warning', title: `条目「${label}」keys 含空字符串`, description: '应过滤掉空白关键词', location: label, fixable: true, fixId: 'filter_empty_keys' });
    }
  });
  return { key: 'worldbook', name: '世界书结构', passed: errCount(issues) === 0, summary: `${entries.length} 条（蓝灯 ${constant.length} / 绿灯 ${triggered.length} / 禁用 ${entries.length - enabled.length}）${issues.length ? '，' + issues.length + ' 处问题' : ''}`, stats: { total: entries.length, enabled: enabled.length, constant: constant.length, triggered: triggered.length }, issues };
}

// 3. 关键词冲突：同 key 触发多条目 + 过度通用词
export function checkKeywordConflicts(data) {
  const entries = (data.character_book?.entries || []).filter((e) => e.enabled !== false && e.constant !== true);
  const issues = [];
  const keyMap = Object.create(null);
  for (const e of entries) for (const k of (Array.isArray(e.keys) ? e.keys : [])) {
    const t = String(k || '').trim();
    if (!t) continue;
    (keyMap[t] ||= []).push(e.name || t);
  }
  for (const [k, list] of Object.entries(keyMap)) {
    if (list.length > 1) issues.push({ severity: 'warning', title: `关键词「${k}」会同时触发 ${list.length} 个条目`, description: '出现一次就把所有同 key 条目全注入，浪费 token；建议把 key 改得更精确、彼此区分', location: list.join(' / '), fixable: false });
    if (COMMON_KEYS.has(k)) issues.push({ severity: 'error', title: `关键词「${k}」过度通用`, description: '这种词几乎每条消息都出现，会让条目近乎常驻触发、白烧 token', location: list.join(' / '), fixable: false });
  }
  return { key: 'keyword_conflicts', name: '关键词冲突', passed: errCount(issues) === 0, summary: `${Object.keys(keyMap).length} 个独立关键词${issues.length ? '，' + issues.length + ' 处冲突/通用词' : ''}`, stats: { totalKeys: Object.keys(keyMap).length, conflicts: issues.length }, issues };
}

// 4. Token 占用：常驻总量 + Top5
export function checkTokenUsage(data) {
  const entries = (data.character_book?.entries || []).filter((e) => e.enabled !== false);
  const issues = [];
  const ranked = entries.map((e, i) => ({ name: entryLabel(e, i), constant: e.constant === true, tokens: est(e.content) })).sort((a, b) => b.tokens - a.tokens);
  const constantTokens = ranked.filter((e) => e.constant).reduce((s, e) => s + e.tokens, 0);
  const triggeredTokens = ranked.filter((e) => !e.constant).reduce((s, e) => s + e.tokens, 0);
  if (constantTokens > CONSTANT_TOKEN_LIMIT) issues.push({ severity: 'warning', title: `常驻(蓝灯)条目总 token 偏多 (~${constantTokens})`, description: `常驻条目每轮都注入，超过 ${CONSTANT_TOKEN_LIMIT} token 会明显挤占 context；把不必要的改成绿灯触发`, location: '世界书-蓝灯合计', fixable: false });
  return { key: 'token_usage', name: 'Token 占用', passed: true, summary: `常驻 ~${constantTokens} / 触发 ~${triggeredTokens} / 合计 ~${constantTokens + triggeredTokens} token`, stats: { constantTokens, triggeredTokens, top5: ranked.slice(0, 5) }, issues };
}

// 5. 八股化扫描：正文字段 + 世界书条目
export function checkBagua(data) {
  const issues = [];
  let total = 0;
  for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    const text = data[key] || '';
    if (!text) continue;
    const hits = scanBagua(text);
    if (!hits.length) continue;
    total += hits.length;
    const byType = {};
    for (const h of hits) (byType[h.type] ||= new Set()).add(h.word);
    for (const [type, words] of Object.entries(byType)) {
      const arr = [...words];
      issues.push({ severity: 'warning', title: `${key} 含「${type}」(${arr.length} 处)`, description: `命中：${arr.slice(0, 5).join('、')}${arr.length > 5 ? '…' : ''}`, location: key, fixable: false });
    }
  }
  (data.character_book?.entries || []).forEach((e, i) => {
    if (e.enabled === false || !e.content) return;
    const hits = scanBagua(e.content);
    if (!hits.length) return;
    total += hits.length;
    const types = [...new Set(hits.map((h) => h.type))];
    issues.push({ severity: 'info', title: `条目「${entryLabel(e, i)}」含八股（${types.join('、')}）`, description: '世界书条目同样建议白描、去套路', location: entryLabel(e, i), fixable: false });
  });
  return { key: 'bagua', name: '八股化扫描', passed: total === 0, summary: total ? `共 ${total} 处套路化表达（建议改写）` : '未发现明显八股', stats: { total }, issues };
}

// 6. 正则脚本：语法能否编译 + 空模式 + 未锚定贪婪
export function checkRegexScripts(data) {
  const scripts = data.extensions?.regex_scripts || data.regex_scripts || [];
  const issues = [];
  if (!Array.isArray(scripts) || !scripts.length) return { key: 'regex_scripts', name: '正则脚本', passed: true, summary: '无正则脚本', stats: { total: 0 }, issues };
  scripts.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      issues.push({ severity: 'error', title: `正则脚本 #${i + 1} 结构无效`, description: '脚本条目必须是对象', location: `#${i + 1}`, fixable: false });
      return;
    }
    if (s.disabled) return;
    const label = s.scriptName || `#${i + 1}`;
    const find = s.findRegex != null ? String(s.findRegex) : '';
    if (!find.trim()) { issues.push({ severity: 'error', title: `正则「${label}」findRegex 为空`, description: '没有匹配模式，脚本无法工作', location: label, fixable: false }); return; }
    try {
      const end = find.lastIndexOf('/');
      if (find.startsWith('/') && end > 0) new RegExp(find.slice(1, end), find.slice(end + 1));
      else new RegExp(find);
    } catch (e) { issues.push({ severity: 'error', title: `正则「${label}」语法错误`, description: e.message, location: label, fixable: false }); return; }
    if (/\.\*/.test(find) && !/\.\*\?$/.test(find) && !find.includes('$')) issues.push({ severity: 'warning', title: `正则「${label}」含未锚定的 .*`, description: '贪婪通配没有边界，可能误匹配大段文本', location: label, fixable: false });
  });
  return { key: 'regex_scripts', name: '正则脚本', passed: errCount(issues) === 0, summary: `${scripts.length} 个脚本${issues.length ? '，' + issues.length + ' 处问题' : '，无问题'}`, stats: { total: scripts.length }, issues };
}

// 7. 运行时接线：MVU 变量块 / 状态栏占位符 / EJS 是否配齐
// 只读检查"卡写成了正确形状没有"，不执行卡内脚本 / EJS / HTML。
const HTML_TAG_RE = /<(?:div|style|details|span|table|script|link|img)\b/i;

export function checkRuntimeWiring(data) {
  const issues = [];
  const scripts = (Array.isArray(data.extensions?.regex_scripts) ? data.extensions.regex_scripts : [])
    .filter((s) => s && !s.disabled);
  const enabledEntries = (data.character_book?.entries || []).filter((e) => e.enabled !== false);
  // 汇总卡里模型能看到的正文（含常驻与触发条目）
  const body = [
    data.first_mes, data.mes_example, data.description, data.personality,
    data.scenario, data.system_prompt, data.post_history_instructions,
    ...enabledEntries.map((e) => e.content),
  ].filter(Boolean).join('\n');

  const mentionsVar = /<UpdateVariable/i.test(body);
  const stripsVar = scripts.some((s) => /UpdateVariable/i.test(String(s.findRegex || '')));
  const hasVarEcho = /format_message_variable/i.test(body);

  // 7a. 让模型吐变量块，却没有任何脚本接管 → 原始 JSON 会裸露在聊天里
  if (mentionsVar && !stripsVar) {
    issues.push({ severity: 'warning', title: '有 <UpdateVariable> 指令，但没有正则脚本接管', description: '模型会按要求输出变量块，却没有脚本把它从显示或回传里处理掉，原始块会裸露在聊天记录中', location: '正则脚本 / 正文', fixable: false });
  }
  // 7b. 变量回流：用了 MVU 却没有常驻条目把当前值喂回模型
  if (mentionsVar && !hasVarEcho) {
    issues.push({ severity: 'warning', title: '缺少变量回流条目（{{format_message_variable}}）', description: '模型更新了变量，但下一轮看不到面板当前值，容易把状态写丢；建议加一条常驻条目回注 stat_data', location: '世界书-常驻', fixable: false });
  }
  // 7c. 美化脚本被设成 promptOnly：HTML 只影响回传，前端看不到
  for (const s of scripts) {
    const label = s.scriptName || '(未命名脚本)';
    const repl = String(s.replaceString || '');
    if (s.promptOnly === true && s.markdownOnly !== true && HTML_TAG_RE.test(repl)) {
      issues.push({ severity: 'warning', title: `脚本「${label}」是 promptOnly，但替换内容是 HTML`, description: '当前只改回传，界面不会渲染；显示专用规则应设置 markdownOnly=true、promptOnly=false。', location: label, fixable: false });
    }
    if (!s.promptOnly && !s.markdownOnly && (HTML_TAG_RE.test(repl) || /UpdateVariable|StatusPlaceHolder/i.test(s.findRegex || ''))) {
      issues.push({ severity: 'warning', title: `脚本「${label}」可能改写聊天原文`, description: 'markdownOnly 与 promptOnly 均未启用，会改写原始消息；美化应仅 markdownOnly，隐藏提示词应仅 promptOnly。', location: label, fixable: false });
    }
  }
  // 7d. EJS 标签不配对（模板残缺会让整条注入内容坏掉）
  const ejsSites = [];
  for (const key of ['system_prompt', 'post_history_instructions', 'first_mes', 'description', 'personality']) {
    const text = String(data[key] || '');
    if (/<%/.test(text)) ejsSites.push({ site: key, text });
  }
  for (const e of enabledEntries) {
    const text = String(e.content || '');
    if (/<%/.test(text)) ejsSites.push({ site: e.name || '世界书条目', text });
  }
  for (const { site, text } of ejsSites) {
    const opens = (text.match(/<%/g) || []).length;
    const closes = (text.match(/%>/g) || []).length;
    if (opens !== closes) {
      issues.push({ severity: 'error', title: `「${site}」的 EJS 标签不配对`, description: `<% 有 ${opens} 处、%> 有 ${closes} 处；模板残缺会让注入内容出错`, location: site, fixable: false });
    }
  }

  const active = mentionsVar || hasVarEcho || ejsSites.length > 0;
  const summary = active
    ? `检测到运行时用法（变量块 ${mentionsVar ? '有' : '无'} / 回流 ${hasVarEcho ? '有' : '无'} / EJS ${ejsSites.length ? ejsSites.length + ' 处' : '无'}）${issues.length ? '，' + issues.length + ' 处问题' : '，接线完整'}`
    : '未使用 MVU / EJS 等运行时特性';
  return { key: 'runtime_wiring', name: '运行时接线', passed: errCount(issues) === 0, summary, stats: { mentionsVar, hasVarEcho, ejsSites: ejsSites.length, scripts: scripts.length }, issues };
}

// 8. EJS / 世界书脚本 API 用法（静态、只读；不执行任何模板）
// 逐站点跑 validateEjs：getwi 漏 await、const 接 getvar、activewi 位置、@@preprocessing 混用、装饰器错位。
// "标签不配对" 已由运行时接线(7d) 报错，这里跳过避免重复。
export function checkEjs(data) {
  const issues = [];
  const sites = [];
  const entries = data.character_book?.entries || [];
  const visited = new Set();
  for (const key of ['system_prompt', 'post_history_instructions', 'first_mes', 'description', 'personality', 'scenario', 'mes_example']) {
    const text = String(data[key] || '');
    if (/<%|@@\w/.test(text)) sites.push({ label: key, text });
  }
  for (const e of entries) {
    if (e.enabled === false) continue;
    const text = String(e.content || '');
    visited.add(e);
    if (/<%|@@\w/.test(text)) sites.push({ label: e.name || e.comment || '世界书条目', text });
  }
  for (const { label, text } of sites) {
    for (const it of validateEjs(text, label)) {
      if (it.title.includes('标签不配对')) continue;
      issues.push({ severity: it.severity, title: it.title, description: it.description, location: label, fixable: false });
    }
    for (const ref of findWorldbookReferences(text)) {
      if (ref.book !== null) continue; // 外部书不在本卡内，不能报为缺失。
      const matches = entries.filter(e => typeof ref.target === 'number'
        ? Number(e.id ?? e.uid) === ref.target
        : (e.name || e.comment) === ref.target);
      if (!matches.length) {
        issues.push({ severity: 'error', title: `「${label}」世界书引用失效`, description: `找不到本卡条目「${ref.target}」。请核对改名后的 getwi 引用；禁用目标仍可被加载。`, location: label, fixable: false });
      } else if (matches.length > 1) {
        issues.push({ severity: 'warning', title: `「${label}」引用的条目重名`, description: `「${ref.target}」匹配 ${matches.length} 条，建议使用唯一名称或数字 UID。`, location: label, fixable: false });
      }
      for (const entry of matches) {
        if (visited.has(entry)) continue;
        visited.add(entry);
        if (/<%|@@\w/.test(entry.content || '')) sites.push({ label: entry.name || entry.comment || '世界书条目', text: String(entry.content) });
      }
    }
  }
  if (!sites.length) return { key: 'ejs', name: 'EJS 用法', passed: true, summary: '未使用 EJS / 装饰器', stats: { sites: 0 }, issues };
  return { key: 'ejs', name: 'EJS 用法', passed: errCount(issues) === 0, summary: `${sites.length} 处 EJS/装饰器${issues.length ? '，' + issues.length + ' 处问题' : '，未见明显误用'}`, stats: { sites: sites.length }, issues };
}

// 9. 角色脚本（酒馆助手 tavern_helper）：结构完整性。只读检查，不执行脚本。
export function checkTavernScripts(data) {
  const scripts = data.extensions?.tavern_helper?.scripts || [];
  const issues = [];
  if (!Array.isArray(scripts) || !scripts.length) return { key: 'tavern_scripts', name: '角色脚本', passed: true, summary: '无角色脚本', stats: { total: 0 }, issues };
  scripts.forEach((s, i) => {
    const label = (s && s.name) ? String(s.name) : `#${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      issues.push({ severity: 'error', title: `角色脚本 #${i + 1} 结构无效`, description: '脚本条目必须是对象', location: label, fixable: false });
      return;
    }
    if (!s || !String(s.name || '').trim()) issues.push({ severity: 'error', title: `角色脚本 #${i + 1} 缺 name`, description: 'tavern_helper 脚本必须有名字，否则界面与导出都认不出它', location: label, fixable: false });
    if (s.type && s.type !== 'script') issues.push({ severity: 'warning', title: `角色脚本「${label}」type 非常规`, description: `type=${s.type}，角色脚本通常为 script`, location: label, fixable: false });
    const content = String(s.content || '');
    if (!content.trim()) { issues.push({ severity: 'error', title: `角色脚本「${label}」content 为空`, description: '空脚本随卡载入却什么都不做', location: label, fixable: false }); return; }
    if (/^\s*import\s+['"]/.test(content) && !/['"]https?:\/\/[^'"]+['"]/.test(content)) {
      issues.push({ severity: 'warning', title: `角色脚本「${label}」import 非 http(s) 地址`, description: '角色脚本的 import 应指向可访问的 https 资源，相对路径载入不到', location: label, fixable: false });
    }
    if (content.includes('registerMvuSchema')) {
      if (!/import\s*\{[^}]*registerMvuSchema[^}]*\}\s*from\s*['"]https?:/.test(content)) {
        issues.push({ severity: 'error', title: `角色脚本「${label}」用了 registerMvuSchema 却没 import 它`, description: '缺 mvu_zod 的 import，注册时会直接报错', location: label, fixable: false });
      } else if (!/registerMvuSchema\s*\(/.test(content.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?/, ''))) {
        issues.push({ severity: 'error', title: `角色脚本「${label}」import 了 registerMvuSchema 却没调用`, description: '只 import 不注册，schema 不会生效', location: label, fixable: false });
      }
    }
    if (s.button != null) {
      if (typeof s.button.enabled !== 'boolean') issues.push({ severity: 'warning', title: `角色脚本「${label}」button.enabled 非布尔`, description: 'button.enabled 应为 true/false', location: label, fixable: false });
      if (!Array.isArray(s.button.buttons)) issues.push({ severity: 'warning', title: `角色脚本「${label}」button.buttons 非数组`, description: 'buttons 应为 [{name,visible}] 数组', location: label, fixable: false });
      else s.button.buttons.forEach((b, bi) => {
        if (!b || typeof b.name !== 'string' || typeof b.visible !== 'boolean') issues.push({ severity: 'warning', title: `角色脚本「${label}」第 ${bi + 1} 个按钮结构不对`, description: '按钮应为 {name: 字符串, visible: 布尔}', location: label, fixable: false });
      });
    }
    if (!s.export_with) issues.push({ severity: 'warning', title: `角色脚本「${label}」未设 export_with`, description: '缺 export_with 时脚本可能不随卡导出，换环境就丢', location: label, fixable: false });
  });
  return { key: 'tavern_scripts', name: '角色脚本', passed: errCount(issues) === 0, summary: `${scripts.length} 个脚本${issues.length ? '，' + issues.length + ' 处问题' : '，无问题'}`, stats: { total: scripts.length }, issues };
}

// 跑全部专项
export function diagnoseCardData(data) {
  return [
    checkBasicFields(data),
    checkWorldbook(data),
    checkKeywordConflicts(data),
    checkTokenUsage(data),
    checkBagua(data),
    checkRegexScripts(data),
    checkRuntimeWiring(data),
    checkEjs(data),
    checkTavernScripts(data),
  ];
}

// CLI/GUI 入口：按卡名诊断
export function cmdDiagnose(name) {
  const dir = cardDir(name);
  if (!fs.existsSync(dir)) return { error: `卡不存在: ${name}` };
  const card = loadCard(dir);
  const checks = diagnoseCardData(card.data);
  const errors = checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === 'error').length, 0);
  const warnings = checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === 'warning').length, 0);
  const infos = checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === 'info').length, 0);
  return { name, checks, totals: { errors, warnings, infos } };
}

// ---------- CLI 入口（独立于 card.mjs，避免循环依赖）----------
const SEV = { error: '✗ 错误', warning: '! 警告', info: '· 提示' };

export function formatDiagnosis(result) {
  if (result.error) return `诊断失败: ${result.error}`;
  const t = result.totals;
  const lines = [`诊断: ${result.name}　—　错误 ${t.errors} / 警告 ${t.warnings} / 提示 ${t.infos}`];
  for (const c of result.checks) {
    lines.push('', `[${c.passed ? 'PASS' : 'FAIL'}] ${c.name} — ${c.summary}`);
    for (const i of c.issues) lines.push(`    ${SEV[i.severity] || i.severity}  ${i.title}  @${i.location}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const [name] = argv;
  if (!name || name === 'help' || name === '--help') {
    console.log('用法: node tools/diagnose.mjs <卡名>');
    console.log('  对 cards/<卡名>/src 做内容体检（基础字段/世界书/关键词/token/八股/正则/运行时接线），只读不改。');
    return 0;
  }
  const result = cmdDiagnose(name);
  console.log(formatDiagnosis(result));
  return result.error ? 2 : (result.totals.errors ? 1 : 0);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exit(main(process.argv.slice(2)));
