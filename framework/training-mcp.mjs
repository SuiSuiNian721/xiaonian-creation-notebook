import {fields,identifier,object} from './contracts.mjs';

const string={type:'string'};
const definition=(name,description,properties={},required=[],write=false)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:!write,...(['training_start','training_workflow_start','training_quick_start','training_save_preset'].includes(name)?{idempotentHint:true}:{}),...(['training_stop','training_workflow_cancel','training_delete_preset'].includes(name)?{destructiveHint:true}:{})}});
export const TRAINING_TOOLS=[
  definition('training_status','读取 APP 内置训练内核状态、引擎和任务；不启动内核或训练。'),
  definition('training_types','读取内核快照的模型家族、六引擎矩阵与控制支持。source_required 需显式准备环境，训练前仍须预检。'),
  definition('training_schema','读取内置训练器的原始定义及解析后的完整参数分组、字段、默认值和条件；不执行训练。',{trainType:string},['trainType']),
  definition('training_saved_configs','只读列出本机训练器的已保存参数和历史任务配置。'),
  definition('training_presets','列出当前训练实例保存的参数预设，不启动内核。'),
  definition('training_save_preset','保存当前实例的完整参数预设。新建使用稳定presetId和revision=0；修改传当前revision，冲突先刷新。',{presetId:string,revision:{type:'integer'},name:string,config:{type:'object'}},['presetId','revision','name','config'],true),
  definition('training_delete_preset','删除当前实例的指定参数预设，必须提供当前版本；不删除训练产物。',{presetId:string,revision:{type:'integer'}},['presetId','revision'],true),
  definition('training_import_preset','解析JSON或TOML预设为参数，不保存、不启动训练。',{format:{type:'string',enum:['json','toml']},text:string},['format','text']),
  definition('training_export_preset','导出JSON或TOML预设内容，保留高级参数，移除密钥，不启动训练。',{format:{type:'string',enum:['json','toml']},name:string,config:{type:'object'}},['format','name','config']),
  definition('training_start_kernel','启动 APP 自己的内核，复用已配置的 Python/CUDA；不提交 GPU 任务。',{},[],true),
  definition('training_validate','校验完整训练配置；不提交训练。',{config:{type:'object'}},['config'],true),
  definition('training_preflight','运行环境预检，可能写入配置与缓存；不提交训练。',{config:{type:'object'}},['config'],true),
  definition('training_start','仅在用户明确要求开始训练时调用，会使用 GPU。必须先读取配置和类型；固定 requestId 重试，不确定时先查 submission 和 tasks，禁止换编号自动补交。',{requestId:string,config:{type:'object'}},['requestId','config'],true),
  definition('training_submission','读取持久化提交记录，核对 submitted/submitting/uncertain 状态。',{requestId:string},['requestId']),
  definition('training_tasks','列出当前工作台训练实例的任务。'),
  definition('training_task','读取指定任务的实际状态、ETA、日志、预览和产物；完成不代表画质验收。',{taskId:string},['taskId']),
  definition('training_stop','用户要求停止时终止指定任务及其缓存阶段；不保证保存当前步骤，不操作其他任务。',{taskId:string},['taskId'],true),
  definition('training_workflows','列出当前实例的一键打标与训练流程；不执行任务。'),
  definition('training_quick_start','用户要求软件内AI一键训练时调用，必须已连接训练模块AI。input提供sourcePath、goal、purpose(character/style/pose)、parameterMode(recommended/defaults)、可选cropMode(auto/none，默认none)。config提供model_train_type与底模路径，可从保存参数补齐同一底模组件。AI规划完整参数后自动打标及训练；固定requestId，不确定时先查流程，不能换编号重交。',{requestId:string,input:{type:'object'},config:{type:'object'}},['requestId','input','config'],true),
  definition('training_workflow','读取流程阶段、打标样本、任务编号与产物。',{workflowId:string},['workflowId']),
  definition('training_workflow_start','外部MCP AI自行提供完整配置时创建受管流程；软件内AI一键入口使用training_quick_start。input含sourcePath、goal、purpose(character/style/pose)、trigger、aiEnabled、mode(train/tag)、cropMode(auto/none，默认none)、captionFormat(auto/tags/natural)、captionPolicy及allowDownload。config复用完整训练参数。默认整图分桶，明确cropMode=auto才补裁切副本并重标。固定requestId，响应丢失先核对原流程。',{requestId:string,input:{type:'object'},config:{type:'object'}},['requestId','input'],true),
  definition('training_workflow_pause','暂停流程，当前已提交阶段完成后不再开启下一阶段。',{workflowId:string},['workflowId'],true),
  definition('training_workflow_resume','明确继续暂停或待处理流程；先核对已有提交，不重复开启任务。',{workflowId:string},['workflowId'],true),
  definition('training_workflow_cancel','取消当前流程并停止它自己的阶段任务；停止训练不保证保存当前步骤。',{workflowId:string},['workflowId'],true),
];

