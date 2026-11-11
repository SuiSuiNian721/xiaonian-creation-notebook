import { parseCharacter, normalizeWorldbook, record, list, RUNTIME_CAPABILITIES } from './card.mjs';
import { runCharacterScript, renderTemplate } from './sandbox.mjs';
import { parseInitialVariables, mergeDefaults, processVariableBlocks, validateVariables } from './variables.mjs';
import { substituteMacros, applyRegex, extractHtml, seededRandom } from './text.mjs';
export { parseCharacter, parseCharacterFile, decodeCharacterPng, RUNTIME_CAPABILITIES } from './card.mjs';
export { runCharacterScript } from './sandbox.mjs';
export { applyVariablePatch } from './variables.mjs';

function externalBooks(value) {
  if (Array.isArray(value)) return value.filter(record);
  return Object.entries(value ?? {}).map(([name, book]) => ({ ...book, name }));
}

const messageText = message => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : typeof message.message === 'string' ? message.message : '';

function decorators(entry) {
  const flags = {}, unknown = [];
  const content = entry.content.replace(/^@@([a-z_]+)(?:[ \t]+([^\r\n]*))?[ \t]*\r?\n?/gm, (line, name, value) => {
    if (['private','if','activate','dont_activate','initial_variables','generate_before','generate_after','render_before','render_after','iframe'].includes(name)) flags[name] = value ?? true;
    else unknown.push(name);
    return '';
  });
  if (/^\[GENERATE:BEFORE\]/i.test(entry.comment)) flags.generate_before = true;
  if (/^\[GENERATE:AFTER\]/i.test(entry.comment)) flags.generate_after = true;
  if (/^\[RENDER:BEFORE\]/i.test(entry.comment)) flags.render_before = true;
  if (/^\[RENDER:AFTER\]/i.test(entry.comment)) flags.render_after = true;
  return { flags, unknown, content };
}

function acceptScriptResult(context, result) {
  context.variables = validateVariables(result.variables);
  if (result.actions.some(action => ['messages-updated', 'messages-created', 'messages-deleted'].includes(action.type))) {
    context.history = result.messages.map(({ message_id, message, ...entry }) => Object.hasOwn(entry, 'content') ? entry : { ...entry, content: message ?? '' });
  }
}

async function scriptsFor(card, context, events = [], lifecycle = {}) {
  const actions = [], trace = [];
  if (!card.scripts.length) return { actions, trace };
  if (!context.settings.scriptsEnabled) return { actions, trace: [{ type: 'scripts', reason: 'scripts-disabled', count: card.scripts.length }] };
  try {
    const result = await runCharacterScript('', { ...context, character: card, messages: context.history, scripts: card.scripts.filter(script => script.enabled !== false), events, ...lifecycle });
    acceptScriptResult(context, result);
    actions.push(...result.actions); trace.push(...result.trace);
    return { actions, trace, text: result.text };
  } catch (error) { trace.push({ type: 'script', error: error.message }); return { actions, trace }; }
}

async function rendered(content, context, source) {
  try {
    let value = substituteMacros(content, context);
    if (value.includes('<%')) {
      if (context.settings.templatesEnabled === false) { context.trace.push({ type: 'template', source, reason: 'templates-disabled' }); return ''; }
      const result = await renderTemplate(value, { ...context, messages: context.history });
      value = result.text; acceptScriptResult(context, result); context.trace.push(...result.trace); context.actions.push(...result.actions);
    }
    return substituteMacros(value, context);
  } catch (error) { context.trace.push({ type: 'template', source, error: error.message }); return ''; }
}

