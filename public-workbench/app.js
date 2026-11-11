import { escape as e, icon, moduleIcon, hydrateIcons, eventList } from './components.js';
import { Drafts } from './drafts.js';
import * as pages from './pages.js';
import {mountModuleAIControl,closeModuleAIControls} from './module-ai-control.js';
import {createImmersion} from './immersion.js';
import {mountModuleHelp,closeModuleHelp} from './module-help.js';
import {createInstanceViews} from './instances-ui.js';
import {moduleFamilyId,moduleVariants,workspaceModules} from './module-families.js';
import {installSearchableSelects} from './searchable-select.js';
import {avatarMarkup} from './user-settings.js';

installSearchableSelects(document);

const modulePaths = { cards:'./modules/cards.js',training:'./modules/training.js',drawing:'./modules/drawing.js',comfyui:'./modules/comfyui.js',voice:'./modules/voice.js','voice-design':'./modules/voice-design.js',companion:'./modules/companion.js','companion-lite':'./modules/companion-lite.js','character-lite':'./modules/character-lite.js','character-full':'./modules/character-full.js',qq:'./modules/qq.js','mc-skin':'./modules/mc-skin.js','mc-play':'./modules/mc-play.js' };
const moduleRetries = {};
const titles = { home:'我的工作台', catalog:'添加模块', characters:'角色资料', events:'运行记录', settings:'工作台设置' };
const root = document.querySelector('#page-content');
const cardsRoot = document.querySelector('#cards-content');
let cardsMounted = false;
let state;
let userProfile={};
let pageController;
let renderGeneration = 0;
let refreshGeneration = 0;
let toastTimer;
let themeQueue = Promise.resolve();
let themePending = 0;
let currentRoute = 'home';
const drafts = new Drafts();
const ui = { moduleTabs:{} };
const immersion=createImmersion({getModule:()=>route().startsWith('module/')?route().slice(7):null,notify});
const instanceContainer=document.createElement('div');instanceContainer.id='instance-content';instanceContainer.hidden=true;root.after(instanceContainer);
let instancesUI;
const moduleTargets=new Map();
hydrateIcons();

