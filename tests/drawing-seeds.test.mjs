import test from 'node:test';
import assert from 'node:assert/strict';

import * as seeds from '../public-workbench/drawing-seeds.js';
const field={key:'7:seed',nodeId:'7',input:'seed',type:'number',value:42,min:0,max:Number.MAX_SAFE_INTEGER,step:1};
const workflow=(type,widgets_values,extra={})=>({document:{nodes:[{id:7,type,widgets_values,...extra}]}});

test('种子字段依照语义标记，旧字段只认明确的整数种子名',()=>{
  assert.equal(typeof seeds.isSeedField,'function');
  assert.equal(seeds.isSeedField(field),true);
  assert.equal(seeds.isSeedField({...field,input:'preset.value',presentation:{seed:true}}),true);
  assert.equal(seeds.isSeedField({...field,presentation:{seed:false}}),false);
  assert.equal(seeds.isSeedField({...field,input:'seed_text',type:'text'}),false);
});
test('仅明确的原生种子伴随控件恢复随机模式，未知布局保留固定',()=>{
  assert.equal(typeof seeds.inferSeedMode,'function');
  assert.equal(seeds.inferSeedMode(workflow('KSampler',[42,'randomize',20,7,'euler','normal',1]),field),'random');
  assert.equal(seeds.inferSeedMode(workflow('KSampler',[42,'fixed',20,7,'euler','normal',1]),field),'fixed');
  assert.equal(seeds.inferSeedMode(workflow('KSampler',[42,'increment',20,7,'euler','normal',1]),field),'fixed');
  assert.equal(seeds.inferSeedMode(workflow('Unknown',[42,'randomize']),field),'fixed');
  assert.equal(seeds.inferSeedMode(workflow('TextGenerateQwen35MTP',['','preset',4096,0.9,42,'randomize','auto']),field),'random');
  assert.equal(seeds.inferSeedMode(workflow('TextGenerateQwen35MTP',[42,'randomize',42,'auto']),field),'fixed');
  assert.equal(seeds.inferSeedMode(workflow('TextGenerateQwen35MTP',[42,'auto']),field),'fixed');
  assert.equal(seeds.inferSeedMode({},field),'fixed');
});
test('随机种子覆盖安全整数边界、尊重节点范围，并拒绝无合法整数范围',()=>{
  assert.equal(typeof seeds.randomSeed,'function');
  const zero={getRandomValues:words=>{words.fill(0);return words;}};
  assert.equal(seeds.randomSeed({min:0,max:Number.MAX_SAFE_INTEGER},zero),0);
  assert.equal(seeds.randomSeed({min:-4,max:4},zero),-4);
  assert.equal(seeds.randomSeed({min:42,max:42},zero),42);
  assert.equal(seeds.randomSeed({min:1.2,max:2.8},zero),2);
  for(let i=0;i<80;i++){const value=seeds.randomSeed({min:0,max:18446744073709551615});assert.ok(Number.isSafeInteger(value));assert.ok(value>=0&&value<=Number.MAX_SAFE_INTEGER);}
  assert.throws(()=>seeds.randomSeed({min:9,max:8}),/种子/);
});
test('随机范围用拒绝采样处理尾部，避免取模偏差',()=>{
  assert.equal(typeof seeds.randomSeed,'function');let calls=0;
  const source={getRandomValues:words=>{words.fill(calls++===0?0xffffffff:0);return words;}};
  assert.equal(seeds.randomSeed({min:5,max:7},source),5);assert.equal(calls,2);
});
