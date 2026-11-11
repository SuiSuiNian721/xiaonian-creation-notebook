import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname,join} from 'node:path';
import {VoiceStudio} from '../framework/voice-studio.mjs';
import {acquireResourceStorageLease} from '../framework/resource-storage.mjs';

function wav(){const bytes=Buffer.alloc(48044);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE(Math.round(Math.sin(i/20)*5000),i);return bytes;}
async function fixture(t,{worker,coordination,fetchImpl}={}){
  const directory=await mkdtemp(join(tmpdir(),'voice-studio-')),calls=[];
  const resources={initialized:Promise.resolve(),state:()=>({config:{pythonPath:process.execPath,generatorPath:directory,clonePath:directory,codecPath:directory},components:['runtime','generator','clone','codec'].map(id=>({id,installed:true})),task:null}),close:async()=>{}};
  const studio=new VoiceStudio({dataDir:directory,resources,coordination,fetchImpl,baseUrl:()=> 'http://127.0.0.1:1234',runWorker:worker||(async request=>{calls.push(request);await writeFile(request.output,wav());if(request.referenceOutput)await writeFile(request.referenceOutput,wav());})});
  await studio.initialized;t.after(async()=>{await studio.close();await rm(directory,{recursive:true,force:true});});
  return {studio,directory,calls,resources};
}
async function finished(studio){await studio.pending;return studio.state().job;}

test('批量设计逐份持久保存，候选可独立保留、克隆与删除',async t=>{
  const {studio,calls,directory,resources}=await fixture(t);
  studio.create({mode:'design',instruction:'清亮自然',text:'这是一份新的声音。',count:3,seed:8},{owner:'one'});await finished(studio);
  const candidates=studio.state({owner:'one'}).candidates;
  assert.equal(candidates.length,3);assert.deepEqual(calls.map(c=>c.seed),[8,9,10]);
  const candidate=candidates[0],voice=await studio.save({jobId:candidate.id,name:'保留的声音'},{owner:'one'});
  const source=new URL(candidate.result.url).pathname.split('/').slice(-2),referenceAudio={id:source[0],signature:source[1]};
  studio.create({mode:'clone',referenceAudio,text:'换一句台词。',transcript:candidate.text},{owner:'one'});assert.equal((await finished(studio)).status,'completed');
  assert.deepEqual(await readFile(calls.at(-1).reference),wav());
  await assert.rejects(studio.discard({jobId:candidate.id},{owner:'two'}),/本实例/);
  await studio.discard({jobId:candidate.id},{owner:'one'});
  assert.equal(studio.state({owner:'one'}).candidates.length,3);
  assert.deepEqual((await studio.exportVoice(voice.id)).bytes,wav());
  await assert.rejects(studio.audio(...source),/不存在/);
  const reopened=new VoiceStudio({dataDir:directory,resources,baseUrl:()=> 'http://127.0.0.1:4321'});await reopened.initialized;t.after(()=>reopened.close());
  assert.equal(reopened.state({owner:'one'}).candidates.length,3);
  assert.equal(new URL(reopened.state({owner:'one'}).candidates[0].result.url).port,'4321','重启后候选使用当前端口');
  assert.deepEqual(reopened.state({owner:'two'}).candidates,[]);
});

test('取消批量剩余任务时保留已经完成的候选',async t=>{
  let entered,release;const ready=new Promise(done=>{entered=done;});let count=0;
  const {studio}=await fixture(t,{worker:async request=>{if(++count===2){entered();await new Promise(done=>{release=done;});}await writeFile(request.output,wav());}});
  studio.create({mode:'design',instruction:'清亮',text:'你好。',count:3});await ready;
  await studio.cancel();release();await finished(studio);
  assert.equal(studio.state().job.status,'cancelled');assert.equal(studio.state().candidates.length,1);assert.equal(count,2);
});

test('批量中途失败不丢失前面的试听，下次生成继续保留旧候选',async t=>{
  let count=0;const {studio}=await fixture(t,{worker:async request=>{if(++count===2)throw new Error('模型执行失败');await writeFile(request.output,wav());}});
  studio.create({mode:'design',instruction:'自然',text:'你好',count:3});await finished(studio);
  const first=studio.state().candidates[0];assert.equal(studio.state().job.status,'failed');assert.equal(studio.state().candidates.length,1);
  studio.create({mode:'design',instruction:'温柔',text:'你好'});await finished(studio);
  assert.equal(studio.state().candidates.length,2);assert.equal(studio.state().candidates[0].id,first.id);
});

