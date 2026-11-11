#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = process.env.XIAOXI_WORKSPACE_ROOT
  ? path.resolve(process.env.XIAOXI_WORKSPACE_ROOT)
  : process.env.NODE_ENV === 'test' && process.env.XIAOXI_TEST_ROOT
    ? path.resolve(process.env.XIAOXI_TEST_ROOT)
    : MODULE_ROOT;
export const CARDS = path.join(ROOT, 'cards');
export const IMPORTS = path.join(ROOT, 'imports');
export const DIST = path.join(ROOT, 'dist');

export const TEXT_FIELDS = [
  'description', 'personality', 'scenario', 'first_mes',
  'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions',
];
const INDEX_FIELDS = ['name', 'creator', 'character_version'];

// ---------- yaml 子集（平铺标量 + 字符串列表） ----------

function scalar(text) {
  const t = text.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (t === '[]') return [];
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) return JSON.parse(t);
  if (t.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(t)) throw new Error('YAML 单引号字符串未正确闭合');
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t;
}

export function parseYaml(text) {
  const out = {};
  const parseValue = (value, line) => {
    try { return scalar(value); }
    catch (error) { throw new Error(`YAML 第 ${line} 行: ${error.message}`); }
  };
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    if (/^\s/.test(line)) throw new Error(`YAML 第 ${i + 1} 行不是受支持的平铺字段或列表`);
    const m = /^("(?:\\.|[^"\\])*"|[^\s:"'{}[\],]+):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`YAML 第 ${i + 1} 行格式错误`);
    const key = m[1].startsWith('"') ? parseValue(m[1], i + 1) : m[1];
    if (Object.hasOwn(out, key)) throw new Error(`YAML 第 ${i + 1} 行字段重复: ${key}`);
    const assign = value => Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
    const rest = m[2];
    if (rest === '') {
      const list = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s?/.test(lines[j])) {
        list.push(parseValue(lines[j].replace(/^\s+-\s?/, ''), j + 1));
        j++;
      }
      assign(list.length ? list : null);
      i = j;
    } else {
      assign(parseValue(rest, i + 1));
      i++;
    }
  }
  return out;
}

function yq(value) {
  return JSON.stringify(value);
}

export function dumpYaml(obj) {
  const lines = [];
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = /^[A-Za-z0-9_.\-]+$/.test(rawKey) ? rawKey : yq(rawKey);
    if (value === null || value === undefined) { lines.push(`${key}:`); continue; }
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${key}: []`); continue; }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yq(item)}`);
      continue;
    }
    if (typeof value === 'string') { lines.push(`${key}: ${yq(value)}`); continue; }
    lines.push(`${key}: ${typeof value === 'object' ? yq(value) : value}`);
  }
  return lines.join('\n') + '\n';
}

// ---------- PNG：crc32 / chunk / chara、ccv3 tEXt ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是有效的 PNG 文件');
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) throw new Error('PNG 数据块不完整: ' + type);
    const data = Buffer.from(buf.subarray(off + 8, off + 8 + len));
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) throw new Error('PNG 数据块校验失败: ' + type);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks[0].data.length !== 13 || chunks.at(-1)?.type !== 'IEND') throw new Error('PNG 缺少完整的 IHDR/IEND 数据块');
  return chunks;
}

export function writeChunks(chunks) {
  const parts = [PNG_SIG];
  for (const { type, data } of chunks) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
    parts.push(head, data, crc);
  }
  return Buffer.concat(parts);
}

export function getPngChara(buf) {
  const payloads = new Map();
  for (const { type, data } of readChunks(buf)) {
    if (type !== 'tEXt') continue;
    const zero = data.indexOf(0);
    if (zero < 0) continue;
    const keyword = data.toString('latin1', 0, zero);
    if (keyword === 'chara' || keyword === 'ccv3') payloads.set(keyword, data.toString('latin1', zero + 1));
  }
  const b64 = payloads.get('ccv3') ?? payloads.get('chara');
  return b64 === undefined ? null : JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

export function setPngChara(buf, cardJson) {
  const b64 = Buffer.from(JSON.stringify(cardJson), 'utf8').toString('base64');
  const keyword = cardJson.spec === 'chara_card_v3' ? 'ccv3' : 'chara';
  const text = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(b64, 'latin1')]);
  const chunks = readChunks(buf).filter(({ type, data }) => {
    if (type !== 'tEXt') return true;
    const zero = data.indexOf(0);
    return !(zero >= 0 && ['chara', 'ccv3'].includes(data.toString('latin1', 0, zero)));
  });
  const iend = chunks.findIndex((c) => c.type === 'IEND');
  chunks.splice(iend < 0 ? chunks.length : iend, 0, { type: 'tEXt', data: text });
  return writeChunks(chunks);
}

