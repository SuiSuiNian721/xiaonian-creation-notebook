// Optional real-service acceptance. Install the official SDK only in the QA folder:
// npm install --prefix artifacts/mcp-sdk --no-save --ignore-scripts @modelcontextprotocol/sdk
// node tools/qa-workbench-mcp.mjs <ComfyUI directory> <Python executable> <API workflow.json>
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkbench} from '../framework/server.mjs';

const [comfyPath,pythonPath,workflowFile]=process.argv.slice(2);
if(!comfyPath||!pythonPath||!workflowFile)throw new Error('请提供隔离 ComfyUI、Python 和验收工作流路径；本脚本会实际生成图片。');
const directory=resolve('artifacts/unified-mcp-qa');await mkdir(directory,{recursive:true});
const requireSdk=createRequire(resolve(process.env.MCP_SDK_ROOT||'artifacts/mcp-sdk','package.json'));
const sdk=async file=>import(pathToFileURL(requireSdk.resolve('@modelcontextprotocol/sdk/'+file)).href);
const {Client}=await sdk('client/index.js');
const {StdioClientTransport}=await sdk('client/stdio.js');
const {StreamableHTTPClientTransport}=await sdk('client/streamableHttp.js');
const backend=await createWorkbench({dataDir:join(directory,'data')});
backend.context.sharedAI.save({mcpEnabled:true});
const config=await fetch(backend.url+'/api/ai/mcp').then(response=>response.json());
const http=new Client({name:'workbench-acceptance-http',version:'1.0.0'});
const stdio=new Client({name:'workbench-acceptance-stdio',version:'1.0.0'});
const sdkPackage=resolve(dirname(requireSdk.resolve('@modelcontextprotocol/sdk/client/index.js')),'../../..','package.json');
const results={at:new Date().toISOString(),sdkVersion:JSON.parse(await readFile(sdkPackage,'utf8')).version};
async function call(client,name,args={}){
  const result=await client.callTool({name,arguments:args},undefined,{timeout:180000});
  assert.equal(result.isError,undefined,JSON.stringify(result));
  return result.structuredContent??JSON.parse(result.content[0].text);
}
const api=async(path,body,method='POST')=>{
  const response=await fetch(backend.url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.ok(response.ok,await response.clone().text());return response.json();
};
let instanceId;
try{
  await http.connect(new StreamableHTTPClientTransport(new URL(config.http.url),{requestInit:{headers:config.http.headers}}));
  await stdio.connect(new StdioClientTransport({...config.stdio,stderr:'pipe'}));
  const httpTools=await http.listTools(),stdioTools=await stdio.listTools();
  assert.deepEqual(httpTools.tools,stdioTools.tools);results.toolCount=httpTools.tools.length;
  results.modules=(await call(http,'workbench_modules')).modules.map(({id,coverage})=>({id,coverage}));
  const instance=(await call(http,'workbench_instance_create',{moduleId:'drawing',name:'统一 MCP 实际出图验收'})).instance;
  instanceId=instance.id;results.instanceId=instanceId;
  const scoped=(name,args={})=>call(http,name,{instanceId,...args});
  await api(`/instances/${instanceId}/api/modules/drawing/config`,{values:{comfyPath:resolve(comfyPath),serviceUrl:'http://127.0.0.1:8199'}},'PUT');
  await scoped('comfy_runtime_settings',{settings:{pythonPath:resolve(pythonPath)}});
  const portCheck=createServer();
  await new Promise((accept,reject)=>{portCheck.once('error',reject);portCheck.listen(8199,'127.0.0.1',accept);});
  await new Promise(accept=>portCheck.close(accept));
  await scoped('comfy_runtime_launch');
  let connected=false;
  for(let i=0;i<90&&!connected;i++){
    const response=await http.callTool({name:'comfy_connect',arguments:{instanceId}});
    connected=!response.isError;if(!connected)await delay(1000);
  }
  assert.ok(connected,'ComfyUI 未就绪');
  const document=JSON.parse(await readFile(resolve(workflowFile),'utf8'));
  for(const node of Object.values(document))if(node.class_type==='SaveImage')node.inputs.filename_prefix='unified_mcp_qa';
  const missing=structuredClone(document);
  const loader=Object.values(missing).find(node=>node.class_type==='VAELoader');assert.ok(loader);
  loader.inputs.vae_name='__missing_mcp_acceptance_vae__.safetensors';
  missing['missing-mcp-node']={class_type:'MissingWorkbenchMcpAcceptanceNode',inputs:{}};
  const started=await scoped('comfy_workflow_complete',{name:'缺失检测验收',document:missing,requestId:randomUUID()});
  let report;
  for(let i=0;i<120;i++){report=await scoped('comfy_completion_report',{id:started.id});if(!['queued','running'].includes(report.status))break;await delay(250);}
  assert.ok(report.dependencies.some(item=>item.filename==='__missing_mcp_acceptance_vae__.safetensors'&&item.service.status==='missing'));
  assert.ok(report.dependencies.some(item=>item.classType==='MissingWorkbenchMcpAcceptanceNode'&&item.service.status==='missing'));
  results.missingDependenciesDetected=true;results.completionReport=report.id;
  const workflow=await scoped('comfy_workflow_import',{name:'MCP SDK 真实模型出图',document});results.workflowId=workflow.id;
  const ui=await fetch(backend.url+`/instances/${instanceId}/api/modules/drawing/workflows`).then(r=>r.json());
  assert.ok(ui.workflows.some(item=>item.id===workflow.id));results.sameUiData=true;
  const requestId=randomUUID();const generated=await scoped('comfy_generate',{workflowId:workflow.id,requestId});
  assert.equal((await scoped('comfy_generate',{workflowId:workflow.id,requestId})).id,generated.id);results.retryDeduplicated=true;
  let wrapped;
  for(let i=0;i<300;i++){
    wrapped=await call(stdio,'workbench_task',{instanceId,kind:'drawing',id:generated.id,refresh:true});
    if(['completed','failed','cancelled'].includes(wrapped.status))break;
    await delay(1000);
  }
  assert.equal(wrapped.status,'completed',JSON.stringify(wrapped));
  const image=wrapped.task.images[0];assert.ok(image.url.startsWith('/instances/'+instanceId+'/'));
  const response=await fetch(backend.url+image.url);assert.ok(response.ok);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');
  await writeFile(join(directory,'generated.png'),bytes);
  results.image={file:join(directory,'generated.png'),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:createHash('sha256').update(bytes).digest('hex')};
  results.jobId=generated.id;results.realComfyUI=true;results.realModel=true;results.http=true;results.stdio=true;results.passed=true;
  await writeFile(join(directory,'result.json'),JSON.stringify(results,null,2)+'\n','utf8');
  console.log(JSON.stringify(results,null,2));
}finally{
  // Backend close only stops the ComfyUI process launched by this QA instance.
  await Promise.allSettled([stdio.close(),http.close()]);
  await backend.close();
}
