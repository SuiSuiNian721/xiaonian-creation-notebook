import test from 'node:test';
import assert from 'node:assert/strict';
import {DrawingCompletionSources} from '../framework/drawing-completion-sources.mjs';

test('固定版本元数据缓存7天，普通检索24小时；取消不留下后台刷新',async()=>{
  let calls=0;const settings=new Map();const store={getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,value)};
  const source=new DrawingCompletionSources({store,fetchImpl:async()=>{calls++;return Response.json({value:calls});}});
  const budget={requests:0,cacheHits:0,maxRequests:40};const search='https://civitai.com/api/v1/models?query=base',fixed='https://civitai.com/api/v1/model-versions/12';
  await source.get(search,{budget});await source.get(fixed,{budget,fixed:true});source.cache[search].at-=2*86400000;source.cache[fixed].at-=2*86400000;
  await source.get(search,{budget});await source.get(fixed,{budget,fixed:true});assert.equal(calls,3);assert.equal(budget.cacheHits,1);
});

test('候选元数据超过上限时在读取阶段停止流，避免无限响应占用内存',async()=>{
  let read=0;const source=new DrawingCompletionSources({store:{getSetting:()=>null,setSetting:()=>{}},fetchImpl:async()=>new Response(new ReadableStream({pull(controller){read++;controller.enqueue(new Uint8Array(1024*1024));if(read>=30)controller.close();}}))});
  await assert.rejects(source.get('https://civitai.com/api/v1/models',{budget:{requests:0,cacheHits:0,maxRequests:40}}),/8 MiB/);assert.ok(read<=11,`读取了 ${read} MiB`);
});

const budget=()=>({requests:0,cacheHits:0,maxRequests:40});
const tick=()=>new Promise(done=>setImmediate(done));

test('Civitai先过滤非模型附件再排序截断，保留第六个精确基础文件名',async()=>{
  const files=[{name:'preview.png'},{name:'training.zip'},...Array.from({length:5},(_,index)=>({name:`base-variant-${index}.safetensors`})),{name:'folder/BASE.SAFETENSORS'}].map((file,index)=>({...file,downloadUrl:`https://civitai.com/files/${index}`}));
  const source=new DrawingCompletionSources({store:{getSetting:()=>null,setSetting:()=>{}},fetchImpl:async url=>Response.json(String(url).startsWith('https://civitai.com/')?{items:[{id:1,name:'base',modelVersions:[{id:2,files}]}]}:[])});
  const limits=budget(),result=await source.models({filename:'nested\\base.safetensors',category:'checkpoints'},{budget:limits});
  assert.equal(result.candidates[0]?.filename,'BASE.SAFETENSORS');
  assert.equal(result.candidates.length,5);assert.ok(result.candidates.every(item=>item.filename.endsWith('.safetensors')||item.filename.endsWith('.SAFETENSORS')));
  assert.ok(result.candidates.every(item=>item.match==='candidate'));assert.equal(limits.requests,2);
});

test('来源响应顺序不改变候选顺序，跨平台精确文件名始终排在近似候选前',async()=>{
  async function run(first){
    const waiting={};
    const civitai={items:[{id:1,modelVersions:[{id:2,files:[{name:'base-near.safetensors',downloadUrl:'https://civitai.com/files/near'},{name:'base.safetensors',downloadUrl:'https://civitai.com/files/exact'}]}]}]};
    const hf={sha:'a'.repeat(40),siblings:[{rfilename:'base-other.safetensors'},{rfilename:'BASE.safetensors'}]};
    const source=new DrawingCompletionSources({store:{getSetting:()=>null,setSetting:()=>{}},fetchImpl:async url=>{
      if(String(url).includes('/api/models?search='))return Response.json([{id:'owner/base'}]);
      const platform=String(url).startsWith('https://civitai.com/')?'civitai':'huggingface';
      return new Promise(done=>{waiting[platform]=()=>done(Response.json(platform==='civitai'?civitai:hf));});
    }});
    const limits=budget(),pending=source.models({filename:'base.safetensors',category:'checkpoints'},{budget:limits});
    while(!waiting.civitai||!waiting.huggingface)await tick();
    waiting[first]();await tick();waiting[first==='civitai'?'huggingface':'civitai']();
    const result=await pending;assert.equal(limits.requests,3);assert.ok(result.candidates.every(item=>item.match==='candidate'));
    assert.deepEqual(result.candidates.slice(0,2).map(item=>item.filename.toLowerCase()),['base.safetensors','base.safetensors']);
    return result.candidates;
  }
  assert.deepEqual(await run('civitai'),await run('huggingface'));
});

