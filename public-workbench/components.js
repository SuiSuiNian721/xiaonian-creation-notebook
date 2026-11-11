export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-3a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v3"/>',
  cards: '<rect x="5" y="3" width="15" height="18" rx="3"/><path d="M2 7v11a3 3 0 0 0 3 3M10 16h5"/><circle cx="12.5" cy="9.5" r="2.5"/>',
  training: '<path d="M9 3h6M9 21h6M3 9v6M21 9v6"/><rect x="6" y="6" width="12" height="12" rx="3"/><path d="m9 13 2-3 2 4 2-3"/>',
  drawing: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="2"/><path d="m3 18 6-5 4 3 4-6 4 5"/>',
  comfyui: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18m-7 4 4 2-4 2Zm-8 3h3"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  voice: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"/>',
  companion: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z"/><path d="m19 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z"/>',
  qq: '<path d="M21 11a9 9 0 0 1-9 9H5l-3 2 1-6a9 9 0 1 1 18-5Z"/><path d="M7 11h.01M12 11h.01M17 11h.01"/>',
  'mc-skin': '<path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="m3 7 9 5 9-5M12 12v10M7 5l10 5M7 10v8"/>',
  'mc-play': '<path d="M7 6h10a4 4 0 0 1 4 3l1 8a3 3 0 0 1-5 2l-3-3h-4l-3 3a3 3 0 0 1-5-2l1-8a4 4 0 0 1 4-3Z"/><path d="M7 9v6M4 12h6M16 10h.01M19 13h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  moon: '<path d="M20 14a9 9 0 0 1-10-11 9 9 0 1 0 10 11Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 4h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(0 0) scale(.95)"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
};
export function icon(name, className = '') {
  return `<svg class="icon ${escape(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
}
export function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon); }); }
export function help(text, label = '查看说明') {
  return `<button type="button" class="help-button" data-help="${escape(text)}" aria-label="${escape(label)}" aria-expanded="false">${icon('info')}</button>`;
}
export const moduleIcon = (id, extra = '') => {const symbol=id==='companion-lite'?'companion':id==='voice-design'?'voice':id.startsWith('character-')?'cards':id;return `<span class="module-icon tone-${escape(symbol)} ${escape(extra)}">${icon(symbol)}</span>`;};
export function dateLabel(value) {
  if (!value) return '尚未打开';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(date);
}
export function eventList(events, modules, limit = 50) {
  if (!events.length) return '<div class="quiet-empty"><p>暂无记录</p></div>';
  return `<ol class="event-list">${events.slice(0, limit).map(e => `<li class="event-row ${e.level === 'error' ? 'event-error' : ''}"><span class="event-symbol">${icon(e.level === 'error' ? 'info' : e.kind?.includes('config') ? 'settings' : 'activity')}</span><div><p>${escape(e.message)}</p><small>${escape(modules.find(m => m.id === e.moduleId)?.name || '工作台')}<span> · </span>${escape(dateLabel(e.at))}</small></div></li>`).join('')}</ol>`;
}
// Keep the download compact so an accepted large card stays importable.
export const serializeBundle = value => JSON.stringify(value);
export function downloadJson(value, name) {
  const blob = new Blob([serializeBundle(value)], { type:'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) + '.json';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
