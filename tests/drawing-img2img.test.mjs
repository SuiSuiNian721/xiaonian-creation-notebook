import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingControls, applyDrawingAdjustments } from '../framework/drawing-adjustments.mjs';
import { img2imgPlan } from '../framework/drawing-img2img.mjs';

const schema={
  UNETLoader:{output:['MODEL']},VAELoader:{output:['VAE']},CLIPTextEncode:{output:['CONDITIONING']},
  LoadImage:{output:['IMAGE','MASK'],input:{required:{image:[['photo.png']]}}},
  KSampler:{output:['LATENT'],input:{required:{denoise:['FLOAT',{min:0,max:1}]}}},
  VAEEncodeTiled:{output:['LATENT'],input:{required:{pixels:['IMAGE'],vae:['VAE'],tile_size:['INT',{default:512}],overlap:['INT',{default:64}]}}},
  ImageScale:{output:['IMAGE'],input:{required:{image:['IMAGE'],width:['INT'],height:['INT'],upscale_method:[['lanczos']],crop:[['center']]}}},
  ImageScaleToTotalPixels:{output:['IMAGE'],input:{required:{image:['IMAGE'],upscale_method:[['lanczos']],megapixels:['FLOAT'],resolution_steps:['INT',{default:1}]}}},
  RepeatLatentBatch:{output:['LATENT'],input:{required:{samples:['LATENT'],amount:['INT',{min:1,max:64}]}}},
  ZML_PresetResolutionV2:{output:['INT','INT','LATENT']},
};
const graph=()=>({model:{class_type:'UNETLoader',inputs:{}},vae:{class_type:'VAELoader',inputs:{}},
  text:{class_type:'CLIPTextEncode',inputs:{text:'a cup'}},size:{class_type:'ZML_PresetResolutionV2',inputs:{预设:'自定义',随机模式:false,自定义宽:1024,自定义高:1024}},
  latent:{class_type:'EmptyFlux2LatentImage',inputs:{width:['size',0],height:['size',1],batch_size:1}},
  sample:{class_type:'KSampler',inputs:{positive:['text',0],negative:['text',0],model:['model',0],latent_image:['latent',0],seed:42,denoise:1}},
  decode:{class_type:'VAEDecode',inputs:{samples:['sample',0],vae:['vae',0]}}});

test('MOSS 可转为图生图，但原工作流参数不显示不存在的图片输入',()=>{
  const controls=img2imgPlan(graph(),schema,[['vae',0]]);
  assert.equal(controls.available,true);assert.equal(controls.mode,'img2img');assert.equal(controls.maxImages,1);assert.equal(controls.denoiseKey,'sample:denoise');
  assert.ok(controls.sizeKeys.includes('size:自定义宽'));
  for(const type of ['EmptyLatentImage','EmptySD3LatentImage','EmptyFlux2LatentImage']){
    const prompt=graph();prompt.latent.class_type=type;
    const reference=drawingControls(prompt,schema).reference;
    assert.equal(reference.available,false,`${type} 不是图片输入节点`);
    assert.equal(reference.maxImages,0);
  }
  assert.equal(img2imgPlan(graph(),{...schema,LoadImage:{...schema.LoadImage,input:{required:{image:[[]]}}}},[['vae',0]]).available,true);
  const existing=graph();existing.photo={class_type:'LoadImage',inputs:{image:'photo.png'}};existing.encode={class_type:'VAEEncodeTiled',inputs:{pixels:['photo',0],vae:['vae',0]}};existing.sample.inputs.latent_image=['encode',0];
  assert.equal(drawingControls(existing,schema).reference.available,false);
});
test('上传图片连接分块编码与初始采样器，默认缩放保比例，原图不变',()=>{
  const prompt=graph(),before=structuredClone(prompt);
  const result=applyDrawingAdjustments(prompt,{images:['photo.png'],imageDenoise:0.55},schema);
  const [loadId,load]=Object.entries(result).find(([,node])=>node.class_type==='LoadImage');
  const [scaleId,scale]=Object.entries(result).find(([,node])=>node.class_type==='ImageScaleToTotalPixels');
  const [encodeId,encode]=Object.entries(result).find(([,node])=>node.class_type==='VAEEncodeTiled');
  assert.equal(load.inputs.image,'photo.png');assert.deepEqual(scale.inputs.image,[loadId,0]);assert.equal(scale.inputs.megapixels,1);
  assert.deepEqual(encode.inputs.pixels,[scaleId,0]);assert.deepEqual(encode.inputs.vae,['vae',0]);assert.equal(encode.inputs.tile_size,512);
  assert.deepEqual(result.sample.inputs.latent_image,[encodeId,0]);assert.equal(result.sample.inputs.denoise,0.55);assert.deepEqual(prompt,before);
  assert.deepEqual(applyDrawingAdjustments(prompt,{images:[]},schema),before);
});
test('使用宽高设置保留动态尺寸连接和张数，后续精修链不被覆盖',()=>{
  const prompt=graph();prompt.latent.inputs.batch_size=3;prompt.refiner={class_type:'KSampler',inputs:{...prompt.sample.inputs,latent_image:['sample',0],denoise:0.2}};
  prompt.decode.inputs.samples=['refiner',0];
  const result=applyDrawingAdjustments(prompt,{images:['photo.png'],referenceSize:'workflow'},schema);
  const scale=Object.values(result).find(node=>node.class_type==='ImageScale');assert.deepEqual(scale.inputs.width,['size',0]);assert.deepEqual(scale.inputs.height,['size',1]);assert.equal(scale.inputs.crop,'center');
  const [repeatId,repeat]=Object.entries(result).find(([,node])=>node.class_type==='RepeatLatentBatch');assert.equal(repeat.inputs.amount,3);assert.deepEqual(result.sample.inputs.latent_image,[repeatId,0]);
  assert.deepEqual(result.refiner,prompt.refiner);assert.equal(result.sample.inputs.denoise,0.65);
});
test('拒绝不明确分支、错误图片、非法幅度和缺少服务节点',()=>{
  for(const value of [{images:['missing.png']},{images:['photo.png','photo.png']},{images:['photo.png'],imageDenoise:-0.1},{images:['photo.png'],imageDenoise:NaN}])assert.throws(()=>applyDrawingAdjustments(graph(),value,schema));
  const ambiguous=graph();ambiguous.other={class_type:'KSampler',inputs:{...ambiguous.sample.inputs}};assert.equal(drawingControls(ambiguous,schema).reference.available,false);
  const noVae={...schema};delete noVae.VAEEncodeTiled;assert.equal(drawingControls(graph(),noVae).reference.available,false);
  const advanced=graph();advanced.sample.class_type='KSamplerAdvanced';assert.equal(drawingControls(advanced,schema).reference.available,false);
});
