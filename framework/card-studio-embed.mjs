// Keep the imported editor intact; this adapter owns the workbench URL and theme contract.
function installWorkbenchTransport(prefix) {
  const instancePrefix = prefix.replace(/\/card-studio$/, '');
  const scoped = value => {
    if (typeof value !== 'string') return value;
    if (value.startsWith('/api/')) return prefix + value;
    // 实例代理会为 JSON 中的动态链接加实例前缀，仍需补上角色卡子服务路径。
    if (instancePrefix && value.startsWith(instancePrefix + '/api/')) return prefix + value.slice(instancePrefix.length);
    return value;
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, options) {
    const target = scoped(input);
    const response = await originalFetch(target, options);
    // Avatar URLs arrive as data, then become img.src; never rewrite card or chat content.
    if (typeof target === 'string' && target.startsWith(prefix+'/api/chat-avatar')) {
      const originalJson = response.json.bind(response);
      response.json = async () => {
        const value = await originalJson();
        for (const id of Object.keys(value)) {
          if (value[id]?.url?.startsWith('/api/chat-avatar/')) value[id].url = scoped(value[id].url);
          else if (instancePrefix && value[id]?.url?.startsWith(instancePrefix+'/api/chat-avatar/')) value[id].url = scoped(value[id].url.slice(instancePrefix.length));
        }
        return value;
      };
    }
    return response;
  };
  const OriginalEventSource = window.EventSource;
  window.EventSource = class extends OriginalEventSource {
    constructor(url, options) { super(scoped(url), options); }
  };
}

function connectWorkbench() {
  const parentDocument = window.parent.document;
  window.__workbenchSaveUserAvatar = async function (body) {
    const avatar = body.reset ? '' : 'data:' + body.mimeType + ';base64,' + body.base64;
    const response = await window.parent.fetch('/api/user-profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '用户头像保存失败');
    window.parent.dispatchEvent(new window.parent.CustomEvent('workbench:user-profile-changed', { detail: value.profile }));
    return api('GET', '/api/chat-avatars');
  };
  const refreshUserProfile = () => {
    api('GET', '/api/chat-avatars').then(mapping => { chatAvatars = mapping; window.__refreshChatAvatars?.(); })
      .catch(error => log('用户头像刷新失败：' + error.message, 'warn'));
  };
  window.parent.addEventListener('workbench:user-profile-changed', refreshUserProfile);
  window.addEventListener('pagehide', () => window.parent.removeEventListener('workbench:user-profile-changed', refreshUserProfile), { once: true });
  document.addEventListener('keydown',event=>{
    if(window.parent.__workbenchHelpKey?.(event))return;
    window.parent.__workbenchImmersionKey?.(event);
  },true);
  const openAI=()=>parentDocument.querySelector('[data-module-ai-control="cards"]')?.click();
  window.openLlmCfg = openAI;
  document.addEventListener('click',event=>{if(event.target.closest('#btn-chat-settings,#btn-workspace-settings')){event.preventDefault();event.stopImmediatePropagation();openAI();}},true);
  const syncTheme = () => {
    const dark = parentDocument.documentElement.dataset.theme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    const host = window.parent.getComputedStyle(parentDocument.documentElement);
    const tokens = {
      '--star-ink':'--ink', '--star-muted':'--muted', '--star-border':'--line',
      '--star-card':'--surface', '--star-card-strong':'--glass-solid', '--star-blue-strong':'--accent',
      '--star-bg':'--page', '--star-bg-soft':'--page', '--reading-ink':'--ink', '--reading-bg':'--field',
      '--chat-history-bg':'--page', '--chat-agent-bg':'--glass-solid', '--chat-user-bg':'--selected',
    };
    for (const [key, source] of Object.entries(tokens)) document.documentElement.style.setProperty(key, host.getPropertyValue(source));
  };
  syncTheme();
  new MutationObserver(syncTheme).observe(parentDocument.documentElement, { attributes:true, attributeFilter:['data-theme'] });
  window.__workbenchOpenCard = async function (name) {
    await window.__flushDrafts();
    state.block = 'card'; state.cardTab = 'char'; state.view = null;
    renderBlocks();
    await loadList(name);
    if (state.name !== name || !state.tree) throw new Error('这份作品未能打开，请返回作品列表重试。');
  };
  window.__workbenchSettings = () => el('btn-workspace-settings').click();
  window.__workbenchRevealDialog = () => window.frameElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  window.__workbenchReady = () => draftPersistence.hydrated;
  const reportSelection = () => window.parent.dispatchEvent(new window.parent.CustomEvent('card-studio-selection',{detail:{name:state.name || '',frame:window.frameElement}}));
  new MutationObserver(reportSelection).observe(el('status'),{childList:true,characterData:true,subtree:true});
  reportSelection();
}

const embedStyles = `
  body, html.dark body { background:transparent; }
  body::before, header h1, #btn-theme, header #status { display:none !important; }
  header .persona-control { margin-left:auto; }
  header, footer { margin-left:0; margin-right:0; box-shadow:none; backdrop-filter:none; }
  header { margin-top:0; border-radius:0; border-width:0 0 1px; padding:8px 10px; flex-wrap:wrap; }
  footer { margin-bottom:0; border-radius:0; border-width:1px 0 0; }
  main { margin:0; }
  .drawer-note { display:none; }
  :root { --reading-font:'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',sans-serif; --reading-shadow:none; }
  @media(max-width:600px) {
    header {gap:6px;} main {min-width:0;gap:0;}
    body.edit #tree {display:none;}
    body.edit #pane {padding:12px;}
    #pane .editor-toolbar button {white-space:nowrap;}
  }
`;

export function embedStudioHtml(html,prefix='/card-studio') {
  if (typeof html !== 'string' || !html.includes('</head>') || !html.includes('</body>')) throw new Error('角色卡编辑器页面格式不兼容。');
  const page = html.replace(/var API_TOKEN = [^;]+;/, 'var API_TOKEN = "";')
    .replaceAll("'/api/", "'"+prefix+"/api/").replaceAll('"/api/', '"'+prefix+'/api/');
  return page.replace('</head>', `<style>${embedStyles}</style><script>(${installWorkbenchTransport.toString()})(${JSON.stringify(prefix)});</script></head>`)
    .replace('</body>', `<script>(${connectWorkbench.toString()})();</script></body>`).replace(/\r\n?/g, '\n');
}