export function placeholderPng(w = 512, h = 512, [r, g, b] = [46, 42, 58]) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return writeChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: zlib.deflateSync(raw, { level: 9 }) },
    { type: 'IEND', data: Buffer.alloc(0) },
  ]);
}

// ---------- 工作区读写 ----------

export function safeName(name) {
  const value = typeof name === 'string' ? name : '';
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  if (!value || value === '.' || value === '..' || /[\\/\0-\x1f<>:"|?*]/.test(value)
    || /[. ]$/.test(value) || reserved.test(value)) throw new Error(`非法卡名: ${name}`);
  return value;
}

export function cardDir(name) {
  const dir = path.join(CARDS, safeName(name));
  if (!dir.startsWith(CARDS + path.sep)) throw new Error(`非法卡名: ${name}`);
  return assertWorkspacePath(ROOT, dir);
}

// 同时检查词法边界和现有路径链，拒绝 junction / symlink 重定向。
export function assertWorkspacePath(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  const relative = path.relative(base, full);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('路径超出工作区: ' + target);
  let current = base;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('工作区路径不允许符号链接: ' + current);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}

export function assertWorkspaceTree(root, target) {
  const full = assertWorkspacePath(root, target);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return full;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('工作区路径不允许符号链接: ' + path.join(full, entry.name));
    if (entry.isDirectory()) assertWorkspaceTree(root, path.join(full, entry.name));
  }
  return full;
}

export function filenameLabel(value, fallback = '条目') {
  let label = String(value ?? '').replace(/[\\/\0-\x1f<>:"|?*]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 120);
  if (!label || label === '.' || label === '..') label = fallback;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(label)) label = '_' + label;
  return label;
}

export function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' 必须是对象');
  return value;
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function listSorted(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(filter).sort();
}

export function srcHash(dir) {
  const src = path.join(dir, 'src');
  assertWorkspaceTree(ROOT, src);
  const hash = crypto.createHash('sha256');
  const walk = (rel) => {
    const abs = path.join(src, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relNext = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(relNext);
      else hash.update(relNext + '\0' + fs.readFileSync(path.join(src, relNext)) + '\0');
    }
  };
  if (fs.existsSync(src)) walk('');
  return hash.digest('hex');
}

