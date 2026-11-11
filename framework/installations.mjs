import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { WorkbenchError, fields, identifier } from './contracts.mjs';
import { moduleDefinitions } from './registry.mjs';
import { resourceCatalog as productionCatalog } from './resource-catalog.mjs';

const activeStatuses = new Set(['queued', 'running']);
const settingKey = moduleId => `module.resources.${moduleId}`;
const timestamp = () => new Date().toISOString();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const size = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const total = (resources, key) => resources.some(resource => resource[key] === null) ? null
  : size(resources.reduce((sum, resource) => sum + resource[key], 0));
const sameDirectory = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

export class Installations {
  // 清单和适配器仅由本地启动代码注入，不经 HTTP 接受可执行代码。
  // 适配器须响应 signal；install 完成后 verify 必须返回 true 才写入已验证记录。
  constructor({ store, dataDir, resourceCatalog = {}, installationAdapters = {}, chooseDirectory, sharedStore, sharedDirectory, sharedLocks }) {
    this.store = store;
    this.dataDir = dataDir;
    this.sharedStore=sharedStore;this.sharedDirectory=sharedDirectory;this.sharedLocks=sharedLocks??new Map();
    this.catalog = resourceCatalog;
    this.adapters = installationAdapters;
    this.openDirectoryDialog = chooseDirectory;
    this.choosingModule = null;
    this.active = new Map();
    this.planSalt = randomUUID();
    this.closing = false;
    for (const { id } of moduleDefinitions) {
      const saved = this.saved(id);
      if (activeStatuses.has(saved.task?.status)) {
        saved.task = { ...saved.task, status: 'interrupted', stage: '安装已中断，请重新查看清单', currentResourceId: null, at: timestamp() };
        this.save(id, saved);
      }
    }
  }

  saved(moduleId) {
    return this.store.getSetting(settingKey(moduleId)) ?? { optionalIds: [], selectionRevision: 0, installed: {}, task: null };
  }

  save(moduleId, value) {
    this.store.setSetting(settingKey(moduleId), value);
    if(this.sharedStore&&Object.keys(value.installed||{}).length){const shared=this.sharedStore.getSetting(settingKey(moduleId))??{optionalIds:[],selectionRevision:0,installed:{},task:null};this.sharedStore.setSetting(settingKey(moduleId),{...shared,installed:{...shared.installed,...value.installed}});}
  }

  definition(moduleId) { return structuredClone(Object.hasOwn(this.catalog, moduleId) ? this.catalog[moduleId] : productionCatalog[moduleId]); }

  defaultDirectory(moduleId) { return join(this.sharedDirectory||this.dataDir, 'resources', moduleId); }

  directory(moduleId) { return this.saved(moduleId).directory || this.sharedStore?.getSetting(settingKey(moduleId))?.directory || this.defaultDirectory(moduleId); }

  async chooseDirectory(moduleId, input) {
    fields(input, []);
    if (this.closing) throw new WorkbenchError(409, '工作台正在关闭。');
    if (!this.store.module(moduleId).enabled) throw new WorkbenchError(409, '请先添加这个模块。');
    if (this.active.has(moduleId)) throw new WorkbenchError(409, '请等待安装结束或取消后再更换目录。');
    if (this.choosingModule) throw new WorkbenchError(409, '请先完成已打开的文件夹选择。');
    if (typeof this.openDirectoryDialog !== 'function') throw new WorkbenchError(503, '请在桌面工作台中选择安装文件夹。');
    this.choosingModule = moduleId;
    let cancelled = false;
    try {
      const selected = await this.openDirectoryDialog({ moduleId, defaultPath: this.directory(moduleId) });
      if (selected === null || selected === undefined) cancelled = true;
      else {
        if (typeof selected !== 'string' || selected.length > 32767 || !isAbsolute(selected) || /[\u0000-\u001f]/.test(selected)) throw new WorkbenchError(400, '请选择有效的安装文件夹。');
        const directory = resolve(selected);
        const entry = await stat(directory).catch(() => null);
        if (!entry?.isDirectory()) throw new WorkbenchError(400, '所选文件夹无法访问，请重新选择。');
        if (this.closing || !this.store.module(moduleId).enabled) throw new WorkbenchError(409, '模块已关闭，安装位置未更改。');
        if (!sameDirectory(directory, this.directory(moduleId))) {
          const saved = this.saved(moduleId);
          saved.directory = directory;
          saved.selectionRevision++;
          this.save(moduleId, saved);
        }
      }
    } finally { this.choosingModule = null; }
    return { ...this.state(moduleId), cancelled };
  }

