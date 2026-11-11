import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../framework/server.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=','base64');
const info={
  EmptyImage:{input:{required:{width:['INT',{min:1,max:1024}],height:['INT',{min:1,max:1024}]}}},
  SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING']}},output_node:true},
};
const graph={'1':{class_type:'EmptyImage',inputs:{width:64,height:64}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'test'}}};
async function fixture(t, options = {}){
  const directory=await mkdtemp(join(tmpdir(),'workbench-drawing-')); const received=[]; const histories={}; const pending=[]; const running=[];const flags={dropSubmission:false};
  const schema={...structuredClone(info),LoadImage:{input:{required:{image:[['old.png']]}}},...options.schema};
  const upstream=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);let body;try{body=JSON.parse(raw.toString()||'{}');}catch{body={};}received.push({path:req.url,method:req.method,body});res.setHeader('content-type','application/json');
    if(req.url==='/system_stats')res.end(JSON.stringify({system:{comfyui_version:options.version || 'test'},devices:[]}));
    else if(req.url==='/object_info')res.end(JSON.stringify(schema));
    else if(req.url==='/upload/image'){schema.LoadImage.input.required.image[0].push('uploaded.png');res.end(JSON.stringify({name:'uploaded.png',subfolder:'',type:'input'}));}
    else if(req.url==='/prompt'){pending.push([0,body.prompt_id]);if(flags.dropSubmission){req.socket.destroy();return;}res.end(JSON.stringify({prompt_id:body.prompt_id,number:0}));}
    else if(req.url==='/queue'&&req.method==='GET')res.end(JSON.stringify({queue_pending:pending,queue_running:running}));
    else if(req.url==='/queue'){for(const id of body.delete||[]){const index=pending.findIndex(item=>item[1]===id);if(index>=0)pending.splice(index,1);}res.end('{}');}
    else if(req.url==='/interrupt')res.end('{}');
    else if(/^\/api\/jobs\/[^/]+\/cancel$/.test(req.url)){
      if(flags.noScopedCancel){res.statusCode=404;res.end('{}');return;}
      const id=req.url.split('/')[3];const index=pending.findIndex(item=>item[1]===id);
      if(index>=0)pending.splice(index,1);
      if(flags.runBeforeCancel&&!running.some(item=>item[1]===id))running.push([0,id]);
      res.end(JSON.stringify({cancelled:index>=0||running.some(item=>item[1]===id)}));
    }
    else if(req.url.startsWith('/history/'))res.end(JSON.stringify(histories));
    else if(req.url.startsWith('/view?')){res.setHeader('content-type','image/png');res.end(png);}
    else{res.statusCode=404;res.end('{}');}
  });
  await new Promise(resolveListen=>upstream.listen(0,'127.0.0.1',resolveListen));const serviceUrl=`http://127.0.0.1:${upstream.address().port}`;
  let app=await createWorkbench({dataDir:join(directory,'data'),drawingOptions:{installationDirectory:directory,downloadsDirectory:join(directory,'downloads'),WebSocketImpl:options.WebSocketImpl || null},aiOptions:options.aiOptions});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return {status:response.status,...await response.json()};};
  t.after(async()=>{await app.close();upstream.closeAllConnections();await new Promise(resolveClose=>upstream.close(resolveClose));assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {api,directory,received,histories,pending,running,flags,async restart(){await app.close();app=await createWorkbench({dataDir:join(directory,'data'),drawingOptions:{WebSocketImpl:null}});},async setup(){await api('/api/modules/drawing/enable',{});await api('/api/modules/drawing/config',{values:{serviceUrl,outputPath:join(directory,'output')}},'PUT');await api('/api/modules/drawing/connect',{});return api('/api/modules/drawing/workflows/import',{name:'测试工作流',document:graph});},base:()=>app.url};
}
const path='/api/modules/drawing';

test('重新扫描发现下载目录的新导出，只收录 ComfyUI JSON，导入读取最新文件且不生成',async t=>{
  const f=await fixture(t);await f.setup();
  const workflows=join(f.directory,'workflows'),downloads=join(f.directory,'downloads');
  await mkdir(workflows);await mkdir(downloads);
  await writeFile(join(workflows,'已有工作流.json'),JSON.stringify(graph));
  await writeFile(join(downloads,'无关设置.json'),JSON.stringify({theme:'dark'}));
  await writeFile(join(downloads,'无效节点.json'),JSON.stringify({nodes:[{name:'not a workflow'}]}));
  await writeFile(join(downloads,'损坏.json'),'{');
  await f.api(path+'/config',{values:{workflowPath:workflows}},'PUT');
  const first=await f.api(path+'/workflows/scan',{});assert.deepEqual(first.files.map(file=>file.name),['已有工作流.json']);
  const exported=join(downloads,'小璃_MOSS_.json');await writeFile(exported,JSON.stringify(graph));
  const second=await f.api(path+'/workflows/scan',{}),found=second.files.find(file=>file.name==='小璃_MOSS_.json');
  assert.ok(found,'再次扫描必须找到刚导出到下载目录的工作流');
  assert.equal(found.directory,downloads);assert.equal(second.files.length,2);
  assert.ok(second.directories.includes(downloads));
  const updated=structuredClone(graph);updated['2'].inputs.filename_prefix='updated';await writeFile(exported,JSON.stringify(updated));
  const imported=await f.api(path+'/workflows/open',{key:found.key});assert.deepEqual(imported.prompt,updated);
  assert.equal(f.received.some(call=>call.path==='/prompt'),false);
});

test('移除已结束作品记录可持久化与撤销，保留图片和任务幂等标识，禁止移除活动任务',async t=>{
  const f=await fixture(t),workflow=await f.setup();
  const request={workflowId:workflow.id,requestId:randomUUID(),values:{}};
  const job=await f.api(path+'/jobs',request);
  assert.equal((await f.api(path+`/jobs/${job.id}/hide`,{})).status,409);
  assert.equal((await f.api(path+'/state')).jobs.length,1);
  f.histories[job.promptId]={status:{completed:true,status_str:'success'},outputs:{'2':{images:[{filename:'kept.png',type:'output'}]}}};
  const complete=await f.api(path+`/jobs/${job.id}/refresh`,{});
  assert.equal(complete.status,'completed');const image=complete.images[0];
  const hidden=await f.api(path+`/jobs/${job.id}/hide`,{});assert.equal(hidden.status,200);assert.equal(hidden.hidden,true);
  assert.equal((await f.api(path+'/state')).jobs.length,0);
  assert.deepEqual(await readFile(image.archived),png);
  assert.deepEqual(Buffer.from(await (await fetch(f.base()+image.url)).arrayBuffer()),png);
  assert.equal((await f.api(path+'/jobs',request)).id,job.id,'移除列表记录不允许同一请求重复生成');
  await f.restart();assert.equal((await f.api(path+'/state')).jobs.length,0,'重启后仍不显示已移除记录');
  assert.equal((await f.api(path+`/jobs/${job.id}/restore`,{})).hidden,false);
  assert.equal((await f.api(path+'/state')).jobs[0].id,job.id);
  assert.deepEqual(await readFile(image.archived),png);
  assert.equal((await f.api(path+`/jobs/${randomUUID()}/hide`,{})).status,404);
  await f.api(path+`/jobs/${job.id}/hide`,{});
  const migrated=await f.api('/api/instances/migrate-legacy',{}),instance=migrated.instances.find(item=>item.moduleId==='drawing');
  await f.api(`/api/instances/${instance.id}/start`,{});
  const scope='/instances/'+instance.id+path;
  assert.equal((await f.api(scope+'/state')).jobs.length,0,'迁移实例时保留已移除状态');
  await f.api(scope+`/jobs/${job.id}/restore`,{});assert.equal((await f.api(scope+'/state')).jobs[0].id,job.id);
  const other=await f.api('/api/instances',{moduleId:'drawing'});
  assert.equal((await f.api('/instances/'+other.instance.id+path+`/jobs/${job.id}/hide`,{})).status,404,'不能移除其他实例的记录');
});

test('从零编写工作流传入底模 LoRA 和实际节点，候选采用前不执行',async t=>{
  const calls=[];
  const f=await fixture(t,{aiOptions:{fetchImpl:async(_url,request)=>{calls.push(JSON.parse(request.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({explanation:'已编写',workflow:graph})}}]}));}}});
  const original=await f.setup();
  await f.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:1234/v1',model:'fixture'},'PUT');
  const result=await f.api(path+'/assistant',{workflowId:null,baseModel:'指定底模.safetensors',loras:'人物.safetensors:0.8',instruction:'二次元角色绘图'});
  assert.equal(result.status,200);assert.deepEqual(result.workflow,graph);
  const context=JSON.parse(calls[0].messages.at(-1).content);
  assert.equal(context.currentWorkflow,null);assert.equal(context.baseModel,'指定底模.safetensors');assert.equal(context.loras,'人物.safetensors:0.8');assert.deepEqual(context.nodes.EmptyImage,info.EmptyImage);
  assert.equal((await f.api(path+'/workflows')).workflows.length,1);assert.equal(f.received.some(call=>call.path==='/prompt'),false);
  assert.equal((await f.api(path+'/workflows/inspect',{document:result.workflow})).valid,true);
  const adopted=await f.api(path+'/workflows/import',{name:'从零生成',document:result.workflow});assert.equal(adopted.status,200);
  const saved=await f.api(path+'/workflows/'+adopted.id);assert.ok(saved.fields.some(field=>field.input==='width'));assert.ok(saved.fields.some(field=>field.input==='height'));
  await f.api(path+'/assistant',{workflowId:original.id,instruction:'调整尺寸'});assert.deepEqual(JSON.parse(calls[1].messages.at(-1).content).currentWorkflow,graph);
  assert.equal((await f.api(path+'/assistant',{instruction:'改图',baseModel:123})).status,400);
});

