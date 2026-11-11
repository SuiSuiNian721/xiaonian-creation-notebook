import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, lstatSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Installations } from './installations.mjs';
import { WorkbenchError, fields } from './contracts.mjs';
import { regularLocal } from './training-dataset.mjs';
import { trainingPath } from './training-runtime.mjs';
import { normalizeTaggerOptions, taggerModelOptions } from '../public-workbench/training-tagger-options.js';

const wdFiles = ['model.onnx', 'selected_tags.csv'];
export const trainingCaptionerDescriptors = Object.freeze([
  ...taggerModelOptions.map(model => ({ id: model.value, label: model.label, format: 'tags', files: model.value === 'cl_tagger_1_01' ? ['cl_tagger_1_01/model.onnx', 'cl_tagger_1_01/tag_mapping.json'] : wdFiles, relativeDirectory: 'tagger-models/wd14/' + model.value })),
  { id: 'florence2-base', label: 'Florence-2 Base', format: 'natural', files: ['config.json', 'model.safetensors', 'preprocessor_config.json', 'tokenizer_config.json', 'tokenizer.json'], relativeDirectory: 'preprocess-models/florence2-base' },
]);
const findDescriptor = id => trainingCaptionerDescriptors.find(item => item.id === id);
const aliases = { 'wd-vit-v3': ['wd14-vit-v3'], 'wd14-moat-v2': ['wd-v1-4-moat-tagger-v2'] };
const resourceId = id => 'captioner-' + id;

function assetsReady(directory, descriptor) {
  try {
    for (const name of descriptor.files) {
      const path = join(directory, name), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1) return false;
      if (/\.json$/i.test(name)) {
        if (info.size > 32 * 1024 * 1024) return false;
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (descriptor.id === 'florence2-base' && name === 'config.json' && (value.model_type !== 'florence2' || value.image_token_id == null)) return false;
        if (name.endsWith('tag_mapping.json') && !(value.idx_to_tag && value.tag_to_category) && !Object.values(value).some(item => item && typeof item.tag === 'string' && typeof item.category === 'string')) return false;
      }
      if (name.endsWith('.csv')) {
        if (info.size > 32 * 1024 * 1024) return false;
        const header = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0].split(',');
        if (!header.includes('name') || !header.includes('category')) return false;
      }
    }
    return true;
  } catch { return false; }
}

async function hash(path, signal) {
  const digest = createHash('sha256');
  for await (const part of createReadStream(path)) { signal?.throwIfAborted(); digest.update(part); }
  return digest.digest('hex');
}

async function createLocalDirectory(path) {
  try { await regularLocal(path, true); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path); if (parent === path) throw error;
    await createLocalDirectory(parent);
    await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await regularLocal(path, true);
  }
}

export async function downloadCaptionerAssets({ descriptor, directory, pythonPath, integrationDir, downloadEndpoint, signal, report, spawnImpl = spawn, onProcess }) {
  signal.throwIfAborted();
  const requestPath = join(dirname(directory), 'request.json');
  await writeFile(requestPath, JSON.stringify({ captionerId: descriptor.id, directory, downloadEndpoint }), { encoding: 'utf8', flag: 'wx' });
  const child = spawnImpl(pythonPath, ['-s', '-B', join(integrationDir, 'prepare_captioner.py'), requestPath], { cwd: integrationDir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } });
  const hasProcess = Number.isInteger(child.pid) && child.pid > 0;
  let output = '', buffer = '', closed = false, onError, onClose, resolveClosed;
  const closedPromise = new Promise(done => { resolveClosed = done; });
  const completion = new Promise(done => {
    onError = error => { if (!hasProcess) resolveClosed(); done({ error }); };
    onClose = code => { closed = true; resolveClosed(); done({ code }); };
    child.once('error', onError); child.once('close', onClose);
  });
  const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
  child.stdout?.on('data', chunk => {
    output = (output + chunk).slice(-8000); buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop().slice(-8000);
    for (const line of lines) if (line.startsWith('CAPTIONER_PROGRESS ')) {
      try { const value = JSON.parse(line.slice(19)); if (typeof value.stage === 'string') report({ stage: value.stage.slice(0, 190) }); } catch { /* Keep nonprogress output in the error tail. */ }
    }
  });
  child.stderr?.on('data', chunk => { output = (output + chunk).slice(-8000); });
  try {
    if (signal.aborted) abort();
    if (hasProcess) onProcess?.(child.pid);
    const { code, error } = await completion;
    if (error) throw error;
    signal.throwIfAborted();
    if (code !== 0) throw new WorkbenchError(422, '打标器模型准备失败：' + output.slice(-1800));
  } catch (error) {
    if (hasProcess && !closed) child.kill();
    await closedPromise;
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    child.removeListener('error', onError); child.removeListener('close', onClose);
  }
}

