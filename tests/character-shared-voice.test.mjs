import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterLife} from '../framework/character-life/service.mjs';

async function fixture(t,sharedVoice){
  const dataDir=await mkdtemp(join(tmpdir(),'character-shared-voice-')),store=new WorkbenchStore(dataDir);
  const character=store.saveCharacter(newCharacter({name:'小璃'}));
  const life=new CharacterLife({store,dataDir,sharedAI:{complete:async()=>({text:'好'})},sharedVoice});
  t.after(async()=>{await life.close();store.close();await rm(dataDir,{recursive:true,force:true});});
  life.configure(character.id,{mode:'full',media:{voiceEnabled:true,voiceId:'xiaoli-warm-bright',voiceMode:'always'}});
  return {life,character};
}

test('每条回复模式在陪伴、QQ 和精简陪伴共用音色标识，普通回复生成完整音频',async t=>{
  const calls=[];const {life,character}=await fixture(t,async value=>{calls.push(value);return {type:'record',url:'http://127.0.0.1/audio.wav',voiceId:value.voiceId,profileSha256:'same-profile'};});
  for(const moduleId of ['companion','qq','companion-lite']){
    const result=await life.processOutput({character,moduleId,conversationId:'test',text:'念念，早上好。'});
    assert.equal(result.actions.length,1);assert.equal(result.actions[0].type,'record');assert.equal(result.actions[0].profileSha256,'same-profile');
  }
  assert.deepEqual(calls.map(x=>x.moduleId),['companion','qq','companion-lite']);assert.ok(calls.every(x=>x.voiceId==='xiaoli-warm-bright'&&x.characterId===character.id));
});

test('模型重复请求 voice 不重复合成；沙盒只返回模拟动作',async t=>{
  let calls=0;const {life,character}=await fixture(t,async()=>{calls++;return {type:'record',url:'http://127.0.0.1/audio.wav'};});
  const text=JSON.stringify({reply:'你好呀',actions:[{type:'voice',text:'你好呀'},{type:'voice',text:'你好呀'}]});
  assert.equal((await life.processOutput({character,moduleId:'qq',text})).actions.length,1);assert.equal(calls,1);
  const simulated=await life.processOutput({character,moduleId:'qq',text,simulation:true});assert.equal(calls,1);assert.equal(simulated.actions[0].simulated,true);
});

test('合成失败保留文字并记录错误，改音色或取消后不交付旧音频',async t=>{
  let finish;const {life,character}=await fixture(t,async()=>new Promise(resolve=>{finish=resolve;}));
  const request=life.processOutput({character,moduleId:'companion',text:'你好'});
  while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
  life.configure(character.id,{media:{voiceEnabled:false}});finish({type:'record',url:'http://127.0.0.1/old.wav'});
  await assert.rejects(request,/改变|取消/);
  life.configure(character.id,{media:{voiceEnabled:true}});life.sharedVoice=async()=>{throw new Error('failed');};
  const failed=await life.processOutput({character,moduleId:'qq',text:'文字仍保留'});assert.equal(failed.text,'文字仍保留');assert.equal(failed.actions.length,0);
  assert.ok(life.view(character.id).events.some(event=>event.kind==='media.voice.failed'));
});