test('输入图片预览仅访问当前服务列出的图片，保留子目录且拒绝任意路径',async t=>{
  const f=await fixture(t,{schema:{LoadImage:{input:{required:{image:[['old.png','folder/photo.png','../private.png']]}}}}});await f.setup();
  const preview=await f.api(path+'/input-preview',{image:'folder/photo.png'});
  assert.equal(preview.status,200);assert.equal(preview.src,'data:image/png;base64,'+png.toString('base64'));
  const request=f.received.find(call=>call.path.startsWith('/view?'));const url=new URL(request.path,'http://localhost');
  assert.equal(url.searchParams.get('filename'),'photo.png');assert.equal(url.searchParams.get('subfolder'),'folder');assert.equal(url.searchParams.get('type'),'input');
  for(const image of ['missing.png','../private.png','C:\\private.png','https://example.com/a.png'])assert.equal((await f.api(path+'/input-preview',{image})).status,400);
  assert.equal(f.received.filter(call=>call.path.startsWith('/view?')).length,1);
});

test('显式图片调整仍可转为图生图，参数面板不将转换能力当成原有图片输入',async t=>{
  const schema={Model:{output:['MODEL'],input:{required:{}}},VAE:{output:['VAE'],input:{required:{}}},Condition:{output:['CONDITIONING'],input:{required:{text:['STRING']}}},
    EmptyLatentImage:{output:['LATENT'],input:{required:{width:['INT'],height:['INT'],batch_size:['INT']}}},
    KSampler:{output:['LATENT'],input:{required:{model:['MODEL'],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT'],seed:['INT'],denoise:['FLOAT',{min:0,max:1}]}}},
    VAEDecode:{output:['IMAGE'],input:{required:{samples:['LATENT'],vae:['VAE']}}},LoadImage:{output:['IMAGE','MASK'],input:{required:{image:[['old.png']]}}},
    VAEEncodeTiled:{output:['LATENT'],input:{required:{pixels:['IMAGE'],vae:['VAE'],tile_size:['INT',{default:512}],overlap:['INT',{default:64}]}}},
    ImageScale:{output:['IMAGE'],input:{required:{image:['IMAGE'],width:['INT'],height:['INT'],upscale_method:[['lanczos']],crop:[['center']]}}},
    ImageScaleToTotalPixels:{output:['IMAGE'],input:{required:{image:['IMAGE'],upscale_method:[['lanczos']],megapixels:['FLOAT'],resolution_steps:['INT',{default:1}]}}},
  };
  const f=await fixture(t,{schema});await f.setup();
  const document={m:{class_type:'Model',inputs:{}},v:{class_type:'VAE',inputs:{}},text:{class_type:'Condition',inputs:{text:'a cup'}},size:{class_type:'EmptyLatentImage',inputs:{width:64,height:64,batch_size:1}},sample:{class_type:'KSampler',inputs:{model:['m',0],positive:['text',0],negative:['text',0],latent_image:['size',0],seed:42,denoise:1}},decode:{class_type:'VAEDecode',inputs:{samples:['sample',0],vae:['v',0]}},save:{class_type:'SaveImage',inputs:{images:['decode',0],filename_prefix:'test'}}};
  const workflow=await f.api(path+'/workflows/import',{name:'原图重绘',document});assert.equal(workflow.controls.reference.available,false);assert.equal(workflow.controls.reference.maxImages,0);
  const upload=await f.api(path+'/uploads',{name:'photo.png',data:png.toString('base64')});assert.equal(upload.image,'uploaded.png');
  const request={requestId:randomUUID(),workflowId:workflow.id,adjustments:{images:[upload.image],imageDenoise:0.4,referenceSize:'workflow'},previewMethod:'none'};
  const job=await f.api(path+'/jobs',request);assert.equal(job.status,'queued');
  const prompt=f.received.find(call=>call.path==='/prompt').body.prompt;
  assert.equal(Object.values(prompt).find(node=>node.class_type==='LoadImage').inputs.image,upload.image);assert.equal(prompt.sample.inputs.denoise,0.4);
  assert.equal((await f.api(path+'/jobs',request)).id,job.id);assert.equal((await f.api(path+'/jobs',{...request,adjustments:{...request.adjustments,imageDenoise:0.9}})).status,409);
  assert.deepEqual((await f.api(path+'/workflows/'+workflow.id)).prompt,document);
  await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:workflow.id,adjustments:{images:[]},previewMethod:'none'});
  assert.deepEqual(f.received.filter(call=>call.path==='/prompt')[1].body.prompt,document);
});

test('任务保存本次实际种子，重试与离线重启后仍可查看而不暴露整个提示词',async t=>{
  const schema={
    TextGenerateQwen35MTP:{output:['STRING'],input:{required:{prompt:['STRING'],seed:['INT',{min:0,max:1000000}]}}},
    KSampler:{output:['IMAGE'],input:{required:{seed:['INT',{min:0,max:1000000}],caption:['STRING']}}},
  };
  const f=await fixture(t,{schema});await f.setup();
  const document={rewrite:{class_type:'TextGenerateQwen35MTP',inputs:{prompt:'a cup',seed:42}},sample:{class_type:'KSampler',inputs:{seed:123,caption:['rewrite',0]}},save:{class_type:'SaveImage',inputs:{images:['sample',0],filename_prefix:'test'}}};
  const workflow=await f.api(path+'/workflows/import',{name:'种子记录',document});
  const request={requestId:randomUUID(),workflowId:workflow.id,values:{'sample:seed':98765},previewMethod:'none'};
  const job=await f.api(path+'/jobs',request);
  assert.equal(job.status,'queued');
  assert.deepEqual(job.seeds?.map(({key,value})=>({key,value})),[{key:'rewrite:seed',value:42},{key:'sample:seed',value:98765}]);
  assert.equal(job.prompt,undefined);
  assert.deepEqual((await f.api(path+'/jobs',request)).seeds,job.seeds);
  await f.restart();
  const saved=(await f.api(path+'/state')).jobs.find(item=>item.id===job.id);
  assert.deepEqual(saved.seeds,job.seeds);
  assert.equal(f.received.filter(call=>call.path==='/prompt').length,1);
});

test('关闭提示词改写后，本次种子仅展示生效的采样种子',async t=>{
  const schema={
    PrimitiveStringMultiline:{output:['STRING'],input:{required:{value:['STRING']}}},
    TextGenerateQwen35MTP:{output:['STRING'],input:{required:{prompt:['STRING'],seed:['INT']}}},
    ComfySwitchNode:{output:['STRING'],input:{required:{switch:['BOOLEAN'],on_false:['STRING'],on_true:['STRING']}}},
    CLIPTextEncode:{output:['CONDITIONING'],input:{required:{text:['STRING']}}},
    KSampler:{output:['IMAGE'],input:{required:{seed:['INT'],positive:['CONDITIONING']}}},
  };
  const f=await fixture(t,{schema});await f.setup();
  const document={source:{class_type:'PrimitiveStringMultiline',inputs:{value:'a cup'}},rewrite:{class_type:'TextGenerateQwen35MTP',inputs:{prompt:['source',0],seed:42}},toggle:{class_type:'ComfySwitchNode',inputs:{switch:true,on_false:['source',0],on_true:['rewrite',0]}},encode:{class_type:'CLIPTextEncode',inputs:{text:['toggle',0]}},sample:{class_type:'KSampler',inputs:{seed:123,positive:['encode',0]}},save:{class_type:'SaveImage',inputs:{images:['sample',0],filename_prefix:'test'}}};
  const workflow=await f.api(path+'/workflows/import',{name:'关闭改写',document});
  const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:workflow.id,values:{'toggle:switch':false},previewMethod:'none'});
  assert.equal(job.status,'queued');
  assert.deepEqual(job.seeds?.map(({key,value})=>({key,value})),[{key:'sample:seed',value:123}]);
  assert.equal(f.received.find(call=>call.path==='/prompt').body.prompt.rewrite.inputs.seed,42,'停用的分支保留原始值');
});

