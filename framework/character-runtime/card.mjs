import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';

export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = value => typeof value === 'string' ? value : '';
export const list = value => Array.isArray(value) ? value : record(value) ? Object.values(value) : [];
const words = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map(String).filter(Boolean);
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const MAX_CARD = 16 * 1024 * 1024;

export const RUNTIME_CAPABILITIES = Object.freeze({
  supported: ['角色卡 JSON v1/v2/v3 与 PNG 元数据', '角色字段与开场白、示例对话、历史后指令', '世界书关键词、四种次条件、递归、概率、扫描深度、插入深度与字符预算', '宿主传入的外部世界书', 'EJS 代码、条件、循环、异步局部助手', 'MVU 原生命令、官方 JSONPatch 与 RFC 6902', '正则显示/提示词分流、HTML 状态栏输出'],
  partial: ['Tavern Helper：当前会话变量/消息副本、世界书读取、事件、提示词注入', 'EJS：当前会话作用域；每条模板独立编译', 'HTML：由工作台 iframe 桥接当前预演变量与消息'],
  unsupported: ['宿主 DOM、网络、Node.js、模块导入、远程脚本与 CDN', '完整 STScript、模型生成/预设修改/全局世界书写入 API', '跨条目 EJS 共享词法作用域、世界书 token 预算、向量触发、组竞选与 sticky/cooldown/delay', '完整 lodash/jQuery/zod/Vue API 与长期后台脚本生命周期'],
});

export function decodeCharacterPng(input) {
  const bytes = Buffer.from(input);
  if (bytes.length > MAX_CARD || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('角色 PNG 文件无效或超过 16 MiB。');
  const values = {};
  let offset = 8, ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据块已损坏。');
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) throw new Error('PNG 数据块长度损坏。');
    const type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('PNG CRC 校验失败，文件可能损坏。');
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const zero = data.indexOf(0), key = data.subarray(0, zero).toString('latin1');
      if (zero >= 0 && ['chara', 'ccv3'].includes(key)) {
        let payload;
        if (type === 'tEXt') payload = data.subarray(zero + 1);
        else if (type === 'zTXt') {
          if (data[zero + 1] !== 0) throw new Error('不支持的 PNG 压缩方式。');
          payload = inflateSync(data.subarray(zero + 2), { maxOutputLength: MAX_CARD });
        } else {
          const languageEnd = data.indexOf(0, zero + 3), translatedEnd = data.indexOf(0, languageEnd + 1);
          if (languageEnd < 0 || translatedEnd < 0 || data[zero + 2] !== 0) throw new Error('PNG iTXt 字段已损坏。');
          payload = data[zero + 1] === 1 ? inflateSync(data.subarray(translatedEnd + 1), { maxOutputLength: MAX_CARD }) : data.subarray(translatedEnd + 1);
        }
        const encoded = payload.toString('utf8').trim();
        values[key] = JSON.parse(encoded.startsWith('{') ? encoded : Buffer.from(encoded, 'base64').toString('utf8'));
      }
    }
    offset = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || !record(values.ccv3 ?? values.chara)) throw new Error('PNG 中没有完整的角色卡元数据。');
  return values.ccv3 ?? values.chara;
}

