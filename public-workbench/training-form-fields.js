const forbidden=new Set(['__proto__','prototype','constructor']);
const labels={
  pretrained_model_name_or_path:'底模路径',text_encoder:'文本编码器',qwen3:'Qwen3 编码器',clip_l:'CLIP-L',t5xxl:'T5 编码器',vae:'VAE',tokenizer_cache_dir:'Tokenizer 目录',
  train_data_dir:'训练集目录',reg_data_dir:'正则化图集',prior_loss_weight:'先验损失权重',resolution:'训练分辨率',enable_bucket:'宽高比分桶',min_bucket_reso:'最小分桶分辨率',max_bucket_reso:'最大分桶分辨率',bucket_reso_steps:'分桶步长',bucket_no_upscale:'分桶不放大',
  output_name:'输出名称',output_dir:'输出目录',save_model_as:'保存格式',save_precision:'保存精度',save_every_n_epochs:'保存间隔（轮）',save_every_n_steps:'保存间隔（步）',save_state:'保存训练状态',save_last_n_epochs_state:'保留状态轮数',
  max_train_epochs:'训练轮数',max_train_steps:'训练步数',train_batch_size:'批量大小',gradient_checkpointing:'梯度检查点',gradient_accumulation_steps:'梯度累加',network_train_unet_only:'仅训练主模型',network_train_text_encoder_only:'仅训练文本编码器',
  learning_rate:'学习率',unet_lr:'主模型学习率',text_encoder_lr:'文本编码器学习率',lr_scheduler:'学习率调度器',lr_warmup_steps:'预热步数',loss_type:'损失函数',lr_scheduler_num_cycles:'调度重启次数',optimizer_type:'优化器',min_snr_gamma:'最小信噪比',optimizer_args_custom:'优化器自定义参数',
  network_module:'网络模块',network_weights:'已有 LoRA 权重',network_dim:'LoRA Rank',network_alpha:'LoRA Alpha',network_dropout:'LoRA Dropout',network_args_custom:'网络自定义参数',
  moss_max_token_length:'MOSS 文本长度',timestep_sampling:'时间步采样',discrete_flow_shift:'时间步位移',sigmoid_scale:'Sigmoid 缩放',blocks_to_swap:'CPU 交换层数',convrot_int8:'DiT INT8',convrot_int8_text_encoder:'文本编码器 INT8',convrot_int8_bwd:'INT8 反向模式',
  enable_preview:'训练预览图',randomly_choice_prompt:'随机选择提示词',prompt_file:'提示词文件',positive_prompts:'正向提示词',negative_prompts:'反向提示词',sample_width:'预览宽度',sample_height:'预览高度',sample_cfg:'预览 CFG',sample_seed:'预览种子',sample_steps:'预览步数',sample_sampler:'预览采样器',sample_every_n_epochs:'预览间隔（轮）',
  log_with:'日志工具',log_prefix:'日志前缀',log_tracker_name:'日志项目名称',logging_dir:'日志目录',wandb_api_key:'WandB 密钥',caption_extension:'标注扩展名',shuffle_caption:'打乱标注',keep_tokens:'保留前置标签',keep_tokens_separator:'标签分隔符',caption_dropout_rate:'整段标注丢弃率',caption_dropout_every_n_epochs:'标注丢弃间隔',caption_tag_dropout_rate:'标签丢弃率',
  mixed_precision:'训练精度',no_half_vae:'VAE 全精度',sdpa:'SDPA',lowram:'低内存模式',cache_latents:'缓存 VAE 潜变量',cache_latents_to_disk:'潜变量写入磁盘',cache_text_encoder_outputs:'缓存文本编码',cache_text_encoder_outputs_to_disk:'文本编码写入磁盘',persistent_data_loader_workers:'保留数据加载进程',vae_batch_size:'VAE 缓存批量',
  color_aug:'颜色增强',flip_aug:'翻转增强',random_crop:'随机裁切',seed:'随机种子',clip_skip:'CLIP 跳层',ui_custom_params:'原始参数覆盖',ddp_timeout:'分布式超时',ddp_gradient_as_bucket_view:'分布式梯度视图',
  training_task:'训练任务',training_duration_mode:'训练时长',preview_samples:'预览样例',control_data_dirs:'参考图目录',input_data_dirs:'输入图目录',
  model_input_mode:'模型输入方式',epochs:'训练轮数',num_epochs:'训练轮数',max_steps:'训练步数上限',rank:'LoRA Rank',alpha:'LoRA Alpha',lr:'学习率',grad_checkpointing:'梯度检查点',
  prodigy_d0:'Prodigy 初始估计',prodigy_d_coef:'Prodigy 估计系数',conv_dim:'卷积层 Rank',conv_alpha:'卷积层 Alpha',
  sample_every_n_steps:'预览间隔（步）',sample_at_first:'训练前生成预览',sample_enabled:'训练预览图',dataset_repeats:'数据集重复次数',max_grad_norm:'梯度裁剪阈值',
  model_path:'模型目录',dit_path:'DiT 权重',text_encoder_path:'文本编码器',vae_path:'VAE',model_config_dir:'模型配置目录',text_encoder_tokenizer_path:'文本编码配置目录',
  model_variant:'模型版本',quantize:'模型量化',quantize_te:'文本编码器量化',qtype:'量化精度',low_vram:'低显存模式',layer_offloading:'模型层卸载',
};

