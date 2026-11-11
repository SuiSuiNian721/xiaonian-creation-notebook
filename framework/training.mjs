import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorkbenchError, object, fields as knownFields } from './contracts.mjs';
import { activeTrainingStatuses, TrainingRuntime, trainingIntegrationDir, trainingPath, trainingProcessExists, trainingDisplayMessage } from './training-runtime.mjs';
import { TrainingPipeline } from './training-pipeline.mjs';
import { taggerModels, normalizeTaggerOptions } from '../public-workbench/training-tagger-options.js';
import { TrainingPresets, parseTrainingPreset, exportTrainingPreset, cleanTrainingConfig } from './training-presets.mjs';
import { assertQuickAI } from './training-quick.mjs';
import { CachedDiscovery } from './resource-discovery.mjs';
import { discoverTrainingResources, inspectTrainingModel } from './training-resources.mjs';
import { trainingModelClassificationVersion } from './training-model-content.mjs';
import { protectDataset } from './training-dataset-guard.mjs';
import { TrainingCaptionerResources } from './training-captioner-resources.mjs';
export { protectDataset } from './training-dataset-guard.mjs';

const identifier = (value, label = '任务编号') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)) throw new WorkbenchError(400, `${label}格式无效。`);
  return value;
};
const secret = /password|secret|authorization|credential|api.?key|(?:^|_)(?:access_?|hf_?)?token$/i;
const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key)).map(([key, item]) => [key, clean(item)])) : value;
const discoveryVersion = record => { try { return JSON.parse(record.fingerprint)[0]; } catch { return null; } };
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new WorkbenchError(400, '训练配置必须是有效 JSON，不能包含 NaN、Infinity 或其他特殊对象。');
}
function configObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError(400, '训练配置必须是 JSON 对象。');
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new WorkbenchError(413, '训练配置超过 1 MiB。');
  return JSON.parse(serialized);
}

function publicTask(task) {
  const metadata = task.metadata || {};
  const date = value => typeof value === 'number' ? new Date(value * 1000).toISOString() : value || null;
  const allowed = ['backend', 'train_type', 'output_name', 'job_label', 'stage', 'train_task_id', 'held', 'error', 'output_dir'];
  return { id: task.id, status: task.status, lane: task.lane || 'compute', name: metadata.output_name || metadata.job_label || task.id, trainType: metadata.train_type || null, createdAt: date(metadata.created_at), startedAt: date(metadata.started_at), finishedAt: date(metadata.finished_at), returncode: task.returncode ?? metadata.returncode ?? null, queuePosition: task.queue_position ?? null, metadata: clean(Object.fromEntries(allowed.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]))) };
}

