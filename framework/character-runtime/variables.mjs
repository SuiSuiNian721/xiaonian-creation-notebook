import { parse as parseYaml } from 'yaml';
import JSON5 from 'json5';
import { isDeepStrictEqual } from 'node:util';
import { record } from './card.mjs';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function validateVariables(value, depth = 0) {
  if (depth > 60) throw new Error('变量嵌套超过限制。');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('变量数值必须有限。');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error('变量包含禁止的原型字段。');
    validateVariables(child, depth + 1);
  }
  return value;
}

export function parseInitialVariables(source) {
  const input = String(source).replace(/^```(?:yaml|json|json5)?\s*\n|\n```\s*$/g, '');
  let value;
  if (input.trim().startsWith('{')) { try { value = JSON5.parse(input); } catch {} }
  if (value === undefined) value = parseYaml(input, { maxAliasCount: 20 });
  if (!record(value)) throw new Error('初始变量必须是 JSON/YAML 对象。');
  return validateVariables(Object.hasOwn(value, 'stat_data') ? value : { stat_data: value });
}

export function mergeDefaults(defaults, existing) {
  const out = structuredClone(defaults);
  for (const [key, value] of Object.entries(existing ?? {})) out[key] = record(value) && record(out[key]) ? mergeDefaults(out[key], value) : structuredClone(value);
  return validateVariables(out);
}

function segments(pointer) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) throw new Error('JSONPatch 路径必须是 JSON Pointer。');
  const keys = pointer === '' ? [] : pointer.slice(1).split('/').map(key => {
    if (/~(?![01])/.test(key)) throw new Error('JSON Pointer 转义无效。');
    return key.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  if (keys.some(key => forbidden.has(key))) throw new Error('变量路径包含禁止的原型字段。');
  return keys;
}

function locate(root, keys, allowMissing = false) {
  let parent = root;
  for (const key of keys.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('变量路径不存在：/' + keys.join('/'));
    parent = parent[key];
  }
  const key = keys.at(-1);
  if (!parent || typeof parent !== 'object' || (!allowMissing && !Object.hasOwn(parent, key))) throw new Error('变量路径不存在：/' + keys.join('/'));
  if (Array.isArray(parent) && key !== '-' && !/^(?:0|[1-9]\d*)$/.test(key)) throw new Error('数组索引无效。');
  return { parent, key };
}

function canonical(root, pointer) {
  const keys = segments(pointer);
  if (keys.length && record(root.stat_data) && keys[0] !== 'stat_data' && !Object.hasOwn(root, keys[0])) keys.unshift('stat_data');
  return keys;
}

export function applyVariablePatch(variables, operations) {
  if (!Array.isArray(operations) || operations.length > 500) throw new Error('JSONPatch 必须是最多 500 项的数组。');
  let root = validateVariables(structuredClone(variables ?? {}));
  const read = keys => keys.length ? (() => { const { parent, key } = locate(root, keys); return parent[key]; })() : root;
  const remove = keys => { if (!keys.length) { root = {}; return; } const { parent, key } = locate(root, keys); if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; };
  const put = (keys, value, mode) => {
    validateVariables(value);
    if (!keys.length) { if (!record(value)) throw new Error('变量根必须保持对象。'); root = structuredClone(value); return; }
    const { parent, key } = locate(root, keys, mode === 'add');
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key);
      if (index > parent.length || (mode === 'replace' && index === parent.length)) throw new Error('数组索引越界。');
      if (mode === 'add') parent.splice(index, 0, structuredClone(value)); else parent[index] = structuredClone(value);
    } else parent[key] = structuredClone(value);
  };
  for (const operation of operations) {
    if (!record(operation)) throw new Error('JSONPatch 项必须是对象。');
    const keys = canonical(root, operation.path);
    switch (operation.op) {
      case 'add': case 'insert': put(keys, operation.value, 'add'); break;
      case 'replace': put(keys, operation.value, 'replace'); break;
      case 'remove': remove(keys); break;
      case 'delta': {
        const current = read(keys);
        if (typeof current !== 'number' || typeof operation.value !== 'number') throw new Error('delta 仅适用于数值。');
        put(keys, current + operation.value, 'replace'); break;
      }
      case 'copy': case 'move': {
        const from = canonical(root, operation.from), value = structuredClone(read(from));
        if (operation.op === 'move') {
          if (from.every((key, i) => key === keys[i]) && keys.length > from.length) throw new Error('不能将父节点移入自身。');
          remove(from);
        }
        put(keys, value, 'add'); break;
      }
      case 'test': if (!isDeepStrictEqual(read(keys), operation.value)) throw new Error('JSONPatch test 不匹配。'); break;
      default: throw new Error('不支持的 JSONPatch 操作：' + operation.op);
    }
  }
  return validateVariables(root);
}

