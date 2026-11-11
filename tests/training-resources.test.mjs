import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LoraTraining } from '../framework/training.mjs';
import { inspectTrainingModelContent } from '../framework/training-model-content.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'training-resources-'));
  const settings=new Map(),store={module:()=>({config:{trainerPath:join(directory,'Next-Trainer')}}),getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,structuredClone(value))};
  const service=new LoraTraining({store,dataDir:directory,runtime:{state:async()=>({status:'stopped'})}}),services=[service];
  t.after(async()=>{for(const item of services)await item.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {directory,store,service,settings,services};
}
async function safetensors(path,metadata,tensors={}) {
  const header=Buffer.from(JSON.stringify({__metadata__:metadata,...tensors}));const size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(header.length));await writeFile(path,Buffer.concat([size,header]));
}
test('training exposes every snapshot engine without claiming its training source is installed',async t=>{
  const {service}=await fixture(t),catalog=await service.catalog();
  assert.deepEqual(new Set(catalog.engines.map(engine=>engine.id)),new Set(['kohya','anima-fast','musubi','ai-toolkit','diffsynth','moss']));
  assert.ok(catalog.training_types.every(item=>item.control_supported===true));
  assert.ok(catalog.training_types.find(item=>item.engine==='musubi').source_required);
  assert.equal((await service.type({model_train_type:'krea2-lora'})).engine,'musubi');
});
test('base model recognition uses metadata and config, leaving filename guesses unknown',async t=>{
  const {directory,service}=await fixture(t);assert.equal(typeof service.inspectModel,'function');
  const model=join(directory,'misleading-sdxl.safetensors');await safetensors(model,{'modelspec.architecture':'qwen-image-2.1'});
  const result=await service.inspectModel({path:model});assert.equal(result.family,'qwen-image-21');assert.equal(result.evidence.kind,'metadata');assert.ok(result.matches.some(item=>item.engine==='diffsynth'));assert.equal(result.training_started,false);
  await safetensors(model,{});assert.equal((await service.inspectModel({path:model})).family,null);
  assert.equal((await service.inspectModel({path:model,family:'krea2'})).family,'krea2');
  await assert.rejects(service.inspectModel({path:model,family:'fake'}),/家族/);
  const repo=join(directory,'repo');await mkdir(repo);await writeFile(join(repo,'config.json'),JSON.stringify({_class_name:'FluxTransformer2DModel'}));
  assert.equal((await service.inspectModel({path:repo})).family,'flux');
});
test('LoRA headers are rejected as base models even when a family is explicitly selected',async t=>{
  const {directory,service}=await fixture(t),model=join(directory,'character.safetensors');
  await safetensors(model,{ss_network_module:'networks.lora'});await assert.rejects(service.inspectModel({path:model,family:'sdxl'}),/LoRA|适配器/);
  await safetensors(model,{}, {'transformer.double_blocks.0.lora_A.weight':{dtype:'BF16',shape:[16,32],data_offsets:[0,0]}});await assert.rejects(service.inspectModel({path:model,family:'flux'}),/LoRA|适配器/);
});
test('lightweight model discovery classifies content instead of assuming a directory contains base models',async t=>{
  const {directory,service}=await fixture(t),root=join(directory,'comfy-models');
  for(const name of ['loras','Downloads','checkpoints','diffusion_models'])await mkdir(join(root,name),{recursive:true});
  const tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  await safetensors(join(root,'loras','renamed-base.safetensors'),{}, {'model.diffusion_model.input_blocks.0.0.weight':tensor});
  await safetensors(join(root,'Downloads','misleading-base.safetensors'),{}, {'transformer_blocks.0.attn.to_q.lora_A.default.weight':tensor});
  await safetensors(join(root,'checkpoints','character.safetensors'),{'modelspec.architecture':'sdxl/lora'},{});
  await safetensors(join(root,'diffusion_models','diffusion.safetensors'),{}, {'double_blocks.0.img_attn.qkv.weight':tensor,'single_blocks.0.linear1.weight':tensor});
  const record=await service.discoverResources({roots:[root]});const found=record.result.models.filter(item=>item.path.startsWith(root));
  assert.deepEqual(found.map(item=>item.name).sort(),['diffusion.safetensors','renamed-base.safetensors']);
  assert.ok(found.every(item=>item.modelType==='base'));
  assert.ok(record.result.excludedCounts.adapter>=2);
});

