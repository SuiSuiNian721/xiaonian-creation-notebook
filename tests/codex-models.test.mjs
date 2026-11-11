import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodexModelCatalog} from '../framework/codex-models.mjs';

test('桥接目录只展示 GPT 模型并合并并发读取，缓存不受调用方修改影响',async()=>{
  let calls=0,now=0;
  const catalog=createCodexModelCatalog({now:()=>now,maxAgeMs:50,load:async()=>{calls++;return [
    {id:'gpt-test',label:'GPT 测试',reasoningLevels:['low','high']},
    {id:'other-model',label:'其他服务'},
    {id:'gpt-test',label:'重复项'},
  ];}});
  const [first,second]=await Promise.all([catalog(),catalog()]);
  assert.equal(calls,1);assert.deepEqual(first.map(item=>item.id),['gpt-test']);assert.deepEqual(second,first);
  first[0].label='changed';assert.equal((await catalog())[0].label,'GPT 测试');
  now=60;await catalog();assert.equal(calls,2);
});

test('目录不可读时明确失败，下一次可以重新读取，不伪造模型',async()=>{
  let available=false;
  const catalog=createCodexModelCatalog({load:async()=>available?[{id:'gpt-recovered',label:'GPT'}]:[]});
  await assert.rejects(catalog(),/模型列表/);
  available=true;assert.equal((await catalog())[0].id,'gpt-recovered');
});
