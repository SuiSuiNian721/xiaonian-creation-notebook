// One caption-format map shared by the browser and the workflow planner.
export const naturalCaptionTypes = new Set(['moss-image-lora', 'moss-image-anima-lora', 'flux-lora', 'flux-finetune', 'lumina-lora', 'anima-lora', 'anima-finetune', 'anima-lora-fast', 'sd3-lora', 'krea2-lora', 'ideogram4-lora', 'qwen-image-21-lora', 'klein-4b-lora', 'klein-9b-lora', 'ai-toolkit-flux-lora', 'ai-toolkit-anima-lora', 'ai-toolkit-krea2-lora', 'ai-toolkit-ideogram4-lora', 'ai-toolkit-qwen-image-21-lora']);
export const modelPathKeys = ['pretrained_model_name_or_path', 'dit', 'dit_path', 'model_path', 'model_dir', 'diffsynth_model_dir', 'text_encoder_path', 'vae_path', 'text_encoder_tokenizer_path', 'model_config_dir', 'text_encoder', 'qwen3', 'vae', 'ae', 'clip_l', 't5xxl', 'gemma2', 'tokenizer_cache_dir', 'tokenizer_path', 'sft_dit_path'];
export function baseModelField(type,config={}){
  if(['krea2-lora','ideogram4-lora'].includes(type))return 'dit';
  if(type==='qwen-image-21-lora')return config.model_input_mode==='comfyui_files'?'dit_path':'diffsynth_model_dir';
  if(type==='moss-image-anima-lora')return config.model_input_mode==='comfyui_files'?'dit_path':'model_dir';
  if(type?.startsWith('ai-toolkit-')||type?.startsWith('klein-'))return config.model_input_mode==='single_file'?'dit_path':'model_path';
  return 'pretrained_model_name_or_path';
}
