import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';
import { WorkbenchError } from './contracts.mjs';
import { normalizeTrainingDuration } from '../public-workbench/training-form-fields.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const sourceLimit = 1024 * 1024;
const outputLimit = 2 * 1024 * 1024;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const primitiveTypes = new Set(['string', 'number', 'boolean', 'array', 'const']);

async function readOrdinaryFile(root, parts, limit) {
  let path = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new WorkbenchError(503, '训练参数来源目录不是普通目录。');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path);
    const file = index === parts.length - 1;
    if (info.isSymbolicLink() || (file ? !info.isFile() : !info.isDirectory())) throw new WorkbenchError(503, '训练参数来源必须是普通文件和目录，不能使用链接。');
    if (file && info.size > limit) throw new WorkbenchError(503, '训练参数来源超过读取限制。');
  }
  const inside = relative(await realpath(root), await realpath(path));
  if (inside === '..' || inside.startsWith('..\\') || inside.startsWith('../') || isAbsolute(inside)) throw new WorkbenchError(503, '训练参数来源路径越界。');
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new WorkbenchError(503, '训练参数来源超过读取限制。');
  return bytes;
}

async function verifiedSources(integrationDir, schemaName) {
  const root = resolve(integrationDir);
  let manifest;
  try { manifest = JSON.parse((await readOrdinaryFile(root, ['source-manifest.json'], 4 * sourceLimit)).toString('utf8')); }
  catch (error) { throw new WorkbenchError(503, `训练参数源码清单读取失败：${error.message}`); }
  if (manifest?.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) throw new WorkbenchError(503, '训练参数源码清单无效。');
  const files = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || /[\\:\u0000-\u001f]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || files.has(file.path)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new WorkbenchError(503, '训练参数源码清单路径、哈希或重复条目无效。');
    files.set(file.path, file);
  }
  const readSource = async name => {
    const path = `mikazuki/schema/${name}.ts`;
    const file = files.get(path);
    if (!file) throw new WorkbenchError(404, `参数定义不在内置源码清单中：${name}`);
    const bytes = await readOrdinaryFile(root, ['source', ...path.split('/')], sourceLimit);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new WorkbenchError(503, `训练参数源码哈希校验失败：${path}`);
    return { source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: file.sha256 };
  };
  const [target, shared] = await Promise.all([readSource(schemaName), readSource('shared')]);
  return { target, shared };
}

// Serialized into QuickJS; this function closes over no host values or APIs.
function schemaFacade() {
  class Node {
    constructor(type, values = {}) { this.type = type; this.meta = {}; Object.assign(this, values); }
    withMeta(key, value) {
      const result = Object.assign(new Node(this.type), this);
      result.meta = { ...this.meta, [key]: value };
      return result;
    }
    default(value) { return this.withMeta('default', value); }
    description(value) { return this.withMeta('description', value); }
    required(value = true) { return this.withMeta('required', value); }
    hidden(value = true) { return this.withMeta('hidden', value); }
    disabled(value = true) { return this.withMeta('disabled', value); }
    role(value, extra) { const result = this.withMeta('role', value); return extra === undefined ? result : result.withMeta('extra', extra); }
    min(value) { return this.withMeta('min', value); }
    max(value) { return this.withMeta('max', value); }
    step(value) { return this.withMeta('step', value); }
  }
  const normalize = value => {
    if (value instanceof Node) return value;
    if (value === String) return new Node('string');
    if (value === Number) return new Node('number');
    if (value === Boolean) return new Node('boolean');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return new Node('const', { value });
    throw new Error('不支持的训练参数 Schema 值。');
  };
  return Object.freeze({
    string: () => new Node('string'), number: () => new Node('number'), boolean: () => new Node('boolean'),
    const: value => new Node('const', { value }), array: inner => new Node('array', { inner: normalize(inner) }),
    object: dict => new Node('object', { dict: Object.fromEntries(Object.entries(dict).map(([key, value]) => [key, normalize(value)])) }),
    intersect: list => new Node('intersect', { list: list.map(normalize) }),
    union: list => new Node('union', { list: list.map(normalize) }),
  });
}