  fingerprint(definition, resource) { return digest({ revision: definition.revision, resource }); }

  optionalIds(definition, value) {
    if (!Array.isArray(value) || value.length > definition.resources.length || new Set(value).size !== value.length) throw new WorkbenchError(400, '可选资源必须是不重复的标识列表。');
    const allowed = new Set(definition.resources.filter(resource => !resource.required).map(resource => resource.id));
    for (const id of value) {
      identifier(id, '资源标识');
      if (!allowed.has(id)) throw new WorkbenchError(400, '可选资源包含未知项或前置依赖。前置依赖由服务端自动加入。');
    }
    return definition.resources.filter(resource => value.includes(resource.id)).map(resource => resource.id);
  }

  availability(resource) {
    if (resource.status !== 'available') return resource.reason || '安装包尚未接入。';
    if (typeof resource.version !== 'string' || !resource.version.trim() || typeof resource.sourceLabel !== 'string' || !resource.sourceLabel.trim()) return '资源版本或来源尚未接入。';
    const adapter = Object.hasOwn(this.adapters, resource.adapterId) ? this.adapters[resource.adapterId] : null;
    if (typeof adapter?.install !== 'function' || typeof adapter?.verify !== 'function') return '安装或校验适配器尚未接入。';
    return null;
  }

  verifiedRecord(moduleId,definition,resource) {
    const candidates=[{moduleId,record:this.saved(moduleId).installed[resource.id]}];
    if(this.sharedStore)for(const {id} of moduleDefinitions){const other=this.definition(id),match=other.resources.find(entry=>entry.id===resource.id&&(id===moduleId||resource.sharedKey&&entry.sharedKey===resource.sharedKey));if(match&&this.fingerprint(other,match)===this.fingerprint(definition,resource))candidates.push({moduleId:id,record:this.sharedStore.getSetting(settingKey(id))?.installed?.[resource.id]});}
    if(resource.sharedKey)for(const {id} of moduleDefinitions){
      if(id===moduleId)continue;
      const other=this.definition(id),match=other.resources.find(entry=>entry.sharedKey===resource.sharedKey&&entry.id===resource.id);
      if(match&&this.fingerprint(other,match)===this.fingerprint(definition,resource))candidates.push({moduleId:id,record:this.saved(id).installed[resource.id]});
    }
    for(const candidate of candidates){
      const record=candidate.record;if(!record||record.fingerprint!==this.fingerprint(definition,resource))continue;
      const directory=record.directory||this.defaultDirectory(candidate.moduleId);
      if(!resource.sharedKey&&!sameDirectory(directory,this.directory(moduleId)))continue;
      const verify=this.adapters[resource.adapterId]?.verifySync;
      try{if(verify&&verify({moduleId,resource,directory})!==true)continue;}catch{continue;}
      return {...record,directory,shared:candidate.moduleId!==moduleId};
    }
    return null;
  }

  resources(moduleId, definition, optionalIds, saved) {
    return definition.resources.map(resource => {
      const record = this.verifiedRecord(moduleId,definition,resource);
      const installed = !!record;
      const reason = installed ? null : this.availability(resource);
      return {
        id: resource.id, name: resource.name, version: resource.version ?? null,
        required: resource.required, status: installed ? 'installed' : reason ? 'pending' : 'available',
        sourceLabel: resource.sourceLabel, downloadBytes: size(resource.downloadBytes), installedBytes: size(resource.installedBytes),
        selected: resource.required || optionalIds.includes(resource.id), ...(reason ? { reason } : {}),
        ...(record?{installationDirectory:record.directory,shared:record.shared}:{}),
      };
    });
  }

