import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVariableRules,evaluateVariableRules,protectRuleVariables} from '../framework/character-life/variable-rules.mjs';
const rule=(patch={})=>({id:'comfort',name:'受到安慰',enabled:true,path:'moodValue',type:'number',initial:50,min:0,max:100,maxDelta:5,trigger:'semantic',environment:'any',conditionPath:'energy',operator:'lte',threshold:30,event:'对方实际安慰了角色，而非假设或引用',operation:'add',value:3,...patch});
test('语义更新必须有本轮原话证据，关键词或未知规则不能触发',()=>{
  const rules=normalizeVariableRules([rule()]);
  assert.equal(evaluateVariableRules({moodValue:50,variables:{}},rules,{input:'如果有人安慰你呢',environment:'private'}).changes.length,0);
  assert.equal(evaluateVariableRules({moodValue:50,variables:{}},rules,{input:'别怕，我陪着你',events:[{ruleId:'comfort',sourceQuote:'不存在'}]}).changes.length,0);
  const result=evaluateVariableRules({moodValue:50,variables:{}},rules,{input:'别怕，我陪着你',events:[{ruleId:'comfort',sourceQuote:'我陪着你',reason:'对方明确安慰'}]});
  assert.equal(result.state.moodValue,53);assert.equal(result.changes[0].sourceQuote,'我陪着你');
});
test('同一变量按顺序只执行一次，范围与每轮上限不能被叠加绕过',()=>{
  const rules=normalizeVariableRules([rule({trigger:'condition',value:99}),rule({id:'second',trigger:'condition',value:80})]);
  const result=evaluateVariableRules({moodValue:98,energy:20,variables:{}},rules,{});
  assert.equal(result.state.moodValue,100);assert.equal(result.changes.length,1);
});
test('自定义变量支持初始值与类型，未命中不进行事件更新',()=>{
  const rules=normalizeVariableRules([rule({path:'variables.story.ready',type:'boolean',initial:false,operation:'set',value:true})]);
  const result=evaluateVariableRules({variables:{}},rules,{});assert.equal(result.state.variables.story.ready,false);
  assert.equal(result.changes[0].kind,'initialize');
  assert.throws(()=>normalizeVariableRules([rule({path:'variables.__proto__.bad'})]));
  assert.throws(()=>normalizeVariableRules([rule({path:'variables.ready',type:'boolean',initial:false,value:3,operation:'set'})]));
});

test('条件首次即读取全部声明初值，不串联前面规则本轮更新的值',()=>{
  const rules=normalizeVariableRules([rule({path:'variables.trust',initial:10,trigger:'condition',conditionPath:'variables.trust',threshold:10}),rule({id:'other',path:'variables.other',initial:0,trigger:'condition',conditionPath:'variables.trust',threshold:10})]);
  const result=evaluateVariableRules({variables:{}},rules);
  assert.equal(result.state.variables.trust,13);assert.equal(result.state.variables.other,3);
});

test('规则不破坏已有冲突父节点，小数增量可执行，过深路径在保存时拒绝',()=>{
  const rules=normalizeVariableRules([rule({path:'variables.stats.trust',trigger:'condition'})]);
  assert.deepEqual(protectRuleVariables({stats:5},{stats:5},rules),{stats:5});
  assert.deepEqual(protectRuleVariables({stats:{}},{stats:[1,2]},rules),{stats:[1,2]});
  const inherited=normalizeVariableRules([rule({path:'variables.toString.x'})]);
  assert.deepEqual(protectRuleVariables({}, {}, inherited),{toString:{}});
  const decimal=normalizeVariableRules([rule({path:'variables.score',trigger:'condition',initial:0,value:0.1,maxDelta:0.1})]);
  const result=evaluateVariableRules({variables:{score:0.2},energy:20},decimal);assert.ok(Math.abs(result.state.variables.score-0.3)<1e-12);
  assert.throws(()=>normalizeVariableRules([rule({path:'variables.'+Array(42).fill('a').join('.')})]),/路径/);
});
