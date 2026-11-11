import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LoraTraining } from '../framework/training.mjs';
import { createHash } from 'node:crypto';
import { pipelineInput } from '../framework/training-plan.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'training-pipeline-'));
  const source = join(directory, 'source'); await mkdir(source);
  await writeFile(join(source, 'one.png'), png);
  const tasks = [], calls = []; let aiCalls = 0;
  const runtime = {
    async state() { return { status: 'running' }; }, async start() {}, async close() {},
    async request(method, path, options = {}) {
      calls.push({ method, path, ...options });
      if (path === '/api/config/validate-import') return { result: 'ok', config: options.body.config };
      if (path.endsWith('/status')) return { state: 'ready' };
      if (path.endsWith('/preflight') || path === '/api/tagger/check' || path === '/api/preprocess/check') return { ok: true };
      if (path === '/api/run' || path === '/api/tagger/run' || path === '/api/preprocess/run') {
        const task = { id: 'task-' + (tasks.length + 1), status: 'RUNNING', returncode: null, metadata: { workbench_owner: options.owner, workbench_request: options.requestId, source_config: options.body, stage: path.includes('tagger') ? 'tagging' : path.includes('preprocess') ? 'cropping' : 'training' } };
        tasks.push(task); return { task_id: task.id };
      }
      if (path === '/api/tasks') return { tasks };
      if (path.includes('/terminate/')) { tasks.find(task => task.id === path.split('/').at(-1)).status = 'TERMINATED'; return {}; }
      if (path.endsWith('/resume')) { tasks.find(task => path.includes('/' + task.id + '/')).metadata.held = false; return { resumed: true }; }
      if (path.endsWith('/config')) return { config: tasks.find(task => path.includes('/' + task.id + '/'))?.metadata.source_config || {} };
      return {};
    },
  };
  const store = { module: () => ({ config: { trainerPath: directory } }) };
  const sharedAI = { async complete() { aiCalls++; return { text: JSON.stringify({ purpose: 'style', trigger: 'quiet_style', steps: 64, repeats: 2, rank: 8, learningRate: 0.0001, summary: '使用画风方案' }) }; } };
  const options = { store, dataDir: join(directory, 'profile'), runtime, sharedAI, pipelineOptions: { autoRun: false } };
  const training = new LoraTraining(options), services = [training];
  t.after(async () => {
    for (const service of services) await service.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const input = { sourcePath: source, goal: '学习这个角色', purpose: 'character', trigger: 'test_character', aiEnabled: false, mode: 'train', captionPolicy: 'fill-missing', allowDownload: false, cropMode: 'none', captionFormat: 'tags' };
  const config = { model_train_type: 'moss-image-lora', pretrained_model_name_or_path: join(directory, 'base.safetensors'), resolution: '512,512', custom_option: '保留高级参数' };
  await writeFile(config.pretrained_model_name_or_path, 'fixture model');
  const tick = async id => { await training.pipeline.tick(id); return training.pipeline.get(id).job; };
  async function toTag(id) { let job; for (let n = 0; n < 8; n++) { job = await tick(id); if (job.tasks.tag || ['blocked', 'completed'].includes(job.state)) return job; } return job; }
  async function finishTag(job, success = true) {
    const task = tasks.find(task => task.id === job.tasks.tag); task.status = 'FINISHED'; task.returncode = success ? 0 : 1;
    if (success) {
      const manifest = JSON.parse(await readFile(join(job.workspace, 'dataset-manifest.json'), 'utf8'));
      const format = task.metadata.source_config.captionFormat || 'tags';
      for (const item of manifest.items) {
        const text = format === 'natural' ? 'test_character. A cat is standing beside a telescope in a quiet room.' : 'test_character, a cat';
        await writeFile(join(job.workspace, 'images', item.name.replace(/\.png$/, '.txt')), text);
        Object.assign(item, { requiresCaption: false, captionImageSha256: item.sha256, captionFormat: format, captionSha256: createHash('sha256').update(text).digest('hex') });
      }
      manifest.captions = { complete: true, requestId: task.metadata.workbench_request, format };
      await writeFile(join(job.workspace, 'dataset-manifest.json'), JSON.stringify(manifest));
    }
  }
  return { directory, source, training, options, services, input, config, runtime, sharedAI, tasks, calls, tick, toTag, finishTag, get aiCalls() { return aiCalls; } };
}

test('打标检查与执行均绑定当前实例的模型资源目录', async t => {
  const f = await fixture(t);
  const {job} = await f.training.pipeline.create({requestId:'instance-caption-root',input:{...f.input,mode:'tag'},config:{}});
  for(let n=0;n<8;n++){const current=await f.tick(job.id);if(current.tasks.tag||current.state==='blocked')break;}
  for(const path of ['/api/tagger/check','/api/tagger/run']){
    const call=f.calls.find(call=>call.path===path);
    assert.ok(call,path);
    assert.equal(call.body.captionResourceRoot,f.training.directory);
  }
});

test('仅使用已有标注时跳过打标模型，校验后进入训练', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'one.txt'), 'test_character, a cat');
  const {job: created} = await f.training.pipeline.create({requestId:'existing-only',input:{...f.input,captionPolicy:'existing',captionSource:'connected'},config:f.config});
  let job;
  for(let n=0;n<10;n++){job=await f.tick(created.id);if(job.tasks.train||job.state==='blocked')break;}
  assert.equal(f.calls.some(call=>call.path.startsWith('/api/tagger/')),false);
  assert.equal(f.aiCalls,0);
  assert.ok(job.tasks.train,JSON.stringify(job));
  assert.equal(job.steps.find(step=>step.id==='tag').status,'skipped');
});