test('额外 LoRA 的名称和权重实际进入任务且参与幂等核对，原始工作流不变',async t=>{
  const schema={
    Model:{output:['MODEL'],input:{required:{}}},Clip:{output:['CLIP'],input:{required:{}}},
    Render:{output:['IMAGE'],input:{required:{model:['MODEL'],clip:['CLIP']}}},
    LoraLoader:{output:['MODEL','CLIP'],input:{required:{model:['MODEL'],clip:['CLIP'],lora_name:[['sample.safetensors']],strength_model:['FLOAT',{min:-10,max:10}],strength_clip:['FLOAT',{min:-10,max:10}]}}},
  };
  const f=await fixture(t,{schema});await f.setup();
  const document={m:{class_type:'Model',inputs:{}},c:{class_type:'Clip',inputs:{}},render:{class_type:'Render',inputs:{model:['m',0],clip:['c',0]}},save:{class_type:'SaveImage',inputs:{images:['render',0],filename_prefix:'test'}}};
  const workflow=await f.api(path+'/workflows/import',{name:'LoRA测试',document});
  assert.equal(workflow.controls?.lora.available,true);
  const adjustments={loras:[{name:'sample.safetensors',modelWeight:0.7,clipWeight:0.5}]};
  const payload={requestId:randomUUID(),workflowId:workflow.id,values:{},adjustments,previewMethod:'none'};
  const first=await f.api(path+'/jobs',payload);assert.equal(first.status,'queued');
  const sent=f.received.find(item=>item.path==='/prompt').body.prompt;
  const [id,loader]=Object.entries(sent).find(([,node])=>node.class_type==='LoraLoader');
  assert.equal(loader.inputs.strength_model,0.7);assert.deepEqual(sent.render.inputs.model,[id,0]);
  assert.equal((await f.api(path+'/jobs',payload)).id,first.id);
  assert.equal((await f.api(path+'/jobs',{...payload,adjustments:{loras:[{...adjustments.loras[0],modelWeight:0.8}]}})).status,409);
  assert.equal(f.received.filter(item=>item.path==='/prompt').length,1);
  assert.deepEqual((await f.api(path+'/workflows/'+workflow.id)).prompt,document);
});

