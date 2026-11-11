import { getQuickJS } from 'quickjs-emscripten';
import ejs from 'ejs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { prepareVariableBlocks, applyPreparedVariableBlocks } from './variables.mjs';

// Serialized into QuickJS; the only host bridge accepts bounded JSON variable data.
function environment(input, variableBlocks) {
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const blocked = new Set(['__proto__', 'prototype', 'constructor']);
  const path = value => {
    const keys = Array.isArray(value) ? value.map(String) : String(value ?? '').replace(/\[(?:["']?)([^\]"']+)["']?\]/g, '.$1').split('.').filter(Boolean);
    if (keys.some(key => blocked.has(key))) throw new Error('变量路径包含禁止的原型字段。');
    return keys;
  };
  const get = (obj, key, fallback) => { let out = obj; for (const part of path(key)) { if (out == null || !Object.hasOwn(out, part)) return fallback; out = out[part]; } return out === undefined ? fallback : out; };
  const set = (obj, key, value) => { const keys = path(key); if (!keys.length) throw new Error('变量路径不能为空。'); let out = obj; for (let i = 0; i < keys.length - 1; i++) { const part = keys[i]; if (!out[part] || typeof out[part] !== 'object') out[part] = /^\d+$/.test(keys[i + 1]) ? [] : {}; out = out[part]; } out[keys.at(-1)] = value; return obj; };
  const unset = (obj, key) => { const keys = path(key), parent = keys.length > 1 ? get(obj, keys.slice(0, -1)) : obj; return parent ? delete parent[keys.at(-1)] : false; };
  const merge = (target, source, overwrite = true) => { for (const [key, value] of Object.entries(source ?? {})) { path([key]); if (value && typeof value === 'object' && !Array.isArray(value)) { if (!target[key] || typeof target[key] !== 'object') target[key] = {}; merge(target[key], value, overwrite); } else if (overwrite || !Object.hasOwn(target, key)) target[key] = clone(value); } return target; };
  let variables = input.variables ?? {}, messages = input.messages ?? [], actions = [], trace = [];
  const messageText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '';
  let outputMessage = input.variableUpdate ? messages.at(-1) : null;
  const originalOutputText = outputMessage ? messageText(outputMessage.content ?? outputMessage.message) : undefined;
  const replaceMessageText = (message, value) => {
    if (typeof value !== 'string') throw new Error('消息文字必须是字符串。');
    if (Array.isArray(message.content)) {
      let replaced = false;
      message.content = message.content.flatMap(part => part?.type !== 'text' ? [part] : replaced ? [] : (replaced = true, [{ ...part, text: value }]));
      if (!replaced) message.content.unshift({ type: 'text', text: value });
    } else message.content = value;
    message.message = value;
  };
  const scope = option => { if (option?.type && !['chat', 'message'].includes(option.type)) throw new Error('不支持变量作用域：' + option.type); if (option?.scope && !['local', 'message'].includes(option.scope)) throw new Error('不支持变量作用域：' + option.scope); if (option?.message_id != null && !['latest', -1, messages.length - 1].includes(option.message_id)) throw new Error('只支持当前消息变量。'); };
  const api = {
    getVariables(option) { scope(option); return clone(variables); },
    getAllVariables() { return clone(variables); },
    replaceVariables(value, option) { scope(option); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('变量必须是对象。'); variables = clone(value); api.variables = variables; return clone(variables); },
    updateVariablesWith(updater, option) { scope(option); return api.replaceVariables(updater(clone(variables)), option); },
    insertOrAssignVariables(value, option) { scope(option); merge(variables, value); return clone(variables); },
    insertVariables(value, option) { scope(option); merge(variables, value, false); return clone(variables); },
    deleteVariable(key, option) { scope(option); return { delete_occurred: unset(variables, key), variables: clone(variables) }; },
    getvar(key, options) { scope(options); const value = key ? get(variables, key, options?.defaults) : variables; return options?.clone ? clone(value) : value; },
    setvar(key, value, options = {}) {
      if (typeof options === 'string') options = ['nx','xx','n'].includes(options) ? { flags: options } : { scope: options };
      scope(options); const previous = key ? get(variables, key) : variables;
      if (options.flags === 'nx' && previous !== undefined || options.flags === 'xx' && previous === undefined) return undefined;
      if (options.flags && !['nx','xx','n'].includes(options.flags)) throw new Error('不支持 setvar flags：' + options.flags);
      if (options.merge && value && typeof value === 'object') value = merge(clone(previous ?? {}), value);
      if (key == null) api.replaceVariables(value); else set(variables, key, value);
      return options.results === 'old' ? previous : options.results === 'fullcache' ? clone(variables) : value;
    },
    incvar(key, value = 1, options = {}) { const next = Number(api.getvar(key, options) ?? 0) + Number(value); return api.setvar(key, Math.max(options.min ?? -Infinity, Math.min(options.max ?? Infinity, next)), options); },
    decvar(key, value = 1, options) { return api.incvar(key, -value, options); },
    delvar(key) { return unset(variables, key); },
    getCharData() { return clone(input.character?.raw?.data ?? input.character?.raw ?? input.character ?? {}); },
    getchar() { return api.getCharData(); },
    getChatMessages(range = '0-{{lastMessageId}}') {
      if (typeof range === 'number' || /^-?\d+$/.test(range)) { const index = Number(range); return clone([messages.at(index)].filter(Boolean)); }
      const match = /^(\d+)-(\d+|{{lastMessageId}})$/.exec(range);
      if (!match) throw new Error('不支持的消息范围：' + range);
      return clone(messages.slice(Number(match[1]), match[2] === '{{lastMessageId}}' ? undefined : Number(match[2]) + 1));
    },
    getChatMessage(index) { return api.getChatMessages(index)[0]; },
    setChatMessages(updates) { for (const update of updates) { const target = messages.at(update.message_id); if (!target) throw new Error('消息不存在：' + update.message_id); Object.assign(target, clone(update)); if (Object.hasOwn(update, 'message') && !Object.hasOwn(update, 'content')) replaceMessageText(target, update.message); else target.message = messageText(target.content); } actions.push({ type: 'messages-updated', updates: clone(updates) }); },
    createChatMessages(additions) { for (const message of additions) { const next = { ...clone(message), message_id: messages.length }; if (!Object.hasOwn(next, 'content')) next.content = next.message ?? ''; next.message = messageText(next.content); messages.push(next); } actions.push({ type: 'messages-created', messages: clone(additions) }); },
    deleteChatMessages(ids) { messages = messages.filter(message => !ids.includes(message.message_id)); messages.forEach((message, i) => { message.message_id = i; }); actions.push({ type: 'messages-deleted', ids }); },
    getLastMessageId() { return messages.length - 1; },
    getCurrentMessageId() { return messages.length - 1; },
    getWorldbook(name) { const book = (input.worldbooks ?? []).find(book => book.name === name); if (!book) throw new Error('世界书未由宿主提供：' + name); return clone(Array.isArray(book.entries) ? book.entries : Object.values(book.entries ?? {})); },
    getWorldbookNames() { return (input.worldbooks ?? []).map(book => book.name); },
    getwi(name, title) { const item = api.getWorldbook(name).find(item => (item.name ?? item.comment) === title); return item?.content ?? ''; },
    injectPrompt(id, content, order = 100) { actions.push({ type: 'inject-prompt', id, content: String(content), order }); },
    injectPrompts(prompts) { for (const prompt of prompts) actions.push({ type: 'inject-prompt', ...clone(prompt) }); },
    uninjectPrompts(ids) { actions = actions.filter(action => action.type !== 'inject-prompt' || !ids.includes(action.id)); },
    getPromptsInjected(id) { return clone(actions.filter(action => action.type === 'inject-prompt' && action.id === id)); },
    hasPromptsInjected(id) { return api.getPromptsInjected(id).length > 0; },
    parseJSON: JSON.parse,
    errorCatched(fn) { return async (...args) => { try { return await fn(...args); } catch (error) { trace.push({ error: String(error.message ?? error) }); } }; },
    variables, userName: input.userName ?? '对话者', charName: input.character?.name ?? '', characterId: input.character?.characterId ?? '',
    runType: input.runType ?? 'generate', lastUserMessage: input.latestInput ?? '',
    lastCharMessage: messages.findLast(message => message.role === 'assistant')?.message ?? '', lastMessageId: messages.length - 1,
  };
  const listeners = new Map();
  const owners = new WeakMap(); let activeScript;
  const capture = () => ({ variables: clone(variables), messages: clone(messages), outputIndex: messages.indexOf(outputMessage), outputMessage: clone(outputMessage), actions: clone(actions), listeners: new Map([...listeners].map(([event, entries]) => [event, [...entries]])) });
  const restore = before => {
    api.replaceVariables(before.variables); messages = before.messages; outputMessage = messages[before.outputIndex] ?? before.outputMessage; actions = before.actions;
    listeners.clear(); for (const [event, entries] of before.listeners) listeners.set(event, entries);
  };
  const eventName = name => name === 'mag_variable_initialized' ? 'mag_variable_initiailized' : name;
  api.eventOn = (event, callback) => { event = eventName(event); const entries = listeners.get(event) ?? []; if (!entries.includes(callback)) entries.push(callback); if (activeScript) owners.set(callback, activeScript); listeners.set(event, entries); return { stop: () => api.eventRemoveListener(event, callback) }; };
  api.eventRemoveListener = (event, callback) => { event = eventName(event); listeners.set(event, (listeners.get(event) ?? []).filter(value => value !== callback)); };
  api.eventOnce = (event, callback) => { const once = async (...args) => { api.eventRemoveListener(event, once); return callback(...args); }; return api.eventOn(event, once); };
  api.eventEmit = async (event, ...args) => {
    event = eventName(event);
    const variableEvent = ['mag_variable_initiailized', 'mag_variable_update_started', 'mag_command_parsed', 'mag_variable_update_ended'].includes(event) && args[0] === variables;
    for (const callback of [...(listeners.get(event) ?? [])]) {
      if (variableEvent) args[0] = variables;
      const before = capture(), prior = variables, owner = activeScript;
      const existingReady = new Set(ready);
      const commandSnapshot = event === 'mag_command_parsed' ? args[1].map(command => ({ command, value: clone(command) })) : null;
      const messageSnapshot = event === 'mag_before_message_update' ? args[0].message_content : undefined;
      activeScript = owners.get(callback);
      try {
        await callback(...args); await flushReady(existingReady);
        if (event === 'mag_before_message_update') {
          if (args[0].variables === prior && variables !== prior) args[0].variables = variables;
          else if (args[0].variables !== variables) { api.replaceVariables(args[0].variables); args[0].variables = variables; }
        }
      } catch (error) {
        await flushReady(existingReady).catch(() => {}); restore(before);
        if (commandSnapshot) {
          for (const { command, value } of commandSnapshot) if (command && typeof command === 'object') { for (const key of Object.keys(command)) delete command[key]; Object.assign(command, value); }
          args[1].splice(0, args[1].length, ...commandSnapshot.map(entry => entry.command));
        }
        if (event === 'mag_before_message_update') { args[0].variables = variables; args[0].message_content = messageSnapshot; }
        trace.push({ type: 'script', name: activeScript ?? '', event, error: String(error.message ?? error) });
      } finally { activeScript = owner; }
    }
  };
  api.eventClearAll = () => listeners.clear();
  api.Mvu = { getMvuData: api.getVariables, replaceMvuData: api.replaceVariables, events: { VARIABLE_INITIALIZED: 'mag_variable_initiailized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started', VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', COMMAND_PARSED: 'mag_command_parsed', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update' } };
  api.tavern_events = Object.fromEntries(['APP_READY','CHAT_CHANGED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','GENERATION_STARTED','GENERATION_ENDED','CHAT_COMPLETION_PROMPT_READY'].map(name => [name, name.toLowerCase()]));
  api.waitGlobalInitialized = async name => { if (!(name in api)) throw new Error('未提供全局接口：' + name); return api[name]; };
  api._ = { get, set, unset, has: (obj, key) => get(obj, key) !== undefined, cloneDeep: clone, merge: (target, ...sources) => { for (const source of sources) merge(target, source); return target; }, clamp: (value, min, max) => Math.min(max, Math.max(min, value)), isEmpty: value => value == null || Object.keys(value).length === 0, keys: Object.keys, values: Object.values, entries: Object.entries, toPairs: Object.entries, map: (obj, fn) => Object.entries(obj ?? {}).map(([key, value]) => fn(value, key)), forEach: (obj, fn) => Object.entries(obj ?? {}).forEach(([key, value]) => fn(value, key)), sum: values => values.reduce((a, b) => a + b, 0), pick: (obj, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(obj, key)).map(key => [key, obj[key]])), omit: (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([key]) => !keys.includes(key))) };
  api.toastr = Object.fromEntries(['info', 'warning', 'error', 'success'].map(level => [level, (...args) => trace.push({ type: 'notification', level, message: args.map(String).join(' ') })]));
  api.console = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => trace.push({ type: 'console', level, message: args.map(String).join(' ') })]));
  let ready = [];
  api.$ = callback => { if (typeof callback !== 'function') throw new Error('不支持 jQuery DOM API；仅支持 $(callback) 初始化。'); const promise = Promise.resolve().then(callback); ready.push(promise); return promise; };
  for (const name of ['generate','generateRaw','triggerSlash','execute','registerMvuSchema','registerVariableSchema','loadPreset','replacePreset','replaceWorldbook','createWorldbook','playAudio','reloadIframe','waitUntil']) api[name] = () => { throw new Error('不支持 Tavern Helper API：' + name); };
  api.Mvu.parseMessage = () => { throw new Error('不支持 Mvu.parseMessage 内嵌调用；模型输出由角色运行层统一解析。'); };
  api.TavernHelper = api;
  api.SillyTavern = { getContext: () => ({ chat: clone(messages), characterId: api.characterId, chatMetadata: { variables: clone(variables) }, setExtensionPrompt: (id, content, position, depth) => api.injectPrompts([{ id, content, position, depth }]) }) };
  const flushReady = async (excluded = new Set()) => {
    let failure;
    while (ready.some(promise => !excluded.has(promise))) {
      const pending = ready.filter(promise => !excluded.has(promise));
      ready = ready.filter(promise => excluded.has(promise));
      const settled = await Promise.allSettled(pending);
      failure ??= settled.find(result => result.status === 'rejected');
    }
    if (failure) throw failure.reason;
  };
  const runScripts = async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const script of input.scripts ?? []) {
      const before = capture(); activeScript = script.name ?? script.id ?? '';
      try {
        await new AsyncFunction(script.content)(); await flushReady();
        trace.push({ type: 'script', name: script.name ?? script.id ?? '', executed: true });
      } catch (error) {
        await flushReady().catch(() => {}); restore(before);
        trace.push({ type: 'script', name: script.name ?? script.id ?? '', error: String(error.message ?? error) });
      } finally { activeScript = undefined; }
    }
  };
  const bridge = request => { const response = JSON.parse(variableBlocks(JSON.stringify(request))); if (response.error) throw new Error(response.error); return response.value; };
  const finish = async result => {
    await flushReady();
    if (input.initialized) await api.eventEmit(api.Mvu.events.VARIABLE_INITIALIZED, variables, input.greetingIndex ?? 0);
    let outputText;
    if (input.variableUpdate) {
      const previous = clone(input.previousVariables ?? variables);
      await api.eventEmit(api.Mvu.events.VARIABLE_UPDATE_STARTED, variables);
      const messageSource = outputMessage ? messageText(outputMessage.content ?? outputMessage.message) : undefined;
      const source = messageSource !== originalOutputText ? messageSource : input.variableUpdate.text;
      const prepared = bridge({ action: 'prepare', text: source, settings: input.variableUpdate.settings });
      const commands = prepared.commands.map(entry => entry.command);
      const originals = new Map(prepared.commands.map(entry => [entry.command, { group: entry.group, original: clone(entry.command) }]));
      await api.eventEmit(api.Mvu.events.COMMAND_PARSED, variables, commands, source);
      const applied = bridge({ action: 'apply', variables, prepared, entries: commands.map(command => ({ command, ...originals.get(command) })) });
      api.replaceVariables(applied.variables); trace.push(...applied.trace);
      await api.eventEmit(api.Mvu.events.VARIABLE_UPDATE_ENDED, variables, previous);
      const update = { variables, message_content: prepared.text };
      await api.eventEmit(api.Mvu.events.BEFORE_MESSAGE_UPDATE, update);
      api.replaceVariables(update.variables);
      outputText = update.message_content;
      if (typeof outputText !== 'string') throw new Error('写回前的消息文字必须是字符串。');
      if (outputMessage) replaceMessageText(outputMessage, outputText);
    }
    for (const event of input.events ?? []) {
      if (event.name === 'message_received' && outputMessage) {
        const index = messages.indexOf(outputMessage);
        if (index >= 0) await api.eventEmit(event.name, index);
      } else await api.eventEmit(event.name, ...(event.variables ? [variables, input.previousVariables ?? {}] : event.args ?? []));
    }
    if (outputMessage) outputText = messages.includes(outputMessage) ? messageText(outputMessage.content) : '';
    return { result: result ?? null, variables, messages, actions, trace, ...(outputText !== undefined ? { text: outputText } : {}) };
  };
  Object.assign(globalThis, api);
  Object.defineProperty(globalThis, 'variables', { get: () => variables, set: value => api.replaceVariables(value), configurable: false });
  return { api, finish, runScripts };
}

