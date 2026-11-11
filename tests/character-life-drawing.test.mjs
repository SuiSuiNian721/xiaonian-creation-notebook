import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../framework/character-life/drawing-tool.mjs').catch(() => ({}));
const requestId = 'reply-17-image-0';
const image = {id:'image-1',jobId:'job-1',mime:'image/png',url:'/api/modules/drawing/images/image-1'};
function fixture(statuses = ['running','completed']) {
  const records=new Map(),submitted=[],synced=[],cancelled=[];
  let current;
  const store={module:()=>({enabled:true}),getSetting:key=>records.get(key),setSetting:(key,value)=>records.set(key,value)};
  const drawing={
    async submit(value){submitted.push(value);current={id:'job-1',...value,status:'queued',images:[]};return current;},
    async syncJob(id){synced.push(id);const status=statuses.shift()??'running';current={...current,status,images:status==='completed'?[image]:[]};return current;},
    async cancel(id){cancelled.push(id);throw new Error('unexpected cancellation');},
  };
  assert.equal(typeof module.createDrawingTool,'function','内置绘图适配器应可创建');
  return {store,drawing,submitted,synced,cancelled,invoke:module.createDrawingTool({drawing,store,baseUrl:()=> 'http://127.0.0.1:19876',pollIntervalMs:1,timeoutMs:200})};
}

test('内置绘图等待任务真实完成并返回工作台归档图片',async()=>{
  const f=fixture();
  const result=await f.invoke({values:{'6:text':'温室里的风信子'}},{characterId:'character-1',workflowId:'workflow-1',requestId});
  assert.equal(f.submitted.length,1);assert.equal(f.synced.length,2);
  assert.deepEqual(f.submitted[0].values,{'6:text':'温室里的风信子'});
  assert.match(f.submitted[0].requestId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(result.url,'http://127.0.0.1:19876/api/modules/drawing/images/image-1');
  assert.equal(result.status,'completed');assert.equal(result.jobId,'job-1');assert.equal(result.images[0].url,result.url);
  assert.deepEqual(f.cancelled,[]);
});

test('相同调用保留稳定请求标识，改变参数必须使用新的调用标识',async()=>{
  const f=fixture(['completed','completed']);
  const context={characterId:'character-1',workflowId:'workflow-1',requestId};
  await f.invoke({values:{'6:text':'同一张图'}},context);
  await f.invoke({values:{'6:text':'同一张图'}},context);
  assert.equal(f.submitted[0].requestId,f.submitted[1].requestId);
  await assert.rejects(f.invoke({values:{'6:text':'另一张图'}},context),/参数已变化/);
  assert.equal(f.submitted.length,2);
});

test('媒体提示词写入配置的真实工作流字段，不猜测多个提示词入口',async()=>{
  const f=fixture(['completed']);f.drawing.workflow=()=>({fields:[{key:'6:text',input:'text',type:'text',group:'正向提示词'},{key:'7:text',input:'text',type:'text',group:'负向提示词'}]});
  await f.invoke({prompt:'一朵风信子'},{characterId:'character-1',workflowId:'workflow-1',promptField:'6:text',requestId});
  assert.equal(f.submitted[0].values['6:text'],'一朵风信子');assert.equal(f.submitted[0].values['7:text'],undefined);
  f.drawing.workflow=()=>({fields:[{key:'6:text',input:'text',type:'text'},{key:'8:text',input:'text',type:'text'}]});
  await assert.rejects(f.invoke({prompt:'温室'},{characterId:'character-1',workflowId:'workflow-1',requestId:'ambiguous'}),/提示词字段/);
});

test('未启用模块、缺少工作流和已经取消的调用均不提交绘图',async()=>{
  const f=fixture(),context={characterId:'character-1',requestId};
  f.store.module=()=>({enabled:false});await assert.rejects(f.invoke({workflowId:'workflow-1'},context),/启用.*绘图/);
  f.store.module=()=>({enabled:true});await assert.rejects(f.invoke({},context),/工作流/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.invoke({workflowId:'workflow-1'},{...context,signal:controller.signal}),/取消/);
  assert.equal(f.submitted.length,0);
});

test('失败、取消和未知结果不会被当作图片成功',async()=>{
  for(const status of ['failed','cancelled','unknown']){
    const f=fixture([status]);
    await assert.rejects(f.invoke({workflowId:'workflow-1'},{characterId:'character-1',requestId}),error=>error.jobId==='job-1'&&error.drawingStatus===status);
    assert.deepEqual(f.cancelled,[]);
  }
  const f=fixture();f.drawing.syncJob=async()=>({...f.submitted[0],id:'job-1',status:'completed',images:[]});
  await assert.rejects(f.invoke({workflowId:'workflow-1'},{characterId:'character-1',requestId}),/图片/);
});

test('等待超时或中途取消时立即返回任务标识，不取消后台任务',async()=>{
  const f=fixture();f.drawing.syncJob=()=>new Promise(()=>{});
  const controller=new AbortController();setTimeout(()=>controller.abort(),15);
  await assert.rejects(f.invoke({workflowId:'workflow-1'},{characterId:'character-1',requestId,signal:controller.signal}),error=>/取消/.test(error.message)&&error.jobId==='job-1');
  const short=module.createDrawingTool({...f,pollIntervalMs:1,timeoutMs:15,baseUrl:()=> 'http://127.0.0.1:19876'});
  await assert.rejects(short({workflowId:'workflow-1'},{characterId:'character-1',requestId:'timeout'}),error=>error.status===504&&error.jobId==='job-1'&&/仍可能/.test(error.message));
  assert.deepEqual(f.cancelled,[]);
});

test('返回其他角色任务或外部图片地址时不使用也不取消该任务',async()=>{
  const f=fixture();f.drawing.syncJob=async()=>({...f.submitted[0],id:'foreign-job',characterId:'other-character',status:'completed',images:[image]});
  await assert.rejects(f.invoke({workflowId:'workflow-1'},{characterId:'character-1',requestId}),/归属/);
  assert.deepEqual(f.cancelled,[]);
  const g=fixture();g.drawing.syncJob=async()=>({...g.submitted[0],id:'job-1',status:'completed',images:[{...image,url:'https://other.invalid/image.png'}]});
  await assert.rejects(g.invoke({workflowId:'workflow-1'},{characterId:'character-1',requestId}),/归档地址/);
  assert.deepEqual(g.cancelled,[]);
});

test('提交响应悬而未决时保留稳定请求标识且不补交',async()=>{
  const f=fixture();f.drawing.submit=value=>{f.submitted.push(value);return new Promise(()=>{});};
  const invoke=module.createDrawingTool({...f,timeoutMs:15,baseUrl:()=> 'http://127.0.0.1:19876'});
  await assert.rejects(invoke({workflowId:'workflow-1'},{characterId:'character-1',requestId}),error=>error.status===504&&error.jobId===null&&error.requestId===f.submitted[0].requestId);
  assert.equal(f.submitted.length,1);assert.deepEqual(f.cancelled,[]);
});
