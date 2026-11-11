import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {preparePipelineDataset,readProcessedDataset,verifyPipelineDataset} from '../framework/training-dataset.mjs';
import {buildTrainingCaptionMessages,captionTrainingDataset} from '../framework/training-ai-caption.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64');
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{format='tags',policy='fill-missing',purpose='character',count=2,caption}={}){
  const directory=await mkdtemp(join(tmpdir(),'training-ai-caption-')),source=join(directory,'source'),owner='owner-fixture';
  await mkdir(source);
  for(let n=1;n<=count;n++)await writeFile(join(source,n+'.png'),png);
  if(caption)await writeFile(join(source,'1.txt'),caption);
  const input={sourcePath:source,captionPolicy:policy,purpose},plan={purpose,trigger:'test_identity',repeats:2,strategy:{captionFormat:format,suppressTags:purpose==='style'?['watercolor','sketch']:[]}};
  const dataset=await preparePipelineDataset({root:join(directory,'workflows','one'),sourcePath:source,owner,input,plan});
  const calls=[],sharedAI={config:()=>({enabled:true,provider:'openai',model:'vision-fixture'}),async complete(messages,options){calls.push({messages,options,bytes:await readFile(options.images[0].path)});return{text:format==='tags'?'blue hair, red coat, standing':'A person in a red coat is standing beside a window.'};}};
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return{directory,source,dataset,owner,input,plan,sharedAI,calls,requestId:'one.tag.0'};
}

test('接入视觉模型逐图生成 TXT，哈希与完成清单兼容现有训练验证',async t=>{
  const f=await fixture(t),progress=[];
  const result=await captionTrainingDataset({...f,onProgress:value=>progress.push(value)});
  assert.equal(result.missing,0);assert.equal(result.captions.complete,true);assert.equal(result.captions.generatedCount,2);
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].bytes,png);
  assert.equal(f.calls[0].options.moduleId,'training');assert.equal(f.calls[0].options.policy,'chat-only-vision');
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);assert.ok(f.calls[0].options.timeoutMs>0);
  assert.equal(progress.at(-1).completed,2);assert.equal(progress.at(-1).total,2);
  for(const item of result.items){const text=await readFile(join(result.imageDir,item.name.replace(/\.png$/,'.txt')),'utf8');assert.match(text,/^test_identity, blue hair/);assert.equal(item.captionSha256,digest(text));}
  assert.equal((await readProcessedDataset(f.dataset,f.owner,null,{captionRequestId:f.requestId,captionFormat:'tags'})).missing,0);
  assert.equal((await verifyPipelineDataset(result,{},f.plan)).captioned,2);
  assert.deepEqual(await readdir(f.source),['1.png','2.png']);
  assert.equal((await readdir(result.workspace)).some(name=>name.startsWith('.ai-caption-input-')),false);
});

test('已有匹配标注复用且保留源文件；自然语言与用途规则进入请求',async t=>{
  const original='A person in a green coat is walking beside a river.\n',f=await fixture(t,{format:'natural',purpose:'pose',caption:original});
  const result=await captionTrainingDataset(f);
  assert.equal(f.calls.length,1);assert.equal(result.captions.reusedCount,1);
  assert.equal(await readFile(join(f.source,'1.txt'),'utf8'),original);
  assert.match(f.calls[0].messages.map(m=>m.content).join('\n'),/姿势|关节/);
  assert.match(await readFile(join(result.imageDir,'originals','000002.txt'),'utf8'),/^test_identity\. A person/);
});

test('画风标签去除固定画风词，触发词由宿主稳定添加且不会重复',async t=>{
  const f=await fixture(t,{purpose:'style',count:1});
  f.sharedAI.complete=async()=>({text:'test_identity, watercolor, blue sky, sketch, red coat, standing'});
  const result=await captionTrainingDataset(f),text=await readFile(join(result.imageDir,'originals','000001.txt'),'utf8');
  assert.equal(text,'test_identity, blue sky, red coat, standing\n');
});

