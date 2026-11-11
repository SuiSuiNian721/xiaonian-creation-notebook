import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { LoraTraining } from '../framework/training.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'training-quick-')), source = join(directory, 'source');
  await mkdir(source); await writeFile(join(source, 'one.png'), png); await mkdir(join(directory, 'tokenizer'));
  for (const file of ['base.safetensors', 'text.safetensors', 'vae.safetensors']) await writeFile(join(directory, file), 'test weight placeholder');
  const config = { model_train_type: 'moss-image-lora', pretrained_model_name_or_path: join(directory, 'base.safetensors'), text_encoder: join(directory, 'text.safetensors'), vae: join(directory, 'vae.safetensors'), tokenizer_cache_dir: join(directory, 'tokenizer'), resolution: '512,512', custom_advanced: '保留参数' };
  const calls = [], tasks = [], control = { enabled: true, aiCalls: 0, suggestion: { summary: '按图集推荐参数', configPatch: { network_dim: 32, gradient_accumulation_steps: 3, max_train_steps: 120, learning_rate: '2e-4' } } };
  const ai = { config: () => ({ enabled: control.enabled }), async complete(messages) { control.aiCalls++; control.messages = messages; return { text: JSON.stringify(control.suggestion) }; } };
  const runtime = { async state() { return { status: 'stopped' }; }, async start() { calls.push({ path: 'start' }); }, async close() {}, async request(method, path, options = {}) {
    calls.push({ method, path, ...options });
    if (path === '/api/config/validate-import') return { result: 'ok', config: options.body.config };
    if (path.endsWith('/status')) return { state: 'ready' };
    if (path.endsWith('/preflight') || path === '/api/tagger/check') return { ok: true };
    if (path === '/api/run' || path === '/api/tagger/run') { const task = { id: 'task-' + (tasks.length + 1), status: 'RUNNING', metadata: { workbench_owner: options.owner, workbench_request: options.requestId, source_config: options.body } }; tasks.push(task); return { task_id: task.id }; }
    if (path === '/api/tasks') return { tasks };
    if (path.endsWith('/config')) return { config: tasks.find(task => path.includes(task.id))?.metadata.source_config || {} };
    return {};
  } };
  const service = new LoraTraining({ dataDir: join(directory, 'profile'), store: { module: () => ({ config: { trainerPath: directory } }) }, runtime, sharedAI: ai, pipelineOptions: { autoRun: false } });
  service.savedConfigs = async () => ({ configs: [] });
  t.after(async () => { await service.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const request = { requestId: 'quick-1', input: { sourcePath: source, captionFormat: 'tags', goal: '训练角色外貌' }, config };
  const tick = async id => { await service.pipeline.tick(id); return service.pipeline.get(id).job; };
  return { directory, source, config, calls, tasks, control, service, request, tick };
}

test('一键训练必须连接 AI；未接入时不创建流程、不启动内核', async t => {
  const f = await fixture(t); f.control.enabled = false;
  await assert.rejects(f.service.quickStart(f.request), /AI|接入/);
  assert.deepEqual(f.service.pipeline.list().jobs, []); assert.deepEqual(f.calls, []); assert.equal(f.control.aiCalls, 0);
});

test('一键显存选项由用户确定，AI 推荐和默认方案均保留显式选择',async t=>{
  const f=await fixture(t);
  for(const mode of ['recommended','defaults']){
    f.control.suggestion={summary:'方案',configPatch:mode==='recommended'?{gradient_accumulation_steps:2,gradient_checkpointing:false,network_dim:32}:{}};
    const created=await f.service.quickStart({...f.request,requestId:'memory-'+mode,input:{...f.request.input,parameterMode:mode,memoryOptions:{gradient_accumulation_steps:4,gradient_checkpointing:true}}});
    const job=await f.tick(created.job.id);assert.notEqual(job.state,'blocked',job.error);
    assert.equal(job.configuration.gradient_accumulation_steps,4);assert.equal(job.configuration.gradient_checkpointing,true);
    const request=JSON.parse(f.control.messages[1].content);
    assert.deepEqual(request.fixedMemoryOptions,{gradient_accumulation_steps:4,gradient_checkpointing:true});
    assert.ok(request.allowedParameters.every(field=>!['gradient_accumulation_steps','gradient_checkpointing'].includes(field.key)));
  }
});

test('显存选项拒绝非法值和当前训练器不支持的梯度累积',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.quickStart({...f.request,input:{...f.request.input,memoryOptions:{gradient_accumulation_steps:0}}}),/显存|梯度|累积/);
  const created=await f.service.quickStart({...f.request,requestId:'unsupported-accumulation',input:{...f.request.input,mode:'tag',memoryOptions:{gradient_accumulation_steps:2}},config:{model_train_type:'moss-image-anima-lora'}});
  const job=await f.tick(created.job.id);assert.equal(job.state,'blocked');assert.match(job.error,/不支持.*gradient_accumulation_steps/);assert.equal(f.control.aiCalls,0);
});