async function executeInHeap(code, input = {}, { timeoutMs = 250, memoryBytes = 24 * 1024 * 1024 } = {}) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(Math.min(64 * 1024 * 1024, Math.max(4 * 1024 * 1024, memoryBytes)));
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + Math.min(2000, Math.max(10, timeoutMs));
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  let promise;
  const unwrap = result => {
    if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw new Error(error?.message ?? String(error)); }
    return result.value;
  };
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length > 2 * 1024 * 1024 || code.length > 1024 * 1024) throw new Error('角色脚本输入超过运行限制。');
    const bridge = context.newFunction('__workbenchVariableBlocks', value => {
      let response;
      try {
        const payload = context.getString(value);
        if (payload.length > 2 * 1024 * 1024) throw new Error('变量处理资料超过运行限制。');
        const request = JSON.parse(payload);
        if (request.action === 'prepare') response = { value: prepareVariableBlocks(request.text, request.settings) };
        else if (request.action === 'apply') response = { value: applyPreparedVariableBlocks(request.variables, request.prepared, request.entries) };
        else throw new Error('变量处理阶段无效。');
      } catch (error) { response = { error: error.message }; }
      return context.newString(JSON.stringify(response));
    });
    context.setProp(context.global, '__workbenchVariableBlocks', bridge); bridge.dispose();
    promise = unwrap(context.evalCode(`(async () => { const bridge = globalThis.__workbenchVariableBlocks; delete globalThis.__workbenchVariableBlocks; const env = (${environment.toString()})(${serialized}, bridge); const result = ${input.scripts ? 'await env.runScripts()' : `await (async () => { ${code}\n })()`}; return JSON.stringify(await env.finish(result)); })()`));
    while (runtime.hasPendingJob()) {
      if (Date.now() > deadline) throw new Error('角色脚本执行超时。');
      const jobs = runtime.executePendingJobs(20);
      if (jobs.error) { const error = context.dump(jobs.error); jobs.error.dispose(); throw new Error(error?.message ?? String(error)); }
    }
    const state = context.getPromiseState(promise);
    if (state.type === 'pending') throw new Error('角色脚本等待了宿主不提供的异步任务。');
    const output = unwrap(state);
    try { return JSON.parse(context.getString(output)); } finally { output.dispose(); }
  } finally { promise?.dispose(); context.dispose(); runtime.dispose(); }
}