test('adapter variants and adapter-only directories cannot be identified as base models',async t=>{
  const {directory,service}=await fixture(t),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  for(const [name,metadata,key] of [['spec',{'modelspec.architecture':'flux-1-dev/lora'},null],['loha',{},'transformer.blocks.0.hada_w1_a'],['lokr',{},'transformer.blocks.0.lokr_w1'],['peft',{},'base_model.model.blocks.0.lora_B.default.weight'],['dora',{},'layers.0.lora_magnitude_vector.default.weight'],['oft',{},'layers.0.oft_blocks']]){
    const path=join(directory,name+'.safetensors');await safetensors(path,metadata,key?{[key]:tensor}:{});
    await assert.rejects(service.inspectModel({path,family:'flux'}),/LoRA|适配器/,name);
  }
  const repo=join(directory,'models','flux-adapter');await mkdir(repo,{recursive:true});
  await writeFile(join(repo,'config.json'),JSON.stringify({_class_name:'FluxTransformer2DModel'}));
  await safetensors(join(repo,'weights.safetensors'),{}, {'blocks.0.lora_down.weight':tensor});
  await assert.rejects(service.inspectModel({path:repo,family:'flux'}),/LoRA|适配器/);
  const peft=join(directory,'peft');await mkdir(peft);await writeFile(join(peft,'adapter_config.json'),JSON.stringify({peft_type:'LORA',base_model_name_or_path:'flux'}));
  await writeFile(join(peft,'adapter_model.bin'),'never unpickle');
  await assert.rejects(service.inspectModel({path:peft}),/LoRA|适配器/);
});

test('unknown weights stay visibly unknown while complete diffusion directories remain usable',async t=>{
  const {directory,service}=await fixture(t),root=join(directory,'models'),repo=join(root,'full-repo'),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  await mkdir(join(repo,'transformer'),{recursive:true});
  await writeFile(join(repo,'model_index.json'),JSON.stringify({_class_name:'FluxPipeline'}));
  await safetensors(join(repo,'transformer','diffusion_pytorch_model.safetensors'),{}, {'double_blocks.0.img_attn.qkv.weight':tensor,'single_blocks.0.linear1.weight':tensor});
  await safetensors(join(repo,'extra-adapter.safetensors'),{ss_network_module:'networks.lora'});
  for(const filename of ['old.ckpt','quantized.gguf','empty.safetensors','flux-lora.safetensors'])await writeFile(join(root,filename),'unknown bytes');
  const largeHeader=Buffer.alloc(8);largeHeader.writeBigUInt64LE(1000000000n);await writeFile(join(root,'bad-header.safetensors'),largeHeader);
  const result=await service.discoverResources({roots:[root]});
  const found=result.result.models.filter(item=>item.path.startsWith(root));
  for(const filename of ['old.ckpt','quantized.gguf','empty.safetensors','flux-lora.safetensors','bad-header.safetensors'])assert.equal(found.find(item=>item.name===filename)?.modelType,'unknown',filename);
  assert.equal(found.find(item=>item.path===repo)?.modelType,'base');
  assert.equal((await service.inspectModel({path:repo})).modelType,'base');
});

test('adapter configuration does not turn unrelated opaque checkpoints into confirmed adapters',async t=>{
  const {directory,service}=await fixture(t),repo=join(directory,'mixed-repo');await mkdir(repo);
  await writeFile(join(repo,'adapter_config.json'),JSON.stringify({peft_type:'LORA'}));
  await writeFile(join(repo,'full.ckpt'),'never unpickle');
  const content=await inspectTrainingModelContent(repo);
  assert.equal(content.modelType,'unknown');
  assert.equal((await service.inspectModel({path:repo,family:'sdxl'})).modelType,'unknown');
});

test('legacy diffusers adapter keys and independent components are recognized from content',async t=>{
  const {directory,service}=await fixture(t),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  for(const key of ['unet.down_blocks.0.attentions.0.to_q_lora.down.weight','layers.0.oft_R.default','layers.0.vera_lambda_b.default']){
    const path=join(directory,'diffusers.safetensors');await safetensors(path,{}, {[key]:tensor});
    await assert.rejects(service.inspectModel({path,family:'sdxl'}),/LoRA|适配器/,key);
  }
  for(const tensors of [{'text_model.embeddings.token_embedding.weight':tensor},{'encoder.conv_in.weight':tensor,'post_quant_conv.weight':tensor}]){
    const path=join(directory,'renamed-diffusion.safetensors');await safetensors(path,{},tensors);
    assert.equal((await inspectTrainingModelContent(path)).modelType,'component');
    await assert.rejects(service.inspectModel({path,family:'sdxl'}),/编码器|VAE/);
  }
});

