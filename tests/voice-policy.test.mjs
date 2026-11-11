import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterLife} from '../framework/character-life/service.mjs';
import {normalizeSettings} from '../framework/character-life/settings.mjs';
const policy=await import('../framework/character-life/voice-policy.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});

test('语音只由本轮明确要求触发；否定、引用、代码、讨论能力保留文字',()=>{
  assert.equal(typeof policy.voiceRequested,'function');
  for(const input of ['测试：回复一条语音','给我发条语音吧','用语音回复我','把这句话读出来','念给我听吧','我想听你的声音','不用担心，给我发条语音吧','请读出“晚安”'])assert.equal(policy.voiceRequested(input),true,input);
  for(const input of ['早上好','不要发语音','不用语音，文字就好','用语音回复我，但是只发文字','你能发语音吗？','为什么不能生成语音？','语音是怎么生成的','他说“给我发条语音”是什么意思','```\n给我发条语音\n```','> 发一条语音','请不要读出来','不要用你的声音读这段话'])assert.equal(policy.voiceRequested(input),false,input);
});

test('常见简短请求和否定变体不能反转发送意图',()=>{
  for(const input of ['语音回复我','语音回复一下','请语音回答','请生成一条语音'])assert.equal(policy.voiceRequested(input),true,input);
  for(const input of ['这次不发语音','先不发语音','你现在能发语音了吗？','你不是说不能发语音吗？','我不想让你用语音回复','不许发语音'])assert.equal(policy.voiceRequested(input),false,input);
});

test('默认按要求发送；旧已开启声音配置保留每条回复，非法模式拒绝',()=>{
  assert.equal(normalizeSettings().media.voiceMode,'requested');
  assert.equal(normalizeSettings({media:{voiceEnabled:true,voiceId:'xiaoli-warm-bright'}}).media.voiceMode,'always');
  assert.equal(normalizeSettings({media:{voiceEnabled:true}},{media:{voiceMode:'requested'}}).media.voiceMode,'requested');
  assert.throws(()=>normalizeSettings(null,{media:{voiceMode:'random'}}),/发送方式/);
});

async function fixture(t,mode='lite'){
  const directory=await mkdtemp(join(tmpdir(),'requested-voice-')),store=new WorkbenchStore(directory),calls=[];
  const character=store.saveCharacter(newCharacter({name:'测试角色'}));
  const life=new CharacterLife({store,dataDir:directory,sharedAI:{complete:async()=>({text:'好'})},sharedVoice:async input=>{calls.push(input);return {type:'record',voiceId:input.voiceId,url:'http://127.0.0.1/audio.wav'};}});
  life.configure(character.id,{mode,memory:{autoExtract:false},media:{voiceEnabled:true,voiceId:'xiaoli-warm-bright',voiceMode:'requested'}});
  t.after(async()=>{await life.close();store.close();await rm(directory,{recursive:true,force:true});});return {life,character,calls};
}

test('三入口在本轮要求时合成，普通下一轮不继承；模型 voice 动作不能自行触发',async t=>{
  for(const mode of ['lite','full'])await t.test(mode,async t=>{
    const {life,character,calls}=await fixture(t,mode);
    for(const moduleId of ['qq','companion','companion-lite']){
      const response=JSON.stringify({reply:'晚安呀。',actions:[{type:'voice',text:'晚安呀。'}]});
      const normal=await life.processOutput({character,moduleId,text:response,context:{latestInput:'晚安'}});assert.equal(normal.actions.length,0);
      const requested=await life.processOutput({character,moduleId,text:response,context:{latestInput:'给我发条语音说晚安'}});assert.equal(requested.actions[0]?.type,'record');
      const next=await life.processOutput({character,moduleId,text:'明天见。',context:{latestInput:'明天见'}});assert.equal(next.actions.length,0);
      const negative=await life.processOutput({character,moduleId,text:response,context:{latestInput:'不要发语音'}});assert.equal(negative.actions.length,0);
    }
    assert.equal(calls.length,3);
  });
});

test('实际输入可直接传入；手动总开关关闭后明确要求也不生成',async t=>{
  const {life,character,calls}=await fixture(t);
  assert.equal((await life.processOutput({character,moduleId:'qq',latestInput:'回复一条语音',text:'我在。'})).actions.length,1);
  life.configure(character.id,{media:{voiceEnabled:false}});
  assert.equal((await life.processOutput({character,moduleId:'qq',latestInput:'回复一条语音',text:'我在。'})).actions.length,0);assert.equal(calls.length,1);
});

test('精简与完整上下文都声明真实已配置语音能力，并区分本轮文字或语音',async t=>{
  for(const mode of ['lite','full'])await t.test(mode,async t=>{
    const {life,character,calls}=await fixture(t,mode);
    const context=await life.context({character,moduleId:'qq',latestInput:'测试：回复一条语音',history:[]});
    assert.match(context.prompt,/共享音色/);assert.match(context.prompt,/工作台/);assert.match(context.prompt,/本轮.*语音/);
    const plain=await life.context({character,moduleId:'qq',latestInput:'你能发语音吗？',history:[]});assert.match(plain.prompt,/本轮.*文字/);assert.match(plain.prompt,/共享音色/);
    assert.equal(calls.length,0);
  });
});