export function readState(dir) {
  const file = assertWorkspacePath(ROOT, path.join(dir, '.card', 'state.json'));
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function writeState(dir, patch) {
  const folder = assertWorkspacePath(ROOT, path.join(dir, '.card'));
  fs.mkdirSync(folder, { recursive: true });
  const state = { ...readState(dir), ...patch };
  fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  return state;
}

// ---------- 卡 <-> src ----------

export function loadCard(dir) {
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const index = parseYaml(readText(path.join(src, 'index.yaml')));
  const data = {};
  for (const field of INDEX_FIELDS) if (index[field] != null) data[field] = String(index[field]);
  if (Array.isArray(index.tags)) data.tags = index.tags.map(String);
  for (const field of TEXT_FIELDS) data[field] = readText(path.join(src, 'text', field + '.md')).replace(/\r\n/g, '\n').replace(/\n$/, '');
  data.alternate_greetings = listSorted(path.join(src, 'greetings'), (f) => f.endsWith('.md'))
    .map((f) => readText(path.join(src, 'greetings', f)).replace(/\r\n/g, '\n').replace(/\n$/, ''));
  const books = listSorted(path.join(src, 'worldbook'), (f) => fs.statSync(path.join(src, 'worldbook', f)).isDirectory());
  if (books.length) {
    const entries = [];
    let bookExtra = {};
    for (const book of books) {
      const bookDir = path.join(src, 'worldbook', book);
      if (book === books[0]) {
        const bookSideFile = path.join(bookDir, '_book.yaml');
        if (fs.existsSync(bookSideFile)) {
          const bookSide = parseYaml(readText(bookSideFile));
          if (bookSide.extra_json) bookExtra = requireObject(JSON.parse(bookSide.extra_json), '世界书元数据');
        }
      }
      for (const md of listSorted(bookDir, (f) => f.endsWith('.md'))) {
        const base = md.slice(0, -3);
        const side = parseYaml(readText(path.join(bookDir, base + '.yaml')));
        const extra = side.extra_json ? JSON.parse(side.extra_json) : {};
        const entry = {
          ...extra,
          keys: Array.isArray(side.keys) ? side.keys.map(String) : [],
          content: readText(path.join(bookDir, md)).replace(/\r\n/g, '\n').replace(/\n$/, ''),
          extensions: side.extensions_json ? JSON.parse(side.extensions_json) : {},
          enabled: side.enabled !== false,
          insertion_order: typeof side.insertion_order === 'number' ? side.insertion_order : 100,
        };
        for (const key of ['secondary_keys', 'constant', 'case_sensitive', 'name', 'cycle', 'position', 'use_regex', 'selective', 'vectorized']) {
          if (side[key] != null) entry[key] = Array.isArray(side[key]) ? side[key].map(String) : side[key];
        }
        entries.push(entry);
      }
    }
    data.character_book = { name: books[0], ...bookExtra, entries };
  }
  const extraFile = path.join(src, 'extra.json');
  if (fs.existsSync(extraFile)) Object.defineProperties(data, Object.getOwnPropertyDescriptors(requireObject(JSON.parse(fs.readFileSync(extraFile, 'utf8')), 'extra.json')));
  const project = JSON.parse(readText(path.join(dir, 'project.json')) || '{}');
  return {
    ...project.extra,
    spec: project.spec || 'chara_card_v2',
    spec_version: project.spec_version || (project.spec === 'chara_card_v3' ? '3.0' : '2.0'),
    data,
  };
}

export function writeSrc(dir, card, meta = {}) {
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const data = card.data || {};
  fs.mkdirSync(path.join(src, 'text'), { recursive: true });
  const index = {
    name: String(data.name || meta.name || path.basename(dir)),
    creator: data.creator != null ? String(data.creator) : '',
    character_version: data.character_version != null ? String(data.character_version) : '',
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
  };
  fs.writeFileSync(path.join(src, 'index.yaml'), dumpYaml(index));
  for (const field of TEXT_FIELDS) {
    fs.writeFileSync(path.join(src, 'text', field + '.md'), (data[field] || '') + (data[field] ? '\n' : ''));
  }
  const gdir = path.join(src, 'greetings');
  fs.mkdirSync(gdir, { recursive: true });
  (data.alternate_greetings || []).forEach((g, i) => {
    const label = String(i + 1).padStart(3, '0');
    fs.writeFileSync(path.join(gdir, `${label}-备选开场.md`), g + '\n');
  });
  if (data.character_book && Array.isArray(data.character_book.entries)) {
    const bookDir = path.join(src, 'worldbook', filenameLabel(data.character_book.name, '默认世界书'));
    fs.mkdirSync(bookDir, { recursive: true });
    const { entries: _bookEntries, ...bookExtra } = data.character_book;
    if (Object.keys(bookExtra).length) {
      fs.writeFileSync(path.join(bookDir, '_book.yaml'), dumpYaml({ extra_json: JSON.stringify(bookExtra) }));
    }
    data.character_book.entries.forEach((entry, i) => {
      const label = String(i + 1).padStart(3, '0');
      const base = `${label}-${filenameLabel(entry.name || entry.keys?.[0])}`;
      const side = {
        keys: entry.keys || [],
        secondary_keys: entry.secondary_keys || [],
        constant: entry.constant === true,
        insertion_order: entry.insertion_order ?? 100,
        enabled: entry.enabled !== false,
      };
      if (entry.name) side.name = entry.name;
      for (const key of ['case_sensitive', 'cycle', 'position', 'use_regex', 'selective', 'vectorized']) {
        if (entry[key] != null) side[key] = entry[key];
      }
      if (entry.extensions && Object.keys(entry.extensions).length) side.extensions_json = JSON.stringify(entry.extensions);
      const knownEntryFields = new Set([
        'keys', 'content', 'extensions', 'enabled', 'insertion_order', 'secondary_keys',
        'constant', 'case_sensitive', 'name', 'cycle', 'position', 'use_regex',
        'selective', 'vectorized',
      ]);
      const entryExtra = Object.create(null);
      for (const [key, value] of Object.entries(entry)) {
        if (!knownEntryFields.has(key)) entryExtra[key] = value;
      }
      if (Object.keys(entryExtra).length) side.extra_json = JSON.stringify(entryExtra);
      fs.writeFileSync(path.join(bookDir, base + '.md'), (entry.content || '') + '\n');
      fs.writeFileSync(path.join(bookDir, base + '.yaml'), dumpYaml(side));
    });
  }
  const known = new Set([...TEXT_FIELDS, ...INDEX_FIELDS, 'tags', 'alternate_greetings', 'character_book']);
  const extra = Object.create(null);
  for (const [key, value] of Object.entries(data)) if (!known.has(key)) extra[key] = value;
  if (Object.keys(extra).length) fs.writeFileSync(path.join(src, 'extra.json'), JSON.stringify(extra, null, 2) + '\n');
}

// ---------- 命令 ----------

export function cmdNew(name, { from } = {}) {
  const dir = cardDir(name);
  if (fs.existsSync(dir)) throw new Error(`卡已存在: ${name}`);
  let description = '';
  if (from) {
    const tpl = assertWorkspacePath(path.join(ROOT, 'templates'), path.resolve(ROOT, 'templates', from));
    if (!fs.existsSync(tpl)) throw new Error(`模板不存在: ${from}`);
    description = fs.readFileSync(tpl, 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'src', 'text'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'original'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name, spec: 'chara_card_v2', createdAt: new Date().toISOString() }, null, 2) + '\n');
  writeState(dir, { createdAt: new Date().toISOString() });
  fs.writeFileSync(path.join(dir, 'src', 'index.yaml'), dumpYaml({ name, creator: '', character_version: '1.0', tags: [] }));
  for (const field of TEXT_FIELDS) fs.writeFileSync(path.join(dir, 'src', 'text', field + '.md'), field === 'description' ? description : '');
  return dir;
}

