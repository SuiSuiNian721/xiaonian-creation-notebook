import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as providers from '../framework/voice-resources.mjs';
import {PathPicker} from '../framework/path-picker.mjs';
import {VoiceStudio} from '../framework/voice-studio.mjs';

async function fixture(t,extra={}){
  const directory=await mkdtemp(join(tmpdir(),'voice-extension-')),settings=new Map();
  const store={getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))};
  const options={store,dataDir:directory,candidates:{},searchRoots:[],...extra};
  const resources=new providers.VoiceResources(options);await resources.initialized;
  t.after(async()=>{await resources.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {resources,directory,store,settings,options};
}

test('声明每种模型的实际能力，OpenAI speech 不冒充克隆或设计',async t=>{
  const {resources}=await fixture(t),catalog=resources.state().providers;
  assert.ok(Array.isArray(catalog),'声音资源必须公开提供者能力');
  const qwen=catalog.find(item=>item.id==='qwen3-tts');
  assert.deepEqual(qwen.models.find(item=>item.id==='base').capabilities,['clone']);
  assert.deepEqual(qwen.models.find(item=>item.id==='custom-voice').capabilities,['synthesis']);
  assert.deepEqual(qwen.models.find(item=>item.id==='voice-design').capabilities,['design']);
  assert.deepEqual(catalog.find(item=>item.id==='http').capabilities,['synthesis']);
});

test('首次轻量发现只记录候选，失败与成功均跨重启缓存且不执行Python',async t=>{
  let scans=0;
  const {resources,options}=await fixture(t,{discoverImpl:async()=>{scans++;return {models:[{provider:'moss',kind:'generator',path:'fixture'}],environments:[],installations:[]};},runtimeProbeImpl:()=>assert.fail('启动不能执行 Python')});
  assert.equal(scans,0);await resources.detect();assert.equal(scans,1);assert.equal(resources.state().config.generatorPath,'');
  assert.equal(resources.state().discovery.attempted,true);
  const reopened=new providers.VoiceResources(options);t.after(()=>reopened.close());await reopened.initialized;
  assert.equal(scans,1);await reopened.detect();assert.equal(scans,1);
  await reopened.detect({refresh:true});assert.equal(scans,2);
});

test('发现失败不在重新进入或重启后自动重试',async t=>{
  let scans=0;const {resources,options}=await fixture(t,{discoverImpl:async()=>{scans++;throw new Error('权限不足');}});
  await resources.detect();
  assert.equal(resources.state().discovery.status,'failed');
  const reopened=new providers.VoiceResources(options);t.after(()=>reopened.close());await reopened.initialized;
  assert.equal(scans,1);assert.match(reopened.state().discovery.error,/权限不足/);
});

test('通用本地绑定不要求外部模型匹配工作台固定下载包',async t=>{
  const {resources,directory}=await fixture(t),model=join(directory,'external-model');await mkdir(model);
  await writeFile(join(model,'config.json'),JSON.stringify({model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],local_hidden_size:1536,local_num_layers:4,n_vq:32}));await writeFile(join(model,'model.safetensors'),'external-weights');
  await resources.configure({clonePath:model});
  assert.equal(resources.state().config.clonePath,model);
  assert.equal(resources.state().components.find(item=>item.id==='clone').installed,true);
});

test('Qwen的隔离环境按磁盘元数据检查，冲突展示两种修复路径且不改原环境',async t=>{
  const {resources,directory}=await fixture(t),env=join(directory,'qwen-env'),python=join(env,'Scripts','python.exe'),packages=join(env,'Lib','site-packages');
  await mkdir(join(env,'Scripts'),{recursive:true});await mkdir(join(packages,'transformers-5.0.0.dist-info'),{recursive:true});
  await writeFile(python,'fixture');await writeFile(join(packages,'transformers-5.0.0.dist-info','METADATA'),'Name: transformers\nVersion: 5.0.0\n');
  await resources.configure({provider:'qwen3-tts',qwenPythonPath:python});
  const check=resources.state().environments.find(item=>item.provider==='qwen3-tts');
  assert.equal(check.status,'incompatible');assert.ok(check.issues.some(item=>item.includes('4.57.3')));
  assert.deepEqual(check.repairOptions.map(item=>item.id),['repair-existing','create-isolated']);
});

test('环境修复先准备具体计划，只有执行计划才运行命令且不混用MOSS解释器',async t=>{
  const commands=[];const {resources,directory}=await fixture(t,{runCommandImpl:async(executable,args)=>{commands.push({executable,args});return {stdout:''};}});
  const python=join(directory,'python.exe');await writeFile(python,'fixture');
  await resources.configure({provider:'qwen3-tts',qwenPythonPath:python,pythonPath:python});
  assert.throws(()=>resources.install({provider:'qwen3-tts',environmentMode:'repair-existing'}),/隔离|共用/);
  const state=resources.install({provider:'qwen3-tts',environmentMode:'create-isolated'});
  assert.equal(commands.length,0);assert.ok(state.environmentPlan.id);assert.equal(state.environmentPlan.provider,'qwen3-tts');
  assert.notEqual(state.environmentPlan.target,python);assert.match(JSON.stringify(state.environmentPlan.commands),/4.57.3/);
  assert.throws(()=>resources.install({planId:'unknown'}),/计划/);
});

