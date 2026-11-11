import { spawn } from 'node:child_process';
import { lstatSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError, object } from './contracts.mjs';
import { comboChoices, expandedInputs, verifiedWidgetLayout, connectionTypeResolver, compatibleTypes } from './drawing-schema.mjs';
import { enrichWorkflowFields } from './drawing-field-semantics.mjs';
import { imageFieldRoles } from './drawing-image-roles.mjs';

const converter = resolve(dirname(fileURLToPath(import.meta.url)), '../integrations/comfy/convert.py');
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
export const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);

function validatePromptStructure(prompt, info) {
  object(prompt, '工作流');
  const entries = Object.entries(prompt);
  if (!entries.length || entries.length > 2000) throw new WorkbenchError(400, '工作流节点数量应在 1–2000 之间。');
  for (const [id, node] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || !node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) throw new WorkbenchError(400, '工作流节点格式无效，请导出有效的 API JSON。');
    if (!Object.hasOwn(info, node.class_type) || !info[node.class_type]) throw new WorkbenchError(400, `ComfyUI 缺少节点 ${node.class_type}，请在该 ComfyUI 环境中安装节点后重新连接。`);
    for (const value of Object.values(node.inputs)) if (isLink(value) && (!Object.hasOwn(prompt, value[0]) || value[1] < 0)) throw new WorkbenchError(400, `节点 ${id} 存在无效连接。`);
  }
  const visited = new Set(); const visiting = new Set();
  function walk(id) {
    if (visiting.has(id)) throw new WorkbenchError(400, `工作流节点 ${id} 存在循环连接。`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const value of Object.values(prompt[id].inputs)) if (isLink(value)) walk(value[0]);
    visiting.delete(id); visited.add(id);
  }
  for (const [id] of entries) walk(id);
  if (!entries.some(([, node]) => info[node.class_type]?.output_node)) throw new WorkbenchError(400, '工作流没有输出节点，请添加保存、预览或文本输出节点。');
  return prompt;
}