test('原生 MOSS 与 DiffSynth 一键参数不注入 Kohya 专属键，时长和显存保持原生语义',async t=>{
  const f=await fixture(t);f.control.suggestion={summary:'原生默认参数',configPatch:{}};
  for(const [type,config,memoryOptions,durationKey,duration] of [
    ['moss-image-anima-lora',{model_dir:f.directory,epochs:3,max_steps:40},{grad_checkpointing:false},'epochs',3],
    ['qwen-image-21-lora',{model_input_mode:'comfyui_files',dit_path:f.config.pretrained_model_name_or_path,text_encoder_path:f.config.text_encoder,vae_path:f.config.vae,num_epochs:4},{gradient_accumulation_steps:2,use_gradient_checkpointing:true},'num_epochs',4],
  ]){
    const {job:created}=await f.service.quickStart({...f.request,requestId:'native-'+type,input:{...f.request.input,parameterMode:'defaults',memoryOptions},config:{model_train_type:type,...config}});
    const job=await f.tick(created.id);assert.notEqual(job.state,'blocked',job.error);
    assert.equal(job.configuration[durationKey],duration);
    for(const [key,value] of Object.entries(memoryOptions))assert.equal(job.configuration[key],value);
    for(const key of ['max_train_epochs','max_train_steps','keep_tokens','color_aug','token_warmup_step'])assert.equal(Object.hasOwn(job.configuration,key),false,key);
    if(type==='moss-image-anima-lora'){
      for(const key of ['network_dim','network_alpha','learning_rate','enable_bucket','bucket_reso_steps','shuffle_caption'])assert.equal(Object.hasOwn(job.configuration,key),false,key);
      assert.equal(job.configuration.max_steps,40);assert.equal(job.plan.steps,40);
    }else assert.equal(job.plan.steps,null);
    const sent=JSON.parse(f.control.messages[1].content);assert.equal(sent.duration.epochKey,durationKey);
  }
});

test('实际 quick-start 规划使用可中止的 AI 请求，取消后不提交参数或训练',async t=>{
  const f=await fixture(t);let enter,options;
  const entered=new Promise(done=>{enter=done;});
  f.service.sharedAI.complete=(_messages,opts)=>{options=opts;enter();return new Promise((_done,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));};
  const {job}=await f.service.quickStart(f.request),ticking=f.service.pipeline.tick(job.id);await entered;
  assert.ok(options.signal instanceof AbortSignal);assert.equal(options.timeoutMs,90000);
  const result=await f.service.pipeline.cancel(job.id);await ticking;
  assert.equal(result.job.state,'cancelled');assert.equal(result.job.stage,'plan');assert.equal(result.job.plan,null);
  assert.equal(options.signal.aborted,true);assert.equal(f.tasks.length,0);
});

