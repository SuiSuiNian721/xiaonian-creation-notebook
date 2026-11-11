import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflow, validatePrompt, unverifiedWidgetNodes, workflowFields, applyWorkflowValues, convertWorkflow } from '../framework/drawing-workflows.mjs';

const combo = options => ['COMBO', { options }];
const schema = {
  Source: { input: { required: {} }, output: ['CLIP', 'IMAGE', 'MODEL'] },
  TextEncodeQwenImage21: {
    input: { required: {
      clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT', { min: 0, max: 4096 }],
      images: ['COMFY_AUTOGROW_V3', { template: { input: { required: { image: ['IMAGE'] } }, names: ['image_1', 'image_2'], min: 0 } }],
    } },
    input_order: { required: ['clip', 'prompt', 'negative_prompt', 'resolution', 'images'] }, output: ['IMAGE'],
  },
  QwenImage21Cache: {
    input: { required: { model: ['MODEL'], device: combo(['auto', 'gpu', 'cpu', 'off']), dtype: combo(['default', 'int8', 'int4']) } },
    input_order: { required: ['model', 'device', 'dtype'] }, output: ['MODEL'],
  },
  SaveImageAdvanced: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'], format: ['COMFY_DYNAMICCOMBO_V3', { options: [
      { key: 'png', inputs: { required: { bit_depth: combo(['8-bit', '16-bit']), input_color_space: combo(['sRGB']) } } },
      { key: 'avif', inputs: { required: { crf: ['INT', { min: 1, max: 63 }], save_mode: ['COMFY_DYNAMICCOMBO_V3', { options: [
        { key: 'still', inputs: { required: {} } },
        { key: 'animated', inputs: { required: { fps: ['FLOAT', { min: 0.01, max: 1000 }] } } },
      ] }] } } },
    ] }] } },
    input_order: { required: ['images', 'filename_prefix', 'format'] }, output_node: true,
  },
};
const graph = () => ({
  '1': { class_type: 'Source', inputs: {} },
  '2': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['1', 0], prompt: '中文提示', negative_prompt: '', resolution: 1024 } },
  '3': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 2], device: 'cpu', dtype: 'int8' } },
  '4': { class_type: 'SaveImageAdvanced', inputs: { images: ['2', 0], filename_prefix: 'Qwen21', format: 'png', 'format.bit_depth': '8-bit', 'format.input_color_space': 'sRGB' } },
});
const uiGraph = () => ({ nodes: [
  { id: 1, type: 'Source', inputs: [], outputs: [{ links: [1] }, { links: null }, { links: [2] }], widgets_values: [] },
  { id: 2, type: 'TextEncodeQwenImage21', inputs: [{ name: 'clip', link: 1 }], outputs: [{ links: [3] }], widgets_values: ['中文提示', '', 1024] },
  { id: 3, type: 'QwenImage21Cache', inputs: [{ name: 'model', link: 2 }], widgets_values: ['cpu', 'int8'] },
  { id: 4, type: 'SaveImageAdvanced', inputs: [{ name: 'images', link: 3 }], widgets_values: ['Qwen21', 'png', '8-bit', 'sRGB'] },
], links: [[1, 1, 0, 2, 0, 'CLIP'], [2, 1, 2, 3, 0, 'MODEL'], [3, 2, 0, 4, 0, 'IMAGE']] });

test('V3 文生图接受空参考图组、COMBO 和动态格式子参数', () => {
  const prompt = graph();
  assert.equal(inspectWorkflow(prompt, schema).valid, true);
  assert.equal(validatePrompt(prompt, schema), prompt);
  assert.deepEqual(unverifiedWidgetNodes(uiGraph(), schema), []);
});

test('参考图组按命名模板校验连接，仍拒绝未知名称、错类型和断连', () => {
  const prompt = graph(); prompt['2'].inputs['images.image_1'] = ['1', 1];
  assert.equal(inspectWorkflow(prompt, schema).valid, true);
  for (const value of [['1', 0], ['1', 8], ['missing', 0], 'image.png']) {
    prompt['2'].inputs['images.image_1'] = value;
    assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'images.image_1'));
  }
  delete prompt['2'].inputs['images.image_1']; prompt['2'].inputs['images.image_3'] = ['1', 1];
  assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'images.image_3'));
});

