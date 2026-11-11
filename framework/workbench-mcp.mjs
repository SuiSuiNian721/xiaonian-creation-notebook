import {DRAWING_TOOLS,drawingRpc} from './drawing-mcp.mjs';
import {TRAINING_TOOLS,trainingRpc} from './training-mcp.mjs';
import {MODULE_TOOLS,callModuleTool} from './module-mcp.mjs';
import {moduleDefinitions} from './registry.mjs';
import {scopeInstanceLinks} from './module-instances.mjs';

const string={type:'string'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const versions=['2025-06-18','2025-03-26'];
const management=(name,description,properties={},required=[],readOnly=true)=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:readOnly}});
const ROOT_TOOLS=[
  management('workbench_modules','发现工作台全部模块、接入状态和可用工具。'),
  management('workbench_instances','列出当前工作台模块实例和运行状态。'),
  management('workbench_instance_create','创建独立模块实例并启动；不启动外部模型或提交任务。',{moduleId:{type:'string',enum:moduleDefinitions.map(item=>item.id)},name:{type:'string',minLength:1,maxLength:120,pattern:'\\S'}},['moduleId'],false),
  management('workbench_instance_start','启动指定已有模块实例；不自动提交业务任务。',{instanceId:{type:'string',pattern:uuid.source}},['instanceId'],false),
  management('workbench_tools','查看全部工具或某个模块的工具及参数。',{moduleId:{type:'string',enum:moduleDefinitions.map(item=>item.id)}}),
];
const businessTools=[
  ...DRAWING_TOOLS.map(tool=>({...tool,moduleIds:['comfy_status','comfy_connect','comfy_nodes'].includes(tool.name)?['drawing','comfyui']:['drawing'],kind:'drawing'})),
  ...TRAINING_TOOLS.map(tool=>({...tool,moduleIds:['training'],kind:'training'})),
  ...MODULE_TOOLS.map(tool=>({...tool,kind:'module'})),
];
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Validate before resolving or invoking a service: coercion can turn a malformed
// cancellation, process action or nested selection into a different operation.
function validate(value,schema,path='arguments'){
  if(schema===true)return;
  if(schema===false)throw new Error(path+' 不允许提供。');
  const types=Array.isArray(schema.type)?schema.type:schema.type?[schema.type]:[];
  const matches=type=>type==='object'?isObject(value):type==='array'?Array.isArray(value):type==='null'?value===null:type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===type;
  if(types.length&&!types.some(matches))throw new Error(path+' 类型无效，需要 '+types.join(' / ')+'。');
  if(schema.enum&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))throw new Error(path+' 不在允许选项内。');
  if(Object.hasOwn(schema,'const')&&JSON.stringify(schema.const)!==JSON.stringify(value))throw new Error(path+' 值无效。');
  if(isObject(value)){
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw new Error(path+' 缺少必填字段 '+key+'。');
    for(const [key,item] of Object.entries(value)){
      if(Object.hasOwn(schema.properties||{},key))validate(item,schema.properties[key],path+'.'+key);
      else if(schema.additionalProperties===false)throw new Error(path+' 包含未知字段 '+key+'。');
      else if(isObject(schema.additionalProperties))validate(item,schema.additionalProperties,path+'.'+key);
    }
  }
  if(Array.isArray(value)&&schema.items)value.forEach((item,index)=>validate(item,schema.items,path+'['+index+']'));
  if(typeof value==='string'){
    if(schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength)throw new Error(path+' 长度无效。');
    if(schema.pattern&&!new RegExp(schema.pattern).test(value))throw new Error(path+' 格式无效。');
  }
  if(typeof value==='number'&&(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))throw new Error(path+' 超出范围。');
}

function publishedTool(tool,requireInstance){
  const {moduleIds,kind,...definition}=tool;
  return {...definition,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,instanceId:{type:'string',pattern:uuid.source,description:'目标模块实例 UUID；从 workbench_instances 获取。'}},required:[...(tool.inputSchema.required||[]),...(requireInstance?['instanceId']:[])]}};
}