test('失败后同请求继续只处理未完成图片，regenerate 也保留已确认结果',async t=>{
  const f=await fixture(t,{policy:'regenerate'});let calls=0;
  f.sharedAI.complete=async()=>{if(++calls===2)throw new Error('temporary offline');return{text:'red coat, standing, outdoors'};};
  await assert.rejects(captionTrainingDataset(f),/temporary offline/);
  const partial=JSON.parse(await readFile(join(f.dataset.workspace,'dataset-manifest.json'),'utf8'));
  assert.equal(partial.captions.complete,false);assert.equal(partial.captions.completed,1);
  const result=await captionTrainingDataset(f);assert.equal(calls,3);assert.equal(result.captions.generatedCount,2);
  await captionTrainingDataset(f);assert.equal(calls,3,'完整请求重放不再请求模型');
});

test('取消不等待忽略 signal 的模型，迟到答复不能写入标注',async t=>{
  const f=await fixture(t,{count:1}),controller=new AbortController();let release,entered;
  const ready=new Promise(done=>{entered=done;});
  f.sharedAI.complete=async()=>{entered();return new Promise(done=>{release=done;});};
  const pending=captionTrainingDataset({...f,signal:controller.signal});await ready;controller.abort();
  await assert.rejects(pending,/取消|abort/i);release({text:'red coat, standing, outdoors'});
  await new Promise(done=>setTimeout(done,30));
  assert.equal((await readdir(join(f.dataset.imageDir,'originals'))).some(name=>name.endsWith('.txt')),false);
  assert.equal(JSON.parse(await readFile(join(f.dataset.workspace,'dataset-manifest.json'),'utf8')).captions.complete,false);
});

test('模型超时可续作，空文本或格式错误不伪造完成结果',async t=>{
  const f=await fixture(t,{format:'natural',count:1});f.sharedAI.complete=async()=>new Promise(()=>{});
  await assert.rejects(captionTrainingDataset({...f,timeoutMs:15}),/超时/);
  f.sharedAI.complete=async()=>({text:'blue hair, red coat, standing'});
  await assert.rejects(captionTrainingDataset(f),/自然语言|格式/);
  f.sharedAI.complete=async()=>({text:'A person wearing a red coat stands beside a window.'});
  assert.equal((await captionTrainingDataset(f)).missing,0);
});

test('已有标注模式缺失时不请求 AI，篡改的工作标注也不悄悄覆盖',async t=>{
  const f=await fixture(t,{policy:'existing',count:1});await assert.rejects(captionTrainingDataset(f),/已有标注|重新标注/);assert.equal(f.calls.length,0);
  const g=await fixture(t,{count:1,caption:'blue hair, red coat, standing\n'});
  await writeFile(join(g.dataset.imageDir,'originals','000001.txt'),'changed manually\n');
  await assert.rejects(captionTrainingDataset(g),/标注.*改变|标注.*校验/);assert.equal(g.calls.length,0);
});

