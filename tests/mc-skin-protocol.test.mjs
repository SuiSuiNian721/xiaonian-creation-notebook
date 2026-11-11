import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSkinApplication, playerInfoSkin } from '../integrations/airi-minecraft/skin-application.mjs';

const uuid='01234567-1234-4321-abcd-0123456789ab',hash='b'.repeat(64);
const url='https://textures.minecraft.net/texture/'+hash;
function packet({id=uuid,model='slim',skinHash=hash,empty=false}={}) {
  const value=Buffer.from(JSON.stringify({profileId:'signed-provider-account',textures:{SKIN:{url:'http://textures.minecraft.net/texture/'+skinHash,...(model==='slim'?{metadata:{model}}:{})}}})).toString('base64');
  return {action:{add_player:true},data:[{uuid:id,player:{name:'TestBot',properties:empty?[]:[{name:'textures',value,signature:'signed-texture'}]}}]};
}
function fixture(t,options={}) {
  const bot=new EventEmitter();bot._client=new EventEmitter();bot._client.uuid=uuid;bot.username='TestBot';bot.entity={};
  const commands=[];bot.chat=value=>commands.push(value);
  const observed=[],skin=createSkinApplication(bot,{onObserved:value=>observed.push(value),...options});
  t.after(()=>skin.close());return {bot,skin,commands,observed};
}
test('只从自己 UUID 的 add-player 属性取皮肤，不使用签名账户 profileId',()=>{
  assert.equal(playerInfoSkin(packet(),uuid).hash,hash);
  assert.equal(playerInfoSkin(packet({id:'another-player'}),uuid),undefined);
  assert.equal(playerInfoSkin({action:{update_latency:true},data:[{uuid}]},uuid),undefined);
  assert.equal(playerInfoSkin(packet({empty:true}),uuid).hash,null);
  const legacy=packet();legacy.action='add_player';legacy.data=legacy.data.map(({uuid,player})=>({uuid,name:player.name,properties:player.properties}));
  assert.equal(playerInfoSkin(legacy,uuid).model,'slim');
});
test('发送换肤命令后等待自己匹配的服务端纹理，聊天成功文字不算完成',async t=>{
  const {bot,skin,commands}=fixture(t);let completed=false;
  const pending=skin.apply({url,hash,model:'slim'}).then(value=>{completed=true;return value;});
  assert.deepEqual(commands,['/skin set web slim "'+url+'"']);
  bot.emit('message',{toString:()=> 'Skin changed successfully!'},'system');
  bot._client.emit('player_info',packet({id:'other'}));bot._client.emit('player_info',packet({model:'classic'}));
  await new Promise(done=>setImmediate(done));assert.equal(completed,false);
  bot._client.emit('player_info',packet());assert.equal((await pending).hash,hash);
});
test('恢复默认也等待服务端清除纹理，重复已确认的皮肤可直接返回',async t=>{
  const {bot,skin,commands}=fixture(t);bot._client.emit('player_info',packet());
  assert.equal((await skin.apply({url,hash,model:'slim'})).hash,hash);assert.equal(commands.length,0);
  const pending=skin.apply({reset:true});assert.deepEqual(commands,['/skin clear']);
  bot._client.emit('player_info',packet({empty:true}));assert.equal((await pending).hash,null);
});
test('拒绝非法 URL 或体型，不能借皮肤操作注入聊天命令',async t=>{
  const {skin,commands}=fixture(t);
  for(const value of [{url:url+'\n/op Somebody',hash,model:'slim'},{url:'https://example.com/a.png',hash,model:'slim'},{url,hash,model:'evil'},{url,hash:'wrong',model:'slim'}])await assert.rejects(skin.apply(value));
  assert.equal(commands.length,0);
});
test('未知命令/权限不足和超时有可恢复错误，断线不会留下等待',async t=>{
  const {bot,skin}=fixture(t,{timeoutMs:15});
  let pending=skin.apply({url,hash,model:'slim'});
  bot._client.emit('system_chat',{content:JSON.stringify({translate:'command.unknown.command'})});
  await assert.rejects(pending,/SkinRestorer|换肤/);
  await assert.rejects(skin.apply({url,hash,model:'slim'}),/确认|超时/);
  pending=skin.apply({url,hash,model:'slim'});bot.emit('end','closed');await assert.rejects(pending,/断开|关闭/);
});
test('取消当前等待不影响后续操作，旧 profile 不得满足新目标',async t=>{
  const {bot,skin}=fixture(t);const controller=new AbortController();
  const prior=skin.apply({url,hash,model:'slim'},{signal:controller.signal});controller.abort();await assert.rejects(prior,/取消/);
  const nextHash='c'.repeat(64),nextUrl='https://textures.minecraft.net/texture/'+nextHash;let completed=false;
  const pending=skin.apply({url:nextUrl,hash:nextHash,model:'classic'}).then(value=>{completed=true;return value;});
  bot._client.emit('player_info',packet());await new Promise(done=>setImmediate(done));assert.equal(completed,false);
  bot._client.emit('player_info',packet({skinHash:nextHash,model:'classic'}));assert.equal((await pending).hash,nextHash);
});
test('取消已发送的换肤后恢复默认不能复用发送前的空皮肤确认',async t=>{
  const {bot,skin,commands}=fixture(t);bot._client.emit('player_info',packet({empty:true}));
  const controller=new AbortController(),prior=skin.apply({url,hash,model:'slim'},{signal:controller.signal});
  controller.abort();await assert.rejects(prior,/取消/);
  let completed=false;const reset=skin.apply({reset:true}).then(value=>{completed=true;return value;});
  await new Promise(done=>setImmediate(done));assert.equal(completed,false);
  assert.equal(commands.at(-1),'/skin clear');bot._client.emit('player_info',packet({empty:true}));assert.equal((await reset).hash,null);
});
