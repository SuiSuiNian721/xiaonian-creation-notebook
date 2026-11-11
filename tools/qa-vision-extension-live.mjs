// Explicit opt-in: downloads the fixed model package into an isolated QA profile.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkbench} from '../framework/server.mjs';

if(!process.argv.includes('--install'))throw new Error('真实安装验证需要显式传入 --install。');
const imageIndex=process.argv.indexOf('--image'),imagePath=imageIndex>=0?process.argv[imageIndex+1]:null;
if(!imagePath)throw new Error('请用 --image 提供一张包含“人设与记忆”标题的测试截图。');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'artifacts','vision-extension'),dataDir=join(output,'live-profile');
await mkdir(output,{recursive:true});
let app=await createWorkbench({dataDir});
const report={startedAt:new Date().toISOString(),dataDir,checks:[]};
const api=async(path,body)=>{
  const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
};
let progress;
try{
  await app.context.visionExtension.ready;
  const before=await api('/api/vision-extension');
  if(before.runtime.status!=='running')await api('/api/vision-extension/'+(before.installed?'start':'install'),{});
  progress=setInterval(()=>{
    const state=app.context.visionExtension.state();
    console.log(JSON.stringify({stage:state.task?.stage,completedBytes:state.task?.completedBytes,totalBytes:state.task?.totalBytes,runtime:state.runtime.status}));
  },5000);
  await app.context.visionExtension.waitForIdle();clearInterval(progress);
  const installed=await api('/api/vision-extension');
  assert.equal(installed.installed,true,JSON.stringify(installed));assert.equal(installed.runtime.status,'running',JSON.stringify(installed));
  report.package=installed.package;report.checks.push('fixed-package-installed-and-running');
  const connection=await api('/api/vision-extension/connection',{});
  const local=connection.media;
  const character=(await api('/api/characters',{name:'千问视觉实测'})).character;
  const tested=await api('/api/characters/'+character.id+'/life/vision/test',connection);
  assert.equal(tested.local.status,'available',JSON.stringify(tested));report.checks.push('character-vision-test:'+tested.local.evidence);
  const image=await readFile(resolve(imagePath));
  const start=Date.now();
  const response=await fetch(local.localVisionBaseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+local.localVisionKey},signal:AbortSignal.timeout(180000),body:JSON.stringify({model:local.localVisionModel,messages:[{role:'user',content:[{type:'text',text:'只抄写图片中白色设置窗口左上角的大标题，不要解释。'},{type:'image_url',image_url:{url:'data:image/png;base64,'+image.toString('base64')}}]}],max_tokens:128,temperature:0,chat_template_kwargs:{enable_thinking:false},stream:false})});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));
  report.imageReply=result.choices?.[0]?.message?.content||'';report.imageLatencyMs=Date.now()-start;
  assert.match(report.imageReply,/人设与记忆/);report.checks.push('real-screenshot-title-recognized');
  await api('/api/vision-extension/stop',{});assert.equal((await api('/api/vision-extension')).runtime.status,'stopped');report.checks.push('owned-service-stopped');
  await api('/api/vision-extension/start',{device:'auto'});await app.context.visionExtension.waitForIdle();
  assert.equal((await api('/api/vision-extension')).runtime.status,'running');
  await app.close();app=await createWorkbench({dataDir});await app.context.visionExtension.waitForIdle();
  const restored=await api('/api/vision-extension/connection',{});
  assert.deepEqual(restored,connection);report.checks.push('restart-restores-stable-port-and-credentials');
  report.ok=true;
}catch(error){report.ok=false;report.error=error.message;process.exitCode=1;}
finally{
  clearInterval(progress);await app.close();report.finishedAt=new Date().toISOString();
  await writeFile(join(output,'live-result.json'),JSON.stringify(report,null,2)+'\n',{encoding:'utf8'});
  console.log(JSON.stringify(report));
}
