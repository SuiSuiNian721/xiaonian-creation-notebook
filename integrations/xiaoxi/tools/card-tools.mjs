import { TEXT_FIELDS, dumpYaml, parseYaml, safeName, requireObject } from './card.mjs';
import { generateMvuBundle, mergeRuntimeData } from './mvu.mjs';
import { generateEjsController, generateEjsStatusBar } from './ejs.mjs';

const string = { type: 'string' };
const object = { type: 'object' };
const strings = { type: 'array', items: string };
const field = { type: 'object', properties: { name: string, type: { type: 'string', enum: ['string', 'number', 'boolean', 'enum', 'array', 'record'] }, default: {}, min: { type: 'number' }, max: { type: 'number' }, values: strings, itemType: string, keyType: string, valueType: string, desc: string, check: strings }, required: ['name', 'type'] };
const groups = { type: 'array', items: { type: 'object', properties: { name: string, fields: { type: 'array', items: field } }, required: ['name', 'fields'] } };
function tool(name, description, properties = {}, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } };
}
export const CARD_TOOLS = [
  tool('read_card', '读取当前卡的源文件列表、完整文件或上一轮待确认稿。路径相对于当前卡 src；不传 path 返回摘要与待确认稿 ID。', { path: string }),
  tool('generate_worldbook', '生成或更新当前卡内世界书的正文与配置配对草稿，不写入。base 为不带扩展名的稳定文件名；更新前先读取原条目。返回 generationId，可交 prepare_card_changes，免于抄写生成结果。', {
    book: string, entries: { type: 'array', items: { type: 'object', properties: { base: string, name: string, content: string, keys: strings, secondary_keys: strings, constant: { type: 'boolean' }, enabled: { type: 'boolean' }, insertion_order: { type: 'number' }, position: string, extensions: object }, required: ['base', 'name', 'content', 'keys'] } },
  }, ['book', 'entries']),
  tool('generate_mvu', '生成 MVU 全套源文件草稿：禁用的 InitVar、变量列表、更新规则、JSONPatch 格式、Zod 注册脚本和正则状态栏。仅生成，不执行或写入。先确定用户所需变量；复杂嵌套结构应自行编写完整文件交 prepare_card_changes，不强行简化成示例。', {
    book: string, definition: { type: 'object', properties: { groups, title: string, varName: string, placeholder: string }, required: ['groups'] }, replaceGenerated: { type: 'boolean', description: '仅用户要求更新已有同名生成脚本时为 true；保留自定义扩展和脚本。' },
  }, ['definition']),
  tool('generate_ejs', '生成 EJS 阶段控制器或状态栏世界书配对草稿，不执行。controller 与 statusbar 至少给一项。', {
    book: string, controller: { type: 'object', properties: { varPath: string, varName: string, default: {}, title: string, stages: { type: 'array', items: { type: 'object', properties: { max: { type: 'number' }, entry: string }, required: ['entry'] } } }, required: ['varPath', 'stages'] },
    statusbar: { type: 'object', properties: { title: string, varName: string, groups }, required: ['groups'] },
  }),
  tool('prepare_card_changes', '准备可确认的完整修改稿，程序在本轮答复附上所有文件的完整内容。支持正文、世界书、脚本/正则的 extra.json。generatedIds 引用本轮生成结果，files 为补充文件；只改列出的文件，保留其余内容。下一条用户明确同意后才能 apply。', {
    summary: string, generatedIds: strings, files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: string, content: string }, required: ['path', 'content'] } },
  }, ['summary']),
  tool('apply_card_changes', '仅当本轮用户明确同意写入上一轮展示的同一份完整稿时应用；confirmation 必须逐字引用本轮用户消息。含否定、改稿、问题或未满足条件时不可调用。不能批准本轮新稿，不能在重试中重复保存。', { proposalId: string, confirmation: string }, ['proposalId', 'confirmation']),
  tool('check_card', '检查当前已保存的正文、世界书和角色卡结构，返回真实错误与警告。'),
  tool('diagnose_card', '静态诊断世界书、MVU、EJS、正则和脚本接线；不运行代码，不等于酒馆验收。'),
  tool('export_card', '用户要求导出/打包时，检查并生成当前已保存内容的 card.png 与 card.json，返回真实文件。未保存草稿不进入成品；缺少必填内容时返回错误，不能声称成功。'),
];

