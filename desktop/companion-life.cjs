// These functions run in the installed AIRI renderer. Keep them closure-free.
// Hooks verified against AIRI 0.12.0-beta.5, not a fabricated renderer API.
function nativeCharacterContext() {
  const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia?._s;
  const cards = stores?.get('airi-card'), sessions = stores?.get('chat-session'), chat = stores?.get('chat');
  let mapping = {}; try { mapping = JSON.parse(localStorage.getItem('ai-future/workbench-character-cards') || '{}'); } catch {}
  const id = Object.keys(mapping).find(key => mapping[key] === cards?.activeCardId);
  const conversationId = chat?.activeSendSessionId || sessions?.activeSessionId || null;
  const history = conversationId ? sessions?.getSessionMessages?.(conversationId) || [] : [];
  const user = history.findLast(message => message.role === 'user');
  return { managed: !!id, id: id || null, conversationId, sourceId: user?.id || null, generation: sessions?.getSessionGeneration?.(conversationId) ?? null };
}

async function nativeLifeActions(value) {
  const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia?._s;
  const cards = stores?.get('airi-card'), sessions = stores?.get('chat-session');
  let mapping = {}; try { mapping = JSON.parse(localStorage.getItem('ai-future/workbench-character-cards') || '{}'); } catch {}
  if (mapping[value.characterId] !== cards?.activeCardId || sessions?.activeSessionId !== value.conversationId) return [];
  const sourceCurrent=()=>!value.userSourceId||(sessions?.getSessionMessages?.(value.conversationId)?.findLast(message=>message.role==='user')?.id===value.userSourceId&&(value.generation===undefined||sessions?.getSessionGeneration?.(value.conversationId)===value.generation));
  if(!sourceCurrent())return [];
  const results = [];
  for (const action of value.actions || []) {
    if (mapping[value.characterId] !== cards?.activeCardId || sessions?.activeSessionId !== value.conversationId||!sourceCurrent()) break;
    try {
      if (['expression', 'motion'].includes(action.type)) {
        const control = stores.get('llm-streaming-control');
        if (!control?.dispatchWith) { results.push({ type: action.type, status: 'unavailable' }); continue; }
        const name = String(action.name || '').slice(0, 120);
        if (!name) { results.push({ type: action.type, status: 'invalid' }); continue; }
        const payload = action.type === 'expression' ? { emotion: { name, intensity: Math.min(1, Math.max(0, Number(action.intensity) || 1)) } } : { motion: name };
        await control.dispatchWith('<|ACT ' + JSON.stringify(payload) + '|>', { turnId: value.sourceId });
        results.push({ type: action.type, status: 'dispatched' });
      } else if (['voice', 'record', 'audio'].includes(action.type)) {
        if (action.url && /^https?:\/\/[^\r\n\0]+$/i.test(action.url)) {
          globalThis.__workbenchVoicePlayback?.stop?.();
          const audio=new Audio(action.url),generation=sessions?.getSessionGeneration?.(value.conversationId);
          const lastUser=sessions?.getSessionMessages?.(value.conversationId)?.findLast(message=>message.role==='user')?.id;
          let timer;
          const playback={stop(){audio.pause();if(timer!==undefined)clearInterval(timer);if(globalThis.__workbenchVoicePlayback===playback)globalThis.__workbenchVoicePlayback=null;}};
          globalThis.__workbenchVoicePlayback=playback;
          const current=()=>sourceCurrent()&&mapping[value.characterId]===cards?.activeCardId&&sessions?.activeSessionId===value.conversationId&&sessions?.getSessionGeneration?.(value.conversationId)===generation&&sessions?.getSessionMessages?.(value.conversationId)?.findLast(message=>message.role==='user')?.id===lastUser;
          audio.addEventListener('ended',()=>playback.stop(),{once:true});audio.addEventListener('error',()=>playback.stop(),{once:true});
          timer=setInterval(()=>{if(!current())playback.stop();},100);
          try{await audio.play();if(!current())playback.stop();}catch(error){playback.stop();throw error;}
          results.push({ type: action.type, status: 'playing' });
        } else {
          const speech = stores.get('speech-runtime');
          if (!speech?.isHost?.() || typeof action.text !== 'string' || !action.text) { results.push({ type: action.type, status: 'unavailable' }); continue; }
          const intent = speech.openIntent({ intentId: value.sourceId + ':voice', turnId: value.sourceId, ownerId: 'workbench-character-life', behavior: 'queue' });
          intent.writeLiteral(action.text.slice(0, 8000)); intent.end(); results.push({ type: action.type, status: 'queued' });
        }
      } else if (['image', 'meme'].includes(action.type) && /^https?:\/\/[^\s<>\r\n\0]+$/i.test(action.url || '')) {
        const id = value.sourceId + ':image:' + results.length;
        if (!sessions.getSessionMessages(value.conversationId).some(message => message.id === id)) {
          const content = '![' + (action.type === 'meme' ? '表情' : '图片') + '](' + action.url + ')';
          sessions.appendSessionMessage(value.conversationId, { id, role: 'assistant', content, slices: [{ type: 'text', text: content }], tool_results: [], createdAt: Date.now() });
        }
        results.push({ type: action.type, status: 'displayed' });
      } else results.push({ type: action.type, status: 'unsupported' });
    } catch { results.push({ type: action.type, status: 'failed' }); }
  }
  return results;
}

async function nativeDeliver(value) {
  const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia?._s;
  const cards = stores?.get('airi-card'), sessions = stores?.get('chat-session'), chat = stores?.get('chat');
  let mapping = {}; try { mapping = JSON.parse(localStorage.getItem('ai-future/workbench-character-cards') || '{}'); } catch {}
  if (mapping[value.characterId] !== cards?.activeCardId || sessions?.activeSessionId !== value.conversationId || chat?.sending) return { delivered: false, status: 'skipped', reason: 'native-context-changed-or-busy' };
  const id = 'character-life:' + value.sourceId;
  if (sessions.getSessionMessages(value.conversationId).some(message => message.id === id)) return { delivered: false, status: 'skipped', reason: 'duplicate' };
  sessions.appendSessionMessage(value.conversationId, { id, role: 'assistant', content: value.text, slices: [{ type: 'text', text: value.text }], tool_results: [], createdAt: Date.now() });
  return { delivered: true, status: 'confirmed', messageId: id };
}

async function nativeConfirmReply(value) {
  const stores = document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia?._s;
  const cards = stores?.get('airi-card'), sessions = stores?.get('chat-session');
  let mapping = {}; try { mapping = JSON.parse(localStorage.getItem('ai-future/workbench-character-cards') || '{}'); } catch {}
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (mapping[value.characterId] !== cards?.activeCardId || sessions?.activeSessionId !== value.conversationId || sessions?.getSessionGeneration?.(value.conversationId) !== value.generation) return false;
    const messages = sessions.getSessionMessages(value.conversationId);
    if(messages.findLast(message=>message.role==='user')?.id!==value.sourceId)return false;
    const index = messages.findIndex(message => message.role === 'user' && message.id === value.sourceId);
    if (index < 0) return false;
    for (const message of messages.slice(index + 1)) {
      if (message.role === 'user') break;
      if (message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string' && message.content.trim() === value.text.trim()) return true;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  return false;
}

module.exports = { nativeCharacterContext, nativeLifeActions, nativeDeliver, nativeConfirmReply };