test('一键训练不接入 AI，按顺序打标和训练，保持源图与原标注', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'two.png'), png); await writeFile(join(f.source, 'two.txt'), 'original caption');
  const { job: created } = await f.training.pipeline.create({ requestId: 'flow-1', input: f.input, config: f.config });
  let job = await f.toTag(created.id); assert.ok(job.tasks.tag); assert.equal(f.aiCalls, 0);
  assert.equal(f.calls.filter(call => call.path === '/api/run').length, 0);
  assert.notEqual(job.workspace, f.source);
  await f.finishTag(job);
  for (let n = 0; n < 5 && !job.tasks.train; n++) job = await f.tick(created.id);
  assert.ok(job.tasks.train); const submitted = f.calls.find(call => call.path === '/api/run').body;
  assert.equal(submitted.custom_option, '保留高级参数'); assert.ok(submitted.dataset_config.startsWith(job.workspace));
  assert.equal(Object.hasOwn(submitted, 'max_train_epochs'), false);
  assert.match(await readFile(submitted.dataset_config, 'utf8'), /num_repeats/);
  const train = f.tasks.find(task => task.id === job.tasks.train); train.status = 'FINISHED'; train.returncode = 0;
  await mkdir(submitted.output_dir, { recursive: true }); await writeFile(join(submitted.output_dir, submitted.output_name + '.safetensors'), 'fixture weights');
  for (let n = 0; n < 3 && job.state !== 'completed'; n++) job = await f.tick(created.id);
  assert.equal(job.state, 'completed'); assert.equal(job.outputs.length, 1);
  assert.deepEqual(await readFile(join(f.source, 'one.png')), png);
  assert.equal(await readFile(join(f.source, 'two.txt'), 'utf8'), 'original caption');
  assert.deepEqual((await readdir(f.source)).sort(), ['one.png', 'two.png', 'two.txt']);
});

test('原生引擎的一键提交使用对应图集与参数键，保留用户显存选项',async t=>{
  const f=await fixture(t);
  for(const [type,native,memoryOptions,sourceKey] of [
    ['moss-image-anima-lora',{model_dir:f.directory,resolution:512},{grad_checkpointing:false},'src'],
    ['qwen-image-21-lora',{diffsynth_model_dir:f.directory,num_epochs:4},{gradient_accumulation_steps:3,use_gradient_checkpointing:true},'train_data_dir'],
  ]){
    const {job:created}=await f.training.pipeline.create({requestId:'native-'+type,input:{...f.input,memoryOptions},config:{model_train_type:type,...native}});
    let job=await f.toTag(created.id);assert.ok(job.tasks.tag,job.error);await f.finishTag(job);
    for(let i=0;i<5&&!job.tasks.train;i++)job=await f.tick(job.id);
    assert.ok(job.tasks.train,job.error);
    const config=f.tasks.find(task=>task.id===job.tasks.train).metadata.source_config;
    assert.equal(config[sourceKey],join(job.workspace,'images'));
    assert.equal(Object.hasOwn(config,'dataset_config'),false);
    for(const [key,value]of Object.entries(memoryOptions))assert.equal(config[key],value);
    for(const key of ['max_train_steps','max_train_epochs','keep_tokens','token_warmup_step'])assert.equal(Object.hasOwn(config,key),false,key);
    if(type==='moss-image-anima-lora'){
      assert.equal(config.rank,f.input.rank??16);assert.equal(config.max_steps,1000);
      for(const key of ['network_dim','learning_rate','caption_extension','enable_bucket'])assert.equal(Object.hasOwn(config,key),false,key);
    }else{assert.equal(config.num_epochs,4);assert.equal(config.dataset_repeat,5);assert.equal(config.dataset_format,'image_text');}
  }
});

