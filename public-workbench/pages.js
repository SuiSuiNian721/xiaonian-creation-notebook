import { escape as e, icon, moduleIcon, eventList, dateLabel, downloadJson, help } from './components.js';
import { mountAISettings } from './ai-settings.js';
import { openCharacterLife } from './character-life.js';
import {mountUserSettings,avatarMarkup} from './user-settings.js';
import {moduleFamilyId,workspaceModules} from './module-families.js';
import {openCharacterResources,resourceKinds} from './character-resources-ui.js';
import {confirmDeleteCharacter,mountDeletedCharacters} from './character-deletion-ui.js';
import {mountComponentPackages} from './component-packages.js';

const pageHeading = (title, action = '', info = '') => `<div class="page-heading"><div class="heading-title"><h1>${title}</h1>${info ? help(info,`${title}说明`) : ''}</div>${action}</div>`;
const avatar = character => `<span class="character-avatar">${character ? avatarMarkup(character.avatar,character.name) : icon('person')}</span>`;

export function home(root, ctx) {
  const state = ctx.state;
  const installed = workspaceModules(state.modules).filter(m => m.enabled);
  const recent = installed.filter(m => m.lastOpenedAt).sort((a,b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).slice(0,4);
  root.innerHTML = `${pageHeading('我的工作台', `<a class="button primary" href="#/catalog">${icon('plus')}添加模块</a>`, '角色卡创作、ComfyUI 绘图与 MC 皮肤制作已接入，具体能力和环境状态可在模块中查看。')}
    <section aria-label="我的模块">${installed.length ? `<div class="launcher-grid">${installed.map(m => `<button class="launcher glass" type="button" data-open="${e(m.id)}" aria-label="打开${e(m.name)}">${moduleIcon(m.id)}<strong>${e(m.name)}</strong><span class="open-mark">${icon('arrow')}</span></button>`).join('')}</div>` : `<div class="empty-workspace glass"><div class="empty-heading">${icon('grid')}<h2>尚未添加模块</h2></div><div class="starter-list">${['cards','drawing','companion'].map(id => state.modules.find(m => m.id === id)).filter(Boolean).map(m => `<button type="button" class="starter-item" data-add="${e(m.id)}" aria-label="添加${e(m.name)}">${moduleIcon(m.id)}<strong>${e(m.name)}</strong><span class="add-label">${icon('plus')}添加</span></button>`).join('')}</div></div>`}</section>
    <div class="bottom-columns"><section class="subtle-section"><div class="section-heading"><h2>最近打开</h2></div>${recent.length ? `<ul class="recent-list">${recent.map(m => `<li><button type="button" class="recent-row" data-open="${e(m.id)}">${moduleIcon(m.id)}<span>${e(m.name)}</span><small>${dateLabel(m.lastOpenedAt)}</small>${icon('arrow')}</button></li>`).join('')}</ul>` : '<div class="quiet-empty"><p>暂无记录</p></div>'}</section><section class="subtle-section home-character"><div class="section-heading"><h2>角色资料</h2><a class="text-link" href="#/characters">打开资料库 ${icon('arrow')}</a></div><a class="button" href="#/characters">${icon('person')}管理 ${state.characters.length} 份人设作品</a></section></div>`;
}

export function catalog(root, ctx) {
  root.innerHTML = `${pageHeading('添加模块', '', '添加后可在左侧打开模块。角色卡编辑器随工作台提供；其余模块的外部工具与资源按需接入。')}
    <div class="catalog-toolbar"><div class="segmented" role="group" aria-label="模块分类"><button type="button" data-category="all">全部模块</button><button type="button" data-category="create">创作工具</button><button type="button" data-category="companion">互动陪伴</button></div><label class="search-box">${icon('search')}<span class="sr-only">搜索模块</span><input id="module-search" type="search" placeholder="搜索模块或工具" value="${e(ctx.ui.catalogQuery || '')}"></label></div><div id="catalog-grid" class="catalog-grid"></div>`;
  const draw = () => {
    const category = ctx.ui.catalogCategory || 'all';
    const query = (ctx.ui.catalogQuery || '').trim().toLocaleLowerCase();
    root.querySelectorAll('[data-category]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.category === category)));
    const modules = workspaceModules(ctx.state.modules).filter(m => (category === 'all' || m.category === category) && `${m.name} ${m.subtitle} ${m.description} ${m.requirements.join(' ')}`.toLocaleLowerCase().includes(query));
    root.querySelector('#catalog-grid').innerHTML = modules.length ? modules.map(m => `<article class="catalog-module glass" data-module-card="${e(m.id)}">${moduleIcon(m.id)}<div class="catalog-module-main"><div class="heading-title"><h2>${e(m.name)}</h2>${help(m.description,`${m.name}说明`)}</div></div><button type="button" class="button small ${m.enabled ? '' : 'primary'}" aria-label="${m.enabled ? '打开' : '添加'}${e(m.name)}" ${m.enabled ? `data-open="${e(m.id)}"` : `data-add="${e(m.id)}"`}>${icon(m.enabled ? 'arrow' : 'plus')}${m.enabled ? '打开' : '添加'}</button></article>`).join('') : '<div class="quiet-empty"><p>没有找到模块</p></div>';
  };
  root.querySelector('#module-search').addEventListener('input', ev => { ctx.ui.catalogQuery = ev.target.value; draw(); }, { signal:ctx.signal });
  root.querySelectorAll('[data-category]').forEach(b => b.addEventListener('click', () => { ctx.ui.catalogCategory = b.dataset.category; draw(); }, { signal:ctx.signal }));
  draw();
}

export function characters(root, ctx) {
  const draftKey = 'character:create';
  const draft = ctx.drafts.read(draftKey, { name:'', description:'' });
  root.innerHTML = `${pageHeading('角色资料', '', '管理角色的人设、世界书、记忆、状态和文件。其他模块可以选用这里的资料，也可以把作品与文件保存回来。模块内已导入的人设和聊天记录分别保留。')}
    <div class="characters-layout"><section class="character-list" aria-label="角色档案列表">${ctx.state.characters.length ? ctx.state.characters.map(c => `<article class="character-row glass" data-character-id="${e(c.id)}"><div class="character-row-heading">${avatar(c)}<div><h2>${e(c.name)}</h2><small>版本 ${e(c.revision)} · ${dateLabel(c.updatedAt)}</small></div>${c.id === ctx.state.selectedCharacterId ? '<span class="status-chip good">当前角色</span>' : ''}</div>${c.description ? `<p>${e(c.description)}</p>` : ''}<div class="character-row-actions"><button class="button small" type="button" data-select-character="${e(c.id)}" ${c.id === ctx.state.selectedCharacterId ? 'disabled' : ''}>${icon('check')}${c.id === ctx.state.selectedCharacterId ? '已选用' : '选用角色'}</button><button class="text-link" type="button" data-export-character="${e(c.id)}">${icon('download')}导出 JSON</button>${help('导出人设、原始角色卡和文件索引。角色文件本体、记忆、状态与聊天记录不包含在内，不能用作完整备份。','JSON 导出范围')}</div><details><summary>原始 JSON</summary><pre>${e(JSON.stringify(c.raw, null, 2))}</pre></details></article>`).join('') : `<div class="panel glass empty-characters">${icon('person')}<h2>暂无角色</h2></div>`}</section>
    <section class="panel glass"><div class="panel-heading"><h2>新建角色</h2>${icon('person')}</div><form id="create-character-form"><div class="field"><label for="new-character-name">角色名称</label><input id="new-character-name" name="name" maxlength="100" required value="${e(draft.name)}"></div><div class="field"><label for="new-character-description">角色简介</label><textarea id="new-character-description" name="description" rows="4" maxlength="12000">${e(draft.description)}</textarea></div><div class="form-actions"><p id="character-feedback" class="form-feedback" role="status"></p><button class="button primary" type="submit">${icon('plus')}创建角色</button></div></form><div class="import-area"><input id="character-import-file" type="file" accept=".json,application/json" class="sr-only" tabindex="-1"><div class="heading-title"><button id="import-character" class="button" type="button">${icon('upload')}导入 JSON</button>${help('支持人设 JSON 和工作台角色资料包，最大 2 MiB。保留原始字段；PNG 角色卡暂不支持。','角色导入说明')}</div><p id="import-feedback" class="form-feedback" role="status"></p></div></section></div>`;
  root.querySelectorAll('[data-character-id]').forEach(row => {
    row.querySelector('[data-select-character]')?.remove();row.querySelector('.status-chip')?.remove();
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button small';
    button.dataset.characterLifeId = row.dataset.characterId; button.innerHTML = `${icon('settings')}人设与记忆`;
    row.querySelector('.character-row-actions').prepend(button);
    button.addEventListener('click', () => openCharacterLife(ctx, {characterId:button.dataset.characterLifeId,trigger:button}), {signal:ctx.signal});
    const categories=document.createElement('div');categories.className='character-resource-categories';categories.setAttribute('aria-label','角色文件分类');
    for(const [kind,label] of Object.entries(resourceKinds)){
      const resources=document.createElement('button');resources.type='button';resources.className='button small';resources.dataset.characterResources=row.dataset.characterId;resources.dataset.characterResourceKind=kind;resources.textContent=label;
      resources.addEventListener('click',()=>void openCharacterResources(ctx,{characterId:row.dataset.characterId,accept:[kind],title:label}),{signal:ctx.signal});categories.append(resources);
    }
    row.querySelector('.character-row-actions').after(categories);
    const remove=document.createElement('button');remove.type='button';remove.className='text-link danger';remove.dataset.deleteCharacter=row.dataset.characterId;remove.textContent='删除';
    remove.addEventListener('click',()=>confirmDeleteCharacter(ctx,row.dataset.characterId),{signal:ctx.signal});row.querySelector('.character-row-actions').append(remove);
  });
  const form = root.querySelector('#create-character-form');
  const readDraft = () => ({ name:form.elements.name.value, description:form.elements.description.value });
  form.addEventListener('input', () => ctx.drafts.write(draftKey, readDraft()), { signal:ctx.signal });
  form.addEventListener('submit', async ev => {
    ev.preventDefault(); const snapshot = readDraft(); const button = form.querySelector('[type="submit"]'); const feedback = root.querySelector('#character-feedback');
    button.disabled = true; feedback.textContent = '正在保存…'; feedback.className = 'form-feedback neutral';
    try {
      await ctx.api('/api/characters', { method:'POST', body:snapshot });
      ctx.drafts.commit(draftKey, snapshot); await ctx.refresh();
      ctx.notify('角色已创建。'); if (!ctx.signal.aborted) ctx.rerender();
    } catch (error) { feedback.textContent = error.message; feedback.className = 'form-feedback error'; }
    finally { button.disabled = false; }
  }, { signal:ctx.signal });
  root.querySelector('#character-import-file').accept = '.json,.png,application/json,image/png';
  root.querySelector('#import-character').innerHTML = `${icon('upload')}导入角色卡`;
  const importHelp = root.querySelector('.import-area [data-help]');
  importHelp.dataset.help = '支持 JSON 人设和 PNG 角色卡。JSON 最大 2 MiB，PNG 最大 8 MiB；原始字段会保留。';
  root.querySelector('#import-character').addEventListener('click', () => root.querySelector('#character-import-file').click(), { signal:ctx.signal });
  root.querySelector('#character-import-file').addEventListener('change', async ev => {
    const file = ev.target.files[0]; if (!file) return;
    const feedback = root.querySelector('#import-feedback'); const button = root.querySelector('#import-character');
    button.disabled = true; feedback.textContent = '正在读取资料…'; feedback.className = 'form-feedback neutral';
    try {
      const png = /\.png$/i.test(file.name);
      if (file.size > (png ? 8 : 2) * 1024 * 1024) throw new Error(png ? 'PNG 角色卡超过 8 MiB，请缩小图片后重新导入。' : 'JSON 文件超过 2 MiB，请移除其中内嵌的大型资源后重试。');
      if (png) {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset,offset + 8192));
        await ctx.api('/api/characters/import-file', {method:'POST',body:{name:file.name,base64:btoa(binary)}});
      } else {
        let document;
        try { document = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error('文件不是有效的 JSON，请检查内容后重新导入。'); }
        await ctx.api('/api/characters/import', { method:'POST', body:{ document } });
      }
      await ctx.refresh(); ctx.notify('角色已导入。'); if (!ctx.signal.aborted) ctx.rerender();
    } catch (error) { feedback.textContent = error.message; feedback.className = 'form-feedback error'; }
    finally { button.disabled = false; ev.target.value = ''; }
  }, { signal:ctx.signal });
  root.querySelectorAll('[data-select-character]').forEach(button => button.addEventListener('click', async () => {
    await ctx.action(button, async () => { await ctx.selectCharacter(button.dataset.selectCharacter); });
  }, { signal:ctx.signal }));
  root.querySelectorAll('[data-export-character]').forEach(button => button.addEventListener('click', () => ctx.action(button, async () => {
    const id = button.dataset.exportCharacter;
    const bundle = await ctx.api(`/api/characters/${encodeURIComponent(id)}/export`);
    const character = ctx.state.characters.find(c => c.id === id);
    downloadJson(bundle, `${character?.name || '角色'}-人设资料-v${character?.revision || 1}`); await ctx.refresh(); ctx.notify('人设与文件索引已准备导出为 JSON。');
  }), { signal:ctx.signal }));
  void mountDeletedCharacters(root,ctx);
}