const modelInput = name => /^(?:(?:ckpt|checkpoint|lora|vae|clip|unet|diffusion|control_net|model)(?:_name|_file)?|clip_name\d+)$/i.test(name);
const uiOnlyTypes = new Set(['Note', 'MarkdownNote', 'PrimitiveNode', 'GetNode', 'SetNode', 'Reroute']);
const uiClassType = (node, info) => Object.hasOwn(info || {}, node?.properties?.['Node name for S&R']) ? node.properties['Node name for S&R'] : node?.type;
const connectionTypes = new Set(['MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'MASK', 'CONDITIONING', 'CONTROL_NET', 'SIGMAS', 'SAMPLER', 'NOISE', 'GUIDER', 'UPSCALE_MODEL']);

function inspectionNodes(document) {
  const definitions = new Map((Array.isArray(document.definitions?.subgraphs) ? document.definitions.subgraphs : []).map(graph => [graph.id, graph]));
  const nodes = [];
  let visitedNodes = 0;
  const visit = (items, prefix = '', ancestors = new Set()) => {
    for (const node of items || []) {
      if (++visitedNodes > 2000) throw new WorkbenchError(400, '工作流展开访问超过 2000 个节点（含子图容器）。');
      const id = prefix + String(node?.id ?? ''); const subgraph = definitions.get(node?.type);
      if (subgraph) {
        if (ancestors.has(subgraph.id)) throw new WorkbenchError(400, '工作流子图存在循环引用。');
        if (ancestors.size >= 24) throw new WorkbenchError(400, '工作流子图嵌套过深。');
        visit(subgraph.nodes, id + ':', new Set([...ancestors, subgraph.id]));
      } else {
        nodes.push({ ...node, id });
      }
    }
  };
  visit(document.nodes); return nodes;
}

// The converter supports more frontend variants, but a successful conversion alone is not
// evidence that an unfamiliar positional widget layout was reconstructed correctly.
export function unverifiedWidgetNodes(document, info) {
  return inspectionNodes(document).filter(node => {
    if (uiOnlyTypes.has(node?.type)) return false;
    const schema = info[uiClassType(node, info)]; if (!schema) return true;
    return !verifiedWidgetLayout(node, schema);
  }).map(node => String(node.id));
}

export function inspectWorkflow(document, info = null) {
  const available = Boolean(info && Object.keys(info).length);
  const report = { available, valid: false, nodeCount: 0, missingNodes: [], missingModels: [], invalidValues: [], errors: [], warnings: [] };
  if (!document || typeof document !== 'object' || Array.isArray(document)) { report.errors.push({ detail: '工作流必须是 JSON 对象。' }); return report; }
  const ui = Array.isArray(document.nodes);
  const prompt = document.prompt || document;
  let entries;
  try { entries = ui ? inspectionNodes(document).map(node => [String(node?.id ?? ''), { class_type: uiClassType(node, info), inputs: node?.inputs, widgets_values: node?.widgets_values, uiOnly: uiOnlyTypes.has(node?.type) }]) : Object.entries(prompt); }
  catch (error) { report.errors.push({ detail:error.message }); return report; }
  report.nodeCount = entries.length;
  if (!entries.length || entries.length > 2000) { report.errors.push({ detail: '工作流节点数量应在 1–2000 之间。' }); return report; }
  if (!available) { report.warnings.push({ detail: '尚未连接当前配置的 ComfyUI，节点、模型和参数未核实。' }); return report; }
  const types = ui ? null : connectionTypeResolver(prompt, info);
  for (const [nodeId, node] of entries) {
    if (ui && node.uiOnly) continue;
    const classType = node?.class_type;
    if (!node || typeof classType !== 'string') { report.errors.push({ nodeId, detail: '工作流节点格式无效。' }); continue; }
    const schema = Object.hasOwn(info, classType) ? info[classType] : null;
    if (!schema) { report.missingNodes.push({ nodeId, classType, detail: `ComfyUI 缺少节点 ${classType}。` }); continue; }
    if (ui) { report.warnings.push({ nodeId, classType, detail: '普通工作流的控件顺序未核实，需要可靠转换为 API JSON 后检查参数。' }); continue; }
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) { report.errors.push({ nodeId, classType, detail: '节点 inputs 必须是 JSON 对象。' }); continue; }
    const { definitions, issues } = expandedInputs(schema, node.inputs);
    report.invalidValues.push(...issues.map(issue => ({ nodeId, classType, ...issue })));
    for (const [name, definition] of definitions) if (definition.required && !Object.hasOwn(node.inputs, name)) report.invalidValues.push({ nodeId, classType, input: name, detail: '缺少必填参数。' });
    for (const [input, value] of Object.entries(node.inputs)) {
      const definition = definitions.get(input); const spec = definition?.spec; const item = { nodeId, classType, input, value };
      if (!spec) { report.invalidValues.push({ ...item, detail: '当前节点定义没有此参数。' }); continue; }
      if (isLink(value)) {
        const source = prompt[value[0]]; const outputs = info[source?.class_type]?.output;
        const sourceType = types.outputType(value[0], value[1]); const targetType = types.inputType(nodeId, spec);
        if (definition.selector) report.invalidValues.push({ ...item, detail: '动态分支必须使用明确的选项。' });
        else if (!source || value[1] < 0 || Array.isArray(outputs) && value[1] >= outputs.length) report.invalidValues.push({ ...item, detail: '节点连接不存在或输出索引无效。' });
        else if (typeof sourceType === 'string' && typeof targetType === 'string' && targetType !== 'COMBO' && !compatibleTypes(sourceType, targetType)) report.invalidValues.push({ ...item, detail: `节点连接类型不匹配：${sourceType || '动态类型冲突'} → ${targetType || '动态类型冲突'}。` });
        continue;
      }
      const [kind, limits = {}] = spec;
      const choices = comboChoices(spec);
      if (choices && !choices.includes(value)) {
        const missingModel = modelInput(input.split('.').at(-1));
        report[missingModel ? 'missingModels' : 'invalidValues'].push({ ...item, options: choices, detail: missingModel ? '模型不在当前 ComfyUI 的可选列表中。' : '参数不在当前节点的可选列表中。' });
      } else if ((kind === 'COMBO' || definition.selector) && !choices) {
        report.invalidValues.push({ ...item, detail: '当前节点的可选列表无法核实。' });
      } else if (['INT', 'FLOAT'].includes(kind) && (typeof value !== 'number' || !Number.isFinite(value) || kind === 'INT' && !Number.isSafeInteger(value) || typeof limits.min === 'number' && value < limits.min || typeof limits.max === 'number' && value > limits.max)) {
        report.invalidValues.push({ ...item, options: limits, detail: '参数类型错误或数值超出范围。' });
      } else if (kind === 'STRING' && (typeof value !== 'string' || value.length > 100000 || value.includes('\0')) || kind === 'BOOLEAN' && typeof value !== 'boolean') {
        report.invalidValues.push({ ...item, detail: '参数类型错误或文字无效。' });
      } else if (connectionTypes.has(kind) || kind === 'COMFY_MATCHTYPE_V3') {
        report.invalidValues.push({ ...item, detail: '此参数需要节点连接。' });
      }
    }
  }
  if (!ui && !report.missingNodes.length) {
    try { validatePromptStructure(prompt, info); } catch (error) { report.errors.push({ detail: error.message }); }
  }
  report.valid = !report.missingNodes.length && !report.missingModels.length && !report.invalidValues.length && !report.errors.length && !report.warnings.length;
  return report;
}

export function validatePrompt(prompt, info) {
  validatePromptStructure(prompt, info);
  const report = inspectWorkflow(prompt, info);
  const issue = [...report.missingNodes, ...report.missingModels, ...report.invalidValues, ...report.errors][0];
  if (issue) throw new WorkbenchError(400, `${issue.nodeId ? `节点 ${issue.nodeId} ${issue.input || ''}：` : ''}${issue.detail}`);
  return prompt;
}

export function workflowFields(prompt, info) {
  const result = [];
  for (const [id, node] of Object.entries(prompt)) {
    const schema = info[node.class_type];
    const { definitions } = expandedInputs(schema, node.inputs);
    for (const [name, value] of Object.entries(node.inputs)) {
      const definition = definitions.get(name); const spec = definition?.spec;
      if (!spec || definition.hidden || definition.selector || isLink(value) || !scalar(value)) continue;
      const [kind, options = {}] = spec;
      const choices = comboChoices(spec);
      if (!choices && !['STRING', 'INT', 'FLOAT', 'BOOLEAN'].includes(kind)) continue;
      result.push({ key: `${id}:${name}`, nodeId: id, input: name, label: name, group: node._meta?.title || schema?.display_name || node.class_type,
        type: choices ? 'select' : kind === 'BOOLEAN' ? 'boolean' : ['INT', 'FLOAT'].includes(kind) ? 'number' : 'text',
        value, ...(choices ? { choices: choices.filter(scalar) } : {}),
        ...(typeof options.min === 'number' ? { min: options.min } : {}), ...(typeof options.max === 'number' ? { max: Math.min(options.max, Number.MAX_SAFE_INTEGER) } : {}),
        step: kind === 'INT' ? 1 : options.step || 'any', multiline: Boolean(options.multiline) || /text|prompt/.test(name),
        image: Boolean(options.image_upload) || name === 'image' && /LoadImage/.test(node.class_type),
      });
    }
  }
  return imageFieldRoles(prompt, enrichWorkflowFields(prompt, result, info), info);
}

export function applyWorkflowValues(prompt, values, info) {
  object(values, '参数');
  const fields = new Map(workflowFields(prompt, info).map(field => [field.key, field]));
  const next = structuredClone(prompt);
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) throw new WorkbenchError(400, `不允许修改参数 ${key}。`);
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || field.step === 1 && !Number.isSafeInteger(value) || field.min !== undefined && value < field.min || field.max !== undefined && value > field.max)) throw new WorkbenchError(400, `${field.group} 的 ${field.label} 数值超出范围。`);
    if (field.type === 'text' && (typeof value !== 'string' || value.length > 100000 || value.includes('\0'))) throw new WorkbenchError(400, `${field.label} 文字无效或过长。`);
    if (field.type === 'boolean' && typeof value !== 'boolean' || field.type === 'select' && !field.choices.includes(value)) throw new WorkbenchError(400, `${field.label} 的选项无效。`);
    next[field.nodeId].inputs[field.input] = value;
  }
  return next;
}

