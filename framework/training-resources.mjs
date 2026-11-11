import { readdir, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { WorkbenchError } from './contracts.mjs';
import { trainingPath } from './training-runtime.mjs';
import { trainingEngineDirectories } from './training-engine-layout.mjs';
import { inspectTrainingModelContent, trainingModelClassificationVersion } from './training-model-content.mjs';

export const trainingFamilies = ['anima','sd15','sdxl','flux','lumina','krea2','ideogram4','klein','qwen-image-21','moss-image'];
const architecture = value => {
  const text=String(value||'').toLowerCase().replace(/[_\s]/g,'-');
  for(const [pattern,family] of [[/moss/,'moss-image'],[/qwen.*(?:2[.-]1|image-21)(?:\D|$)/,'qwen-image-21'],[/klein/,'klein'],[/krea/,'krea2'],[/ideogram/,'ideogram4'],[/anima/,'anima'],[/lumina/,'lumina'],[/flux/,'flux'],[/stable-diffusion-xl|sdxl|sd-xl/,'sdxl'],[/stable-diffusion-v1|stable-diffusion-1|sd15|sd-1[.-]5/,'sd15']])if(pattern.test(text))return family;
  return null;
};
export async function inspectTrainingModel(value,catalog) {
  const path=trainingPath(value.path,'底模路径');
  if(value.family!==undefined&&value.family!==''&&!trainingFamilies.includes(value.family))throw new WorkbenchError(400,'模型家族无效。');
  let info;try{info=await stat(path);}catch{throw new WorkbenchError(400,'底模路径不存在或不可读取。');}
  const content=await inspectTrainingModelContent(path,{budget:{remaining:128*1024*1024},cache:new Map()}),{metadata,keys}=content;
  if(content.modelType==='adapter')throw new WorkbenchError(400,'所选文件或目录是 LoRA／适配器权重，不能作为训练底模。请选择完整底模或 DiT 权重。');
  if(content.modelType==='component')throw new WorkbenchError(400,'所选文件或目录是独立编码器、VAE 或条件网络，不能作为训练底模。');
  let detected=null,evidence={kind:'unknown',detail:'元数据不足，请选择模型家族。'};
  for(const {relative,config} of content.configs){
    const family=architecture([config._class_name,Array.isArray(config.architectures)?config.architectures.join(' '):'',config.model_type,config._name_or_path,config['modelspec.architecture']].filter(Boolean).join(' '));
    if(family){detected=family;evidence={kind:'config',detail:relative};break;}
  }
  if(!detected)for(const key of ['modelspec.architecture','ss_base_model_version','model_type','architecture','base_model']){const family=architecture(metadata[key]);if(family){detected=family;evidence={kind:'metadata',detail:key};break;}}
  if(!detected){
    if(keys.some(key=>key.includes('conditioner.embedders.1.model.transformer.resblocks'))){detected='sdxl';evidence={kind:'tensors',detail:'SDXL 双文本编码器'};}
    else if(keys.some(key=>key.startsWith('double_blocks.'))&&keys.some(key=>key.startsWith('single_blocks.'))){detected='flux';evidence={kind:'tensors',detail:'Flux double_blocks / single_blocks'};}
  }
  const manual=value.family||null,family=manual||detected;
  const quantized=keys.some(key=>/comfy_quant|quant_state|bitsandbytes/.test(key))||Object.values(metadata).some(item=>/gguf|bitsandbytes|nf4/i.test(String(item)));
  const preference=catalog.engine_preference?.[family]||[],order=engine=>preference.includes(engine)?preference.indexOf(engine):preference.length;
  const matches=catalog.training_types.filter(item=>family&&item.family===family&&item.target==='lora').sort((a,b)=>order(a.engine)-order(b.engine));
  return {path,name:basename(path),kind:info.isDirectory()?'directory':'file',modelType:content.modelType,classificationEvidence:content.evidence,family,detectedFamily:detected,evidence:manual?{kind:'manual',detail:manual}:evidence,quantized,warnings:[...(content.modelType==='unknown'?['尚未确认此文件或目录包含完整底模，训练前需继续预检。']:[]),...(manual&&detected&&manual!==detected?['手选家族与元数据不同，预检会继续验证实际文件。']:[]),...(quantized?['检测到量化信息；不能把推理量化权重当作可训练底模，请核对引擎要求。']:[])],matches,training_started:false};
}

export async function discoverTrainingResources({roots=[],trainerPath='',pythonPath='',limit=2500,maxDepth=5}={}) {
  if(!Array.isArray(roots)||roots.length>12)throw new WorkbenchError(400,'最多指定 12 个检索目录。');
  const common=[trainerPath,trainerPath&&dirname(trainerPath),'E:\\ai draw\\train','E:\\ai draw\\ComfyUI-aki-v2\\ComfyUI\\models',join(homedir(),'.cache','huggingface','hub'),join(homedir(),'Downloads'),join(homedir(),'Desktop')].filter(Boolean);
  const bases=[...new Set([...roots.map(path=>trainingPath(path,'检索目录')),...common].map(path=>resolve(path)))];
  const models=[],trainers=[],engines=[],pythons=[],warnings=[],seen=new Set(),excludedCounts={adapter:0,component:0};let visited=0,partial=false,candidates=0;
  const contentOptions={budget:{remaining:128*1024*1024,exhausted:false},cache:new Map()};
  async function candidate(path,name,kind){
    candidates++;const content=await inspectTrainingModelContent(path,contentOptions);
    if(content.modelType==='adapter'||content.modelType==='component')excludedCounts[content.modelType]++;
    else models.push({path,name,kind,modelType:content.modelType,evidence:content.evidence});
  }
  const pythonCandidates=[pythonPath,...(process.env.PATH||'').split(delimiter).filter(Boolean).map(path=>join(path,process.platform==='win32'?'python.exe':'python3'))].filter(Boolean);
  for(const path of [...new Set(pythonCandidates)]){try{if((await stat(path)).isFile()&&!/WindowsApps[\\/]python/i.test(path))pythons.push({path,name:basename(dirname(path))});}catch{}}
  const queue=bases.map(path=>({path,depth:0}));
  const mainDirectories=new Set(['checkpoints','diffusion_models','unet','diffusers']);
  while(queue.length){
    if(visited>=limit){partial=true;break;}
    const {path,depth}=queue.shift(),key=path.toLowerCase();if(seen.has(key))continue;seen.add(key);visited++;
    let entries;try{entries=await readdir(path,{withFileTypes:true});}catch{continue;}
    const names=new Set(entries.map(entry=>entry.name));
    if(names.has('mikazuki')&&(names.has('VERSION')||names.has('frontend'))){
      const pythonCandidates=[join(dirname(path),'python_embeded','python.exe'),join(path,'python_embeded','python.exe'),join(path,'.venv','Scripts','python.exe')];let pythonPath='';for(const candidate of pythonCandidates){try{if((await stat(candidate)).isFile()){pythonPath=candidate;break;}}catch{}}
      trainers.push({path,name:basename(path),pythonPath});
      if(pythonPath&&!pythons.some(item=>item.path===pythonPath))pythons.push({path:pythonPath,name:basename(path)});
      for(const [id,nativeDirectory] of Object.entries(trainingEngineDirectories)){
        const engineRoot=join(path,'extensions',nativeDirectory),python=join(engineRoot,'.venv','Scripts','python.exe');
        try{if((await stat(engineRoot)).isDirectory()){let pythonExists=false;try{pythonExists=(await stat(python)).isFile();}catch{}engines.push({id,path:engineRoot,trainerPath:path,pythonPath:pythonExists?python:'',state:pythonExists?'installed_unverified':'not_installed'});}}catch{}
      }
    }
    if(names.has('model_index.json')||names.has('adapter_config.json')||names.has('config.json')&&(/snapshots|models|transformer/i.test(path)))await candidate(path,basename(path),'directory');
    entries.sort((a,b)=>Number(mainDirectories.has(b.name.toLowerCase()))-Number(mainDirectories.has(a.name.toLowerCase())));
    for(const entry of entries){
      if(entry.isSymbolicLink())continue;
      if(entry.isFile()&&/\.(safetensors|ckpt|gguf)$/i.test(entry.name)){await candidate(join(path,entry.name),entry.name,'file');if(candidates>=800){partial=true;break;}}
      if(entry.isDirectory()&&depth<maxDepth&&!/^\.(?:git|venv|python)$|^(?:node_modules|__pycache__|site-packages|output|outputs|logs|blobs|\.python)$/i.test(entry.name))queue.push({path:join(path,entry.name),depth:depth+1});
    }
    if(candidates>=800){partial=true;break;}
  }
  if(partial)warnings.push('达到轻量检索上限，可指定更小的目录后重新检索。');
  if(contentOptions.budget.exhausted){partial=true;warnings.push('达到元数据读取上限，余下模型保留为待识别。');}
  return {models,trainers,engines,pythons,roots:bases,visited,partial,warnings,excludedCounts,classificationVersion:trainingModelClassificationVersion,training_started:false};
}
