import { personaDisplayName } from './personas.mjs';
import { readModelResponse } from './model-response.mjs';

export function buildBridgeMessages({ persona = '', personaName = '中性助手', personaId = 'neutral', context = '', history = [], maxMessages = 40, toolsEnabled = false } = {}) {
  const system = [
    '你是' + personaName + '。按给定人设回答，并协助用户制卡；使用大白话，一次问不超过两三个问题。',
    persona,
    context,
    toolsEnabled
      ? '当前可调用制卡工具：读取当前作品、检查、诊断、生成世界书/MVU/EJS 部件、准备完整修改稿、确认后写入及导出 PNG/JSON。用户要求操作时实际调用工具，不用切换后端。只有工具成功才可声称完成；生成草稿不等于写入，写入不等于导出或酒馆运行验收。改动先用 prepare_card_changes 展示完整稿，下一轮用户明确同意写入该稿才调用 apply_card_changes；否定、仅评价、问题、改稿或附带未满足条件不构成确认。重试只回复，不重复执行写入、导出。导出仅包含已保存的正文，可从“查看成品”下载。不要执行生成的脚本或卡内代码。'
      : '本轮没有可执行工具，不能直接修改文件，只讨论和整理草稿；如需保存，可在编辑卡片中写入。不得声称已执行检查、写入或导出。',
  ].filter(Boolean).join('\n\n');
  const chat = history
    .filter((message) => message && !message.pinned && !message.pending && ['user', 'agent', 'assistant'].includes(message.role) && String(message.text || '').trim())
    .slice(-Math.max(1, maxMessages))
    .map((message) => {
      const role = message.role === 'user' ? 'user' : 'assistant';
      const previousPersona = message.personaId || 'xiaoxi';
      const previousName = personaDisplayName(previousPersona, message.personaName);
      const label = role === 'assistant' && (previousPersona !== personaId || previousName !== personaName)
        ? '【' + previousName + '此前的回复】\n' : '';
      return { role, content: label + String(message.text) };
    });
  return [{ role: 'system', content: system }, ...chat];
}

export async function requestBridgeCompletion({ baseUrl = '', apiKey = '', model, messages, temperature, tools = [] }, { timeoutMs = 8 * 60 * 1000, idleTimeoutMs = 5 * 60 * 1000, signal: cancellationSignal, executeTool, maxToolRounds = 12, onProgress = () => {} } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const address = new URL(base);
  const internal = ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) && address.pathname.endsWith('/internal/ai/v1');
  const timeoutController = new AbortController();
  let timer, activityRevision = 0;
  const renew = () => { clearTimeout(timer); timer = setTimeout(() => timeoutController.abort(), internal ? idleTimeoutMs : timeoutMs); };
  renew();
  const signal = cancellationSignal ? AbortSignal.any([timeoutController.signal, cancellationSignal]) : timeoutController.signal;
  try {
    const history = [...messages];
    const allowed = new Set(tools.map(tool => tool.function?.name));
    for (let round = 0; round <= maxToolRounds; round++) {
    signal.throwIfAborted();
    const progress = (phase, { active = false, partialText } = {}) => {
      if (active) { activityRevision++; if (internal) renew(); }
      try { Promise.resolve(onProgress({ phase, round: round + 1, activityRevision, ...(partialText !== undefined ? { partialText } : {}) })).catch(() => {}); } catch { /* 阶段显示不改变工具结果。 */ }
    };
    progress('waiting-model', { active: true, partialText: '' });
    const response = await fetch(base + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
      body: JSON.stringify({ model, messages: history, temperature: typeof temperature === 'number' ? temperature : 0.7,
        ...(internal ? { stream: true, workbenchIdleTimeoutMs: idleTimeoutMs } : {}),
        ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) }),
    });
    if (!response.ok) throw new Error('LLM ' + response.status + ' ' + (await response.text()).slice(0, 120));
    let modelRevision = 0;
    const result = await readModelResponse(response, { signal, onProgress: value => {
      const active = Number.isSafeInteger(value.activityRevision) && value.activityRevision > modelRevision;
      if (active) modelRevision = value.activityRevision;
      progress(value.phase, { active, partialText: value.partialText });
    } });
    const message = result?.choices?.[0]?.message;
    const calls = message?.tool_calls;
    if (Array.isArray(calls) && calls.length) {
      if (round === maxToolRounds) throw new Error('工具调用达到本轮上限，请核对已保存内容后继续');
      if (calls.length > 8 || calls.some(call => !call?.id || call.type !== 'function' || typeof call.function?.name !== 'string')) throw new Error('模型工具调用格式无效');
      history.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
      const outcomes = [];
      for (const call of calls) {
        signal.throwIfAborted();
        progress(call.function.name === 'read_card' ? 'reading' : 'running-tool', { active: true });
        let output;
        try {
          if (!allowed.has(call.function.name) || !executeTool) throw new Error('未声明的工具：' + call.function.name);
          const args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象');
          output = await executeTool(call.function.name, args, { callId: call.id, signal });
        } catch (error) {
          if (signal.aborted || error.statusCode === 409) throw error;
          output = { error: error.message || '工具执行失败' };
        }
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
        outcomes.push({ name: call.function.name, output });
        progress('running-tool', { active: true });
      }
      const last = outcomes.at(-1);
      if (last?.name === 'prepare_card_changes' && last.output?.replyReady === 'proposal'
        && typeof last.output.proposalId === 'string' && last.output.saved === false && outcomes.every(item => !item.output?.error)) {
        signal.throwIfAborted(); progress('finalizing');
        return '完整修改稿已准备好，请核对后确认是否写入。';
      }
      continue;
    }
    const text = message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回有效的文本答复');
    progress('finalizing');
    return text;
    }
  } catch (error) {
    if (cancellationSignal?.aborted) throw new Error('本轮回复已停止');
    if (timeoutController.signal.aborted) throw new Error(internal ? '连续 ' + Math.ceil(idleTimeoutMs / 1000) + ' 秒没有新进展，已停止本次回复' : '外部模型回复超时，请检查服务后重试');
    throw error;
  } finally { clearTimeout(timer); }
}