export async function trainingRpc(message,getService,enabled) {
  if(message?.id===undefined)return null;
  const reply=result=>({jsonrpc:'2.0',id:message?.id??null,result});
  try {
    if(!enabled())throw new Error('请先添加 LoRA 训练模块，并在对应训练实例中操作。');
    const {name,arguments:args={}}=message.params||{};
    const tool=TRAINING_TOOLS.find(item=>item.name===name);
    if(!tool)throw new Error('找不到此训练工具。');
    fields(args,Object.keys(tool.inputSchema.properties));
    for(const key of tool.inputSchema.required)if(args[key]===undefined)throw new Error('缺少参数：'+key);
    for(const [key,schema] of Object.entries(tool.inputSchema.properties))if(args[key]!==undefined){
      if(schema.type==='object')object(args[key],key);
      else if(schema.type==='integer'){if(!Number.isInteger(args[key])||args[key]<0)throw new Error(key+'需要非负整数。');}
      else if(['name','text'].includes(key)){if(typeof args[key]!=='string')throw new Error(key+'需要文字。');}
      else identifier(args[key],key);
      if(schema.enum&&!schema.enum.includes(args[key]))throw new Error(key+'不在允许选项内。');
    }
    const service=await getService();let result;
    if(name==='training_status')result=await service.state();
    else if(name==='training_types')result=await service.catalog();
    else if(name==='training_schema')result=await service.schema(args.trainType);
    else if(name==='training_saved_configs')result=await service.savedConfigs();
    else if(name==='training_presets')result=service.listPresets();
    else if(name==='training_save_preset')result=service.savePreset({id:args.presetId,revision:args.revision,name:args.name,config:args.config});
    else if(name==='training_delete_preset')result=service.deletePreset(args.presetId,{revision:args.revision});
    else if(name==='training_import_preset')result=service.importPreset(args);
    else if(name==='training_export_preset')result=service.exportPreset(args);
    else if(name==='training_start_kernel')result=await service.start();
    else if(name==='training_validate')result=await service.validate(args.config);
    else if(name==='training_preflight')result=await service.preflight(args.config);
    else if(name==='training_start')result=await service.submit(args);
    else if(name==='training_submission')result=await service.submission(args.requestId);
    else if(name==='training_tasks')result=await service.tasks();
    else if(name==='training_task')result=await service.task(args.taskId);
    else if(name==='training_stop')result=await service.stopTask(args.taskId);
    else if(name==='training_workflows')result=service.pipeline.list();
    else if(name==='training_quick_start')result=await service.quickStart(args);
    else if(name==='training_workflow')result=service.pipeline.get(args.workflowId);
    else if(name==='training_workflow_start')result=await service.pipeline.create(args);
    else if(name==='training_workflow_pause')result=await service.pipeline.pause(args.workflowId);
    else if(name==='training_workflow_resume')result=await service.pipeline.resume(args.workflowId);
    else if(name==='training_workflow_cancel')result=await service.pipeline.cancel(args.workflowId);
    return reply({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
  } catch(error) {return reply({isError:true,content:[{type:'text',text:error.message}]});}
}