export function isComfyDirectory(directory) {
  try { return ['main.py','server.py','nodes.py'].every(name=>lstatSync(join(directory,name)).isFile()) && lstatSync(join(directory,'comfy')).isDirectory(); }
  catch { return false; }
}

export function pythonForComfy(comfyPath) {
  const base = resolve(comfyPath || '.');
  const candidates = [process.env.AI_FUTURE_COMFY_PYTHON, ...['.venv/Scripts/python.exe','venv/Scripts/python.exe','.venv/bin/python','venv/bin/python','../python_embeded/python.exe','../python/python.exe'].map(path=>resolve(base,path))].filter(Boolean);
  const executable = candidates.find(path=>{try{return statSync(path).isFile();}catch{return false;}});
  if (!executable) throw new WorkbenchError(400, '找不到此 ComfyUI 的 Python 环境。请使用其虚拟环境或便携包内的 Python，也可通过 AI_FUTURE_COMFY_PYTHON 指定。');
  return executable;
}

export async function convertWorkflow(document, info, comfyPath, { validate = true, signal, pythonPath } = {}) {
  object(document, '工作流');
  if (signal?.aborted) throw new WorkbenchError(503, '工作流转换已取消。');
  if (!Array.isArray(document.nodes)) return validate ? validatePrompt(structuredClone(document.prompt || document), info) : structuredClone(document.prompt || document);
  const python = pythonPath || pythonForComfy(comfyPath);
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, ['-I', converter], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let error = ''; let settled = false;
    const finish = (failure, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); failure ? reject(failure) : resolveResult(value); };
    const cancel = () => { child.kill(); finish(new WorkbenchError(503, '工作流转换已取消。')); };
    const timer = setTimeout(() => { child.kill(); finish(new WorkbenchError(408, '工作流转换超时，请在 ComfyUI 导出 API JSON 后导入。')); }, 20000);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 4 * 1024 * 1024) { child.kill(); finish(new WorkbenchError(413, '转换后工作流过大。')); } });
    child.stderr.on('data', bytes => { if (error.length < 10000) error += bytes.toString('utf8'); });
    child.on('error', () => finish(new WorkbenchError(503, '无法运行 ComfyUI 的 Python，请检查安装路径。')));
    child.on('close', code => { try { if (code) throw new WorkbenchError(400, `工作流无法可靠转换：${error.trim().slice(-1000)}。请导出 API JSON 后导入。`); const prompt = JSON.parse(output); finish(null, validate ? validatePrompt(prompt, info) : prompt); } catch (failure) { finish(failure); } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ workflow: document, object_info: info }));
  });
}
