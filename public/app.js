'use strict';

const $ = (id) => document.getElementById(id);
const views = { chat: '聊天', memories: '记忆', connections: '连接', events: '运行记录', stage: 'AIRI 舞台' };
const app = {
  state: null,
  view: 'chat',
  activeId: sessionStorage.getItem('ai-future:conversation') || null,
  drafts: new Map(),
  dirty: new Set(),
  busyForms: new Set(),
  messageModes: new Map(),
  speechBusy: new Set(),
  pendingSend: null,
  sending: false,
  creating: false,
  refreshing: false,
  chatSignature: '',
  renderedConversation: undefined,
  memorySource: undefined,
  memoryFromMessage: false,
  memoryScopeTouched: false,
  deleteMemoryId: null,
  sandboxConversation: null,
  stageFrame: null,
  stageState: 'unavailable',
  stageTimer: null,
  noticeTimer: null,
  inspectorOpen: matchMedia('(min-width: 1181px)').matches,
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function button(text, className, action) {
  const element = node('button', className, text);
  element.type = 'button';
  if (action) element.addEventListener('click', action);
  return element;
}

function formatTime(value, withDate = false) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', withDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function notice(text, error = false) {
  clearTimeout(app.noticeTimer);
  $('notice').textContent = text;
  $('notice').className = `notice${error ? ' error' : ''}`;
  $('notice').hidden = false;
  app.noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 7000 : 4300);
}

function formMessage(id, text, kind = '') {
  $(id).textContent = text;
  $(id).className = `form-message${kind ? ` ${kind}` : ''}`;
}

async function api(path, { method = 'GET', data, timeout = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`本地服务返回了无法读取的数据（HTTP ${response.status}），请重试。`); }
    if (!response.ok) throw new Error(result.error || `请求未完成（HTTP ${response.status}），请重试。`);
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请检查服务状态后重试。');
    if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认工作台服务仍在运行后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const currentConversation = () => app.state?.conversations.find((conversation) => conversation.id === app.activeId);
const draftKey = () => app.activeId || 'new';
const channelName = (conversation) => conversation.sandbox ? 'QQ 沙盒' : ({ desktop: '本地对话', 'qq-private': 'QQ 私聊', 'qq-group': 'QQ 群聊' }[conversation.channel] || '本地对话');

function setInspector(open) {
  app.inspectorOpen = open;
  $('app-shell').classList.toggle('inspector-closed', !open);
  $('inspector').hidden = !open;
  $('toggle-inspector').setAttribute('aria-expanded', String(open));
  $('inspector-backdrop').hidden = !open || matchMedia('(min-width: 1181px)').matches;
}

function showView(view, { focus = false } = {}) {
  if (!Object.hasOwn(views, view)) view = 'chat';
  app.view = view;
  for (const name of Object.keys(views)) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  $('workspace-name').textContent = views[view];
  history.replaceState(null, '', `#${view}`);
  if (view === 'chat') renderChat();
  if (view === 'memories') syncMemoryScope();
  if (view === 'stage') renderStage();
  if (focus) $('main-content').focus({ preventScroll: true });
}

function selectConversation(id) {
  if (!app.state?.conversations.some((conversation) => conversation.id === id)) return;
  app.drafts.set(draftKey(), $('message-input').value);
  app.activeId = id;
  sessionStorage.setItem('ai-future:conversation', id);
  renderConversations();
  syncMemoryScope();
  showView('chat');
}