test('响应丢失后仅完整原参数可复用请求，修改参数或预览方式必须用新编号',async t=>{
  const f=await fixture(t),w=await f.setup();f.flags.dropSubmission=true;
  const payload={requestId:randomUUID(),workflowId:w.id,values:{'1:width':128,'1:height':64},previewMethod:'none'};
  const first=await f.api(path+'/jobs',payload);assert.equal(first.status,'unknown');
  assert.equal((await f.api(path+'/jobs',{...payload,values:{'1:height':64,'1:width':128}})).id,first.id);
  assert.equal((await f.api(path+'/jobs',{...payload,values:{...payload.values,'1:width':256}})).status,409);
  assert.equal((await f.api(path+'/jobs',{...payload,previewMethod:'auto'})).status,409);
  assert.equal(f.received.filter(call=>call.path==='/prompt').length,1);
});

async function comfyFixture(directory){
  await mkdir(join(directory,'comfy'),{recursive:true});
  for(const file of ['main.py','server.py','nodes.py'])await writeFile(join(directory,file),'# ComfyUI fixture\n');
}
test('检测独立 ComfyUI 本体，不依赖启动器，保留已有服务与资料配置且不外联',async t=>{
  const f=await fixture(t);const core=join(f.directory,'standalone');await comfyFixture(core);
  await f.api(path+'/enable',{});const config={comfyPath:core,serviceUrl:'http://127.0.0.1:9000',workflowPath:join(f.directory,'workflows'),outputPath:join(f.directory,'output')};
  await f.api(path+'/config',{values:config},'PUT');
  const result=await f.api(path+'/discover',{});assert.equal(result.status,200);for(const [key,value]of Object.entries(config))assert.equal(result[key],value);
  assert.equal(f.received.length,0);
});