test('批量份数与签名参考校验，不能静默接受两个参考来源',async t=>{
  const {studio,calls}=await fixture(t);
  for(const count of [0,9,1.5])assert.throws(()=>studio.create({mode:'design',instruction:'自然',text:'你好',count}),/份数/);
  studio.create({mode:'design',instruction:'自然',text:'你好'});const job=await finished(studio),parts=new URL(job.result.url).pathname.split('/').slice(-2);
  const referenceAudio={id:parts[0],signature:'0'.repeat(64)};
  assert.throws(()=>studio.create({mode:'clone',referencePath:'x.wav',referenceAudio,text:'你好'}),/一种参考/);
  studio.create({mode:'clone',referenceAudio,text:'你好'});assert.equal((await finished(studio)).status,'failed');assert.equal(calls.length,1);
});

for(const cause of ['queue-full','storage-exclusive-lock'])test(`声音准入拒绝保留已有候选并可直接重试：${cause}`,async t=>{
  const coordination={tail:Promise.resolve(),active:0,queued:0},owner='design-instance';
  const {studio,directory,calls}=await fixture(t,{coordination});
  studio.create({mode:'design',instruction:'原来的声音',text:'保留这份试听'},{owner});const previous=await finished(studio),pending=studio.pending;
  const release=cause==='storage-exclusive-lock'?acquireResourceStorageLease(directory,'voice',{exclusive:true}):()=>{};
  if(cause==='queue-full')coordination.queued=8;
  try{
    assert.throws(()=>studio.create({mode:'design',instruction:'被拒绝的声音',text:'不应替换候选'},{owner}),/队列已满|维护此资源/);
    assert.equal(studio.state({owner}).busy,false);assert.deepEqual(studio.state({owner}).job,previous);
    assert.deepEqual(studio.jobs.get(owner),previous);assert.equal(studio.pending,pending);assert.equal(calls.length,1);
  }finally{release();coordination.queued=0;}
  await studio.cancel({owner});assert.deepEqual(studio.state({owner}).job,previous);
  studio.create({mode:'design',instruction:'重试声音',text:'现在可以生成'},{owner});
  assert.equal((await finished(studio)).status,'completed');assert.equal(calls.length,2);assert.equal(studio.state().busy,false);
});

for(const provider of ['moss','qwen3-tts'])for(const binding of ['missing','unavailable'])test(`设计音色先保存参考与转录，复用时再要求克隆能力：${provider}/${binding}`,async t=>{
  const {studio,resources,directory,calls}=await fixture(t);
  const config=provider==='moss'?{pythonPath:process.execPath,generatorPath:directory,codecPath:directory}:{qwenPythonPath:process.execPath,qwenDesignPath:directory};
  if(binding==='unavailable')config[provider==='moss'?'clonePath':'qwenBasePath']=join(directory,'unavailable-model');
  const state={config,components:['runtime','generator','codec'].map(id=>({id,installed:true})),bindings:{qwenDesignPath:{status:'available'}},environments:[{provider:'qwen3-tts',status:'available'}]};resources.state=()=>state;
  studio.create({provider,mode:'design',instruction:'温暖明亮',text:'这是保存的参考转录。'});const job=await finished(studio);
  assert.equal(job.status,'completed');const voice=await studio.save({jobId:job.id,name:'只准备设计模型的声音'});
  const manifest=JSON.parse(await readFile(join(directory,'shared-voice','studio','voices.json'),'utf8')),entry=manifest.voices[0];
  assert.equal(entry.model,undefined);assert.equal(entry.designModel,directory);assert.equal(entry.transcript,'这是保存的参考转录。');
  assert.deepEqual(await readFile(join(directory,'shared-voice','studio','voices',voice.id,'reference.wav')),wav());
  const reopened=new VoiceStudio({dataDir:directory,resources,runWorker:async request=>{calls.push(request);await writeFile(request.output,wav());}});await reopened.initialized;t.after(()=>reopened.close());
  assert.equal(reopened.voices()[0].id,voice.id);
  await assert.rejects(reopened.synthesize({voiceId:voice.id,text:'尚未准备克隆'}),/声音组件|对应模型/);assert.equal(calls.length,1);
  if(provider==='moss'){config.clonePath=directory;state.components.push({id:'clone',installed:true});}
  else{config.qwenBasePath=directory;state.bindings.qwenBasePath={status:'available'};}
  await reopened.synthesize({voiceId:voice.id,text:'现在复用这份声音'});
  assert.equal(calls.length,2);assert.equal(calls[1].mode,'clone');assert.equal(calls[1].model,directory);assert.equal(calls[1].transcript,entry.transcript);
});

