import test from 'node:test';
import assert from 'node:assert/strict';
import {drawingRpc} from '../framework/drawing-mcp.mjs';
import {handleDrawingCompletionHttp} from '../framework/drawing-completion-http.mjs';

test('MCP与HTTP共用工作流补全服务，读取不扫描，检查不触发生图',async()=>{
  const calls=[];const completion={list:()=>[{id:'one'}],get:id=>({id}),start:async value=>{calls.push(value);return {id:'report'};}};
  const tools=await drawingRpc({jsonrpc:'2.0',id:1,method:'tools/list'},{},()=>true,completion);
  assert.ok(tools.result.tools.some(item=>item.name==='comfy_workflow_complete'));
  const result=await drawingRpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'comfy_workflow_complete',arguments:{document:{nodes:[]},requestId:'mcp-request'}}},{},()=>true,completion);
  assert.equal(JSON.parse(result.result.content[0].text).id,'report');assert.equal(calls.length,1);
  let response;assert.equal(await handleDrawingCompletionHttp({req:{method:'GET'},res:{},pathname:'/api/modules/drawing/completion',json:(_res,code,value)=>{response={code,value};},completion}),true);
  assert.deepEqual(response,{code:200,value:{reports:[{id:'one'}]}});assert.equal(calls.length,1);
});
