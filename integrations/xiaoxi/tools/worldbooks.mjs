#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, parseYaml, dumpYaml, safeName, assertWorkspacePath, assertWorkspaceTree, filenameLabel, requireObject } from './card.mjs';

const BOOKS = path.join(ROOT, 'worldbooks');
const DIST = path.join(ROOT, 'dist', 'worldbooks');

function bookDir(name) {
  const dir = path.join(BOOKS, safeName(name));
  if (!dir.startsWith(BOOKS + path.sep)) throw new Error('非法世界书名: ' + name);
  return assertWorkspacePath(ROOT, dir);
}

function readText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function san(s) {
  return filenameLabel(s);
}

function srcHash(dir) {
  const src = path.join(dir, 'src');
  assertWorkspaceTree(ROOT, src);
  const hash = crypto.createHash('sha256');
  const walk = (rel) => {
    const abs = path.join(src, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else hash.update(r + '\0' + fs.readFileSync(path.join(src, r)) + '\0');
    }
  };
  if (fs.existsSync(src)) walk('');
  return hash.digest('hex');
}

function readState(dir) {
  const f = assertWorkspacePath(ROOT, path.join(dir, '.book', 'state.json'));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

function writeState(dir, patch) {
  fs.mkdirSync(path.join(dir, '.book'), { recursive: true });
  const s = { ...readState(dir), ...patch };
  fs.writeFileSync(path.join(dir, '.book', 'state.json'), JSON.stringify(s, null, 2) + '\n');
}

export function importWorldbook(file, name) {
  const abs = path.resolve(file);
  const target = safeName(name || path.basename(abs).replace(/\.json$/i, ''));
  const dir = bookDir(target);
  if (fs.existsSync(dir)) throw new Error('世界书已存在: ' + target + '（已拆分的不要重新导入覆盖）');
  const o = JSON.parse(fs.readFileSync(abs, 'utf8'));
  requireObject(o, '世界书');
  requireObject(o.entries, 'entries');
  for (const entry of Object.values(o.entries)) {
    requireObject(entry, '世界书条目');
    if (entry.content != null && typeof entry.content !== 'string') throw new Error('世界书 content 必须是字符串');
  }
  fs.mkdirSync(path.join(dir, 'original'), { recursive: true });
  fs.copyFileSync(abs, path.join(dir, 'original', path.basename(abs)));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'entries'), { recursive: true });
  const index = Object.create(null);
  const extra = Object.create(null);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'entries') continue;
    if (v === null || typeof v !== 'object') index[k] = v;
    else extra[k] = v;
  }
  fs.writeFileSync(path.join(src, 'index.yaml'), dumpYaml(index));
  if (Object.keys(extra).length) fs.writeFileSync(path.join(src, 'extra.json'), JSON.stringify(extra, null, 2) + '\n');
  const entries = o.entries || {};
  const used = new Set();
  Object.keys(entries).forEach((k, i) => {
    const e = entries[k];
    const label = String(i + 1).padStart(3, '0');
    let base = label + '-' + san(e.comment || (Array.isArray(e.key) ? e.key[0] : '') || e.uid || '条目');
    if (used.has(base)) base += '-' + (i + 1);
    used.add(base);
    const side = Object.create(null);
    const eextra = Object.create(null);
    for (const [ek, ev] of Object.entries(e)) {
      if (ek === 'content') continue;
      if (ek === 'extensions_json' || ek === '_key') { eextra[ek] = ev; continue; }
      if (ev === null || typeof ev !== 'object') side[ek] = ev;
      else if (Array.isArray(ev) && ev.every((x) => typeof x === 'string')) side[ek] = ev;
      else eextra[ek] = ev;
    }
    if (Object.keys(eextra).length) side.extensions_json = JSON.stringify(eextra);
    side._key = String(k);
    if ('content' in e) fs.writeFileSync(path.join(src, 'entries', base + '.md'), (e.content || '') + '\n');
    fs.writeFileSync(path.join(src, 'entries', base + '.yaml'), dumpYaml(side));
  });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: target, kind: 'world-info', createdAt: new Date().toISOString() }, null, 2) + '\n');
  writeState(dir, { createdAt: new Date().toISOString(), importedFrom: path.basename(abs) });
  return dir;
}