  state(moduleId) {
    const definition = this.definition(moduleId);
    const saved = this.saved(moduleId);
    const optionalIds = definition.resources.filter(resource => !resource.required && saved.optionalIds.includes(resource.id)).map(resource => resource.id);
    const resources = this.resources(moduleId, definition, optionalIds, saved);
    const directory = this.directory(moduleId);
    const task = saved.task && sameDirectory(saved.task.directory || this.defaultDirectory(moduleId), directory) ? saved.task : null;
    return { moduleId, directory, canChooseDirectory: typeof this.openDirectoryDialog === 'function', choosingDirectory: this.choosingModule === moduleId, resources, prerequisitesReady: resources.filter(resource => resource.required).every(resource => resource.status === 'installed'), optionalIds, task };
  }

  select(moduleId, input) {
    fields(input, ['optionalIds']);
    const optionalIds = this.optionalIds(this.definition(moduleId), input.optionalIds);
    const saved = this.saved(moduleId);
    if (JSON.stringify(optionalIds) !== JSON.stringify(saved.optionalIds)) {
      saved.optionalIds = optionalIds;
      saved.selectionRevision++;
      this.save(moduleId, saved);
    }
    return this.state(moduleId);
  }

  buildPlan(moduleId, optionalIds) {
    const definition = this.definition(moduleId);
    const selected = this.optionalIds(definition, optionalIds);
    const saved = this.saved(moduleId);
    const resources = this.resources(moduleId, definition, selected, saved).filter(resource => resource.selected);
    const remaining = resources.filter(resource => resource.status !== 'installed');
    const reasons = remaining.filter(resource => resource.status === 'pending').map(resource => `${resource.name}：${resource.reason}`);
    if (!remaining.length) reasons.push('所选资源均已安装，无需重复安装。');
    const directory = this.directory(moduleId);
    const planId = digest({ salt: this.planSalt, moduleId, directory, definition, selected, selectionRevision: saved.selectionRevision, savedSelection: saved.optionalIds, installed: saved.installed, resources });
    return {
      plan: { planId, moduleId, directory, resources, downloadBytes: total(remaining, 'downloadBytes'), installedBytes: total(remaining, 'installedBytes'), unknownSizeCount: remaining.filter(resource => resource.downloadBytes === null || resource.installedBytes === null).length, canInstall: reasons.length === 0, reasons },
      definition,
      remaining: definition.resources.filter(resource => remaining.some(entry => entry.id === resource.id))
        .sort((left, right) => Number(right.required) - Number(left.required)),
    };
  }

  plan(moduleId, input) {
    fields(input, ['optionalIds']);
    return this.buildPlan(moduleId, input.optionalIds).plan;
  }

  install(moduleId, input) {
    fields(input, ['planId', 'optionalIds']);
    identifier(input.planId, '安装计划标识');
    if (this.closing) throw new WorkbenchError(409, '工作台正在关闭。');
    if (!this.store.module(moduleId).enabled) throw new WorkbenchError(409, '请先添加这个模块。');
    if (this.active.has(moduleId)) throw new WorkbenchError(409, '这个模块已有安装任务，请等待结束或取消。');
    if(this.sharedLocks?.has('install:'+moduleId))throw new WorkbenchError(409,'其他实例正在安装这个共享资源，请等待完成。');
    if (this.choosingModule === moduleId) throw new WorkbenchError(409, '请先完成安装文件夹选择，再确认安装。');
    const { plan, definition, remaining } = this.buildPlan(moduleId, input.optionalIds);
    const lockKeys=[...new Set(remaining.map(resource=>'resource:'+(resource.sharedKey||resource.id)))];
    if(lockKeys.some(key=>this.sharedLocks?.has(key)))throw new WorkbenchError(409,'其他实例正在安装同一共享资源，请等待完成。');
    if (plan.planId !== input.planId) throw new WorkbenchError(409, '安装清单已变化，请重新查看后确认。');
    if (!plan.canInstall) throw new WorkbenchError(409, plan.reasons.join(' '));
    const task = { id: randomUUID(), moduleId, directory: plan.directory, status: 'queued', stage: '等待安装', completedBytes: 0, totalBytes: null, currentResourceId: null, at: timestamp() };
    const saved = this.saved(moduleId);
    saved.task = task;
    this.save(moduleId, saved);
    const job = { task, controller: new AbortController(), promise: null };
    this.active.set(moduleId, job);
    this.sharedLocks?.set('install:'+moduleId,job);
    for(const key of lockKeys)this.sharedLocks?.set(key,job);
    job.promise = Promise.resolve().then(() => this.run(moduleId, job, definition, remaining)).finally(() => {this.active.delete(moduleId);for(const key of ['install:'+moduleId,...lockKeys])if(this.sharedLocks?.get(key)===job)this.sharedLocks.delete(key);});
    return { task: { ...task } };
  }