test('前缀组要求前 min 个槽位，普通必填参数仍不能遗漏', () => {
  const info = structuredClone(schema);
  info.TextEncodeQwenImage21.input.required.images[1].template = { input: { required: { image: ['IMAGE'] } }, prefix: 'image', min: 1, max: 2 };
  const prompt = graph(); prompt['2'].inputs['images.image1'] = ['1', 1];
  assert.ok(inspectWorkflow(prompt, info).invalidValues.some(item => item.input === 'images.image0'));
  prompt['2'].inputs['images.image0'] = ['1', 1];
  assert.equal(inspectWorkflow(prompt, info).valid, true);
  delete prompt['2'].inputs.prompt;
  assert.ok(inspectWorkflow(prompt, info).invalidValues.some(item => item.input === 'prompt'));
});

test('V3 COMBO 枚举与模型枚举不能绕过校验', () => {
  const prompt = graph(); prompt['3'].inputs.device = 'invalid';
  assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'device'));
  const info = structuredClone(schema); info.QwenImage21Cache.input.required.lora_name = combo(['real.safetensors']);
  prompt['3'].inputs.lora_name = 'missing.safetensors';
  assert.ok(inspectWorkflow(prompt, info).missingModels.some(item => item.input === 'lora_name'));
});

test('动态分支递归检查必填项、范围、选择值和遗留子参数', () => {
  const prompt = graph();
  prompt['4'].inputs = { images: ['2', 0], filename_prefix: 'Qwen21', format: 'avif', 'format.crf': 18, 'format.save_mode': 'animated', 'format.save_mode.fps': 6 };
  assert.equal(inspectWorkflow(prompt, schema).valid, true);
  prompt['4'].inputs['format.save_mode.fps'] = 0;
  assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'format.save_mode.fps'));
  delete prompt['4'].inputs['format.save_mode.fps'];
  assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'format.save_mode.fps'));
  prompt['4'].inputs['format.save_mode'] = 'still';
  assert.equal(inspectWorkflow(prompt, schema).valid, true);
  prompt['4'].inputs['format.bit_depth'] = '8-bit';
  assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'format.bit_depth'));
  prompt['4'].inputs.format = 'unknown';
  assert.ok(inspectWorkflow(prompt, schema).invalidValues.some(item => item.input === 'format'));
});

test('参数面板开放 V3 枚举和已选分支字段，不开放无法重建的分支选择器', () => {
  const prompt = graph(); const fields = workflowFields(prompt, schema);
  assert.deepEqual(fields.find(field => field.key === '3:device')?.choices, ['auto', 'gpu', 'cpu', 'off']);
  assert.deepEqual(fields.find(field => field.key === '4:format.bit_depth')?.choices, ['8-bit', '16-bit']);
  assert.equal(fields.some(field => field.key === '4:format'), false);
  const next = applyWorkflowValues(prompt, { '3:device': 'gpu', '4:format.bit_depth': '16-bit' }, schema);
  assert.equal(next['4'].inputs['format.bit_depth'], '16-bit');
  assert.equal(prompt['4'].inputs['format.bit_depth'], '8-bit');
  assert.equal(inspectWorkflow(next, schema).valid, true);
  assert.throws(() => applyWorkflowValues(prompt, { '4:format': 'avif' }, schema));
});

test('动态控件只接受可解释的当前分支布局，未知控件和旧分支仍未核实', () => {
  const document = uiGraph();
  document.nodes[3].widgets_values = ['Qwen21', 'avif', 18, 'animated', 6];
  assert.deepEqual(unverifiedWidgetNodes(document, schema), []);
  document.nodes[3].widgets_values.push('custom-widget');
  assert.deepEqual(unverifiedWidgetNodes(document, schema), ['4']);
  document.nodes[3].widgets_values = ['Qwen21', 'removed-format'];
  assert.deepEqual(unverifiedWidgetNodes(document, schema), ['4']);
  const unordered = structuredClone(schema); delete unordered.QwenImage21Cache.input_order;
  assert.ok(unverifiedWidgetNodes(uiGraph(), unordered).includes('3'));
});

