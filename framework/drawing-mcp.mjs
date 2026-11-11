const object = properties => ({type:'object',properties,additionalProperties:false});
const string = {type:'string'};
export const DRAWING_TOOLS = [
  {name:'comfy_status',description:'查看工作台 ComfyUI 连接、工作流和任务；不自动连接。',inputSchema:object({}),annotations:{readOnlyHint:true}},
  {name:'comfy_connect',description:'连接工作台中已配置的 ComfyUI，读取实际节点定义。',inputSchema:object({})},
  {name:'comfy_nodes',description:'检索真实节点定义、输入和可选模型，最多返回 25 项。',inputSchema:object({query:string}),annotations:{readOnlyHint:true}},
  {name:'comfy_workflows',description:'列出工作台保存的工作流。',inputSchema:object({}),annotations:{readOnlyHint:true}},
  {name:'comfy_workflow_get',description:'读取工作流 API 节点图及可编辑参数。',inputSchema:{...object({id:string}),required:['id']},annotations:{readOnlyHint:true}},
  {name:'comfy_workflow_import',description:'导入工作流副本并校验节点。不会开始生成。',inputSchema:{...object({name:string,document:{type:'object'}}),required:['name','document']}},
  {name:'comfy_workflow_complete',description:'提取导入工作流的模型和节点依赖，检查本地与当前服务，建立持久报告。不会下载、安装或生成。重试沿用 requestId。',inputSchema:{...object({name:string,document:{type:'object'},requestId:string,explicitDirectories:{type:'array',items:object({path:string,category:string})}}),required:['document','requestId']},annotations:{readOnlyHint:true,idempotentHint:true}},
  {name:'comfy_completion_report',description:'读取工作流补全报告；省略 id 时列出记录，不扫描和联网。',inputSchema:object({id:string}),annotations:{readOnlyHint:true}},
  {name:'comfy_completion_search',description:'按预算查询所选依赖的 Civitai、Hugging Face 或 Comfy Registry 来源候选，不自动下载。',inputSchema:{...object({id:string,dependencyIds:{type:'array',items:string}}),required:['id']},annotations:{readOnlyHint:true}},
  {name:'comfy_completion_cancel',description:'取消工作流依赖检查，保留已得到结果。',inputSchema:{...object({id:string}),required:['id']}},
  {name:'comfy_completion_download',description:'仅在用户明确勾选候选后下载到已选本地 ComfyUI，不覆盖文件、不生成图片。',inputSchema:{...object({id:string,requestId:string,selections:{type:'array',items:object({dependencyId:string,candidateId:string,acceptUnverifiedHash:{type:'boolean'}})}}),required:['id','requestId','selections']},annotations:{readOnlyHint:false,idempotentHint:true}},
  {name:'comfy_completion_copy',description:'按明确选择替换模型引用并另存工作流副本，保留原工作流。',inputSchema:{...object({id:string,replacements:{type:'array',items:object({dependencyId:string,value:string})}}),required:['id','replacements']}},
  {name:'comfy_completion_node_plan',description:'预览 Registry 候选的 Git 节点安装计划；继续通过原资源管理器确认应用，不自动执行安装脚本。',inputSchema:{...object({id:string,dependencyId:string,candidateId:string}),required:['id','dependencyId','candidateId']}},
  {name:'comfy_generate',description:'明确提交绘图任务，会使用 GPU。requestId 为唯一 UUID，重试须沿用原值以避免重复提交。',inputSchema:{...object({requestId:string,workflowId:string,values:{type:'object'},characterId:{type:['string','null']}}),required:['requestId','workflowId']},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'comfy_job',description:'查询本工作台任务及图片地址，refresh=true 时核实远端历史。',inputSchema:{...object({id:string,refresh:{type:'boolean'}}),required:['id']},annotations:{readOnlyHint:true}},
  {name:'comfy_cancel',description:'取消指定工作台任务，不清空其他 ComfyUI 任务。',inputSchema:{...object({id:string}),required:['id']},annotations:{readOnlyHint:false,destructiveHint:true}},
];
export async function drawingRpc(message,drawing,enabled,completion){
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string')return {jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:'无效 JSON-RPC 请求。'}};
  const reply=result=>({jsonrpc:'2.0',id:message.id,result});
  if(message.id===undefined)return null;
  if(message.method==='initialize')return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'ai-future-comfyui',version:'0.5.0'},instructions:'工具访问工作台已配置的 ComfyUI。先查看状态，节点定义与模型以 comfy_nodes 实际返回为准。生成任务需要明确请求且不可自动重复提交。'});
  if(message.method==='ping')return reply({});
  if(message.method==='tools/list')return reply({tools:DRAWING_TOOLS});
  if(message.method!=='tools/call')return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'不支持此 MCP 方法。'}};
  const {name,arguments:args={}}=message.params||{};
  try{
    if(!enabled())throw new Error('请先在工作台添加角色绘图模块。');
    const tool=DRAWING_TOOLS.find(tool=>tool.name===name);if(!tool)throw new Error('找不到此工具。');
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(tool.inputSchema.properties,key))||(tool.inputSchema.required||[]).some(key=>args[key]===undefined))throw new Error('工具参数无效或缺少必填字段。');
    let result;
    if(name==='comfy_status')result=drawing.state();
    else if(name==='comfy_connect')result=await drawing.connect();
    else if(name==='comfy_nodes'){drawing.connected();const query=String(args.query||'').toLowerCase();result={nodes:Object.fromEntries(Object.entries(drawing.schema).filter(([name])=>name.toLowerCase().includes(query)).slice(0,25))};}
    else if(name==='comfy_workflows')result={workflows:drawing.workflows()};
    else if(name==='comfy_workflow_get')result=drawing.workflow(args.id);
    else if(name==='comfy_workflow_import')result=await drawing.importWorkflow(args);
    else if(name==='comfy_workflow_complete'){if(!completion)throw new Error('工作流补全服务未接入。');result=await completion.start(args);}
    else if(name==='comfy_completion_report'){if(!completion)throw new Error('工作流补全服务未接入。');result=args.id?completion.get(args.id):{reports:completion.list()};}
    else if(name==='comfy_completion_search'){if(!completion)throw new Error('工作流补全服务未接入。');result=await completion.search(args.id,args.dependencyIds?{dependencyIds:args.dependencyIds}:{});}
    else if(name==='comfy_completion_cancel'){if(!completion)throw new Error('工作流补全服务未接入。');result=await completion.cancel(args.id);}
    else if(name==='comfy_completion_download'){if(!completion)throw new Error('工作流补全服务未接入。');result=await completion.download(args.id,{requestId:args.requestId,selections:args.selections});}
    else if(name==='comfy_completion_copy'){if(!completion)throw new Error('工作流补全服务未接入。');result=await completion.copy(args.id,{replacements:args.replacements});}
    else if(name==='comfy_completion_node_plan'){if(!completion)throw new Error('工作流补全服务未接入。');result=await completion.planNode(args.id,{dependencyId:args.dependencyId,candidateId:args.candidateId});}
    else if(name==='comfy_generate')result=await drawing.submit({...args,characterId:args.characterId??null});
    else if(name==='comfy_job')result=args.refresh?await drawing.syncJob(args.id):drawing.publicJob(drawing.job(args.id));
    else if(name==='comfy_cancel')result=await drawing.cancel(args.id);
    return reply({content:[{type:'text',text:JSON.stringify(result)}]});
  }catch(error){return reply({isError:true,content:[{type:'text',text:error.message}]});}
}
