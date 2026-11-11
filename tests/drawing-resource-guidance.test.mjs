import test from 'node:test';
import assert from 'node:assert/strict';
import * as preflight from '../public-workbench/drawing-preflight-view.js';
import * as comfyui from '../public-workbench/comfyui-view.js';
import * as manager from '../public-workbench/drawing-manager-view.js';

test('工作流缺失模型显示具体文件名，说明不会遮住实际值', () => {
  const html = preflight.inspectionMarkup({available:true, missingModels:[{nodeId:'4',classType:'CheckpointLoaderSimple',input:'ckpt_name',value:'缺失<模型>.safetensors',detail:'模型不在当前 ComfyUI 的可选列表中。'}]});
  assert.match(html, /缺失&lt;模型&gt;\.safetensors/);
  assert.match(html, /模型不在当前 ComfyUI/);
  assert.match(html, /data-inspection-resource="missingModels:0"/);
  assert.doesNotMatch(html, /缺失<模型>/);
});

test('参数问题同时显示实际值、选项和数值范围，并转义内容', () => {
  const html = preflight.inspectionMarkup({available:true,invalidValues:[
    {input:'sampler_name',value:'<script>"bad"</script>',options:['euler','<custom>'],detail:'参数不在当前节点的可选列表中。'},
    {input:'steps',value:99,options:{min:1,max:30,step:1},detail:'参数类型错误或数值超出范围。'},
    {input:'enabled',value:false,options:[true],detail:'参数不在当前节点的可选列表中。'},
  ]});
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /euler/);
  assert.match(html, /&lt;custom&gt;/);
  assert.match(html, /实际值[：:]\s*99/);
  assert.match(html, /最小值[：:]\s*1/);
  assert.match(html, /最大值[：:]\s*30/);
  assert.match(html, /实际值[：:]\s*false/);
  assert.doesNotMatch(html, /<script>|<custom>/);
});

test('缺失节点可进入已有插件工具，不生成未经核实的仓库', () => {
  const html = preflight.inspectionMarkup({available:true,missingNodes:[{nodeId:'7',classType:'Missing<Node>',detail:'缺少节点。'}]});
  assert.match(html, /data-inspection-resource="missingNodes:0"/);
  assert.match(html, /准备插件/);
});

test('缺项跳转只传已知文件类别与节点名，不猜来源', async () => {
  const buttons = ['missingModels:0','missingNodes:0','missingModels:1'].map(value => ({dataset:{inspectionResource:value}}));
  const calls=[];
  const ctx={signal:new AbortController().signal,action:async (_button,job)=>job(),navigateModule:async (...args)=>calls.push(args),notify:assert.fail};
  assert.equal(typeof preflight.bindInspectionActions,'function','依赖检查需要接入现有资源工具');
  preflight.bindInspectionActions({querySelectorAll:()=>buttons},ctx,{missingModels:[{input:'ckpt_name',value:'character.safetensors'},{input:'model_name',value:'unknown.safetensors'}],missingNodes:[{classType:'Missing<Node>'}]});
  for (const button of buttons) await button.onclick();
  assert.deepEqual(calls,[
    ['comfyui',{tab:'resources',section:'downloads',filename:'character.safetensors',category:'checkpoints'}],
    ['comfyui',{tab:'resources',section:'plugins',query:'Missing<Node>'}],
    ['comfyui',{tab:'resources',section:'downloads',filename:'unknown.safetensors',category:''}],
  ]);
});

test('启动器一次性消费目标，不让后续挂载重放', () => {
  const target={tab:'resources',section:'downloads',filename:'one.safetensors'};
  const ui={moduleTarget:target};
  assert.equal(typeof comfyui.consumeComfyTarget,'function','资源目标需要消费一次');
  assert.deepEqual(comfyui.consumeComfyTarget(ui),target);
  assert.equal(ui.moduleTarget,undefined);
  assert.equal(comfyui.consumeComfyTarget(ui),null);
});

test('新模型缺项预填清除旧地址和哈希，保留明确目标，不启动下载', () => {
  assert.equal(typeof manager.resourceDownloadDraft,'function','目标预填应避免沿用上次模型来源');
  const draft={url:'https://example.invalid/old',category:'loras',filename:'old.pth',sha256:'f'.repeat(64)};
  assert.deepEqual(manager.resourceDownloadDraft(draft,{section:'downloads',filename:'new.safetensors',category:'checkpoints'}),{url:'',category:'checkpoints',filename:'new.safetensors',sha256:''});
  assert.deepEqual(manager.resourceDownloadDraft(draft,null),draft);
  assert.deepEqual(manager.resourceDownloadDraft(draft,{section:'downloads',filename:'MOSS\\小璃.safetensors',category:'loras'}),{url:'',category:'loras',filename:'小璃.safetensors',sha256:''},'现有下载器只接受基础文件名，保留原路径供页面提示');
});

test('解码器目录为明确选择的模型家族提供官方原始权重，不自动猜家族', () => {
  assert.ok(Array.isArray(manager.PREVIEW_DECODERS),'需提供可选择的解码器清单');
  assert.deepEqual(manager.PREVIEW_DECODERS.map(item=>[item.family,item.filename]),[
    ['SD1.5 / SD2','taesd_decoder.pth'],['SDXL','taesdxl_decoder.pth'],['SD3','taesd3_decoder.pth'],['FLUX.1','taef1_decoder.pth'],
  ]);
  for (const item of manager.PREVIEW_DECODERS) {
    assert.equal(item.category,'vae_approx');
    assert.equal(item.source,'https://github.com/madebyollin/taesd');
    assert.equal(item.url,'https://raw.githubusercontent.com/madebyollin/taesd/main/'+item.filename);
  }
  assert.deepEqual(manager.resourceDownloadDraft({url:'old',filename:'old',category:'vae',sha256:'old'},{section:'downloads',previewDecoders:true}),{url:'',filename:'',category:'vae_approx',sha256:''});
});