export function cmdImport(file, name) {
  const abs = path.resolve(file);
  const target = safeName(name || path.basename(abs).replace(/\.(png|json)$/i, ''));
  const dir = cardDir(target);
  if (fs.existsSync(dir)) throw new Error(`卡已存在: ${target}（已拆分的卡不要重新导入覆盖）`);
  const buf = fs.readFileSync(abs);
  let card;
  if (abs.toLowerCase().endsWith('.png')) {
    card = getPngChara(buf);
    if (!card) throw new Error('PNG 中未找到 chara / ccv3 块，不是可导入的角色卡 PNG');
  } else {
    card = JSON.parse(buf.toString('utf8'));
  }
  requireObject(card, '角色卡');
  requireObject(card.data, '角色卡 data');
  for (const field of [...TEXT_FIELDS, ...INDEX_FIELDS]) if (card.data[field] != null && typeof card.data[field] !== 'string') throw new Error(field + ' 必须是字符串');
  if (card.data.alternate_greetings != null && (!Array.isArray(card.data.alternate_greetings) || card.data.alternate_greetings.some(g => typeof g !== 'string'))) throw new Error('alternate_greetings 必须是字符串数组');
  if (card.data.character_book != null) {
    const book = requireObject(card.data.character_book, 'character_book');
    if (!Array.isArray(book.entries)) throw new Error('character_book.entries 必须是数组');
    for (const entry of book.entries) {
      requireObject(entry, '世界书条目');
      if (entry.content != null && typeof entry.content !== 'string') throw new Error('世界书 content 必须是字符串');
    }
  }
  assertWorkspaceTree(ROOT, path.join(IMPORTS, target));
  fs.mkdirSync(path.join(dir, 'original'), { recursive: true });
  fs.copyFileSync(abs, path.join(dir, 'original', path.basename(abs)));
  fs.mkdirSync(path.join(IMPORTS, target), { recursive: true });
  fs.copyFileSync(abs, path.join(IMPORTS, target, path.basename(abs)));
  const { data: _data, spec, spec_version, ...extra } = card;
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: target, spec: spec || 'chara_card_v2', spec_version, extra, createdAt: new Date().toISOString() }, null, 2) + '\n');
  writeSrc(dir, card, { name: target });
  writeState(dir, { createdAt: new Date().toISOString(), importedFrom: path.basename(abs), importedAt: new Date().toISOString() });
  return dir;
}