test('可选接入 AI 逐图标注并结束图集流程，不提交本地打标或训练任务',async t=>{
  const f=await fixture(t);let images=0;
  f.sharedAI.config=()=>({enabled:true});f.sharedAI.complete=async(messages,options)=>{
    images++;assert.equal(options.policy,'chat-only-vision');assert.equal(options.images.length,1);
    assert.match(messages[0].content,/身份绑定/);return{text:'1girl, blue dress, standing'};
  };
  const {job:created}=await f.training.pipeline.create({requestId:'connected-captions',input:{...f.input,mode:'tag',captionSource:'connected'},config:f.config});
  let job=created;for(let i=0;i<8&&job.state==='running';i++)job=await f.tick(job.id);
  assert.equal(job.state,'completed',job.error);assert.equal(images,1);assert.equal(job.tasks.tag,null);
  assert.equal(job.summary.captioned,1);assert.deepEqual(f.calls,[]);
  assert.equal(await readFile(join(f.source,'one.png'),'base64'),png.toString('base64'));
  assert.match(await readFile(join(job.workspace,'images/originals/000001.txt'),'utf8'),/^test_character, 1girl, blue dress, standing/);
});

test('切换 AI 或自然语言时不让隐藏的无效本地标签草稿阻止提交',async t=>{
  const f=await fixture(t);
  for(const selection of [{captionSource:'connected'},{captionFormat:'natural'}]){
    const result=pipelineInput({...f.input,...selection,taggerOptions:{threshold:null}});
    assert.equal(Object.hasOwn(result,'taggerOptions'),false);
  }
});

test('AI 逐图标注期间取消或关闭会中止请求，迟到结果不写入图集',async t=>{
  for(const operation of ['cancel','close']){
    const f=await fixture(t);let entered,late;const waiting=new Promise(done=>{entered=done;});
    f.sharedAI.config=()=>({enabled:true});f.sharedAI.complete=async()=>{entered();return await new Promise(done=>{late=done;});};
    const {job:created}=await f.training.pipeline.create({requestId:'caption-'+operation,input:{...f.input,mode:'tag',captionSource:'connected'},config:f.config});
    for(let i=0;i<3;i++)await f.tick(created.id);
    const ticking=f.tick(created.id);await waiting;
    if(operation==='cancel')await f.training.pipeline.cancel(created.id);else await f.training.pipeline.close();
    await ticking;late({text:'1girl, blue dress, standing'});await new Promise(done=>setImmediate(done));
    const job=f.training.pipeline.get(created.id).job;assert.equal(job.state,operation==='cancel'?'cancelled':'paused');
    await assert.rejects(readFile(join(job.workspace,'images/originals/000001.txt')),error=>error.code==='ENOENT');
    assert.deepEqual(f.calls,[]);
  }
});

test('原生标签递归和冲突参数贯穿源扫描与本地提交',async t=>{
  const f=await fixture(t);await mkdir(join(f.source,'nested'));await writeFile(join(f.source,'nested/two.png'),png);
  const taggerOptions={batch_input_recursive:false,threshold:0.45,batch_output_action_on_conflict:'prepend'};
  const {job:created}=await f.training.pipeline.create({requestId:'native-tagger',input:{...f.input,mode:'tag',taggerModel:'cl_tagger_1_01',taggerOptions},config:f.config});
  const job=await f.toTag(created.id);assert.ok(job.tasks.tag,job.error);assert.equal(job.summary.imageCount,1);
  const request=f.tasks.find(task=>task.id===job.tasks.tag).metadata.source_config;
  assert.equal(request.model,'cl_tagger_1_01');assert.equal(request.taggerOptions.threshold,0.45);assert.equal(request.taggerOptions.batch_output_action_on_conflict,'prepend');
  assert.equal(request.captionOperationId,'native-tagger.tag');
});

test('仅处理图集也可选择输出位置，受管副本保存在选择的目录内',async t=>{
  const f=await fixture(t),destination=join(f.directory,'导出图集');
  const {job:created}=await f.training.pipeline.create({requestId:'tag-output',input:{...f.input,mode:'tag'},config:{...f.config,output_dir:destination}});
  const job=await f.toTag(created.id);assert.ok(job.tasks.tag,job.error);
  assert.ok(job.outputDirectory.startsWith(destination+sep));assert.ok(job.workspace.startsWith(job.outputDirectory+sep));
  assert.equal(await readFile(join(f.source,'one.png'),'base64'),png.toString('base64'));
  const {captionResourceRoot,...request}=f.tasks.find(task=>task.id===job.tasks.tag).metadata.source_config;
  await assert.rejects(f.training.submitTag({requestId:'forged-output',workflow:{id:job.id,stage:'tag'},config:{...request,path:f.source}}),/工作副本/);
  await assert.rejects(f.training.submitTag({requestId:'forged-resources',workflow:{id:job.id,stage:'tag'},config:{...request,captionResourceRoot:f.source}}),/格式无效/);
});

