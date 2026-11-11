import { runCharacterScript } from './sandbox.mjs';
import { validateVariables } from './variables.mjs';

export function seededRandom(seed = 1) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => { state += 0x6D2B79F5; let n = state; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}

export function substituteMacros(source, context) {
  const { variables, character, userName = '对话者', history = [], latestInput = '', random = Math.random, trace = [] } = context;
  function keys(path) { const result = path.split('.').filter(Boolean); if (result.some(key => ['__proto__','prototype','constructor'].includes(key))) throw new Error('宏变量路径包含禁止字段。'); return result; }
  const get = path => keys(path).reduce((object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined, variables);
  function set(path, value) { const parts = keys(path); if (!parts.length) throw new Error('宏变量路径不能为空。'); let object = variables; for (const key of parts.slice(0, -1)) { if (!object[key] || typeof object[key] !== 'object') object[key] = {}; object = object[key]; } object[parts.at(-1)] = value; }
  const display = value => value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return String(source).replace(/{{([^{}]*?)}}/g, (whole, expression) => {
    const [command, ...args] = expression.split('::'), name = command.trim().toLowerCase();
    try {
      const basic = { char: character.name, user: userName, description: character.description, personality: character.personality, scenario: character.scenario, lastmessage: history.at(-1)?.content ?? latestInput, lastusermessage: latestInput, lastcharmessage: history.findLast(message => message.role === 'assistant')?.content ?? '', lastmessageid: history.length - 1, newline: '\n', trim: '', noop: '' };
      if (Object.hasOwn(basic, name)) return display(basic[name]);
      if (name.startsWith('//')) return '';
      if (['getvar','get_message_variable','get_chat_variable'].includes(name)) return display(get(args[0] ?? ''));
      if (['setvar','set_message_variable','set_chat_variable'].includes(name)) { let value = args.slice(1).join('::'); try { value = JSON.parse(value); } catch {} set(args[0], value); validateVariables(variables); return ''; }
      if (['incvar','decvar','addvar'].includes(name)) { set(args[0], Number(get(args[0]) ?? 0) + (name === 'decvar' ? -1 : 1) * Number(args[1] ?? 1)); return name === 'addvar' ? '' : display(get(args[0])); }
      if (name === 'random' || name === 'pick') return args[Math.floor(random() * args.length)] ?? '';
      if (name === 'roll') { const match = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(args[0] ?? '1d6'); if (!match) throw new Error('骰子格式无效。'); const count = Math.min(100, Number(match[1] || 1)), sides = Math.min(1000000, Number(match[2])); let value = Number(match[3] || 0); for (let i = 0; i < count; i++) value += 1 + Math.floor(random() * sides); return String(value); }
      trace.push({ type: 'macro', reason: 'unsupported', macro: command }); return whole;
    } catch (error) { trace.push({ type: 'macro', error: error.message }); return ''; }
  });
}

export async function applyRegex(source, scripts, { placement = 2, destination = 'display', depth = 0, edited = false, context } = {}) {
  const trace = []; let output = String(source);
  for (const script of scripts ?? []) {
    if (script.disabled || !(script.placement ?? [2]).includes(placement) || (edited && !script.runOnEdit)) continue;
    if ((script.minDepth != null && depth < script.minDepth) || (script.maxDepth != null && script.maxDepth >= 0 && depth > script.maxDepth)) continue;
    if (destination === 'prompt' && script.markdownOnly && !script.promptOnly) continue;
    if (destination === 'display' && script.promptOnly && !script.markdownOnly) continue;
    try {
      const pattern = script.substituteRegex && context ? substituteMacros(script.findRegex ?? '', context) : String(script.findRegex ?? '');
      const replacement = context ? substituteMacros(script.replaceString ?? '', context) : String(script.replaceString ?? '');
      const result = await runCharacterScript(String.raw`const pattern=${JSON.stringify(pattern)}; const literal=/^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(pattern); const regex=literal?new RegExp(literal[1],literal[2]):new RegExp(pattern,'g'); const trims=${JSON.stringify(script.trimStrings ?? [])}; return ${JSON.stringify(output)}.replace(regex,(...args)=>{const matched=args[0]; let value=${JSON.stringify(replacement)}.replace(/\{\{match\}\}/gi,()=>matched).replace(/\$\$|\$&|\$\d{1,2}/g, token=>token==='$$'?'$':token==='$&'?matched:String(args[Number(token.slice(1))]??'')); for(const trim of trims)value=value.split(trim).join(''); return value;});`, {});
      output = String(result.result); trace.push({ type: 'regex', name: script.scriptName ?? script.id ?? '', destination, applied: true });
    } catch (error) { trace.push({ type: 'regex', name: script.scriptName ?? '', error: error.message }); }
  }
  return { text: output, trace };
}

export function extractHtml(source) {
  const html = [];
  let text = source.replace(/```(?:html)?\s*\n([\s\S]*?)```/gi, (whole, body) => {
    if (!/<[a-z][\s\S]*>/i.test(body)) return whole;
    html.push({ html: body.trim(), source: 'code-block' }); return '';
  });
  if (/<(?:html|body|div|style|script|details|section|article|table|svg)\b/i.test(text)) {
    html.push({ html: text, source: 'output' });
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').trim();
  }
  return { text, html };
}
