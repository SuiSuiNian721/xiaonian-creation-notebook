import {fields,WorkbenchError} from './contracts.mjs';
import {moduleDefinitions,moduleDefinition} from './registry.mjs';

const string={type:'string'},boolean={type:'boolean'},record={type:'object'};
const object=properties=>({type:'object',properties,additionalProperties:false});
const tool=(moduleIds,name,description,properties={},required=[],readOnlyHint=false)=>({moduleIds,name,description,inputSchema:{...object(properties),required},annotations:{readOnlyHint}});
const drawing=['drawing','comfyui'],skin=['mc-skin'],taskModules=[...drawing,'training',...skin];
const resource=(...args)=>tool(drawing,...args);
const skinTool=(...args)=>tool(skin,...args);
const kinds={drawing:['drawing','completion','download','management'],comfyui:['download','management'],training:['training','training-workflow'],'mc-skin':['skin']};
const kind={type:'string',enum:[...new Set(Object.values(kinds).flat())]};

// Only named adapters enter this table. No arbitrary HTTP route, method or filesystem
// path can be dispatched by an agent. Services retain validation and persistence.
export const MODULE_TOOLS=[
  tool(moduleDefinitions.map(item=>item.id),'workbench_module_state','读取所选实例的当前状态。模块能力范围以 workbench_tools 为准；不会连接外部服务或开始生成。',{},[],true),
  tool(taskModules,'workbench_tasks','列出当前实例的任务、类型和原始任务数据。可按 kind 筛选；无法读取的任务类型列在 unavailable 中。',{kind},[],true),
  tool(taskModules,'workbench_task','查询指定类型与编号的任务和产物。refresh=true 时核实绘图远端进度。',{kind,id:string,refresh:boolean},['kind','id'],true),
  tool(taskModules,'workbench_task_cancel','停止指定任务。download 类型暂停并保留续传；管理安装任务不支持取消。不会停止其他实例的任务。',{kind,id:string},['kind','id']),
  resource('comfy_manager_state','读取模型库存、下载、环境任务和快照记录。',{},[],true),
  resource('comfy_inventory','扫描本地 ComfyUI 的模型、节点仓库及 Git 状态。',{},[],true),
  resource('comfy_manager_plan','预览节点安装、更新、启停、依赖安装或快照恢复计划。先展示 changes 和 warnings；不执行安装。',{operation:{type:'string',enum:['install-plugin','update','disable-plugin','enable-plugin','dependencies','restore']},url:string,name:string,repositoryId:string,revision:string,snapshotId:string},['operation'],true),
  resource('comfy_manager_apply','用户确认具体计划后应用 planId。要求 ComfyUI 已退出，先保存快照，不执行 install.py；依赖安装单独预览确认。',{planId:string},['planId']),
  resource('comfy_manager_logs','读取管理任务进度和日志。',{id:string},['id'],true),
  resource('comfy_snapshot_create','创建环境快照，保存配置、Git 状态与依赖清单；不备份模型或 Python 环境。',{name:string}),
  resource('comfy_snapshot_get','读取快照详情。',{id:string},['id'],true),
  resource('comfy_download_start','按明确选择的模型直链下载，校验 SHA256，不覆盖同名文件。重试沿用 requestId。缺少预期 sha256 时只计算实际哈希。',{requestId:string,url:string,category:string,filename:string,sha256:string},['requestId','url','category','filename']),
  resource('comfy_download_get','读取下载进度、实际 SHA256、验证状态和本地路径。',{id:string},['id'],true),
  resource('comfy_download_pause','暂停指定模型下载，保留续传资料。',{id:string},['id']),
  resource('comfy_download_resume','继续指定下载；restart=true 会重新下载该任务。',{id:string,restart:boolean},['id']),
  resource('comfy_runtime_state','读取启动设置、支持字段、环境诊断和进程状态。',{},[],true),
  resource('comfy_runtime_settings','保存启动设置，先从 comfy_runtime_state.fields 读取支持项与类型。',{settings:record},['settings']),
  resource('comfy_runtime_diagnose','用已选 Python 检查 ComfyUI 环境和启动参数。',{},[],true),
  resource('comfy_runtime_launch','按当前设置启动本地 ComfyUI；已有服务可用时只连接。'),
  resource('comfy_runtime_logs','读取 ComfyUI 启动日志。',{},[],true),
  resource('comfy_runtime_stop_preview','检查进程身份并预览停止范围，不结束进程。',{},[],true),
  resource('comfy_runtime_stop_confirm','用户确认预览的停止范围后，用两分钟内的 token 停止已核实的进程。',{token:string},['token']),
  skinTool('skin_state','读取皮肤制作环境、模板和已有作品。',{},[],true),
  skinTool('skin_check','重新检查 Python/Pillow 与像素制作规则，不生成皮肤。',{},[],true),
  skinTool('skin_upload','上传参考图或原皮肤；base64 仅含文件内容，kind=skin 时提供 slim/classic 模型。MCP 请求上限 2 MiB，大图请在界面上传。',{fileName:string,base64:string,kind:{type:'string',enum:['reference','skin']},model:{type:'string',enum:['slim','classic']}},['fileName','base64','kind']),
  skinTool('skin_import_configured','导入当前实例已配置的皮肤 PNG，保留原文件。',{model:{type:'string',enum:['slim','classic']}},['model']),
  skinTool('skin_generate','明确开始制作皮肤。固定 requestId 重试，返回任务编号后用 skin_job 查询，不自动另开任务。',{requestId:string,name:string,instruction:string,model:{type:'string',enum:['slim','classic']},eyeTemplate:{type:['string','null'],enum:['eye_A','eye_B',null]},referenceIds:{type:'array',items:string},sourceId:{type:['string','null']},parentId:{type:['string','null']},characterId:{type:['string','null']}},['requestId','name','instruction','model','eyeTemplate']),
  skinTool('skin_job','读取作品状态、版本、像素校验结果及产物地址。',{id:string},['id'],true),
  skinTool('skin_cancel','取消指定皮肤任务，保留已有版本。',{id:string},['id']),
  skinTool('skin_approve','用户确认成品后，将指定完成版本标记为已确认。',{id:string},['id']),
];