test('隔离环境执行计划使用已选基础Python并保留原目录',async t=>{
  const commands=[];let controller;
  const result=await fixture(t,{runCommandImpl:async(executable,args)=>{
    commands.push({executable,args});
    if(args.includes('venv')){const target=args.at(-1);await mkdir(join(target,'Scripts'),{recursive:true});await writeFile(join(target,'Scripts','python.exe'),'new-python');}
    if(args.includes('pip')){
      const target=controller.state().environmentPlan.target,packages=join(target,'Lib','site-packages');
      for(const [name,version] of Object.entries({'transformers':'4.57.3','qwen-tts':'0.1.1','torch':'2.9.1','soundfile':'0.14.0','scipy':'1.16.2'})){
        const folder=join(packages,name+'-'+version+'.dist-info');await mkdir(folder,{recursive:true});await writeFile(join(folder,'METADATA'),`Name: ${name}\nVersion: ${version}\n`);
      }
    }
    return {stdout:'fixture complete'};
  }});controller=result.resources;const python=join(result.directory,'python.exe');await writeFile(python,'original');
  await controller.configure({qwenPythonPath:python});const planned=controller.install({provider:'qwen3-tts',environmentMode:'create-isolated'});
  controller.install({planId:planned.environmentPlan.id});assert.throws(()=>controller.install({planId:planned.environmentPlan.id}),/计划/);await controller.job.promise;
  assert.equal(controller.state().task.status,'completed');assert.equal(commands[0].executable,python);assert.ok(commands[0].args.includes('venv'));
  assert.notEqual(controller.state().config.qwenPythonPath,python);
  const count=commands.length;assert.throws(()=>controller.install({planId:planned.environmentPlan.id}),/计划/);assert.equal(commands.length,count);
});

test('两个声音模块均可选择Qwen专用解释器和模型目录，拒绝错误类型',async t=>{
  const {directory}=await fixture(t),python=join(directory,'python.exe');await writeFile(python,'fixture');
  for(const moduleId of ['voice','voice-design']){
    const picker=new PathPicker({store:{getSetting:()=>null,module:()=>({enabled:true})},choosePath:async({kind})=>kind==='file'?python:directory});
    assert.equal((await picker.choose({moduleId,target:'module',field:'qwenPythonPath',kind:'file',currentPath:''})).path,python);
    assert.equal((await picker.choose({moduleId,target:'module',field:'qwenBasePath',kind:'directory',currentPath:''})).path,directory);
    await assert.rejects(picker.choose({moduleId,target:'module',field:'qwenBasePath',kind:'file'}),/路径类型/);
  }
});

test('已采用的 MOSS 与 Qwen 全部路径持久保存并进入各操作实际执行配置',async t=>{
  const {resources,directory,options,settings}=await fixture(t),paths={};
  for(const [field,packages] of Object.entries({pythonPath:{transformers:'5.0.0',torch:'2.9.1',torchaudio:'2.9.1',soundfile:'0.14.0',scipy:'1.16.2'},qwenPythonPath:{transformers:'4.57.3',torch:'2.9.1',soundfile:'0.14.0',scipy:'1.16.2'}})){
    const environment=join(directory,field);paths[field]=join(environment,'Scripts','python.exe');await mkdir(join(environment,'Scripts'),{recursive:true});await writeFile(paths[field],'fixture');
    for(const [name,version] of Object.entries(packages)){const folder=join(environment,'Lib','site-packages',name+'-'+version+'.dist-info');await mkdir(folder,{recursive:true});await writeFile(join(folder,'METADATA'),`Name: ${name}\nVersion: ${version}\n`);}
  }
  paths.qwenSourcePath=join(directory,'qwen-source');await mkdir(join(paths.qwenSourcePath,'qwen_tts'),{recursive:true});await writeFile(join(paths.qwenSourcePath,'qwen_tts','__init__.py'),'# fixture');
  const configs={generatorPath:{model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],gen_token_id:151656,audio_ch0_vocab_size:1024,n_vq:16},clonePath:{model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],local_hidden_size:1536,local_num_layers:4,n_vq:32},codecPath:{model_type:'moss-audio-tokenizer',architectures:['MossAudioTokenizerModel']},
    ...Object.fromEntries([['qwenBasePath','Base'],['qwenCustomVoicePath','CustomVoice'],['qwenDesignPath','VoiceDesign']].map(([field,kind])=>[field,{model_type:'qwen3_tts',architectures:['Qwen3TTSForConditionalGeneration'],tts_model_type:kind}]))};
  for(const [field,config] of Object.entries(configs)){paths[field]=join(directory,field);await mkdir(paths[field]);await writeFile(join(paths[field],'config.json'),JSON.stringify(config));await writeFile(join(paths[field],'model.safetensors'),'fixture');}
  await resources.configure(paths);for(const [field,path] of Object.entries(paths))assert.equal(settings.get('voice.resources').config[field],path);
  const reopened=new providers.VoiceResources(options);t.after(()=>reopened.close());await reopened.initialized;
  const studio=new VoiceStudio({resources:reopened,dataDir:directory,runWorker:()=>assert.fail('配置检查不得启动推理')});await studio.initialized;t.after(()=>studio.close());
  for(const [provider,mode,field] of [['moss','design','generatorPath'],['moss','clone','clonePath'],['qwen3-tts','design','qwenDesignPath'],['qwen3-tts','clone','qwenBasePath'],['qwen3-tts','synthesis','qwenCustomVoicePath']]){
    const config=studio.config(mode,provider);assert.equal(config.model,paths[field]);assert.equal(config.pythonPath,paths[provider==='moss'?'pythonPath':'qwenPythonPath']);
    if(provider==='moss')assert.equal(config.codecPath,paths.codecPath);else assert.equal(config.sourcePath,paths.qwenSourcePath);
  }
});