export function events(root, ctx) {
  root.innerHTML = `${pageHeading('运行记录', `<button class="button" id="refresh-events" type="button">${icon('activity')}刷新</button>`)}<div class="panel glass"><div class="events-toolbar"><label for="event-filter">模块</label><select id="event-filter" class="log-filter"><option value="all">全部</option><option value="workbench">工作台</option>${workspaceModules(ctx.state.modules).map(m => `<option value="${e(m.id)}">${e(m.name)}</option>`).join('')}</select></div><div id="event-results"></div></div>`;
  const select = root.querySelector('#event-filter'); select.value = ctx.ui.eventFilter || 'all';
  const draw = () => { root.querySelector('#event-results').innerHTML = eventList(ctx.state.events.filter(ev => select.value === 'all' || (select.value === 'workbench' ? !ev.moduleId : moduleFamilyId(ctx.state.modules,ev.moduleId) === select.value)), ctx.state.modules, 500); };
  select.addEventListener('change', () => { ctx.ui.eventFilter = select.value; draw(); }, { signal:ctx.signal });
  const refresh = root.querySelector('#refresh-events'); refresh.addEventListener('click', () => ctx.action(refresh, async () => { await ctx.refresh(); if (!ctx.signal.aborted) draw(); }), { signal:ctx.signal });
  draw();
}