async function api(path, { method='GET', body, timeoutMs=15000, signal } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(path, { method, signal:signal?AbortSignal.any([controller.signal,signal]):controller.signal, headers:body === undefined ? {} : {'content-type':'application/json'}, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || `请求失败（${response.status}），请重试。`),{status:response.status});
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(signal?.aborted?'请求已取消。':'工作台服务响应超时，请稍后重试。');
    if (error instanceof TypeError) throw new Error('无法连接工作台服务，请检查程序是否仍在运行。');
    throw error;
  } finally { clearTimeout(timer); }
}
function notify(message, error = false) {
  clearTimeout(toastTimer); const toast = document.querySelector('#toast');
  document.querySelector('#toast-text').textContent = message; toast.className = `toast${error ? ' error' : ''}`; toast.hidden = false;
  if (!error) toastTimer = setTimeout(() => { toast.hidden = true; }, 5500);
}
async function action(button, job) {
  if (button.disabled) return;
  button.disabled = true;
  try { await job(); } catch (error) { notify(error.message,true); }
  finally { button.disabled = false; }
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===theme)));
  const button = document.querySelector('#theme-toggle');
  button.innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
  button.title = button.ariaLabel = theme === 'light' ? '切换深色主题' : '切换浅色主题';
}
async function setTheme(theme) {
  if (!state) return;
  themePending++; state.preferences.theme = theme; applyTheme(theme);
  const pending = themeQueue.then(() => api('/api/preferences', { method:'POST', body:{theme} }));
  themeQueue = pending.catch(() => {});
  try { await pending; }
  finally { themePending--; if (!themePending) await refresh(); }
}
function route() {
  const value = location.hash.startsWith('#/') ? location.hash.slice(2) : 'home';
  return /^[a-z-]+(?:\/[a-z-]+)?$/.test(value) ? value : 'home';
}
function navigate(value) {
  if (route() === value) void render();
  else location.hash = `/${value}`;
}
async function navigateModule(id,target=null){
  const definition=state.modules.find(module=>module.id===id);
  if(!definition||definition.librarySection)throw new Error('没有找到可打开的目标模块。');
  if(!definition.enabled){await api('/api/modules/'+id+'/enable',{method:'POST',body:{}});await refresh();}
  const family=moduleFamilyId(state.modules,id);moduleTargets.clear();
  if(target&&Object.keys(target).length)moduleTargets.set(family,structuredClone(target));
  navigate('module/'+family);
}
function chrome() {
  if (!state) return;
  const userName=userProfile.displayName?.trim()||'请输入用户名';
  document.querySelector('#sidebar-user-name').textContent=userName;
  document.querySelector('#sidebar-user-name').title=userName;
  document.querySelector('#sidebar-user-avatar').innerHTML=userProfile.avatar?avatarMarkup(userProfile.avatar):'';
  document.querySelector('#sidebar-user-avatar').classList.toggle('is-empty',!userProfile.avatar);
  document.querySelector('.brand').setAttribute('aria-label',`${userName}，打开用户设置`);
  document.querySelector('#app-shell').setAttribute('aria-busy','false');
  document.querySelector('#connection-dot').className = 'dot connected';
  document.querySelector('#connection-label').textContent = '工作台服务正常';
  const installed = workspaceModules(state.modules).filter(m => m.enabled);
  document.querySelector('#installed-count').textContent = installed.length;
  document.querySelector('#module-nav').innerHTML = installed.map(m => `<a href="#/module/${e(m.id)}" data-module-nav="${e(m.id)}" ${currentRoute === `module/${m.id}` ? 'aria-current="page"' : ''}>${moduleIcon(m.id)}<span>${e(m.name)}</span></a>`).join('');
  const select = document.querySelector('#character-select');
  select.innerHTML = '<option value="">暂不选择角色</option>' + state.characters.map(c => `<option value="${e(c.id)}">${e(c.name)}</option>`).join('');
  select.value = state.selectedCharacterId || '';
  document.querySelectorAll('[data-nav]').forEach(a => { if (a.dataset.nav === currentRoute) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  const m = workspaceModules(state.modules).find(m => currentRoute === `module/${m.id}`);
  document.querySelector('.character-switch').hidden = true;
  document.querySelector('#route-title').textContent = m?.name || titles[currentRoute] || '工作台';
  document.title = `${m?.name || titles[currentRoute] || '工作台'} · 小念的创作笔记`;
  if (!themePending) applyTheme(state.preferences.theme);
  renderDrawer();
}
function renderDrawer() {
  if (!state) return;
  document.querySelector('#drawer-content').innerHTML = `<p class="drawer-status"><span class="dot connected"></span>工作台服务正常</p>${eventList(state.events, state.modules,5)}`;
}
async function refresh() {
  const generation = ++refreshGeneration;
  const [next,identity] = await Promise.all([api('/api/state'),api('/api/user-profile')]);
  if (generation !== refreshGeneration) return;
  state = next; userProfile=identity.profile; document.querySelector('#service-error').hidden = true; chrome();
}
window.addEventListener('workbench:user-profile-changed',event=>{userProfile=event.detail;chrome();void refresh().catch(error=>notify(error.message,true));});
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();ui.settingsTab='user';navigate('settings');});
async function selectCharacter(id) {
  await api('/api/characters/select', {method:'POST',body:{id:id || null}}); await refresh(); await render();
}
async function disableModule(id) {
  const members=moduleVariants(state.modules,id),ids=members.length?members.map(module=>module.id):[id];
  await instancesUI?.stopModule(id);
  for(const member of ids)await api(`/api/modules/${member}/disable`,{method:'POST',body:{}});
  // Commit the acknowledged local state even if the following full refresh fails.
  state={...state,modules:state.modules.map(module=>ids.includes(module.id)?{...module,enabled:false}:module)};
  chrome();
  try {await refresh();} catch(error) {notify(`入口已移除，刷新运行信息失败：${error.message}`,true);}
}
const context = signal => ({
  get state() { return state; }, signal, ui, drafts, api, refresh, notify, action, navigate, navigateModule, setTheme, selectCharacter, disableModule,immersion,
  rerender: () => render(),
  characters: { getSelected:() => state.characters.find(c => c.id === state.selectedCharacterId) || null },
  assets: { list:() => state.characters.find(c => c.id === state.selectedCharacterId)?.assets || [] },
  tasks: { list:() => state.tasks || [] },
  ai: { complete:(moduleId,messages)=>api('/api/ai/chat',{method:'POST',body:{moduleId,messages},timeoutMs:185000}) },
});
instancesUI=createInstanceViews({container:instanceContainer,api,baseContext:context,getModules:()=>state.modules,loadModule:id=>import(modulePaths[id]+(moduleRetries[id]?`?retry=${moduleRetries[id]}`:'')),refreshLibrary:refresh,notify,immersion});