test('按任务请求预览，实际 socket 帧通过同源图片端点展示且完成后清理',async t=>{
  const sockets=[];
  class Socket extends EventTarget {
    constructor(url){super();this.url=url;this.readyState=1;sockets.push(this);}
    sendMessage(data){this.dispatchEvent(new MessageEvent('message',{data}));}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const f=await fixture(t,{WebSocketImpl:Socket,version:'0.42.0'}),w=await f.setup();
  const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},previewMethod:'auto'});
  assert.equal(job.status,'queued'); assert.equal(f.received.find(r=>r.path==='/prompt').body.extra_data.preview_method,'auto');
  sockets[0].sendMessage('null');sockets[0].sendMessage('[]');
  sockets[0].sendMessage(JSON.stringify({type:'executing',data:{prompt_id:job.promptId,node:'1'}}));
  const header=Buffer.alloc(8);header.writeUInt32BE(1);header.writeUInt32BE(2,4);sockets[0].sendMessage(Buffer.concat([header,png]));
  const state=await f.api(path+'/state');assert.ok(state.jobs[0].preview?.url);
  const image=await fetch(f.base()+state.jobs[0].preview.url);assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
  assert.equal((await fetch(f.base()+path+'/jobs/'+randomUUID()+'/preview')).status,404);
  assert.equal((await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},previewMethod:'invalid'})).status,400);
  f.histories[job.promptId]={status:{status_str:'success',completed:true},outputs:{'2':{images:[{filename:'final.png',type:'output'}]}}};
  const completed=await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal(completed.status,'completed');assert.equal(completed.preview,undefined);assert.equal(completed.images.length,1);
  assert.equal((await fetch(f.base()+state.jobs[0].preview.url)).status,404);
  sockets[0].close();await f.api(path+'/connect',{});assert.equal(sockets.length,2);
});

