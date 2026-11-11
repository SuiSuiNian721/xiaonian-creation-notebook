import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
import {newCharacter} from '../framework/contracts.mjs';

// Explicit manual QA: one real GPU synthesis, using an isolated profile.
const directory=resolve(process.env.AI_FUTURE_VOICE_QA_DIR||join('qa','shared-voice-'+Date.now()));
await mkdir(directory,{recursive:true});
const app=await createWorkbench({dataDir:join(directory,'profile'),instances:false});
const {store,life}=app.context;
const report={at:new Date().toISOString(),directory,usesRealMoss:true,realQQ:false,ok:false,entries:[]};
async function api(path,body){
  const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(950000)});
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
}
try{
  store.saveConfig('voice',{pythonPath:'E:\\voice\\envs\\moss-py312\\Scripts\\python.exe',profilePath:'E:\\voice\\data\\outputs\\MOSS_小璃固定参考克隆_20261108\\固定参考配置.json',serviceUrl:'http://127.0.0.1:17866'});
  for(const moduleId of ['character-full','companion-lite']){
    store.setEnabled(moduleId,true);
    const plan=app.context.installations.plan(moduleId,{optionalIds:[]});
    if(plan.canInstall){app.context.installations.install(moduleId,{planId:plan.planId,optionalIds:[]});await app.context.installations.active.get(moduleId).promise;}
    assert.equal(app.context.installations.state(moduleId).prerequisitesReady,true);
  }
  const character=store.saveCharacter(newCharacter({name:'小璃语音验收'}));
  life.configure(character.id,{mode:'full',media:{voiceEnabled:true,voiceId:'xiaoli-warm-bright',voiceMode:'always'}});
  const text='念念，我在这里。今天也想和你一起，发现一点温暖的小事情。';
  console.log('REAL_VOICE_START '+directory);
  const started=Date.now();
  const direct=await api('/api/voice/speech',{text,voiceId:'xiaoli-warm-bright',characterId:character.id});
  report.freshInference=Date.parse(direct.createdAt)>=started;
  report.entries.push({entry:'角色声音 HTTP',...direct,elapsedMs:Date.now()-started});
  for(const moduleId of ['companion','qq','companion-lite']){
    const result=await life.processOutput({character,moduleId,conversationId:'shared-voice-qa',text});
    assert.equal(result.actions.length,1);const action=result.actions[0];
    assert.equal(action.type,'record');assert.equal(action.profileSha256,direct.profileSha256);assert.equal(action.referenceSha256,direct.referenceSha256);assert.equal(action.url,direct.url);
    report.entries.push({entry:moduleId,...action});
  }
  const audioResponse=await fetch(direct.url);assert.equal(audioResponse.status,200);
  const audio=Buffer.from(await audioResponse.arrayBuffer());assert.equal(audio.subarray(0,4).toString(),'RIFF');assert.equal(audio.readUInt32LE(4)+8,audio.length);
  await writeFile(join(directory,'小璃_共享音色_HTTP验收.wav'),audio);
  report.audio={file:join(directory,'小璃_共享音色_HTTP验收.wav'),bytes:audio.length,sampleRate:audio.readUInt32LE(24)};report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n','utf8');
  await app.close();console.log(JSON.stringify(report,null,2));
}