async function executeInHeap({ source, shared }) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(24 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 250;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  const expression = value => value.trim().replace(/;\s*$/, '');
  let result;
  try {
    result = context.evalCode(`(() => {
      'use strict';
      const Schema = (${schemaFacade.toString()})();
      const UpdateSchema = (base, patch, removed = []) => {
        const result = { ...base, ...patch };
        for (const key of removed) delete result[key];
        return result;
      };
      const window = { __MIKAZUKI__: {
        SAMPLE_PROMPTS_DEFAULT: '(masterpiece, best quality:1.2), 1girl, solo, --n lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts,signature, watermark, username, blurry,  --w 512  --h 768  --l 7  --s 24  --d 1337',
        SAMPLE_PROMPTS_DESCRIPTION: '预览图生成参数。可填写参数或 txt 文件路径。--n 为反向提示词，--w 为宽，--h 为高，--l 为 CFG Scale，--s 为迭代步数，--d 为种子。'
      } };
      const SHARED_SCHEMAS = (${expression(shared)});
      return JSON.stringify((${expression(source)}));
    })()`, 'training-schema.js');
    if (result.error) {
      const error = context.dump(result.error);
      throw new Error(error?.message || String(error));
    }
    const json = context.getString(result.value);
    if (json.length > outputLimit) throw new Error('训练参数结构超过输出限制。');
    return JSON.parse(json);
  } finally {
    result?.error?.dispose(); result?.value?.dispose();
    context.dispose(); runtime.dispose();
  }
}

function executeIsolated(sources) {
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { trainingSchemaSandbox: true, ...sources }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(new WorkbenchError(503, `训练参数结构执行失败：${error.message}`)); else resolveResult(result);
    };
    // The worker also bounds native/WASM operations that lack interrupt points.
    const timer = setTimeout(() => finish(new Error('执行超时，隔离线程已停止。')), 2500);
    worker.once('message', message => message.error ? finish(new Error(message.error)) : finish(null, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => finish(new Error(`隔离线程提前退出（${code}）。`)));
  });
}

if (!isMainThread && workerData?.trainingSchemaSandbox) {
  executeInHeap(workerData).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message }));
}

function validateDefinition(definition) {
  let nodes = 0;
  const walk = (node, depth = 0) => {
    if (++nodes > 10000 || depth > 64 || !node || typeof node !== 'object' || Array.isArray(node)) throw new WorkbenchError(503, '训练参数结构无效或超过层级限制。');
    if (!node.meta || typeof node.meta !== 'object' || Array.isArray(node.meta)) throw new WorkbenchError(503, '训练参数元数据无效。');
    if (node.type === 'object') {
      if (!node.dict || typeof node.dict !== 'object' || Array.isArray(node.dict)) throw new WorkbenchError(503, '训练参数字段无效。');
      for (const [key, child] of Object.entries(node.dict)) {
        if (!key || key.length > 256 || forbiddenKeys.has(key)) throw new WorkbenchError(503, '训练参数字段名称无效。');
        walk(child, depth + 1);
      }
    } else if (node.type === 'intersect' || node.type === 'union') {
      if (!Array.isArray(node.list)) throw new WorkbenchError(503, '训练参数分组无效。');
      for (const child of node.list) walk(child, depth + 1);
    } else if (!primitiveTypes.has(node.type)) throw new WorkbenchError(503, '训练参数类型不受支持。');
    if (node.type === 'array') walk(node.inner, depth + 1);
  };
  walk(definition);
  if (!['object', 'intersect', 'union'].includes(definition.type)) throw new WorkbenchError(503, '训练参数定义没有表单结构。');
}

const description = meta => typeof meta?.description === 'string' ? meta.description : meta?.description?.['zh-CN'] || meta?.description?.[''];
const enumValues = node => node.type === 'union' && node.list.length && node.list.every(item => item.type === 'const') ? node.list.map(item => item.value) : undefined;
const missingDescriptions = {
  prodigy_d0: 'Prodigy 自适应学习率的初始估计值；一般保留默认值。',
  prodigy_d_coef: 'Prodigy 学习率估计的缩放系数；增大会提高自适应更新幅度。',
  conv_dim: '卷积层低秩分解的 Rank；越大可学习的容量和显存开销越高。',
  conv_alpha: '卷积层 LoRA 的缩放系数；与卷积 Rank 共同决定更新强度。',
  ddp_gradient_as_bucket_view: '让分布式梯度复用通信缓冲区，减少显存占用；仅影响分布式训练。',
  training_task: '选择文生图或图像编辑；图像编辑需要配对的目标图与参考图。',
};

