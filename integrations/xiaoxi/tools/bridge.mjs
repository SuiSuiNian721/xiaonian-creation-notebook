// 自动回复桥：把 studio 对话面板的待回复消息送给 OpenAI 兼容端点，按发送时的人设回写。
// OpenAI 兼容端口的面板回复服务；Codex 使用独立的本机 CLI 链路。
// 配置 work/llm-config.json: { "enabled": true, "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "", "model": "...", "temperature": 0.7 }
// 通常不用手动跑：studio 在配置启用时会自动拉起本进程（接入设置里也可启停）。
import fs from 'node:fs';
import path from 'node:path';
import { buildCardContext } from './codex-bridge.mjs';
import { buildBridgeMessages, requestBridgeCompletion } from './bridge-messages.mjs';
import { createConversationStore } from './conversations.mjs';
import { readUserProfile, userProfileText } from './user-profile.mjs';
import { ROOT } from './card.mjs';
import { readPersonaPrompt } from './personas.mjs';
import { chatContextHistory, chatRetryHistory, isChatRetry, readChatVersionSelection } from './chat-retries.mjs';

const CFG = path.join(ROOT, 'work', 'llm-config.json');
const STUDIO = 'http://127.0.0.1:' + (process.env.PORT || 8742);
const conversations = createConversationStore(ROOT);
let activeRequest = null;

process.on('message', (message) => {
  if (message?.type !== 'cancel-reply' || !activeRequest) return;
  const target = activeRequest.target;
  if (message.cardName === String(target.cardName || '1')
    && message.conversationId === String(target.conversationId || 'main') && message.replyToAt === target.at) {
    activeRequest.controller.abort();
  }
});

