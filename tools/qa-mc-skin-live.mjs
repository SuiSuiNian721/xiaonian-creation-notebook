import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createWorkbench} from '../framework/server.mjs';

const directory=resolve(process.env.AI_FUTURE_SKIN_LIVE_QA_DIR||'qa/mc-skin-live');await mkdir(directory,{recursive:true});
const source=resolve(process.argv[2]||'qa/mc-skin-source-03/seed/skin.png');
const runtime=await createWorkbench({dataDir:join(directory,'data')});
const api=async(path,value,method=value===undefined?'GET':'POST')=>{const response=await fetch(runtime.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败 '+response.status);return result;};
try{
  await api('/api/ai/config',{provider:'codex',enabled:true},'PUT');await api('/api/modules/mc-skin/enable',{});
  const bytes=await readFile(source);const originalHash=createHash('sha256').update(bytes).digest('hex');
  const upload=await api('/api/modules/mc-skin/uploads',{fileName:'隔离像素验收.png',kind:'skin',model:'classic',base64:bytes.toString('base64')});
  const job=await api('/api/modules/mc-skin/jobs',{requestId:randomUUID(),name:'真实AI单像素验收',instruction:'只把 body.front 基础层的局部坐标 [0,0] 一格改成 RGBA [44,165,142,255]。其余4095个像素保持原样，外层全部KEEP，不改变眼睛。只返回该面的12行8列方案，除目标格外均使用句点 KEEP。',model:'classic',eyeTemplate:null,referenceIds:[],sourceId:upload.id});
  console.log('已提交隔离真实 Codex 皮肤请求：'+job.id);let last='';let finished;
  const deadline=Date.now()+360000;
  while(Date.now()<deadline){const value=await api('/api/modules/mc-skin/jobs/'+job.id);if(value.status!==last){last=value.status;console.log('真实皮肤验收状态：'+last);}if(!['queued','designing','rendering'].includes(value.status)){finished=value;break;}await new Promise(done=>setTimeout(done,1000));}
  assert.equal(finished?.status,'completed',finished?.error||'真实请求未在时限内完成');
  const manifest=await fetch(runtime.url+finished.files['manifest.json']).then(response=>response.json());assert.equal(manifest.changed_pixels.length,1);assert.deepEqual(manifest.changed_pixels[0],[20,20]);
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),originalHash);
  const png=Buffer.from(await fetch(runtime.url+finished.files['skin.png']).then(response=>response.arrayBuffer()));await writeFile(join(directory,'skin.png'),png,{flag:'wx'});
  await writeFile(join(directory,'result.json'),JSON.stringify({ok:true,realAI:true,provider:'codex',skill:'minecraft-pixel-skin',jobId:job.id,changedPixels:manifest.changed_pixels,sourceUnchanged:true,pngReadback:manifest.png_readback_verified,validation:finished.validation,usage:finished.usage||null,gameRuntimeVerified:false},null,2),'utf8');
  console.log('真实 Codex + skill + Python 制作链通过，精确修改一格。');
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({ok:false,realAI:true,error:error.stack},null,2),'utf8');console.error(error.message);process.exitCode=1;}
finally{await runtime.close();}