let worker, queue = Promise.resolve(), requestId = 0;
export function executeIsolated(code, input = {}, options = {}) {
  // The worker also bounds native RegExp/WASM operations that may not reach a
  // JavaScript interrupt point. No host APIs are installed in the guest heap.
  const run = () => new Promise((resolve, reject) => {
    const fresh = !worker;
    if (!worker) worker = new Worker(new URL('./sandbox.mjs', import.meta.url), { workerData: { characterSandbox: true }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const current = worker, id = ++requestId;
    current.ref();
    const cleanup = () => { clearTimeout(timer); current.off('message', onMessage); current.off('error', onError); current.off('exit', onExit); current.unref(); };
    const fail = error => { cleanup(); if (worker === current) worker = undefined; void current.terminate(); reject(error); };
    const onMessage = message => { if (message.id !== id) return; cleanup(); message.error ? reject(new Error(message.error)) : resolve(message.result); };
    const onError = error => fail(error);
    const onExit = code => fail(new Error('角色隔离执行器退出：' + code));
    const timeout = Math.min(2000, Math.max(10, options.timeoutMs ?? 250));
    const timer = setTimeout(() => fail(new Error('角色脚本执行超时（隔离线程已停止）。')), timeout + (fresh ? 1500 : 150));
    current.on('message', onMessage); current.once('error', onError); current.once('exit', onExit);
    current.postMessage({ id, code, input, options: { timeoutMs: timeout, memoryBytes: options.memoryBytes } });
  });
  const pending = queue.then(run, run);
  queue = pending.catch(() => {});
  return pending;
}

if (!isMainThread && workerData?.characterSandbox) parentPort.on('message', async ({ id, code, input, options }) => {
  try { parentPort.postMessage({ id, result: await executeInHeap(code, input, options) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});

export async function runCharacterScript(code, options = {}) {
  return executeIsolated(String(code), {
    variables: options.variables ?? {}, messages: (options.messages ?? []).map((message, index) => ({ ...message, message_id: index, message: message.message ?? (typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '') })),
    character: options.character ?? {}, worldbooks: options.worldbooks ?? [], events: options.events ?? [],
    previousVariables: options.previousVariables, userName: options.userName, latestInput: options.latestInput, runType: options.runType,
    scripts: options.scripts, initialized: options.initialized, greetingIndex: options.greetingIndex, variableUpdate: options.variableUpdate,
  }, options);
}

export async function renderTemplate(template, options = {}) {
  if (!template.includes('<%')) return { text: template, variables: options.variables ?? {}, actions: [], trace: [] };
  // EJS 7 removed client compilation. Use its parser's generated source, then
  // compile and execute only inside QuickJS; host never evaluates card code.
  const parsed = new ejs.Template(template, { async: true, compileDebug: false });
  parsed.generateSource();
  const compiled = `async function(locals, escapeFn, include) { let __output = ''; const __append = value => { if (value != null) __output += value; }; with (locals) { ${parsed.source}\n } return __output; }`;
  const result = await runCharacterScript(`const escapeXML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&#34;',"'":'&#39;'}[char])); return await (${compiled})(globalThis, escapeXML, () => { throw new Error('不支持文件 include；请使用宿主提供的世界书。'); });`, options);
  return { ...result, text: String(result.result ?? '') };
}
