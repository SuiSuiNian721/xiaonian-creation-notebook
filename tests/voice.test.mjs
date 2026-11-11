import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SharedVoice} from '../framework/voice.mjs';

function wav(){
  const b=Buffer.alloc(4844);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4800,40);return b;
}
async function fixture(t,{slow=false,audio=wav()}={}){
  const directory=await mkdtemp(join(tmpdir(),'shared-voice-'));const profilePath=join(directory,'profile.json');
  const profile={voice_name:'小璃 · 温暖清亮',reference_sha256:'a'.repeat(64),reference_file:'reference.wav',model:'model',codec:'codec',parameters:{audio_temperature:1}};
  const bytes=JSON.stringify(profile);await writeFile(profilePath,bytes);const profileSha256=createHash('sha256').update(bytes).digest('hex');
  let calls=0,shutdowns=0,release;const tokens=new Set();const gate=new Promise(resolve=>{release=resolve;});
  const server=createServer(async(req,res)=>{
    if(req.url==='/health'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({service:'moss-character-voice',version:1,busy:false,loaded:true}));}
    assert.match(req.headers.authorization??'',/^Bearer .+/);
    tokens.add(req.headers.authorization);
    if(req.url==='/shutdown'){shutdowns++;res.setHeader('content-type','application/json');return res.end(JSON.stringify({stopped:true}));}
    if(req.url==='/v1/voices'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({voices:[{id:'xiaoli-warm-bright',name:profile.voice_name,profileSha256,referenceSha256:profile.reference_sha256}]}));}
    if(req.url==='/v1/audio/speech'){
      const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));
      assert.equal(body.voice,'xiaoli-warm-bright');assert.equal(body.model,'moss-tts-local');calls++;if(slow)await gate;
      res.writeHead(200,{'content-type':'audio/wav','x-voice-id':body.voice,'x-voice-profile-sha256':profileSha256,'x-reference-sha256':profile.reference_sha256});return res.end(audio);
    }
    res.writeHead(404);res.end();
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={serviceUrl:`http://127.0.0.1:${server.address().port}`,profilePath,pythonPath:''};
  const store={module:()=>({enabled:true,config})};
  const voice=new SharedVoice({store,globalStore:store,dataDir:directory,sharedDirectory:directory,baseUrl:()=> 'http://127.0.0.1:12345'});
  t.after(async()=>{release();await voice.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return {voice,config,profileSha256,release,calls:()=>calls,shutdowns:()=>shutdowns,tokens,directory};
}

test('共享音色保留同一参考身份，重复请求使用同一音频缓存，签名拒绝篡改',async t=>{
  const f=await fixture(t);const list=await f.voice.voices();assert.equal(list.voices[0].id,'xiaoli-warm-bright');
  const first=await f.voice.synthesize({text:'念念，早上好。',characterId:'a',moduleId:'voice'});
  const second=await f.voice.synthesize({text:'念念，早上好。',characterId:'a',moduleId:'qq'});
  assert.equal(first.type,'record');assert.equal(first.profileSha256,f.profileSha256);assert.equal(first.url,second.url);assert.equal(f.calls(),1);
  assert.equal(second.moduleId,'qq');
  const match=new URL(first.url).pathname.match(/\/internal\/voice-audio\/([a-f0-9]{64})\/([a-f0-9]{64})$/);assert.ok(match);
  const audio=await f.voice.audio(match[1],match[2]);assert.equal(audio.bytes.subarray(0,4).toString(),'RIFF');
  await assert.rejects(()=>f.voice.audio(match[1],'0'.repeat(64)),/无效|签名/);
});

test('并发读取音色只建立一份私有凭据',async t=>{
  const f=await fixture(t);await Promise.all([f.voice.voices(),f.voice.voices(),f.voice.voices()]);assert.equal(f.tokens.size,1);
});

test('状态探测识别复用的外部同身份服务，不依赖本窗口创建的子进程',async t=>{
  const f=await fixture(t);assert.equal(f.voice.state().running,false);
  const status=await f.voice.status();assert.equal(status.running,true);assert.equal(status.busy,false);
});

test('更换固定配方后仍能凭本机服务身份停止旧服务',async t=>{
  const f=await fixture(t);await f.voice.voices();
  const replacement=join(f.directory,'replacement.json');await writeFile(replacement,JSON.stringify({reference_sha256:'b'.repeat(64)}));
  f.config.profilePath=replacement;
  await assert.rejects(()=>f.voice.voices(),/不一致/);
  assert.deepEqual(await f.voice.stop(),{stopped:true});assert.equal(f.shutdowns(),1);
});

test('合成开始后取消不交付音频，排队取消不触发第二次合成',async t=>{
  const f=await fixture(t,{slow:true}),a=new AbortController(),b=new AbortController();
  const first=f.voice.synthesize({text:'第一句',signal:a.signal});
  while(!f.calls())await new Promise(resolve=>setTimeout(resolve,5));
  const second=f.voice.synthesize({text:'第二句',signal:b.signal});b.abort();a.abort();
  await assert.rejects(first,/取消/);await assert.rejects(second,/取消/);f.release();
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.calls(),1);
});

test('不接受不存在的音色或超长文字，不静默改用默认音色',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.voice.synthesize({text:'你好',voiceId:'another-voice'}),/音色/);
  await assert.rejects(()=>f.voice.synthesize({text:'字'.repeat(501)}),/500/);assert.equal(f.calls(),0);
});

test('宿主拒绝截断、空采样或非约定 PCM 格式的 WAV，不写入可播放缓存',async t=>{
  const empty=wav().subarray(0,44);empty.writeUInt32LE(36,4);empty.writeUInt32LE(0,40);
  const wrongFormat=wav();wrongFormat.writeUInt16LE(3,20);
  const truncated=wav().subarray(0,44);truncated.writeUInt32LE(4836,4);
  const wrongMagic=wav();wrongMagic[0]=0xd2;
  for(const [name,audio] of [['截断',truncated],['空采样',empty],['格式',wrongFormat],['无效魔数',wrongMagic]])await t.test(name,async t=>{
    const f=await fixture(t,{audio});await assert.rejects(()=>f.voice.synthesize({text:'完整声音'}),/完整 WAV/);
    assert.equal(f.voice.state().lastResult,null);
  });
});