test('Python 转换与 V3 预检共享动态控件映射结果', { skip: !process.env.AI_FUTURE_TEST_PYTHON }, async () => {
  const converted = await convertWorkflow(uiGraph(), schema, '', { pythonPath: process.env.AI_FUTURE_TEST_PYTHON });
  assert.deepEqual(converted['2'].inputs, graph()['2'].inputs);
  assert.deepEqual(converted['3'].inputs, graph()['3'].inputs);
  assert.deepEqual(converted['4'].inputs, graph()['4'].inputs);
});

test('经典隐藏参数的字符串定义不影响导入，也不会成为可编辑字段', () => {
  const info = structuredClone(schema); info.SaveImageAdvanced.input.hidden = { prompt: 'PROMPT', extra_pnginfo: 'EXTRA_PNGINFO' };
  assert.equal(inspectWorkflow(graph(), info).valid, true);
  assert.deepEqual(unverifiedWidgetNodes(uiGraph(), info), []);
});

test('图片上传控件已知的 image 尾槽可核实，多余自定义控件仍被拒绝', () => {
  const info = { LoadImage: { input: { required: { image: [['example.png'], { image_upload: true }] } }, input_order: { required: ['image'] } } };
  const document = { nodes: [{ id: 1, type: 'LoadImage', widgets_values: ['example.png', 'image'] }] };
  assert.deepEqual(unverifiedWidgetNodes(document, info), []);
  document.nodes[0].widgets_values.push('custom');
  assert.deepEqual(unverifiedWidgetNodes(document, info), ['1']);
  document.nodes[0].widgets_values = ['example.png', 'unknown'];
  assert.deepEqual(unverifiedWidgetNodes(document, info), ['1']);
  delete info.LoadImage.input.required.image[1].image_upload;
  document.nodes[0].widgets_values = ['example.png', 'image'];
  assert.deepEqual(unverifiedWidgetNodes(document, info), ['1']);
});

test('V3 MatchType 依据同组连接推导输出，拒绝混合类型和越过允许类型', () => {
  const match = ['COMFY_MATCHTYPE_V3', { template: { template_id: 'branch', allowed_types: '*' } }];
  const info = { ...schema, Switch: { input: { optional: { left: match, right: match } }, output: ['COMFY_MATCHTYPE_V3'], output_matchtypes: ['branch'] } };
  const prompt = graph();
  prompt['5'] = { class_type: 'Switch', inputs: { left: ['1', 1], right: ['2', 0] } };
  prompt['6'] = { class_type: 'Switch', inputs: { left: ['5', 0] } };
  prompt['4'].inputs.images = ['6', 0];
  assert.equal(inspectWorkflow(prompt, info).valid, true);
  prompt['5'].inputs.right = ['1', 0];
  assert.ok(inspectWorkflow(prompt, info).invalidValues.some(item => item.nodeId === '5'));
  prompt['5'].inputs.right = ['2', 0];
  const restricted = structuredClone(info); restricted.Switch.input.optional.left[1].template.allowed_types = 'LATENT'; restricted.Switch.input.optional.right[1].template.allowed_types = 'LATENT';
  assert.ok(inspectWorkflow(prompt, restricted).invalidValues.some(item => item.nodeId === '5'));
});

test('全部文字控件由连线提供时允许空控件数组', () => {
  const info = { Text: { input: { required: { text: ['STRING'] } } } };
  const document = { nodes: [{ id: 1, type: 'Text', inputs: [{ name: 'text', link: 1 }], widgets_values: [] }] };
  assert.deepEqual(unverifiedWidgetNodes(document, info), []);
  document.nodes[0].inputs[0].link = null;
  assert.deepEqual(unverifiedWidgetNodes(document, info), ['1']);
});

test('动态分支定义损坏时不能通过 API 预检', () => {
  const info = structuredClone(schema); delete info.SaveImageAdvanced.input.required.format[1].options[0].inputs;
  const prompt = graph(); delete prompt['4'].inputs['format.bit_depth']; delete prompt['4'].inputs['format.input_color_space'];
  assert.equal(inspectWorkflow(prompt, info).valid, false);
});