async function render() {
  if (!state) return;
  closeModuleAIControls();
  closeModuleHelp();
  hideHelp();
  const generation = ++renderGeneration;
  const nextRoute = route();
  immersion.routeChanged(nextRoute.startsWith('module/')?nextRoute.slice(7):null);
  if (currentRoute === 'module/cards' && nextRoute !== currentRoute && state.modules.find(module=>module.id==='cards')?.enabled && window.__workbenchFlushDrafts) {
    try { await window.__workbenchFlushDrafts(); }
    catch (error) {
      if (generation !== renderGeneration) return;
      history.replaceState(null,'',`#/${currentRoute}`);
      notify(`草稿尚未保存，已保留当前页面：${error.message}`,true);
      return;
    }
    if (generation !== renderGeneration) return;
  }
  pageController?.abort(); pageController = new AbortController(); const signal = pageController.signal;
  const requestedRoute=route(),requestedModuleId=requestedRoute.startsWith('module/')?requestedRoute.slice(7):null;
  const librarySection=state.modules.find(module=>module.id===requestedModuleId)?.librarySection;
  currentRoute = librarySection|| (requestedModuleId?'module/'+moduleFamilyId(state.modules,requestedModuleId):requestedRoute);
  if(currentRoute!==requestedRoute)history.replaceState(null,'',`#/${currentRoute}`);
  chrome();
  instancesUI.hide();
  root.hidden = false; cardsRoot.hidden = true;
  document.body.inert = false;
  root.setAttribute('aria-busy','true');
  document.querySelector('#main-content').setAttribute('aria-busy','true');
  try {
    if (currentRoute.startsWith('module/')) {
      const id = currentRoute.slice(7); const module = workspaceModules(state.modules).find(m => m.id === id);
      if (!module?.enabled || !Object.hasOwn(modulePaths,id)) {
        root.innerHTML = `<section class="module-failure glass"><h1>这个模块还没有添加</h1><p>在模块目录中添加后，就可以在这里配置和使用。</p><a href="#/catalog" class="button primary">浏览模块目录 ${icon('arrow')}</a></section>`;
      } else {
        root.innerHTML = '<div class="initial-loading"><span class="loading-orbit" aria-hidden="true"></span><p>正在打开模块…</p></div>';
        try {
          const target=moduleTargets.get(id);moduleTargets.clear();
          root.hidden=true;await instancesUI.show(module,{preferredModuleId:requestedModuleId!==id?requestedModuleId:null,target});
          if(generation!==renderGeneration)return;
          await refresh();
        } catch (error) {
          if (generation !== renderGeneration) return;
          root.hidden=false; cardsRoot.hidden=true;
          instancesUI.hide();
          moduleRetries[id] = (moduleRetries[id] || 0) + 1;
          root.innerHTML = `<section class="module-failure glass"><h1>${e(module.name)}暂时无法打开</h1><p>${e(error.message)} 其他模块仍可以使用。</p><button class="button primary" type="button" id="retry-module">重试打开</button><a href="#/home" class="button">返回工作台</a></section>`;
          root.querySelector('#retry-module').addEventListener('click', () => render(), {signal});
          void api('/api/events', {method:'POST',body:{moduleId:id,kind:'module.load.failed',level:'error',message:`${module.name}界面加载失败，请重新打开。`}}).catch(() => {});
        }
      }
    } else {
      const page = pages[currentRoute] || pages.home; page(root,context(signal));
    }
  } catch (error) {
    root.hidden=false; cardsRoot.hidden=true;
    root.innerHTML = `<section class="module-failure glass"><h1>页面暂时无法显示</h1><p>${e(error.message)}</p><a href="#/home" class="button">返回工作台</a></section>`;
  } finally { if (generation === renderGeneration) { root.setAttribute('aria-busy','false'); document.querySelector('#main-content').setAttribute('aria-busy','false'); } }
}