test('actual tensor structure takes precedence over inherited family or adapter metadata',async t=>{
  const {directory}=await fixture(t),path=join(directory,'merged.safetensors'),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  await safetensors(path,{ss_network_module:'networks.lora','modelspec.architecture':'sdxl/lora'},{'model.diffusion_model.input_blocks.0.0.weight':tensor,'text_model.embeddings.token_embedding.weight':tensor});
  assert.equal((await inspectTrainingModelContent(path)).modelType,'base','merged full checkpoints may retain adapter provenance metadata');
  await safetensors(path,{'modelspec.architecture':'stable-diffusion-xl-v1-base'},{'text_model.embeddings.token_embedding.weight':tensor});
  assert.equal((await inspectTrainingModelContent(path)).modelType,'component','base family metadata alone does not make a text encoder a base model');
});

test('ControlNet LLLite content cannot be promoted to a base by family metadata',async t=>{
  const {directory,service}=await fixture(t),path=join(directory,'anima.safetensors'),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  for(const architecture of ['anima-preview/control-net-lllite','anima-preview/control_net_lllite','anima-preview/lllite']){
    await safetensors(path,{'modelspec.architecture':architecture},{'conditioning.weight':tensor});
    assert.equal((await inspectTrainingModelContent(path)).modelType,'component',architecture);
    await assert.rejects(service.inspectModel({path,family:'anima'}),/条件网络/);
  }
  await safetensors(path,{'modelspec.architecture':'anima-preview'},{'lllite_conditioning1.0.weight':tensor});
  assert.equal((await inspectTrainingModelContent(path)).modelType,'component','LLLite tensor keys override generic family metadata');
  await safetensors(path,{'modelspec.architecture':'anima-preview/control-net-lllite'},{'blocks.0.lora_down.weight':tensor});
  assert.equal((await inspectTrainingModelContent(path)).modelType,'adapter','adapter tensors retain priority');
});

test('model content inspection respects its header budget and keeps malformed input unknown',async t=>{
  const {directory}=await fixture(t),path=join(directory,'large.safetensors'),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  await safetensors(path,{}, {'model.diffusion_model.input_blocks.0.0.weight':tensor});
  const budget={remaining:8,exhausted:false};
  assert.equal((await inspectTrainingModelContent(path,{budget})).modelType,'unknown');assert.equal(budget.exhausted,true);assert.equal(budget.remaining,0);
  await safetensors(path,{}, {'lora_unet_fake':null});
  assert.equal((await inspectTrainingModelContent(path)).modelType,'unknown','malformed tensor descriptors are not confirmed adapters');
});

test('weight-looking directory links are not traversed',async t=>{
  const {directory}=await fixture(t),repo=join(directory,'repo'),external=join(directory,'external'),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};
  await mkdir(repo);await mkdir(external);
  const weight=join(external,'base.safetensors');await safetensors(weight,{}, {'model.diffusion_model.input_blocks.0.0.weight':tensor});
  await symlink(external,join(repo,'nested.safetensors'),'junction');
  assert.equal((await inspectTrainingModelContent(repo)).modelType,'unknown','a weight filename must not introduce another directory traversal');
});

test('weight file symlinks remain reusable when the host permits creating them',async t=>{
  const {directory}=await fixture(t),repo=join(directory,'repo'),weight=join(directory,'base.safetensors'),tensor={dtype:'F32',shape:[0],data_offsets:[0,0]};await mkdir(repo);
  await safetensors(weight,{}, {'model.diffusion_model.input_blocks.0.0.weight':tensor});
  try{await symlink(weight,join(repo,'linked.safetensors'),'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Windows does not permit file symlink creation for this process.');return;}throw error;}
  assert.equal((await inspectTrainingModelContent(repo)).modelType,'base','Hugging Face style weight file links remain valid');
});

test('cyclic weight-looking directory links terminate even with an exhausted budget',{timeout:1000},async t=>{
  const {directory}=await fixture(t),repo=join(directory,'cyclic');await mkdir(repo);
  await symlink(repo,join(repo,'self.safetensors'),'junction');
  const budget={remaining:0,exhausted:false};
  assert.equal((await inspectTrainingModelContent(repo,{budget,cache:new Map()})).modelType,'unknown');
  assert.equal(budget.remaining,0);
});

