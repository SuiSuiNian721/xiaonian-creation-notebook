import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkbench} from '../framework/server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=','base64');
const schema={EmptyImage:{input:{required:{width:['INT'],height:['INT']}},output:['IMAGE']},SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING']}},output_node:true}};
const graph={a:{class_type:'EmptyImage',inputs:{width:64,height:64}},b:{class_type:'SaveImage',inputs:{images:['a',0],filename_prefix:'test'}}};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'drawing-preferences-')),opened=[],histories={};let ready=true,launches=0;
  const options={dataDir:join(directory,'profile'),instances:false,openComfyUI:async url=>opened.push(url),startupOptions:{pollMs:5,timeoutMs:1000},drawingOptions:{installationDirectory:directory,WebSocketImpl:null,fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;
    if(!ready)throw new Error('offline');
    if(path==='/view')return new Response(png);
    return new Response(JSON.stringify(path==='/system_stats'?{system:{comfyui_version:'0.42.0'}}:path==='/object_info'?schema:path==='/queue'?{queue_running:[],queue_pending:[]}:path.startsWith('/history/')?histories:path==='/prompt'?{prompt_id:JSON.parse(options.body).prompt_id}:{}));
  }}};
  let app=await createWorkbench(options);
  const api=async(path,body)=>{const response=await fetch(app.url+'/api/modules/drawing/'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return {httpStatus:response.status,...await response.json()};};
  app.context.store.setEnabled('drawing',true);
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {api,directory,opened,histories,drawing:()=>app.context.drawing,launches:()=>launches,offline(){ready=false;app.context.drawing.connection=null;app.context.drawing.runtime.launch=async()=>{launches++;app.context.drawing.runtime.launchRecord={status:'running',pid:123,startedAt:'fixture'};setTimeout(()=>{ready=true;},35);return {starting:true};};},async restart(){await app.close();app=await createWorkbench(options);}};
}

test('默认安装目录、手填目录、重启恢复与恢复默认；保存设置不改变服务配置',async t=>{
  const f=await fixture(t),config=structuredClone(f.drawing().config());
  const initial=(await f.api('state')).preferences;assert.equal(initial.outputPath,join(f.directory,'角色绘图'));assert.equal(initial.openBrowser,false);
  const custom=join(f.directory,'我的作品');assert.equal((await f.api('preferences',{outputPath:custom,openBrowser:true})).outputPath,custom);
  await f.restart();assert.equal((await f.api('state')).preferences.outputPath,custom);assert.equal((await f.api('state')).preferences.openBrowser,true);
  await f.api('preferences',{openBrowser:false});assert.equal((await f.api('state')).preferences.outputPath,custom);
  await f.api('preferences',{outputPath:''});assert.equal((await f.api('state')).preferences.outputPath,initial.outputPath);assert.deepEqual(f.drawing().config(),config);
  const file=join(f.directory,'file');await writeFile(file,'original');
  for(const path of ['relative/path',file])assert.equal((await f.api('preferences',{outputPath:path})).httpStatus,400);
  assert.equal((await f.api('preferences',{openBrowser:'false'})).httpStatus,400);
});

test('真实归档字节进入默认和自定义目录，运行中的任务保留提交时路径',async t=>{
  const f=await fixture(t);await f.api('connect',{});const workflow=await f.api('workflows/import',{name:'保存位置',document:graph});
  const submit=()=>f.api('jobs',{requestId:randomUUID(),workflowId:workflow.id,values:{}});
  const first=await submit(),custom=join(f.directory,'指定目录');await f.api('preferences',{outputPath:custom});const second=await submit();
  for(const [job,root] of [[first,join(f.directory,'角色绘图')],[second,custom]]){
    f.histories[job.promptId]={status:{completed:true,status_str:'success'},outputs:{b:{images:[{filename:'result.png',type:'output'}]}}};
    const complete=await f.api('jobs/'+job.id+'/refresh',{});assert.equal(complete.status,'completed');assert.ok(complete.images[0].archived.startsWith(join(root,job.id)+sep));assert.deepEqual(await readFile(complete.images[0].archived),png);
  }
});

test('打开 ComfyUI 的纯后台与浏览器选项，已启动服务不会重复拉起',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api('open-service',{openBrowser:false})).connection.connected,true);assert.equal(f.opened.length,0);assert.equal(f.launches(),0);
  await f.api('open-service',{openBrowser:true});assert.equal(f.opened.length,1);assert.equal((await f.api('state')).preferences.openBrowser,true);
  f.offline();const result=await f.api('open-service',{openBrowser:false});assert.equal(result.starting,true);
  for(let i=0;i<100&&(await f.api('state')).startup.status==='waiting';i++)await delay(10);
  assert.equal((await f.api('state')).connection.connected,true);assert.equal((await f.api('state')).startup.status,'ready');assert.equal(f.opened.length,1);assert.equal(f.launches(),1);
  f.offline();await f.api('open-service',{openBrowser:true});
  for(let i=0;i<100&&(await f.api('state')).startup.status==='waiting';i++)await delay(10);
  assert.equal((await f.api('state')).startup.status,'opened');assert.equal(f.opened.length,2);assert.equal(f.launches(),2);
});
