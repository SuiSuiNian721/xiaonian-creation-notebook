import { WorkbenchError, fields, text, object } from '../contracts.mjs';
import { cleanJSON, httpURL, MASK } from './settings.mjs';

export function normalizeTool(value, previous) {
  fields(value,['id','name','description','url','method','headers','inputSchema','enabled','kind','scope','createdAt','updatedAt','workflowId','promptField']);
  const tool={id:value.id??previous?.id,name:text(value.name,'工具名称',100),description:text(value.description??'','工具说明',1000,{empty:true}),url:value.kind==='drawing'?'workbench:drawing':httpURL(value.url,{empty:false}),method:value.method??'POST',headers:{},inputSchema:cleanJSON(value.inputSchema??{type:'object',properties:{}},'参数结构',50000),enabled:value.enabled===true,kind:value.kind??'http'};
  if(!['GET','POST'].includes(tool.method))throw new WorkbenchError(400,'工具请求方法只能是 GET 或 POST。');
  if(!['http','drawing','image-search','image-generate','vision','voice','qzone','balance'].includes(tool.kind))throw new WorkbenchError(400,'工具类型无效。');
  if(tool.kind==='drawing'){tool.workflowId=text(value.workflowId??previous?.workflowId??'','绘图工作流',128);tool.promptField=text(value.promptField??previous?.promptField??'','绘图提示词字段',200,{empty:true});}
  for(const [key,entry] of Object.entries(object(value.headers??{},'请求头'))){
    if(!/^[A-Za-z0-9-]+$/.test(key)||['host','content-length','connection','cookie'].includes(key.toLowerCase()))throw new WorkbenchError(400,'工具请求头不受支持。');
    const val=text(entry,'请求头内容',8000,{empty:true,trim:false});if(/[\r\n]/.test(val))throw new WorkbenchError(400,'请求头不能换行。');
    tool.headers[key]=val===MASK?previous?.headers?.[key]??'':val;
  }
  return tool;
}

export function publicTool(tool){return {...tool,headers:Object.fromEntries(Object.keys(tool.headers??{}).map(key=>[key,tool.headers[key]?MASK:'']))};}

function validateArguments(value,schema,path='参数',depth=0){
  if(depth>20)throw new WorkbenchError(400,'工具参数结构太深。');
  if(schema.enum&&!schema.enum.includes(value))throw new WorkbenchError(400,`${path}不在允许值内。`);
  if(schema.type==='object'){
    object(value,path);
    for(const key of schema.required??[])if(!(key in value))throw new WorkbenchError(400,`${path}缺少 ${key}。`);
    for(const [key,child] of Object.entries(value)){
      if(schema.additionalProperties===false&&!Object.hasOwn(schema.properties??{},key))throw new WorkbenchError(400,`${path}包含未知字段。`);
      if(schema.properties?.[key])validateArguments(child,schema.properties[key],`${path}.${key}`,depth+1);
    }
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length>(schema.maxItems??100))throw new WorkbenchError(400,`${path}数组无效。`);
    if(schema.items)value.forEach(item=>validateArguments(item,schema.items,path,depth+1));
  }else if(schema.type==='integer'||schema.type==='number'){
    if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isInteger(value))||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw new WorkbenchError(400,`${path}数字无效。`);
  }else if(schema.type==='string'){
    text(value,path,Math.min(schema.maxLength??12000,12000),{empty:true});
  }else if(schema.type==='boolean'&&typeof value!=='boolean')throw new WorkbenchError(400,`${path}开关无效。`);
}

export function validateToolArguments(args,schema){
  const input=cleanJSON(object(args??{},'工具参数'),'工具参数',64000);validateArguments(input,schema);return input;
}

export async function boundedResponse(response,maxBytes=2*1024*1024){
  if(!response.ok){await response.body?.cancel();throw new WorkbenchError(502,`服务返回 ${response.status}。`);}
  const chunks=[];let length=0;
  for await(const chunk of response.body??[]){length+=chunk.length;if(length>maxBytes)throw new WorkbenchError(502,'服务回复过大。');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString('utf8');
}

export async function invokeTool(tool,args,{fetchImpl=fetch,signal}={}){
  if(!tool?.enabled)throw new WorkbenchError(409,'请先启用这个工具。');
  const input=validateToolArguments(args,tool.inputSchema);
  const controller=new AbortController();const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timeout=setTimeout(abort,30000);
  try{
    const url=new URL(tool.url);let body;
    if(tool.method==='GET')for(const [key,value] of Object.entries(input))url.searchParams.set(key,typeof value==='string'?value:JSON.stringify(value));
    else body=JSON.stringify(input);
    const response=await fetchImpl(url,{method:tool.method,headers:{...(body?{'content-type':'application/json'}:{}),...tool.headers},body,signal:controller.signal,redirect:'error'});
    const content=await boundedResponse(response);try{return JSON.parse(content);}catch{return {text:content};}
  }catch(error){if(error instanceof WorkbenchError)throw error;throw new WorkbenchError(502,controller.signal.aborted?'工具调用已取消或超时。':'工具调用失败，请检查地址和连接。');}
  finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}

export async function embeddingFor(input,config,{fetchImpl=fetch,signal}={}){
  if(!config.enabled||!config.baseUrl||!config.model)return null;
  const result=await invokeTool({enabled:true,url:config.baseUrl.replace(/\/$/,'')+'/embeddings',method:'POST',headers:config.apiKey?{Authorization:'Bearer '+config.apiKey}:{},inputSchema:{type:'object'}},{model:config.model,input:String(input).slice(0,12000)},{fetchImpl,signal});
  const vector=result.data?.[0]?.embedding;
  if(!Array.isArray(vector)||!vector.length||vector.length>65536||vector.some(n=>typeof n!=='number'||!Number.isFinite(n)))throw new WorkbenchError(502,'向量服务返回格式无效。');
  return vector;
}
