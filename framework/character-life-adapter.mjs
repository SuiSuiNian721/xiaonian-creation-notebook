/** Runtime messages may target a depth counted from the end of the original history. */
export function characterMessages(context, history, extra = '') {
  if (Array.isArray(context.messages)) return extra ? [{ role: 'system', content: extra }, ...context.messages] : context.messages;
  const messages = history.map(message => ({ ...message })), depth = [];
  const plain = message => ({ role: message.role || 'system', content: message.content });
  const before = [], after = [];
  for (const [items, target] of [[context.beforeMessages, before], [context.afterMessages, after]]) {
    for (const message of items || []) {
      if (Number.isInteger(message.depth) && message.depth >= 0) depth.push(message);
      else target.push(plain(message));
    }
  }
  // Descending insert position keeps depths relative to the untouched history.
  for (const message of depth.map((message, index) => ({ ...message, index })).sort((a, b) => a.depth - b.depth || b.index - a.index)) {
    messages.splice(Math.max(0, history.length - message.depth), 0, plain(message));
  }
  const prompt = [extra, context.prompt || [context.profile, context.lore].filter(Boolean).join('\n\n')].filter(Boolean).join('\n\n');
  return [...before, ...(prompt ? [{ role: 'system', content: prompt }] : []), ...messages, ...after];
}

export function textContent(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : '';
}
