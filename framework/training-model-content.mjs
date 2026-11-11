import { open, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const trainingModelClassificationVersion = 'base-models-v4';
const maxHeaderBytes = 16 * 1024 * 1024;
const weightFile = name => /\.(?:safetensors|ckpt|gguf|bin|pt|pth)$/i.test(name);
const adapterName = /(?:^|[\s/_.-])(?:lora|lycoris|lokr|loha|dora|oft|boft|adapter)(?:$|[\s/_.-])/i;
const adapterKey = /(?:^|[._])(?:lora_(?:up|down|[ab]|embedding_[ab])|lora(?:_linear_layer)?\.(?:up|down)|lokr_\w+|hada_\w+|dora_scale|lora_magnitude_vector|oft_\w+|boft_\w+|vera_(?:[ab]|lambda_[bd])|ia3_l)(?:[._]|$)/i;
const componentName = /(?:^|[\s/_.-])(?:vae|autoencoder\w*|clip(?:text|vision)?\w*|t5(?:encoder)?\w*|text-encoder|control[-_]?net\w*|lllite|ipadapter)(?:$|[\s/_.-])/i;
const diffusionName = /stable.?diffusion|sdxl|flux|qwen.?image|moss.?image|anima|lumina|hunyuan|wan(?:\d|[._-])|sd3|pixart|transformer2dmodel|unet2dconditionmodel|diffusionpipeline/i;
const unknown = detail => ({modelType:'unknown',evidence:{kind:'unknown',detail},metadata:{},keys:[],configs:[]});
const classified = (modelType,kind,detail,content) => ({...content,modelType,evidence:{kind,detail}});
const object = value => value && typeof value==='object' && !Array.isArray(value);
function consume(budget,bytes) {
  if(!budget)return;
  if(bytes>budget.remaining){budget.exhausted=true;throw new Error('达到本次元数据读取上限');}
  budget.remaining-=bytes;
}
async function configFile(path,budget) {
  const info=await stat(path);
  if(!info.isFile()||info.size>2*1024*1024)throw new Error('配置文件过大或不是普通文件');
  consume(budget,info.size);
  const value=JSON.parse(await readFile(path,'utf8'));
  if(!object(value))throw new Error('配置文件不是对象');
  return value;
}
function headerClassification(metadata,keys) {
  const content={metadata,keys,configs:[]};
  const adapter=keys.find(key=>adapterKey.test(key)||/^lora_(?:unet|te|transformer)/i.test(key));
  if(adapter)return classified('adapter','tensors',adapter,content);
  const has=pattern=>keys.some(key=>pattern.test(key));
  // Check the denoiser before component keys: full checkpoints also contain VAE and CLIP tensors.
  const diffusion=has(/^(?:model\.)?diffusion_model\..+\.weight$/)
    ||has(/^(?:transformer\.)?double_blocks\.\d+\..+\.weight$/)&&has(/^(?:transformer\.)?single_blocks\.\d+\..+\.weight$/)
    ||has(/^(?:unet\.)?down_blocks\.\d+\./)&&has(/^(?:unet\.)?up_blocks\.\d+\./)
    ||has(/^(?:transformer\.)?transformer_blocks\.\d+\.(?:attn|attn1)\..+\.weight$/)&&has(/(?:^|\.)(?:time_text_embed|time_embed|time_embedding|img_in|x_embedder)\./)
    ||has(/^(?:net\.)?(?:blocks|joint_blocks)\.\d+\..+\.weight$/)&&has(/^(?:net\.)?(?:x_embedder|patch_embedding)\./)&&has(/^(?:net\.)?(?:t_embedder|time_embedding)\./);
  if(diffusion)return classified('base','tensors','检测到扩散主网络张量',content);
  for(const key of ['ss_network_module','network_module','modelspec.architecture','peft_type','adapter_type','model_type']){
    if(adapterName.test(String(metadata[key]||'')))return classified('adapter','metadata',key,content);
  }
  const spec=String(metadata['modelspec.architecture']||metadata.model_type||metadata.architecture||'');
  if(componentName.test(spec))return classified('component','metadata','独立编码器、VAE 或条件网络',content);
  if(has(/^(?:text_model|vision_model)\.embeddings\./)||has(/^encoder\.block\.\d+\.layer\./)
    ||has(/^(?:encoder|decoder)\.conv_in\.weight$/)&&has(/^(?:quant_conv|post_quant_conv)\.weight$/)
    ||has(/^(?:controlnet_(?:down_blocks|mid_block|cond_embedding)|lllite_conditioning\d*)\./))return classified('component','tensors','独立编码器、VAE 或条件网络张量',content);
  if(keys.length&&diffusionName.test(spec))return classified('base','metadata','modelspec.architecture / model_type / architecture',content);
  return {...unknown('尚无足够内容证据确认是底模，请识别后使用。'),...content};
}
async function inspectFile(path,info,budget) {
  if(extname(path).toLowerCase()!=='.safetensors')return unknown('此格式尚未检查权重内容，请识别后使用。');
  let file;
  try{
    file=await open(path,'r');const size=Buffer.alloc(8);consume(budget,8);
    if((await file.read(size,0,8,0)).bytesRead!==8)throw new Error('权重头不完整');
    const length=size.readBigUInt64LE();
    if(length<2n||length>BigInt(maxHeaderBytes)||length>BigInt(Math.max(0,info.size-8)))throw new Error('权重头大小无效');
    consume(budget,Number(length));const bytes=Buffer.alloc(Number(length));
    if((await file.read(bytes,0,bytes.length,8)).bytesRead!==bytes.length)throw new Error('权重头不完整');
    const header=JSON.parse(bytes.toString('utf8'));
    if(!object(header))throw new Error('权重头不是对象');
    const keys=Object.keys(header).filter(key=>key!=='__metadata__');
    if(keys.some(key=>!object(header[key])||typeof header[key].dtype!=='string'||!Array.isArray(header[key].shape)||!Array.isArray(header[key].data_offsets)||header[key].data_offsets.length!==2))throw new Error('张量描述无效');
    return headerClassification(object(header.__metadata__)?header.__metadata__:{},keys);
  }catch(error){return unknown(`无法识别权重头：${error.message}`);}
  finally{await file?.close();}
}
async function inspectDirectory(path,options) {
  const configs=[];
  for(const relative of ['model_index.json','config.json','adapter_config.json','transformer/config.json','unet/config.json']){
    try{configs.push({relative,config:await configFile(join(path,relative),options.budget)});}catch{/* Optional configuration, bounded like headers. */}
  }
  const weights=[];let truncated=false;
  for(const relative of ['','transformer','unet']){
    let entries;try{entries=await readdir(join(path,relative),{withFileTypes:true});}catch{continue;}
    for(const entry of entries){
      if(!weightFile(entry.name)||entry.isDirectory())continue;
      if(weights.length>=64){truncated=true;break;}
      const weightPath=join(path,relative,entry.name);let info;
      try{info=await stat(weightPath);}catch{weights.push({...unknown('权重文件不可读取。'),filename:entry.name});continue;}
      // Follow file links used by model caches, but never recurse through a weight-looking directory link.
      if(!info.isFile())continue;
      let content=options.cache?.get(weightPath);
      if(!content){content=inspectFile(weightPath,info,options.budget);options.cache?.set(weightPath,content);}
      weights.push({...await content,filename:entry.name});
    }
  }
  const base=weights.find(item=>item.modelType==='base');
  if(base)return {...base,evidence:{kind:'directory',detail:'目录中已识别到扩散主网络权重'},configs};
  const adapterConfig=configs.find(({config})=>adapterName.test(String(config.peft_type||config.adapter_type||'')));
  const adapters=weights.filter(item=>item.modelType==='adapter');
  if(!truncated&&(adapterConfig||adapters.length)&&weights.every(item=>item.modelType==='adapter'||adapterConfig&&item.modelType==='unknown'&&/^adapter_model\.bin$/i.test(item.filename)))return classified('adapter','directory','目录包含适配器配置或仅包含适配器权重',{metadata:{},keys:[],configs});
  const component=configs.find(({config})=>componentName.test([config._class_name,...(Array.isArray(config.architectures)?config.architectures:[]),config.model_type].filter(Boolean).join(' ')));
  if(!truncated&&(component||weights.length)&&weights.every(item=>item.modelType==='component'))return classified('component','directory','目录包含独立编码器、VAE 或条件网络',{metadata:{},keys:[],configs});
  return {...unknown('模型目录尚未确认主网络权重，请识别后使用。'),configs};
}
export async function inspectTrainingModelContent(path,options={}) {
  if(options.cache?.has(path))return options.cache.get(path);
  const result=(async()=>{
    try{
      const info=await stat(path);
      return info.isDirectory()?await inspectDirectory(path,options):info.isFile()?await inspectFile(path,info,options.budget):unknown('不是普通模型文件。');
    }catch{return unknown('模型路径不可读取。');}
  })();
  options.cache?.set(path,result);
  return result;
}
