const MAX_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const PHASES = new Set(['starting', 'thinking', 'generating', 'reconnecting', 'finalizing']);
const encoder = new TextEncoder();
function checkFinish(value) {
  const reason = value?.choices?.[0]?.finish_reason;
  if (reason != null && !['stop', 'tool_calls'].includes(reason)) throw new Error('模型回复因 ' + String(reason).slice(0, 40) + ' 未完整结束，未执行本轮工具');
  return value;
}
function addedBytes(previous, delta) {
  const joinedSurrogate = /[\uD800-\uDBFF]$/.test(previous) && /^[\uDC00-\uDFFF]/.test(delta);
  return encoder.encode(delta).byteLength - (joinedSurrogate ? 2 : 0);
}

// 只读取公开阶段和最终助手消息；结构化工具参数不作为流式聊天正文展示。
export async function readModelResponse(response, { signal, onProgress = () => {} } = {}) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) throw new Error('模型回复超过 4 MiB');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('模型未返回有效 UTF-8 JSON'); }
    return checkFinish(value);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], bytes = 0, resultBytes = 0, complete = false, content = '', preview = '', activityRevision = 0, usage = null;
  const calls = new Map();
  function progress(value) { try { Promise.resolve(onProgress(value)).catch(() => {}); } catch { /* 预览失败不改变最终结果。 */ } }
  function dispatch() {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') { complete = true; return; }
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('模型数据流不是有效 JSON'); }
    if (value?.error) throw new Error(String(value.error.message || '模型连接失败').slice(0, 300));
    checkFinish(value);
    if (value.usage) usage = value.usage;
    if (PHASES.has(value?.workbench?.phase)) {
      const revision = value.workbench.activityRevision;
      if (Number.isSafeInteger(revision) && revision > activityRevision) activityRevision = revision;
      let hasPreview = false;
      if (typeof value.workbench.partialText === 'string' && value.workbench.partialText.length <= 100000) { preview = value.workbench.partialText; hasPreview = true; }
      if (typeof value.workbench.previewDelta === 'string') {
        preview = (value.workbench.previewReset === true ? '' : preview) + value.workbench.previewDelta;
        if (preview.length > 100000) throw new Error('模型预览超过长度限制');
        hasPreview = true;
      }
      progress({ phase: value.workbench.phase, activityRevision, ...(hasPreview ? { partialText: preview } : {}) });
    }
    const choice = value?.choices?.[0], delta = choice?.delta || choice?.message;
    if (!delta) return;
    if (typeof delta.content === 'string') { resultBytes += addedBytes(content, delta.content); content += delta.content; }
    const active = !!delta.content?.length || delta.tool_calls?.some(part => part.function?.arguments?.length || part.function?.name?.length);
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? calls.size;
      if (!Number.isInteger(index) || index < 0 || index >= 8) throw new Error('模型流式工具索引无效');
      const current = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof part.id === 'string') current.id = part.id;
      if (part.type !== undefined && part.type !== 'function') throw new Error('模型流式工具类型无效');
      if (typeof part.function?.name === 'string') { resultBytes += addedBytes(current.function.name, part.function.name); current.function.name += part.function.name; }
      if (typeof part.function?.arguments === 'string') { resultBytes += addedBytes(current.function.arguments, part.function.arguments); current.function.arguments += part.function.arguments; }
      calls.set(index, current);
    }
    if (resultBytes > MAX_BYTES) throw new Error('模型回复与工具参数合计超过 4 MiB');
    if (active) progress({ phase: 'generating', activityRevision: ++activityRevision, partialText: content.slice(0, 100000) });
  }
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) dispatch();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  for await (const chunk of response.body) {
    signal?.throwIfAborted(); bytes += chunk.byteLength;
    if (bytes > MAX_STREAM_BYTES) throw new Error('模型数据流超过 32 MiB');
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while (!complete && (index = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    }
    if (complete) break;
  }
  signal?.throwIfAborted();
  if (!complete) throw new Error('模型数据流未完整结束，未执行本轮工具');
  return { choices: [{ message: { content: content || null, ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) } }], usage };
}