document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); document.querySelector('#main-content').focus(); });
root.addEventListener('click', async event => {
  const button = event.target.closest('button[data-add],button[data-open]');
  if (!button) return;
  if (button.dataset.open) { navigate(`module/${button.dataset.open}`); return; }
  await action(button,async () => {
    const id = button.dataset.add; await api(`/api/modules/${id}/enable`, {method:'POST',body:{}}); await refresh();
    notify(`${state.modules.find(m => m.id === id)?.name || '模块'}已添加到工作台。`); await render();
  });
});
document.querySelector('#character-select').addEventListener('change', async ev => {
  const select = ev.currentTarget; select.disabled = true;
  try { await selectCharacter(select.value); }
  catch (error) { notify(error.message,true); chrome(); }
  finally { select.disabled = false; }
});
document.querySelector('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light').catch(error => notify(error.message,true)));
function toggleDrawer(open) {
  const drawer = document.querySelector('#activity-drawer'); drawer.hidden = !open;
  document.querySelector('#activity-toggle').setAttribute('aria-expanded',String(open));
  if (open) { renderDrawer(); document.querySelector('#close-activity').focus(); }
  else document.querySelector('#activity-toggle').focus();
}
document.querySelector('#activity-toggle').addEventListener('click', () => toggleDrawer(document.querySelector('#activity-drawer').hidden));
document.querySelector('#close-activity').addEventListener('click', () => toggleDrawer(false));
document.querySelector('#close-toast').addEventListener('click', () => { document.querySelector('#toast').hidden = true; });
const tooltip = document.querySelector('#help-tooltip');
let helpButton;
let helpPinned = false;
let helpTimer;
function hideHelp() {
  clearTimeout(helpTimer);
  if (helpButton) { helpButton.setAttribute('aria-expanded','false'); helpButton.removeAttribute('aria-describedby'); }
  helpButton = undefined; helpPinned = false; tooltip.hidden = true;
}
function showHelp(button, pin = false) {
  clearTimeout(helpTimer);
  if (helpButton !== button) hideHelp();
  helpButton = button; helpPinned = pin || helpPinned;
  tooltip.textContent = button.dataset.help; tooltip.hidden = false;
  button.setAttribute('aria-expanded','true'); button.setAttribute('aria-describedby','help-tooltip');
  const rect = button.getBoundingClientRect();
  const size = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(12,Math.min(rect.left,innerWidth-size.width-12))}px`;
  tooltip.style.top = `${Math.max(12,rect.bottom+size.height+10>innerHeight ? rect.top-size.height-8 : rect.bottom+8)}px`;
}
document.addEventListener('pointerover',event => { const button = event.target.closest('[data-help]'); if(button) showHelp(button); if(event.target.closest('#help-tooltip')) clearTimeout(helpTimer); });
document.addEventListener('pointerout',event => {
  if(event.target.closest('[data-help],#help-tooltip') && !helpPinned && document.activeElement !== helpButton) helpTimer=setTimeout(hideHelp,200);
});
document.addEventListener('focusin',event => { const button = event.target.closest('[data-help]'); if(button) showHelp(button); else if(!helpPinned) hideHelp(); });
document.addEventListener('click',event => {
  const button = event.target.closest('[data-help]');
  if(button) { if(helpButton===button && helpPinned) hideHelp(); else showHelp(button,true); }
  else if(!event.target.closest('#help-tooltip')) hideHelp();
});
function repositionHelp() {
  if (helpButton && (helpPinned || document.activeElement === helpButton)) showHelp(helpButton,helpPinned);
  else hideHelp();
}
window.addEventListener('resize',repositionHelp);
window.addEventListener('scroll',repositionHelp,true);
document.addEventListener('keydown',event => {if(event.key==='Escape') hideHelp();});
document.addEventListener('keydown', ev => { if(ev.key === 'Escape' && !document.querySelector('#activity-drawer').hidden) toggleDrawer(false); });
window.addEventListener('hashchange', () => { document.querySelector('#activity-drawer').hidden = true; document.querySelector('#activity-toggle').setAttribute('aria-expanded','false'); void render(); });
async function start() {
  try { await api('/api/instances/migrate-legacy',{method:'POST',body:{},timeoutMs:120000});await refresh(); await render(); }
  catch (error) {
    document.querySelector('#service-error').hidden = false; document.querySelector('#service-error-text').textContent = error.message;
    document.querySelector('#connection-dot').className = 'dot error'; document.querySelector('#connection-label').textContent = '工作台服务未连接';
    root.innerHTML = '<div class="initial-loading"><h1>暂时无法读取工作台</h1><p>请使用上方的“重新连接”重试，已有资料仍保存在本机。</p></div>';
    document.querySelector('#app-shell').setAttribute('aria-busy','false');
  }
}
document.querySelector('#retry-service').addEventListener('click', ev => action(ev.currentTarget,start));
void start();