test('legacy discovery results are hidden until a one-time classified rescan replaces them',async t=>{
  const {directory,service,store}=await fixture(t),root=join(directory,'models');await mkdir(root);
  const path=join(root,'portrait.safetensors');await safetensors(path,{ss_network_module:'networks.lora'});
  store.setSetting('training.discoveryRoots',[root]);
  store.setSetting('resource.discovery.training',{attempted:true,status:'completed',fingerprint:JSON.stringify(['base-models-v3',join(directory,'Next-Trainer'),'', [root]]),result:{models:[{path,name:'portrait.safetensors',kind:'file'}],trainers:[],engines:[]}});
  const state=await service.state();assert.deepEqual(state.discovery.result.models,[]);assert.equal(state.discovery.classificationStale,true);
  const rescanned=await service.discoverResources();assert.equal(rescanned.classificationStale,false);assert.ok(!rescanned.result.models.some(item=>item.path===path));
  assert.equal((await service.discoverResources()).scannedAt,rescanned.scannedAt,'classified scans remain durable');
});

test('a failed classification migration stays hidden and does not automatically retry forever',async t=>{
  const {service,store}=await fixture(t);
  store.setSetting('resource.discovery.training',{attempted:true,status:'completed',fingerprint:'old-version',result:{models:[{path:'legacy.safetensors'}]}});
  const failed=await service.discoverResources({roots:'invalid-roots'});assert.equal(failed.status,'failed');assert.deepEqual(failed.result.models,[]);
  const saved=store.setSetting;let writes=0;store.setSetting=(...args)=>{writes++;return saved(...args);};
  const cached=await service.discoverResources();assert.equal(cached.status,'failed');assert.deepEqual(cached.result.models,[]);assert.equal(writes,0);
});
test('discovery is lightweight, once-only and durable, and a supplied root only scans on refresh',async t=>{
  const {directory,service,store,services}=await fixture(t);assert.equal(typeof service.discoverResources,'function');
  const root=join(directory,'models');await mkdir(root);const model=join(root,'sdxl.safetensors');await writeFile(model,'metadata discovery must not parse weights');
  const one=await service.discoverResources({roots:[root]});assert.equal(one.attempted,true);assert.ok(one.result.models.some(item=>item.path===model));
  await writeFile(join(root,'later.safetensors'),'later');
  const second=new LoraTraining({store,dataDir:directory,instanceId:'second',runtime:{state:async()=>({status:'stopped'})}});services.push(second);
  assert.equal((await second.discoverResources({roots:[root]})).result.models.length,one.result.models.length);
  assert.ok((await second.discoverResources({roots:[root],refresh:true})).result.models.some(item=>item.name==='later.safetensors'));
  assert.equal((await second.state()).discovery.attempted,true);
  store.module=()=>({config:{trainerPath:join(directory,'changed-trainer')}});
  assert.equal((await second.state()).discovery.stale,true,'配置改变只标记过期，不自动扫描');
});
test('engine maintenance requires an explicit target and confirmation, with no implicit training submission',async t=>{
  const {service}=await fixture(t);assert.equal(typeof service.engineAction,'function');
  await assert.rejects(service.engineAction('musubi','install',{}),/环境|目标/);
  await assert.rejects(service.engineAction('musubi','install',{target:'isolated'}),/确认/);
});
test('an explicitly selected existing engine can be reused without install or training dispatch',async t=>{
  const {service}=await fixture(t),calls=[];
  service.runtime={selectEngineTarget:async(...values)=>calls.push(['target',...values]),start:async()=>calls.push(['start']),request:async(method,path)=>{calls.push([method,path]);return {state:'ready'};}};
  const result=await service.engineAction('musubi','use',{target:'original',confirmed:true});
  assert.equal(result.training_started,false);assert.equal(result.status.state,'ready');
  assert.ok(calls.some(call=>call[0]==='GET'&&call[1]==='/api/engines/musubi/status'));
  assert.ok(!calls.some(call=>call[0]==='POST'));
});
test('original engine maintenance refuses an active queue owned by the original Next Trainer',async t=>{
  const {directory,service}=await fixture(t);await mkdir(join(directory,'Next-Trainer','logs'),{recursive:true});await writeFile(join(directory,'Next-Trainer','logs','task_queue.json'),JSON.stringify([{status:'RUNNING',task_id:'external-original'}]));
  let changed=false;service.runtime={selectEngineTarget:async()=>{changed=true;},start:async()=>{},request:async()=>({plan:[]})};
  await assert.rejects(service.engineAction('musubi','repair',{target:'original',confirmed:true,dryRun:false}),/原.*任务|原.*活动/);assert.equal(changed,false);
});
test('an instance cannot be removed while its app-owned service environment is being prepared',async t=>{
  const {service}=await fixture(t);service.runtime={state:async()=>({status:'unconfigured',servicePreparation:{status:'running',pid:process.pid}})};
  await assert.rejects(service.prepareRemoval(),/服务环境|正在准备/);assert.equal(service.removing,false);
});
