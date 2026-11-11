import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFields } from '../framework/drawing-workflows.mjs';
import { drawingControls, applyDrawingAdjustments } from '../framework/drawing-adjustments.mjs';

const info={LoadImage:{output:['IMAGE','MASK'],input:{required:{image:[['main.png','ref.png'],{image_upload:true}]}}},
  ImageScale:{output:['IMAGE'],input:{required:{image:['IMAGE']}}},VAEEncode:{output:['LATENT'],input:{required:{pixels:['IMAGE']}}},
  KSampler:{output:['LATENT'],input:{required:{latent_image:['LATENT'],positive:['CONDITIONING'],negative:['CONDITIONING']}}},
  TextEncodeQwenImage21:{output:['CONDITIONING','CONDITIONING','LATENT'],input:{required:{images:['COMFY_AUTOGROW_V3',{template:{names:['image_1','image_2','image_3'],min:0,input:{required:{image:['IMAGE']}}}}]},optional:{vae:['VAE']}}},
  VAE:{output:['VAE']},Decode:{output:['IMAGE'],input:{required:{vae:['VAE'],samples:['LATENT']}}}};
const photo=(image)=>({class_type:'LoadImage',inputs:{image}});
test('Qwen 图片按真实槽位区分主图和参考图，不依赖节点标题和编号',()=>{
  const prompt={a:photo('main.png'),b:photo('ref.png'),resize:{class_type:'ImageScale',inputs:{image:['a',0]}},encode:{class_type:'TextEncodeQwenImage21',inputs:{'images.image_1':['resize',0],'images.image_2':['b',0]}}};
  const fields=workflowFields(prompt,info);
  assert.equal(fields.find(f=>f.nodeId==='a').presentation.label,'主图');assert.equal(fields.find(f=>f.nodeId==='b').presentation.label,'参考图 1');
  [prompt.encode.inputs['images.image_1'],prompt.encode.inputs['images.image_2']]=[prompt.encode.inputs['images.image_2'],prompt.encode.inputs['images.image_1']];
  assert.equal(workflowFields(prompt,info).find(f=>f.nodeId==='a').presentation.label,'参考图 1');
});
test('传统图生图沿潜空间与缩放路径找到主图，未知输入不猜用途',()=>{
  const prompt={a:photo('main.png'),b:photo('ref.png'),resize:{class_type:'ImageScale',inputs:{image:['a',0]}},encode:{class_type:'VAEEncode',inputs:{pixels:['resize',0]}},sample:{class_type:'KSampler',inputs:{latent_image:['encode',0]}}};
  const fields=workflowFields(prompt,info);
  assert.equal(fields.find(f=>f.nodeId==='a').presentation.label,'主图');assert.equal(fields.find(f=>f.nodeId==='b').presentation.label,'图片输入');
});
test('已有主图时，追加入口从剩余参考图槽位开始，不把它标成主图',()=>{
  const prompt={a:photo('main.png'),vae:{class_type:'VAE',inputs:{}},encode:{class_type:'TextEncodeQwenImage21',inputs:{'images.image_1':['a',0],vae:['vae',0]}},sample:{class_type:'KSampler',inputs:{positive:['encode',0],negative:['encode',1],latent_image:['encode',2]}}};
  assert.deepEqual(drawingControls(prompt,info).reference.roles,[{slot:'images.image_2',role:'reference',label:'参考图 1'},{slot:'images.image_3',role:'reference',label:'参考图 2'}]);
});
test('图片上传能力按实际控件标记识别，不限于名为LoadImage的节点',()=>{
  const prompt={a:{class_type:'CustomPicture',inputs:{picture:'main.png'}}};
  const fields=workflowFields(prompt,{CustomPicture:{output:['IMAGE'],input:{required:{picture:[['main.png'],{image_upload:true}]}}}});
  assert.equal(fields[0].image,true);assert.equal(fields[0].presentation.section,'reference');
});

test('指定参考图槽位时不向前移位，缺少主图不把参考图冒充主图',()=>{
  const prompt={a:photo('main.png'),vae:{class_type:'VAE',inputs:{}},encode:{class_type:'TextEncodeQwenImage21',inputs:{'images.image_1':['a',0],vae:['vae',0]}},sample:{class_type:'KSampler',inputs:{positive:['encode',0],negative:['encode',1],latent_image:['encode',2]}}};
  const result=applyDrawingAdjustments(prompt,{images:['ref.png'],imageSlots:['images.image_3']},info);
  assert.equal(result.encode.inputs['images.image_2'],undefined);assert.ok(result.encode.inputs['images.image_3']);assert.deepEqual(result.encode.inputs['images.image_1'],['a',0]);
  const missing=structuredClone(prompt);delete missing.encode.inputs['images.image_1'];
  assert.throws(()=>applyDrawingAdjustments(missing,{images:['ref.png'],imageSlots:['images.image_2']},info),/主图/);
  for(const imageSlots of [['images.image_1'],['images.invalid'],[],['images.image_2','images.image_2']])assert.throws(()=>applyDrawingAdjustments(prompt,{images:['ref.png'],imageSlots},info));
});