async function bridgeRequest(action, body, signal) {
  const response = await fetch(STUDIO + '/api/bridge/' + action, {
    method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-Xiaoxi-Token': process.env.XIAOXI_API_TOKEN || '' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || (action + ' ' + response.status)), { statusCode: response.status });
  return result;
}

function loadCfg() {
  if (!fs.existsSync(CFG)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    return c && c.enabled ? c : null;
  } catch {
    return null;
  }
}

function systemPrompt(personaId, profile = readUserProfile(ROOT)) {
  const persona = readPersonaPrompt(ROOT, personaId, profile);
  return { name: persona.name, text: persona.text + '\n\n' + userProfileText(profile) + '\n\n' + (profile.displayName
    ? '用户已经确认称呼，称呼用户为“' + profile.displayName + '”。'
    : '用户还没有确认称呼时，先自然询问该怎么称呼；如果用户不愿提供，使用“你”。') };
}

async function once(cfg) {
  const r = await fetch(STUDIO + '/api/bridge/pending', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('pending ' + r.status);
  const { pending, userProfile } = await r.json();
  if (!pending || !pending.length) return false;
  const target = pending.at(-1);
  // 新消息显式保存人设；没有标记的是旧版林小汐记录。
  const personaId = target.personaId || 'xiaoxi';
  let personaName = target.personaName || '';
  const controller = new AbortController();
  const identity = { cardName: target.cardName || '1', conversationId: target.conversationId || 'main', replyToAt: target.at };
  activeRequest = { target, controller };
  let claimId = '';
  let heartbeat = null;
  let heartbeatBusy = false;
  let sendingReply = false;
  let progressQueue = null, pendingProgress = null, latestProgress = {}, lastProgress = '';
  function drainProgress() {
    if (progressQueue || !pendingProgress || controller.signal.aborted) return;
    progressQueue = (async () => {
      while (pendingProgress && !controller.signal.aborted) {
        const state = pendingProgress; pendingProgress = null;
        try { await bridgeRequest('task-state', { ...identity, claimId, ...state }, controller.signal); }
        catch (error) { if (error.statusCode === 409) controller.abort(); }
      }
    })().finally(() => { progressQueue = null; drainProgress(); });
  }
  function publishProgress(value) {
    latestProgress = { ...latestProgress, ...value };
    const key = JSON.stringify(latestProgress);
    if (key === lastProgress) return;
    lastProgress = key;
    pendingProgress = latestProgress;
    drainProgress();
  }
  async function postReply(text, error = false) {
    return bridgeRequest('reply', {
      ...identity, text, personaId, personaName, error, claimId,
      ...(isChatRetry(target) ? { retryOfAt: target.retryOfAt, retrySourceUserAt: target.retrySourceUserAt } : {}),
    }, controller.signal);
  }
  try {
    const claimed = await bridgeRequest('task-start', { ...identity, backend: 'openai' }, controller.signal);
    claimId = claimed.claimId;
    const tools = claimed.tools || [];
    heartbeat = setInterval(() => {
      if (heartbeatBusy || progressQueue || controller.signal.aborted) return;
      heartbeatBusy = true;
      bridgeRequest('task-state', { ...identity, claimId }, controller.signal)
        .catch((error) => { if (error.statusCode === 409) controller.abort(); })
        .finally(() => { heartbeatBusy = false; });
    }, 1000);
    let context = '';
    if (target.cardName && fs.existsSync(path.join(ROOT, 'cards', target.cardName, 'src'))) {
      try {
        const conversation = conversations.get(target.cardName, target.conversationId || 'main');
        context = buildCardContext(ROOT, target.cardName, target.module || conversation.module);
      } catch { /* 无卡片上下文时仍可普通对话 */ }
    }
    let history = pending;
    if (target.cardName) {
      const conversationId = target.conversationId || 'main';
      const h = await fetch(STUDIO + '/api/chat/' + encodeURIComponent(target.cardName) + '?conversationId=' + encodeURIComponent(conversationId), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!h.ok) throw new Error('无法读取当前对话历史，回复已停止（HTTP ' + h.status + '）');
      history = await h.json();
      if (!Array.isArray(history)) throw new Error('当前对话历史格式不正确，回复已停止');
    }
    const selectedMap = readChatVersionSelection(ROOT, target.cardName || '', target.conversationId || 'main');
    history = isChatRetry(target) ? chatRetryHistory(history, target, selectedMap) : chatContextHistory(history, selectedMap);
    if (isChatRetry(target)) context += '\n\n本轮是用户要求重新回复，只重新回应下面历史中的原提问，不解释重试任务，不引用已撤回答复，不重复执行原提问中的写入、确认、检查或打包操作。需要新草稿时重新展示完整稿并等待用户确认。';
    const persona = systemPrompt(personaId, userProfile);
    personaName = persona.name;
    const messages = buildBridgeMessages({ persona: persona.text, personaName: persona.name, personaId, context, history, toolsEnabled: tools.length > 0 });
    await bridgeRequest('task-state', { ...identity, claimId, phase: 'waiting-model' }, controller.signal);
    const replyText = await requestBridgeCompletion({ ...cfg, messages, tools }, { signal: controller.signal,
      onProgress: publishProgress,
      executeTool: (tool, args, { callId, signal }) => bridgeRequest('tool', { ...identity, claimId, callId, tool, args }, signal) });
    while (progressQueue) await progressQueue;
    controller.signal.throwIfAborted();
    sendingReply = true;
    await postReply(replyText);
    return true;
  } catch (error) {
    while (progressQueue) await progressQueue;
    if (controller.signal.aborted || error.statusCode === 409) return false;
    if (claimId && !sendingReply) await postReply('外部端口回复失败：' + String(error.message || error).slice(0, 500) + '。请检查接入设置后重试。', true);
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (claimId) await bridgeRequest('task-finish', { ...identity, claimId }).catch(() => {});
    if (activeRequest?.controller === controller) activeRequest = null;
  }
}

const cfg = loadCfg();
if (!cfg) {
  console.log('未启用 OpenAI 兼容端口，回复服务未启动。');
  process.exit(0);
}
console.log('对话自动桥已启动 →', cfg.baseUrl, '| model:', cfg.model);
let busy = false;
setInterval(() => {
  if (busy) return;
  const current = loadCfg();
  if (!current || (current.backend && current.backend !== 'openai')) return;
  busy = true;
  once(current).catch((e) => console.error('桥接失败:', e.message)).finally(() => { busy = false; });
}, 2000);