export function cmdCheck(name) {
  const errors = [];
  const warnings = [];
  const dir = cardDir(name);
  if (!fs.existsSync(dir)) return { errors: [`卡不存在: ${name}`], warnings };
  const src = path.join(dir, 'src');
  if (!fs.existsSync(path.join(dir, 'project.json'))) errors.push('缺少 project.json');
  if (!fs.existsSync(path.join(src, 'index.yaml'))) errors.push('缺少 src/index.yaml');
  let card;
  try { card = loadCard(dir); } catch (error) { return { errors: [...errors, '读取失败: ' + error.message], warnings }; }
  for (const field of [...INDEX_FIELDS, ...TEXT_FIELDS]) {
    if (card.data[field] != null && typeof card.data[field] !== 'string') errors.push(field + ' 必须是字符串');
  }
  if (!String(card.data.name || '').trim()) errors.push('index.yaml: name 为空');
  if (!String(card.data.description || '').trim()) errors.push('src/text/description.md 为空（角色描述是必填）');
  if (!String(card.data.first_mes || '').trim()) errors.push('src/text/first_mes.md 为空（开场白是必填）');
  for (const field of ['personality', 'scenario', 'mes_example']) {
    if (!card.data[field]) warnings.push(`src/text/${field}.md 为空`);
  }
  const bookDir = path.join(src, 'worldbook');
  if (fs.existsSync(bookDir)) {
    for (const book of fs.readdirSync(bookDir)) {
      const bd = path.join(bookDir, book);
      if (!fs.statSync(bd).isDirectory()) continue;
      for (const md of fs.readdirSync(bd).filter((f) => f.endsWith('.md'))) {
        const base = md.slice(0, -3);
        const sideFile = path.join(bd, base + '.yaml');
        if (!fs.existsSync(sideFile)) { errors.push(`世界书条目缺少侧车: ${book}/${base}.yaml`); continue; }
        let side;
        try { side = parseYaml(fs.readFileSync(sideFile, 'utf8')); } catch (e) { errors.push(`侧车 YAML 解析失败: ${book}/${base}.yaml (${e.message})`); continue; }
        for (const field of ['enabled', 'constant', 'case_sensitive', 'use_regex', 'selective', 'vectorized']) {
          if (side[field] != null && typeof side[field] !== 'boolean') errors.push(`世界书 ${book}/${base}: ${field} 必须是布尔值`);
        }
        for (const field of ['keys', 'secondary_keys']) {
          if (side[field] != null && (!Array.isArray(side[field]) || side[field].some(key => typeof key !== 'string' || !key.trim()))) errors.push(`世界书 ${book}/${base}: ${field} 必须是非空字符串数组`);
        }
        if (side.insertion_order != null && !Number.isFinite(side.insertion_order)) errors.push(`世界书 ${book}/${base}: insertion_order 必须是有限数字`);
        if (side.enabled === false) continue;
        if (side.constant !== true && !(Array.isArray(side.keys) && side.keys.some(key => typeof key === 'string' && key.trim()))) errors.push(`世界书条目无触发词且非 constant: ${book}/${base}`);
        if (!readText(path.join(bd, md)).trim()) warnings.push(`世界书条目正文为空: ${book}/${base}`);
      }
    }
  }
  const gdir = path.join(src, 'greetings');
  for (const g of listSorted(gdir, (f) => f.endsWith('.md'))) {
    if (!readText(path.join(gdir, g)).trim()) warnings.push(`备选开场为空: ${g}`);
  }
  const state = readState(dir);
  if (state.lastBuild) {
    if (state.lastBuild.srcHash !== srcHash(dir)) warnings.push('src 自上次 build 后有改动，需要重新 build');
  } else {
    warnings.push('尚未 build 过');
  }
  if (!listSorted(path.join(dir, 'original'), () => true).length) warnings.push('无头像原图，build 将使用占位图');
  return { errors, warnings };
}

