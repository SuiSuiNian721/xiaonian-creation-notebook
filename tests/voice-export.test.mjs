import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'voice-export-'));
  const wav=Buffer.alloc(48044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  const config={pythonPath:process.execPath,generatorPath:directory,clonePath:directory,codecPath:directory};
  const resources={initialized:Promise.resolve(),state:()=>({config,components:['runtime','generator','clone','codec'].map(id=>({id,installed:true})),task:null}),close:async()=>{}};
  const app=await createWorkbench({dataDir:join(directory,'profile'),instances:false,voiceStudioOptions:{resources,runWorker:async request=>{await writeFile(request.output,wav);if(request.referenceOutput)await writeFile(request.referenceOutput,wav);}}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const post=async(path,value)=>{const response=await fetch(app.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});assert.ok([200,202].includes(response.status));return response.json();};
  await post('/api/voice-studio/jobs',{mode:'design',instruction:'测试声音',text:'仅测试文件导出。'});await app.context.voiceStudio.pending;
  const job=app.context.voiceStudio.state().job,voice=await post('/api/voice-studio/save',{jobId:job.id,name:'念念的测试声线'});
  return {app,directory,wav,job,voice,url:app.url+'/api/voice/voices/'+voice.id+'/audio'};
}
test('保存音色按 ID 导出已验证的参考 WAV，保持候选和共享资料不变',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.app.context.voiceStudio.state());
  const response=await fetch(f.url);assert.equal(response.status,200,'已保存音色需要有独立音频导出接口');assert.equal(response.headers.get('content-type'),'audio/wav');
  assert.match(response.headers.get('content-disposition'),/attachment; filename\*=UTF-8''/);assert.match(decodeURIComponent(response.headers.get('content-disposition')),/念念的测试声线\.wav/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.wav);assert.equal(JSON.stringify(f.app.context.voiceStudio.state()),before);
  const candidate=await fetch(f.job.result.url);assert.equal(candidate.status,200);assert.deepEqual(Buffer.from(await candidate.arrayBuffer()),f.wav);
  assert.equal((await fetch(f.url,{method:'POST'})).status,405);
  assert.equal((await fetch(f.app.url+'/api/voice/voices/voice-00000000-0000-4000-8000-000000000000/audio')).status,404);
  assert.equal((await fetch(f.url+'?path=C%3A%5Cprivate.wav')).status,400,'导出接口不接受路径参数');
  const other=await createWorkbench({dataDir:join(f.directory,'other'),instances:false});
  try{assert.equal((await fetch(other.url+'/api/voice/voices/'+f.voice.id+'/audio')).status,404,'独立资料目录不可读取其他声音库');}finally{await other.close();}
});
test('音色参考文件篡改或目录联接不能成为导出源',async t=>{
  const f=await fixture(t),path=join(f.app.context.voiceStudio.directory,'voices',f.voice.id,'reference.wav');
  const bytes=await readFile(path);bytes[bytes.length-1]=1;await writeFile(path,bytes);
  assert.equal((await fetch(f.url)).status,409);
  const folder=join(f.app.context.voiceStudio.directory,'voices',f.voice.id),external=join(f.directory,'outside');
  const {mkdir}=await import('node:fs/promises');await mkdir(external);await writeFile(join(external,'reference.wav'),f.wav);
  assert.ok(resolve(folder).startsWith(resolve(f.directory)+sep));await rm(folder,{recursive:true});await symlink(external,folder,process.platform==='win32'?'junction':'dir');
  assert.equal((await fetch(f.url)).status,400);
});
