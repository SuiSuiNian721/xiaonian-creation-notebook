import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectVoiceModel,discoverVoiceResources} from '../framework/voice-providers.mjs';
import {VoiceResources} from '../framework/voice-resources.mjs';
import {PathPicker} from '../framework/path-picker.mjs';
import {VoiceStudio} from '../framework/voice-studio.mjs';

const configs={
  generator:{model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],gen_token_id:151656,audio_ch0_vocab_size:1024,n_vq:16},
  clone:{model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],local_hidden_size:1536,local_num_layers:4,n_vq:32},
  codec:{model_type:'moss-audio-tokenizer',architectures:['MossAudioTokenizerModel']},
  base:{model_type:'qwen3_tts',architectures:['Qwen3TTSForConditionalGeneration'],tts_model_type:'base'},
};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'voice-model-validation-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const model=async(name,config)=>{const path=join(directory,name);await mkdir(path);await writeFile(join(path,'config.json'),JSON.stringify(config));await writeFile(join(path,'model.safetensors'),'fixture-weights');return path;};
  return {directory,model};
}

test('目录叫Base不能给空配置或未知MOSS用途授予生成能力',async t=>{
  const {model}=await fixture(t),empty=await model('Base',{}),ambiguous=await model('MOSS-VoiceGenerator',{model_type:'moss_tts_delay',architectures:['MossTTSDelayModel']});
  for(const provider of ['moss','qwen3-tts'])assert.equal((await inspectVoiceModel(empty,{provider,kind:provider==='moss'?'generator':'base'})).status,'unrecognized');
  assert.equal((await inspectVoiceModel(ambiguous,{provider:'moss',kind:'generator'})).status,'unrecognized');
});

test('配置中的提供者和用途必须与绑定字段匹配',async t=>{
  const {model}=await fixture(t),qwen=await model('arbitrary-qwen-name',configs.base),sd=await model('MOSS-model',{model_type:'stable-diffusion',architectures:['UNet2DConditionModel']});
  for(const path of [qwen,sd])for(const kind of ['generator','clone','codec'])assert.equal((await inspectVoiceModel(path,{provider:'moss',kind})).status,'incompatible');
  for(const kind of ['generator','clone','codec']){
    const path=await model('arbitrary-'+kind,configs[kind]);assert.equal((await inspectVoiceModel(path,{provider:'moss',kind})).status,'available');
    const wrong=kind==='generator'?'clone':'generator';assert.equal((await inspectVoiceModel(path,{provider:'moss',kind:wrong})).status,'incompatible');
    assert.equal((await inspectVoiceModel(path,{provider:'qwen3-tts',kind:'base'})).status,'incompatible');
  }
  assert.equal((await inspectVoiceModel(qwen,{provider:'qwen3-tts',kind:'voice-design'})).status,'incompatible');
});

test('HF快照中的配置与分片软链接可以发现和绑定，缓存复读不跟随重扫',async t=>{
  const {directory}=await fixture(t),blobs=join(directory,'blobs'),snapshot=join(directory,'models--Qwen--fixture','snapshots','revision');await mkdir(blobs);await mkdir(snapshot,{recursive:true});
  await writeFile(join(blobs,'config-blob'),JSON.stringify(configs.base));await writeFile(join(blobs,'weight-blob'),'weight-data');await writeFile(join(blobs,'index-blob'),JSON.stringify({weight_map:{weight:'model-00001-of-00001.safetensors'}}));
  const links=new Map([[join(snapshot,'config.json'),join(blobs,'config-blob')],[join(snapshot,'model-00001-of-00001.safetensors'),join(blobs,'weight-blob')],[join(snapshot,'model.safetensors.index.json'),join(blobs,'index-blob')]]);
  try{for(const [link,target] of links)await symlink(target,link,'file');}
  catch(error){
    if(!['EPERM','EACCES'].includes(error.code))throw error;
    // Windows may forbid file symlink creation. Exercise the same resolver with
    // a bounded link table rather than skipping the HF-cache regression.
    for(const link of links.keys())await writeFile(link,'link-placeholder');
    const originalStat=fsPromises.lstat,originalReadlink=fsPromises.readlink;
    fsPromises.lstat=async(path,...args)=>links.has(String(path))?{isSymbolicLink:()=>true}:originalStat(path,...args);
    fsPromises.readlink=async(path,...args)=>links.get(String(path))||originalReadlink(path,...args);syncBuiltinESMExports();
    t.after(()=>{fsPromises.lstat=originalStat;fsPromises.readlink=originalReadlink;syncBuiltinESMExports();});
    t.diagnostic('文件symlink权限不足，HF配置/权重链接通过受控lstat/readlink表验证。');
  }
  const settings=new Map(),store={getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))};
  const options={store,dataDir:directory,searchRoots:[directory],candidates:{}};const resources=new VoiceResources(options);t.after(()=>resources.close());
  await resources.detect();assert.equal(resources.state().discovery.result.models.find(item=>item.path===snapshot)?.status,'available');
  await resources.configure({qwenBasePath:snapshot});assert.equal(resources.state().bindings.qwenBasePath.status,'available');
  await rm(join(blobs,'weight-blob'));const reopened=new VoiceResources(options);t.after(()=>reopened.close());await reopened.detect();assert.equal(reopened.state().discovery.result.models.find(item=>item.path===snapshot)?.status,'available');
  await reopened.detect({refresh:true});assert.equal(reopened.state().discovery.result.models.find(item=>item.path===snapshot)?.status,'incomplete');
});