export class LoraTraining {
  constructor({ store, dataDir, runtime, instanceId = 'default', integrationDir = trainingIntegrationDir, componentProvider, runtimeOptions = {}, sharedAI, chooseDirectory, pipelineOptions = {} }) {
    this.store = store; this.dataDir = resolve(dataDir); this.directory = join(this.dataDir, 'training'); this.fallbackIntegrationDir = integrationDir; this.componentProvider = componentProvider; this.sharedAI = sharedAI;
    this.owner = createHash('sha256').update(`${this.dataDir.toLowerCase()}|${instanceId}`).digest('hex');
    this.ownsRuntime = !runtime; this.runtime = runtime || new TrainingRuntime({ store, dataDir, integrationDir, componentProvider, ...runtimeOptions });
    mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, 'submissions.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS submissions (owner TEXT NOT NULL, request_id TEXT NOT NULL, config_sha256 TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checker_pid INTEGER, PRIMARY KEY(owner,request_id));`);
    if (!this.db.prepare('PRAGMA table_info(submissions)').all().some(column => column.name === 'checker_pid')) this.db.exec('ALTER TABLE submissions ADD COLUMN checker_pid INTEGER');
    for (const column of ['workflow_id', 'workflow_stage']) if (!this.db.prepare('PRAGMA table_info(submissions)').all().some(item => item.name === column)) this.db.exec(`ALTER TABLE submissions ADD COLUMN ${column} TEXT`);
    this.serial = Promise.resolve(); this.closed = false; this.removing = false;
    this.presets = new TrainingPresets(this.db, this.owner);
    this.pipeline = new TrainingPipeline(this, { sharedAI, ...pipelineOptions });
    this.chooseDirectory = chooseDirectory; this.choosingDataset = false;
    this.discovery = typeof store.getSetting === 'function' && typeof store.setSetting === 'function' ? new CachedDiscovery({store,key:'training'}) : null;
    this.maintenance = false;
    this.captioners = new TrainingCaptionerResources(this);
  }
  get integrationDir() {
    const runtimeDirectory = this.runtime.integrationDir;
    if (runtimeDirectory) return runtimeDirectory;
    if (!this.componentProvider) return this.fallbackIntegrationDir;
    const component = this.componentProvider.resolve('training');
    if (!component?.path) throw new WorkbenchError(503, '训练组件尚未准备，请先在组件管理中安装或选择已有训练组件。');
    return component.path;
  }
  config() { return this.store.module('training').config || {}; }
  assertOpen() {
    if (this.closed) throw new WorkbenchError(503, '训练模块已关闭。');
    if (this.removing) throw new WorkbenchError(409, '训练实例正在移除，暂不能执行其他操作。');
  }
  async chooseDataset() {
    this.assertOpen();
    if (typeof this.chooseDirectory !== 'function') throw new WorkbenchError(409, '请在桌面工作台选择图集，或直接填写本地目录。');
    if (this.choosingDataset) throw new WorkbenchError(409, '请先完成当前文件夹选择。');
    this.choosingDataset = true;
    try { const directory = await this.chooseDirectory({ moduleId: 'training', purpose: 'training-dataset', defaultPath: homedir() }); return { directory: directory ? trainingPath(directory, '图集目录') : null, cancelled: !directory }; }
    finally { this.choosingDataset = false; }
  }
  async catalog() { this.assertOpen(); return JSON.parse(await readFile(join(this.integrationDir, 'catalog.json'), 'utf8')); }
  async inspectModel(value) { this.assertOpen(); knownFields(value,['path','family']); return inspectTrainingModel(value,await this.catalog()); }
  async prepareService(value) { this.assertOpen();knownFields(value,['pythonPath','confirmed']);return this.runtime.prepareService(value); }
  discoveryFingerprint(roots=this.store.getSetting?.('training.discoveryRoots')||[]) {return JSON.stringify([trainingModelClassificationVersion,this.config().trainerPath||'',this.config().pythonPath||'',roots]);}
  discoveryState(record=this.discovery?.read({fingerprint:this.discoveryFingerprint()})||null) {
    if(!record)return null;
    const classificationStale=Boolean(record.attempted&&(discoveryVersion(record)!==trainingModelClassificationVersion||record.result&&record.result.classificationVersion!==trainingModelClassificationVersion));
    return {...record,classificationStale,...(classificationStale?{stale:true,result:record.result?{...record.result,models:[]}:null}:{})};
  }
  async discoverResources(value={}) {
    this.assertOpen(); knownFields(value,['refresh','roots']);
    if(value.refresh!==undefined&&typeof value.refresh!=='boolean')throw new WorkbenchError(400,'重新检索参数无效。');
    if(!this.discovery)throw new WorkbenchError(503,'训练发现缓存不可用。');
    const roots=value.roots||this.store.getSetting('training.discoveryRoots')||[],fingerprint=this.discoveryFingerprint(roots);
    const previous=this.discoveryState(),refresh=value.refresh===true||previous.classificationStale&&discoveryVersion(previous)!==trainingModelClassificationVersion;
    if(refresh||!previous.attempted)this.store.setSetting('training.discoveryRoots',roots);
    return this.discoveryState(await this.discovery.run(()=>discoverTrainingResources({roots,trainerPath:this.config().trainerPath,pythonPath:this.config().pythonPath}),{refresh,fingerprint}));
  }
  async engineAction(engine,action,value={}) {
    this.assertOpen();knownFields(value,['target','confirmed','dryRun']);
    if(!(await this.catalog()).engines.some(item=>item.id===engine)||!['install','repair','use'].includes(action))throw new WorkbenchError(400,'训练引擎操作无效。');
    if(!['original','isolated'].includes(value.target))throw new WorkbenchError(400,'请选择原环境或隔离环境。');
    if(value.confirmed!==true)throw new WorkbenchError(400,'请明确确认安装或修复；操作可能下载依赖并修改所选环境。');
    if(value.target==='original'&&action!=='use'){
      const original=this.config().trainerPath;if(!original)throw new WorkbenchError(400,'请先选择原有训练环境目录，或使用工作台隔离环境。');
      for(const queue of [join(original,'logs','task_queue.json'),join(original,'task_queue.json')]){
        let records;
        try{const info=await stat(queue);if(info.size>8*1024*1024)throw new WorkbenchError(409,'原训练器队列过大，无法核实原环境活动任务。');records=JSON.parse(await readFile(queue,'utf8'));}
        catch(error){if(error.code==='ENOENT')continue;if(error instanceof WorkbenchError)throw error;throw new WorkbenchError(409,'无法核实原训练器队列，请先在原训练器确认任务结束。');}
        if(!Array.isArray(records)||records.some(task=>activeTrainingStatuses.has(task.status)||[0,1,5].includes(task.status)))throw new WorkbenchError(409,'原有训练工具仍有活动或排队任务，请先在原训练器完成或停止任务。');
      }
    }
    if(this.maintenance)throw new WorkbenchError(409,'训练环境正在处理，请稍后刷新。');
    this.maintenance=true;
    try{
      if(typeof this.runtime.selectEngineTarget!=='function')throw new WorkbenchError(503,'训练内核不支持环境管理。');
      await this.runtime.selectEngineTarget(engine,value.target,this.config());
      await this.runtime.start(this.config());
      if(action==='use')return {target:value.target,status:clean(await this.runtime.request('GET',`/api/engines/${engine}/status`)),training_started:false};
      const result=await this.runtime.request('POST',`/api/engines/${engine}/maintenance/${action}`,{body:{dry_run:value.dryRun!==false},owner:this.owner,timeoutMs:90000});
      return clean({...result,target:value.target,training_started:false});
    }finally{this.maintenance=false;}
  }
  async schema(trainType) {
    identifier(trainType, '训练类型');
    this.assertOpen(); const integrationDir = this.integrationDir;
    const item = JSON.parse(await readFile(join(integrationDir, 'catalog.json'), 'utf8')).training_types.find(item => item.train_type === trainType || item.schema_name === trainType);
    if (!item?.schema_name) throw new WorkbenchError(404, '此训练类型没有独立参数定义。');
    const directory = join(integrationDir, 'source', 'mikazuki', 'schema');
    const files = await readdir(directory); const name = files.find(name => basename(name, extname(name)) === item.schema_name);
    if (!name) throw new WorkbenchError(404, '内置源码中未找到参数定义。');
    const { loadTrainingForm } = await import('./training-schema.mjs');
    return { train_type: item.train_type, schema_name: item.schema_name, format: 'schemastery-typescript', schema: await readFile(join(directory, name), 'utf8'), shared: await readFile(join(directory, 'shared.ts'), 'utf8'), form: await loadTrainingForm(integrationDir, item.schema_name) };
  }
  listPresets() { this.assertOpen(); return this.presets.list(); }
  savePreset(value) { this.assertOpen(); return this.presets.save(value); }
  deletePreset(id, value) { this.assertOpen(); return this.presets.remove(id, value); }
  importPreset(value) { this.assertOpen(); return parseTrainingPreset(value); }
  exportPreset(value) { this.assertOpen(); return exportTrainingPreset(value); }
  async quickStart(value) {
    this.assertOpen(); knownFields(value, ['requestId', 'input', 'config']); identifier(value.requestId, '流程编号'); object(value.input, '一键训练输入');
    const config = cleanTrainingConfig(value.config);
    const exists = this.db.prepare('SELECT 1 FROM training_workflows WHERE owner=? AND id=?').get(this.owner, value.requestId);
    if (!exists) assertQuickAI(this.sharedAI);
    return this.pipeline.create({ requestId: value.requestId, config, input: { ...value.input, planner: 'full', aiEnabled: true } });
  }
  async type(config) {
    const item = (await this.catalog()).training_types.find(item => item.train_type === config.model_train_type);
    if (!item) throw new WorkbenchError(400, '请提供当前内核支持的 model_train_type 训练类型。');
    if (!item.control_supported) throw new WorkbenchError(409, '当前内核快照不支持此训练类型。');
    return item;
  }
  async state() {
    this.assertOpen();
    this.recoverChecks();
    const runtime = await this.runtime.state(this.config()); const engines = {}; let tasks = []; let hardware = null;
    if (['running', 'configuration_changed'].includes(runtime.status)) {
      const ids = [...new Set((await this.catalog()).training_types.map(item => item.engine))];
      await Promise.all(ids.map(async id => {
        try { engines[id] = await this.runtime.request('GET', `/api/engines/${encodeURIComponent(id)}/status`); }
        catch (error) { engines[id] = { state: 'unavailable', reason: error.message }; }
      }));
      try { tasks = (await this.tasks()).tasks; } catch { /* An unavailable queue cannot be reported as current. */ }
      try { hardware = await this.runtime.request('GET', '/api/hardware/status'); } catch { hardware = null; }
    }
    const unresolvedSubmissions = this.db.prepare("SELECT request_id AS requestId,state FROM submissions WHERE owner=? AND state IN ('checking','submitting','uncertain') ORDER BY created_at").all(this.owner);
    return clean({ runtime, engines, tasks, hardware, unresolvedSubmissions, discovery:this.discoveryState() });
  }
  async start() { this.assertOpen(); await this.runtime.start(this.config()); return this.state(); }
  async stop() {
    this.assertOpen();
    if (this.runtime.pendingSubmissions > 0) throw new WorkbenchError(409, '仍有训练参数检查或提交正在进行，不能停止内核。');
    await this.runtime.stop(); return this.state();
  }
  async savedConfigs() {
    this.assertOpen();
    const config = this.config();
    if (!config.trainerPath) return { configs: [] };
    const selected = await this.runtime.configuration(config);
    return clean(await this.runtime.readSavedConfigs(selected.environmentRoot, selected.pythonPath));
  }
  async validate(input) {
    this.assertOpen(); const config = configObject(input); const type = await this.type(config);
    await this.runtime.start(this.config());
    const validation = await this.runtime.request('POST', '/api/config/validate-import', { body: { page_train_type: type.train_type, config } });
    const normalized = configObject(validation.config || config); let valid = validation.result === 'ok';
    if (valid) { const resolved = await this.type(normalized); valid = resolved.engine === type.engine && resolved.variant === type.variant; }
    return clean({ valid, engine: type.engine, normalized_config: normalized, validation });
  }
  async preflight(input) {
    const validation = await this.validate(input);
    if (!validation.valid) throw new WorkbenchError(422, '训练配置校验未通过。');
    const config = validation.normalized_config;
    await protectDataset(config, { engine: validation.engine, root: this.runtime.record?.root });
    if (!config.output_dir) config.output_dir = this.config().outputPath || join(this.dataDir, 'training', 'output');
    config.output_dir = trainingPath(config.output_dir, '训练输出目录');
    const status = await this.runtime.request('GET', `/api/engines/${validation.engine}/status`);
    if (status.state !== 'ready') throw new WorkbenchError(409, `训练引擎尚未就绪：${trainingDisplayMessage(status.reason || status.state)}`);
    const preflight = await this.runtime.request('POST', `/api/engines/${validation.engine}/preflight`, { body: config, timeoutMs: 90000 });
    if (preflight.ok !== true) throw new WorkbenchError(422, `引擎预检没有通过：${(preflight.errors || []).map(trainingDisplayMessage).join('；')}`);
    return { ok: true, engine: validation.engine, validation, preflight: clean(preflight), training_started: false };
  }
  record(requestId) {
    this.recoverChecks();
    const row = this.db.prepare('SELECT * FROM submissions WHERE owner=? AND request_id=?').get(this.owner, requestId);
    return row ? { requestId: row.request_id, configHash: row.config_sha256, workflowId: row.workflow_id, workflowStage: row.workflow_stage, state: row.state, result: row.result ? JSON.parse(row.result) : null, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  recoverChecks() {
    for (const row of this.db.prepare("SELECT request_id,checker_pid FROM submissions WHERE owner=? AND state='checking'").all(this.owner)) {
      // A missing process is evidence that this preflight cannot continue.
      // An existing or reused PID, or an older record without a PID, remains
      // unresolved; it never authorizes another training submission.
      if (Number.isInteger(row.checker_pid) && row.checker_pid > 0 && !trainingProcessExists(row.checker_pid)) {
        this.db.prepare("UPDATE submissions SET state='failed',result=?,updated_at=? WHERE owner=? AND request_id=? AND state='checking'").run(JSON.stringify({ error: '参数检查所属工作台已退出；此请求尚未提交训练，可以重新提交。' }), new Date().toISOString(), this.owner, row.request_id);
      }
    }
  }
  replay(record, hash) {
    if (record.configHash !== hash) throw new WorkbenchError(409, '此请求编号已用于另一份配置，编号与参数冲突。');
    if (record.state === 'submitted') return { ...record.result, reused: true };
    if (['checking', 'submitting', 'uncertain'].includes(record.state)) throw new WorkbenchError(409, '上次提交结果不确定或仍在检查，请先核对提交记录和任务列表；不能自动重复提交。');
    throw new WorkbenchError(409, '此请求之前已失败；修正后请使用新的请求编号。');
  }
  finish(requestId, state, result) { this.db.prepare('UPDATE submissions SET state=?,result=?,updated_at=? WHERE owner=? AND request_id=?').run(state, JSON.stringify(clean(result)), new Date().toISOString(), this.owner, requestId); }
  async submit(value = {}) { return this.reserveSubmission(value); }
  ownsWorkflowDataset(path,workflow,stage){
    const local=relative(join(this.directory,'workflows'),path);
    if(local&&local!=='..'&&!local.startsWith('..'+sep)&&!isAbsolute(local))return true;
    if(!workflow||workflow.stage!==stage||typeof workflow.id!=='string')return false;
    const record=this.db.prepare('SELECT record FROM training_workflows WHERE owner=? AND id=?').get(this.owner,workflow.id);
    if(!record)return false;
    const job=JSON.parse(record.record);
    return job.input?.mode==='tag'&&!!job.outputDirectory&&job.dataset?.imageDir===path;
  }
  async submitTag({ requestId, config, workflow, signal } = {}) {
    config = configObject(config);
    if (config.captionModelPath !== undefined) config.captionModelPath = config.captionModelPath === '' ? '' : trainingPath(config.captionModelPath, '描述模型目录');
    if (Object.keys(config).some(key => !['path', 'model', 'allowDownload', 'trigger', 'policy', 'purpose', 'captionFormat', 'captionModelPath', 'taggerOptions', 'captionOperationId'].includes(key)) || !taggerModels.includes(config.model) || typeof config.allowDownload !== 'boolean' || typeof config.trigger !== 'string' || config.trigger.length > 120 || !['fill-missing', 'regenerate', 'existing'].includes(config.policy) || config.captionFormat !== undefined && !['tags', 'natural'].includes(config.captionFormat) || config.purpose !== undefined && !['character', 'style', 'pose'].includes(config.purpose)) throw new WorkbenchError(400, '打标配置格式无效。');
    if (config.captionOperationId !== undefined) identifier(config.captionOperationId, '标注操作编号');
    if (config.taggerOptions !== undefined) {
      try { config.taggerOptions = normalizeTaggerOptions(config.taggerOptions, { legacyPolicy: config.policy }); }
      catch (error) { throw new WorkbenchError(400, error.message); }
    }
    const path = trainingPath(config.path, '打标工作副本');
    if(!this.ownsWorkflowDataset(path,workflow,'tag'))throw new WorkbenchError(400,'打标只能处理当前实例的一键流程工作副本。');
    // Resource installation belongs to the instance even when its kernel is shared.
    return this.reserveSubmission({ requestId, config: { ...config, path, captionResourceRoot: this.directory }, tagging: true, workflow, signal });
  }
  async submitCrop({ requestId, config, workflow, signal } = {}) {
    config = configObject(config);
    if (config.detectorPath !== undefined) config.detectorPath = config.detectorPath === '' ? '' : trainingPath(config.detectorPath, '裁切模型目录');
    if (Object.keys(config).some(key => !['path', 'purpose', 'cropMode', 'detectorPath', 'allowDownload'].includes(key)) || !['character', 'style', 'pose'].includes(config.purpose) || !['character', 'pose', 'preserve'].includes(config.cropMode) || typeof config.allowDownload !== 'boolean') throw new WorkbenchError(400, '裁切配置格式无效。');
    const path = trainingPath(config.path, '裁切工作副本');
    if(!this.ownsWorkflowDataset(path,workflow,'crop'))throw new WorkbenchError(400,'裁切只能处理当前实例的流程副本。');
    return this.reserveSubmission({ requestId, config: { ...config, path }, preprocessing: true, workflow, signal });
  }
  async reserveSubmission({ requestId, config: input, tagging = false, preprocessing = false, workflow, signal } = {}) {
    this.assertOpen();
    signal?.throwIfAborted();
    identifier(requestId, '请求编号'); const config = configObject(input); const hash = createHash('sha256').update((preprocessing ? 'cropping|' : tagging ? 'tagging|' : '') + canonical(config)).digest('hex');
    // Reserve synchronously before joining the queue or awaiting preflight.
    // Thus a concurrent status lookup can safely distinguish not_found from
    // accepted work, even while another request or a slow check is pending.
    const previous = this.record(requestId);
    if (workflow && (typeof workflow.id !== 'string' || !['crop', 'tag', 'train'].includes(workflow.stage))) throw new WorkbenchError(400, '流程提交绑定无效。');
    const bound = record => {
      if ((record.workflowId || null) !== (workflow?.id || null) || (record.workflowStage || null) !== (workflow?.stage || null)) throw new WorkbenchError(409, '提交编号已绑定其他来源或流程，请使用新的流程编号。');
      return this.replay(record, hash);
    };
    if (previous) return this.serial.then(() => bound(this.record(requestId)));
    const unresolved = this.db.prepare("SELECT request_id FROM submissions WHERE owner=? AND config_sha256=? AND state IN ('checking','submitting','uncertain') LIMIT 1").get(this.owner, hash);
    if (unresolved) throw new WorkbenchError(409, `相同配置的提交 ${unresolved.request_id} 结果不确定或仍在检查，请先核对，不能换编号重复提交。`);
    const now = new Date().toISOString();
    const reserved = this.db.prepare("INSERT OR IGNORE INTO submissions (owner,request_id,config_sha256,state,created_at,updated_at,checker_pid,workflow_id,workflow_stage) VALUES (?,?,?,'checking',?,?,?,?,?)").run(this.owner, requestId, hash, now, now, process.pid, workflow?.id || null, workflow?.stage || null);
    if (!reserved.changes) return bound(this.record(requestId));
    this.runtime.pendingSubmissions = (this.runtime.pendingSubmissions || 0) + 1;
    const operation = this.serial.then(() => tagging || preprocessing ? this.submitTagReserved({ requestId, config, preprocessing, signal }) : this.submitReserved({ requestId, config, signal })).finally(() => { this.runtime.pendingSubmissions--; });
    this.serial = operation.catch(() => {}); return operation;
  }
  async submitTagReserved({ requestId, config, preprocessing = false, signal }) {
    const base = preprocessing ? '/api/preprocess' : '/api/tagger';
    try {
      signal?.throwIfAborted();
      await this.runtime.start(this.config());
      signal?.throwIfAborted();
      const check = await this.runtime.request('POST', base + '/check', { body: config, owner: this.owner, requestId });
      signal?.throwIfAborted();
      if (check.ok !== true) throw new WorkbenchError(422, check.reason || '本地打标环境未就绪。');
    } catch (error) { this.finish(requestId, 'failed', { error: error.message }); throw error; }
    this.finish(requestId, 'submitting', {});
    try {
      const data = await this.runtime.request('POST', base + '/run', { body: config, owner: this.owner, requestId, timeoutMs: 20000 });
      if (typeof data.task_id !== 'string' || !data.task_id) throw new WorkbenchError(502, '打标提交未返回任务编号，请核对任务。');
      const result = clean({ ...data, requestId, reused: false }); this.finish(requestId, 'submitted', result); return result;
    } catch (error) { this.finish(requestId, error.code === 'BACKEND_REJECTED' ? 'failed' : 'uncertain', { error: error.message }); throw error; }
  }
  async submitReserved({ requestId, config, signal }) {
    let checked;
    try { signal?.throwIfAborted(); checked = await this.preflight(config); signal?.throwIfAborted(); }
    catch (error) { this.finish(requestId, 'failed', { error: error.message }); throw error; }
    this.finish(requestId, 'submitting', {});
    // This reservation is committed before the only call that can create work.
    // Connection loss after this point can never trigger an automatic retry.
    try {
      const data = await this.runtime.request('POST', '/api/run', { body: checked.validation.normalized_config, owner: this.owner, requestId, timeoutMs: 90000 });
      if (typeof data.task_id !== 'string' || !data.task_id) throw new WorkbenchError(502, '提交没有返回任务编号，结果不确定，请核对任务列表。');
      const result = clean({ ...data, requestId, reused: false });
      this.finish(requestId, 'submitted', result); return result;
    } catch (error) {
      this.finish(requestId, error.code === 'BACKEND_REJECTED' ? 'failed' : 'uncertain', { error: error.message }); throw error;
    }
  }
  async submission(requestId) {
    this.assertOpen(); let record = this.record(identifier(requestId, '请求编号'));
    if (!record) return { requestId, state: 'not_found' };
    if (['submitting', 'uncertain'].includes(record.state)) {
      try {
        const candidates = (await this.ownedTasks()).filter(task => task.metadata?.workbench_request === requestId);
        if (candidates.length) {
          const main = candidates.find(task => task.id === task.metadata?.train_task_id) || candidates[0];
          this.finish(requestId, 'submitted', { task_id: main.metadata?.train_task_id || main.id, requestId, reused: true, queued: main.status === 'QUEUED', reconciled: true });
          record = this.record(requestId);
        }
      } catch { /* Absence or network failure cannot prove that no job started. */ }
    }
    return clean(record);
  }
  ownedIds() {
    const ids = new Set();
    for (const row of this.db.prepare("SELECT result FROM submissions WHERE owner=? AND state='submitted'").all(this.owner)) {
      const result = JSON.parse(row.result);
      for (const [key, value] of Object.entries(result)) if ((key === 'task_id' || key.endsWith('_task_id')) && typeof value === 'string') ids.add(value);
    }
    return ids;
  }
  async ownedTasks() {
    const data = await this.runtime.request('GET', '/api/tasks'); const known = this.ownedIds();
    return (data.tasks || []).filter(task => task.metadata?.workbench_owner === this.owner || !task.metadata?.workbench_owner && known.has(task.id));
  }
  async tasks() {
    this.assertOpen(); const tasks = await this.ownedTasks();
    return { tasks: tasks.map(publicTask).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) };
  }
  async ownedTask(id) {
    identifier(id); const tasks = await this.ownedTasks(); const task = tasks.find(task => task.id === id);
    if (!task) throw new WorkbenchError(404, '没有找到属于当前训练实例的任务。'); return task;
  }
  async task(id) {
    this.assertOpen(); const task = await this.ownedTask(id); const base = `/api/tasks/${encodeURIComponent(id)}`;
    const [metrics, logs, previews, config] = await Promise.all([
      this.runtime.request('GET', base + '/metrics'),
      this.runtime.request('GET', `/api/train/log/tail/${encodeURIComponent(id)}?limit=240`),
      this.runtime.request('GET', base + '/previews'),
      this.runtime.request('GET', base + '/config').catch(() => ({ config: {} })),
    ]);
    const outputs = await this.outputFiles(config.config || {}, task);
    return clean({ task: publicTask(task), metrics, logs, previews: previews.images || [], outputs });
  }
  async outputFiles(config, task) {
    if (!config.output_dir || !isAbsolute(config.output_dir)) return [];
    const name = config.output_name || task.metadata?.output_name;
    if (!name) return [];
    // Keep this aligned with the bundled output_naming._artifact_pattern:
    // xiaoli-v2 is another run; xiaoli-000001 and xiaoli-step20 are checkpoints.
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(?:\\..+|-\\d+(?:\\..+|-state.*)?|-step\\d+(?:\\..+)?)?$`, process.platform === 'win32' ? 'i' : '');
    const allowed = new Set(['.safetensors', '.ckpt', '.pt', '.json', '.toml', '.csv', '.yaml', '.yml']);
    try {
      const items = await readdir(config.output_dir, { withFileTypes: true }); const result = [];
      for (const item of items) {
        if (result.length >= 100) break;
        if (!item.isFile() || !pattern.test(item.name) || !allowed.has(extname(item.name).toLowerCase())) continue;
        const path = join(config.output_dir, item.name); const info = await stat(path);
        result.push({ name: item.name, path, bytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
      return result;
    } catch { return []; }
  }
  async preview(id, filename) {
    this.assertOpen(); await this.ownedTask(id);
    if (typeof filename !== 'string' || basename(filename) !== filename || filename.includes('\\') || filename.includes('\0') || !filename) throw new WorkbenchError(400, '预览文件名无效。');
    return this.runtime.image(`/api/tasks/${encodeURIComponent(id)}/previews/${encodeURIComponent(filename)}?thumb=1`);
  }
  async stopTask(id) {
    this.assertOpen(); const target = await this.ownedTask(id); const tasks = await this.ownedTasks();
    const group = target.metadata?.train_task_id || target.id;
    const members = tasks.filter(task => task.id === target.id || task.id === group || task.metadata?.train_task_id === group);
    members.sort((a, b) => Number(a.status === 'RUNNING') - Number(b.status === 'RUNNING'));
    for (const task of members) if (activeTrainingStatuses.has(task.status)) await this.runtime.request('GET', `/api/tasks/terminate/${encodeURIComponent(task.id)}`, { owner: this.owner, timeoutMs: 20000 });
    const remaining = (await this.ownedTasks()).filter(task => members.some(member => member.id === task.id) && activeTrainingStatuses.has(task.status)).map(task => task.id);
    return { stopped: remaining.length === 0, remaining_active_task_ids: remaining };
  }
  async resumeHeldTask(id) {
    const target = await this.ownedTask(id), group = target.metadata?.train_task_id || target.id;
    for (const task of await this.ownedTasks()) if ((task.id === id || task.id === group || task.metadata?.train_task_id === group) && task.metadata?.held) await this.runtime.request('POST', `/api/tasks/${encodeURIComponent(task.id)}/resume`, { body: {}, owner: this.owner });
  }
  async prepareRemoval() {
    this.assertOpen(); this.removing = true;
    try {
      if(this.maintenance)throw new WorkbenchError(409,'此实例仍在维护训练环境，请等待完成后再移除。');
      this.pipeline.assertRemovable();
      this.captioners.assertRemovable();
      this.recoverChecks();
      const pending = this.db.prepare("SELECT request_id FROM submissions WHERE owner=? AND state IN ('checking','submitting','uncertain') LIMIT 1").get(this.owner);
      if (pending) throw new WorkbenchError(409, `提交 ${pending.request_id} 尚未确认，请先核对提交结果后再移除此训练实例。`);
      const state = await this.runtime.state(this.config());
      if(['starting','running'].includes(state.servicePreparation?.status))throw new WorkbenchError(409,'工作台服务环境正在准备，请等待完成后再移除此训练实例。');
      if (['running', 'configuration_changed'].includes(state.status)) {
        let owned;
        try { owned = await this.ownedTasks(); }
        catch (error) { throw new WorkbenchError(409, `无法核实此实例的训练任务，暂不能移除：${error.message}`); }
        if (owned.some(task => activeTrainingStatuses.has(task.status))) throw new WorkbenchError(409, '此训练实例仍有活动或排队任务，请等待完成或停止任务后再移除。');
      } else if (!['stopped', 'unconfigured'].includes(state.status)) {
        throw new WorkbenchError(409, '训练内核离线或身份尚未核实，无法确认此实例任务已经结束；请先恢复连接并核对任务。');
      }
      return () => { this.removing = false; };
    } catch (error) { this.removing = false; throw error; }
  }
  async close() {
    if (this.closed) return; await this.captioners.close(); await this.pipeline.close(); await this.serial;
    if (this.ownsRuntime) await this.runtime.close();
    this.closed = true; this.db.close();
  }
}