test('文字描述无需参考音频；试听、保存、重启音色库与签名音频保持一致',async t=>{
  const {studio,calls,directory,resources}=await fixture(t);
  const state=studio.create({mode:'design',instruction:'清亮柔和、自然轻快的声音',text:'念念，今天的天空很漂亮。',seed:123});
  assert.equal(state.job.status,'queued');
  const job=await finished(studio);assert.equal(job.status,'completed');assert.equal(calls[0].mode,'design');assert.equal(calls[0].reference,undefined);assert.equal(calls[0].seed,123);
  const voice=await studio.save({jobId:job.id,name:'清亮试作'});assert.equal(voice.source,'design');assert.equal(voice.name,'清亮试作');
  assert.equal((await studio.save({jobId:job.id,name:'清亮试作'})).id,voice.id,'重复保存不会建立第二个音色');
  const audio=new URL(job.result.url),[,id,signature]=audio.pathname.match(/voice-audio\/([^/]+)\/([^/]+)/);
  assert.deepEqual((await studio.audio(id,signature)).bytes,wav());await assert.rejects(studio.audio(id,'0'.repeat(64)),/签名/);
  const reopened=new VoiceStudio({dataDir:directory,resources,runWorker:async()=>{}});await reopened.initialized;t.after(()=>reopened.close());
  assert.equal(reopened.voices()[0].id,voice.id);assert.deepEqual((await reopened.audio(id,signature)).bytes,wav());
});

test('克隆复制参考录音并保留音色来源，外部源文件保持原样',async t=>{
  const {studio,directory,calls}=await fixture(t);const source=join(directory,'原始录音.wav');await writeFile(source,wav());
  studio.create({mode:'clone',referencePath:source,text:'声音克隆试听。',seed:7});const job=await finished(studio);
  assert.equal(job.status,'completed');assert.notEqual(calls[0].reference,source);assert.equal(extname(calls[0].reference),'.wav');assert.ok(calls[0].referenceOutput);
  const voice=await studio.save({jobId:job.id,name:'克隆试作'});assert.equal(voice.source,'clone');assert.deepEqual(await readFile(source),wav());
});

test('已保存音色可合成其他台词并复用缓存，不能静默改用其他音色',async t=>{
  const {studio,calls}=await fixture(t);studio.create({mode:'design',instruction:'温和、沉稳',text:'第一句。'});const job=await finished(studio),voice=await studio.save({jobId:job.id,name:'沉稳试作'});
  const first=await studio.synthesize({voiceId:voice.id,text:'第二句。'}),second=await studio.synthesize({voiceId:voice.id,text:'第二句。'});
  assert.equal(first.id,second.id);assert.equal(first.voiceId,voice.id);assert.equal(calls.length,2);assert.equal(calls[1].mode,'clone');
  await assert.rejects(studio.synthesize({voiceId:'missing',text:'你好'}),/音色/);
});

test('排队取消不执行推理，执行中取消不交付或保存旧结果',async t=>{
  let unblock,entered;const ready=new Promise(resolve=>{entered=resolve;});
  const {studio}=await fixture(t,{worker:async request=>{entered();await new Promise(resolve=>{unblock=resolve;});await writeFile(request.output,wav());}});
  studio.create({mode:'design',instruction:'温暖',text:'你好'});await ready;await studio.cancel();unblock();const job=await finished(studio);
  assert.equal(job.status,'cancelled');assert.equal(job.result,undefined);await assert.rejects(studio.save({jobId:job.id,name:'旧结果'}),/完成/);
});

test('非法输入和损坏音频不会产生可保存结果',async t=>{
  const {studio}=await fixture(t,{worker:async request=>{await writeFile(request.output,Buffer.from('broken'));}});
  assert.throws(()=>studio.create({mode:'design',instruction:'',text:'你好'}),/描述/);
  assert.throws(()=>studio.create({mode:'design',instruction:'清亮',text:'你好',seed:-1}),/种子/);
  studio.create({mode:'design',instruction:'清亮',text:'你好'});const job=await finished(studio);assert.equal(job.status,'failed');assert.equal(job.result,undefined);
});

