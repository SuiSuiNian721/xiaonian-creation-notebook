import { createHash } from 'node:crypto';
import { WorkbenchError } from './contracts.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value.trim() : '';
const strings = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map(string).filter(Boolean);
const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function worldbook(card) {
  const entries = card.character_book?.entries;
  const source = Array.isArray(entries) ? entries : record(entries) ? Object.values(entries) : [];
  return source.flatMap((entry, index) => {
    if (!record(entry) || !string(entry.content)) return [];
    const logic = entry.selectiveLogic ?? entry.selective_logic ?? entry.extensions?.selectiveLogic ?? 0;
    return [{
      uid: String(entry.uid ?? entry.id ?? index), index,
      comment: string(entry.comment ?? entry.name), content: string(entry.content),
      keys: strings(entry.keys ?? entry.key), secondaryKeys: strings(entry.secondary_keys ?? entry.keysecondary),
      secondaryLogic: [0, 1, 2, 3].includes(logic) ? logic : null,
      selective: entry.selective !== false,
      enabled: entry.enabled !== false && entry.disable !== true,
      constant: entry.constant === true,
      order: number(entry.insertion_order ?? entry.order ?? entry.display_index ?? entry.displayIndex, index),
    }];
  });
}

function unsupported(raw, card) {
  const found = new Set();
  const pending = [raw];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if (!record(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (/^(mvu|mvu_config|variable_schema)$/i.test(key)) found.add('MVU 变量系统');
      if (/^(tavern_helper|scripts?|javascript)$/i.test(key)) found.add('JavaScript / Tavern Helper 脚本');
      if (key === 'regex_scripts') found.add('酒馆正则');
      if (typeof child === 'string') {
        if (/<%[=-]?/.test(child)) found.add('EJS 模板');
        if (/<script\b|javascript:/i.test(child)) found.add('JavaScript / HTML 状态栏');
        if (/\[mvu_(?:plot|update)\]|\[initvar\]|\b(?:getvar|setvar|insert_or_assign)\s*\(/i.test(child)) found.add('MVU 变量系统');
        if (/^\s*@@/m.test(child)) found.add('世界书动态指令');
        for (const match of child.matchAll(/{{([^{}]+)}}/g)) {
          if (!/^\s*(?:char|user)\s*$/i.test(match[1])) found.add('除 {{char}}、{{user}} 外的宏');
        }
      } else if (child && typeof child === 'object') pending.push(child);
    }
  }
  if (string(card.extensions?.world)) found.add('外部世界书引用（未由宿主提供）');
  if (card.character_book?.recursive_scanning === true) found.add('世界书递归扫描');
  const entries = card.character_book?.entries;
  for (const entry of Array.isArray(entries) ? entries : record(entries) ? Object.values(entries) : []) {
    if (!record(entry)) continue;
    const extra = entry.extensions ?? {};
    if ((entry.probability ?? extra.probability ?? 100) !== 100 || entry.useProbability === true || extra.useProbability === true) found.add('世界书概率触发');
    if (entry.position !== undefined && !['before_char', 'after_char', 0, 1].includes(entry.position)) found.add('世界书特殊插入位置');
    if (extra.depth !== undefined || entry.depth !== undefined) found.add('世界书深度插入');
    if (entry.use_regex === true || extra.useRegex === true) found.add('世界书正则关键词');
    const logic = entry.selectiveLogic ?? entry.selective_logic ?? extra.selectiveLogic ?? 0;
    if (![0, 1, 2, 3].includes(logic)) found.add('世界书未识别的次关键词条件');
  }
  return [...found];
}

/** 只消费宿主提供的 JSON，不读取路径、不执行卡内脚本。 */
export function parseQQCharacter(character) {
  if (!record(character) || typeof character.id !== 'string' || !Number.isSafeInteger(character.revision)) throw new WorkbenchError(400, 'QQ 角色需要宿主的标识与版本。');
  const raw = record(character.raw) ? structuredClone(character.raw) : {};
  const card = record(raw.data) ? raw.data : raw;
  const name = string(card.name ?? card.char_name) || string(character.name);
  if (!name) throw new WorkbenchError(400, '角色资料缺少名字。');
  const unsupportedFeatures = unsupported(raw, card);
  return {
    characterId: character.id, revision: character.revision, name,
    hash: createHash('sha256').update(JSON.stringify({ id: character.id, revision: character.revision, name: character.name, description: character.description, raw })).digest('hex'),
    description: string(card.description) || string(character.description),
    personality: string(card.personality), scenario: string(card.scenario),
    firstMessage: string(card.first_mes ?? card.first_message),
    exampleMessages: string(card.mes_example ?? card.example_dialogue),
    systemPrompt: string(card.system_prompt), postHistoryInstructions: string(card.post_history_instructions),
    worldbook: worldbook(card), unsupportedFeatures,
    compatibility: unsupportedFeatures.length ? 'limited' : 'supported',
    raw,
  };
}

export function substituteQQMacros(content, characterName, userName) {
  return content.replace(/{{\s*char\s*}}/gi, () => characterName).replace(/{{\s*user\s*}}/gi, () => userName);
}

function matches(entry, input) {
  if (!entry.enabled) return false;
  if (entry.constant) return true;
  const has = keyword => input.includes(keyword.toLocaleLowerCase('zh-CN'));
  if (!entry.keys.some(has)) return false;
  if (!entry.selective || !entry.secondaryKeys.length) return true;
  const any = entry.secondaryKeys.some(has), all = entry.secondaryKeys.every(has);
  return entry.secondaryLogic === 0 ? any : entry.secondaryLogic === 1 ? !all : entry.secondaryLogic === 2 ? !any : entry.secondaryLogic === 3 ? all : false;
}

export function renderQQCharacter(card, { userName = '对话者', latestInput = '', worldbookBudgetChars = 6000 } = {}) {
  const substitute = value => substituteQQMacros(value, card.name, userName);
  const profile = [
    ['角色设定', card.description], ['性格', card.personality], ['当前情境', card.scenario],
    ['系统补充', card.systemPrompt], ['对话风格参考', card.exampleMessages],
  ].filter(([, content]) => content).map(([title, content]) => `${title}：\n${substitute(content)}`).join('\n\n');
  let lore = '';
  const candidates = card.worldbook.filter(entry => matches(entry, latestInput.toLocaleLowerCase('zh-CN'))).sort((a, b) => a.order - b.order || a.index - b.index);
  for (const entry of candidates) {
    const rendered = substitute((entry.comment ? `【${entry.comment}】\n` : '') + entry.content);
    const next = lore ? `${lore}\n\n${rendered}` : rendered;
    if (next.length <= Math.max(0, worldbookBudgetChars)) lore = next;
  }
  return { profile: [profile, card.postHistoryInstructions ? `历史后指令：\n${substitute(card.postHistoryInstructions)}` : ''].filter(Boolean).join('\n\n'),
    postHistoryInstructions: substitute(card.postHistoryInstructions), opening: substitute(card.firstMessage), lore };
}
