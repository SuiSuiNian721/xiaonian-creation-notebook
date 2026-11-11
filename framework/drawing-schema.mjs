const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const dynamicCombo = spec => spec?.[0] === 'COMFY_DYNAMICCOMBO_V3';
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
const sections = ['required', 'optional'];

export function comboChoices(spec) {
  if (Array.isArray(spec?.[0])) return spec[0];
  if (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) return spec[1].options;
  if (dynamicCombo(spec) && Array.isArray(spec?.[1]?.options)) return spec[1].options.map(option => option?.key).filter(scalar);
  return null;
}

function entries(input, prefix = '', includeHidden = false) {
  return (includeHidden ? [...sections, 'hidden'] : sections).flatMap(section =>
    Object.entries(record(input?.[section]) ? input[section] : {}).map(([name, spec]) => ({ name: prefix + name, spec: section === 'hidden' && typeof spec === 'string' ? [spec] : spec, required: section === 'required', hidden: section === 'hidden' })));
}

const selectedOption = (spec, value) => Array.isArray(spec?.[1]?.options) ? spec[1].options.find(option => record(option) && option.key === value) : null;
const widget = spec => Array.isArray(spec) && !spec[1]?.forceInput && !spec[1]?.defaultInput &&
  (Array.isArray(spec[0]) || ['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO', 'COMFY_DYNAMICCOMBO_V3'].includes(spec[0]));

// V3 API inputs use dotted names. Autogrow's container is never an API input;
// the first min template slots are required, and a dynamic combo adds only its
// selected option's children. Match ComfyUI's parse_class_inputs expansion.
export function expandedInputs(schema, inputs) {
  const definitions = new Map(); const issues = [];
  let count = 0;
  const visit = (items, depth = 0) => {
    for (const entry of items) {
      const { name, spec } = entry;
      if (++count > 10000 || depth > 16) { issues.push({ input: name, detail: '动态参数展开超过安全限制。' }); return; }
      if (!Array.isArray(spec) || !spec.length) { issues.push({ input: name, detail: '当前节点的参数定义无效。' }); continue; }
      if (spec[0] === 'COMFY_AUTOGROW_V3') {
        const template = spec[1]?.template;
        const child = entries(template?.input)[0];
        const names = Array.isArray(template?.names) ? template.names : typeof template?.prefix === 'string' && Number.isInteger(template.max) && template.max >= 1 && template.max <= 1000 ? Array.from({ length: template.max }, (_, index) => template.prefix + index) : null;
        if (!child || !names || names.length > 1000 || names.some(item => typeof item !== 'string' || !item) || new Set(names).size !== names.length || !Number.isInteger(template.min) || template.min < 0 || template.min > names.length) {
          issues.push({ input: name, detail: '当前节点的动态输入组定义无法核实。' }); continue;
        }
        visit(names.map((childName, index) => ({ ...child, name: `${name}.${childName}`, required: child.required && index < template.min })), depth + 1);
        continue;
      }
      if (definitions.has(name)) { issues.push({ input: name, detail: '当前节点的动态参数名称重复。' }); continue; }
      definitions.set(name, { ...entry, selector: dynamicCombo(spec) });
      if (dynamicCombo(spec)) {
        const option = selectedOption(spec, inputs[name]);
        if (option && !record(option.inputs)) issues.push({ input: name, detail: '当前节点的动态分支定义无效。' });
        else if (option) visit(entries(option.inputs, name + '.'), depth + 1);
      } else if (typeof spec[0] === 'string' && spec[0].startsWith('COMFY_') && spec[0] !== 'COMFY_MATCHTYPE_V3') {
        issues.push({ input: name, detail: '当前节点的动态参数类型尚未支持可靠校验。' });
      }
    }
  };
  visit(entries(schema?.input, '', true));
  return { definitions, issues };
}

const typeSet = type => new Set(typeof type === 'string' ? type.split(',').map(item => item.trim()) : ['*']);
const intersectTypes = (left, right) => left.has('*') ? right : right.has('*') ? left : new Set([...left].filter(type => right.has(type)));
export const compatibleTypes = (left, right) => intersectTypes(typeSet(left), typeSet(right)).size > 0;