export function parseCharacterFile({ name = '', base64 }) {
  if (typeof base64 !== 'string' || base64.length > MAX_CARD * 1.4) throw new Error('角色卡文件内容无效或过大。');
  const bytes = Buffer.from(base64, 'base64');
  return /\.png$/i.test(name) || bytes[0] === 137 ? decodeCharacterPng(bytes) : JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

export function normalizeWorldbook(book = {}, name = 'character') {
  return list(book.entries ?? book).filter(record).map((entry, index) => {
    const extra = entry.extensions ?? {}, strategy = entry.strategy ?? {}, placement = record(entry.position) ? entry.position : {};
    const logic = entry.selectiveLogic ?? entry.selective_logic ?? extra.selectiveLogic ?? strategy.keys_secondary?.logic ?? 0;
    const positions = { before_character_definition: 0, after_character_definition: 1, before_author_note: 2, after_author_note: 3, at_depth: 4, depth: 4, before_example_messages: 5, after_example_messages: 6, before_char: 0, after_char: 1 };
    const position = placement.type ?? entry.position ?? extra.position ?? 1;
    const positionId = positions[position] ?? position;
    return {
      uid: String(entry.uid ?? entry.id ?? index), index, book: name, source: `${name}:${entry.uid ?? entry.id ?? index}`,
      comment: text(entry.comment ?? entry.name), content: text(entry.content),
      keys: words(entry.keys ?? entry.key ?? strategy.keys), secondaryKeys: words(entry.secondary_keys ?? entry.keysecondary ?? strategy.keys_secondary?.keys),
      secondaryLogic: ({ and_any: 0, not_all: 1, not_any: 2, and_all: 3 })[logic] ?? logic,
      selective: entry.selective !== false, enabled: entry.enabled !== false && entry.disable !== true,
      constant: entry.constant === true || strategy.type === 'constant', order: finite(placement.order ?? entry.insertion_order ?? entry.order ?? extra.order, index),
      position: positionId, depth: Math.max(0, finite(placement.depth ?? entry.depth ?? extra.depth, 4)),
      role: ['system', 'user', 'assistant'].includes(placement.role) ? placement.role : ['system', 'user', 'assistant'][entry.role ?? extra.role ?? 0] ?? 'system',
      probability: Math.max(0, Math.min(100, finite(entry.probability ?? extra.probability, 100))),
      useProbability: entry.useProbability ?? extra.useProbability ?? true,
      scanDepth: Math.max(0, finite(strategy.scan_depth ?? entry.scanDepth ?? extra.scan_depth ?? extra.scanDepth ?? book.scan_depth, 2)),
      caseSensitive: entry.case_sensitive ?? extra.case_sensitive ?? extra.caseSensitive ?? false,
      wholeWords: entry.matchWholeWords ?? extra.matchWholeWords ?? false,
      useRegex: entry.use_regex ?? extra.useRegex ?? false,
      recursive: book.recursive_scanning ?? true,
      excludeRecursion: entry.excludeRecursion ?? extra.excludeRecursion ?? entry.recursion?.prevent_incoming ?? false,
      preventRecursion: entry.preventRecursion ?? extra.preventRecursion ?? entry.recursion?.prevent_outgoing ?? false,
      delayUntilRecursion: finite(entry.delayUntilRecursion ?? extra.delayUntilRecursion ?? entry.recursion?.delay_until, 0),
      raw: structuredClone(entry),
    };
  });
}

export function parseCharacter(character) {
  if (character?.runtimeVersion === 1) return structuredClone(character);
  if (Buffer.isBuffer(character) || character instanceof Uint8Array) character = decodeCharacterPng(character);
  if (typeof character === 'string') { try { character = JSON.parse(character); } catch { throw new Error('角色 JSON 格式无效。'); } }
  if (!record(character)) throw new Error('角色资料必须是 JSON 对象。');
  const raw = structuredClone(record(character.raw) ? character.raw : character);
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_CARD) throw new Error('角色资料超过 16 MiB。');
  const card = record(raw.data) ? raw.data : raw, ext = card.extensions ?? {};
  const name = text(card.name ?? card.char_name ?? character.name).trim();
  if (!name) throw new Error('角色资料缺少名字。');
  const scripts = [];
  function collectScripts(items) {
    for (const item of list(items)) {
      if (record(item) && (item.type === 'folder' || Array.isArray(item.scripts))) collectScripts(item.scripts ?? item.value);
      else if (record(item) && typeof (item.content ?? item.code) === 'string') scripts.push({ ...structuredClone(item), content: item.content ?? item.code });
    }
  }
  collectScripts(ext.tavern_helper?.scripts ?? ext.TavernHelper_scripts ?? ext.scripts);
  const unsupportedFeatures = [];
  if (scripts.length) unsupportedFeatures.push('卡内脚本仅支持工作台公布的 Tavern Helper API 子集');
  const worldbook = normalizeWorldbook(card.character_book, 'character');
  if (worldbook.some(e => e.raw.group || e.raw.extensions?.group || e.raw.effect || e.raw.vectorized)) unsupportedFeatures.push('世界书组竞选、向量触发与时间效果未实现');
  if (JSON.stringify(raw).includes('@@')) unsupportedFeatures.push('仅支持 @@private / @@if / @@activate / @@dont_activate / @@initial_variables / @@generate_before / @@generate_after / @@render_before / @@render_after / @@iframe');
  return {
    runtimeVersion: 1, characterId: character.id ?? createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 16), revision: Number.isSafeInteger(character.revision) ? character.revision : 1, name,
    hash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'), raw,
    description: text(card.description ?? card.char_persona ?? character.description), personality: text(card.personality), scenario: text(card.scenario ?? card.world_scenario),
    firstMessage: text(card.first_mes ?? card.first_message ?? card.char_greeting), alternateGreetings: list(card.alternate_greetings).map(text),
    exampleMessages: text(card.mes_example ?? card.example_dialogue), systemPrompt: text(card.system_prompt), postHistoryInstructions: text(card.post_history_instructions),
    promptOrder: [...new Set([...list(ext.workbench?.prompt_order).filter(key => ['description','personality','scenario','system_prompt','mes_example'].includes(key)), 'description','personality','scenario','system_prompt','mes_example'])],
    worldbook, externalWorldbooks: words(ext.world).concat(words(ext.extra_worldbooks)), scripts,
    regex: list(ext.regex_scripts).filter(record).map(value => structuredClone(value)),
    compatibility: unsupportedFeatures.length ? 'limited' : 'supported', unsupportedFeatures,
    compatibilityDetails: structuredClone(RUNTIME_CAPABILITIES),
  };
}