test('关闭预览仍可提交，旧服务明确提示任务级预览未核实',async t=>{
  const f=await fixture(t),w=await f.setup();
  const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},previewMethod:'none'});
  assert.equal(job.status,'queued');assert.equal(job.previewMethod,'none');assert.match(job.previewNotice,/启动|版本|核实/);
  assert.equal(f.received.find(r=>r.path==='/prompt').body.extra_data.preview_method,undefined);
});

test('清晰预览扫描期间重复提交只创建一个任务，本地缺解码器仍由服务检查外部模型并回退',async t=>{
  const f=await fixture(t,{version:'0.42.0'}),w=await f.setup();
  const core=join(f.directory,'comfy-local');await comfyFixture(core);
  await f.api(path+'/config',{values:{comfyPath:core}},'PUT');await f.api(path+'/connect',{});
  const request={requestId:randomUUID(),workflowId:w.id,values:{},previewMethod:'taesd'};
  const [one,two]=await Promise.all([f.api(path+'/jobs',request),f.api(path+'/jobs',request)]);
  assert.equal(one.id,two.id);assert.equal(f.received.filter(r=>r.path==='/prompt').length,1);
  assert.equal(one.previewMethod,'taesd');assert.match(one.previewNotice,/本地.*外部.*回退/);
  assert.equal(f.received.find(r=>r.path==='/prompt').body.extra_data.preview_method,'taesd');
});
test('检测接受便携包根目录并定位到 ComfyUI，普通 main.py 或单独启动器不被当成本体',async t=>{
  const f=await fixture(t);await f.api(path+'/enable',{});const bundle=join(f.directory,'portable'),core=join(bundle,'ComfyUI');await comfyFixture(core);
  const result=await f.api(path+'/discover',{comfyPath:bundle});assert.equal(result.status,200);assert.equal(result.comfyPath,core);assert.equal(result.outputPath,join(core,'output'));
  const fake=join(f.directory,'not-comfy');await mkdir(fake);await writeFile(join(fake,'main.py'),'# unrelated');await writeFile(join(fake,'绘世启动器.exe'),'fixture');
  assert.equal((await f.api(path+'/discover',{comfyPath:fake})).status,400);
});
test('添加与配置不会外联；显式连接才读取节点，API 工作流可导入与导出',async t=>{const f=await fixture(t);assert.equal((await f.api(path+'/state')).status,409);assert.equal(f.received.length,0);const workflow=await f.setup();assert.equal(workflow.status,200);assert.equal(workflow.fields.length,3);assert.deepEqual((await f.api(path+`/workflows/${workflow.id}/export`))['1'],graph['1']);assert.equal(f.received.filter(r=>r.path==='/prompt').length,0);});
test('同一请求不重复提交，节点参数校验在入队前生效，任务持久化并关联提交时角色',async t=>{const f=await fixture(t);const w=await f.setup();const c=await f.api('/api/characters',{name:'甲'});const request={requestId:randomUUID(),workflowId:w.id,values:{'1:width':128},characterId:c.character.id};const first=await f.api(path+'/jobs',request);const again=await f.api(path+'/jobs',request);assert.equal(first.id,again.id);assert.equal(f.received.filter(r=>r.path==='/prompt').length,1);assert.equal(f.received.find(r=>r.path==='/prompt').body.prompt['1'].inputs.width,128);assert.equal((await f.api(path+'/jobs',{...request,requestId:randomUUID(),values:{'1:width':0}})).status,400);await f.restart();assert.equal(f.received.filter(r=>r.path==='/prompt').length,1);assert.equal((await f.api(path+'/state')).jobs[0].characterId,c.character.id);});
test('完成任务真实下载并保存图片，切换角色不改变归属，结果离线仍可读取',async t=>{const f=await fixture(t);const w=await f.setup();const a=(await f.api('/api/characters',{name:'甲'})).character;const b=(await f.api('/api/characters',{name:'乙'})).character;const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},characterId:a.id});await f.api('/api/characters/select',{id:b.id});f.histories[job.promptId]={status:{status_str:'success',completed:true},outputs:{'2':{images:[{filename:'result.png',subfolder:'',type:'output'}]}}};const completed=await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal(completed.status,'completed');assert.equal(completed.images.length,1);assert.deepEqual(await readFile(completed.images[0].archived),png);const response=await fetch(f.base()+completed.images[0].url);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);const state=await f.api('/api/state');assert.equal(state.characters.find(c=>c.id===a.id).assets.length,1);assert.equal(state.characters.find(c=>c.id===b.id).assets.length,0);await f.restart();assert.equal((await fetch(f.base()+completed.images[0].url)).status,200);});
test('使用按任务取消接口，运行中的取消须等待实际终态，不清空其他任务',async t=>{
  const f=await fixture(t);const w=await f.setup();const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},characterId:null});f.pending.push([1,'other-task']);
  const cancelled=await f.api(path+`/jobs/${job.id}/cancel`,{});assert.equal(cancelled.status,'cancelled');assert.ok(f.pending.some(item=>item[1]==='other-task'));
  assert.ok(f.received.some(r=>r.path===`/api/jobs/${job.promptId}/cancel`));assert.equal(f.received.some(r=>r.path==='/interrupt'||r.path==='/queue'&&r.method==='POST'),false);
  const next=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},characterId:null});f.flags.runBeforeCancel=true;
  const requested=await f.api(path+`/jobs/${next.id}/cancel`,{});assert.equal(requested.status,'running');assert.ok(requested.cancelRequestedAt);
  f.histories[next.promptId]={status:{status_str:'error',completed:false,messages:[['execution_interrupted',{}]]},outputs:{}};
  assert.equal((await f.api(path+`/jobs/${next.id}/refresh`,{})).status,'cancelled');
});
test('缺节点与损坏图片拒绝，图片访问不能指定任意文件',async t=>{const f=await fixture(t);await f.setup();assert.equal((await f.api(path+'/workflows/import',{name:'坏图',document:{'1':{class_type:'Missing',inputs:{}}}})).status,400);assert.equal((await f.api(path+'/uploads',{name:'bad.png',data:Buffer.from('<svg/>').toString('base64')})).status,400);assert.equal((await fetch(f.base()+path+'/images/not-a-file')).status,404);});

