// Serialized into the editor page; dependencies are passed explicitly.
export function attachPersonaManager({ api, state, applyState, refreshAvatars }) {
  let dialog;
  let dirty = false;
  let busy = false;
  const checkDraft = () => {
    if (busy) throw new Error('人设正在保存，请稍后再离开。');
    if (dialog?.open && dirty) throw new Error('人设修改尚未保存，请先保存或在“管理人设”中放弃修改。');
  };
  function open() {
    if (state.personaSwitching || state.personaBusy) return;
    if (dialog?.open) { dialog.focus(); return; }
    dialog = document.createElement('dialog');
    dialog.id = 'persona-manager'; dialog.setAttribute('aria-labelledby', 'persona-manager-title');
    dialog.innerHTML = '<div class="persona-manager-heading"><h2 id="persona-manager-title">管理人设</h2><button type="button" id="persona-close">关闭</button></div>'
      + '<div class="persona-manager-body"><div class="persona-list-pane"><label for="persona-list">已保存的人设</label><select id="persona-list" size="8"></select><button type="button" id="persona-new">新建人设</button></div>'
      + '<form id="persona-form"><label for="persona-name">名称</label><input id="persona-name" required maxlength="60" autocomplete="off">'
      + '<label for="persona-prompt">人设</label><textarea id="persona-prompt" required maxlength="20000" rows="10" placeholder="描述助手的身份、语气和交流偏好"></textarea>'
      + '<p id="persona-feedback" role="status" aria-live="polite"></p><div class="persona-form-actions"><button type="button" id="persona-copy">复制</button><button type="button" id="persona-delete">删除</button><button type="button" id="persona-use">使用此人设</button><button type="submit" id="persona-save" class="primary">保存</button></div>'
      + '<div id="persona-delete-confirm" hidden><p>删除此人设后无法恢复。已有对话保留；若正在使用，将切换回' + (state.personaOptions.some(item => item.id === 'neutral') ? '中性助手' : '林小汐') + '。</p><button type="button" id="persona-delete-cancel">取消</button><button type="button" id="persona-delete-final">确认删除</button></div></form></div>';
    document.body.append(dialog);
    const find = id => dialog.querySelector('#' + id);
    const list = find('persona-list'), name = find('persona-name'), prompt = find('persona-prompt');
    const status = find('persona-feedback');
    let selectedId = state.personaId;
    const current = () => state.personaOptions.find(item => item.id === selectedId);
    const say = (text, error = false) => { status.textContent = text; status.className = error ? 'err' : 'muted'; };
    function controls() {
      const item = current();
      const builtin = !!item?.builtin;
      dialog.querySelectorAll('button,select,input,textarea').forEach(element => { element.disabled = busy; });
      name.readOnly = prompt.readOnly = builtin;
      find('persona-save').hidden = builtin;
      find('persona-delete').hidden = !item || builtin;
      find('persona-copy').disabled = busy || !item;
      find('persona-use').disabled = busy || !item || dirty || item.id === state.personaId;
      find('persona-use').textContent = item?.id === state.personaId ? '正在使用' : '使用此人设';
    }
    function paint(id) {
      selectedId = id;
      list.replaceChildren();
      state.personaOptions.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name + (item.id === state.personaId ? ' · 当前' : ''); list.append(option); });
      if (!id) { const option = document.createElement('option'); option.value = ''; option.textContent = '未保存的人设'; list.append(option); }
      list.value = id;
      const item = current();
      name.value = item?.name || ''; prompt.value = item?.prompt || '';
      dirty = false; find('persona-delete-confirm').hidden = true;
      say(item?.builtin ? '内置人设，可复制后修改。' : ''); controls();
    }
    const discard = () => !dirty || window.confirm('人设修改尚未保存，放弃这些修改？');
    const run = async operation => {
      if (busy) return;
      busy = true; controls(); say('正在保存…');
      try { await operation(); }
      catch (error) { say(error.message, true); }
      finally { busy = false; controls(); }
    };
    list.onchange = () => { const next = list.value; if (discard()) paint(next); else list.value = selectedId; };
    find('persona-new').onclick = () => { if (discard()) { paint(''); name.focus(); } };
    find('persona-copy').onclick = () => {
      if (!discard()) return;
      const item = current(); if (!item) return;
      paint(''); name.value = (item.name + ' 副本').slice(0, 60); prompt.value = item.prompt; dirty = true; controls(); name.focus();
    };
    const edited = () => { dirty = true; find('persona-delete-confirm').hidden = true; controls(); };
    name.oninput = prompt.oninput = edited;
    find('persona-form').onsubmit = event => {
      event.preventDefault();
      if (current()?.builtin) return;
      void run(async () => {
        const result = await api('POST', '/api/personas', { ...(selectedId ? { id: selectedId } : {}), name: name.value, prompt: prompt.value });
        applyState(result); paint(result.persona.id); await refreshAvatars(); say('已保存。');
      });
    };
    find('persona-use').onclick = () => void run(async () => {
      const result = await api('POST', '/api/persona', { id: selectedId });
      applyState(result); paint(selectedId); say('后续回复使用此人设。');
    });
    find('persona-delete').onclick = () => { find('persona-delete-confirm').hidden = false; find('persona-delete-cancel').focus(); };
    find('persona-delete-cancel').onclick = () => { find('persona-delete-confirm').hidden = true; find('persona-delete').focus(); };
    find('persona-delete-final').onclick = () => void run(async () => {
      const result = await api('DELETE', '/api/personas', { id: selectedId });
      applyState(result); paint(result.activeId); await refreshAvatars(); say('人设已删除。');
    });
    const close = () => { if (!busy && discard()) { dirty = false; dialog.close(); } };
    find('persona-close').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { dialog.remove(); dialog = null; document.getElementById('btn-personas')?.focus(); }, { once: true });
    paint(selectedId); dialog.showModal(); list.focus();
  }
  return { open, checkDraft };
}