export function cmdBuild(name) {
  const dir = cardDir(name);
  const { errors } = cmdCheck(name);
  if (errors.length) throw new Error('check 未通过:\n- ' + errors.join('\n- '));
  const card = loadCard(dir);
  assertWorkspaceTree(ROOT, path.join(DIST, name));
  const originals = listSorted(path.join(dir, 'original'), (f) => f.toLowerCase().endsWith('.png'));
  const base = originals.length ? fs.readFileSync(path.join(dir, 'original', originals[0])) : placeholderPng();
  const png = setPngChara(base, card);
  const hash = srcHash(dir);
  fs.mkdirSync(path.join(DIST, name), { recursive: true });
  fs.writeFileSync(path.join(DIST, name, 'card.json'), JSON.stringify(card, null, 2) + '\n');
  fs.writeFileSync(path.join(DIST, name, 'card.png'), png);
  writeState(dir, { lastBuild: { at: new Date().toISOString(), srcHash: hash } });
  return path.join(DIST, name);
}

export function cmdList() {
  if (!fs.existsSync(CARDS)) return [];
  assertWorkspacePath(ROOT, CARDS);
  return fs.readdirSync(CARDS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .map((n) => {
      const dir = path.join(CARDS, n);
      const row = { name: n, spec: '?', lastBuild: null, drift: true };
      let source = '项目目录';
      try {
        assertWorkspacePath(ROOT, dir);
        source = '.card/state.json';
        const state = requireObject(readState(dir), source);
        source = 'project.json';
        const projectFile = assertWorkspacePath(ROOT, path.join(dir, 'project.json'));
        const project = fs.existsSync(projectFile) ? requireObject(JSON.parse(fs.readFileSync(projectFile, 'utf8')), source) : {};
        row.spec = project.spec || '?';
        row.lastBuild = state.lastBuild?.at || null;
        source = 'src/';
        row.drift = state.lastBuild ? state.lastBuild.srcHash !== srcHash(dir) : true;
      } catch (error) {
        row.warning = `读取失败（${source}）: ${error.message}`;
        row.drift = true;
      }
      return row;
    });
}

const COMMANDS = {
  new: (args) => cmdNew(args[0], { from: args[1] === '--from' ? args[2] : undefined }),
  import: (args) => cmdImport(args[0], args[1]),
  check: (args) => cmdCheck(args[0]),
  build: (args) => cmdBuild(args[0]),
  list: () => cmdList(),
};

function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help') {
    console.log('用法: node tools/card.mjs <new|import|check|build|list> [参数]');
    console.log('  new <卡名> [--from 模板文件]   新建卡项目');
    console.log('  import <png|json> [卡名]       导入并拆分到 src/');
    console.log('  check <卡名>                   校验 src/');
    console.log('  build <卡名>                   打包到 dist/（JSON + PNG）');
    console.log('  list                           列出所有卡');
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`未知命令: ${cmd}`); return 1; }
  const result = fn(args);
  if (cmd === 'check') {
    for (const e of result.errors) console.error('错误: ' + e);
    for (const w of result.warnings) console.warn('警告: ' + w);
    console.log(result.errors.length ? `CHECK FAILED: ${result.errors.length} 错误` : `CHECK OK: ${result.warnings.length} 警告`);
    return result.errors.length ? 1 : 0;
  }
  if (cmd === 'list') {
    for (const row of result) console.log(`${row.name}\t${row.spec}\tlastBuild=${row.lastBuild || '无'}\t${row.drift ? '需重新build' : '已同步'}${row.warning ? '\t警告: ' + row.warning : ''}`);
    return 0;
  }
  console.log(cmd === 'build' ? `BUILD OK: ${result}` : `OK: ${result}`);
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exit(main(process.argv.slice(2)));