async function keywordMatches(keyword, haystack, entry, context) {
  const key = substituteMacros(keyword, context);
  if (!key) return false;
  if (entry.useRegex || /^\/[\s\S]*\/[gimsuy]*$/.test(key)) {
    try {
      const result = await runCharacterScript(String.raw`const value=${JSON.stringify(key)};const m=/^\/([\s\S]*)\/([gimsuy]*)$/.exec(value);return new RegExp(m?m[1]:value,m?m[2]:${JSON.stringify(entry.caseSensitive ? '' : 'i')}).test(${JSON.stringify(haystack)});`);
      return result.result === true;
    } catch (error) { context.trace.push({ type: 'worldbook', source: entry.source, error: error.message }); return false; }
  }
  const normalized = entry.caseSensitive ? haystack : haystack.toLocaleLowerCase('zh-CN'), needle = entry.caseSensitive ? key : key.toLocaleLowerCase('zh-CN');
  if (!entry.wholeWords) return normalized.includes(needle);
  let at = -1;
  while ((at = normalized.indexOf(needle, at + 1)) >= 0) {
    const word = char => char != null && /[\p{L}\p{N}_]/u.test(char);
    if (!word(normalized[at - 1]) && !word(normalized[at + needle.length])) return true;
  }
  return false;
}

