#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, parseYaml, dumpYaml, safeName, assertWorkspacePath, assertWorkspaceTree, filenameLabel, requireObject } from './card.mjs';

const PRESETS = path.join(ROOT, 'presets');
const DIST = path.join(ROOT, 'dist', 'presets');

function presetDir(name) {
  const dir = path.join(PRESETS, safeName(name));
  if (!dir.startsWith(PRESETS + path.sep)) throw new Error('非法预设名: ' + name);
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
  const f = assertWorkspacePath(ROOT, path.join(dir, '.preset', 'state.json'));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

function writeState(dir, patch) {
  fs.mkdirSync(path.join(dir, '.preset'), { recursive: true });
  const s = { ...readState(dir), ...patch };
  fs.writeFileSync(path.join(dir, '.preset', 'state.json'), JSON.stringify(s, null, 2) + '\n');
}

export function importPreset(file, name) {
  const abs = path.resolve(file);
  const target = safeName(name || path.basename(abs).replace(/\.json$/i, ''));
  const dir = presetDir(target);
  if (fs.existsSync(dir)) throw new Error('预设已存在: ' + target + '（已拆分的不要重新导入覆盖）');
  const o = JSON.parse(fs.readFileSync(abs, 'utf8'));
  requireObject(o, '预设');
  if (!Array.isArray(o.prompts)) throw new Error('prompts 必须是数组');
  if (o.prompt_order != null && !Array.isArray(o.prompt_order)) throw new Error('prompt_order 必须是数组');
  for (const prompt of o.prompts) {
    requireObject(prompt, '提示词条目');
    if (prompt.content != null && typeof prompt.content !== 'string') throw new Error('提示词 content 必须是字符串');
  }
  fs.mkdirSync(path.join(dir, 'original'), { recursive: true });
  fs.copyFileSync(abs, path.join(dir, 'original', path.basename(abs)));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'prompts'), { recursive: true });
  const index = Object.create(null);
  const extra = Object.create(null);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'prompts' || k === 'prompt_order') continue;
    if (v === null || typeof v !== 'object') index[k] = v;
    else extra[k] = v;
  }
  fs.writeFileSync(path.join(src, 'index.yaml'), dumpYaml(index));
  if (Object.keys(extra).length) fs.writeFileSync(path.join(src, 'extra.json'), JSON.stringify(extra, null, 2) + '\n');
  const used = new Set();
  (o.prompts || []).forEach((p, i) => {
    const label = String(i + 1).padStart(3, '0');
    let base = label + '-' + san(p.name || p.identifier);
    if (used.has(base)) base += '-' + (i + 1);
    used.add(base);
    const side = Object.create(null);
    const pextra = Object.create(null);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'content') continue;
      if (k === 'extensions_json') { pextra[k] = v; continue; }
      if (v === null || typeof v !== 'object') side[k] = v;
      else pextra[k] = v;
    }
    if (Object.keys(pextra).length) side.extensions_json = JSON.stringify(pextra);
    if ('content' in p) fs.writeFileSync(path.join(src, 'prompts', base + '.md'), (p.content || '') + '\n');
    fs.writeFileSync(path.join(src, 'prompts', base + '.yaml'), dumpYaml(side));
  });
  const order = o.prompt_order || [];
  fs.writeFileSync(path.join(src, 'order.json'), JSON.stringify(order, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ name: target, kind: 'openai-chat-preset', createdAt: new Date().toISOString() }, null, 2) + '\n');
  writeState(dir, { createdAt: new Date().toISOString(), importedFrom: path.basename(abs) });
  return dir;
}

export function loadPreset(dir) {
  assertWorkspaceTree(ROOT, dir);
  const src = path.join(dir, 'src');
  const index = parseYaml(readText(path.join(src, 'index.yaml')));
  const out = { ...index };
  const extraFile = path.join(src, 'extra.json');
  if (fs.existsSync(extraFile)) Object.defineProperties(out, Object.getOwnPropertyDescriptors(requireObject(JSON.parse(fs.readFileSync(extraFile, 'utf8')), 'extra.json')));
  const prompts = [];
  const pdir = path.join(src, 'prompts');
  if (fs.existsSync(pdir)) {
    for (const yml of fs.readdirSync(pdir).filter((f) => f.endsWith('.yaml')).sort()) {
      const base = yml.slice(0, -5);
      const side = parseYaml(readText(path.join(pdir, yml)));
      const mdPath = path.join(pdir, base + '.md');
      const entry = {};
      if (fs.existsSync(mdPath)) entry.content = readText(mdPath).replace(/\r\n/g, '\n').replace(/\n$/, '');
      for (const [k, v] of Object.entries(side)) {
        if (k === 'extensions_json') { Object.defineProperties(entry, Object.getOwnPropertyDescriptors(requireObject(JSON.parse(v), 'extensions_json'))); continue; }
        Object.defineProperty(entry, k, { value: v, enumerable: true, configurable: true, writable: true });
      }
      prompts.push(entry);
    }
  }
  out.prompts = prompts;
  const orderFile = path.join(src, 'order.json');
  out.prompt_order = fs.existsSync(orderFile) ? JSON.parse(fs.readFileSync(orderFile, 'utf8')) : [];
  return out;
}

