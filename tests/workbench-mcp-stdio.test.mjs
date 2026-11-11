import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

test('stdio 慢请求期间可以查询与取消，畸形 JSON 返回协议错误',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mcp-stdio-'));
  let release,started;
  const began=new Promise(r=>started=r),held=new Promise(r=>release=r);
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const message=JSON.parse(text);
    assert.equal(req.headers.authorization,'Bearer test-token');
    if(message.method==='slow'){started();await held;}
    if(message.method==='cancel')release();
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{method:message.method}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const file=join(directory,'connection.json');await writeFile(file,JSON.stringify({url:`http://127.0.0.1:${server.address().port}/mcp`,token:'test-token'}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/workbench-mcp.mjs',import.meta.url)),file],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(async()=>{release();child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'slow'})+'\n');await began;
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'cancel'})+'\n');
  for(let i=0;i<80&&!output.includes('"id":2');i++)await delay(10);
  assert.ok(output.includes('"id":2'),'取消不能排在慢请求之后');
  child.stdin.write('{broken-json\n');
  for(let i=0;i<80&&!output.includes('-32700');i++)await delay(10);
  const messages=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(messages.some(message=>message.error?.code===-32700&&message.id===null));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name:'skin_upload',arguments:{base64:'x'.repeat(2*1024*1024)}}})+'\n');
  for(let i=0;i<80&&!output.includes('"id":91');i++)await delay(10);
  const oversized=output.trim().split('\n').map(line=>JSON.parse(line)).find(message=>message.id===91);
  assert.match(oversized?.error?.message??'',/2 MiB/,'超限请求仍必须回复对应请求 ID');
  const exit=once(child,'exit');child.stdin.end();await exit;
});