test('显式目录junction作为扫描根与绑定路径可以解析，本地管理写目录仍拒绝junction',async t=>{
  const {directory,model}=await fixture(t),actual=await model('actual',configs.clone),linked=join(directory,'user-selected-root');await symlink(actual,linked,process.platform==='win32'?'junction':'dir');
  const result=await discoverVoiceResources({roots:[linked]});assert.equal(result.models[0]?.status,'available');
  const settings=new Map(),resources=new VoiceResources({store:{getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,value)},dataDir:directory,searchRoots:[],candidates:{}});t.after(()=>resources.close());
  await resources.configure({searchRoots:[linked],clonePath:linked});assert.equal(resources.state().bindings.clonePath.status,'available');assert.equal(resources.state().config.clonePath,actual);
  const picker=new PathPicker({store:{getSetting:()=>null,module:()=>({enabled:true})},choosePath:async()=>linked});
  assert.equal((await picker.choose({moduleId:'voice',target:'module',field:'clonePath',kind:'directory'})).path,actual);
  await assert.rejects(resources.configure({directory:linked}),/符号链接|目录联接/);assert.equal(await readFile(join(actual,'model.safetensors'),'utf8'),'fixture-weights');
});

test('旧可用缓存只标为待检验，保留已下载标志并阻止直接启动模型，手动刷新后再判定',async t=>{
  const {directory,model}=await fixture(t),generator=await model('generator',configs.generator),codec=await model('codec',configs.codec);
  const settings=new Map([['voice.resources',{directory:join(directory,'resources'),config:{pythonPath:process.execPath,generatorPath:generator,codecPath:codec},installed:{runtime:true,generator:true,codec:true},bindings:{generatorPath:{path:generator,status:'available'},codecPath:{path:codec,status:'available'}}}],['resource.discovery.voice.discovery',{attempted:true,status:'completed',result:{models:[{provider:'moss',kind:'generator',path:generator,status:'available'}]},fingerprint:''}]]);
  let scans=0;const resources=new VoiceResources({store:{getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))},dataDir:directory,searchRoots:[],candidates:{},discoverImpl:async()=>{scans++;return discoverVoiceResources({roots:[directory]});}});t.after(()=>resources.close());
  assert.equal(resources.state().components.find(item=>item.id==='generator').installed,true);
  assert.equal(resources.state().bindings.generatorPath.status,'unverified');assert.equal(resources.state().bindings.generatorPath.stale,true);assert.equal(resources.state().discovery.stale,true);assert.equal(resources.state().discovery.result.models[0].status,'unverified');
  const studio=new VoiceStudio({dataDir:directory,resources,runWorker:()=>assert.fail('旧available不允许启动模型')});await studio.initialized;t.after(()=>studio.close());
  assert.throws(()=>studio.create({mode:'design',instruction:'明亮',text:'你好'}),/检验|检索/);
  await resources.detect();assert.equal(scans,0);assert.equal(resources.state().bindings.generatorPath.status,'unverified');
  await resources.detect({refresh:true});assert.equal(scans,1);assert.equal(resources.state().bindings.generatorPath.status,'available');assert.equal(resources.state().bindings.generatorPath.stale,false);
});

test('显式生成任务启动前重新检查模型用途，不直接相信已有available快照',async t=>{
  const {directory,model}=await fixture(t),generator=await model('generator',configs.generator),codec=await model('codec',configs.codec),settings=new Map();
  const resources=new VoiceResources({store:{getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,value)},dataDir:directory,searchRoots:[],candidates:{}});t.after(()=>resources.close());
  await resources.configure({pythonPath:process.execPath,generatorPath:generator,codecPath:codec});resources.installed.runtime=true;
  let launches=0;const studio=new VoiceStudio({dataDir:directory,resources,runWorker:async()=>{launches++;}});await studio.initialized;t.after(()=>studio.close());
  await writeFile(join(generator,'config.json'),JSON.stringify(configs.base));
  studio.create({mode:'design',instruction:'明亮',text:'你好'});await studio.pending;
  assert.equal(studio.state().job.status,'failed');assert.match(studio.state().job.error,/检验未通过/);assert.equal(launches,0);
});