// MatchType templates bind a node's inputs and outputs to the same type. Resolve
// through upstream matching nodes, retaining a conflict instead of treating the
// COMFY_MATCHTYPE_V3 marker itself as either a concrete type or a wildcard.
export function connectionTypeResolver(prompt, info) {
  const definitions = new Map(); const cache = new Map();
  const nodeDefinitions = id => {
    if (!definitions.has(id)) definitions.set(id, expandedInputs(info[prompt[id]?.class_type], prompt[id]?.inputs || {}).definitions);
    return definitions.get(id);
  };
  const groupType = (id, templateId, path) => {
    const key = JSON.stringify([id, templateId]);
    if (cache.has(key)) return cache.get(key);
    if (path.has(key) || path.size >= 2000) return '*';
    const nextPath = new Set([...path, key]); let possible = new Set(['*']);
    for (const { name, spec } of nodeDefinitions(id).values()) {
      if (spec[0] !== 'COMFY_MATCHTYPE_V3' || spec[1]?.template?.template_id !== templateId) continue;
      possible = intersectTypes(possible, typeSet(spec[1]?.template?.allowed_types));
      const value = prompt[id]?.inputs?.[name];
      if (Array.isArray(value) && typeof value[0] === 'string' && Number.isInteger(value[1])) possible = intersectTypes(possible, typeSet(outputType(value[0], value[1], nextPath)));
    }
    const result = possible.size ? [...possible].join(',') : '';
    cache.set(key, result); return result;
  };
  const outputType = (id, slot, path = new Set()) => {
    const schema = info[prompt[id]?.class_type]; const type = schema?.output?.[slot];
    return type === 'COMFY_MATCHTYPE_V3' ? groupType(id, schema.output_matchtypes?.[slot], path) : type;
  };
  return { outputType, inputType: (id, spec) => spec[0] === 'COMFY_MATCHTYPE_V3' ? groupType(id, spec[1]?.template?.template_id, new Set()) : spec[0] };
}

// Verify the same positional walk used by the Python converter. Top-level
// classic widgets require input_order; V3 option.inputs declares child order.
export function verifiedWidgetLayout(node, schema) {
  const values = node.widgets_values;
  const connected = new Set((node.inputs || []).filter(input => input.link !== null && input.link !== undefined).map(input => input.name));
  const pairs = entries(schema.input).filter(entry => widget(entry.spec));
  if (record(values) || values === undefined || values === null || Array.isArray(values) && !values.length) {
    const named = record(values) ? values : {};
    const { definitions, issues } = expandedInputs(schema, named);
    return !issues.length && [...definitions.values()].every(entry => !entry.required || !widget(entry.spec) || connected.has(entry.name) || Object.hasOwn(named, entry.name));
  }
  if (!Array.isArray(values)) return false;
  if (pairs.length > 1) {
    const order = [...(schema.input_order?.required || []), ...(schema.input_order?.optional || [])].filter(name => pairs.some(entry => entry.name === name));
    if (JSON.stringify(order) !== JSON.stringify(pairs.map(entry => entry.name))) return false;
  }
  let offset = 0; let valid = true;
  const consume = (items, depth = 0) => {
    if (depth > 16) { valid = false; return; }
    const widgets = items.filter(entry => widget(entry.spec));
    for (const [index, { name, spec }] of widgets.entries()) {
      if (offset >= values.length || !scalar(values[offset])) { valid = false; return; }
      const value = values[offset++];
      if (dynamicCombo(spec)) {
        const option = selectedOption(spec, value);
        if (!option || !record(option.inputs)) { valid = false; return; }
        consume(entries(option.inputs, name + '.'), depth + 1);
      } else {
        const marker = values[offset]; const explicit = spec[1]?.control_after_generate;
        const implicit = spec[0] === 'INT' && /seed/i.test(name) && !comboChoices(widgets[index + 1]?.spec)?.includes(marker);
        if ((explicit || implicit) && ['fixed', 'increment', 'decrement', 'randomize'].includes(marker)) offset++;
      }
    }
  };
  consume(pairs);
  // ComfyUI's image upload button adds this frontend-only trailer. The Python
  // converter ignores it after all declared widget slots; no other extras pass.
  if (valid && offset + 1 === values.length && values[offset] === 'image' && pairs.some(entry => entry.spec[1]?.image_upload)) offset++;
  return valid && offset === values.length;
}