test('声音设计与旧语音共用队列，排队取消不会启动第二个推理进程',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;}),coordination={tail:hold,active:1,queued:0};
  const {studio,calls}=await fixture(t,{coordination});studio.create({mode:'design',instruction:'明亮',text:'你好'});
  assert.equal(coordination.queued,1);assert.equal(calls.length,0);await studio.cancel();release();const job=await finished(studio);
  assert.equal(job.status,'cancelled');assert.equal(calls.length,0);assert.equal(coordination.queued,0);
});

test('超过三十秒的试听可播放，但保存为参考时要求缩短台词',async t=>{
  const long=Buffer.alloc(31*48000+44);wav().copy(long);long.writeUInt32LE(long.length-8,4);long.writeUInt32LE(long.length-44,40);
  const {studio}=await fixture(t,{worker:async request=>{await writeFile(request.output,long);}});
  studio.create({mode:'design',instruction:'明亮',text:'长试听'});const job=await finished(studio);assert.equal(job.status,'completed');
  await assert.rejects(studio.save({jobId:job.id,name:'长试听'}),/30 秒/);
  const [id,signature]=new URL(job.result.url).pathname.split('/').slice(-2);
  studio.create({mode:'clone',referenceAudio:{id,signature},text:'新台词'});const rejected=await finished(studio);
  assert.equal(rejected.status,'failed');assert.match(rejected.error,/30 秒/);assert.equal(studio.state().candidates.length,1);
});

test('配置保留但组件校验失败时不启动推理',async t=>{
  const {studio,resources,calls}=await fixture(t),state=resources.state();state.components.find(item=>item.id==='generator').installed=false;resources.state=()=>state;
  assert.throws(()=>studio.create({mode:'design',instruction:'清亮',text:'你好'}),/声音组件/);assert.equal(calls.length,0);
});

test('不同实例分别保留未保存试听，不能保存或取消另一实例的候选',async t=>{
  const {studio,directory,resources}=await fixture(t);
  studio.create({mode:'design',instruction:'清亮',text:'第一份试听'},{owner:'design-instance'});const first=await finished(studio);
  studio.create({mode:'clone',referencePath:join(directory,'shared-voice','studio','jobs',first.id,'preview.wav'),text:'第二份试听'},{owner:'clone-instance'});const second=await finished(studio);
  assert.equal(studio.state({owner:'design-instance'}).job.id,first.id);assert.equal(studio.state({owner:'clone-instance'}).job.id,second.id);
  const voice=await studio.save({jobId:first.id,name:'第一份声音'},{owner:'design-instance'});assert.equal(voice.source,'design');
  await assert.rejects(studio.save({jobId:second.id,name:'另一份'},{owner:'design-instance'}),/本实例/);
  const reopened=new VoiceStudio({dataDir:directory,resources,runWorker:async()=>{}});await reopened.initialized;t.after(()=>reopened.close());
  assert.equal(reopened.state({owner:'design-instance'}).job.id,first.id);assert.equal(reopened.state({owner:'clone-instance'}).job.id,second.id);
});

test('最终完成记录提交期间取消会收敛为取消且不暴露试听结果',async t=>{
  const {studio}=await fixture(t);let release,entered;const ready=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;}),persist=studio.persistJob.bind(studio);
  studio.persistJob=async()=>{if(studio.job?.status==='completed'){entered();await gate;}return persist();};
  studio.create({mode:'design',instruction:'轻快',text:'你好'});await ready;await studio.cancel();release();const job=await finished(studio);
  assert.equal(job.status,'cancelled');assert.equal(job.result,undefined);assert.equal(studio.state().busy,false);
});

test('后台任务记录持续写入失败不会产生未处理拒绝',async t=>{
  const {studio}=await fixture(t);studio.persistJob=async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};
  studio.create({mode:'design',instruction:'轻快',text:'你好'});await assert.doesNotReject(studio.pending);
  assert.equal(studio.state().job.status,'failed');assert.match(studio.state().job.error,/保存|磁盘/);
});