class CaptionerInstallations extends Installations {
  defaultDirectory(moduleId) { return moduleId === 'training' ? this.dataDir : super.defaultDirectory(moduleId); }
}

export class TrainingCaptionerResources {
  constructor(service, { downloadImpl = downloadCaptionerAssets } = {}) {
    this.service = service; this.download = downloadImpl; this.current = null; this.preparing = false; this.closed = false;
    const memory = new Map(), source = service.store;
    this.store = {
      getSetting: key => source.getSetting?.('training.captioners.' + key) ?? memory.get(key),
      setSetting: (key, value) => { if (source.setSetting) source.setSetting('training.captioners.' + key, value); else memory.set(key, structuredClone(value)); },
      module: () => ({ ...source.module('training'), enabled: source.module('training').enabled !== false }),
    };
    const resources = trainingCaptionerDescriptors.map(item => ({ id: resourceId(item.id), name: item.label, version: 'native-assets-v1', required: false, status: 'available', sourceLabel: item.id === 'florence2-base' ? 'florence-community / Florence-2-base' : item.id === 'cl_tagger_1_01' ? 'cella110n / cl_tagger' : 'SmilingWolf', downloadBytes: null, installedBytes: null, adapterId: 'training-captioner-assets', captionerId: item.id }));
    this.installations = new CaptionerInstallations({ store: this.store, dataDir: service.directory, resourceCatalog: { training: { revision: 'captioners-v1', resources } }, installationAdapters: { 'training-captioner-assets': {
      install: context => this.install(context),
      verify: ({ resource, directory }) => assetsReady(join(directory, findDescriptor(resource.captionerId).relativeDirectory), findDescriptor(resource.captionerId)),
      verifySync: ({ resource, directory }) => assetsReady(join(directory, findDescriptor(resource.captionerId).relativeDirectory), findDescriptor(resource.captionerId)),
    } } });
  }
  assertRemovable() { if (this.preparing || this.current || this.installations.active.size) throw new WorkbenchError(409, '打标器模型正在准备或下载，请等待完成或取消后再移除实例。'); }
  async wait() { await Promise.allSettled([...this.installations.active.values()].map(job => job.promise)); }
  async state() {
    const config = this.service.config();let environment;
    try{if(config.trainerPath)environment=trainingPath(config.trainerPath,'训练环境目录');}catch{ /* Invalid paths remain uninspected; managed model files are still usable. */ }
    const items = trainingCaptionerDescriptors.map(descriptor => {
      const own = join(this.service.directory, descriptor.relativeDirectory);
      const candidates = [own];
      if (environment) {
        if (descriptor.format === 'natural') candidates.push(join(environment, descriptor.relativeDirectory));
        else for (const id of [descriptor.id, ...(aliases[descriptor.id] || [])]) candidates.push(join(environment, 'tagger-models', 'wd14', id), join(environment, 'tagger-models', id));
      }
      if (this.service.runtime.directory && this.service.runtime.directory !== this.service.directory) candidates.push(join(this.service.runtime.directory, descriptor.relativeDirectory));
      const existing = candidates.find(path => assetsReady(path, descriptor));
      return { id: descriptor.id, label: descriptor.label, format: descriptor.format, ready: Boolean(existing), modelPath: existing || own, files: [...descriptor.files], ...(existing ? {} : { reason: '尚未找到完整的本地模型文件。' }) };
    });
    const task = this.installations.state('training').task, binding = this.store.getSetting('task-binding');
    return { items, task: task ? { ...task, captionerId: binding?.taskId === task.id ? binding.captionerId : null } : null, training_started: false, tagging_started: false };
  }
  async prepare(value) {
    this.service.assertOpen(); fields(value, ['captionerId', 'downloadEndpoint']);
    const descriptor = findDescriptor(value.captionerId);
    if (!descriptor) throw new WorkbenchError(400, '未知本地打标器。');
    let endpoint;
    try { endpoint = normalizeTaggerOptions({ download_endpoint: value.downloadEndpoint ?? '默认' }).download_endpoint; } catch (error) { throw new WorkbenchError(400, error.message); }
    if (this.closed || this.preparing || this.installations.active.size) throw new WorkbenchError(409, '打标器模型准备任务尚未结束。');
    this.preparing = true; let lease, preparationDone;
    this.preparationDone = new Promise(done => { preparationDone = done; });
    try {
      const current = await this.state();
      if (current.items.find(item => item.id === descriptor.id).ready) return { ...current, alreadyReady: true };
      const selected = await this.service.runtime.configuration(this.service.config());
      lease = await this.service.runtime.acquireComponent('captioner-models');
      this.service.assertOpen(); if (this.closed) throw new WorkbenchError(409, '打标器准备正在关闭。');
      this.current = { descriptor, pythonPath: selected.pythonPath, integrationDir: lease.path, downloadEndpoint: endpoint, lease };
      const optionalIds = [resourceId(descriptor.id)], plan = this.installations.plan('training', { optionalIds });
      const result = this.installations.install('training', { optionalIds, planId: plan.planId });
      this.store.setSetting('task-binding', { taskId: result.task.id, captionerId: descriptor.id });
      const held = lease; lease = null;
      const job = this.installations.active.get('training');
      job.promise = job.promise.finally(async () => { await held.release(); this.current = null; });
      return await this.state();
    } finally { this.preparing = false; try { if (lease) await lease.release(); } finally { preparationDone(); } }
  }
  async install({ resource, directory, signal, report }) {
    const descriptor = findDescriptor(resource.captionerId), request = this.current;
    if (!request || request.descriptor.id !== descriptor.id) throw new WorkbenchError(409, '打标器下载上下文已改变。');
    await createLocalDirectory(directory);
    const staging = await mkdtemp(join(directory, '.captioner-download-')), assets = join(staging, 'assets');
    try {
      await mkdir(assets); signal.throwIfAborted();
      await this.download({ ...request, directory: assets, signal, report, onProcess: pid => request.lease.retain?.(pid) });
      signal.throwIfAborted();
      if (!assetsReady(assets, descriptor)) throw new WorkbenchError(422, '下载的打标器资源不完整或格式校验失败。');
      const files = [];
      async function collect(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const path = join(folder, entry.name), name = relative(assets, path).replaceAll('\\', '/');
          if (entry.isSymbolicLink()) throw new WorkbenchError(400, '下载资源不能包含链接。');
          if (entry.isDirectory()) await collect(path);
          else if (entry.isFile() && (descriptor.files.includes(name) || descriptor.format === 'natural' && (/\.(?:json|txt)$/.test(name) || name === 'LICENSE'))) files.push({ path, name });
        }
      }
      await collect(assets);
      const target = join(directory, descriptor.relativeDirectory);
      // Existing user files are reused only when identical; never overwrite
      // a different model while filling a partially prepared directory.
      for (const file of files) {
        signal.throwIfAborted(); const destination = join(target, file.name);
        try { await regularLocal(destination); if (await hash(destination, signal) !== await hash(file.path, signal)) throw new WorkbenchError(409, `已有模型文件内容不同，已保留原文件：${destination}`); file.exists = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const file of files) {
        signal.throwIfAborted(); if (file.exists) continue;
        const destination = join(target, file.name); await createLocalDirectory(dirname(destination));
        await copyFile(file.path, destination, constants.COPYFILE_EXCL);
      }
      signal.throwIfAborted(); report({ stage: '打标器文件已准备，正在校验' });
    } finally {
      const child = relative(resolve(directory), resolve(staging));
      if (!child || child.startsWith('..' + sep) || child === '..' || isAbsolute(child)) throw new Error('下载暂存目录越界。');
      await regularLocal(staging, true); await rm(staging, { recursive: true, force: true });
    }
  }
  async cancel(value) { this.installations.cancel('training', value); return this.state(); }
  async close() { this.closed = true; await this.preparationDone; await this.installations.close(); }
}
