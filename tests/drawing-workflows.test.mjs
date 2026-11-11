import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFields, applyWorkflowValues, validatePrompt, pythonForComfy } from '../framework/drawing-workflows.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const info = {
  Text: { input: { required: { text: ['STRING', { multiline: true }] } } },
  Sampler: { input: { required: { seed: ['INT', { min: 0, max: 1000 }], steps: ['INT', { min: 1, max: 100 }], model: ['MODEL'], mode: [['normal', 'fast']] } } },
  Save: { output_node: true, input: { required: { images: ['IMAGE'] } } },
};
const graph = { '1': { class_type: 'Text', inputs: { text: '中文提示' } }, '2': { class_type: 'Sampler', inputs: { seed: 12, steps: 20, mode: 'normal', model: ['1', 0] } }, '3': { class_type: 'Save', inputs: { images: ['2', 0] } } };

test('根据真实节点定义生成参数，连接不会成为可编辑文字', () => {
  const fields = workflowFields(graph, info);
  assert.equal(fields.find(f => f.key === '1:text').type, 'text');
  assert.deepEqual(fields.find(f => f.key === '2:mode').choices, ['normal', 'fast']);
  assert.equal(fields.some(f => f.key === '2:model'), false);
});
test('只修改允许的参数且保留原图，拒绝越界、非整数与未知输入', () => {
  const next = applyWorkflowValues(graph, { '1:text': '新的中文', '2:steps': 4 }, info);
  assert.equal(next['1'].inputs.text, '新的中文');
  assert.equal(graph['1'].inputs.text, '中文提示');
  for (const values of [{ '2:steps': 0 }, { '2:steps': 1.5 }, { '2:mode': 'missing' }, { '2:model': 'override' }]) assert.throws(() => applyWorkflowValues(graph, values, info));
});
test('拒绝缺失节点、断连、无输出与循环，保留准确的修复信息', () => {
  assert.doesNotThrow(() => validatePrompt(graph, info));
  assert.throws(() => validatePrompt({ ...graph, '4': { class_type: 'Missing', inputs: {} } }, info), /Missing/);
  assert.throws(() => validatePrompt({ '1': graph['1'] }, info), /输出/);
  assert.throws(() => validatePrompt({ ...graph, '3': { class_type: 'Save', inputs: { images: ['missing', 0] } } }, info), /连接/);
});

test('启动优先使用 ComfyUI 自己的虚拟环境，不被相邻整合环境覆盖',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'comfy-python-'));const core=join(directory,'ComfyUI');
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const own=join(core,'.venv/Scripts/python.exe'),adjacent=join(directory,'python/python.exe');
  for(const file of [own,adjacent]){await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,'fixture');}
  assert.equal(pythonForComfy(core),own);
});