function currentModule(context,definition){
  const identity=context.store.getSetting('instance.identity');
  if(identity){if(!definition.moduleIds.includes(identity.moduleId))throw new WorkbenchError(409,'这个工具不属于当前模块。');return identity.moduleId;}
  const enabled=definition.moduleIds.filter(id=>context.store.module(id).enabled);
  if(enabled.length!==1)throw new WorkbenchError(409,'请明确选择一个模块实例。');
  return enabled[0];
}
function taskKinds(moduleId,requested){
  const supported=kinds[moduleId]||[];
  if(requested&&!supported.includes(requested))throw new WorkbenchError(409,'当前模块不支持这个任务类型。');
  return requested?[requested]:supported;
}
function taskRecord(context,kind,task,id){
  return {instanceId:context.store.getSetting('instance.identity')?.id??null,kind,id:id??task.id,status:task.status??task.stage??task.task?.status??'unknown',task};
}
async function tasks(context,moduleId,requested){
  const result={tasks:[],unavailable:[]};
  for(const kind of taskKinds(moduleId,requested)){
    try{
      let items;
      if(kind==='drawing')items=context.drawing.jobs();
      else if(kind==='completion')items=context.drawingCompletion.list();
      else if(kind==='download')items=context.drawingManager.downloads.list();
      else if(kind==='management')items=context.drawingManager.state().tasks;
      else if(kind==='skin')items=context.mcSkin.jobs();
      else {const training=await context.ensureTraining();items=kind==='training'?(await training.tasks()).tasks:training.pipeline.list().jobs;}
      result.tasks.push(...items.map(task=>taskRecord(context,kind,task)));
    }catch(error){result.unavailable.push({kind,error:error.message});}
  }
  return result;
}
async function task(context,moduleId,args,cancel=false){
  taskKinds(moduleId,args.kind);const {kind,id}=args;let result;
  if(kind==='drawing')result=cancel?await context.drawing.cancel(id):args.refresh?await context.drawing.syncJob(id):context.drawing.publicJob(context.drawing.job(id));
  else if(kind==='completion')result=cancel?await context.drawingCompletion.cancel(id):context.drawingCompletion.get(id);
  else if(kind==='download')result=cancel?await context.drawingManager.downloads.pause(id):context.drawingManager.downloads.get(id);
  else if(kind==='management'){
    result=context.drawingManager.state().tasks.find(item=>item.id===id);
    if(!result)throw new WorkbenchError(404,'找不到这个管理任务。');
    if(cancel)throw new WorkbenchError(409,'环境管理任务不支持取消，请查询日志并等待结束。');
  }else if(kind==='skin')result=cancel?context.mcSkin.cancel(id):context.mcSkin.job(id);
  else {const training=await context.ensureTraining();result=kind==='training'?(cancel?await training.stopTask(id):await training.task(id)):(cancel?await training.pipeline.cancel(id):training.pipeline.get(id));}
  return taskRecord(context,kind,result,id);
}