test('本地打标器可随底模自动匹配，也可手动覆盖格式与模型',async t=>{
  const f=await fixture(t);
  for(const [name,captioner,format,expectedModel]of [['auto','auto','natural',null],['manual-tag','wd-vit-v3','tags','wd-vit-v3'],['manual-natural','florence2','natural',null]]){
    const {job:created}=await f.training.pipeline.create({requestId:'captioner-'+name,input:{...f.input,mode:'tag',captionFormat:'auto',captioner},config:f.config});
    const job=await f.toTag(created.id);assert.ok(job.tasks.tag,job.error);
    const request=f.tasks.find(task=>task.id===job.tasks.tag).metadata.source_config;
    assert.equal(request.captionFormat,format);if(expectedModel)assert.equal(request.model,expectedModel);
  }
});

test('自动自然语言打标复用已发现的 Florence 路径，显式位置优先且编号可重放',async t=>{
  const f=await fixture(t),external=join(f.directory,'已有Florence');
  f.training.captioners.state=async()=>({items:[{id:'florence2-base',ready:true,modelPath:external}]});
  const input={...f.input,mode:'tag',captioner:'florence2'};
  const request={requestId:'reuse-florence',input,config:f.config};
  const created=await f.training.pipeline.create(request);const job=await f.toTag(created.job.id);
  assert.ok(job.tasks.tag,job.error);assert.equal(f.tasks.find(task=>task.id===job.tasks.tag).metadata.source_config.captionModelPath,external);
  assert.equal((await f.training.pipeline.create(request)).reused,true);
  const manual=await f.training.pipeline.create({...request,requestId:'manual-florence',input:{...input,captionModelPath:f.directory}});
  const manualJob=await f.toTag(manual.job.id);assert.equal(f.tasks.find(task=>task.id===manualJob.tasks.tag).metadata.source_config.captionModelPath,f.directory);
});

test('重复编号复用流程，参数冲突拒绝；本地方案不会调用 AI', async t => {
  const f = await fixture(t), request = { requestId: 'stable', input: f.input, config: f.config };
  const [a, b] = await Promise.all([f.training.pipeline.create(request), f.training.pipeline.create(request)]);
  assert.equal(a.job.id, b.job.id); assert.equal(f.training.pipeline.list().jobs.length, 1);
  await assert.rejects(f.training.pipeline.create({ ...request, input: { ...f.input, goal: '另一目标' } }), /编号|冲突/);
  await f.toTag(a.job.id); assert.equal(f.aiCalls, 0);
});

test('一键输出使用选择的目录，每个流程独立保存并保留重试位置',async t=>{
  const f=await fixture(t),outputRoot=join(f.directory,'chosen-output');
  const request={requestId:'chosen-destination',input:f.input,config:{...f.config,output_dir:outputRoot}};
  const created=(await f.training.pipeline.create(request)).job;
  assert.ok(created.outputDirectory?.startsWith(outputRoot+sep),'返回实际输出目录');
  assert.equal((await f.training.pipeline.create(request)).job.outputDirectory,created.outputDirectory);
  const another=(await f.training.pipeline.create({...request,requestId:'another-output'})).job;
  assert.notEqual(another.outputDirectory,created.outputDirectory);
  let job=await f.toTag(created.id);await f.finishTag(job);
  for(let n=0;n<5&&!job.tasks.train;n++)job=await f.tick(created.id);
  assert.equal(f.calls.find(call=>call.path==='/api/run').body.output_dir,created.outputDirectory);
  assert.ok((await readdir(created.outputDirectory)).includes('.workbench-training-output.json'));
  await f.training.close();const reopened=new LoraTraining(f.options);f.services.push(reopened);
  assert.equal(reopened.pipeline.get(created.id).job.outputDirectory,created.outputDirectory);
  assert.deepEqual(await readdir(f.source),['one.png']);
});

test('输出目标已有其他文件时不覆盖，不能把产物写进原始训练图集',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.training.pipeline.create({requestId:'inside-source',input:f.input,config:{...f.config,output_dir:f.source}}),/原始|图集/);
  const created=(await f.training.pipeline.create({requestId:'occupied-output',input:f.input,config:{...f.config,output_dir:join(f.directory,'output')}})).job;
  assert.ok(created.outputDirectory);await mkdir(created.outputDirectory,{recursive:true});await writeFile(join(created.outputDirectory,'user.safetensors'),'keep');
  let job=await f.toTag(created.id);await f.finishTag(job);
  for(let n=0;n<5&&job.state!=='blocked';n++)job=await f.tick(created.id);
  assert.equal(job.state,'blocked');assert.match(job.error,/已有|归属/);
  assert.equal(f.calls.filter(call=>call.path==='/api/run').length,0);
  assert.equal(await readFile(join(created.outputDirectory,'user.safetensors'),'utf8'),'keep');
});

