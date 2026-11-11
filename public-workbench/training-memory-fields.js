const definitions={
  gradient_accumulation_steps:{label:'梯度累积',description:'累积多个微批次后更新一次权重。增大可提高有效批量，通常会延长每次更新的时间。'},
  gradient_checkpointing:{label:'梯度检查点',description:'反向传播时重新计算部分激活，以训练速度换取更低的显存占用。'},
  use_gradient_checkpointing:{label:'梯度检查点',description:'反向传播时重新计算部分激活，以训练速度换取更低的显存占用。'},
  grad_checkpointing:{label:'梯度检查点',description:'反向传播时重新计算部分激活，以训练速度换取更低的显存占用。'},
  use_gradient_checkpointing_offload:{label:'检查点转移到内存',description:'将检查点数据转移到系统内存，减少显存占用，但会增加传输开销。'},
  initialize_model_on_cpu:{label:'在 CPU 初始化模型',description:'先在系统内存中加载模型，降低初始化阶段的显存峰值。'},
  enable_model_cpu_offload:{label:'模型卸载到 CPU',description:'将暂时不用的模型部分放到系统内存，降低显存占用并增加传输时间。'},
};
export const memoryOptionKeys=Object.keys(definitions);
export function memoryFields(form){
  const seen=new Set();
  return (form?.sections||[]).flatMap(section=>section.fields||[]).filter(field=>Object.hasOwn(definitions,field.key)&&!field.hidden&&!field.disabled&&!seen.has(field.key)&&seen.add(field.key)).map(field=>({...field,...definitions[field.key]}));
}
export function normalizeMemoryOptions(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('显存选项格式无效。');
  const result={};
  for(const [key,item] of Object.entries(value)){
    if(!Object.hasOwn(definitions,key))throw new Error('不支持的显存选项：'+key);
    if(key==='gradient_accumulation_steps'?!Number.isSafeInteger(item)||item<1:typeof item!=='boolean')throw new Error(definitions[key].label+'的值无效。');
    result[key]=item;
  }
  return result;
}
export function applyMemoryOptions(form,config,value={}){
  const options=normalizeMemoryOptions(value),fields=memoryFields(form),result={...config,...options};
  for(const [key,item] of Object.entries(options)){
    const field=fields.find(field=>field.key===key);
    if(!field)throw new Error('当前训练器不支持显存选项 '+key+'。');
    if((field.conditions||[]).some(condition=>result[condition.key]!==condition.value))throw new Error(field.label+'的前置选项未启用。');
    if(field.options&&!field.options.includes(item)||typeof item==='number'&&(item<(field.min??1)||item>(field.max??Number.MAX_SAFE_INTEGER)))throw new Error(field.label+'超出训练器允许的范围。');
  }
  return result;
}