test('提交已被接收但响应断线时保持待核实，重复请求不再入队，后续能按标识恢复',async t=>{const f=await fixture(t);const w=await f.setup();f.flags.dropSubmission=true;const request={requestId:randomUUID(),workflowId:w.id,values:{},characterId:null};const job=await f.api(path+'/jobs',request);assert.equal(job.status,'unknown');await f.api(path+'/jobs',request);assert.equal(f.received.filter(r=>r.path==='/prompt').length,1);const checked=await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal(checked.status,'queued');});

test('服务执行结束但没有图片时如实报错，不显示绘图成功',async t=>{const f=await fixture(t);const w=await f.setup();const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{},characterId:null});f.histories[job.promptId]={status:{status_str:'success',completed:true},outputs:{}};const result=await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal(result.status,'failed');assert.match(result.error,/没有返回图片/);});

test('上传后刷新实际图片枚举，新参考图能提交，重连后仍可选择',async t=>{
  const f=await fixture(t);await f.setup();const imageGraph={'1':{class_type:'LoadImage',inputs:{image:'old.png'}},'2':graph['2']};
  const w=await f.api(path+'/workflows/import',{name:'参考图',document:imageGraph});
  const uploaded=await f.api(path+'/uploads',{name:'新参考.png',data:png.toString('base64')});assert.equal(uploaded.status,200);
  const refreshed=await f.api(path+`/workflows/${w.id}`);assert.ok(refreshed.fields.find(field=>field.image).choices.includes(uploaded.image));
  const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{'1:image':uploaded.image}});assert.equal(job.status,'queued');
  assert.equal(f.received.find(r=>r.path==='/prompt').body.prompt['1'].inputs.image,uploaded.image);
  await f.restart();await f.api(path+'/connect',{});assert.ok((await f.api(path+`/workflows/${w.id}`)).fields.find(field=>field.image).choices.includes(uploaded.image));
});