// State discovery does not publish connection credentials or complete character cards.
function publicState(value){
  if(Array.isArray(value))return value.map(publicState);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:api[-_]?key|(?:access|refresh|external|web|onebot)?[-_]?token|authorization|password|secret|credentials|headers)$/i.test(key)).map(([key,item])=>[key,publicState(item)]));
  if(typeof value==='string'&&/^https?:\/\//i.test(value)){try{const url=new URL(value);url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(/key|token|secret|signature/i.test(key))url.searchParams.delete(key);return url.href;}catch{}}
  return value;
}
async function moduleState(context,moduleId){
  const identity=context.store.getSetting('instance.identity'),selected=context.store.getSetting('selectedCharacterId');
  const character=selected?context.store.character(selected):null;
  let state={};
  if(moduleId==='drawing')state=context.drawing.state();
  else if(moduleId==='comfyui')state={runtime:await context.drawing.runtime.state(),manager:context.drawingManager.state()};
  else if(moduleId==='training')state=await (await context.ensureTraining()).state();
  else if(moduleId==='mc-skin')state=await context.mcSkin.state();
  else if(['voice','voice-design'].includes(moduleId))state=context.voiceStudio.state({owner:context.voiceOwner});
  else if(moduleId==='companion')state=context.companion.state();
  else if(moduleId==='companion-lite')state=context.liteCompanion.state();
  else if(moduleId==='mc-play')state=context.minecraft.state();
  else if(moduleId==='qq')state=context.ensureQQ().state();
  else if(moduleId==='cards')state={running:!!context.cardStudio.upstreamUrl,editorUrl:'/card-studio/'};
  return publicState({moduleId,name:moduleDefinition(moduleId).name,instanceId:identity?.id??null,selectedCharacter:character?{id:character.id,name:character.name,revision:character.revision}:null,state});
}

export async function callModuleTool(name,args,context){
  const definition=MODULE_TOOLS.find(item=>item.name===name);
  if(!definition)throw new WorkbenchError(404,'找不到这个模块工具。');
  fields(args,Object.keys(definition.inputSchema.properties));
  for(const key of definition.inputSchema.required)if(args[key]===undefined)throw new WorkbenchError(400,'缺少参数：'+key);
  const moduleId=currentModule(context,definition),drawing=context.drawing,manager=context.drawingManager,skin=context.mcSkin;
  switch(name){
    case 'workbench_module_state':return moduleState(context,moduleId);
    case 'workbench_tasks':return tasks(context,moduleId,args.kind);
    case 'workbench_task':return task(context,moduleId,args);
    case 'workbench_task_cancel':return task(context,moduleId,args,true);
    case 'comfy_manager_state':return manager.state();
    case 'comfy_inventory':return manager.inventory();
    case 'comfy_manager_plan':return manager.plan(args);
    case 'comfy_manager_apply':return manager.apply(args);
    case 'comfy_manager_logs':return manager.logs(args.id);
    case 'comfy_snapshot_create':return manager.snapshot(args);
    case 'comfy_snapshot_get':return manager.snapshotById(args.id);
    case 'comfy_download_start':return manager.downloads.start(args);
    case 'comfy_download_get':return manager.downloads.get(args.id);
    case 'comfy_download_pause':return manager.downloads.pause(args.id);
    case 'comfy_download_resume':return manager.downloads.resume(args.id,args.restart===undefined?{}:{restart:args.restart});
    case 'comfy_runtime_state':return drawing.runtime.state();
    case 'comfy_runtime_settings':manager.assertIdle();drawing.runtime.saveSettings(args.settings);return drawing.runtime.state();
    case 'comfy_runtime_diagnose':return drawing.runtime.diagnose();
    case 'comfy_runtime_launch':{manager.assertIdle();const result=await drawing.launch();context.drawingStartup?.start({owned:result.starting===true});return result;}
    case 'comfy_runtime_logs':return drawing.runtime.logs();
    case 'comfy_runtime_stop_preview':return drawing.prepareStop();
    case 'comfy_runtime_stop_confirm':context.drawingStartup?.cancel();return context.instanceCoordination?context.instanceCoordination.run('stop',()=>drawing.confirmStop(args)):drawing.confirmStop(args);
    case 'skin_state':return skin.state();
    case 'skin_check':return skin.check();
    case 'skin_upload':return skin.upload(args);
    case 'skin_import_configured':return skin.importConfigured(args);
    case 'skin_generate':return skin.submit(args);
    case 'skin_job':return skin.job(args.id);
    case 'skin_cancel':return skin.cancel(args.id);
    case 'skin_approve':return skin.approve(args.id);
    default:throw new WorkbenchError(404,'找不到这个模块工具。');
  }
}
