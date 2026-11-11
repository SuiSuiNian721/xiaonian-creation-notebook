import { createHash } from 'node:crypto';
import { WorkbenchError } from './contracts.mjs';

export const dependencyId = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
const UI_ONLY = new Set(['Note','MarkdownNote','Reroute','PrimitiveNode','GetNode','SetNode']);
const LOADERS = {CheckpointLoaderSimple:['checkpoints','ckpt_name'],CheckpointLoader:['checkpoints','ckpt_name'],UNETLoader:['unet','unet_name'],UnetLoaderGGUF:['unet','unet_name'],CLIPLoader:['clip','clip_name'],DualCLIPLoader:['clip','clip_name1','clip_name2'],TripleCLIPLoader:['clip','clip_name1','clip_name2','clip_name3'],VAELoader:['vae','vae_name'],LoraLoader:['loras','lora_name'],LoraLoaderModelOnly:['loras','lora_name'],ControlNetLoader:['controlnet','control_net_name'],UpscaleModelLoader:['upscale_models','model_name']};
export const modelCategory = name => /^(ckpt|checkpoint)(?:_name|_file)?$/i.test(name) ? 'checkpoints' : /^lora(?:_name|_file)?$/i.test(name) ? 'loras' : /^vae(?:_name|_file)?$/i.test(name) ? 'vae' : /^clip(?:_name\d*|_file)?$/i.test(name) ? 'clip' : /^unet(?:_name|_file)?$/i.test(name) ? 'unet' : /^diffusion(?:_name|_file)?$/i.test(name) ? 'diffusion_models' : /^control_net(?:_name|_file)?$/i.test(name) ? 'controlnet' : null;
const modelFile = value => typeof value === 'string' && value.length < 1024 && /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(value) && !/[\u0000-\u001f]/.test(value);

export function extractWorkflowDependencies(document, info = {}) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new WorkbenchError(400,'工作流必须是 JSON 对象。');
  const dependencies = new Map(), warnings = []; let count = 0;
  const add = (item,reference) => {
    const id=dependencyId(item.kind==='node'?['node',item.classType]:['model',item.category,item.filename]);
    if (!dependencies.has(id)) dependencies.set(id,{id,...item,references:[]});
    dependencies.get(id).references.push(reference);
  };
  const visit = (node,nodeId,path,ui) => {
    if (++count>2000) throw new WorkbenchError(400,'工作流展开超过 2000 个节点。');
    const classType=ui?node.type:node.class_type;
    if (typeof classType!=='string' || UI_ONLY.has(classType)) return;
    add({kind:'node',classType,registryId:node.properties?.cnr_id || null,gitSource:node.properties?.aux_id || null},{nodeId,path});
    const addModel=(input,value,valuePath,certainty='named-input')=>{const category=modelCategory(input) || (LOADERS[classType]?.slice(1).includes(input)?LOADERS[classType][0]:null);if(category&&modelFile(value)) add({kind:'model',category,filename:value,extraction:certainty},{nodeId,classType,input,path:valuePath});};
    if (!ui) { for (const [input,value] of Object.entries(node.inputs||{})) addModel(input,value,[...path,'inputs',input]); return; }
    if (node.widgets_values && !Array.isArray(node.widgets_values)) { for(const [input,value] of Object.entries(node.widgets_values)) addModel(input,value,[...path,'widgets_values',input]); return; }
    const layout=LOADERS[classType];
    if (layout) for(const [index,input] of layout.slice(1).entries()) addModel(input,node.widgets_values?.[index],[...path,'widgets_values',index],'known-loader-layout');
    else if (node.widgets_values?.some(modelFile)) warnings.push(`${classType}（节点 ${nodeId}）的控件顺序未验证；模型引用需要人工检查或导出 API JSON。`);
  };
  if (Array.isArray(document.nodes)) {
    const definitions=new Map((document.definitions?.subgraphs||[]).map((graph,index)=>[graph.id,{graph,index}]));
    const walk=(nodes,base,ancestors=new Set())=>{
      for(const [index,node] of nodes.entries()) {
        const graph=definitions.get(node.type);
        if(graph){if(ancestors.has(node.type)||ancestors.size>24)throw new WorkbenchError(400,'工作流子图存在循环或嵌套过深。');if(++count>2000)throw new WorkbenchError(400,'工作流展开超过 2000 个节点。');walk(graph.graph.nodes,['definitions','subgraphs',graph.index,'nodes'],new Set([...ancestors,node.type]));}
        else visit(node,String(node.id),[...base,index],true);
      }
    };walk(document.nodes,['nodes']);
  } else {
    const base=document.prompt?['prompt']:[];
    for(const [nodeId,node] of Object.entries(document.prompt||document)) if(node&&typeof node==='object')visit(node,nodeId,[...base,nodeId],false);
  }
  if (!count) throw new WorkbenchError(400,'工作流没有可识别的节点。');
  return {dependencies:[...dependencies.values()],warnings,nodeCount:count};
}

export function replaceWorkflowReferences(document,dependencies,replacements) {
  const next=structuredClone(document);
  for(const replacement of replacements) {
    const dependency=dependencies.find(item=>item.id===replacement.dependencyId&&item.kind==='model');
    if(!dependency||!modelFile(replacement.value)||replacement.value.split(/[\\/]/).includes('..')||/^[\\/]|^[A-Za-z]:/.test(replacement.value))throw new WorkbenchError(400,'请选择有效的模型依赖和相对文件名。');
    for(const reference of dependency.references){let node=next;for(const part of reference.path.slice(0,-1))node=node[part];node[reference.path.at(-1)]=replacement.value;}
  }
  return next;
}