function conditionsFrom(node) {
  if (node.type === 'object') return Object.entries(node.dict).filter(([, value]) => value.type === 'const' && !value.meta.hidden).map(([key, value]) => ({ key, value: value.value }));
  if (node.type === 'intersect') return node.list.flatMap(conditionsFrom);
  return [];
}

function fieldFrom(key, node, conditions) {
  const options = enumValues(node);
  if (!options && !primitiveTypes.has(node.type)) return;
  const type = options ? (options.every(value => typeof value === 'number') ? 'number' : options.every(value => typeof value === 'boolean') ? 'boolean' : 'string') : node.type;
  const field = { key, type, conditions: conditions.map(condition => ({ ...condition })) };
  const title = description(node.meta) || missingDescriptions[key];
  if (title !== undefined) field.description = title;
  for (const name of ['role', 'extra', 'required', 'hidden', 'disabled', 'min', 'max', 'step']) if (Object.hasOwn(node.meta, name)) field[name] = node.meta[name];
  if (Object.hasOwn(node.meta, 'default')) field.defaultValue = node.meta.default;
  if (node.type === 'const') field.constValue = node.value;
  if (options) field.options = options;
  if (node.type === 'array') field.itemType = node.inner.type;
  return field;
}

function buildSections(definition) {
  const sections = [];
  const collect = (node, conditions, omitted) => {
    if (node.type === 'object') return Object.entries(node.dict).flatMap(([key, child]) => {
      if (omitted.has(key)) return [];
      const field = fieldFrom(key, child, conditions);
      return field ? [field] : collect(child, conditions, omitted);
    });
    if (node.type === 'intersect') return node.list.flatMap(child => collect(child, conditions, omitted));
    if (node.type === 'union') return node.list.flatMap(branch => {
      const extra = conditionsFrom(branch);
      return collect(branch, [...conditions, ...extra], new Set([...omitted, ...extra.map(condition => condition.key)]));
    });
    return [];
  };
  const push = (title, fields, conditions) => {
    if (!fields.length && !title) return;
    // Guidance-only groups retain their predicate and never absorb later fields.
    const previous = !title && sections.findLast(section => section.fields.length && section.conditions.every(condition => conditions.some(current => current.key === condition.key && current.value === condition.value)));
    if (previous) previous.fields.push(...fields);
    else sections.push({ id: `section-${sections.length + 1}`, title: title || '高级设置', conditions: conditions.map(condition => ({ ...condition })), fields });
  };
  const visit = (node, conditions = [], omitted = new Set()) => {
    const title = description(node.meta);
    if (!title && node.type === 'intersect') for (const child of node.list) visit(child, conditions, omitted);
    else if (!title && node.type === 'union') for (const branch of node.list) {
      const extra = conditionsFrom(branch);
      visit(branch, [...conditions, ...extra], new Set([...omitted, ...extra.map(condition => condition.key)]));
    }
    else push(title, collect(node, conditions, omitted), conditions);
  };
  visit(definition);
  return sections;
}

export async function loadTrainingForm(integrationDir, schemaName) {
  if (typeof schemaName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(schemaName) || schemaName === 'shared') throw new WorkbenchError(400, '训练参数定义名称无效。');
  const { target, shared } = await verifiedSources(integrationDir, schemaName);
  const definition = await executeIsolated({ source: target.source, shared: shared.source });
  validateDefinition(definition);
  return { schemaName, sourceHash: digest(JSON.stringify([target.hash, shared.hash])), schemaHash: target.hash, sharedHash: shared.hash, sections: buildSections(definition) };
}

export function formDefaults(form, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new WorkbenchError(400, '训练参数必须是对象。');
  const result = normalizeTrainingDuration(form, config);
  const fields = form.sections.flatMap(section => section.fields);
  // Later controls may activate earlier fields; explicit user keys always win.
  for (let pass = 0; pass <= fields.length; pass++) {
    let changed = false;
    for (const field of fields) {
      if (forbiddenKeys.has(field.key) || Object.hasOwn(result, field.key) || !field.conditions.every(condition => Object.hasOwn(result, condition.key) && result[condition.key] === condition.value)) continue;
      const value = field.type === 'const' ? field.constValue : field.defaultValue;
      if (value === undefined) continue;
      result[field.key] = structuredClone(value);
      changed = true;
    }
    if (!changed) break;
  }
  return result;
}