test('规划 AI 未返回时取消立即完成并中止请求，迟到方案不能推进阶段',async t=>{
  const f=await fixture(t);let enter,release,options;
  const entered=new Promise(done=>{enter=done;}),waiting=new Promise(done=>{release=done;});
  f.sharedAI.complete=async(_messages,opts)=>{options=opts;enter();await waiting;return{text:'{"summary":"late plan"}'};};
  const {job}=await f.training.pipeline.create({requestId:'cancel-planning',input:{...f.input,mode:'tag',aiEnabled:true},config:f.config});
  const ticking=f.training.pipeline.tick(job.id);await entered;
  let outcome;
  try{
    outcome=await Promise.race([f.training.pipeline.cancel(job.id),new Promise(done=>setTimeout(()=>done(null),200))]);
    assert.ok(outcome,'取消不应排在未完成的 AI 请求后');
    assert.equal(outcome.job.state,'cancelled');assert.equal(options.signal?.aborted,true);
  }finally{release();await ticking;}
  const result=f.training.pipeline.get(job.id).job;
  assert.equal(result.state,'cancelled');assert.equal(result.stage,'plan');assert.equal(result.plan,null);
  assert.equal(f.calls.some(call=>/\/run$/.test(call.path)),false);
});

for(const phase of ['check','run'])test(`取消在打标 ${phase} 等待期间立即登记，提交前拦截或提交后核对停止`,async t=>{
  const f=await fixture(t);let enter,release;
  const entered=new Promise(done=>{enter=done;}),waiting=new Promise(done=>{release=done;});
  const request=f.runtime.request.bind(f.runtime);
  f.runtime.request=async(method,path,options)=>{
    const result=await request(method,path,options);
    if(path==='/api/tagger/'+phase){enter();await waiting;}
    return result;
  };
  const {job}=await f.training.pipeline.create({requestId:'cancel-'+phase,input:{...f.input,mode:'tag'},config:{}});
  for(let n=0;n<3;n++)await f.tick(job.id);
  const ticking=f.training.pipeline.tick(job.id);await entered;
  let cancellation;
  try{
    cancellation=f.training.pipeline.cancel(job.id);
    assert.equal(f.training.pipeline.get(job.id).job.state,'cancelling');
  }finally{release();await ticking;await cancellation;}
  assert.equal(f.training.pipeline.get(job.id).job.state,'cancelled');
  if(phase==='check')assert.equal(f.tasks.length,0,'取消后不得越过预检查创建任务');
  else{assert.equal(f.tasks.length,1);assert.equal(f.tasks[0].status,'TERMINATED','已经实际提交的任务必须核对并停止');}
});

test('新默认整图流程跳过检测与裁切，不提交预处理任务', async t => {
  const f = await fixture(t), input = { ...f.input, mode: 'tag' }; delete input.cropMode;
  const { job: created } = await f.training.pipeline.create({ requestId: 'whole-default', input, config: f.config });
  const job = await f.toTag(created.id);
  assert.equal(job.tasks.crop, null); assert.equal(job.steps.find(step => step.id === 'crop').status, 'skipped');
  assert.equal(job.plan.strategy.cropMode, 'preserve');
  assert.equal(f.calls.some(call => call.path.startsWith('/api/preprocess')), false);
  await f.finishTag(job); await f.tick(job.id); const completed = await f.tick(job.id);
  assert.equal(completed.state, 'completed');
  assert.match(await readFile(completed.summary.datasetPath, 'utf8'), /bucket_no_upscale = true/);
  assert.match(await readFile(completed.summary.datasetPath, 'utf8'), /bucket_reso_steps = 16/);
});