// 模型负责理解上下文；服务端仍拒绝明显的否定、疑问、条件与引用，不能把任意原话当许可。
export function isExplicitCardWriteRequest(text) {
  if (typeof text !== 'string' || text.length > 500) return false;
  // “完整修改稿”指已展示的稿件；句末“不再扩写”约束保存范围，并未否定写入。
  const value = text.trim().replace(/^我(?=确认|同意)/, '')
    .replace(/((?:刚才|上面|上一轮)展示的|这份|这版)完整修改稿(?=[，,。；;\s]|写入|保存|落盘|应用|$)/g, '$1完整稿')
    .replace(/[，,。；;]\s*不再扩写[。.]?$/, '');
  if (/(?:吗|么|呢)(?:[。！!\s]|$)|(?:改成|改为|修改|调整|替换|补充|增加|删掉|删除|润色|重写|优化)/.test(value)) return false;
  if (/[?？“”「」『』`"\n]/.test(value) || /(?:不|别|暂缓|暂时|稍后|待会|以后|如果|假如|除非|等我|后再|是否|能否|可否|为什么|怎么|什么意思|先.{0,12}(?:改|调整|解释|检查)|(?:还|需要|要)(?:修改|调整)|(?:他说|她说|有人说))/.test(value)) return false;
  return /(?:写入|保存|落盘|应用)/.test(value)
    && /^(?:确认|同意|可以|按|照|就|请|帮我|直接|这版|这一版|写入|保存|应用)/.test(value);
}

export function assertSourceFile(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || /[\0-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part))) throw new Error('源文件路径无效');
  const valid = ['index.yaml', 'extra.json'].includes(value)
    || TEXT_FIELDS.some(key => value === 'text/' + key + '.md')
    || /^greetings\/[^/]+\.md$/.test(value) || /^worldbook\/[^/]+\/[^/]+\.(md|yaml)$/.test(value);
  if (!valid) throw new Error('路径不属于当前卡可编辑的源文件：' + value);
  value.split('/').forEach(part => safeName(part));
  return value;
}

export function validateSourceChanges(files, source) {
  if (!Array.isArray(files) || !files.length || files.length > 80) throw new Error('修改稿需要 1–80 个文件');
  const seen = new Set();
  let bytes = 0;
  for (const file of files) {
    assertSourceFile(file?.path);
    const canonical = file.path.toLowerCase();
    if (seen.has(canonical)) throw new Error('修改稿包含重复路径：' + file.path);
    seen.add(canonical);
    if (typeof file.content !== 'string' || file.content.includes('\u0000')) throw new Error('文件内容必须为文本');
    bytes += Buffer.byteLength(file.content);
    if (bytes > 180000) throw new Error('本轮修改稿过大，请拆分模块');
    if (file.path.endsWith('.json')) requireObject(JSON.parse(file.content), 'extra.json');
    if (file.path.endsWith('.yaml')) parseYaml(file.content);
  }
  const merged = { ...source, ...Object.fromEntries(files.map(file => [file.path, file.content])) };
  for (const file of files.filter(file => file.path.startsWith('worldbook/'))) {
    const base = file.path.replace(/\.(md|yaml)$/, '');
    if (base.endsWith('/_book')) continue;
    if (!Object.hasOwn(merged, base + '.md') || !Object.hasOwn(merged, base + '.yaml')) throw new Error('世界书缺少配对正文或配置：' + base);
    const side = parseYaml(merged[base + '.yaml']);
    if (side.enabled !== false && side.constant !== true && !(Array.isArray(side.keys) && side.keys.some(key => typeof key === 'string' && key.trim()))) throw new Error('世界书条目缺少触发词：' + base);
  }
  return files.map(({ path, content }) => ({ path, content }));
}

function bookEntry(book, base, content, metadata, source, constant = true) {
  const root = 'worldbook/' + safeName(book) + '/' + safeName(base);
  const previous = source[root + '.yaml'] ? parseYaml(source[root + '.yaml']) : {};
  return [{ path: root + '.md', content }, { path: root + '.yaml', content: dumpYaml({ keys: [], constant, enabled: true, insertion_order: 100, ...previous, ...metadata }) }];
}

function validateMvu(def) {
  requireObject(def, 'MVU 定义');
  if (!Array.isArray(def.groups) || !def.groups.length || def.groups.length > 30) throw new Error('MVU 需要明确的变量组');
  const names = new Set();
  for (const group of def.groups) {
    if (typeof group?.name !== 'string' || !group.name.trim() || /[.\[\]\/]/.test(group.name) || names.has(group.name)) throw new Error('变量组名称为空、重复或包含路径符号');
    names.add(group.name);
    if (!Array.isArray(group.fields) || !group.fields.length || group.fields.length > 80) throw new Error('变量组需要字段');
    const fields = new Set();
    for (const f of group.fields) {
      if (!f || typeof f.name !== 'string' || !f.name.trim() || /[.\[\]\/]/.test(f.name) || fields.has(f.name)) throw new Error('变量字段名为空、重复或包含路径符号');
      fields.add(f.name);
      if (!['string', 'number', 'boolean', 'enum', 'array', 'record'].includes(f.type)) throw new Error('不支持的变量类型：' + f.type);
      if (f.type === 'enum' && (!Array.isArray(f.values) || !f.values.length || f.values.some(value => typeof value !== 'string'))) throw new Error('枚举需要字符串选项');
      if (f.default !== undefined && (['number', 'string', 'boolean'].includes(f.type) && typeof f.default !== f.type
        || f.type === 'number' && !Number.isFinite(f.default) || f.type === 'enum' && !f.values.includes(f.default)
        || f.type === 'array' && !Array.isArray(f.default) || f.type === 'record' && (!f.default || typeof f.default !== 'object' || Array.isArray(f.default)))) throw new Error('变量默认值与类型不符：' + f.name);
      for (const key of ['itemType', 'keyType', 'valueType']) if (f[key] && !['string', 'number', 'boolean'].includes(f[key])) throw new Error('生成器不支持该嵌套类型，请使用完整结构脚本');
      if (f.min !== undefined && !Number.isFinite(f.min) || f.max !== undefined && !Number.isFinite(f.max) || f.min > f.max) throw new Error('变量范围无效');
    }
  }
}

export function generateCardParts(name, args, source) {
  const book = args.book || (name === 'generate_mvu' ? 'MVU' : '世界书');
  let files = [];
  if (name === 'generate_worldbook') {
    if (!Array.isArray(args.entries) || !args.entries.length || args.entries.length > 30) throw new Error('世界书需要 1–30 个条目');
    for (const entry of args.entries) {
      const { base, content, extensions, ...metadata } = entry;
      if (typeof content !== 'string' || !content.trim()) throw new Error('世界书正文不能为空');
      if (typeof metadata.name !== 'string' || !metadata.name.trim() || !Array.isArray(metadata.keys) || metadata.keys.some(key => typeof key !== 'string' || !key.trim())) throw new Error('世界书需要条目名与触发词数组');
      if (extensions) metadata.extensions_json = JSON.stringify(requireObject(extensions, '世界书扩展'));
      files.push(...bookEntry(book, base, content, metadata, source, false));
    }
  } else if (name === 'generate_mvu') {
    validateMvu(args.definition);
    const bundle = generateMvuBundle(args.definition);
    const extra = source['extra.json'] ? JSON.parse(source['extra.json']) : {};
    if (!args.replaceGenerated) {
      const oldScripts = extra.extensions?.tavern_helper?.scripts || [];
      const oldRegex = extra.extensions?.regex_scripts || [];
      if (bundle.tavernScripts.some(script => oldScripts.some(old => old.name === script.name && old.content !== script.content))
        || bundle.runtime.regexScripts.some(script => oldRegex.some(old => old.scriptName === script.scriptName && (old.findRegex !== script.findRegex || old.replaceString !== script.replaceString)))) {
        throw new Error('已有同名 MVU 脚本与新定义不同；确认需要更新后使用 replaceGenerated，避免新规则与旧结构混用');
      }
    }
    files.push({ path: 'extra.json', content: JSON.stringify(mergeRuntimeData(extra, bundle, { replaceGenerated: args.replaceGenerated === true }), null, 2) + '\n' });
    files.push(...bookEntry(book, '01-初始变量', bundle.initialYaml, { name: '[InitVar]初始变量', enabled: false }, source));
    files.push(...bookEntry(book, '02-变量列表', bundle.varListEntry, { name: '变量列表', insertion_order: 200 }, source));
    files.push(...bookEntry(book, '03-更新规则', bundle.updateRules, { name: '[mvu_update]变量更新规则', insertion_order: 201 }, source));
    files.push(...bookEntry(book, '04-输出格式', bundle.outputFormat, { name: '[mvu_update]变量输出格式', insertion_order: 202 }, source));
  } else if (name === 'generate_ejs') {
    if (!args.controller && !args.statusbar) throw new Error('请指定 EJS 控制器或状态栏定义');
    if (args.controller) {
      const result = generateEjsController(requireObject(args.controller, '控制器'));
      files.push(...bookEntry(book, 'EJS-阶段控制器', result.content, { ...parseYaml(result.sidecar), name: args.controller.title || '阶段控制器' }, source));
    }
    if (args.statusbar) {
      const result = generateEjsStatusBar(requireObject(args.statusbar, '状态栏'));
      files.push(...bookEntry(book, 'EJS-状态栏', result.content, { ...parseYaml(result.sidecar), name: args.statusbar.title || '状态栏' }, source));
    }
  } else throw new Error('未知生成工具');
  return validateSourceChanges(files, source);
}

export function proposalText(proposal) {
  return '待确认修改稿：' + proposal.summary + '\n\n' + proposal.files.map(file => {
    const longest = Math.max(2, ...(file.content.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return file.path + '\n' + fence + '\n' + file.content + '\n' + fence;
  }).join('\n\n') + '\n\n以上内容尚未写入。确认这份稿后，告诉我写入即可。';
}
