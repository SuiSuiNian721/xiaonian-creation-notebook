(() => {
  'use strict';

  const element = id => document.getElementById(id);
  const listen = (id, type, handler) => element(id)?.addEventListener(type, handler);
  const titles = { chat: '对话', memories: '记忆', connections: '连接', events: '运行记录', stage: '角色舞台', character: '角色设定' };
  const desktopPanel = matchMedia('(min-width: 1200px)');
  const readStorage = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
  const writeStorage = (storage, key, value) => { try { value === null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* Storage can be disabled by the host. */ } };
  const state = {
    data: null,
    activeId: readStorage(sessionStorage, 'ai-future:conversation'),
    view: 'chat',
    configTab: 'llm',
    drafts: new Map(),
    dirty: new Set(),
    revisions: new Map(),
    busy: new Set(),
    send: null,
    speech: new Set(),
    chatStamp: '',
    refresh: null,
    memory: { scope: undefined, pinned: false, touched: false, deleting: null },
    sandboxId: null,
    panelOpen: desktopPanel.matches,
    theme: readStorage(localStorage, 'ai-future:theme') === 'dark' ? 'dark' : 'light',
    themeRestored: false,
    themeTouched: false,
    themeRevision: 0,
    themeSave: Promise.resolve(),
  };

  const dom = {
    make(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    },
    text(id, value) { if (element(id)) element(id).textContent = value; },
    action(label, className, handler) {
      const node = this.make('button', className, label);
      node.type = 'button';
      node.addEventListener('click', handler);
      return node;
    },
    status(id, label, tone = 'neutral') {
      const node = element(id);
      if (!node) return;
      node.textContent = label;
      node.className = `status-label ${tone}`;
    },
    time(value, date = false) {
      const parsed = new Date(value);
      if (!value || Number.isNaN(parsed.getTime())) return '';
      return new Intl.DateTimeFormat('zh-CN', {
        ...(date ? { month: '2-digit', day: '2-digit' } : {}),
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(parsed);
    },
    formNote(name, message = '', tone = '') {
      const target = element(`${name}-message`);
      if (!target) return;
      target.textContent = message;
      target.className = `form-message${tone ? ` ${tone}` : ''}`;
    },
    notify(message, error = false) {
      clearTimeout(this.noticeTimer);
      const node = element('notice');
      node.textContent = message;
      node.className = `notice${error ? ' error' : ''}`;
      node.hidden = false;
      this.noticeTimer = setTimeout(() => { node.hidden = true; }, error ? 7000 : 4200);
    },
  };

  const service = {
    async request(path, { method = 'GET', data, timeout = 120000 } = {}) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeout);
      try {
        const response = await fetch(path, {
          method, signal: abort.signal, credentials: 'same-origin', cache: 'no-store',
          ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
        });
        let result;
        try { result = await response.json(); }
        catch { throw new Error(`本地服务返回了无法读取的数据（HTTP ${response.status}）。`); }
        if (!response.ok) throw new Error(result.error || `请求未完成（HTTP ${response.status}）。`);
        return result;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('请求超时，请检查服务后重试。');
        if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认工作台仍在运行。');
        throw error;
      } finally { clearTimeout(timer); }
    },
    post(path, data = {}, timeout) { return this.request(path, { method: 'POST', data, timeout }); },
    async refresh({ force = false } = {}) {
      if (state.refresh) {
        await state.refresh;
        if (!force) return;
      }
      const work = (async () => {
        try {
          const data = await this.request('/api/state', { timeout: 12000 });
          if (!data.character || !data.config || !data.status || !Array.isArray(data.conversations)) throw new Error('工作台状态不完整，请重新连接。');
          state.data = { ...data, memories: data.memories || [], events: data.events || [] };
          if (!state.themeRestored) {
            state.themeRestored = true;
            if (!state.themeTouched && ['light', 'dark'].includes(data.preferences?.theme)) navigation.theme(data.preferences.theme);
          }
          if (!data.conversations.some(item => item.id === state.activeId)) {
            state.activeId = data.conversations[0]?.id || null;
            writeStorage(sessionStorage, 'ai-future:conversation', state.activeId);
            element('message-input').value = state.drafts.get(state.activeId || 'new') || '';
          }
          if (element('service-error')) element('service-error').hidden = true;
          dom.text('service-label', '本地服务已连接');
          if (element('service-dot')) element('service-dot').className = 'status-dot positive';
          element('app-shell').setAttribute('aria-busy', 'false');
          render.all();
        } catch (error) {
          dom.text('service-label', '本地服务未连接');
          if (element('service-dot')) element('service-dot').className = 'status-dot error';
          if (element('service-error')) element('service-error').hidden = false;
          dom.text('service-error-text', error.message);
          element('app-shell').setAttribute('aria-busy', 'false');
        }
      })();
      state.refresh = work;
      try { await work; } finally { if (state.refresh === work) state.refresh = null; }
    },
  };

  const conversations = {
    current() { return state.data?.conversations.find(item => item.id === state.activeId); },
    channel(item) {
      if (item?.sandbox) return 'QQ 沙盒';
      return { desktop: '本地对话', 'qq-private': 'QQ 私聊', 'qq-group': 'QQ 群聊' }[item?.channel] || '本地对话';
    },
    upsert(item) {
      if (!item || !state.data) return;
      const index = state.data.conversations.findIndex(value => value.id === item.id);
      if (index === -1) state.data.conversations.unshift(item);
      else state.data.conversations[index] = item;
      state.data.conversations.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
    },
    select(id) {
      if (!state.data?.conversations.some(item => item.id === id)) return;
      state.drafts.set(state.activeId || 'new', element('message-input').value);
      state.activeId = id;
      writeStorage(sessionStorage, 'ai-future:conversation', id);
      element('message-input').value = state.drafts.get(id) || '';
      element('composer-error').hidden = true;
      render.conversations();
      memories.scope();
      navigation.show('chat');
    },
    async create() {
      if (!state.data || state.busy.has('conversation')) return;
      state.busy.add('conversation'); render.conversations();
      try {
        const result = await service.post('/api/conversations', { channel: 'desktop' });
        this.upsert(result.conversation);
        this.select(result.conversation.id);
        element('message-input').focus();
      } catch (error) { dom.notify(error.message, true); }
      finally { state.busy.delete('conversation'); render.conversations(); }
    },
  };

  const navigation = {
    show(view) {
      state.view = Object.hasOwn(titles, view) ? view : 'chat';
      for (const name of Object.keys(titles)) if (element(`view-${name}`)) element(`view-${name}`).hidden = name !== state.view;
      document.querySelectorAll('button[data-view]').forEach(node => {
        const selected = node.dataset.view === state.view;
        node.classList.toggle('is-active', selected);
        if (selected) node.setAttribute('aria-current', 'page');
        else node.removeAttribute('aria-current');
      });
      element('app-shell').dataset.view = state.view;
      dom.text('workspace-name', titles[state.view]);
      history.replaceState(null, '', `#${state.view}`);
      if (state.view === 'memories') memories.scope();
      if (state.view === 'chat') render.chat();
      if (state.view === 'stage') stage.render();
      if (!desktopPanel.matches && state.panelOpen) this.panel(false);
    },
    config(tab) {
      state.configTab = ['llm', 'tts', 'qq', 'sandbox'].includes(tab) ? tab : 'llm';
      for (const name of ['llm', 'tts', 'qq', 'sandbox']) if (element(`config-${name}`)) element(`config-${name}`).hidden = name !== state.configTab;
      document.querySelectorAll('[data-config]').forEach(node => {
        const active = node.dataset.config === state.configTab;
        node.classList.toggle('is-active', active);
        node.setAttribute('aria-pressed', String(active));
      });
    },
    panel(open) {
      state.panelOpen = open;
      if (element('character-panel')) element('character-panel').hidden = !open;
      element('app-shell').classList.toggle('inspector-closed', !open);
      element('app-shell').dataset.inspector = open ? 'open' : 'closed';
      element('toggle-inspector')?.setAttribute('aria-expanded', String(open));
      if (element('inspector-backdrop')) element('inspector-backdrop').hidden = !open || desktopPanel.matches;
    },
    theme(theme, { save = false } = {}) {
      state.theme = theme;
      document.documentElement.dataset.theme = theme;
      writeStorage(localStorage, 'ai-future:theme', theme);
      const toggle = element('theme-toggle');
      if (toggle) {
        toggle.setAttribute('aria-pressed', String(theme === 'dark'));
        toggle.setAttribute('aria-label', theme === 'dark' ? '切换为浅色' : '切换为深色');
        toggle.title = theme === 'dark' ? '切换为浅色' : '切换为深色';
        toggle.querySelector('use')?.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
      }
      if (save) {
        state.themeTouched = true;
        const revision = ++state.themeRevision;
        state.themeSave = state.themeSave.catch(() => {}).then(async () => {
          try {
            await service.post('/api/preferences', { theme });
            if (state.data) state.data.preferences = { ...state.data.preferences, theme };
          } catch (error) {
            if (revision === state.themeRevision) dom.notify(`主题暂未保存，当前外观仍可使用。${error.message}`, true);
          }
        });
      }
    },
  };

  const chat = {
    media(value) {
      try {
        const url = new URL(value, location.origin);
        return url.origin === location.origin && url.pathname.startsWith('/media/') ? url.href : null;
      } catch { return null; }
    },
    message(item, conversation, pending = false) {
      const assistant = item.role === 'assistant';
      const name = assistant ? state.data.character.name : item.role === 'system' ? '系统' : conversation.channel === 'desktop' ? '你' : conversation.sandbox ? '模拟来信' : 'QQ 来信';
      const row = dom.make('article', `message ${assistant ? 'message-assistant' : 'message-user'}${pending ? ' message-pending' : ''}`);
      const avatar = dom.make('span', 'message-avatar', assistant ? name.slice(0, 1) : conversation.channel === 'desktop' ? '你' : 'Q');
      avatar.setAttribute('aria-hidden', 'true');
      const body = dom.make('div', 'message-body');
      const meta = dom.make('div', 'message-meta');
      meta.append(dom.make('strong', '', name));
      if (assistant && item.mode) meta.append(dom.make('span', `status-label ${item.mode === 'demo' ? 'warning' : 'positive'}`, item.mode === 'demo' ? '离线演示' : '模型回复'));
      const delivery = { received: '已接收', sending: '正在发送 QQ', sent: '已发送 QQ', failed: 'QQ 发送失败', simulated: assistant ? '沙盒回复' : '沙盒消息' }[item.delivery];
      if (delivery) meta.append(dom.make('span', `message-delivery${item.delivery === 'failed' ? ' failed' : ''}`, delivery));
      if (item.createdAt) {
        const time = dom.make('time', '', dom.time(item.createdAt));
        time.dateTime = String(item.createdAt); time.title = dom.time(item.createdAt, true); meta.append(time);
      }
      body.append(meta, dom.make('p', 'message-text', item.content));
      if (!pending && item.id) {
        const actions = dom.make('div', 'message-actions');
        const save = dom.action('保存为记忆', 'text-button', () => memories.prepare(item.content, conversation.id));
        save.dataset.action = 'memory'; actions.append(save);
        if (assistant) {
          const busy = state.speech.has(item.id);
          const speech = dom.action(busy ? '正在合成…' : item.audioUrl ? '重新合成' : '合成语音', 'text-button', () => this.speech(conversation.id, item.id));
          speech.dataset.action = 'speech';
          speech.disabled = busy || state.data.status.tts !== 'configured';
          speech.title = state.data.status.tts === 'configured' ? '生成后手动播放' : '先在连接中设置语音服务';
          actions.append(speech);
        }
        body.append(actions);
        if (item.audioUrl && this.media(item.audioUrl)) {
          const audio = dom.make('audio', 'message-audio');
          audio.controls = true; audio.preload = 'none'; audio.src = this.media(item.audioUrl);
          audio.setAttribute('aria-label', `${name}的合成语音`); body.append(audio);
        }
      }
      row.append(avatar, body); return row;
    },
    async send() {
      const content = element('message-input').value.trim();
      if (!content || state.send || !state.data) return;
      const startId = state.activeId;
      state.drafts.set(startId || 'new', content);
      state.send = { id: startId, text: content };
      element('composer-error').hidden = true; render.chat();
      let conversationId = startId;
      try {
        if (!conversationId) {
          const result = await service.post('/api/conversations', { channel: 'desktop' });
          conversations.upsert(result.conversation);
          conversationId = result.conversation.id;
          state.activeId = conversationId;
          state.send.id = conversationId;
          state.drafts.delete('new'); state.drafts.set(conversationId, content);
          writeStorage(sessionStorage, 'ai-future:conversation', conversationId);
          render.conversations(); memories.scope(); render.chat();
        }
        const result = await service.post('/api/chat', { conversationId, text: content });
        conversations.upsert(result.conversation);
        state.drafts.delete(conversationId);
        if (state.activeId === conversationId) element('message-input').value = '';
        await service.refresh({ force: true });
      } catch (error) {
        if (state.activeId === conversationId) {
          element('message-input').value = content;
          dom.text('composer-error-text', `${error.message} 输入内容已保留。`);
          element('composer-error').hidden = false;
        } else dom.notify(`${error.message} 原会话中的输入已保留。`, true);
        await service.refresh({ force: true });
      } finally {
        state.send = null; render.conversations(); render.chat();
        if (state.view === 'chat' && state.activeId === conversationId) element('message-input').focus({ preventScroll: true });
      }
    },
    async speech(conversationId, messageId) {
      if (state.speech.has(messageId)) return;
      state.speech.add(messageId); render.chat();
      try {
        const result = await service.post('/api/speech', { conversationId, messageId });
        if (!this.media(result.audioUrl)) throw new Error('服务返回的音频地址无效。');
        const message = state.data.conversations.find(item => item.id === conversationId)?.messages.find(item => item.id === messageId);
        if (message) message.audioUrl = result.audioUrl;
        dom.notify('语音已生成，点击播放器即可试听。');
      } catch (error) { dom.notify(error.message, true); }
      finally { state.speech.delete(messageId); render.chat(); }
    },
  };

  const memories = {
    scope() {
      if (!state.data) return;
      const draft = state.memory;
      if (draft.scope === undefined || (!draft.pinned && !draft.touched && !element('memory-content').value.trim())) draft.scope = state.activeId || null;
      const options = document.createDocumentFragment();
      const ids = new Set([draft.scope, state.activeId].filter(Boolean));
      for (const id of ids) {
        const conversation = state.data.conversations.find(item => item.id === id);
        if (!conversation) continue;
        const option = dom.make('option', '', `仅此会话 · ${conversation.title}`); option.value = id; options.append(option);
      }
      const shared = dom.make('option', '', '角色共用（所有会话）'); shared.value = 'shared'; options.append(shared);
      const scope = element('memory-scope'); scope.replaceChildren(options); scope.value = draft.scope || 'shared'; scope.disabled = draft.pinned;
      const source = state.data.conversations.find(item => item.id === draft.scope);
      dom.text('memory-scope-help', draft.scope ? `仅用于「${source?.title || '来源会话'}」${draft.pinned ? '，从消息保存的记忆固定归属该会话' : ''}。` : '这条记忆会带入所有桌面、QQ 私聊和群聊。请确认内容适合共用。');
      dom.text('memory-source', draft.pinned ? '从消息保存 · 来源已固定' : '');
      if (element('cancel-memory-source')) element('cancel-memory-source').hidden = !draft.pinned;
    },
    prepare(content, id) {
      state.revisions.set('memory', (state.revisions.get('memory') || 0) + 1);
      state.memory = { ...state.memory, scope: id, pinned: true, touched: true };
      element('memory-content').value = content;
      this.scope(); navigation.show('memories');
      dom.formNote('memory', '可以先调整内容，点击「保存记忆」后才会写入。');
      element('memory-content').focus();
    },
    reset() {
      state.memory.scope = undefined; state.memory.pinned = false; state.memory.touched = false;
      element('memory-content').value = ''; this.scope();
    },
    async save() {
      const originalContent = element('memory-content').value;
      const content = originalContent.trim();
      if (!content || state.busy.has('memory')) return;
      const scope = state.memory.scope;
      const revision = state.revisions.get('memory') || 0;
      await forms.run('memory', async () => {
        const payload = { content, ...(scope ? { conversationId: scope } : {}) };
        const result = await service.post('/api/memories', payload);
        if (result.memory) state.data.memories.unshift(result.memory);
        if (revision === (state.revisions.get('memory') || 0) && element('memory-content').value === originalContent && state.memory.scope === scope) this.reset();
        render.memories();
      }, '记忆已保存。');
    },
    async remove(id) {
      if (state.busy.has(`memory:${id}`)) return;
      state.busy.add(`memory:${id}`); render.memories();
      try {
        await service.request(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
        state.data.memories = state.data.memories.filter(item => item.id !== id);
        state.memory.deleting = null; render.memories(); dom.notify('这条记忆已删除。');
        await service.refresh({ force: true });
      } catch (error) { dom.notify(error.message, true); }
      finally { state.busy.delete(`memory:${id}`); render.memories(); }
    },
  };

  const forms = {
    async run(name, action, success) {
      if (state.busy.has(name)) return;
      state.busy.add(name);
      const revision = state.revisions.get(name) || 0;
      const submit = element(`${name}-form`).querySelector('[type="submit"]');
      const original = [...submit.childNodes]; submit.disabled = true; submit.textContent = '正在保存…';
      dom.formNote(name);
      try {
        await action();
        const unchanged = revision === (state.revisions.get(name) || 0);
        if (unchanged) state.dirty.delete(name);
        dom.formNote(name, unchanged ? success : '提交时的内容已保存；仍有新的修改尚未保存。');
        await service.refresh({ force: true });
      } catch (error) { dom.formNote(name, error.message, 'error'); }
      finally { state.busy.delete(name); submit.disabled = false; submit.replaceChildren(...original); }
    },
    sync() {
      if (!state.data) return;
      const { character, config } = state.data;
      if (!state.dirty.has('character')) {
        element('character-name').value = character.name || '';
        element('character-description').value = character.description || '';
        element('character-system').value = character.systemPrompt || '';
      }
      for (const name of ['llm', 'tts']) {
        const value = config[name] || {};
        if (!state.dirty.has(name)) {
          element(`${name}-base`).value = value.baseUrl || '';
          element(`${name}-model`).value = value.model || '';
          element(`${name}-key`).value = '';
          element(`${name}-clear-key`).checked = false;
          if (name === 'tts') element('tts-voice').value = value.voice || '';
        }
        dom.text(`${name}-key-hint`, value.hasKey ? '已保存密钥；留空保留，不会在界面中回显。' : '尚未保存密钥。服务无需密钥时可以留空。');
      }
      const qq = config.qq || {};
      if (!state.dirty.has('qq')) {
        element('qq-url').value = qq.wsUrl || '';
        element('qq-token').value = ''; element('qq-clear-key').checked = false;
        element('qq-private-allow').value = (qq.privateAllow || []).join('\n');
        element('qq-group-allow').value = (qq.groupAllow || []).join('\n');
        element('qq-mention').checked = qq.requireMention !== false;
      }
      dom.text('qq-key-hint', qq.hasToken ? '已保存令牌；留空保留，不会在界面中回显。' : '尚未保存令牌，请与 OneBot 服务端保持一致。');
    },
    async character() {
      const value = {
        name: element('character-name').value.trim(), description: element('character-description').value.trim(), systemPrompt: element('character-system').value.trim(),
      };
      await this.run('character', async () => {
        const result = await service.post('/api/character', value);
        if (result.character) state.data.character = result.character;
        render.summary(); render.chat();
      }, '角色设定已保存，后续回复会使用新设定。');
    },
  };

  const connections = {
    list(value) { return [...new Set(value.split(/[\s,，;；]+/u).map(item => item.trim()).filter(Boolean))]; },
    async save(name) {
      const value = name === 'qq' ? {
        wsUrl: element('qq-url').value.trim(), token: element('qq-token').value, clearKey: element('qq-clear-key').checked,
        privateAllow: this.list(element('qq-private-allow').value), groupAllow: this.list(element('qq-group-allow').value), requireMention: element('qq-mention').checked,
      } : {
        baseUrl: element(`${name}-base`).value.trim(), model: element(`${name}-model`).value.trim(), apiKey: element(`${name}-key`).value,
        clearKey: element(`${name}-clear-key`).checked, ...(name === 'tts' ? { voice: element('tts-voice').value.trim() } : {}),
      };
      await forms.run(name, async () => {
        const result = await service.post('/api/config', { [name]: value });
        if (result.config) state.data.config = result.config;
      }, name === 'qq' ? 'QQ 配置已保存，点击「连接 QQ」后才会建立连接。' : '配置已保存。实际调用结果请查看聊天和运行记录。');
    },
    async connect(open) {
      if (!state.data || state.busy.has('qq-connection')) return;
      state.busy.add('qq-connection'); render.summary();
      dom.formNote('qq', open ? '正在连接已保存的 QQ 网关…' : '正在断开 QQ 连接…');
      try {
        await service.post(`/api/qq/${open ? 'connect' : 'disconnect'}`, {}, 15000);
        dom.formNote('qq', open ? '连接请求已完成，请核对当前状态。' : 'QQ 连接已断开。');
      } catch (error) { dom.formNote('qq', error.message, 'error'); }
      finally { state.busy.delete('qq-connection'); await service.refresh({ force: true }); render.summary(); }
    },
    sandboxFields() {
      const group = element('sandbox-channel').value === 'qq-group';
      dom.text('sandbox-peer-label', group ? '群号' : '对方 QQ 号');
      element('sandbox-user-field').hidden = !group; element('sandbox-mention-field').hidden = !group;
    },
    async simulate() {
      if (state.busy.has('sandbox')) return;
      state.busy.add('sandbox');
      const submit = element('sandbox-form').querySelector('[type="submit"]');
      const label = submit.textContent; submit.disabled = true; submit.textContent = '正在运行…';
      element('sandbox-open').hidden = true; dom.formNote('sandbox', '正在检查规则并生成本地沙盒回复…');
      try {
        const result = await service.post('/api/qq/simulate', {
          channel: element('sandbox-channel').value, peerId: element('sandbox-peer').value.trim(), userId: element('sandbox-user').value.trim() || undefined,
          text: element('sandbox-text').value.trim(), mentioned: element('sandbox-mentioned').checked,
        });
        if (result.accepted) {
          state.sandboxId = result.conversation?.id; conversations.upsert(result.conversation);
          dom.formNote('sandbox', '沙盒消息已处理，回复仅保存在本地。');
          element('sandbox-open').hidden = !state.sandboxId;
        } else dom.formNote('sandbox', `这条消息未被处理：${result.reason || '未通过当前规则。'}`, 'warning');
        await service.refresh({ force: true });
      } catch (error) { dom.formNote('sandbox', error.message, 'error'); }
      finally { state.busy.delete('sandbox'); submit.disabled = false; submit.textContent = label; }
    },
  };

  const stage = {
    frame: null,
    state: 'unavailable',
    timer: null,
    status(value, message) {
      this.state = value; dom.text('stage-state-text', message);
      element('stage-state-dot').className = `status-dot ${value === 'mounted' ? 'positive' : value === 'error' ? 'error' : 'neutral'}`;
    },
    remove() { clearTimeout(this.timer); this.frame?.remove(); this.frame = null; },
    fail(message) {
      clearTimeout(this.timer); this.status('error', message);
      element('stage-placeholder').hidden = false;
      dom.text('stage-placeholder-title', '舞台暂时未能打开');
      dom.text('stage-placeholder-note', `${message} 可以重新载入，其他功能仍可使用。`);
      if (this.frame) this.frame.hidden = true;
    },
    render(reload = false) {
      const info = state.data?.status.airi;
      if (!info) return;
      element('reload-stage').hidden = !info.available;
      dom.text('stage-description', info.available ? `AIRI ${info.version || ''} · 示例形象 · 静音待机` : info.note || '尚未找到可用舞台资源。');
      if (!info.available) {
        this.remove(); this.status('unavailable', '本机舞台当前不可用'); element('stage-placeholder').hidden = false;
        dom.text('stage-placeholder-title', '等待可用的角色舞台');
        dom.text('stage-placeholder-note', info.note || '请检查舞台资源，聊天和记忆仍可独立使用。'); return;
      }
      if (state.view !== 'stage') return;
      if (reload) this.remove();
      if (this.frame) return;
      let url;
      try {
        url = new URL(info.url || '/airi/', location.origin);
        if (url.origin !== location.origin || !url.pathname.startsWith('/airi/')) throw new Error('舞台地址不属于本机工作台。');
      } catch (error) { this.fail(error.message); return; }
      this.status('loading', '正在载入本机形象与动画…');
      element('stage-placeholder').hidden = false;
      dom.text('stage-placeholder-title', '正在准备角色舞台');
      dom.text('stage-placeholder-note', '首次打开需要读取本机渲染资源，请稍等。');
      const frame = dom.make('iframe'); frame.title = 'AIRI 示例角色舞台'; frame.referrerPolicy = 'no-referrer'; frame.src = url.href;
      frame.addEventListener('error', () => { if (this.frame === frame) this.fail('舞台资源载入失败。'); });
      this.frame = frame; element('stage-surface').append(frame);
      this.timer = setTimeout(() => { if (this.frame === frame && this.state !== 'mounted') this.fail('尚未确认形象已就绪，请稍后重新载入。'); }, 45000);
    },
    receive(event) {
      if (event.origin !== location.origin || event.source !== this.frame?.contentWindow || !event.data || event.data.type !== 'airi-stage-status') return;
      if (event.data.state === 'mounted') {
        clearTimeout(this.timer); this.status('mounted', '示例形象已就绪 · 静音待机');
        element('stage-placeholder').hidden = true; this.frame.hidden = false;
      } else if (event.data.state === 'loading') this.status('loading', '正在载入形象与动画…');
      else if (event.data.state === 'error') this.fail(typeof event.data.message === 'string' ? event.data.message.slice(0, 1000) : '舞台初始化失败。');
    },
  };

  const render = {
    all() { this.summary(); forms.sync(); this.conversations(); memories.scope(); this.chat(); this.memories(); this.events(); stage.render(); },
    summary() {
      if (!state.data) return;
      const { status, character, config } = state.data;
      const model = status.model === 'configured'; const tts = status.tts === 'configured';
      const qq = { connected: '已连接', connecting: '连接中', disconnected: '未连接' }[status.qq] || '未知';
      dom.status('mode-status', model ? '模型已配置' : '离线演示', model ? 'positive' : 'warning');
      dom.status('llm-status', model ? '已配置' : '未配置', model ? 'positive' : 'neutral');
      dom.status('tts-status', tts ? '已配置' : '未配置', tts ? 'positive' : 'neutral');
      dom.status('qq-status', qq, status.qq === 'connected' ? 'positive' : 'neutral');
      dom.text('summary-model', model ? '已配置' : '离线演示'); dom.text('summary-tts', tts ? '已配置' : '未配置');
      dom.text('summary-qq', qq); dom.text('summary-airi', status.airi?.available ? '资源可用' : '不可用');
      dom.text('character-display-name', character.name || '未命名角色');
      dom.text('character-avatar', (character.name || '未').slice(0, 1));
      dom.text('character-summary-description', character.description || '在角色设定中写下她的来历与性格。');
      dom.text('mode-explanation', model ? '已配置模型，调用结果以每条回复的标识为准。' : '当前是离线演示。连接模型后，可以开始真实对话。');
      element('qq-connect').disabled = state.busy.has('qq-connection') || status.qq !== 'disconnected' || !config.qq?.wsUrl;
      element('qq-disconnect').disabled = state.busy.has('qq-connection') || status.qq === 'disconnected';
      element('qq-connect').textContent = status.qq === 'connecting' ? '正在连接…' : '连接 QQ';
      document.title = `${character.name || '角色'} · AI-未来 Aurora`;
    },
    conversations() {
      const values = state.data?.conversations || [];
      const search = (element('conversation-search')?.value || '').trim().toLocaleLowerCase();
      dom.text('conversation-count', String(values.length));
      element('new-conversation').disabled = !state.data || state.busy.has('conversation');
      const list = document.createDocumentFragment(); const options = document.createDocumentFragment();
      const initial = dom.make('option', '', values.length ? '选择会话' : '还没有会话'); initial.value = ''; options.append(initial);
      for (const value of values) {
        const option = dom.make('option', '', `${value.sandbox ? '[沙盒] ' : ''}${value.title}`); option.value = value.id; options.append(option);
        if (search && !`${value.title} ${value.peerId} ${conversations.channel(value)}`.toLocaleLowerCase().includes(search)) continue;
        const item = dom.action('', `conversation-item${value.id === state.activeId ? ' is-active' : ''}`, () => conversations.select(value.id));
        item.title = value.title;
        if (value.id === state.activeId) item.setAttribute('aria-current', 'true');
        const icon = dom.make('span', 'conversation-icon', value.channel === 'qq-group' ? '#' : value.channel === 'qq-private' ? 'Q' : '·'); icon.setAttribute('aria-hidden', 'true');
        const copy = dom.make('span', 'conversation-copy');
        copy.append(dom.make('strong', '', value.title || '新的对话'), dom.make('span', 'conversation-meta', `${conversations.channel(value)} · ${dom.time(value.updatedAt, true)}`));
        item.append(icon, copy); list.append(item);
      }
      if (!list.childNodes.length) list.append(dom.make('p', 'sidebar-empty', search ? '没有找到匹配的会话。' : '还没有会话，从一句问候开始吧。'));
      element('conversation-list').replaceChildren(list); element('conversation-select').replaceChildren(options); element('conversation-select').value = state.activeId || '';
    },
    chat() {
      const conversation = conversations.current();
      const pending = state.send && state.send.id === state.activeId;
      const content = element('message-input');
      content.disabled = !state.data || Boolean(state.send);
      element('send-message').disabled = !state.data || Boolean(state.send) || !content.value.trim();
      dom.text('send-label', state.send ? '等待回复' : conversation?.channel?.startsWith('qq') ? '生成回复' : '发送');
      dom.text('chat-title', conversation?.title || '开始一段对话');
      dom.text('chat-subtitle', conversation ? `${conversations.channel(conversation)}${conversation.peerId ? ` · ${conversation.peerId}` : ''}` : '在这里，慢慢认识彼此。');
      element('qq-compose-note').hidden = !conversation?.channel?.startsWith('qq');
      const stamp = JSON.stringify([state.activeId, state.data?.character.name, state.data?.status.tts, conversation?.messages, pending ? state.send.text : null, [...state.speech]]);
      if (stamp === state.chatStamp) return;
      state.chatStamp = stamp;
      const list = element('chat-messages');
      const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 150;
      const oldId = list.dataset.conversation; list.dataset.conversation = state.activeId || '';
      const children = document.createDocumentFragment();
      const messages = conversation?.messages || [];
      if (!messages.length && !pending) {
        const empty = dom.make('div', 'chat-empty');
        empty.append(dom.make('span', 'chat-empty-mark', state.data?.character.name?.slice(0, 1) || '未'), dom.make('h2', '', state.data ? `把今天，讲给${state.data.character.name}听。` : '正在打开工作台…'), dom.make('p', '', state.data ? '不用准备好一个故事。一件小事，也值得被听见。' : '正在读取角色与会话，请稍等。'));
        if (state.data) {
          const starters = dom.make('div', 'chat-starter');
          for (const text of ['聊聊今天', '介绍一下你自己']) starters.append(dom.action(text, 'starter-button', () => {
            content.value = text; state.drafts.set(state.activeId || 'new', text); render.chat(); content.focus();
          }));
          empty.append(starters);
        }
        children.append(empty);
      }
      for (const message of messages) children.append(chat.message(message, conversation));
      if (pending) {
        children.append(chat.message({ role: 'user', content: state.send.text }, conversation || { channel: 'desktop' }, true));
        const waiting = dom.make('div', 'message message-assistant message-waiting');
        waiting.append(dom.make('span', 'message-avatar', state.data.character.name.slice(0, 1)), dom.make('div', 'waiting-text', state.data.status.model === 'configured' ? '正在等待模型回复…' : '正在生成离线演示回复…'));
        children.append(waiting);
      }
      list.replaceChildren(children);
      if (bottom || pending || oldId !== list.dataset.conversation) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    },
    memories() {
      const values = state.data?.memories || [];
      dom.text('memory-count', `${values.length} 条`);
      const list = document.createDocumentFragment();
      for (const value of values) {
        const row = dom.make('article', 'memory-item'); row.append(dom.make('p', '', value.content));
        const meta = dom.make('div', 'memory-meta'); const source = state.data.conversations.find(item => item.id === value.conversationId);
        meta.append(dom.make('span', '', `${dom.time(value.createdAt, true)} · ${value.conversationId ? `仅此会话：${source?.title || '来源会话'}` : '角色共用（所有会话）'}`));
        const actions = dom.make('div', 'memory-actions');
        if (state.memory.deleting === value.id) {
          actions.append(dom.action('取消', 'text-button', () => { state.memory.deleting = null; this.memories(); }));
          const confirm = dom.action('确认删除', 'text-button delete-button', () => memories.remove(value.id));
          confirm.disabled = state.busy.has(`memory:${value.id}`); actions.append(confirm);
        } else actions.append(dom.action('删除', 'text-button delete-button', () => { state.memory.deleting = value.id; this.memories(); }));
        meta.append(actions); row.append(meta); list.append(row);
      }
      if (!values.length) list.append(dom.make('p', 'empty-state', '还没有记忆。从聊天中选择「保存为记忆」，或在上方写下一件重要的事。'));
      element('memory-list').replaceChildren(list);
    },
    events() {
      const filter = element('event-filter').value;
      const values = (state.data?.events || []).filter(item => filter === 'all' || item.level === filter || (filter === 'warn' && item.level === 'warning'));
      const list = document.createDocumentFragment();
      for (const value of values) {
        const level = value.level === 'warning' ? 'warn' : value.level;
        const row = dom.make('li', 'event-item'); row.append(dom.make('span', `event-label ${level || 'info'}`, { error: '错误', warn: '提醒', info: '一般' }[level] || '记录'));
        const copy = dom.make('div', 'event-copy');
        copy.append(dom.make('p', '', value.message));
        const time = dom.make('time', '', `${dom.time(value.at, true)}${value.type ? ` · ${value.type}` : ''}`); time.dateTime = String(value.at || ''); copy.append(time); row.append(copy); list.append(row);
      }
      if (!values.length) list.append(dom.make('li', 'empty-state', filter === 'all' ? '还没有运行记录。配置、生成和连接的实际结果会显示在这里。' : '当前没有符合筛选条件的记录。'));
      element('event-list').replaceChildren(list); dom.text('events-updated', `更新于 ${dom.time(Date.now())} · 工作台打开时自动刷新`);
    },
  };

  function bind() {
    document.querySelectorAll('button[data-view]').forEach(node => node.addEventListener('click', () => navigation.show(node.dataset.view)));
    document.querySelectorAll('[data-config]').forEach(node => node.addEventListener('click', () => navigation.config(node.dataset.config)));
    listen('theme-toggle', 'click', () => navigation.theme(state.theme === 'dark' ? 'light' : 'dark', { save: true }));
    listen('toggle-inspector', 'click', () => navigation.panel(!state.panelOpen));
    listen('close-inspector', 'click', () => { navigation.panel(false); element('toggle-inspector')?.focus(); });
    listen('inspector-backdrop', 'click', () => navigation.panel(false));
    listen('manage-connections', 'click', () => navigation.show('connections'));
    listen('new-conversation', 'click', () => conversations.create());
    listen('conversation-select', 'change', event => conversations.select(event.target.value));
    listen('conversation-search', 'input', () => render.conversations());
    listen('chat-form', 'submit', event => { event.preventDefault(); chat.send(); });
    listen('retry-send', 'click', () => chat.send());
    listen('message-input', 'input', event => { state.drafts.set(state.activeId || 'new', event.target.value); render.chat(); });
    listen('message-input', 'keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); if (!state.send && event.target.value.trim()) element('chat-form').requestSubmit();
      }
    });
    listen('memory-form', 'submit', event => { event.preventDefault(); memories.save(); });
    listen('memory-scope', 'change', event => { state.memory.scope = event.target.value === 'shared' ? null : event.target.value; state.memory.touched = true; state.revisions.set('memory', (state.revisions.get('memory') || 0) + 1); memories.scope(); });
    listen('cancel-memory-source', 'click', () => { state.revisions.set('memory', (state.revisions.get('memory') || 0) + 1); memories.reset(); dom.formNote('memory', '已开始一条新的记忆。'); element('memory-content').focus(); });
    listen('character-form', 'submit', event => { event.preventDefault(); forms.character(); });
    listen('reset-character', 'click', () => { state.dirty.delete('character'); forms.sync(); dom.formNote('character', '已还原为上次保存的设定。'); });
    for (const name of ['character', 'llm', 'tts', 'qq']) listen(`${name}-form`, 'input', () => {
      state.dirty.add(name); state.revisions.set(name, (state.revisions.get(name) || 0) + 1); dom.formNote(name, '有未保存的修改。');
    });
    listen('memory-form', 'input', () => {
      state.dirty.add('memory'); state.revisions.set('memory', (state.revisions.get('memory') || 0) + 1);
    });
    for (const name of ['llm', 'tts', 'qq']) listen(`${name}-form`, 'submit', event => { event.preventDefault(); connections.save(name); });
    listen('qq-connect', 'click', () => connections.connect(true)); listen('qq-disconnect', 'click', () => connections.connect(false));
    listen('sandbox-channel', 'change', () => connections.sandboxFields());
    listen('sandbox-form', 'submit', event => { event.preventDefault(); connections.simulate(); });
    listen('sandbox-open', 'click', () => { if (state.sandboxId) conversations.select(state.sandboxId); });
    listen('event-filter', 'change', () => render.events());
    listen('refresh-events', 'click', async () => { element('refresh-events').disabled = true; try { await service.refresh({ force: true }); } finally { element('refresh-events').disabled = false; } });
    listen('retry-state', 'click', () => service.refresh({ force: true }));
    listen('reload-stage', 'click', () => stage.render(true));
    window.addEventListener('message', event => stage.receive(event));
    window.addEventListener('hashchange', () => navigation.show(location.hash.slice(1)));
    window.addEventListener('pagehide', () => clearTimeout(stage.timer));
    desktopPanel.addEventListener('change', event => navigation.panel(event.matches));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.panelOpen && !desktopPanel.matches) navigation.panel(false); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.send) service.refresh(); });
  }

  bind(); navigation.theme(state.theme); navigation.config('llm'); connections.sandboxFields();
  navigation.show(location.hash.slice(1) || 'chat'); navigation.panel(state.panelOpen);
  render.conversations(); render.chat(); service.refresh();
  setInterval(() => { if (!document.hidden && !state.send && !state.refresh && !state.busy.size) service.refresh(); }, 6000);
})();