test('取消与执行完成重叠时继续确认历史并归档，不提前丢弃结果',async t=>{
  const f=await fixture(t);const w=await f.setup();const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{}});f.flags.runBeforeCancel=true;
  assert.equal((await f.api(path+`/jobs/${job.id}/cancel`,{})).status,'running');
  f.histories[job.promptId]={status:{status_str:'success',completed:true},outputs:{'2':{images:[{filename:'result.png',type:'output'}]}}};
  const completed=await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal(completed.status,'completed');assert.equal(completed.images.length,1);
});

test('旧服务没有按任务取消能力时明确报错并保留查询，不回退全局中断',async t=>{
  const f=await fixture(t);const w=await f.setup();const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{}});f.flags.noScopedCancel=true;
  const result=await f.api(path+`/jobs/${job.id}/cancel`,{});assert.equal(result.status,409);
  assert.equal(f.received.some(r=>r.path==='/interrupt'||r.path==='/queue'&&r.method==='POST'),false);
  assert.equal((await f.api(path+`/jobs/${job.id}/refresh`,{})).status,'queued');
});

test('额外作品目录不可写时保留唯一私有结果，完成任务并提示导出，不反复生成孤儿文件',async t=>{
  const f=await fixture(t);const w=await f.setup();const blocked=join(f.directory,'not-a-directory');
  assert.equal((await f.api(path+'/preferences',{outputPath:blocked})).status,200);await writeFile(blocked,'保留此原件');const job=await f.api(path+'/jobs',{requestId:randomUUID(),workflowId:w.id,values:{}});
  f.histories[job.promptId]={status:{status_str:'success',completed:true},outputs:{'2':{images:[{filename:'result.png',type:'output'}]}}};
  const result=await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal(result.status,'completed');assert.equal(result.images.length,1);assert.match(result.warning,/作品目录/);
  assert.deepEqual(Buffer.from(await (await fetch(f.base()+result.images[0].url)).arrayBuffer()),png);
  await f.api(path+`/jobs/${job.id}/refresh`,{});assert.equal((await readdir(join(f.directory,'data/drawing/images'))).length,1);assert.equal(await readFile(blocked,'utf8'),'保留此原件');
});