export async function renderCharacter(character, options = {}) {
  const card = parseCharacter(character), settings = options.settings ?? {};
  const books = externalBooks(options.worldbooks ?? settings.worldbooks ?? []);
  const context = { character: card, settings, variables: validateVariables(structuredClone(options.variables ?? {})), history: structuredClone(options.history ?? []), userName: options.userName ?? '对话者', latestInput: options.latestInput ?? '', worldbooks: books, random: seededRandom(options.seed ?? `${card.hash}:${options.latestInput ?? ''}:${options.history?.length ?? 0}`), trace: [], actions: [] };
  const entries = [...card.worldbook, ...books.filter(book => book.enabled !== false).flatMap(book => normalizeWorldbook(book, book.name ?? 'external'))];
  if (entries.length > 2000) throw new Error('世界书条目超过 2000 项。');
  for (const name of card.externalWorldbooks) if (!books.some(book => book.name === name)) context.trace.push({ type: 'worldbook', source: name, reason: 'external-missing' });
  const initialize = !context.variables.__workbenchRuntimeInitialized;
  const openingSource = Number.isInteger(settings.greetingIndex) && settings.greetingIndex > 0 ? card.alternateGreetings[settings.greetingIndex - 1] ?? card.firstMessage : card.firstMessage;
  if (initialize) {
    for (const entry of entries) {
      const { flags, content } = decorators(entry);
      if (/\[(?:InitVar|InitialVariables)\]/i.test(entry.comment) || flags.initial_variables) {
        try { context.variables = mergeDefaults(parseInitialVariables(content), context.variables); context.trace.push({ type: 'variables', source: entry.source, reason: 'initialized' }); }
        catch (error) { context.trace.push({ type: 'variables', source: entry.source, error: error.message }); }
      }
    }
    const initialOpening = processVariableBlocks(openingSource, context.variables, settings);
    context.variables = initialOpening.variables; context.trace.push(...initialOpening.trace);
    context.variables.__workbenchRuntimeInitialized = true;
  }
  const scripts = await scriptsFor(card, context, [{ name: 'generation_started', args: ['normal', {}, false] }], { initialized: initialize, greetingIndex: settings.greetingIndex ?? 0 });
  context.trace.push(...scripts.trace); context.actions.push(...scripts.actions);
  for (let i = 0; i < context.history.length; i++) {
    const message = context.history[i];
    if (!['user','assistant'].includes(message.role)) continue;
    const formatText = async value => {
      const result = await applyRegex(value, card.regex, { placement: message.role === 'user' ? 1 : 2, destination: 'prompt', depth: context.history.length - 1 - i, context });
      context.trace.push(...result.trace); return processVariableBlocks(result.text, context.variables).text;
    };
    if (typeof message.content === 'string') message.content = await formatText(message.content);
    else if (Array.isArray(message.content)) { for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string') part.text = await formatText(part.text); }
    else if (typeof message.message === 'string') message.message = await formatText(message.message);
  }
  const beforeMessages = [], afterMessages = [], lore = [], exampleBefore = [], exampleAfter = [];
  let used = 0, recursiveText = ''; const selected = new Set(), skipped = new Set();
  const budget = Math.max(0, Math.min(200000, Number(settings.worldbookBudgetChars ?? options.worldbookBudgetChars ?? 6000)));
  for (let pass = 0; pass < Math.min(20, entries.length + 1); pass++) {
    let activated = 0;
    for (const entry of [...entries].sort((a, b) => a.order - b.order || a.index - b.index)) {
      if (selected.has(entry.source) || skipped.has(entry.source)) continue;
      const { flags, unknown, content } = decorators(entry);
      if (/\[(?:InitVar|InitialVariables)\]/i.test(entry.comment) || flags.initial_variables) continue;
      if (!entry.enabled || flags.dont_activate || flags.render_before || flags.render_after) { skipped.add(entry.source); continue; }
      if (unknown.length) { context.trace.push({ type: 'worldbook', source: entry.source, reason: 'unsupported-decorator', directives: unknown }); skipped.add(entry.source); continue; }
      if (pass > 0 && (!entry.recursive || entry.excludeRecursion)) continue;
      if (entry.delayUntilRecursion > pass) continue;
      const scan = [...(entry.scanDepth ? context.history.slice(-entry.scanDepth) : []).map(messageText), context.latestInput, pass ? recursiveText : ''].join('\n');
      let matched = entry.constant || flags.activate;
      if (!matched) {
        for (const key of entry.keys) if (await keywordMatches(key, scan, entry, context)) { matched = true; break; }
        if (matched && entry.selective && entry.secondaryKeys.length) {
          const secondary = await Promise.all(entry.secondaryKeys.map(key => keywordMatches(key, scan, entry, context)));
          matched = entry.secondaryLogic === 0 ? secondary.some(Boolean) : entry.secondaryLogic === 1 ? !secondary.every(Boolean) : entry.secondaryLogic === 2 ? !secondary.some(Boolean) : entry.secondaryLogic === 3 ? secondary.every(Boolean) : false;
        }
      }
      if (!matched) continue;
      if (flags.if) {
        try { const condition = await runCharacterScript(`return Boolean(${flags.if});`, { ...context, messages: context.history }); if (!condition.result) { context.trace.push({ type: 'worldbook', source: entry.source, reason: 'condition' }); skipped.add(entry.source); continue; } }
        catch (error) { context.trace.push({ type: 'worldbook', source: entry.source, error: error.message }); skipped.add(entry.source); continue; }
      }
      if (entry.useProbability && context.random() * 100 >= entry.probability) { context.trace.push({ type: 'worldbook', source: entry.source, reason: 'probability' }); skipped.add(entry.source); continue; }
      let value = await rendered(content, context, entry.source);
      const regexed = await applyRegex(value, card.regex, { placement: 5, destination: 'prompt', context }); value = regexed.text; context.trace.push(...regexed.trace);
      const cost = value.length + (used ? 2 : 0);
      if (used + cost > budget) { context.trace.push({ type: 'worldbook', source: entry.source, reason: 'budget', cost, remaining: budget - used }); skipped.add(entry.source); continue; }
      used += cost; selected.add(entry.source); activated++;
      const position = flags.generate_before ? 0 : flags.generate_after ? 4 : entry.position;
      const message = { role: entry.role, content: value, position, source: entry.source };
      if (position === 0) beforeMessages.push(message);
      else if (position === 4) afterMessages.push({ ...message, depth: flags.generate_after ? 0 : entry.depth });
      else if (position === 5) exampleBefore.push(value);
      else if (position === 6) exampleAfter.push(value);
      else if (position === 1) lore.push(value);
      else { context.trace.push({ type: 'worldbook', source: entry.source, reason: 'unsupported-position', position }); continue; }
      if (!entry.preventRecursion) recursiveText += '\n' + value;
      context.trace.push({ type: 'worldbook', source: entry.source, reason: pass ? 'recursion' : entry.constant || flags.activate ? 'constant' : 'keyword', pass, position, depth: position === 4 ? message.depth ?? entry.depth : undefined, chars: value.length });
    }
    if (!activated) break;
  }
  for (const entry of entries) if (entry.enabled && !selected.has(entry.source) && !skipped.has(entry.source) && !/\[(InitVar|InitialVariables)\]/i.test(entry.comment)) context.trace.push({ type: 'worldbook', source: entry.source, reason: 'no-match' });
  const sections = [];
  const fields = { description: ['角色设定', card.description], personality: ['性格', card.personality], scenario: ['当前情境', card.scenario], system_prompt: ['系统补充', card.systemPrompt], mes_example: ['对话风格参考', card.exampleMessages] };
  for (const key of card.promptOrder) {
    if (key === 'mes_example') sections.push(...exampleBefore);
    const [title, content] = fields[key];
    if (content) sections.push(title + '：\n' + await rendered(content, context, title));
    if (key === 'mes_example') sections.push(...exampleAfter);
  }
  const postHistoryInstructions = await rendered(card.postHistoryInstructions, context, 'post-history');
  if (postHistoryInstructions) afterMessages.push({ role: 'system', content: postHistoryInstructions, depth: 0, source: 'post-history' });
  for (const action of context.actions.filter(action => action.type === 'inject-prompt')) afterMessages.push({ role: action.role ?? 'system', content: action.content, depth: action.depth ?? 0, source: `script:${action.id}` });
  const opening = await rendered(processVariableBlocks(openingSource, context.variables, settings).text, context, 'opening');
  return { profile: sections.filter(Boolean).join('\n\n'), lore: lore.join('\n\n'), opening, postHistoryInstructions, beforeMessages, afterMessages, history: context.history, variables: context.variables, trace: context.trace, actions: context.actions, compatibility: card.compatibility, compatibilityDetails: card.compatibilityDetails, html: extractHtml(opening).html };
}

export async function processCharacterOutput(text, options = {}) {
  const card = options.character ? parseCharacter(options.character) : parseCharacter({ name: '角色' });
  const settings = options.settings ?? {}, previousVariables = validateVariables(structuredClone(options.variables ?? {}));
  const changed = processVariableBlocks(text, previousVariables, settings);
  const scripted = settings.scriptsEnabled && card.scripts.some(script => script.enabled !== false);
  const context = { character: card, settings, variables: scripted ? structuredClone(previousVariables) : changed.variables, previousVariables, history: structuredClone(options.history ?? []), worldbooks: externalBooks(options.worldbooks ?? settings.worldbooks ?? []), userName: options.userName ?? '对话者', latestInput: options.latestInput??'', trace: scripted ? [] : [...changed.trace], actions: [], random: seededRandom(options.seed ?? text), runType: 'render' };
  const scripts = await scriptsFor(card, context, context.history.length ? [{ name: 'message_received', args: [context.history.length - 1] }] : [], scripted ? { variableUpdate: { text, settings: { dialect: settings.dialect ?? 'auto' } } } : {});
  if (scripted && scripts.text === undefined) { context.variables = changed.variables; context.trace.push(...changed.trace); }
  context.trace.push(...scripts.trace); context.actions.push(...scripts.actions);
  let output = scripts.text ?? changed.text;
  for (const entry of [...card.worldbook, ...context.worldbooks.filter(book=>book.enabled!==false).flatMap(book => normalizeWorldbook(book, book.name))]) {
    const { flags, content } = decorators(entry);
    if (!entry.enabled || (!flags.render_before && !flags.render_after)) continue;
    const renderedText = await rendered(content, context, entry.source);
    output = flags.render_before ? renderedText + '\n' + output : output + '\n' + renderedText;
  }
  const regexed = await applyRegex(output, card.regex, { placement: 2, destination: 'display', context });
  context.trace.push(...regexed.trace);
  const display = await rendered(regexed.text, context, 'output');
  const extracted = extractHtml(display);
  return { text: extracted.text.trim(), variables: context.variables, actions: context.actions, html: extracted.html, trace: context.trace, compatibility: card.compatibility, compatibilityDetails: RUNTIME_CAPABILITIES };
}
