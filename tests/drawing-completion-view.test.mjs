import test from 'node:test';
import assert from 'node:assert/strict';

test('依赖报告分别显示磁盘和服务，候选不会默认勾选且暴露体积与哈希证据',async()=>{
  const {completionMarkup}=await import('../public-workbench/drawing-completion-view.js');
  const markup=completionMarkup({id:'report',status:'completed',scope:'remote',comfyPath:'C:\\Comfy',dependencies:[{id:'dep',kind:'model',filename:'<base>.safetensors',category:'checkpoints',status:'candidate',service:{status:'unverified'},local:{status:'exists',identity:'unverified',files:[{path:'C:\\base.safetensors',sha256:'a'.repeat(64)}]},candidates:[{id:'candidate',platform:'huggingface',filename:'base.safetensors',version:'v1',url:'https://huggingface.co/a/b/resolve/v1/base',source:'https://huggingface.co/a/b',sha256:null,verification:'untrusted-hash',license:'unverified',storage:{downloadBytes:100,incrementalBytes:100,temporaryPeakBytes:200,destination:'C:\\Comfy\\models\\checkpoints\\base.safetensors'}}],issues:[]}],warnings:[],budget:{requests:0,hashBytes:0},ai:{calls:0}});
  assert.match(markup,/服务/);assert.match(markup,/磁盘/);assert.match(markup,/临时峰值/);assert.match(markup,/SHA256/);assert.match(markup,/远程/);
  assert.equal(markup.includes('<base>'),false);assert.equal(/type="checkbox"[^>]*checked/.test(markup),false);
  assert.match(markup,/额外模型目录/);assert.match(markup,/data-completion-local-recheck/);
});

test('LoRA资源只列当前服务可选项，不把绝对路径直接传给ComfyUI',async()=>{
  const {loraServiceChoices}=await import('../public-workbench/drawing-completion-view.js');
  assert.deepEqual(loraServiceChoices({reference:{path:'E:\\models\\person.safetensors'}},['person.safetensors','folder/person.safetensors','other.safetensors']),['person.safetensors','folder/person.safetensors']);
  assert.deepEqual(loraServiceChoices({reference:{path:'E:\\models\\absent.safetensors'}},['person.safetensors']),[]);
});

test('同SHA本地复用候选在报告中可见，另存副本采用本地相对引用',async()=>{
  const {completionMarkup,completionModelReplacement}=await import('../public-workbench/drawing-completion-view.js');
  const candidate={id:'candidate',filename:'new.safetensors',platform:'civitai',source:'https://civitai.com/models/1',sha256:'a'.repeat(64),reuse:{path:'C:/Comfy/models/checkpoints/renamed.safetensors',reference:'renamed.safetensors'},storage:{downloadBytes:0,incrementalBytes:0,temporaryPeakBytes:0,destination:'C:/Comfy/models/checkpoints/renamed.safetensors'}};
  const dependency={id:'dep',kind:'model',filename:'old.safetensors',status:'candidate',service:{status:'missing'},local:{status:'exists',identity:'verified',files:[]},candidates:[candidate],issues:[]};
  const markup=completionMarkup({status:'completed',scope:'local',dependencies:[dependency],warnings:[],budget:{},ai:{}});assert.match(markup,/本地复用/);
  assert.deepEqual(completionModelReplacement(dependency,candidate),{dependencyId:'dep',value:'renamed.safetensors'});
});