function upsertConversation(conversation) {
  if (!app.state || !conversation) return;
  const index = app.state.conversations.findIndex((item) => item.id === conversation.id);
  if (index >= 0) app.state.conversations[index] = conversation;
  else app.state.conversations.unshift(conversation);
  app.state.conversations.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function createConversation() {
  if (app.creating || !app.state) return null;
  app.creating = true;
  $('new-conversation').disabled = true;
  try {
    const { conversation } = await api('/api/conversations', { method: 'POST', data: { channel: 'desktop' } });
    upsertConversation(conversation);
    selectConversation(conversation.id);
    $('message-input').focus();
    return conversation;
  } catch (error) {
    notice(error.message, true);
    return null;
  } finally {
    app.creating = false;
    $('new-conversation').disabled = false;
  }
}

function renderConversations() {
  const conversations = app.state?.conversations || [];
  $('conversation-count').textContent = String(conversations.length);
  $('new-conversation').disabled = !app.state || app.creating;
  const fragment = document.createDocumentFragment();
  const options = document.createDocumentFragment();
  const placeholder = node('option', '', conversations.length ? '选择会话' : '还没有会话');
  placeholder.value = '';
  options.append(placeholder);
  for (const conversation of conversations) {
    const item = button('', `conversation-item${conversation.id === app.activeId ? ' is-active' : ''}`, () => selectConversation(conversation.id));
    item.title = conversation.title;
    if (conversation.id === app.activeId) item.setAttribute('aria-current', 'true');
    item.append(node('strong', '', conversation.title || '新的对话'), node('span', '', `${channelName(conversation)} · ${formatTime(conversation.updatedAt, true)}`));
    fragment.append(item);
    const option = node('option', '', `${conversation.sandbox ? '[沙盒] ' : ''}${conversation.title || '新的对话'}`);
    option.value = conversation.id;
    options.append(option);
  }
  if (!conversations.length) fragment.append(node('p', 'sidebar-empty', '还没有会话。写下第一句话，或新建一段对话。'));
  $('conversation-list').replaceChildren(fragment);
  $('conversation-select').replaceChildren(options);
  $('conversation-select').value = app.activeId || '';
}

function messageElement(message, conversation, pending = false) {
  const assistant = message.role === 'assistant';
  const qqMessage = conversation?.channel?.startsWith('qq');
  const author = assistant ? (app.state?.character.name || '角色') : message.role === 'system' ? '系统' : qqMessage ? (conversation.sandbox ? '模拟来信' : 'QQ 来信') : '你';
  const article = node('article', `message ${assistant ? 'message-assistant' : 'message-user'}${pending ? ' message-pending' : ''}`);
  const avatar = node('span', 'message-avatar', assistant ? author.slice(0, 1) : message.role === 'system' ? '系' : qqMessage ? 'Q' : '你');
  avatar.setAttribute('aria-hidden', 'true');
  const body = node('div', 'message-body');
  const meta = node('div', 'message-meta');
  meta.append(node('strong', '', author));
  if (assistant) {
    const mode = message.mode || app.messageModes.get(message.id);
    if (mode) meta.append(node('span', `status-label ${mode === 'demo' ? 'warning' : 'positive'}`, mode === 'demo' ? '离线演示' : '模型回复'));
  }
  const delivery = {
    received: '已接收', sending: '正在发送 QQ', sent: '已发送 QQ', failed: 'QQ 发送失败',
    simulated: assistant ? '沙盒回复' : '沙盒消息',
  }[message.delivery];
  if (delivery) meta.append(node('span', `message-delivery${message.delivery === 'failed' ? ' failed' : ''}`, delivery));
  if (message.createdAt) {
    const time = node('time', '', formatTime(message.createdAt));
    time.dateTime = String(message.createdAt);
    time.title = formatTime(message.createdAt, true);
    meta.append(time);
  }
  body.append(meta, node('p', 'message-text', message.content));
  if (!pending && message.id) {
    const actions = node('div', 'message-actions');
    actions.append(button('保存为记忆', '', () => prepareMemory(message.content, conversation.id)));
    if (assistant) {
      const busy = app.speechBusy.has(message.id);
      const speech = button(busy ? '正在合成…' : message.audioUrl ? '重新合成' : '合成语音', '', () => synthesizeSpeech(conversation.id, message.id));
      speech.disabled = busy || app.state?.status.tts !== 'configured';
      speech.title = app.state?.status.tts === 'configured' ? '生成后手动播放，不会自动播放' : '请先在「连接」中配置语音服务';
      actions.append(speech);
    }
    body.append(actions);
    if (message.audioUrl) {
      const audioUrl = localMediaUrl(message.audioUrl);
      if (audioUrl) {
        const audio = node('audio', 'message-audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = audioUrl;
        audio.setAttribute('aria-label', `${author}的合成语音，点击播放`);
        body.append(audio);
      }
    }
  }
  article.append(avatar, body);
  return article;
}

function localMediaUrl(value) {
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/media/') ? url.href : null;
  } catch { return null; }
}

function renderChat() {
  const conversation = currentConversation();
  const character = app.state?.character;
  const pendingHere = app.pendingSend && app.pendingSend.conversationId === app.activeId;
  const signature = JSON.stringify([app.activeId, character?.name, app.state?.status.tts, conversation?.messages, pendingHere ? app.pendingSend.text : null, [...app.speechBusy], [...app.messageModes]]);
  $('chat-title').textContent = conversation?.title || '开始一段对话';
  $('chat-subtitle').textContent = conversation ? `${channelName(conversation)}${conversation.peerId ? ` · ${conversation.peerId}` : ''}` : '在这里，慢慢完善属于你的角色。';
  $('qq-compose-note').hidden = !conversation?.channel?.startsWith('qq');
  $('send-label').textContent = app.sending ? '等待回复' : conversation?.channel?.startsWith('qq') ? '生成回复' : '发送';
  $('send-message').disabled = !app.state || app.sending || !$('message-input').value.trim();
  $('message-input').disabled = !app.state || app.sending;
  if (app.renderedConversation !== app.activeId) {
    $('message-input').value = app.drafts.get(draftKey()) || '';
    $('composer-error').hidden = true;
    $('send-message').disabled = !app.state || app.sending || !$('message-input').value.trim();
  }
  if (signature === app.chatSignature) return;
  const timeline = $('chat-messages');
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 140;
  const changedConversation = app.renderedConversation !== app.activeId;
  const fragment = document.createDocumentFragment();
  const messages = conversation?.messages || [];
  if (!messages.length && !pendingHere) {
    const empty = node('div', 'chat-empty');
    const mark = node('span', 'chat-empty-mark', character?.name?.slice(0, 1) || '未');
    mark.setAttribute('aria-hidden', 'true');
    empty.append(mark, node('h2', '', app.state ? `你好，我是${character?.name || '你的角色'}。` : '正在打开工作台…'), node('p', '', app.state
      ? '一句问候，一段故事，或是今天发生的小事。写下第一句话，让对话从这里开始。'
      : '正在读取本机角色、会话和连接状态。'));
    if (app.state) {
      const starters = node('div', 'chat-starter');
      for (const prompt of ['聊聊今天', '介绍一下你自己']) {
        starters.append(button(prompt, 'starter-button', () => {
          $('message-input').value = prompt;
          app.drafts.set(draftKey(), prompt);
          $('send-message').disabled = app.sending;
          $('message-input').focus();
        }));
      }
      empty.append(starters);
    }
    fragment.append(empty);
  }
  for (const message of messages) fragment.append(messageElement(message, conversation));
  if (pendingHere) {
    fragment.append(messageElement({ role: 'user', content: app.pendingSend.text }, conversation, true));
    const waiting = node('div', 'message');
    waiting.append(node('span', 'message-avatar', character?.name?.slice(0, 1) || '未'));
    const text = node('div', 'waiting-text');
    const spinner = node('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    text.append(spinner, node('span', '', app.state?.status.model === 'configured' ? '正在等待模型回复…' : '正在生成离线演示回复…'));
    waiting.append(text);
    fragment.append(waiting);
  }
  timeline.replaceChildren(fragment);
  app.chatSignature = signature;
  app.renderedConversation = app.activeId;
  if (atBottom || changedConversation || pendingHere) requestAnimationFrame(() => { timeline.scrollTop = timeline.scrollHeight; });
}

async function sendMessage(event) {
  event?.preventDefault();
  const text = $('message-input').value.trim();
  if (!text || app.sending || !app.state) return;
  app.sending = true;
  $('composer-error').hidden = true;
  app.drafts.set(draftKey(), text);
  renderChat();
  let conversationId = app.activeId;
  try {
    if (!conversationId) {
      const { conversation } = await api('/api/conversations', { method: 'POST', data: { channel: 'desktop' } });
      upsertConversation(conversation);
      app.activeId = conversation.id;
      conversationId = conversation.id;
      sessionStorage.setItem('ai-future:conversation', conversation.id);
      app.drafts.delete('new');
      app.drafts.set(conversation.id, text);
      renderConversations();
    }
    app.pendingSend = { conversationId, text };
    renderChat();
    const result = await api('/api/chat', { method: 'POST', data: { conversationId, text } });
    upsertConversation(result.conversation);
    const assistant = result.conversation?.messages?.findLast((message) => message.role === 'assistant');
    if (assistant && result.mode) app.messageModes.set(assistant.id, result.mode);
    app.drafts.delete(conversationId);
    if (app.activeId === conversationId) $('message-input').value = '';
    app.pendingSend = null;
    renderConversations();
    await refreshState({ quiet: true });
  } catch (error) {
    app.pendingSend = null;
    $('composer-error-text').textContent = `${error.message} 输入内容已保留。`;
    $('composer-error').hidden = false;
    await refreshState({ quiet: true });
  } finally {
    app.pendingSend = null;
    app.sending = false;
    renderChat();
    if (app.view === 'chat' && app.activeId === conversationId) $('message-input').focus({ preventScroll: true });
  }
}

function prepareMemory(content, conversationId) {
  app.memorySource = conversationId;
  app.memoryFromMessage = true;
  app.memoryScopeTouched = true;
  $('memory-content').value = content;
  syncMemoryScope();
  formMessage('memory-message', '内容已放入编辑区，确认后点击「保存记忆」。');
  showView('memories');
  $('memory-content').focus();
}

function syncMemoryScope() {
  if (!app.state) return;
  if (app.memorySource === undefined || (!app.memoryFromMessage && !app.memoryScopeTouched && !$('memory-content').value.trim())) app.memorySource = app.activeId || null;
  const source = app.state.conversations.find((conversation) => conversation.id === app.memorySource);
  const current = currentConversation();
  const options = document.createDocumentFragment();
  if (source || current) {
    const conversation = source || current;
    const option = node('option', '', `仅此会话 · ${conversation.title}`);
    option.value = conversation.id;
    options.append(option);
  }
  const shared = node('option', '', '角色共用（所有会话）');
  shared.value = 'shared';
  options.append(shared);
  $('memory-scope').replaceChildren(options);
  $('memory-scope').value = app.memorySource || 'shared';
  $('memory-scope').disabled = app.memoryFromMessage;
  $('memory-scope-help').textContent = app.memorySource
    ? `仅在「${source?.title || '指定会话'}」的模型回复中使用${app.memoryFromMessage ? '，从消息保存的记忆固定归属该会话' : ''}。`
    : '这条记忆会带入所有桌面、QQ 私聊与群聊的模型请求。请确认内容适合所有交流入口。';
  $('memory-source').textContent = app.memoryFromMessage ? '从消息保存 · 已固定来源会话' : '';
}

function renderMemories() {
  const memories = app.state?.memories || [];
  $('memory-count').textContent = `${memories.length} 条`;
  const fragment = document.createDocumentFragment();
  for (const memory of memories) {
    const row = node('article', 'memory-item');
    row.append(node('p', '', memory.content));
    const meta = node('div', 'memory-meta');
    const conversation = app.state.conversations.find((item) => item.id === memory.conversationId);
    meta.append(node('span', '', `${formatTime(memory.createdAt, true)} · ${memory.conversationId ? `仅此会话：${conversation?.title || '原会话'}` : '角色共用（所有会话）'}`));
    const actions = node('div');
    if (app.deleteMemoryId === memory.id) {
      actions.append(button('取消', 'text-button', () => { app.deleteMemoryId = null; renderMemories(); }), button('确认删除', 'text-button delete-button', () => deleteMemory(memory.id)));
    } else {
      actions.append(button('删除', 'text-button delete-button', () => { app.deleteMemoryId = memory.id; renderMemories(); }));
    }
    meta.append(actions);
    row.append(meta);
    fragment.append(row);
  }
  if (!memories.length) fragment.append(node('p', 'empty-state', '还没有保存的记忆。可以在上方添加，也可以从聊天消息中选择「保存为记忆」。'));
  $('memory-list').replaceChildren(fragment);
}

async function deleteMemory(id) {
  try {
    await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    app.deleteMemoryId = null;
    app.state.memories = app.state.memories.filter((memory) => memory.id !== id);
    renderMemories();
    syncMemoryScope();
    notice('这条记忆已删除。');
    await refreshState({ quiet: true });
  } catch (error) { notice(error.message, true); }
}

function setStatus(id, text, kind = 'neutral') {
  $(id).textContent = text;
  $(id).className = `status-label ${kind}`;
}

function renderStatus() {
  const status = app.state?.status;
  if (!status) return;
  const configured = status.model === 'configured';
  setStatus('mode-status', configured ? '模型已配置' : '离线演示', configured ? 'positive' : 'warning');
  setStatus('llm-status', configured ? '已配置' : '未配置', configured ? 'positive' : 'neutral');
  setStatus('tts-status', status.tts === 'configured' ? '已配置' : '未配置', status.tts === 'configured' ? 'positive' : 'neutral');
  const qqText = { connected: '已连接', connecting: '连接中', disconnected: '未连接' }[status.qq] || '未知';
  setStatus('qq-status', qqText, status.qq === 'connected' ? 'positive' : 'neutral');
  $('summary-model').textContent = configured ? '已配置' : '离线演示';
  $('summary-tts').textContent = status.tts === 'configured' ? '已配置' : '未配置';
  $('summary-qq').textContent = qqText;
  $('summary-airi').textContent = status.airi?.available ? '资源可用' : '不可用';
  $('mode-explanation').textContent = configured ? '已配置模型服务，调用结果以每条回复的标识为准。记忆只在你点击保存时写入。' : '当前为离线演示回复。连接模型后可开始真实对话；记忆由你明确保存。';
  const qqBusy = app.busyForms.has('qq-connection');
  $('qq-connect').disabled = qqBusy || status.qq !== 'disconnected' || !app.state.config.qq?.wsUrl;
  $('qq-disconnect').disabled = qqBusy || status.qq === 'disconnected';
  $('qq-connect').textContent = status.qq === 'connecting' ? '正在连接…' : '连接 QQ';
  $('character-display-name').textContent = app.state.character.name || '未命名角色';
  $('character-avatar').textContent = (app.state.character.name || '未').slice(0, 1);
  document.title = `${app.state.character.name || '角色'} · AI-未来`;
}

function syncForms() {
  if (!app.state) return;
  const { character, config } = app.state;
  if (!app.dirty.has('character')) {
    $('character-name').value = character.name || '';
    $('character-description').value = character.description || '';
    $('character-system').value = character.systemPrompt || '';
  }
  for (const type of ['llm', 'tts']) {
    const value = config[type] || {};
    if (!app.dirty.has(type)) {
      $(`${type}-base`).value = value.baseUrl || '';
      $(`${type}-model`).value = value.model || '';
      if (type === 'tts') $('tts-voice').value = value.voice || '';
      $(`${type}-key`).value = '';
      $(`${type}-clear-key`).checked = false;
    }
    $(`${type}-key-hint`).textContent = value.hasKey ? '已保存密钥；留空会保留，不在界面中回显。' : '尚未保存密钥。服务无需密钥时可以留空。';
  }
  const qq = config.qq || {};
  if (!app.dirty.has('qq')) {
    $('qq-url').value = qq.wsUrl || '';
    $('qq-token').value = '';
    $('qq-clear-key').checked = false;
    $('qq-private-allow').value = (qq.privateAllow || []).join('\n');
    $('qq-group-allow').value = (qq.groupAllow || []).join('\n');
    $('qq-mention').checked = qq.requireMention !== false;
  }
  $('qq-key-hint').textContent = qq.hasToken ? '已保存令牌；留空会保留，不在界面中回显。' : '尚未保存令牌。请与 OneBot 服务端配置保持一致。';
}

async function withForm(name, action, successText) {
  if (app.busyForms.has(name)) return;
  app.busyForms.add(name);
  const form = $(`${name}-form`);
  const submit = form?.querySelector('[type="submit"]');
  const original = submit?.textContent;
  if (submit) { submit.disabled = true; submit.textContent = '正在保存…'; }
  formMessage(`${name}-message`, '');
  try {
    await action();
    app.dirty.delete(name);
    formMessage(`${name}-message`, successText);
    await refreshState({ quiet: true });
  } catch (error) { formMessage(`${name}-message`, error.message, 'error'); }
  finally {
    app.busyForms.delete(name);
    if (submit) { submit.disabled = false; submit.textContent = original; }
  }
}

async function saveConfig(type) {
  const data = type === 'qq' ? {
    wsUrl: $('qq-url').value.trim(), token: $('qq-token').value,
    clearKey: $('qq-clear-key').checked,
    privateAllow: splitAllow($('qq-private-allow').value), groupAllow: splitAllow($('qq-group-allow').value),
    requireMention: $('qq-mention').checked,
  } : {
    baseUrl: $(`${type}-base`).value.trim(), model: $(`${type}-model`).value.trim(), apiKey: $(`${type}-key`).value,
    clearKey: $(`${type}-clear-key`).checked,
    ...(type === 'tts' ? { voice: $('tts-voice').value.trim() } : {}),
  };
  await withForm(type, async () => {
    const result = await api('/api/config', { method: 'POST', data: { [type]: data } });
    if (result.config) app.state.config = result.config;
  }, type === 'qq' ? 'QQ 配置已保存，需要时点击「连接 QQ」。' : '配置已保存。实际调用结果可在聊天与运行记录中查看。');
}

function splitAllow(value) { return [...new Set(value.split(/[\s,，;；]+/u).map((item) => item.trim()).filter(Boolean))]; }

async function connectQQ(connect) {
  if (app.busyForms.has('qq-connection')) return;
  app.busyForms.add('qq-connection');
  renderStatus();
  formMessage('qq-message', connect ? '正在连接已保存的 QQ 服务…' : '正在断开 QQ 连接…');
  try {
    await api(`/api/qq/${connect ? 'connect' : 'disconnect'}`, { method: 'POST', data: {}, timeout: 20000 });
    formMessage('qq-message', connect ? '连接请求已完成，当前状态见上方。' : 'QQ 连接已断开。');
  } catch (error) { formMessage('qq-message', error.message, 'error'); }
  finally {
    app.busyForms.delete('qq-connection');
    await refreshState({ quiet: true });
    renderStatus();
  }
}

function updateSandboxFields() {
  const group = $('sandbox-channel').value === 'qq-group';
  $('sandbox-peer-label').textContent = group ? '群号' : '对方 QQ 号';
  $('sandbox-user-field').hidden = !group;
  $('sandbox-mention-field').hidden = !group;
}

async function simulateMessage(event) {
  event.preventDefault();
  if (app.busyForms.has('sandbox')) return;
  app.busyForms.add('sandbox');
  const submit = $('sandbox-form').querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = '正在运行…';
  $('sandbox-open').hidden = true;
  formMessage('sandbox-message', '正在检查规则并生成沙盒回复…');
  try {
    const result = await api('/api/qq/simulate', { method: 'POST', data: {
      channel: $('sandbox-channel').value,
      peerId: $('sandbox-peer').value.trim(),
      userId: $('sandbox-user').value.trim() || undefined,
      text: $('sandbox-text').value.trim(),
      mentioned: $('sandbox-mentioned').checked,
    } });
    if (result.accepted) {
      formMessage('sandbox-message', '沙盒消息已处理，回复仅保存在本地。');
      app.sandboxConversation = result.conversation?.id;
      upsertConversation(result.conversation);
      $('sandbox-open').hidden = !app.sandboxConversation;
    } else formMessage('sandbox-message', `这条消息未被处理：${result.reason || '未通过当前消息规则。'}`, 'warning');
    await refreshState({ quiet: true });
  } catch (error) { formMessage('sandbox-message', error.message, 'error'); }
  finally { app.busyForms.delete('sandbox'); submit.disabled = false; submit.textContent = '运行沙盒消息'; }
}

async function synthesizeSpeech(conversationId, messageId) {
  if (app.speechBusy.has(messageId)) return;
  app.speechBusy.add(messageId);
  renderChat();
  try {
    const result = await api('/api/speech', { method: 'POST', data: { conversationId, messageId } });
    const audioUrl = localMediaUrl(result.audioUrl);
    if (!audioUrl) throw new Error('服务返回的音频地址不可用，请查看运行记录。');
    const message = app.state.conversations.find((item) => item.id === conversationId)?.messages.find((item) => item.id === messageId);
    if (message) message.audioUrl = audioUrl;
    notice('语音已生成，请点击消息下方的播放器试听。');
  } catch (error) { notice(error.message, true); }
  finally { app.speechBusy.delete(messageId); renderChat(); }
}

function renderEvents() {
  const filter = $('event-filter').value;
  const events = (app.state?.events || []).filter((event) => filter === 'all' || event.level === filter || (filter === 'warn' && event.level === 'warning'));
  const fragment = document.createDocumentFragment();
  for (const event of events) {
    const row = node('li', 'event-item');
    const level = event.level === 'warning' ? 'warn' : event.level;
    row.append(node('span', `event-label ${level || 'info'}`, { error: '错误', warn: '提醒', info: '一般' }[level] || '记录'));
    const content = node('div');
    content.append(node('p', '', event.message));
    const time = node('time', '', `${formatTime(event.at, true)}${event.type ? ` · ${event.type}` : ''}`);
    time.dateTime = String(event.at || '');
    content.append(time);
    row.append(content);
    fragment.append(row);
  }
  if (!events.length) fragment.append(node('li', 'empty-state', filter === 'all' ? '还没有运行记录。配置、生成与连接发生后，结果会显示在这里。' : '当前没有符合条件的记录。'));
  $('event-list').replaceChildren(fragment);
}

function stageStatus(state, text) {
  app.stageState = state;
  $('stage-state-text').textContent = text;
  $('stage-state-dot').className = `status-dot ${state === 'mounted' ? 'positive' : state === 'error' ? 'error' : 'neutral'}`;
}

function removeStageFrame() {
  clearTimeout(app.stageTimer);
  app.stageFrame?.remove();
  app.stageFrame = null;
}

function stageFailure(message) {
  clearTimeout(app.stageTimer);
  stageStatus('error', message);
  $('stage-placeholder').hidden = false;
  $('stage-placeholder-title').textContent = '舞台暂时未能打开';
  $('stage-placeholder-note').textContent = `${message} 可以点击「重新载入」，也可以继续使用工作台聊天。`;
  if (app.stageFrame) app.stageFrame.hidden = true;
}

function renderStage({ reload = false } = {}) {
  const airi = app.state?.status.airi;
  if (!airi) return;
  $('reload-stage').hidden = !airi.available;
  $('stage-description').textContent = airi.available
    ? `${airi.version ? `AIRI ${airi.version} · ` : ''}本机资源 · 示例形象 · 静音待机`
    : airi.note || '尚未找到可用的本机 AIRI 舞台资源。';
  if (!airi.available) {
    removeStageFrame();
    stageStatus('unavailable', '本机舞台当前不可用');
    $('stage-placeholder').hidden = false;
    $('stage-placeholder-title').textContent = '暂时没有可用的舞台';
    $('stage-placeholder-note').textContent = airi.note || '请检查本机 AIRI 安装后重新读取工作台状态。聊天、记忆与连接仍可独立使用。';
    return;
  }
  if (app.view !== 'stage') return;
  if (reload) removeStageFrame();
  if (app.stageFrame) return;
  let stageUrl;
  try {
    stageUrl = new URL(airi.url || '/airi/', location.origin);
    if (stageUrl.origin !== location.origin || !stageUrl.pathname.startsWith('/airi/')) throw new Error('舞台地址不属于本地工作台。');
  } catch (error) { stageFailure(error.message); return; }
  $('stage-placeholder').hidden = false;
  $('stage-placeholder-title').textContent = '正在准备角色舞台';
  $('stage-placeholder-note').textContent = '首次载入需要读取本机形象与渲染资源，请稍等。';
  stageStatus('loading', '正在载入本机舞台资源…');
  const frame = node('iframe');
  frame.title = 'AIRI 示例角色舞台';
  frame.referrerPolicy = 'no-referrer';
  frame.src = stageUrl.href;
  frame.addEventListener('load', () => {
    if (app.stageState === 'loading') stageStatus('loading', '舞台页面已打开，正在载入形象…');
  });
  frame.addEventListener('error', () => stageFailure('舞台资源载入失败。'));
  app.stageFrame = frame;
  $('stage-surface').append(frame);
  app.stageTimer = setTimeout(() => {
    if (app.stageState !== 'mounted') stageFailure('舞台载入时间较长，尚未确认形象已就绪。');
  }, 45000);
}

async function refreshState({ quiet = false } = {}) {
  if (app.refreshing) return;
  app.refreshing = true;
  try {
    const state = await api('/api/state', { timeout: 12000 });
    if (!state.character || !state.config || !state.status || !Array.isArray(state.conversations)) throw new Error('本地服务返回的数据不完整，请重新连接。');
    app.state = { ...state, memories: state.memories || [], events: state.events || [] };
    if (!state.conversations.some((conversation) => conversation.id === app.activeId)) {
      app.activeId = state.conversations[0]?.id || null;
      if (app.activeId) sessionStorage.setItem('ai-future:conversation', app.activeId);
      else sessionStorage.removeItem('ai-future:conversation');
    }
    $('service-error').hidden = true;
    $('service-dot').className = 'status-dot positive';
    $('service-label').textContent = '本地服务已连接';
    $('events-updated').textContent = `更新于 ${formatTime(Date.now())} · 工作台打开时自动刷新`;
    $('app-shell').setAttribute('aria-busy', 'false');
    renderConversations();
    renderStatus();
    syncForms();
    syncMemoryScope();
    renderChat();
    renderMemories();
    renderEvents();
    renderStage();
  } catch (error) {
    $('service-error-text').textContent = error.message;
    $('service-error').hidden = false;
    $('service-dot').className = 'status-dot error';
    $('service-label').textContent = '本地服务未连接';
    $('app-shell').setAttribute('aria-busy', 'false');
    if (!quiet) $('retry-state').focus({ preventScroll: true });
  } finally { app.refreshing = false; }
}

document.querySelectorAll('[data-view]').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view, { focus: true })));
$('new-conversation').addEventListener('click', createConversation);
$('conversation-select').addEventListener('change', (event) => selectConversation(event.target.value));
$('toggle-inspector').addEventListener('click', () => setInspector(!app.inspectorOpen));
$('close-inspector').addEventListener('click', () => { setInspector(false); $('toggle-inspector').focus(); });
$('inspector-backdrop').addEventListener('click', () => setInspector(false));
$('manage-connections').addEventListener('click', () => { showView('connections'); if (!matchMedia('(min-width: 1181px)').matches) setInspector(false); });
$('retry-state').addEventListener('click', () => refreshState());
$('refresh-events').addEventListener('click', async () => {
  $('refresh-events').disabled = true;
  await refreshState();
  $('refresh-events').disabled = false;
});
$('event-filter').addEventListener('change', renderEvents);
$('chat-form').addEventListener('submit', sendMessage);
$('retry-send').addEventListener('click', sendMessage);
$('message-input').addEventListener('input', () => {
  app.drafts.set(draftKey(), $('message-input').value);
  $('send-message').disabled = !app.state || app.sending || !$('message-input').value.trim();
});
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!app.sending && $('message-input').value.trim()) $('chat-form').requestSubmit();
  }
});
$('memory-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = $('memory-content').value.trim();
  if (!content) return;
  await withForm('memory', async () => {
    const result = await api('/api/memories', { method: 'POST', data: { content, ...(app.memorySource ? { conversationId: app.memorySource } : {}) } });
    if (result.memory) app.state.memories.unshift(result.memory);
    $('memory-content').value = '';
    app.memorySource = undefined;
    app.memoryFromMessage = false;
    app.memoryScopeTouched = false;
    syncMemoryScope();
    renderMemories();
  }, '记忆已保存。');
});
$('memory-scope').addEventListener('change', () => {
  app.memorySource = $('memory-scope').value === 'shared' ? null : $('memory-scope').value;
  app.memoryScopeTouched = true;
  syncMemoryScope();
});
$('character-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await withForm('character', async () => {
    const result = await api('/api/character', { method: 'POST', data: {
      name: $('character-name').value.trim(), description: $('character-description').value.trim(), systemPrompt: $('character-system').value.trim(),
    } });
    if (result.character) app.state.character = result.character;
    renderStatus();
  }, '角色设定已保存。');
});
$('reset-character').addEventListener('click', () => { app.dirty.delete('character'); syncForms(); formMessage('character-message', '已还原为上次保存的设定。'); });
for (const name of ['character', 'llm', 'tts', 'qq']) {
  $(`${name}-form`).addEventListener('input', () => {
    app.dirty.add(name);
    formMessage(`${name}-message`, '有未保存的修改。');
  });
}
for (const type of ['llm', 'tts', 'qq']) $(`${type}-form`).addEventListener('submit', (event) => { event.preventDefault(); saveConfig(type); });
$('qq-connect').addEventListener('click', () => connectQQ(true));
$('qq-disconnect').addEventListener('click', () => connectQQ(false));
$('sandbox-channel').addEventListener('change', updateSandboxFields);
$('sandbox-form').addEventListener('submit', simulateMessage);
$('sandbox-open').addEventListener('click', () => { if (app.sandboxConversation) selectConversation(app.sandboxConversation); });
$('reload-stage').addEventListener('click', () => renderStage({ reload: true }));
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== app.stageFrame?.contentWindow || event.data?.type !== 'airi-stage-status') return;
  if (event.data.state === 'mounted') {
    clearTimeout(app.stageTimer);
    stageStatus('mounted', '示例形象已就绪 · 静音待机');
    $('stage-placeholder').hidden = true;
    app.stageFrame.hidden = false;
  } else if (event.data.state === 'error') stageFailure(typeof event.data.message === 'string' ? event.data.message : '舞台兼容初始化失败。');
  else if (event.data.state === 'loading') stageStatus('loading', '正在载入形象与动画…');
});
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && app.inspectorOpen) setInspector(false); });
matchMedia('(min-width: 1181px)').addEventListener('change', (event) => setInspector(event.matches));
document.addEventListener('visibilitychange', () => { if (!document.hidden && !app.sending) refreshState({ quiet: true }); });

setInspector(app.inspectorOpen);
showView(location.hash.slice(1) || 'chat');
renderChat();
renderConversations();
refreshState({ quiet: true });
setInterval(() => { if (!document.hidden && !app.sending && !app.refreshing) refreshState({ quiet: true }); }, 6000);