// Parse data literals only. MVU command text is never evaluated as JavaScript.
function readArguments(source) {
  let i = 0;
  const space = () => { while (/\s/.test(source[i] ?? '') && i < source.length) i++; };
  function value() {
    space(); const char = source[i];
    if (char === '"' || char === "'") {
      const quote = source[i++]; let out = '';
      while (i < source.length) {
        const c = source[i++];
        if (c === quote) return out;
        if (c !== '\\') { out += c; continue; }
        const escaped = source[i++];
        if (escaped === 'u') { const code = source.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error('MVU 字符串转义错误。'); out += String.fromCharCode(parseInt(code, 16)); i += 4; }
        else { const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' }; if (!(escaped in escapes)) throw new Error('MVU 字符串转义错误。'); out += escapes[escaped]; }
      }
      throw new Error('MVU 字符串未闭合。');
    }
    if (char === '[' || char === '{') {
      const array = char === '[', close = array ? ']' : '}'; i++; space(); const out = array ? [] : {};
      while (source[i] !== close) {
        if (array) out.push(value());
        else { const key = value(); if (typeof key !== 'string' || forbidden.has(key)) throw new Error('MVU 对象键无效。'); space(); if (source[i++] !== ':') throw new Error('MVU 对象格式错误。'); out[key] = value(); }
        space(); if (source[i] !== ',') break; i++; space();
      }
      if (source[i++] !== close) throw new Error('MVU 数据未闭合。'); return out;
    }
    const literal = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(source.slice(i));
    if (!literal) throw new Error('MVU 只允许字符串、数字、对象、数组和布尔字面量。');
    i += literal[0].length; return JSON.parse(literal[0]);
  }
  const args = [];
  while (i < source.length) { args.push(value()); space(); if (i === source.length) break; if (source[i++] !== ',') throw new Error('MVU 参数格式错误。'); }
  return args;
}

function parseNativeCommands(source) {
  const commands = []; let i = 0;
  while (i < source.length) {
    const whitespace = /^(?:\s|;|\/\/[^\n]*(?:\n|$))*/.exec(source.slice(i))[0]; i += whitespace.length;
    if (i >= source.length) break;
    const command = /^_\.(set|add|insert|remove|unset|delete)\s*\(/.exec(source.slice(i));
    if (!command || commands.length >= 500) throw new Error('MVU 原生命令格式不支持；仅接受 _.set/add/insert/remove/unset/delete。');
    const commandStart = i; i += command[0].length; const start = i; let quote = '', depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (quote) { if (c === '\\') { i += 2; continue; } if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if ('[{'.includes(c)) depth++;
      else if (']}'.includes(c)) depth--;
      else if (c === ')' && depth === 0) break;
      i++;
    }
    if (i >= source.length) throw new Error('MVU 命令未闭合。');
    const args = readArguments(source.slice(start, i++)), name = command[1];
    if (typeof args[0] !== 'string') throw new Error('MVU 首参数必须是点路径。');
    validateVariables(args);
    commands.push({ type: ['remove', 'unset'].includes(name) ? 'delete' : name, full_match: source.slice(commandStart, i), args: args.map((value, index) => index ? JSON.stringify(value) : value), reason: '' });
  }
  return commands;
}

function literal(source) {
  if (typeof source !== 'string') throw new Error('MVU 命令参数必须是数据字面量字符串。');
  const values = readArguments(source);
  if (values.length !== 1) throw new Error('MVU 命令参数必须是单个数据字面量。');
  return values[0];
}

function applyParsedNativeCommands(variables, commands) {
  let root = validateVariables(structuredClone(variables ?? {}));
  for (const command of commands) {
    if (!record(command) || !['set', 'add', 'insert', 'delete'].includes(command.type) || !Array.isArray(command.args) || typeof command.args[0] !== 'string') throw new Error('MVU 命令结构无效。');
    const args = command.args.map((value, index) => index ? literal(value) : value), name = command.type;
    const parts = args[0].replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    const pointer = keys => '/' + keys.map(key => String(key).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
    let path = pointer(parts), op, value, displayChange;
    if (name === 'set') {
      if (args.length < 2 || args.length > 4) throw new Error('_.set 参数数量错误。');
      value = args.length >= 3 ? args[2] : args[1];
      const keys = canonical(root, path); let parent = root;
      for (let n = 0; n < keys.length - 1; n++) {
        const key = keys[n];
        if (!Object.hasOwn(parent, key)) parent[key] = /^\d+$/.test(keys[n + 1]) ? [] : {};
        if (!parent[key] || typeof parent[key] !== 'object') throw new Error('MVU 路径的父节点不是对象。');
        parent = parent[key];
      }
      const current = parent[keys.at(-1)];
      if (Array.isArray(current) && current.length === 2 && typeof current[1] === 'string' && !Array.isArray(value)) {
        displayChange = { path: keys.slice(keys[0] === 'stat_data' ? 1 : 0), old: current[0], value };
        path += '/0'; op = 'replace';
      } else op = Object.hasOwn(parent, keys.at(-1)) ? 'replace' : 'add';
    }
    else if (name === 'add') {
      op = 'delta'; value = args[1]; const keys = canonical(root, path), { parent, key } = locate(root, keys), current = parent[key];
      if (Array.isArray(current) && current.length === 2 && typeof current[1] === 'string') { path += '/0'; displayChange = { path: keys.slice(keys[0] === 'stat_data' ? 1 : 0), old: current[0], value: current[0] + value }; }
    }
    else if (name === 'insert') { op = 'insert'; if (args.length >= 3) { path = pointer([...parts, args[1]]); value = args[2]; } else { path += '/-'; value = args[1]; } }
    else { op = 'remove'; if (args.length > 1) path = pointer([...parts, args[1]]); }
    root = applyVariablePatch(root, [{ op, path, value }]);
    if (displayChange) {
      root.display_data ??= {}; let target = root.display_data;
      for (const key of displayChange.path.slice(0, -1)) { if (!record(target[key])) target[key] = {}; target = target[key]; }
      target[displayChange.path.at(-1)] = `${displayChange.old} → ${displayChange.value}`;
    }
  }
  return root;
}

export function applyNativeCommands(variables, source) {
  return applyParsedNativeCommands(variables, parseNativeCommands(source));
}

const patchTypes = { add: 'set', replace: 'set', delta: 'add', insert: 'insert', remove: 'delete', move: 'move', copy: 'copy', test: 'test' };
function patchCommand(operation) {
  if (!record(operation) || !Object.hasOwn(patchTypes, operation.op)) throw new Error('不支持的 JSONPatch 操作：' + operation?.op);
  const args = ['move', 'copy'].includes(operation.op) ? [operation.from, operation.path] : operation.op === 'remove' ? [operation.path] : [operation.path, JSON.stringify(operation.value)];
  return { ...operation, type: patchTypes[operation.op], full_match: JSON.stringify(operation), args, reason: operation.reason ?? '' };
}

// Preparation never applies a command; callbacks may inspect and repair it first.
export function prepareVariableBlocks(text, { dialect = 'auto' } = {}) {
  const groups = [], trace = [], commands = [];
  const pattern = /<UpdateVariable\b[^>]*>([\s\S]*?)(?:<\/UpdateVariable\s*>|$)|<JSONPatch\b[^>]*>([\s\S]*?)(?:<\/JSONPatch\s*>|$)|<initvar\b[^>]*>([\s\S]*?)(?:<\/initvar\s*>|$)/gi;
  const output = String(text).replace(pattern, (block, update, patch, init) => {
    try {
      const closing = update !== undefined ? /<\/UpdateVariable\s*>$/i : patch !== undefined ? /<\/JSONPatch\s*>$/i : /<\/initvar\s*>$/i;
      if (!closing.test(block)) throw new Error('变量块未闭合，已隐藏且未应用。');
      if (init !== undefined) { groups.push({ kind: 'init', value: parseInitialVariables(init) }); return ''; }
      const json = patch ?? /<JSONPatch\b[^>]*>([\s\S]*?)<\/JSONPatch\s*>/i.exec(update ?? '')?.[1];
      let parsed, kind;
      if (json !== undefined) {
        if (dialect === 'native') throw new Error('当前方言只允许 MVU 原生命令。');
        const operations = JSON.parse(json.replace(/^\s*```(?:json)?|```\s*$/g, '').trim());
        if (!Array.isArray(operations) || operations.length > 500) throw new Error('JSONPatch 必须是最多 500 项的数组。');
        validateVariables(operations);
        if (dialect === 'rfc6902' && operations.some(op => ['delta', 'insert'].includes(op.op))) throw new Error('RFC 6902 不包含 delta/insert。');
        parsed = operations.map(patchCommand); kind = 'patch';
      } else {
        if (!['auto', 'native', 'mvu'].includes(dialect)) throw new Error('当前方言不允许 MVU 原生命令。');
        parsed = parseNativeCommands(String(update).replace(/<Analysis>[\s\S]*?<\/Analysis>/gi, '').replace(/^\s*```(?:javascript|js)?|```\s*$/g, '').trim()); kind = 'native';
      }
      if (commands.length + parsed.length > 500) throw new Error('变量命令总数超过 500 项。');
      const group = groups.length; groups.push({ kind, dialect: kind === 'native' ? 'native' : parsed.some(command => ['delta', 'insert'].includes(command.op)) ? 'mvu-jsonpatch' : 'rfc6902' });
      commands.push(...parsed.map(command => ({ group, command })));
    } catch (error) { trace.push({ type: 'variables', error: error.message }); }
    return '';
  });
  return { text: output.trim(), groups, commands, trace, dialect };
}

function commandOperation(command, original) {
  if (!original && record(command) && command.op && !command.args) return { op: command.op, path: command.path, from: command.from, value: command.value };
  if (original && isDeepStrictEqual(command.args, original.args) && command.type === original.type) return { op: command.op, path: command.path, from: command.from, value: command.value };
  if (!Array.isArray(command.args) || typeof command.args[0] !== 'string') throw new Error('变量命令参数无效。');
  const op = original?.type === command.type ? original.op : { set: 'replace', add: 'delta', insert: 'insert', delete: 'remove', move: 'move', copy: 'copy', test: 'test' }[command.type];
  if (['move', 'copy'].includes(op)) return { op, from: command.args[0], path: command.args[1] };
  return { op, path: command.args[0], ...(op === 'remove' ? {} : { value: literal(command.args.at(-1)) }) };
}

export function applyPreparedVariableBlocks(variables, prepared, entries) {
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('变量命令总数超过 500 项。');
  let current = validateVariables(structuredClone(variables ?? {})); const trace = [...prepared.trace];
  const groups = [...prepared.groups, { kind: 'extra' }];
  for (const [index, group] of groups.entries()) {
    try {
      const selected = entries.filter(entry => (Number.isInteger(entry.group) ? entry.group : groups.length - 1) === index);
      if (group.kind === 'init') { current = mergeDefaults(group.value, current); continue; }
      let candidate = structuredClone(current);
      for (const entry of selected) {
        const command = entry.command;
        if (group.kind === 'patch' || group.kind === 'extra' && command.op) {
          const operation = commandOperation(command, entry.original);
          if (prepared.dialect === 'native' || prepared.dialect === 'rfc6902' && ['delta', 'insert'].includes(operation.op)) throw new Error('变量命令不符合当前方言。');
          candidate = applyVariablePatch(candidate, [operation]);
        } else {
          if (!['auto', 'native', 'mvu'].includes(prepared.dialect)) throw new Error('当前方言不允许 MVU 原生命令。');
          candidate = applyParsedNativeCommands(candidate, [command]);
        }
      }
      current = candidate;
      if (selected.length) trace.push({ type: 'variables', dialect: group.dialect ?? 'mixed', operations: selected.length });
    } catch (error) { trace.push({ type: 'variables', error: error.message }); }
  }
  return { variables: current, trace };
}

export function processVariableBlocks(text, variables, { dialect = 'auto' } = {}) {
  const prepared = prepareVariableBlocks(text, { dialect });
  const applied = applyPreparedVariableBlocks(variables, prepared, prepared.commands.map(entry => ({ ...entry, original: entry.command })));
  return { text: prepared.text, ...applied };
}
