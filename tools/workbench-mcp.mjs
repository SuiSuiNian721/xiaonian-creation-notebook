import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// stdout belongs exclusively to MCP JSON-RPC. The connection file is re-read per
// request so clients can continue after the workbench restarts on a new port.
const connectionFile=process.argv[2];
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
const pending=new Set();
let protocolVersion='2025-06-18';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
async function forward(line){
  let request;
  try{
    try{request=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'JSON 解析失败。'}});return;}
    if(Buffer.byteLength(line)>2*1024*1024)throw new Error('MCP 请求超过 2 MiB。');
    const {url,token}=JSON.parse(await readFile(connectionFile,'utf8'));
    const address=new URL(url);
    if(!['127.0.0.1','[::1]'].includes(address.hostname)||address.protocol!=='http:'||address.username||address.password||!address.pathname.endsWith('/mcp')||typeof token!=='string'||!token)throw new Error('工作台连接记录无效。');
    const response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,'mcp-protocol-version':protocolVersion},body:line,signal:AbortSignal.timeout(180000)});
    if(response.status===202)return;
    if(!response.ok)throw new Error(`工作台 MCP 返回 ${response.status}，请启动工作台并启用 MCP。`);
    const result=await response.json();
    if(request?.method==='initialize'&&result.result?.protocolVersion)protocolVersion=result.result.protocolVersion;
    send(result);
  }catch(error){if(request?.id!==undefined)send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:error.message}});else process.stderr.write(error.message+'\n');}
}
// Do not serialize transport requests: a query or cancellation must reach the
// workbench while a previous lookup is still in progress. IDs correlate replies.
for await(const line of lines){
  if(!line.trim())continue;
  const work=forward(line);pending.add(work);work.finally(()=>pending.delete(work));
}
await Promise.allSettled([...pending]);