test('拒绝错误归属、越界及篡改图片，在请求前阻断',async t=>{
  const f=await fixture(t,{count:1});
  await assert.rejects(captionTrainingDataset({...f,owner:'other'}),/归属|属于/);
  await writeFile(join(f.dataset.imageDir,'originals','000001.png'),Buffer.concat([png,Buffer.from('changed')]));
  await assert.rejects(captionTrainingDataset(f),/图像.*校验|图片.*改变/);assert.equal(f.calls.length,0);
  const g=await fixture(t,{count:1}),manifestPath=join(g.dataset.workspace,'dataset-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.items[0].name='../../source/1.png';await writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(captionTrainingDataset(g),/路径|清单|原图/);assert.equal(g.calls.length,0);
});

test('请求期间图片变化不能提交 TXT；链接标注不被写穿',async t=>{
  const f=await fixture(t,{count:1});f.sharedAI.complete=async()=>{await writeFile(join(f.dataset.imageDir,'originals','000001.png'),'changed');return{text:'red coat, standing, outdoors'};};
  await assert.rejects(captionTrainingDataset(f),/图像.*校验|图片.*改变/);
  assert.equal((await readdir(join(f.dataset.imageDir,'originals'))).some(name=>name.endsWith('.txt')),false);
  const g=await fixture(t,{count:1}),outside=join(g.directory,'outside.txt');await writeFile(outside,'untouched');
  try{await symlink(outside,join(g.dataset.imageDir,'originals','000001.txt'));}catch(error){if(['EPERM','EACCES'].includes(error.code))return;throw error;}
  await assert.rejects(captionTrainingDataset(g),/链接/);assert.equal(await readFile(outside,'utf8'),'untouched');assert.equal(g.calls.length,0);
});

test('同图集并发会拒绝第二个请求，不重复发送图片',async t=>{
  const f=await fixture(t,{count:1});let entered,release,calls=0;
  const ready=new Promise(done=>{entered=done;});
  f.sharedAI.complete=async()=>{calls++;entered();return new Promise(done=>{release=done;});};
  const first=captionTrainingDataset(f);await ready;
  await assert.rejects(captionTrainingDataset(f),/正在标注/);assert.equal(calls,1);
  release({text:'red coat, standing, outdoors'});assert.equal((await first).missing,0);
});

test('用途和补充提示词明确进入模型请求，改变已提交请求的提示词不能复用',async t=>{
  const f=await fixture(t,{count:1});f.input.aiCaptionPrompt='只描述可见的红色围巾。';
  const messages=buildTrainingCaptionMessages(f);
  assert.match(messages[0].content,/固定的脸型|身份绑定/);assert.match(messages[0].content,/红色围巾/);
  assert.match(buildTrainingCaptionMessages({...f,plan:{...f.plan,purpose:'style'}})[0].content,/画师|笔触/);
  assert.match(buildTrainingCaptionMessages({...f,plan:{...f.plan,purpose:'pose'}})[0].content,/左右肢体|关节/);
  await captionTrainingDataset(f);
  await assert.rejects(captionTrainingDataset({...f,input:{...f.input,aiCaptionPrompt:'换一套规则'}}),/提示词.*改变/);
  assert.equal(f.calls.length,1);
});

test('AI 视觉拒绝超大图片和不支持格式，不假装完成或发出模型请求',async t=>{
  for(const mode of ['large','bmp']){
    const f=await fixture(t,{count:1}),item=f.dataset.items[0];
    if(mode==='large'){const bytes=Buffer.alloc(8*1024*1024+1);png.copy(bytes);await writeFile(join(f.dataset.imageDir,item.name),bytes);item.sha256=digest(bytes);}
    else{item.name=item.name.replace('.png','.bmp');const bytes=Buffer.from('BM fixture bitmap');await writeFile(join(f.dataset.imageDir,item.name),bytes);item.sha256=digest(bytes);}
    await writeFile(join(f.dataset.workspace,'dataset-manifest.json'),JSON.stringify(f.dataset));
    await assert.rejects(captionTrainingDataset(f),mode==='large'?/8 MiB/:/PNG.*JPEG.*WebP/);assert.equal(f.calls.length,0);
    assert.equal(JSON.parse(await readFile(join(f.dataset.workspace,'dataset-manifest.json'),'utf8')).captions.complete,false);
  }
});

test('复用已经校验的 BMP 标注不需要调用视觉接口',async t=>{
  const f=await fixture(t,{count:1,policy:'existing',caption:'red coat, standing, outdoors\n'}),item=f.dataset.items[0];
  item.name=item.name.replace('.png','.bmp');const bytes=Buffer.from('BM fixture bitmap');await writeFile(join(f.dataset.imageDir,item.name),bytes);
  item.sha256=digest(bytes);item.captionImageSha256=item.sha256;
  await writeFile(join(f.dataset.workspace,'dataset-manifest.json'),JSON.stringify(f.dataset));
  assert.equal((await captionTrainingDataset(f)).missing,0);assert.equal(f.calls.length,0);
});

test('取消保留已提交的图片进度，继续不会重复调用该图片',async t=>{
  const f=await fixture(t),controller=new AbortController();
  await assert.rejects(captionTrainingDataset({...f,signal:controller.signal,onProgress:({completed})=>{if(completed===1)controller.abort();}}),/取消/);
  assert.equal(f.calls.length,1);
  const result=await captionTrainingDataset(f);assert.equal(result.captions.generatedCount,2);assert.equal(f.calls.length,2);
});

test('生成后修改早期图片标注不应写入完成标记',async t=>{
  const f=await fixture(t);let calls=0;
  f.sharedAI.complete=async()=>{if(++calls===2)await writeFile(join(f.dataset.imageDir,'originals','000001.txt'),'manual edit');return{text:'red coat, standing, outdoors'};};
  await assert.rejects(captionTrainingDataset(f),/标注.*改变|标注.*校验/);
  assert.equal(JSON.parse(await readFile(join(f.dataset.workspace,'dataset-manifest.json'),'utf8')).captions.complete,false);
});
