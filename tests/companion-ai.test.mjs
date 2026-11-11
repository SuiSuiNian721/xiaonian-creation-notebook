import test from 'node:test';
import assert from 'node:assert/strict';
const adapter=await import('../framework/companion-ai.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});

test('OpenAI 接入保留多模态、流和工具，使用模块配置与角色快照',async()=>{
  assert.equal(typeof adapter.completeAiriChat,'function');
  let received;
  const sharedAI={config:id=>{assert.equal(id,'companion');return {enabled:true,provider:'openai',model:'actual-model',baseUrl:'https://example.invalid/v1',apiKey:'private-key'};},fetch:async(url,options)=>{received={url,...options};return new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}};
  const messages=[{role:'user',content:[{type:'text',text:'看一下'}]}];
  const tools=[{type:'function',function:{name:'look',parameters:{type:'object'}}}];
  const result=await adapter.completeAiriChat({sharedAI,value:{model:'workbench-shared',stream:true,messages,tools},character:{name:'茉茉',description:'工程伙伴'}});
  const value=JSON.parse(received.body);
  assert.equal(value.model,'actual-model');assert.equal(value.stream,true);assert.deepEqual(value.tools,tools);assert.deepEqual(value.messages.at(-1),messages[0]);
  assert.match(value.messages[0].content,/茉茉/);assert.equal(received.headers.authorization,'Bearer private-key');
  assert.equal(result.response.headers.get('content-type'),'text/event-stream');
});

test('Codex 工具输出转换成原生工具调用，工具结果继续进入对话',async()=>{
  assert.equal(typeof adapter.completeAiriChat,'function');
  let input,options;
  const sharedAI={config:()=>({enabled:true,provider:'codex'}),complete:async(messages,settings)=>{input=messages;options=settings;return {text:JSON.stringify({content:'',tool_calls:[{name:'read',arguments:'{"target":"screen"}'}]})};}};
  const result=await adapter.completeAiriChat({sharedAI,value:{messages:[{role:'tool',tool_call_id:'old',content:'屏幕内容'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}]}});
  assert.equal(options.moduleId,'companion');assert.ok(options.outputSchema);
  assert.ok(input.every(message=>['system','user','assistant','developer'].includes(message.role)));
  assert.equal(result.value.choices[0].finish_reason,'tool_calls');assert.equal(result.value.choices[0].message.tool_calls[0].function.name,'read');
});

test('未启用 AI 和未经声明的工具结果必须明确失败',async()=>{
  assert.equal(typeof adapter.completeAiriChat,'function');
  await assert.rejects(adapter.completeAiriChat({sharedAI:{config:()=>({enabled:false})},value:{messages:[{role:'user',content:'你好'}]}}),/启用/);
  await assert.rejects(adapter.completeAiriChat({sharedAI:{config:()=>({enabled:true,provider:'codex'}),complete:async()=>({text:'{"content":"","tool_calls":[{"name":"unknown","arguments":"{}"}]}'})},value:{messages:[{role:'user',content:'你好'}],tools:[{type:'function',function:{name:'read'}}]}}),/工具/);
});

test('原生精简角色使用 Codex 文字策略，既不声明原生工具也不开放宿主工具',async()=>{
  let options,input;
  const life={context:async()=>({prompt:'基本人设',runtimeContext:{mode:'lite',configRevision:1}}),processOutput:async value=>({text:value.text,actions:[]})};
  const sharedAI={config:()=>({enabled:true,provider:'codex'}),complete:async(messages,configuration)=>{input=messages;options=configuration;return {text:'你好'};}};
  await adapter.completeAiriChat({sharedAI,life,character:{id:'test',name:'杏'},value:{messages:[{role:'user',content:'你好'}],tools:[{type:'function',function:{name:'look'}}]}});
  assert.equal(options.policy,'chat-only');assert.equal(options.outputSchema,undefined);assert.doesNotMatch(JSON.stringify(input),/工具定义/);
});