export const fieldLabel=field=>labels[field.key]||field.description?.split(/\s+\/\s+|[。；;（(：:，,]/)[0].trim().slice(0,30)||field.key;
export const conditionsMatch=(conditions,config)=>(conditions||[]).every(({key,value})=>Object.hasOwn(config,key)&&config[key]===value);

const explanations={
  gradient_checkpointing:'反向传播时重算部分中间结果，降低显存占用，代价是训练变慢。',
  gradient_accumulation_steps:'连续累积多个批次的梯度再更新一次参数；单卡有效批量约等于批量大小乘以此值。',
  train_batch_size:'每次前向计算同时处理的图片数；增大会提高显存需求。',
  learning_rate:'控制每次参数更新的幅度；过大容易不稳定，过小学习较慢。',
  optimizer_type:'选择如何根据梯度更新权重；不同优化器的显存占用和学习率习惯不同。',
  lr_scheduler:'决定学习率随训练进度保持不变、衰减或周期性重启。',
  lr_warmup_steps:'训练开始时逐渐提高学习率的更新步数；0 表示不预热。',
  lr_scheduler_num_cycles:'周期性学习率调度的重复次数；只对支持周期的调度器生效。',
  loss_type:'选择训练预测与目标之间的误差计算方式。',
  network_dim:'LoRA 低秩矩阵的维度；增大可提高容量，也增加模型体积和训练开销。',
  network_alpha:'LoRA 更新的缩放系数，通常与 Rank 一起设置；不是额外的 Rank。',
  network_module:'训练时使用的网络实现；会影响 LoRA 权重结构与可用选项。',
  network_weights:'加载已有 LoRA 作为起点；只加载权重通常不会恢复优化器进度。',
  network_train_unet_only:'只更新主图像模型对应的 LoRA，不训练文本编码器 LoRA。',
  network_train_text_encoder_only:'只更新文本编码器对应的 LoRA，不训练主图像模型 LoRA。',
  network_dropout:'训练时随机丢弃部分网络激活，帮助抑制过拟合；0 表示关闭。',
  rank_dropout:'训练时随机停用部分低秩维度；0 表示关闭。',
  lycoris_algo:'选择 LyCORIS 的低秩或分解算法；不同算法使用不同网络参数。',
  enable_base_weight:'训练前合并指定基础权重，用于相对既有权重学习差异。',
  block_lr_zero_threshold:'低于此阈值的分层学习率会被置为 0，对应层停止更新。',
  use_cp:'对适用网络使用 CP 分解，以调整卷积权重的分解方式。',
  use_scalar:'为网络更新增加一个可训练的整体缩放系数。',
  decompose_both:'同时分解输入与输出侧矩阵，改变适用网络的参数量与结构。',
  dora_wd:'将权重更新拆分为幅度与方向，使用 DoRA 的训练方式。',
  use_ema:'维护训练权重的指数移动平均，用于平滑参数变化。',
  pretrained_model_name_or_path:'训练使用的基础模型位置；须与当前训练类型匹配。',
  train_data_dir:'训练图片和标注的来源目录；目录组织方式由当前引擎决定。',
  dataset_base_path:'解析元数据中图片相对路径时使用的根目录。',
  dataset_repeats:'每轮重复使用数据集的次数；与目录自带重复次数的关系由引擎决定。',
  prior_loss_weight:'正则化图集损失相对于训练图集损失的权重。',
  resolution:'训练图像的目标分辨率或像素预算；启用分桶后保留不同宽高比。',
  enable_bucket:'将相近宽高比的图片分到同一批次，减少为统一形状进行的裁切。',
  min_bucket_reso:'允许创建的分桶最小边长；须符合当前引擎的分桶步长。',
  max_bucket_reso:'允许创建的分桶最大边长；限制极端长宽图片的桶尺寸。',
  bucket_reso_steps:'相邻分桶尺寸的间隔；越小形状选择越细，也会生成更多桶。',
  bucket_no_upscale:'分桶时不放大原图，避免低分辨率图片被强行拉大。',
  caption_extension:'与训练图片同名的标注文件后缀，通常为 .txt。',
  shuffle_caption:'训练时随机打乱标签顺序，减少模型对固定顺序的依赖。',
  caption_tag_dropout_rate:'训练时随机省略部分标签的概率；0 表示保留所有标签。',
  max_token_length:'文本编码时保留的最大 token 数；更长标注可能需要更多显存。',
  color_aug:'训练时随机改变图片颜色；会改变模型看到的配色。',
  flip_aug:'训练时随机水平翻转图片；有左右特征的角色需谨慎启用。',
  random_crop:'训练时随机选择裁切区域，增加图像位置变化。',
  clip_skip:'选择 CLIP 文本编码器跳过的末端层数；应与底模的训练习惯一致。',
  max_train_epochs:'完整遍历训练数据的次数；每轮步数由数据量、批量与梯度累积决定。',
  max_train_steps:'达到指定优化器更新步数后结束训练。',
  training_duration_mode:'按完整遍历数据的轮数，或按参数更新步数控制训练时长。',
  seed:'控制随机过程的初始种子；同参数同环境下固定种子有助于比较结果。',
  output_dir:'训练权重和相关文件的保存目录。',
  save_model_as:'选择输出权重的文件格式，须与之后的加载工具兼容。',
  save_precision:'保存权重时采用的数值精度；不等同于训练计算精度。',
  save_state:'保存优化器等训练状态，便于按原进度恢复；会额外占用磁盘。',
  resume:'从已有训练状态恢复进度；与只加载 LoRA 权重不同。',
  enable_preview:'在训练过程中生成测试图片，观察学习效果；采样会增加耗时与显存需求。',
  positive_prompts:'生成训练预览图时使用的正向提示词。',
  negative_prompts:'生成训练预览图时希望减少的内容；仅支持反向提示词的模型生效。',
  randomly_choice_prompt:'从训练数据标注中随机选择预览提示词，观察不同内容。',
  sample_width:'生成预览图片的宽度，须符合当前模型的尺寸要求。',
  sample_height:'生成预览图片的高度，须符合当前模型的尺寸要求。',
  sample_cfg:'预览时提示词对生成结果的引导强度；适用范围取决于模型。',
  sample_steps:'生成每张预览图的采样迭代次数；越多通常越慢。',
  sample_seed:'预览采样的随机种子；固定后更容易比较不同训练阶段。',
  sample_sampler:'选择预览图的去噪采样算法；不会改变训练优化器。',
  sample_scheduler:'选择预览采样的噪声调度方式；不会改变训练学习率调度。',
  preview_samples:'逐组设置预览提示词、尺寸、种子和采样参数；Edit 模式还需参考图。',
  log_with:'选择记录训练指标的日志后端。',
  log_prefix:'给日志文件或记录名称添加前缀，方便区分训练任务。',
  log_tracker_name:'在日志后端显示的项目或追踪任务名称。',
  logging_dir:'保存训练日志与指标文件的目录。',
  wandb_api_key:'连接 WandB 日志服务使用的凭据；不影响本地训练算法。',
  mixed_precision:'训练计算采用的数值精度，影响显存、速度与数值稳定性。',
  full_fp16:'连同通常保留全精度的参数一起使用 FP16，降低精度与显存开销。',
  full_bf16:'连同通常保留全精度的参数一起使用 BF16；需要硬件支持。',
  no_half_vae:'让 VAE 使用全精度计算，减少半精度溢出，但会增加显存。',
  xformers:'使用 xFormers 注意力实现；需要当前训练环境安装兼容版本。',
  sdpa:'使用 PyTorch 的缩放点积注意力实现，由环境选择适合的内核。',
  cache_latents:'提前缓存图片的 VAE 编码结果，减少重复编码；与部分图像增强不兼容。',
  cache_latents_to_disk:'将图片编码缓存写入磁盘，可降低内存占用并在之后复用。',
  cache_text_encoder_outputs_to_disk:'将文本编码结果缓存到磁盘，减少重复编码计算。',
  vae_batch_size:'缓存 VAE 编码时每批处理的图片数；增大会提高显存占用。',
  text_encoder_batch_size:'缓存文本编码时每批处理的标注数；增大会提高显存占用。',
  persistent_data_loader_workers:'在轮次之间保留数据加载进程，减少重建开销；Windows 通常保持关闭。',
  max_data_loader_n_workers:'并行读取数据的进程数；更多进程也会占用更多内存。',
  ddp_timeout:'分布式训练等待其他进程响应的超时时间。',
  timestep_sampling:'选择训练时抽取噪声时间步的分布，决定不同噪声阶段的训练比例。',
  discrete_flow_shift:'移动 Flow Matching 的时间步分布，改变高低噪声样本的比例。',
  sigmoid_scale:'调整 Sigmoid 时间步采样分布的集中程度。',
  weighting_scheme:'选择不同时间步的损失权重或采样分布策略。',
  mode_scale:'调整 mode 时间步权重策略的强度。',
  flow_uniform_shift:'按图像分辨率调整 Flow 时间步的位置。',
  vae_disable_cache:'关闭 VAE 实现内部的缓存；与训练数据的 latent 缓存不是同一设置。',
  use_gradient_checkpointing_offload:'将梯度检查点相关数据卸载到系统内存，降低显存并增加传输开销。',
  fp8_base:'用 FP8 表示基础模型权重以节省显存；需要对应模型与硬件支持。',
  anima_debug_mode:'输出更详细的 Anima 诊断日志，便于排查训练问题。',
  enable_debug_options:'展开 Anima 的进阶诊断参数。',
  anima_rope_mismatch_mode:'控制旋转位置编码尺寸不匹配时的处理策略。',
  json_caption_hint:'向 Anima 提供 JSON 标注的格式说明或解读提示。',
  model_prediction_type:'指定模型预测的是噪声、速度或其他目标，须与底模匹配。',
  guidance_scale:'控制模型使用的条件引导强度，含义以当前模型实现为准。',
  train_t5xxl:'同时训练 T5XXL 文本编码器，会显著增加训练开销。',
  cfg_trunc:'设置 CFG 引导的截断范围，限制采样中的引导影响。',
  renorm_cfg:'对 CFG 引导后的结果重新归一化，调整引导带来的幅度变化。',
  system_prompt:'附加给文本编码模型的系统提示，用于定义标注解读方式。',
  max_grad_norm:'限制梯度范数，抑制过大的更新；是否允许 0 由当前引擎决定。',
  split_attn:'分块计算注意力以降低显存峰值，代价是速度可能变慢。',
};
for(const key of ['grad_checkpointing','use_gradient_checkpointing'])explanations[key]=explanations.gradient_checkpointing;
for(const key of ['lora_rank','rank'])explanations[key]=explanations.network_dim;
for(const key of ['lora_alpha','alpha'])explanations[key]=explanations.network_alpha;
for(const key of ['num_epochs','epochs'])explanations[key]=explanations.max_train_epochs;
for(const key of ['lr','unet_lr','text_encoder_lr','learning_rate_te','learning_rate_te1','learning_rate_te2','cross_attn_lr','self_attn_lr','mlp_lr','mod_lr','llm_adapter_lr'])explanations[key]='控制对应模型部分每次参数更新的幅度；与总学习率的关系以当前引擎为准。';
for(const key of ['t5_max_token_length','t5xxl_max_token_length','qwen3_max_token_length'])explanations[key]=explanations.max_token_length;
for(const key of ['qwen3','ae','vae','clip_l','t5xxl','gemma2'])explanations[key]='当前底模配套的编码器或 VAE 权重位置，须与所选模型版本匹配。';
explanations.dropout=explanations.network_dropout;explanations.flow_timestep_distribution=explanations.timestep_sampling;
export function fieldHelp(field){
  const native=field.description||'',extra=explanations[field.key];
  return [extra||native,extra&&native.length>35&&native!==extra?native:null,field.key].filter(Boolean).join('\n');
}

// The schema owns duration names and semantics. Only Kohya's epoch-only forms
// receive the existing workbench step-mode extension.
export function trainingDuration(form){
  const keys=new Set((form?.sections||[]).flatMap(section=>section.fields||[]).map(field=>field.key));
  if(keys.has('training_duration_mode'))return {kind:'discriminator',epochKey:'max_train_epochs',stepKey:'max_train_steps',modeKey:'training_duration_mode'};
  if(keys.has('epochs')&&keys.has('max_steps'))return {kind:'both',epochKey:'epochs',stepKey:'max_steps'};
  if(keys.has('num_epochs'))return {kind:'epochs',epochKey:'num_epochs'};
  if(keys.has('max_train_steps')&&!keys.has('max_train_epochs'))return {kind:'steps',stepKey:'max_train_steps'};
  if(keys.has('max_train_steps')&&keys.has('max_train_epochs'))return {kind:'both',epochKey:'max_train_epochs',stepKey:'max_train_steps'};
  if(!form||keys.has('max_train_epochs'))return {kind:'choice',epochKey:'max_train_epochs',stepKey:'max_train_steps'};
  return {kind:'none'};
}

export function normalizeTrainingDuration(form,config,{limitMode}={}){
  const result=structuredClone(config),duration=trainingDuration(form);
  const has=key=>result[key]!==undefined&&result[key]!==null&&result[key]!=='';
  if(duration.kind==='discriminator'){
    if(!['epoch','steps'].includes(result[duration.modeKey]))result[duration.modeKey]=has(duration.stepKey)&&!has(duration.epochKey)?'steps':'epoch';
    delete result[result[duration.modeKey]==='steps'?duration.epochKey:duration.stepKey];
  }else if(duration.kind==='steps')delete result.max_train_epochs;
  else if(duration.epochKey&&duration.epochKey!=='max_train_epochs'){
    delete result.max_train_epochs;delete result.max_train_steps;
  }else if(duration.kind==='choice'&&limitMode)delete result[limitMode==='steps'?duration.epochKey:duration.stepKey];
  return result;
}

export function trainingSubmission(form,config){
  const result=structuredClone(config),known=new Set(),active=new Set();
  for(const section of form?.sections||[])for(const field of section.fields||[]){
    known.add(field.key);
    if(conditionsMatch(section.conditions,config)&&conditionsMatch(field.conditions,config))active.add(field.key);
  }
  for(const key of known)if(key!=='model_train_type'&&!active.has(key))delete result[key];
  if(result.training_task!=='image-edit'&&Array.isArray(result.preview_samples))result.preview_samples=result.preview_samples.map(value=>{
    try{const sample=JSON.parse(value);return sample&&typeof sample==='object'&&!Array.isArray(sample)&&Object.hasOwn(sample,'controlImages')?JSON.stringify({...sample,controlImages:[]}):value;}catch{return value;}
  });
  return result;
}

// Keep this order and exact-value condition evaluation aligned with formDefaults
// in the server adapter. Explicit values, including false, null and '', win.
export function fillTrainingDefaults(form,config,{limitMode,omitted=new Set()}={}){
  const result=normalizeTrainingDuration(form,config,{limitMode}),fields=(form?.sections||[]).flatMap(section=>section.fields||[]),duration=trainingDuration(form);
  for(let pass=0;pass<=fields.length;pass++){
    let changed=false;
    for(const field of fields){
      if(forbidden.has(field.key)||field.key==='model_train_type'||Object.hasOwn(result,field.key)||omitted.has(field.key)||!conditionsMatch(field.conditions,result))continue;
      if(duration.kind==='choice'&&((limitMode==='steps'&&field.key===duration.epochKey)||(limitMode==='epochs'&&field.key===duration.stepKey)))continue;
      const value=field.type==='const'?field.constValue:field.defaultValue;
      if(value===undefined)continue;
      result[field.key]=structuredClone(value);changed=true;
    }
    if(!changed)break;
  }
  return result;
}

export function parseFieldValue(node,field){
  if(field.options){
    const optionIndex=node.selectedOptions[0]?.dataset.optionIndex;
    if(optionIndex===undefined)return undefined;
    const index=Number(optionIndex);
    if(!Number.isInteger(index)||!Object.hasOwn(field.options,index))throw new Error('请选择参数列表中的值。');
    return structuredClone(field.options[index]);
  }
  if(field.type==='boolean')return node.checked;
  if(field.type==='number'){
    if(node.validity.badInput)throw new Error('请输入有效数字。');
    if(node.value==='')return undefined;
    const value=node.valueAsNumber;
    if(!Number.isFinite(value))throw new Error('请输入有效数字。');
    if(field.min!==undefined&&value<field.min)throw new Error(`最小值为 ${field.min}。`);
    if(field.max!==undefined&&value>field.max)throw new Error(`最大值为 ${field.max}。`);
    if(node.validity.stepMismatch)throw new Error(`请按步长 ${field.step} 输入。`);
    return value;
  }
  if(field.type==='array'){
    const text=node.value.trim();let value;
    if(!text)return [];
    if(text.startsWith('[')||text.startsWith('{')){
      try{value=JSON.parse(text);}catch{throw new Error('数组 JSON 不完整，请检查引号、逗号和括号。');}
    }else{
      const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      value=lines.map(line=>field.itemType==='number'?Number(line):field.itemType==='boolean'?(line==='true'?true:line==='false'?false:line):line);
    }
    if(!Array.isArray(value))throw new Error('请输入 JSON 数组，或每行填写一个值。');
    if(field.itemType&&value.some(item=>typeof item!==field.itemType||(field.itemType==='number'&&!Number.isFinite(item))))throw new Error(`数组每项必须是 ${field.itemType==='number'?'数字':field.itemType==='boolean'?'true 或 false':'字符串'}。`);
    return value;
  }
  return node.value;
}

export function fallbackSections(config){
  const make=(key,type='string',extra={})=>({key,type,conditions:[],...extra});
  const moss=config.model_train_type==='moss-image-lora',anima=['anima-lora','sd3-lora','anima-finetune'].includes(config.model_train_type),flux=config.model_train_type?.startsWith('flux');
  const model=[make('pretrained_model_name_or_path','string',{required:true,role:'filepicker'})];
  if(moss)model.push(make('text_encoder','string',{required:true,role:'filepicker'}));
  if(anima)model.push(make('qwen3','string',{required:true,role:'filepicker'}));
  if(flux)model.push(make('clip_l','string',{role:'filepicker'}),make('t5xxl','string',{role:'filepicker'}));
  model.push(make('vae','string',{required:moss||anima,role:'filepicker'}));
  if(moss)model.push(make('tokenizer_cache_dir','string',{required:true,role:'filepicker'}));
  return [
    {id:'model',title:'训练用模型',conditions:[],fields:model},
    {id:'dataset',title:'数据集设置',conditions:[],fields:[make('train_data_dir','string',{required:true,role:'filepicker'}),make('resolution','string',{required:true})]},
    {id:'saving',title:'保存设置',conditions:[],fields:[make('output_name','string',{required:true}),make('output_dir','string',{required:true,role:'filepicker'})]},
    {id:'training',title:'训练设置',conditions:[],fields:[make('max_train_epochs','number',{min:1}),make('learning_rate','number',{step:'any',min:0}),make('network_dim','number',{min:1,step:1}),make('network_alpha','number',{min:1,step:'any'}),make('train_batch_size','number',{min:1,step:1}),make('mixed_precision','string',{options:['bf16','fp16','no']}),make('gradient_checkpointing','boolean')]},
  ];
}

export function displaySections(form,config){
  const sections=structuredClone(form?.sections||fallbackSections(config));
  if(trainingDuration(form).kind!=='choice')return sections;
  const fields=sections.flatMap(section=>section.fields||[]);
  let limitSection=sections.find(section=>section.fields.some(field=>['max_train_epochs','max_train_steps'].includes(field.key)));
  if(!limitSection){limitSection={id:'host-limit',title:'训练时长',conditions:[],fields:[]};sections.push(limitSection);}
  for(const key of ['max_train_epochs','max_train_steps'])if(!fields.some(field=>field.key===key))limitSection.fields.push({key,type:'number',conditions:[],min:1,step:1,description:key==='max_train_steps'?'训练达到指定优化器更新步数后停止。':'完整遍历训练数据的次数。'});
  return sections;
}

export function clearModelComponents(config,form){
  const result=structuredClone(config);
  const sharedPaths=new Set(['train_data_dir','reg_data_dir','output_dir','logging_dir','dataset_config','sample_prompts','prompt_file']);
  const modelKeys=new Set(['pretrained_model_name_or_path','text_encoder','vae','tokenizer_cache_dir','qwen3','clip_l','t5xxl','network_weights','network_module']);
  for(const field of (form?.sections||[]).flatMap(section=>section.fields||[])){
    if((field.role==='filepicker'&&field.extra?.type==='model-file')||(field.type==='const'&&field.key!=='model_train_type'))modelKeys.add(field.key);
  }
  for(const key of modelKeys)if(!sharedPaths.has(key))delete result[key];
  return result;
}