export function loadWorldbook(dir) {
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const index = parseYaml(readText(path.join(src, 'index.yaml')));
  const out = { ...index };
  const extraFile = path.join(src, 'extra.json');
  if (fs.existsSync(extraFile)) Object.defineProperties(out, Object.getOwnPropertyDescriptors(requireObject(JSON.parse(fs.readFileSync(extraFile, 'utf8')), 'extra.json')));
  const entries = {};
  const edir = path.join(src, 'entries');
  if (fs.existsSync(edir)) {
    let i = 0;
    for (const yml of fs.readdirSync(edir).filter((f) => f.endsWith('.yaml')).sort()) {
      const base = yml.slice(0, -5);
      const side = parseYaml(readText(path.join(edir, yml)));
      const mdPath = path.join(edir, base + '.md');
      const entry = {};
      if (fs.existsSync(mdPath)) entry.content = readText(mdPath).replace(/\r\n/g, '\n').replace(/\n$/, '');
      let key = String(i);
      for (const [k, v] of Object.entries(side)) {
        if (k === '_key') { key = String(v); continue; }
        if (k === 'extensions_json') { Object.defineProperties(entry, Object.getOwnPropertyDescriptors(requireObject(JSON.parse(v), 'extensions_json'))); continue; }
        Object.defineProperty(entry, k, { value: v, enumerable: true, configurable: true, writable: true });
      }
      if (Object.hasOwn(entries, key)) throw new Error('世界书条目 _key 重复: ' + key);
      Object.defineProperty(entries, key, { value: entry, enumerable: true, configurable: true, writable: true });
      i++;
    }
  }
  out.entries = entries;
  return out;
}

export function checkWorldbook(name) {
  const errors = [];
  const warnings = [];
  const dir = bookDir(name);
  if (!fs.existsSync(dir)) return { errors: ['世界书不存在: ' + name], warnings };
  let book;
  try {
    book = loadWorldbook(dir);
  } catch (e) {
    return { errors: ['读取失败: ' + e.message], warnings };
  }
  for (const [k, e] of Object.entries(book.entries)) {
    const label = e.comment || ('条目' + k);
    if (e.disable === true || e.enabled === false) continue;
    const keys = Array.isArray(e.key) ? e.key : [];
    if (!e.constant && keys.length === 0) warnings.push('条目无触发词且非常量: ' + label);
    if (!(e.content || '').trim()) warnings.push('条目正文为空: ' + label);
  }
  const state = readState(dir);
  if (!state.lastBuild) warnings.push('尚未 build 过');
  else if (state.lastBuild.srcHash !== srcHash(dir)) warnings.push('src 自上次 build 后有改动，需要重新 build');
  return { errors, warnings };
}

export function buildWorldbook(name) {
  const dir = bookDir(name);
  const { errors } = checkWorldbook(name);
  if (errors.length) throw new Error('check 未通过:\n- ' + errors.join('\n- '));
  const book = loadWorldbook(dir);
  assertWorkspacePath(ROOT, path.join(DIST, name + '.json'));
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, name + '.json');
  fs.writeFileSync(out, JSON.stringify(book, null, 2) + '\n');
  writeState(dir, { lastBuild: { at: new Date().toISOString(), srcHash: srcHash(dir) } });
  return out;
}

export function listWorldbooks() {
  if (!fs.existsSync(BOOKS)) return [];
  assertWorkspacePath(ROOT, BOOKS);
  return fs.readdirSync(BOOKS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .map((n) => {
      const dir = path.join(BOOKS, n);
      const row = { name: n, entries: 0, lastBuild: null, drift: true };
      let source = '项目目录';
      try {
        assertWorkspacePath(ROOT, dir);
        source = '.book/state.json';
        const state = requireObject(readState(dir), source);
        row.lastBuild = state.lastBuild?.at || null;
        source = 'src/entries/';
        const edir = assertWorkspacePath(ROOT, path.join(dir, 'src', 'entries'));
        if (fs.existsSync(edir)) row.entries = fs.readdirSync(edir).filter((f) => f.endsWith('.yaml')).length;
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
  import: (a) => importWorldbook(a[0], a[1]),
  list: () => listWorldbooks(),
  check: (a) => checkWorldbook(a[0]),
  build: (a) => buildWorldbook(a[0]),
};

function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help') {
    console.log('用法: node tools/worldbooks.mjs <import|list|check|build> [参数]');
    return 0;
  }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error('未知命令: ' + cmd); return 1; }
  const r = fn(args);
  if (cmd === 'check') {
    for (const e of r.errors) console.error('错误: ' + e);
    for (const w of r.warnings) console.warn('警告: ' + w);
    console.log(r.errors.length ? 'CHECK FAILED: ' + r.errors.length + ' 错误' : 'CHECK OK: ' + r.warnings.length + ' 警告');
    return r.errors.length ? 1 : 0;
  }
  if (cmd === 'list') {
    for (const row of r) console.log(row.name + '\t entries=' + row.entries + '\t lastBuild=' + (row.lastBuild || '无') + '\t ' + (row.drift ? '需重新build' : '已同步') + (row.warning ? '\t警告: ' + row.warning : ''));
    return 0;
  }
  console.log(cmd === 'build' ? 'BUILD OK: ' + r : 'OK: ' + r);
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exit(main(process.argv.slice(2)));
