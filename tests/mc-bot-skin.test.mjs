import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { WorkbenchStore } from '../framework/store.mjs';
import { MinecraftBotSkin, validateBotSkin } from '../framework/mc-bot-skin.mjs';

function chunk(type, data) {
  const tag=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);
  size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([tag,data])));
  return Buffer.concat([size,tag,data,checksum]);
}
function png(width=64,height=64) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
const upload=(bytes=png(),model='classic')=>({name:'岁岁.png',base64:bytes.toString('base64'),model});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function texture(model='classic',hash='a'.repeat(64)) {
  const url='https://textures.minecraft.net/texture/'+hash;
  const value=Buffer.from(JSON.stringify({textures:{SKIN:{url,...(model==='slim'?{metadata:{model:'slim'}}:{})}}})).toString('base64');
  return {uuid:'test-skin',texture:{data:{value,signature:Buffer.from('test-signature').toString('base64')},url:{skin:url},hash:{skin:hash}}};
}
async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'mc-bot-skin-')),store=new WorkbenchStore(directory);
  const skin=new MinecraftBotSkin({store,dataDir:directory,pollIntervalMs:1,...options});
  t.after(async()=>{skin.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {skin,store,directory};
}

test('标准新旧皮肤尺寸与模型通过实际 PNG 校验',()=>{
  const modern=validateBotSkin(upload());assert.equal(modern.width,64);assert.equal(modern.height,64);assert.equal(modern.model,'classic');
  assert.equal(validateBotSkin(upload(png(),'slim')).model,'slim');
  assert.equal(validateBotSkin(upload(png(64,32))).height,32);
  assert.throws(()=>validateBotSkin(upload(png(64,32),'slim')),/旧版|classic|Steve/);
});
test('拒绝伪造、坏 CRC、截断、错误尺寸和超大压缩皮肤',()=>{
  const damaged=png();damaged[30]^=1;
  for(const bytes of [Buffer.from('not png'),damaged,png().subarray(0,-2),png(128,128),Buffer.concat([png(),Buffer.alloc(600*1024)])]){
    assert.throws(()=>validateBotSkin(upload(bytes)),{status:400});
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(64,4);header[8]=8;header[9]=6;
  const bomb=Buffer.concat([png().subarray(0,8),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(1024*1024))),chunk('IEND',Buffer.alloc(0))]);
  assert.throws(()=>validateBotSkin(upload(bomb)),{status:400});
  assert.throws(()=>validateBotSkin({...upload(),base64:'!!bad!!'}),{status:400});
});
test('索引 PNG 校验调色板数量及反过滤后的索引，灰度 PNG 不接受调色板',()=>{
  const indexed=(depth,color,entries,index)=>{
    const header=Buffer.alloc(13);header.writeUInt32BE(64);header.writeUInt32BE(64,4);header[8]=depth;header[9]=color;
    const rowBytes=Math.ceil(64*depth/8),raw=Buffer.alloc((rowBytes+1)*64,index);
    for(let row=0;row<64;row++)raw[row*(rowBytes+1)]=0;
    return Buffer.concat([PNG_HEADER,chunk('IHDR',header),chunk('PLTE',Buffer.alloc(entries*3)),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  };
  const PNG_HEADER=png().subarray(0,8);
  assert.equal(validateBotSkin(upload(indexed(1,3,2,255))).width,64);
  for(const bytes of [indexed(8,3,1,1),indexed(1,3,3,0),indexed(8,0,1,0)])assert.throws(()=>validateBotSkin(upload(bytes)),{status:400});
});
test('保存失败保留原皮肤，各实例文件与设置互相隔离',async t=>{
  const a=await fixture(t),b=await fixture(t);
  const saved=a.skin.save(upload());assert.equal(saved.image.name,'岁岁.png');assert.equal(b.skin.state().image,null);
  assert.deepEqual(a.skin.image(saved.image.id).bytes,png());
  assert.throws(()=>a.skin.save(upload(png(128,128))),{status:400});
  assert.equal(a.skin.state().image.id,saved.image.id);
  assert.throws(()=>a.skin.image('wrong-revision'),{status:404});
  assert.equal((await readFile(a.skin.file())).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
});
test('重新导入同一有效皮肤会修复损坏的缓存图片',async t=>{
  const {skin}=await fixture(t);skin.save(upload());
  await writeFile(skin.file(),'broken cache');skin.save(upload());
  assert.deepEqual(skin.image().bytes,png());
});
test('匿名 PNG 队列上传立即轮询，缓存可复用且公开状态不泄漏签名或密钥',async t=>{
  const calls=[],skinValue=texture();
  const {skin}=await fixture(t,{fetchImpl:async(url,options={})=>{
    calls.push({url,options});
    if(options.method==='POST')return response({success:true,job:{id:'job-1',status:'waiting'}},202);
    return response({success:true,job:{id:'job-1',status:'completed',result:'test-skin'},skin:skinValue});
  }});
  skin.save(upload());const result=await skin.prepare();
  assert.equal(result.url,skinValue.texture.url.skin);assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(calls[0].options.body.get('visibility'),'unlisted');
  assert.equal(calls[0].options.body.get('variant'),'classic');
  assert.equal(calls[0].options.body.get('file').type,'image/png');
  assert.equal(skin.state().generation.status,'ready');
  assert.equal(JSON.stringify(skin.state()).includes(skinValue.texture.data.signature),false);
  await skin.prepare();assert.equal(calls.length,2,'已生成的同一皮肤不得重复上传');
});
test('队列直接完成但不带 skin 时按结果 ID 获取资料，拒绝错误体型',async t=>{
  const calls=[];
  const {skin}=await fixture(t,{fetchImpl:async(url,options={})=>{
    calls.push(url);return options.method==='POST'?response({success:true,job:{id:'job-2',status:'completed',result:'test-skin'}}):response({success:true,skin:texture('slim')});
  }});
  skin.save(upload());await assert.rejects(skin.prepare(),/体型/);
  assert.equal(calls.at(-1),'https://api.mineskin.org/v2/skins/test-skin');assert.equal(skin.state().texture,null);
});
test('兼容生成服务的 active 处理中状态并持续轮询至完成',async t=>{
  let calls=0;const {skin}=await fixture(t,{fetchImpl:async()=>{
    calls++;return calls<3?response({success:true,job:{id:'active-job',status:'active'}},calls===1?202:200):response({success:true,job:{id:'active-job',status:'completed'},skin:texture()});
  }});
  skin.save(upload());await skin.prepare();assert.equal(calls,3);assert.equal(skin.state().generation.status,'ready');
});
test('队列已受理后短暂返回 404 时只重查同一任务，不重复上传',async t=>{
  const calls=[];let polls=0;const {skin}=await fixture(t,{fetchImpl:async(url,options)=>{
    calls.push({url,method:options.method});
    if(options.method==='POST')return response({success:true,job:{id:'eventual-job',status:'waiting'}},202);
    return ++polls<3?response({success:false,errors:[{code:'job_not_found'}]},404):response({success:true,job:{id:'eventual-job',status:'completed'},skin:texture()});
  }});
  skin.save(upload());await skin.prepare();assert.equal(skin.state().generation.status,'ready');
  assert.equal(calls.filter(item=>item.method==='POST').length,1);assert.equal(polls,3);
  assert.ok(calls.slice(1).every(item=>item.url.endsWith('/queue/eventual-job')));
});
test('队列一直不存在时有限次结束，保留图片且不偷偷重交',async t=>{
  let posts=0,polls=0;const {skin}=await fixture(t,{fetchImpl:async(_url,options)=>{
    if(options.method==='POST'){posts++;return response({success:true,job:{id:'missing-job',status:'waiting'}},202);}
    polls++;return response({success:false,errors:[{code:'job_not_found'}]},404);
  }});
  skin.save(upload());await assert.rejects(skin.prepare(),/队列/);assert.equal(posts,1);assert.equal(polls,5);assert.equal(skin.state().generation.status,'error');assert.ok(skin.state().image);assert.equal(skin.state().texture,null);
});
test('取消队列响应体期间断开，旧查询不能重新写回等待状态',async t=>{
  let releaseCancel,startedCancel,queries=0;
  const cancellationStarted=new Promise(done=>{startedCancel=done;});
  const cancellation=new Promise(done=>{releaseCancel=done;});
  const {skin}=await fixture(t,{fetchImpl:async(_url,options)=>{
    if(options.method==='POST')return response({success:true,job:{id:'cancel-job',status:'waiting'}},202);
    queries++;
    return new Response(new ReadableStream({cancel(){startedCancel();return cancellation;}}),{status:404});
  }});
  skin.save(upload());const outcome=skin.prepare().catch(error=>error);
  await cancellationStarted;skin.invalidate();assert.equal(skin.state().generation.status,'idle');
  releaseCancel();assert.ok(await outcome instanceof Error);
  assert.equal(skin.state().generation.status,'idle');assert.equal(queries,1);
});
test('更换图片后丢弃旧上传结果，取消状态不能覆盖新皮肤',async t=>{
  let finish;const pending=new Promise(done=>{finish=done;});
  const {skin}=await fixture(t,{fetchImpl:async()=>pending});skin.save(upload());
  const old=skin.prepare();const outcome=old.catch(error=>error);
  const current=skin.save({...upload(),name:'另一套.png',model:'slim'});
  finish(response({success:true,job:{id:'job-old',status:'completed'},skin:texture()}));
  assert.ok(await outcome instanceof Error);assert.equal(skin.state().image.id,current.image.id);
  assert.equal(skin.state().texture,null);assert.equal(skin.state().generation.status,'idle');
});
test('可选密钥仅用于生成请求，更改模型会清除旧生成结果',async t=>{
  let authorization;
  const {skin}=await fixture(t,{fetchImpl:async(_url,options)=>{authorization=options.headers.Authorization;return response({success:true,job:{id:'ready',status:'completed'},skin:texture()});}});
  skin.save(upload());skin.configure({apiKey:'local-test-secret'});await skin.prepare();
  assert.equal(authorization,'Bearer local-test-secret');assert.equal(skin.state().hasApiKey,true);
  assert.equal(JSON.stringify(skin.state()).includes('local-test-secret'),false);
  skin.configure({model:'slim',clearApiKey:true});assert.equal(skin.state().image.model,'slim');assert.equal(skin.state().texture,null);assert.equal(skin.state().hasApiKey,false);
});
test('生成服务失败和断连后可重试，不伪报 ready',async t=>{
  let ok=false;
  const {skin}=await fixture(t,{fetchImpl:async()=>ok?response({success:true,skin:texture(),job:{id:'ok',status:'completed'}}):response({success:false,errors:[{code:'invalid_image',message:'bad'}]},400)});
  skin.save(upload());await assert.rejects(skin.prepare(),/生成|皮肤/);assert.equal(skin.state().generation.status,'error');
  ok=true;await skin.prepare();assert.equal(skin.state().generation.status,'ready');
});
