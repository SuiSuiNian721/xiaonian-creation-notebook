import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createWorkbench } from '../framework/server.mjs';

function png(){const chunk=(type,data)=>{const payload=Buffer.concat([Buffer.from(type),data]),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(payload));return Buffer.concat([n,payload,c]);};const h=Buffer.alloc(13);h.writeUInt32BE(64);h.writeUInt32BE(64,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc(257*64))),chunk('IEND',Buffer.alloc(0))]);}
test('皮肤 API 始终落在当前 Bot 实例，上传与游戏应用状态分开',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mc-skin-http-')),runtimeRoot=join(directory,'runtime');
  for(const name of ['worker.mjs','node_modules/tsx/package.json','node_modules/isolated-vm/isolated-vm.js']){const file=join(runtimeRoot,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,'');}
  const hash='f'.repeat(64),url='https://textures.minecraft.net/texture/'+hash;
  const result={success:true,job:{id:'fixture',status:'completed'},skin:{texture:{data:{value:Buffer.from(JSON.stringify({textures:{SKIN:{url}}})).toString('base64'),signature:'signed-fixture'}}}};
  const children=[];
  const app=await createWorkbench({dataDir:directory,instanceOptionsFactory:()=>({minecraftOptions:{runtimeRoot,nodePath:process.execPath,skinOptions:{fetchImpl:async()=>new Response(JSON.stringify(result))},spawnImpl:()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.connected=true;child.sent=[];
    child.send=(value,done)=>{child.sent.push(value);done?.();queueMicrotask(()=>{
      if(value.type==='init')child.emit('message',{type:'online',sessionId:value.sessionId,username:value.settings.playerName,version:'1.20.1',paused:true,skinProtocol:1});
      if(value.type==='skin')child.emit('message',{type:'skin-result',sessionId:value.sessionId,requestId:value.requestId,ok:true,profile:value.reset?{hash:null,model:'classic',signed:false}:{hash,model:'classic',signed:true}});
      if(value.type==='disconnect')child.kill();
    });};child.kill=()=>{child.connected=false;child.emit('exit',0);};children.push(child);return child;
  }}})});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const request=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const a=(await request('/api/instances',{moduleId:'mc-play'})).value.instance,b=(await request('/api/instances',{moduleId:'mc-play'})).value.instance;
  const path=id=>'/instances/'+id+'/api/modules/mc-play';
  const saved=await request(path(a.id)+'/skin',{name:'Skin.png',base64:png().toString('base64'),model:'classic'},'PUT');
  assert.equal(saved.status,200);assert.equal(saved.value.skin.application.status,'idle');assert.equal(children.length,0);
  assert.equal(saved.value.connection.status,'disconnected');assert.ok(saved.value.config,'皮肤操作返回完整实例状态，界面不能丢失连接与身份');
  assert.equal((await request(path(b.id)+'/state')).value.skin.image,null);
  const preview=saved.value.skin.image.previewUrl;assert.ok(preview.startsWith('/instances/'+a.id+'/'));
  const image=await fetch(app.url+preview);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png());
  const wrong=await fetch(app.url+preview.replace(a.id,b.id));assert.equal(wrong.status,404);
  await request(path(a.id)+'/connection',{playerName:'SkinHTTP_A'},'PUT');await request(path(a.id)+'/connect',{});
  await new Promise(done=>setImmediate(done));const applying=await request(path(a.id)+'/skin/apply',{});assert.equal(applying.status,202);
  let state;for(let i=0;i<50;i++){state=(await request(path(a.id)+'/state')).value;if(!state.skin.busy)break;await new Promise(done=>setTimeout(done,2));}
  assert.equal(state.skin.application.status,'applied');assert.equal((await request(path(b.id)+'/state')).value.skin.application.status,'idle');
  assert.equal(children.length,1);assert.equal(children[0].sent.filter(item=>item.type==='skin').length,1);
  assert.equal((await request(path(a.id)+'/skin',{apiKey:'secret-http-fixture'},'PATCH')).value.skin.hasApiKey,true);
  assert.equal(JSON.stringify((await request(path(a.id)+'/state')).value).includes('secret-http-fixture'),false);
});
