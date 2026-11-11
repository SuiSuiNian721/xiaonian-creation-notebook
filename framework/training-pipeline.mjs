import { createHash } from 'node:crypto';
import { extname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { WorkbenchError, identifier, object } from './contracts.mjs';
import { buildPipelinePlan, pipelineInput, taggerModels } from './training-plan.mjs';
import { preparePipelineDataset, readProcessedDataset, regularLocal, verifyPipelineDataset } from './training-dataset.mjs';
import { activeTrainingStatuses } from './training-runtime.mjs';
import { cleanTrainingConfig } from './training-presets.mjs';
import { buildQuickTrainingPlan } from './training-quick.mjs';
import { baseModelField } from '../public-workbench/training-types.js';
import {workflowOutputDirectory,prepareWorkflowOutput} from './training-output.mjs';
import {assertWorkflowSupported,prepareWorkflowTrainingConfig} from './training-workflow-config.mjs';
import {workflowPolicy,basicWorkflowParameters} from './training-workflow-parameters.mjs';
import {applyMemoryOptions} from '../public-workbench/training-memory-fields.js';
import {trainingSubmission} from '../public-workbench/training-form-fields.js';
import {formDefaults} from './training-schema.mjs';
import {captionTrainingDataset} from './training-ai-caption.mjs';
import {resolveCaptioner} from '../public-workbench/training-captioners.js';

const stages = [['plan', '整理方案'], ['prepare', '准备图集副本'], ['crop', '检测与裁切'], ['tag', '本地标注'], ['verify', '检查标注'], ['train', '训练与产物']];
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const now = () => new Date().toISOString();
const publicJob = job => ({ id: job.id, state: job.state, stage: job.stage, mode: job.input.mode, goal: job.input.goal, sourcePath: job.input.sourcePath, createdAt: job.createdAt, updatedAt: job.updatedAt, cancelRequestedAt: job.cancelRequestedAt || null, plan: job.plan, configuration: cleanTrainingConfig(job.trainingConfig || job.config, { requireType: false }), steps: job.steps, tasks: job.tasks, workspace: job.dataset?.workspace || null, imageDirectory:job.dataset?.imageDir||null, outputDirectory:job.outputDirectory||job.trainingConfig?.output_dir||null, summary: job.summary, error: job.error, outputs: job.outputs });

export class TrainingPipeline {
  constructor(training, { sharedAI, autoRun = true, intervalMs = 1500 } = {}) {
    this.training = training; this.db = training.db; this.owner = training.owner; this.sharedAI = sharedAI;
    this.autoRun = autoRun; this.intervalMs = intervalMs; this.timer = null; this.closed = false; this.serial = Promise.resolve(); this.activeRuns = new Map();
    this.db.exec('CREATE TABLE IF NOT EXISTS training_workflows (owner TEXT NOT NULL,id TEXT NOT NULL,input_hash TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner,id));');
    for (const job of this.records()) if (['running', 'pausing'].includes(job.state)) { job.state = 'paused'; job.error = '工作台已重新打开；已提交任务保留，点击继续核对并推进后续阶段。'; this.save(job); }
    for (const job of this.records()) if (job.state === 'cancelling') { job.state = 'blocked'; job.error = '取消尚未完成；请再次取消以核对并停止已提交的任务。'; this.save(job); }
  }
  records() { return this.db.prepare('SELECT record FROM training_workflows WHERE owner=? ORDER BY rowid DESC').all(this.owner).map(row => JSON.parse(row.record)); }
  record(id) {
    identifier(id, '流程编号');
    const row = this.db.prepare('SELECT record FROM training_workflows WHERE owner=? AND id=?').get(this.owner, id);
    if (!row) throw new WorkbenchError(404, '找不到属于当前训练实例的流程。'); return JSON.parse(row.record);
  }
  save(job) { job.updatedAt = now(); this.db.prepare('UPDATE training_workflows SET record=? WHERE owner=? AND id=?').run(JSON.stringify(job), this.owner, job.id); return job; }
  list() { return { jobs: this.records().map(publicJob), taggerModels }; }
  get(id) { return { job: publicJob(this.record(id)) }; }
  async create({ requestId, input, config = {} }) {
    this.training.assertOpen(); identifier(requestId, '流程编号'); object(config, '训练参数');
    let actualInput=input;
    if(input?.captionSource!=='connected'&&input?.captioner!==undefined){
      try{
        const choice=resolveCaptioner({captioner:input.captioner,modelTrainType:config.model_train_type,taggerModel:input.taggerModel,captionFormat:input.captionFormat});
        actualInput={...input,captionFormat:choice.format,...(choice.format==='tags'?{taggerModel:choice.id}:{})};
        if(choice.format==='natural')delete actualInput.taggerOptions;
      }catch(error){throw new WorkbenchError(400,error.message);}
    }
    const normalized = pipelineInput(actualInput);
    if (normalized.mode === 'train') {
      const key=baseModelField(config.model_train_type,config);
      if (typeof config[key] !== 'string' || !config[key].trim()) throw new WorkbenchError(400, '请先载入或填写底模，再开始一键训练。');
    }
    const snapshot = JSON.parse(JSON.stringify({ input: normalized, config }));
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) throw new WorkbenchError(413, '流程参数超过 1 MiB。');
    const hash = createHash('sha256').update(canonical(snapshot)).digest('hex');
    const previous = this.db.prepare('SELECT input_hash,record FROM training_workflows WHERE owner=? AND id=?').get(this.owner, requestId);
    if (previous) {
      const saved = JSON.parse(previous.record), v2Fields = ['cropMode', 'captionFormat', 'detectorPath', 'captionModelPath'], v3Fields = ['planner', 'parameterMode'];
      let matches = previous.input_hash === hash;
      const version = saved.version || 1, introduced = version < 2 ? [...v2Fields, ...v3Fields] : v3Fields;
      if (!matches && version < 3 && introduced.every(key => input[key] === undefined)) {
        const legacyInput = { ...normalized }; for (const key of introduced) delete legacyInput[key];
        if (version === 2 && input.cropMode === undefined) legacyInput.cropMode = 'auto';
        matches = previous.input_hash === createHash('sha256').update(canonical({ input: legacyInput, config })).digest('hex');
      }
      if (!matches) throw new WorkbenchError(409, '此流程编号已用于其他参数，不能替换原流程。');
      return { job: publicJob(saved), reused: true };
    }
    const outputDirectory=await workflowOutputDirectory({root:config.output_dir||(normalized.mode==='train'?this.training.config().outputPath:null),owner:this.owner,id:requestId,sourcePath:normalized.sourcePath});
    const job = { id: requestId, version: 3, ...snapshot, outputDirectory, state: 'running', stage: 'plan', createdAt: now(), updatedAt: now(), plan: null, dataset: null, summary: null, error: null, outputs: [], tasks: { crop: null, tag: null, train: null }, attempts: { crop: 0, tag: 0, train: 0 }, steps: stages.map(([id, label]) => ({ id, label, status: 'pending' })) };
    if(normalized.captionSource==='connected')job.steps.find(step=>step.id==='tag').label='AI 标注';
    const inserted=this.db.prepare('INSERT OR IGNORE INTO training_workflows(owner,id,input_hash,record) VALUES(?,?,?,?)').run(this.owner, job.id, hash, JSON.stringify(job));
    if(!inserted.changes)return this.create({requestId,input,config});
    this.schedule(); return { job: publicJob(job), reused: false };
  }
  schedule() {
    if (!this.autoRun || this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick().finally(() => { if (!this.closed && this.records().some(job => ['running', 'pausing'].includes(job.state))) this.schedule(); }); }, this.intervalMs);
    this.timer.unref?.();
  }
  locked(operation) { const result = this.serial.then(operation); this.serial = result.catch(() => {}); return result; }
  async tick(id) {
    return this.locked(async () => {
      if (this.closed) return;
      const jobs = id ? [this.record(id)] : this.records();
      for (const snapshot of jobs) {
        const job = this.record(snapshot.id);
        if (!['running', 'pausing'].includes(job.state)) continue;
        const controller = new AbortController(); this.activeRuns.set(job.id, { job, controller });
        try { await this.advance(job, controller.signal); }
        catch (error) { if (!job.cancelRequestedAt&&!this.closed) { job.state = 'blocked'; job.error = String(error.message).slice(0, 1600); job.steps.find(step => step.id === job.stage).status = 'blocked'; this.save(job); } }
        finally { this.activeRuns.delete(job.id); }
      }
    });
  }
  assertAdvancing(job) { if (job.cancelRequestedAt) throw new WorkbenchError(409, '流程已请求取消，不再推进后续阶段。'); }
  completeStage(job, next) {
    this.assertAdvancing(job);
    job.steps.find(step => step.id === job.stage).status = 'completed';
    if (!next) job.state = 'completed';
    else { job.stage = next; if (job.state === 'pausing') job.state = 'paused'; }
    job.error = null; this.save(job);
  }
  requestId(job, stage) { return `${job.id}.${stage}.${job.attempts[stage]}`; }
  assertBound(job, stage, record) {
    if (record && (record.workflowId !== job.id || record.workflowStage !== stage)) throw new WorkbenchError(409, '阶段提交编号已绑定其他来源或流程；请取消此流程并使用新编号创建。');
  }
  async submitted(job, stage, submit) {
    this.assertAdvancing(job);
    const requestId = this.requestId(job, stage), existing = this.training.record(requestId);
    if (existing) {
      this.assertBound(job, stage, existing);
      const record = await this.training.submission(requestId);
      if (record.state === 'submitted') return record.result;
      if (['submitting', 'uncertain', 'checking'].includes(record.state)) throw new WorkbenchError(409, `提交 ${requestId} 尚未确认；已暂停流程，请核对任务后继续，不会重复提交。`);
      throw new WorkbenchError(409, '这次阶段提交已失败，点击继续可重新检查。');
    }
    return submit(requestId);
  }
  async terminal(id) {
    const task = await this.training.ownedTask(id);
    this.assertNoInterruptedProcess(task);
    if (activeTrainingStatuses.has(task.status)) return null;
    if (task.status !== 'FINISHED' || (task.returncode ?? task.metadata?.returncode) !== 0) throw new WorkbenchError(422, `阶段任务${task.status === 'TERMINATED' ? '已停止' : '失败'}：${task.metadata?.error || id}。后续阶段已暂停。`);
    return task;
  }
  assertNoInterruptedProcess(task) {
    if (/interrupted by server restart|服务重启导致任务中断/i.test(task.metadata?.error || '')) throw new WorkbenchError(409, '内核异常重启，尚未核实旧阶段进程是否结束；已保留待处理状态，禁止自动重交或声明取消成功。请先人工核对旧进程与产物。');
  }
  async advance(job, signal) {
    const step = job.steps.find(step => step.id === job.stage);
    if (job.state === 'pausing' && !job.tasks[job.stage]) { job.state = 'paused'; this.save(job); return; }
    step.status = 'running'; this.save(job);
    if (job.stage === 'plan') {
      if(job.input.captionPolicy!=='existing'&&job.input.captionSource==='connected'&&this.sharedAI?.config?.('training')?.enabled!==true)throw new WorkbenchError(409,'AI 打标需要启用训练模块或全局 AI 接入，并选择支持看图的模型。');
      let type;
      if (job.input.mode === 'train') {
        type=await this.training.type(job.config);
        assertWorkflowSupported({type,config:job.config,input:job.input});
      }
      if(job.input.memoryOptions){
        const {form}=await this.training.schema(job.config.model_train_type);
        try{job.config=applyMemoryOptions(form,job.config,job.input.memoryOptions);}catch(error){throw new WorkbenchError(422,error.message);}
      }
      this.assertAdvancing(job);
      if (job.input.planner === 'full') {
        const result = await buildQuickTrainingPlan(this.training, job.input, job.config, { signal }); this.assertAdvancing(job); job.plan = result.plan; job.config = result.config;
      } else { const plan = await buildPipelinePlan(job.input, this.sharedAI, job.config, { strategyVersion: job.version >= 3 ? 3 : 2, signal }); this.assertAdvancing(job); job.plan = plan; }
      if (!job.version) delete job.plan.strategy;
      if(type)assertWorkflowSupported({type,config:job.config,plan:job.plan});
      if(job.input.captionSource!=='connected'&&job.plan.strategy?.captionFormat==='natural'&&!job.input.captionModelPath&&this.training.captioners){
        const resources=await this.training.captioners.state();this.assertAdvancing(job);
        const florence=resources.items.find(item=>item.id==='florence2-base'&&item.ready);
        if(florence)job.input.captionModelPath=florence.modelPath;
      }
      this.completeStage(job, 'prepare');
    } else if (job.stage === 'prepare') {
      if(job.input.mode==='tag'&&job.outputDirectory)await prepareWorkflowOutput({directory:job.outputDirectory,owner:this.owner,id:job.id});
      this.assertAdvancing(job);
      job.dataset = await preparePipelineDataset({ root:job.input.mode==='tag'&&job.outputDirectory?job.outputDirectory:join(this.training.directory, 'workflows', job.id), sourcePath: job.input.sourcePath, owner: this.owner, input: job.input, plan: job.plan });
      job.summary = { imageCount: job.dataset.imageCount, originalCount: job.dataset.originalCount, derivedCount: 0, captioned: job.dataset.captioned, missing: job.dataset.missing, samples: [] }; this.completeStage(job, job.version >= 2 ? 'crop' : 'tag');
    } else if (job.stage === 'crop') {
      if (job.plan.strategy.cropMode === 'preserve') { this.completeStage(job, 'tag'); step.status = 'skipped'; this.save(job); return; }
      if (!job.tasks.crop) {
        const result = await this.submitted(job, 'crop', requestId => this.training.submitCrop({ requestId, signal, workflow: { id: job.id, stage: 'crop' }, config: { path: job.dataset.imageDir, purpose: job.plan.purpose, cropMode: job.plan.strategy.cropMode, detectorPath: job.input.detectorPath || '', allowDownload: job.input.allowDownload } }));
        job.tasks.crop = result.task_id; this.save(job);
      } else if (await this.terminal(job.tasks.crop)) {
        job.dataset = await readProcessedDataset(job.dataset, this.owner, this.requestId(job, 'crop'));
        job.summary = { ...job.summary, imageCount: job.dataset.imageCount, originalCount: job.dataset.originalCount, derivedCount: job.dataset.derivedCount, reviewCount: job.dataset.processing?.reviewCount || 0, reviews: job.dataset.processing?.reviews || [], missing: job.dataset.missing };
        this.completeStage(job, 'tag');
      }
    } else if (job.stage === 'tag') {
      if (!job.dataset.missing && !job.version) return this.completeStage(job, 'verify');
      if (job.dataset.missing && job.input.captionPolicy === 'existing') throw new WorkbenchError(422, `还有 ${job.dataset.missing} 张图片缺少匹配格式的标注，请先到「图集打标」补齐；裁切图需要重新标注。`);
      if(job.input.captionPolicy==='existing'){
        // Preparation binds the copied captions to image hashes; verify checks them
        // again before training, without loading or submitting a captioning model.
        this.completeStage(job,'verify');job.steps.find(step=>step.id==='tag').status='skipped';this.save(job);return;
      }
      if(job.input.captionSource==='connected'){
        job.dataset=await captionTrainingDataset({dataset:job.dataset,owner:this.owner,requestId:this.requestId(job,'tag'),input:job.input,plan:job.plan,sharedAI:this.sharedAI,signal,onProgress:progress=>{
          signal?.throwIfAborted();this.assertAdvancing(job);job.summary={...job.summary,captionProgress:progress};this.save(job);
        }});
        signal?.throwIfAborted();this.assertAdvancing(job);this.completeStage(job,'verify');return;
      }
      if (!job.tasks.tag) {
        const result = await this.submitted(job, 'tag', requestId => this.training.submitTag({ requestId, signal, workflow: { id: job.id, stage: 'tag' }, config: { path: job.dataset.imageDir, model: job.input.taggerModel, allowDownload: job.input.allowDownload, trigger: job.plan.trigger, policy: job.input.captionPolicy, ...(job.version>=3?{captionOperationId:job.id+'.tag'}:{}), ...(job.input.taggerOptions?{taggerOptions:job.input.taggerOptions}:{}), ...(job.version >= 2 ? { purpose: job.plan.purpose, captionFormat: job.plan.strategy.captionFormat, captionModelPath: job.input.captionModelPath || '' } : {}) } }));
        job.tasks.tag = result.task_id; this.save(job);
      } else if (await this.terminal(job.tasks.tag)) {
        if (job.dataset.format >= 2) job.dataset = await readProcessedDataset(job.dataset, this.owner, null, { captionRequestId: this.requestId(job, 'tag'), captionFormat: job.plan.strategy?.captionFormat || 'tags' });
        this.completeStage(job, 'verify');
      }
    } else if (job.stage === 'verify') {
      job.summary = await verifyPipelineDataset(job.dataset, job.config, job.plan);
      this.completeStage(job, job.input.mode === 'tag' ? null : 'train');
      if (job.input.mode === 'tag') { job.steps.find(item => item.id === 'train').status = 'skipped'; this.save(job); }
    } else if (job.stage === 'train') {
      if (!job.tasks.train) {
        if(job.outputDirectory)await prepareWorkflowOutput({directory:job.outputDirectory,owner:this.owner,id:job.id});
        this.assertAdvancing(job);
        const type=await this.training.type(job.config),{form}=await this.training.schema(job.config.model_train_type);
        let config={...job.config,...workflowPolicy(form,job.plan.strategy)};
        if(job.input.planner!=='full')config=basicWorkflowParameters(form,formDefaults(form,config),job.plan);
        config=await prepareWorkflowTrainingConfig({config,dataset:job.dataset,summary:job.summary,plan:job.plan,engine:type.engine,signal});
        Object.assign(config,{output_dir:job.outputDirectory||join(job.dataset.workspace,'output'),output_name:`lora-${job.id}`});
        try{config=applyMemoryOptions(form,config,job.input.memoryOptions||{});}catch(error){throw new WorkbenchError(422,error.message);}
        config=trainingSubmission(form,config);
        job.trainingConfig = config; this.save(job);
        const result = await this.submitted(job, 'train', requestId => this.training.submit({ requestId, config, signal, workflow: { id: job.id, stage: 'train' } }));
        job.tasks.train = result.task_id; this.save(job);
      } else if (await this.terminal(job.tasks.train)) {
        job.outputs = (await this.training.task(job.tasks.train)).outputs || [];
        if (!job.outputs.some(file => /\.(?:safetensors|ckpt|pt)$/i.test(file.name || file.path || ''))) throw new WorkbenchError(422, '训练进程已结束，但尚未找到权重文件；请查看任务日志和产物。');
        this.completeStage(job, null);
      }
    }
  }
  async pause(id) {
    return this.locked(() => {
      const job = this.record(id);
      if (job.state === 'running') { job.state = job.tasks[job.stage] ? 'pausing' : 'paused'; this.save(job); }
      return this.get(id);
    });
  }
  async resume(id) {
    return this.locked(async () => {
      const job = this.record(id);
      if (job.cancelRequestedAt) throw new WorkbenchError(409, '流程已请求取消，请先核对并完成取消。');
      if (!['paused', 'blocked'].includes(job.state)) throw new WorkbenchError(409, '只有暂停或待处理的流程可以继续。');
      for (const stage of ['crop', 'tag', 'train']) if (stage === job.stage) {
        const requestId = this.requestId(job, stage); let record = this.training.record(requestId);
        this.assertBound(job, stage, record);
        if (record || job.tasks[stage]) {
          await this.training.runtime.start(this.training.config());
          record = await this.training.submission(requestId);
          if (record.state === 'submitted' && record.result?.task_id) { job.tasks[stage] = record.result.task_id; this.save(job); }
          if (['checking', 'submitting', 'uncertain'].includes(record.state)) throw new WorkbenchError(409, '原阶段提交仍未确认；请核对内核与任务，不能重复创建。');
        }
        if (record?.state === 'failed') { job.attempts[stage]++; job.tasks[stage] = null; }
        if (job.tasks[stage]) {
          const task = await this.training.ownedTask(job.tasks[stage]);
          this.assertNoInterruptedProcess(task);
          if (!activeTrainingStatuses.has(task.status) && !(task.status === 'FINISHED' && (task.returncode ?? task.metadata?.returncode) === 0)) { job.attempts[stage]++; job.tasks[stage] = null; }
          else await this.training.resumeHeldTask(job.tasks[stage]);
        }
      }
      job.state = 'running'; job.error = null; this.save(job); this.schedule(); return this.get(id);
    });
  }
  async cancel(id) {
    const active = this.activeRuns.get(id), job = active?.job || this.record(id);
    if (['completed', 'cancelled'].includes(job.state)) return this.get(id);
    job.cancelRequestedAt ||= now(); job.state = 'cancelling'; job.error = null; this.save(job);
    active?.controller.abort();
    // Local/AI planning has no external submission to reconcile. Its late result
    // is rejected at the stage commit boundary, even if a provider ignores abort.
    const hasSubmission = ['crop', 'tag', 'train'].some(stage => job.tasks[stage] || this.training.record(this.requestId(job, stage)));
    if (!hasSubmission && !['crop', 'tag', 'train'].includes(job.stage)) { job.state = 'cancelled'; this.save(job); return this.get(id); }
    return this.locked(async () => {
      const job = this.record(id);
      if (['completed', 'cancelled'].includes(job.state)) return this.get(id);
      // A lost response may have created work; reconcile before declaring cancel.
      for (const stage of ['crop', 'tag', 'train']) {
        if (job.attempts[stage] === undefined) continue;
        const binding = this.training.record(this.requestId(job, stage));
        if (!binding || binding.workflowId !== job.id || binding.workflowStage !== stage) continue;
        const record = await this.training.submission(this.requestId(job, stage));
        if (['uncertain', 'submitting', 'checking'].includes(record.state)) throw new WorkbenchError(409, '仍有未确认的提交，请先恢复内核并核对，再取消流程。');
        const taskId = job.tasks[stage] || record.result?.task_id;
        if (taskId) { this.assertNoInterruptedProcess(await this.training.ownedTask(taskId)); const stopped = await this.training.stopTask(taskId); if (!stopped.stopped) throw new WorkbenchError(409, '阶段任务仍在停止中，请稍后再次取消。'); }
      }
      job.state = 'cancelled'; job.error = null; this.save(job); return this.get(id);
    }).catch(error => { const current = this.record(id); if (current.state === 'cancelling') { current.state = 'blocked'; current.error = String(error.message).slice(0, 1600); this.save(current); } throw error; });
  }
  assertRemovable() { if (this.records().some(job => !['completed', 'cancelled'].includes(job.state))) throw new WorkbenchError(409, '此实例有未完成的一键流程，请先完成或取消流程后再移除。'); }
  async sample(id, index) {
    this.training.assertOpen(); const job = this.record(id), number = Number(index), sample = job.summary?.samples?.[number];
    if (!/^\d{1,2}$/.test(String(index)) || !sample || !job.dataset.items.some(item => item.name === sample.image)) throw new WorkbenchError(404, '找不到当前流程的样本。');
    const path = join(job.dataset.imageDir, sample.image), info = await regularLocal(path);
    if (info.size > 100 * 1024 * 1024) throw new WorkbenchError(413, '样本图像过大。');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[extname(path).toLowerCase()];
    if (!mime) throw new WorkbenchError(404, '样本类型无效。'); return { bytes: await readFile(path), mime };
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);for(const active of this.activeRuns.values())active.controller.abort();await this.serial;
    for (const job of this.records()) if (['running', 'pausing'].includes(job.state)) { job.state = 'paused'; job.error = '工作台已关闭，已提交任务保留；重新打开后点击继续。'; this.save(job); }
  }
}