test('Krea and Qwen quick workflows use the native model field without requiring a Kohya checkpoint field',async t=>{
  const f=await fixture(t);f.control.suggestion={summary:'采用原生默认值',configPatch:{}};
  for(const [type,key,extra] of [['krea2-lora','dit',{}],['qwen-image-21-lora','dit_path',{model_input_mode:'comfyui_files',text_encoder_path:f.config.text_encoder,vae_path:f.config.vae}]]){
    const created=await f.service.quickStart({...f.request,requestId:type,input:{...f.request.input,parameterMode:'defaults'},config:{model_train_type:type,[key]:f.config.pretrained_model_name_or_path,...extra}});
    const planned=await f.tick(created.job.id);assert.notEqual(planned.state,'blocked',planned.error);assert.equal(planned.configuration[key],f.config.pretrained_model_name_or_path);assert.equal(Object.hasOwn(planned.configuration,'pretrained_model_name_or_path'),false);
  }
});

test('AI 推荐参数实际进入训练提交、展示快照和稳定编号重放', async t => {
  const f = await fixture(t), first = await f.service.quickStart(f.request);
  let job = await f.tick(first.job.id);
  assert.equal(job.plan.aiUsed, true); assert.equal(job.configuration.network_dim, 32); assert.equal(job.configuration.max_train_steps, 120);
  assert.equal(Object.hasOwn(job.configuration, 'max_train_epochs'), false);
  assert.equal(JSON.stringify(f.control.messages).includes(f.directory), false, '不向规划模型发送本地绝对路径');
  for (let n = 0; n < 6 && !job.tasks.tag; n++) job = await f.tick(job.id);
  assert.equal(job.tasks.crop, null);
  const tag = f.tasks.find(task => task.id === job.tasks.tag), manifestPath = join(job.workspace, 'dataset-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const item of manifest.items) { const caption = '1girl, standing, blue eyes'; await writeFile(join(manifest.imageDir, item.name.replace(/\.png$/, '.txt')), caption); Object.assign(item, { requiresCaption: false, captionImageSha256: item.sha256, captionFormat: 'tags', captionSha256: createHash('sha256').update(caption).digest('hex') }); }
  manifest.captions = { complete: true, requestId: tag.metadata.workbench_request, format: 'tags' }; await writeFile(manifestPath, JSON.stringify(manifest)); tag.status = 'FINISHED'; tag.returncode = 0;
  for (let n = 0; n < 5 && !job.tasks.train; n++) job = await f.tick(job.id);
  const submitted = f.calls.find(call => call.path === '/api/run').body;
  assert.equal(submitted.network_dim, 32); assert.equal(submitted.gradient_accumulation_steps, 3); assert.equal(submitted.max_train_steps, 120); assert.equal(Number(submitted.learning_rate), 0.0002); assert.equal(Number(submitted.unet_lr), 0.0002);
  assert.equal(submitted.custom_advanced, '保留参数'); assert.equal(Object.hasOwn(submitted, 'max_train_epochs'), false);
  f.control.enabled = false;
  assert.equal((await f.service.quickStart(f.request)).reused, true, '已接受的请求可在 AI 断开后核对');
  assert.equal(f.control.aiCalls, 1); assert.equal(f.calls.filter(call => call.path === '/api/run').length, 1);
});

test('默认参数方案保留训练器轮数默认，非法路径、越界和默认方案改参均阻断', async t => {
  const f = await fixture(t);
  f.control.suggestion = { summary: '沿用默认参数', configPatch: {} };
  const defaults = await f.service.quickStart({ ...f.request, requestId: 'defaults', input: { ...f.request.input, parameterMode: 'defaults' } });
  const job = await f.tick(defaults.job.id); assert.equal(job.configuration.max_train_epochs, 8); assert.equal(Object.hasOwn(job.configuration, 'max_train_steps'), false);
  const steps = await f.service.quickStart({ ...f.request, requestId: 'defaults-steps', input: { ...f.request.input, parameterMode: 'defaults' }, config: { ...f.config, max_train_steps: 100 } });
  const stepJob = await f.tick(steps.job.id); assert.equal(stepJob.configuration.max_train_steps, 100); assert.equal(Object.hasOwn(stepJob.configuration, 'max_train_epochs'), false, '原生默认轮数不能覆盖显式步数模式');
  for (const [id, patch, mode] of [['path', { output_dir: 'C:\\other' }, 'recommended'], ['range', { network_dim: 99999 }, 'recommended'], ['defaults-change', { network_dim: 64 }, 'defaults']]) {
    f.control.suggestion = { summary: '无效建议', configPatch: patch };
    const created = await f.service.quickStart({ ...f.request, requestId: id, input: { ...f.request.input, parameterMode: mode } });
    const blocked = await f.tick(created.job.id); assert.equal(blocked.state, 'blocked'); assert.match(blocked.error, /参数|路径|默认|范围|修改/);
  }
  assert.equal(f.calls.filter(call => call.path === '/api/run').length, 0);
});

test('模型组件从同一底模的保存参数补齐，确实缺少时明确报告且不请求 AI', async t => {
  const f = await fixture(t), partial = { model_train_type: f.config.model_train_type, pretrained_model_name_or_path: f.config.pretrained_model_name_or_path };
  const missing = await f.service.quickStart({ ...f.request, requestId: 'missing-models', config: partial });
  const blocked = await f.tick(missing.job.id); assert.equal(blocked.state, 'blocked'); assert.match(blocked.error, /text_encoder|文本编码器/); assert.equal(f.control.aiCalls, 0);
  f.service.savedConfigs = async () => ({ configs: [{ id: 'saved-model', config: f.config }] });
  const matched = await f.service.quickStart({ ...f.request, requestId: 'matched-models', config: partial });
  const planned = await f.tick(matched.job.id); assert.equal(planned.configuration.text_encoder, f.config.text_encoder); assert.equal(planned.state, 'running');
  f.service.savedConfigs = async () => ({ configs: [] });
  f.service.savePreset({ name: '工作台同底模方案', config: f.config });
  const local = await f.service.quickStart({ ...f.request, requestId: 'local-models', config: partial });
  assert.equal((await f.tick(local.job.id)).configuration.text_encoder, f.config.text_encoder);
});

test('各底模的必需组件均从同底模补齐，新 Anima 默认分桶 16；AI 不替换网络类型', async t => {
  const f = await fixture(t);
  f.control.suggestion = { summary: '默认方案', configPatch: {} };
  for (const [type, keys] of [['anima-lora',['qwen3','vae']],['flux-lora',['clip_l','t5xxl','ae']],['lumina-lora',['gemma2','ae']]]) {
    const config = { model_train_type: type, pretrained_model_name_or_path: f.config.pretrained_model_name_or_path, ...Object.fromEntries(keys.map(key=>[key,f.config.text_encoder])) };
    f.service.savedConfigs = async () => ({ configs: [{config}] });
    const created = await f.service.quickStart({ ...f.request, requestId: type, config: { model_train_type:type,pretrained_model_name_or_path:config.pretrained_model_name_or_path } });
    const job = await f.tick(created.job.id);assert.equal(job.state,'running',job.error);
    for (const key of keys) assert.equal(job.configuration[key],config[key]);
    if(type==='anima-lora')assert.equal(job.configuration.bucket_reso_steps,16);
  }
  f.control.suggestion = { summary: '切换网络', configPatch: { lora_type: 'lokr' } };
  const changed = await f.service.quickStart({ ...f.request, requestId:'no-network-change' });
  assert.equal((await f.tick(changed.job.id)).state,'blocked');
  f.control.suggestion = { summary:'双时长',configPatch:{} };
  const both = await f.service.quickStart({ ...f.request, requestId:'double-duration',config:{...f.config,max_train_steps:100,max_train_epochs:8} });
  assert.match((await f.tick(both.job.id)).error,/步数|轮数/);
});
