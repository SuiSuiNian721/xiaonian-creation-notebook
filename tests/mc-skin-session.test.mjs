import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { WorkbenchStore } from '../framework/store.mjs';
import { MinecraftSkinSession } from '../framework/mc-skin-session.mjs';
import { createSkinApplication } from '../integrations/airi-minecraft/skin-application.mjs';

function png(){const chunk=(tag,data)=>{const body=Buffer.concat([Buffer.from(tag),data]),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([size,body,crc]);};const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(64,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(257*64))),chunk('IEND',Buffer.alloc(0))]);}
const hash='d'.repeat(64),textureUrl='https://textures.minecraft.net/texture/'+hash,profile={hash,model:'classic',signed:true};
const skinResult={success:true,job:{id:'fixture',status:'completed'},skin:{texture:{data:{value:Buffer.from(JSON.stringify({textures:{SKIN:{url:textureUrl}}})).toString('base64'),signature:'fixture-signature'}}}};
async function until(test){for(let i=0;i<100;i++){if(test())return;await new Promise(done=>setImmediate(done));}throw new Error('操作没有进入预期阶段');}
async function fixture(t,fetchImpl=async()=>new Response(JSON.stringify(skinResult))){
  const directory=await mkdtemp(join(tmpdir(),'mc-skin-session-')),store=new WorkbenchStore(directory),messages=[];
  const live={connection:{status:'connected',skinProtocol:1},session:{id:'first'}};
  const skins=new MinecraftSkinSession({store,dataDir:directory,connection:()=>live.connection,session:()=>live.session,send:(value,callback)=>{messages.push(value);callback?.();},record:()=>{},fetchImpl});
  t.after(async()=>{skins.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  skins.save({name:'fixture.png',base64:png().toString('base64'),model:'classic'});
  return {skins,messages,live,store};
}
test('应用异步生成并只接受当前会话当前请求的真实匹配资料',async t=>{
  const {skins,messages}=await fixture(t);assert.equal(skins.startApply().busy,true);const complete=skins.job.promise;
  await until(()=>messages.length);const request=messages[0];assert.equal(request.type,'skin');assert.equal(request.texture.url,textureUrl);
  skins.receive({type:'skin-result',sessionId:'old',requestId:request.requestId,ok:true,profile});assert.equal(skins.state().busy,true);
  skins.receive({type:'skin-result',sessionId:'first',requestId:'old',ok:true,profile});assert.equal(skins.state().busy,true);
  skins.receive({type:'skin-result',sessionId:'first',requestId:request.requestId,ok:true,profile});await complete;
  assert.equal(skins.state().application.status,'applied');assert.equal(skins.state().autoApply,true);
  assert.equal(JSON.stringify(skins.state()).includes('fixture-signature'),false);
});
test('游戏应用中拒绝替换配置，恢复默认保留 PNG 并关闭重连自动应用',async t=>{
  const {skins,messages}=await fixture(t);const imageId=skins.state().image.id;
  skins.startApply();const applying=skins.job.promise;await until(()=>messages.length);
  assert.throws(()=>skins.configure({model:'slim'}),{status:409});
  const request=messages[0];skins.receive({type:'skin-result',sessionId:'first',requestId:request.requestId,ok:true,profile});await applying;
  skins.startReset();const reset=skins.job.promise;const clear=messages.at(-1);assert.equal(clear.reset,true);
  skins.receive({type:'skin-result',sessionId:'first',requestId:clear.requestId,ok:true,profile:{hash:null,model:'classic',signed:false}});await reset;
  assert.equal(skins.state().image.id,imageId);assert.equal(skins.state().application.mode,'default');assert.equal(skins.state().autoApply,false);
});
test('断开会取消上传，迟到结果不能向新会话发送换肤命令',async t=>{
  let done;const pending=new Promise(resolve=>{done=resolve;});const {skins,messages,live}=await fixture(t,async()=>pending);
  skins.startApply();const old=skins.job.promise;skins.disconnect();live.session={id:'second'};
  done(new Response(JSON.stringify(skinResult)));await old;
  assert.equal(messages.some(value=>value.type==='skin'),false);assert.equal(skins.state().busy,false);assert.notEqual(skins.state().application.status,'applied');
  assert.equal(skins.state().generation.status,'idle','断开取消后不能继续显示正在生成');
});
test('确认后又收到不同皮肤会撤回已应用状态，不虚报原皮肤仍在使用',async t=>{
  const {skins,messages}=await fixture(t);skins.startApply();const job=skins.job.promise;await until(()=>messages.length);
  skins.receive({type:'skin-result',sessionId:'first',requestId:messages[0].requestId,ok:true,profile});await job;
  skins.receive({type:'skin-observed',sessionId:'first',profile:{hash:'e'.repeat(64),model:'slim',signed:true}});
  assert.equal(skins.state().application.status,'changed');
});
test('目标皮肤后立即收到更新材质，异步旧确认不能覆盖最新服务端观察',async t=>{
  const {skins}=await fixture(t),bot=new EventEmitter();bot._client=new EventEmitter();bot._client.uuid='fixture-player';
  const packet=value=>({action:{add_player:true},data:[{uuid:bot._client.uuid,player:{properties:[{name:'textures',signature:'fixture',value:Buffer.from(JSON.stringify({textures:{SKIN:{url:'https://textures.minecraft.net/texture/'+value}}})).toString('base64')}]}}]});
  bot.chat=()=>{bot._client.emit('player_info',packet(hash));bot._client.emit('player_info',packet('e'.repeat(64)));};
  const protocol=createSkinApplication(bot,{onObserved:observed=>skins.receive({type:'skin-observed',sessionId:'first',profile:observed})});t.after(()=>protocol.close());
  skins.send=(message,callback)=>{callback?.();if(message.type==='skin')void protocol.apply(message.texture).then(observed=>skins.receive({type:'skin-result',sessionId:'first',requestId:message.requestId,ok:true,profile:observed}));};
  skins.startApply();await skins.job.promise;
  assert.equal(protocol.current().hash,'e'.repeat(64));assert.notEqual(skins.state().application.status,'applied');assert.equal(skins.state().autoApply,false);
});
test('断线/旧运行端不允许应用，失败后仍能重试',async t=>{
  const {skins,messages,live}=await fixture(t);live.connection.status='disconnected';assert.throws(()=>skins.startApply(),{status:409});
  live.connection={status:'connected'};assert.throws(()=>skins.startApply(),{status:409});live.connection.skinProtocol=1;
  skins.startApply();let job=skins.job.promise;await until(()=>messages.length);skins.receive({type:'skin-result',sessionId:'first',requestId:messages[0].requestId,ok:false,error:'需要服务器皮肤模组'});await job;
  assert.equal(skins.state().application.status,'error');skins.startApply();job=skins.job.promise;await until(()=>messages.length>1);
  skins.receive({type:'skin-result',sessionId:'first',requestId:messages[1].requestId,ok:true,profile});await job;assert.equal(skins.state().application.status,'applied');
});