test('HF同一仓库第六个精确文件在五候选截断前优先，不增加请求',async()=>{
  const source=new DrawingCompletionSources({store:{getSetting:()=>null,setSetting:()=>{}},fetchImpl:async url=>{
    if(String(url).startsWith('https://civitai.com/'))return Response.json({items:[]});
    if(String(url).includes('/api/models?search='))return Response.json([{id:'owner/base'}]);
    return Response.json({sha:'a'.repeat(40),siblings:[...Array.from({length:5},(_,index)=>({rfilename:`base-${index}.safetensors`})),{rfilename:'folder/BASE.SAFETENSORS'}]});
  }});
  const limits=budget(),result=await source.models({filename:'nested/base.safetensors',category:'checkpoints'},{budget:limits});
  assert.equal(result.candidates[0]?.filename,'BASE.SAFETENSORS');assert.equal(result.candidates.length,5);assert.equal(limits.requests,3);
});

function pendingSource() {
  const waiting=[];
  const source=new DrawingCompletionSources({store:{getSetting:()=>null,setSetting:()=>{}},fetchImpl:(_url,{signal})=>new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});waiting.push(()=>{signal.removeEventListener('abort',abort);resolve(Response.json({ok:true}));});})});
  return {source,waiting};
}

test('同URL跨报告只共享完成缓存，取消A不取消B，同报告仍合并请求',async()=>{
  const {source,waiting}=pendingSource();const a=new AbortController(),b=new AbortController(),url='https://civitai.com/api/v1/models?query=shared';
  const requests=[source.get(url,{signal:a.signal,budget:budget()}),source.get(url,{signal:a.signal,budget:budget()}),source.get(url,{signal:b.signal,budget:budget()})];
  await tick();a.abort(new Error('cancel A'));for(const complete of waiting)complete();const result=await Promise.allSettled(requests);
  assert.equal(waiting.length,2);assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'rejected');assert.equal(result[2].status,'fulfilled');assert.equal(b.signal.aborted,false);
  const count=waiting.length;assert.deepEqual(await source.get(url,{signal:new AbortController().signal,budget:budget()}),{ok:true});assert.equal(waiting.length,count);
});

test('B取消自身的同URL等待不必等A请求完成，也不会取消A',async()=>{
  const {source,waiting}=pendingSource();const a=new AbortController(),b=new AbortController(),url='https://civitai.com/api/v1/models?query=shared';
  const requestA=source.get(url,{signal:a.signal,budget:budget()});const requestB=source.get(url,{signal:b.signal,budget:budget()});
  await tick();b.abort(new Error('cancel B'));
  const promptly=await Promise.race([requestB.then(()=>'fulfilled',()=>'cancelled'),new Promise(done=>setTimeout(()=>done('still-waiting'),30))]);
  for(const complete of waiting)complete();const result=await Promise.allSettled([requestA,requestB]);
  assert.equal(promptly,'cancelled');assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');assert.equal(a.signal.aborted,false);
});

test('交出网络并发令牌时新请求不能抢占已唤醒的等待者而突破并发2',async()=>{
  let active=0,peak=0;const waiting=[];const source=new DrawingCompletionSources({store:{getSetting:()=>null,setSetting:()=>{}},fetchImpl:()=>{active++;peak=Math.max(peak,active);return new Promise(done=>waiting.push(()=>{active--;done(Response.json({ok:true}));}));}});
  const get=index=>source.get(`https://civitai.com/api/v1/models?query=${index}`,{signal:new AbortController().signal,budget:budget()});
  const requests=[get(1),get(2),get(3)];await tick();const resume=source.waiters[0].resolve;
  source.waiters[0].resolve=()=>{requests.push(get(4));resume();};
  waiting.shift()();await tick();
  for(let index=0;index<10;index++){for(const complete of waiting.splice(0))complete();await tick();}
  await Promise.all(requests);assert.ok(peak<=2,`真实网络并发达到 ${peak}`);assert.equal(source.active,0);
});