test('v2 省略裁切字段的旧请求仍复用原编号，未规划旧流程仍按旧策略增强', async t => {
  const f = await fixture(t), normalized = pipelineInput({ ...f.input, cropMode: 'auto' });
  delete normalized.planner; delete normalized.parameterMode;
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const snapshot = { input: normalized, config: f.config };
  const job = { id: 'v2-default', version: 2, ...snapshot, state: 'running', stage: 'plan', tasks: { crop: null, tag: null, train: null }, attempts: { crop: 0, tag: 0, train: 0 }, steps: ['plan', 'prepare', 'crop', 'tag', 'verify', 'train'].map(id => ({ id, status: 'pending' })), outputs: [] };
  f.training.db.prepare('INSERT INTO training_workflows(owner,id,input_hash,record) VALUES(?,?,?,?)').run(f.training.owner, job.id, createHash('sha256').update(canonical(snapshot)).digest('hex'), JSON.stringify(job));
  const raw = { ...f.input }; delete raw.cropMode;
  assert.equal((await f.training.pipeline.create({ requestId: job.id, input: raw, config: f.config })).reused, true);
  const planned = await f.tick(job.id);
  assert.equal(planned.plan.strategy.cropMode, 'character'); assert.equal(planned.plan.strategy.dataset, undefined);
  await assert.rejects(f.training.pipeline.create({ requestId: job.id, input: { ...raw, cropMode: 'none' }, config: f.config }), /编号|参数/);
});

test('升级前的流程响应丢失，原编号与原输入仍能核对，新增策略不能偷换', async t => {
  const f = await fixture(t), oldInput = pipelineInput(f.input);
  for (const field of ['cropMode', 'captionFormat', 'detectorPath', 'captionModelPath', 'planner', 'parameterMode']) delete oldInput[field];
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const snapshot = { input: oldInput, config: f.config }, hash = createHash('sha256').update(canonical(snapshot)).digest('hex');
  const legacy = { id: 'legacy', ...snapshot, state: 'paused', stage: 'tag', steps: [], tasks: { tag: null, train: null }, attempts: { tag: 0, train: 0 } };
  f.training.db.prepare('INSERT INTO training_workflows(owner,id,input_hash,record) VALUES(?,?,?,?)').run(f.training.owner, legacy.id, hash, JSON.stringify(legacy));
  const request = { requestId: legacy.id, input: oldInput, config: f.config };
  const result = await f.training.pipeline.create(request);
  assert.equal(result.reused, true); assert.equal(result.job.id, legacy.id);
  await assert.rejects(f.training.pipeline.create({ ...request, input: { ...oldInput, captionFormat: 'natural' } }), /编号|参数/);
  await assert.rejects(f.training.pipeline.create({ ...request, input: { ...oldInput, goal: 'changed' } }), /编号|参数/);
});

test('标注报告提交后修改工作 TXT，不能用旧图像绑定绕过完整性检查', async t => {
  const f = await fixture(t), created = await f.training.pipeline.create({ requestId: 'caption-changed', input: { ...f.input, mode: 'tag' }, config: f.config });
  let job = await f.toTag(created.job.id); await f.finishTag(job);
  await writeFile(join(job.workspace, 'images', 'originals', '000001.txt'), 'full body, standing, street');
  job = await f.tick(job.id);
  assert.equal(job.state, 'blocked'); assert.match(job.error, /标注.*(?:改变|校验)/);
  assert.equal(f.calls.filter(call => call.path === '/api/run').length, 0);
});

test('升级前尚未准备的旧流程，使用新副本补标后能够继续校验', async t => {
  const f = await fixture(t), created = await f.training.pipeline.create({ requestId: 'legacy-prepare', input: { ...f.input, mode: 'tag' }, config: f.config });
  const saved = f.training.pipeline.record(created.job.id); delete saved.version;
  saved.steps = saved.steps.filter(step => step.id !== 'crop'); delete saved.tasks.crop; delete saved.attempts.crop;
  f.training.pipeline.save(saved);
  let job = await f.toTag(saved.id); assert.ok(job.tasks.tag);
  assert.equal(job.plan.strategy, undefined); await f.finishTag(job);
  for (let n = 0; n < 4 && job.state !== 'completed'; n++) job = await f.tick(job.id);
  assert.equal(job.state, 'completed'); assert.equal(job.summary.captioned, 1);
});

test('打标失败与空标注均阻止后续训练，只有明确继续才重试', async t => {
  const f = await fixture(t), { job: created } = await f.training.pipeline.create({ requestId: 'failed-tag', input: f.input, config: f.config });
  let job = await f.toTag(created.id); await f.finishTag(job, false); job = await f.tick(job.id);
  assert.equal(job.state, 'blocked'); assert.equal(f.calls.filter(call => call.path === '/api/run').length, 0);
  await f.tick(job.id); assert.equal(f.tasks.length, 1);
  await f.training.pipeline.resume(job.id); job = await f.toTag(job.id); assert.equal(f.tasks.length, 2);
  f.tasks[1].status = 'FINISHED'; f.tasks[1].returncode = 0;
  for (let n = 0; n < 3 && job.state === 'running'; n++) job = await f.tick(job.id);
  assert.equal(job.state, 'blocked'); assert.match(job.error, /标注/); assert.equal(f.calls.filter(call => call.path === '/api/run').length, 0);
});

