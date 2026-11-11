import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';

test('宿主公开共享配置与完整语音接口，取消传递到合成且音频仅接受签名访问',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-http-'));const calls=[];
  const voice={state:()=>({configured:true}),voices:async()=>({voices:[{id:'xiaoli-warm-bright',name:'小璃'}]}),start:async()=>({started:true}),stop:async()=>({stopped:true}),
    synthesize:async value=>{calls.push(value);return {type:'record',url:'http://127.0.0.1/audio',voiceId:value.voiceId};},audio:async(id,sig)=>{assert.equal(id,'a'.repeat(64));assert.equal(sig,'b'.repeat(64));return {bytes:Buffer.from('RIFF-test-WAVE'),mime:'audio/wav'};},close:async()=>{}};
  const app=await createWorkbench({dataDir:directory,instances:false,voiceOptions:{controller:voice}});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const request=(path,body,method='POST')=>fetch(app.url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(app.url+'/api/voice/voices')).status,200);
  const response=await request('/api/voice/speech',{text:'你好',voiceId:'xiaoli-warm-bright'});assert.equal(response.status,200);assert.equal((await response.json()).voiceId,'xiaoli-warm-bright');
  assert.equal(calls.length,1);assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal((await request('/api/voice/config',{values:{pythonPath:'python.exe',profilePath:'profile.json',serviceUrl:'http://127.0.0.1:17866'}},'PUT')).status,200);
  const config=await (await fetch(app.url+'/api/voice/config')).json();assert.equal(config.config.profilePath,'profile.json');
  const audio=await fetch(app.url+'/internal/voice-audio/'+'a'.repeat(64)+'/'+'b'.repeat(64),{headers:{origin:'null'}});assert.equal(audio.status,200);assert.equal(audio.headers.get('content-type'),'audio/wav');
  assert.equal((await fetch(app.url+'/api/voice/state',{headers:{origin:'https://example.com'}})).status,403);
});