export function createWorkbenchRpc({store,instanceManager,context}){
  const identity=()=>store.getSetting('instance.identity');
  const availableTools=()=>businessTools.filter(tool=>!identity()||tool.moduleIds.includes(identity().moduleId));
  const listedTools=()=>[...ROOT_TOOLS.filter(tool=>instanceManager||tool.annotations.readOnlyHint),...availableTools().map(tool=>publishedTool(tool,!!instanceManager))];
  const legacyDrawing=tool=>tool.kind==='drawing'&&(!instanceManager||!instanceManager.list().length&&!instanceManager.db.prepare("SELECT value FROM metadata WHERE key='legacy-v1'").get());
  const callBusiness=async(tool,args)=>{
    const current=identity();
    const {instanceId,...businessArgs}=args;
    const execute=async(target,moduleId,id)=>{
      if(target.isClosing?.())throw new Error('目标模块实例正在停止，请稍后重试。');
      if(moduleId&&!tool.moduleIds.includes(moduleId))throw new Error('这个工具不属于目标模块实例。');
      if(moduleId&&!target.store.module(moduleId).enabled)throw new Error('目标模块已停用，请先在工作台启用。');
      let result;
      if(tool.kind==='module')result=await callModuleTool(tool.name,businessArgs,target);
      else {
        const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:businessArgs}};
        const response=tool.kind==='drawing'
          ?await drawingRpc(request,target.drawing,()=>target.store.module(moduleId||'drawing').enabled,target.drawingCompletion)
          :await trainingRpc(request,target.ensureTraining,()=>target.store.module('training').enabled);
        if(response.result.isError)throw new Error(response.result.content.map(item=>item.text||'').join('\n'));
        result=response.result.structuredContent??JSON.parse(response.result.content[0].text);
      }
      return id?scopeInstanceLinks(result,'/instances/'+id):result;
    };
    if(current){
      if(instanceId!==undefined&&instanceId!==current.id)throw new Error('传入实例与当前 MCP 入口不一致。');
      return execute(context,current.moduleId,current.id);
    }
    if(instanceId!==undefined){
      if(!instanceManager)throw new Error('当前入口不支持切换模块实例。');
      if(!uuid.test(instanceId))throw new Error('实例标识无效。');
      // Keep the same concurrency as the UI: long-running lookups must not hold
      // the lifecycle queue and prevent their cancellation tool from running.
      const record=instanceManager.record(instanceId);
      return execute(instanceManager.context(instanceId),record.moduleId,record.id);
    }
    if(instanceManager&&!legacyDrawing(tool))throw new Error('请提供 instanceId，先使用 workbench_instances 选择实例。');
    if(tool.kind==='module')throw new Error('请从对应模块实例调用此工具。');
    return execute(context,tool.kind==='drawing'?'drawing':tool.kind==='training'?'training':null);
  };

  return async message=>{
    const validId=message?.id===null||typeof message?.id==='string'||typeof message?.id==='number'&&Number.isFinite(message.id);
    const error=(code,text)=>({jsonrpc:'2.0',id:validId?message.id:null,error:{code,message:text}});
    if(!isObject(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||!message.method||Object.hasOwn(message,'id')&&!validId)return error(-32600,'无效 JSON-RPC 请求。');
    if(!Object.hasOwn(message,'id'))return null;
    const reply=result=>({jsonrpc:'2.0',id:message.id,result});
    if(message.params!==undefined&&!isObject(message.params))return error(-32602,'MCP 参数需要对象。');
    if(message.method==='initialize'){
      const requested=message.params?.protocolVersion;
      if(requested!==undefined&&typeof requested!=='string')return error(-32602,'协议版本需要文字。');
      return reply({protocolVersion:versions.includes(requested)?requested:versions[0],capabilities:{tools:{}},serverInfo:{name:'ai-future-workbench',version:'1.0.0'},instructions:'一个连接访问工作台。先用 workbench_modules 和 workbench_instances 发现模块与实例；根业务工具必须明确提供 instanceId，已停止实例需先启动。任务与页面共享状态，提交重试须保留 requestId。'});
    }
    if(message.method==='ping')return reply({});
    if(message.method==='tools/list')return reply({tools:listedTools()});
    if(message.method!=='tools/call')return error(-32601,'不支持此 MCP 方法。');
    if(typeof message.params?.name!=='string')return error(-32602,'缺少工具名称。');
    const {name,arguments:args={}}=message.params;
    try{
      const rootTool=ROOT_TOOLS.find(tool=>tool.name===name);
      const tool=rootTool||businessTools.find(tool=>tool.name===name);
      if(!tool)throw new Error('找不到此工具。');
      const requireInstance=!!instanceManager&&!(args.instanceId===undefined&&legacyDrawing(tool));
      validate(args,rootTool?tool.inputSchema:publishedTool(tool,requireInstance).inputSchema);
      let result;
      if(!rootTool)result=await callBusiness(tool,args);
      else if(name==='workbench_modules')result={modules:moduleDefinitions.map(({id,name})=>{
        const tools=availableTools().filter(tool=>tool.moduleIds.includes(id)&&(!identity()||identity().moduleId===id)).map(tool=>tool.name);
        return {id,name,available:tools.length>0,coverage:tools.some(name=>name!=='workbench_module_state')?'operations':tools.length?'state-only':'unavailable',tools};
      })};
      else if(name==='workbench_tools')result={tools:args.moduleId?availableTools().filter(tool=>tool.moduleIds.includes(args.moduleId)&&(!identity()||identity().moduleId===args.moduleId)).map(tool=>publishedTool(tool,!!instanceManager)):listedTools()};
      else if(name==='workbench_instances')result={instances:instanceManager?instanceManager.list():identity()?[{...identity(),status:'running'}]:[]};
      else {
        if(!instanceManager)throw new Error('实例创建和启动只能通过工作台根 MCP 入口操作。');
        const moduleId=name==='workbench_instance_create'?args.moduleId:instanceManager.record(args.instanceId).moduleId;
        await context.prepareInstances();
        await context.enableModule(moduleId);
        result={instance:name==='workbench_instance_create'?await instanceManager.create(args):await instanceManager.start(args.instanceId)};
      }
      return reply({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result});
    }catch(error){return reply({isError:true,content:[{type:'text',text:error.message}]});}
  };
}