  update(moduleId, job, patch) {
    job.task = { ...job.task, ...patch, at: timestamp() };
    const saved = this.saved(moduleId);
    saved.task = job.task;
    this.save(moduleId, saved);
  }

  async run(moduleId, job, definition, resources) {
    const signal = job.controller.signal;
    try {
      signal.throwIfAborted();
      this.update(moduleId, job, { status: 'running', stage: '准备安装目录' });
      const directory = job.task.directory;
      await mkdir(directory, { recursive: true });
      for (const resource of resources) {
        signal.throwIfAborted();
        this.update(moduleId, job, { stage: '开始安装资源', currentResourceId: resource.id, completedBytes: 0, totalBytes: null });
        const adapter = this.adapters[resource.adapterId];
        const report = progress => {
          if (signal.aborted || job.task.status !== 'running') return;
          fields(progress, ['stage', 'completedBytes', 'totalBytes'], '安装进度');
          const patch = {};
          if (progress.stage !== undefined) {
            if (typeof progress.stage !== 'string' || !progress.stage.trim() || progress.stage.length > 200) throw new Error('安装器报告了无效阶段。');
            patch.stage = progress.stage;
          }
          if (progress.completedBytes !== undefined) {
            if (size(progress.completedBytes) === null) throw new Error('安装器报告了无效完成字节。');
            patch.completedBytes = progress.completedBytes;
          }
          if (progress.totalBytes !== undefined) {
            if (progress.totalBytes !== null && size(progress.totalBytes) === null) throw new Error('安装器报告了无效总字节。');
            patch.totalBytes = progress.totalBytes;
          }
          const completed = patch.completedBytes ?? job.task.completedBytes;
          const bytes = Object.hasOwn(patch, 'totalBytes') ? patch.totalBytes : job.task.totalBytes;
          if (bytes !== null && completed > bytes) throw new Error('安装器报告的完成字节超过总字节。');
          this.update(moduleId, job, patch);
        };
        const context = { moduleId, resource, directory, signal, report };
        await adapter.install(context);
        signal.throwIfAborted();
        this.update(moduleId, job, { stage: '校验安装结果' });
        const verified = await adapter.verify(context);
        signal.throwIfAborted();
        if (verified !== true) throw new Error(`${resource.name}安装结果校验失败。`);
        const saved = this.saved(moduleId);
        saved.installed[resource.id] = { fingerprint: this.fingerprint(definition, resource), directory, at: timestamp() };
        this.save(moduleId, saved);
      }
      this.update(moduleId, job, { status: 'completed', stage: '安装完成', currentResourceId: null });
    } catch (error) {
      if (signal.aborted) return;
      const message = typeof error?.message === 'string' ? error.message.slice(0, 1000) : '安装失败，请重新查看清单后重试。';
      this.update(moduleId, job, { status: 'failed', stage: '安装失败', error: message });
    }
  }

  cancel(moduleId, input) {
    fields(input, ['taskId']);
    identifier(input.taskId, '安装任务标识');
    const saved = this.saved(moduleId);
    if (saved.task?.id !== input.taskId) throw new WorkbenchError(409, '找不到这个模块的当前安装任务。');
    const job = this.active.get(moduleId);
    if (!job || !activeStatuses.has(job.task.status)) return { task: saved.task };
    this.update(moduleId, job, { status: 'cancelled', stage: '安装已取消', currentResourceId: null });
    job.controller.abort(new Error('安装已取消。'));
    return { task: { ...job.task } };
  }

  tasks() { return moduleDefinitions.map(({ id }) => this.saved(id).task).filter(Boolean); }

  async close() {
    this.closing = true;
    const jobs = [...this.active.entries()];
    for (const [moduleId, job] of jobs) {
      if (activeStatuses.has(job.task.status)) this.update(moduleId, job, { status: 'interrupted', stage: '安装已中断，请重新查看清单', currentResourceId: null });
      job.controller.abort(new Error('工作台正在关闭。'));
    }
    await Promise.allSettled(jobs.map(([, job]) => job.promise));
  }
}