export function checkPreset(name) {
  const errors = [];
  const warnings = [];
  const dir = presetDir(name);
  if (!fs.existsSync(dir)) return { errors: ['预设不存在: ' + name], warnings };
  let preset;
  try {
    preset = loadPreset(dir);
  } catch (e) {
    return { errors: ['读取失败: ' + e.message], warnings };
  }
  const ids = new Set(preset.prompts.map((p) => p.identifier).filter(Boolean));
  if (preset.prompts.some((p) => !p.identifier)) errors.push('存在缺少 identifier 的提示词条目');
  const seenIds = new Set();
  for (const prompt of preset.prompts) {
    if (seenIds.has(prompt.identifier)) errors.push('提示词 identifier 重复: ' + prompt.identifier);
    seenIds.add(prompt.identifier);
  }
  if (!Array.isArray(preset.prompt_order)) return { errors: [...errors, 'prompt_order 必须是数组'], warnings };
  for (const group of preset.prompt_order) {
    const entries = Array.isArray(group) ? group : group?.order;
    if (!Array.isArray(entries)) { errors.push('prompt_order 分组缺少 order 数组'); continue; }
    for (const e of entries) {
      if (!e || !ids.has(e.identifier)) errors.push('prompt_order 引用了不存在的 identifier: ' + (e && e.identifier));
    }
  }
  for (const p of preset.prompts) {
    if (!(p.content || '').trim()) warnings.push('提示词正文为空: ' + (p.name || p.identifier));
  }
  const state = readState(dir);
  if (!state.lastBuild) warnings.push('尚未 build 过');
  else if (state.lastBuild.srcHash !== srcHash(dir)) warnings.push('src 自上次 build 后有改动，需要重新 build');
  return { errors, warnings };
}

export function buildPreset(name) {
  const dir = presetDir(name);
  const { errors } = checkPreset(name);
  if (errors.length) throw new Error('check 未通过:\n- ' + errors.join('\n- '));
  const preset = loadPreset(dir);
  assertWorkspacePath(ROOT, path.join(DIST, name + '.json'));
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, name + '.json');
  fs.writeFileSync(out, JSON.stringify(preset, null, 2) + '\n');
  writeState(dir, { lastBuild: { at: new Date().toISOString(), srcHash: srcHash(dir) } });
  return out;
}

export function listPresets() {
  if (!fs.existsSync(PRESETS)) return [];
  assertWorkspacePath(ROOT, PRESETS);
  return fs.readdirSync(PRESETS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .map((n) => {
      const dir = path.join(PRESETS, n);
      const row = { name: n, prompts: 0, lastBuild: null, drift: true };
      let source = '项目目录';
      try {
        assertWorkspacePath(ROOT, dir);
        source = '.preset/state.json';
        const state = requireObject(readState(dir), source);
        row.lastBuild = state.lastBuild?.at || null;
        source = 'src/prompts/';
        const pdir = assertWorkspacePath(ROOT, path.join(dir, 'src', 'prompts'));
        if (fs.existsSync(pdir)) row.prompts = fs.readdirSync(pdir).filter((f) => f.endsWith('.yaml')).length;
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
  import: (a) => importPreset(a[0], a[1]),
  list: () => listPresets(),
  check: (a) => checkPreset(a[0]),
  build: (a) => buildPreset(a[0]),
};

function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help') {
    console.log('用法: node tools/presets.mjs <import|list|check|build> [参数]');
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
    for (const row of r) console.log(row.name + '\t prompts=' + row.prompts + '\t lastBuild=' + (row.lastBuild || '无') + '\t ' + (row.drift ? '需重新build' : '已同步') + (row.warning ? '\t警告: ' + row.warning : ''));
    return 0;
  }
  console.log(cmd === 'build' ? 'BUILD OK: ' + r : 'OK: ' + r);
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) process.exit(main(process.argv.slice(2)));