export function settings(root, ctx) {
  root.innerHTML = `${pageHeading('工作台设置')}<section class="panel glass"><div class="settings-section"><h2>外观</h2><div class="theme-choices"><button type="button" data-theme-choice="light" class="theme-choice" aria-pressed="${ctx.state.preferences.theme === 'light'}">${icon('sun')}浅色</button><button type="button" data-theme-choice="dark" class="theme-choice" aria-pressed="${ctx.state.preferences.theme === 'dark'}">${icon('moon')}深色</button></div></div><div class="settings-section"><div class="heading-title"><h2>本机数据</h2>${help('角色资料、模块配置和写卡作品分别保存。移除模块保留数据；删除角色会归档到「已删除角色」，可以恢复。本版不提供永久删除角色档案的操作。','数据管理说明')}</div><div class="settings-links"><a class="button" href="#/characters">角色资料 ${icon('arrow')}</a><a class="button" href="#/events">运行记录 ${icon('arrow')}</a></div></div><div class="settings-section"><div class="heading-title"><h2>小念的创作笔记</h2><span class="status-chip">v1.0</span>${help('已提供角色卡创作、ComfyUI 绘图与环境管理、声音生成与克隆、MC 皮肤制作、全局与模块 AI 接入及 MCP；具体能力以各模块页面为准。','版本能力说明')}</div></div></section>`;
  root.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => ctx.action(button, async () => { await ctx.setTheme(button.dataset.themeChoice); if (!ctx.signal.aborted) root.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === ctx.state.preferences.theme))); }), { signal:ctx.signal }));
  const general=root.querySelector('.panel'),tabs=document.createElement('div');
  tabs.className='module-tabs settings-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','设置分区');root.insertBefore(tabs,general);
  const sections=[['ai','AI 接入'],['user','用户资料'],['storage','组件存储'],['general','通用']];
  const panels=new Map();
  for(const [key,label] of sections){
    const panel=key==='general'?general:document.createElement('section');
    if(key!=='general')root.insertBefore(panel,general);
    panel.id='settings-panel-'+key;panel.dataset.settingsPanel=key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','settings-tab-'+key);panel.tabIndex=0;panel.hidden=key!=='ai';panels.set(key,panel);
    tabs.insertAdjacentHTML('beforeend',`<button type="button" id="settings-tab-${key}" data-settings-tab="${key}" role="tab" aria-controls="${panel.id}" aria-selected="${key==='ai'}" tabindex="${key==='ai'?0:-1}">${label}</button>`);
  }
  const buttons=[...tabs.querySelectorAll('[data-settings-tab]')];
  const activate=button=>{
    ctx.ui.settingsTab=button.dataset.settingsTab;
    for(const tab of buttons){const selected=tab===button;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;panels.get(tab.dataset.settingsTab).hidden=!selected;}
  };
  activate(buttons.find(button=>button.dataset.settingsTab===ctx.ui.settingsTab)||buttons[0]);
  for(const button of buttons){
    button.addEventListener('click',()=>activate(button),{signal:ctx.signal});
    button.addEventListener('keydown',event=>{
      const index=buttons.indexOf(button),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowRight'?(index+1)%buttons.length:event.key==='ArrowLeft'?(index+buttons.length-1)%buttons.length:null;
      if(next===null)return;event.preventDefault();activate(buttons[next]);buttons[next].focus();
    },{signal:ctx.signal});
  }
  const ai=panels.get('ai');ai.className='panel glass shared-ai-panel';void mountAISettings(ai,ctx);
  void mountUserSettings(panels.get('user'),ctx);
  const storage=panels.get('storage');storage.className='panel glass';mountComponentPackages(storage,ctx,{storage:true});
}
