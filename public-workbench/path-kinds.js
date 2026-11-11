const directories=new Set(['train_data_dir','reg_data_dir','output_dir','logging_dir','tokenizer_cache_dir','model_config_dir','t5_tokenizer_path']);
const files=new Set(['dataset_config','sample_prompts','prompt_file']);
export function trainingPathKind(field,trainingType){
  if(field?.type==='array'&&field.itemType==='string'){
    if(field.role==='reference-paths')return 'directory';
    if(field.role==='preview-samples')return 'file';
  }
  if(!field||field.type!=='string')return null;
  if(field.extra?.type==='folder'||directories.has(field.key))return 'directory';
  if(field.role!=='filepicker'&&!files.has(field.key))return null;
  if(trainingType!=='moss-image-lora'&&['pretrained_model_name_or_path','qwen3'].includes(field.key))return 'model';
  if(field.extra?.type==='model-file'&&field.extra.filter?.includes('index.json'))return 'model';
  return 'file';
}