test('仅打标不要求底模；暂停、关闭恢复和取消不会启动额外训练', async t => {
  const f = await fixture(t), { job: created } = await f.training.pipeline.create({ requestId: 'tag-only', input: { ...f.input, mode: 'tag' }, config: {} });
  await f.training.pipeline.pause(created.id); await f.tick(created.id); assert.equal(f.training.pipeline.get(created.id).job.state, 'paused');
  await f.training.pipeline.resume(created.id); let job = await f.toTag(created.id);
  await f.training.close();
  const reopened = new LoraTraining(f.options); f.services.push(reopened);
  assert.equal(reopened.pipeline.get(job.id).job.state, 'paused'); assert.equal(f.tasks.length, 1);
  await reopened.pipeline.resume(job.id); await f.finishTag(job);
  for (let n = 0; n < 5; n++) await reopened.pipeline.tick(job.id);
  job = reopened.pipeline.get(job.id).job; assert.equal(job.state, 'completed'); assert.equal(job.tasks.train, null);
  const second = await reopened.pipeline.create({ requestId: 'cancel', input: { ...f.input, mode: 'tag' }, config: {} });
  await reopened.pipeline.cancel(second.job.id); await reopened.pipeline.tick(second.job.id);
  assert.equal(reopened.pipeline.get(second.job.id).job.state, 'cancelled'); assert.equal(f.tasks.length, 1);
});

test('AI 显式启用才调用，建议限制为有限参数，仍复用原底模配置', async t => {
  const f = await fixture(t), { job } = await f.training.pipeline.create({ requestId: 'ai', input: { ...f.input, aiEnabled: true }, config: f.config });
  await f.tick(job.id); const planned = f.training.pipeline.get(job.id).job;
  assert.equal(f.aiCalls, 1); assert.equal(planned.plan.steps, 64); assert.equal(planned.plan.purpose, 'style');
  f.sharedAI.complete = async () => ({ text: JSON.stringify({ command: 'arbitrary', sourcePath: 'C:\\other' }) });
  const bad = await f.training.pipeline.create({ requestId: 'bad-ai', input: { ...f.input, aiEnabled: true }, config: f.config });
  const rejected = await f.tick(bad.job.id); assert.equal(rejected.state, 'blocked'); assert.match(rejected.error, /AI|字段|方案/);
});

test('打标提交响应丢失先对账，不能重复打标；失联时保留未决流程', async t => {
  const f = await fixture(t), original = f.runtime.request;
  let lost = true;
  f.runtime.request = async (...args) => { const result = await original(...args); if (args[1] === '/api/tagger/run' && lost) { lost = false; throw new Error('fixture response lost'); } return result; };
  const { job } = await f.training.pipeline.create({ requestId: 'lost-response', input: f.input, config: f.config });
  const blocked = await f.toTag(job.id); assert.equal(blocked.state, 'blocked'); assert.equal(f.tasks.length, 1);
  await f.training.pipeline.resume(job.id); const resumed = await f.toTag(job.id);
  assert.equal(resumed.tasks.tag, f.tasks[0].id); assert.equal(f.tasks.length, 1);
  await f.training.pipeline.cancel(job.id); assert.equal(f.tasks[0].status, 'TERMINATED');
});