test('Qwen文本设计保存音频和转录，并始终经Base克隆合成新台词',async t=>{
  const {studio,resources,directory,calls}=await fixture(t),config={provider:'qwen3-tts',qwenPythonPath:process.execPath,qwenDesignPath:directory,qwenBasePath:directory};
  resources.state=()=>({config,bindings:{qwenDesignPath:{status:'available'},qwenBasePath:{status:'available'}},environments:[{provider:'qwen3-tts',status:'available'}]});
  studio.create({provider:'qwen3-tts',mode:'design',instruction:'温暖明亮',text:'这是用于保存的参考台词。',language:'Chinese'});
  const job=await finished(studio);assert.equal(job.status,'completed');assert.equal(calls[0].provider,'qwen3-tts');assert.equal(calls[0].modelKind,'voice-design');
  const voice=await studio.save({jobId:job.id,name:'Qwen设计'});assert.equal(voice.provider,'qwen3-tts');
  config.provider='moss';await studio.synthesize({voiceId:voice.id,text:'新的台词'});
  assert.equal(calls[1].provider,'qwen3-tts');assert.equal(calls[1].modelKind,'base');assert.equal(calls[1].transcript,'这是用于保存的参考台词。');
  const manifest=JSON.parse(await readFile(join(directory,'shared-voice','studio','voices.json'),'utf8'));
  assert.equal(manifest.version,2);assert.equal(manifest.voices[0].language,'Chinese');
});

test('Qwen克隆必须提供参考转录，HTTP不支持克隆或文本设计',async t=>{
  const {studio}=await fixture(t);
  assert.throws(()=>studio.create({provider:'qwen3-tts',mode:'clone',referencePath:'fixture.wav',text:'你好'}),/转录/);
  assert.throws(()=>studio.create({provider:'http',mode:'design',instruction:'温暖',text:'你好'}),/不支持/);
  assert.throws(()=>studio.create({provider:'http',mode:'clone',referencePath:'fixture.wav',text:'你好'}),/不支持/);
});

test('自定义OpenAI speech只发普通合成并把24k PCM保存为规范WAV',async t=>{
  const requests=[];const {studio,resources}=await fixture(t,{fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body),headers:options.headers});return new Response(wav().subarray(44));}});
  const config={provider:'http',httpUrl:'http://127.0.0.1:8888/v1/audio/speech',httpModel:'local',httpVoice:'custom'};resources.state=()=>({config});
  studio.create({provider:'http',mode:'synthesis',text:'你好'});const job=await finished(studio);
  assert.equal(job.status,'completed');assert.equal(requests[0].body.response_format,'pcm');assert.equal(requests[0].body.input,'你好');
  const voice=await studio.save({jobId:job.id,name:'HTTP声音'});assert.equal(voice.provider,'http');
  await studio.synthesize({voiceId:voice.id,text:'再说一句'});assert.equal(requests.length,2);
  config.httpUrl='http://127.0.0.1:9999/v1/audio/speech';await assert.rejects(studio.synthesize({voiceId:voice.id,text:'端点变化'}),/接口.*改变|接口.*一致/);assert.equal(requests.length,2);
});

test('旧v1音色保持MOSS来源和原有音频URL',async t=>{
  const {studio,resources,directory}=await fixture(t);studio.create({mode:'design',instruction:'清亮',text:'参考台词'});const job=await finished(studio),voice=await studio.save({jobId:job.id,name:'旧声音'});
  const path=join(directory,'shared-voice','studio','voices.json'),manifest=JSON.parse(await readFile(path,'utf8'));manifest.version=1;
  for(const item of manifest.voices)for(const key of ['provider','model','modelKind','transcript','language','designModel'])delete item[key];await writeFile(path,JSON.stringify(manifest));
  const reopened=new VoiceStudio({dataDir:directory,resources,baseUrl:()=> 'http://127.0.0.1:1234',runWorker:async request=>{assert.equal(request.provider,'moss');await writeFile(request.output,wav());}});await reopened.initialized;t.after(()=>reopened.close());
  assert.equal(reopened.voices()[0].id,voice.id);assert.equal(reopened.voices()[0].provider,'moss');const parsed=new URL(job.result.url);assert.equal(reopened.acceptsAudio(...parsed.pathname.split('/').slice(-2)),true);
  await reopened.synthesize({voiceId:voice.id,text:'新台词'});
});