test('流程隔离、仅使用已有标注和原目录链接检查', async t => {
  const f = await fixture(t), other = new LoraTraining({ ...f.options, instanceId: 'other' }); f.services.push(other);
  const { job } = await f.training.pipeline.create({ requestId: 'existing', input: { ...f.input, mode: 'tag', captionPolicy: 'existing' }, config: {} });
  assert.equal(other.pipeline.list().jobs.length, 0); assert.throws(() => other.pipeline.get(job.id), /找不到/);
  const blocked = await f.toTag(job.id); assert.equal(blocked.state, 'blocked'); assert.match(blocked.error, /缺少.*标注/); assert.equal(f.tasks.length, 0);
  await assert.rejects(f.training.prepareRemoval(), /未完成/); await f.training.pipeline.cancel(job.id);
  const linked = join(f.directory, 'linked'); await symlink(f.source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const linkJob = await f.training.pipeline.create({ requestId: 'link', input: { ...f.input, sourcePath: linked, mode: 'tag' }, config: {} });
  const rejected = await f.toTag(linkJob.job.id); assert.equal(rejected.state, 'blocked'); assert.match(rejected.error, /链接|联接/);
  assert.deepEqual(await readFile(join(f.source, 'one.png')), png);
});

test('响应丢失后重开内核：先取回阶段编号，再释放已有的 held 队列任务', async t => {
  const f = await fixture(t), original = f.runtime.request;
  f.runtime.request = async (...args) => { const result = await original(...args); if (args[1] === '/api/tagger/run') throw new Error('fixture response lost before saving stage id'); return result; };
  const { job } = await f.training.pipeline.create({ requestId: 'held-response', input: f.input, config: f.config });
  assert.equal((await f.toTag(job.id)).tasks.tag, null); await f.training.close();
  f.tasks[0].status = 'QUEUED'; f.tasks[0].metadata.held = true;
  const reopened = new LoraTraining(f.options); f.services.push(reopened);
  await reopened.pipeline.resume(job.id);
  assert.equal(reopened.pipeline.get(job.id).job.tasks.tag, f.tasks[0].id);
  assert.equal(f.tasks[0].metadata.held, false); assert.equal(f.tasks.length, 1);
});

test('流程编号与手工提交编号相撞，不能采纳或停止那次手工训练', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'existing.toml'), '[[datasets]]\n');
  const manual = await f.training.submit({ requestId: 'collision.train.0', config: { ...f.config, train_data_dir: f.source, dataset_config: join(f.directory, 'existing.toml') } });
  const { job: created } = await f.training.pipeline.create({ requestId: 'collision', input: f.input, config: f.config });
  let job = await f.toTag(created.id); await f.finishTag(job);
  for (let n = 0; n < 5 && job.state === 'running'; n++) job = await f.tick(job.id);
  assert.equal(job.state, 'blocked'); assert.equal(job.tasks.train, null); assert.match(job.error, /绑定|其他|流程/);
  await f.training.pipeline.cancel(job.id);
  assert.equal(f.tasks.find(task => task.id === manual.task_id).status, 'RUNNING');
});

test('内核异常重启留下的中断标记不能被当成已核实失败而自动重交或取消', async t => {
  const f = await fixture(t), { job: created } = await f.training.pipeline.create({ requestId: 'interrupted', input: f.input, config: f.config });
  const job = await f.toTag(created.id);
  f.tasks[0].status = 'FAILED'; f.tasks[0].returncode = -1; f.tasks[0].metadata.error = 'interrupted by server restart / 服务重启导致任务中断';
  await f.training.pipeline.pause(job.id); await f.tick(job.id);
  await assert.rejects(f.training.pipeline.resume(job.id), /旧阶段进程|核实/);
  await assert.rejects(f.training.pipeline.cancel(job.id), /旧阶段进程|核实/);
  assert.equal(f.tasks.length, 1); assert.equal(f.training.pipeline.get(job.id).job.state, 'blocked');
});

test('裁切先于打标，派生图必须重新标注，MOSS 自动使用自然语言', async t => {
  const f = await fixture(t), request = { requestId: 'pose-natural', input: { ...f.input, purpose: 'pose', cropMode: 'auto', captionFormat: 'auto', mode: 'tag' }, config: f.config };
  let job = (await f.training.pipeline.create(request)).job;
  for (let n = 0; n < 6 && !job.tasks.crop; n++) job = await f.tick(job.id);
  assert.ok(job.tasks.crop, '应先提交独立裁切任务'); assert.equal(job.tasks.tag, null);
  const crop = f.tasks.find(task => task.id === job.tasks.crop); crop.status = 'FINISHED'; crop.returncode = 0;
  const manifestPath = join(job.workspace, 'dataset-manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await mkdir(join(job.workspace, 'images', 'crops-fixture'));
  await writeFile(join(job.workspace, 'images', 'crops-fixture', 'derived.png'), png);
  manifest.items.push({ name: 'crops-fixture/derived.png', kind: 'pose', generatedFrom: manifest.items[0].name, sha256: createHash('sha256').update(png).digest('hex'), requiresCaption: true });
  manifest.processing = { complete: true, requestId: crop.metadata.workbench_request, originalCount: 1, derivedCount: 1, imageCount: 2, reviewCount: 0, reviews: [] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  for (let n = 0; n < 5 && !job.tasks.tag; n++) job = await f.tick(job.id);
  const tagging = f.calls.find(call => call.path === '/api/tagger/run').body;
  assert.equal(tagging.captionFormat, 'natural'); assert.equal(tagging.purpose, 'pose');
  await f.finishTag(job);
  for (let n = 0; n < 4 && job.state !== 'completed'; n++) job = await f.tick(job.id);
  assert.equal(job.state, 'completed'); assert.equal(job.summary.derivedCount, 1);
  assert.equal(job.summary.samples.some(item => item.image.includes('crops-fixture')), true);
  assert.equal(f.aiCalls, 0); assert.equal(f.calls.filter(call => call.path === '/api/run').length, 0);
});
