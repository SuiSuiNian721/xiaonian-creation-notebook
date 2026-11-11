import { escape as e, icon, moduleIcon, eventList, help } from './components.js';
import { mountInstallation } from './installation-view.js';
import { mountEnvironmentDiscovery } from './environment-view.js';
import {mountModulePathPickers} from './path-picker.js';

// Module views receive only the public workbench context. They never import another module.
export function defineModuleView({ id, flow, guide, primaryLink }) {
  return function mount(root, ctx) {
    const module = () => ctx.state.modules.find(m => m.id === id);
    let tab = ctx.ui.moduleTabs[id] || 'overview';
    let tabEvents;
    const draftKey = `module:${id}`;
    root.innerHTML = `<div class="module-heading">${moduleIcon(id,'large')}<div class="heading-title"><h1>${e(module().name)}</h1>${help(module().description,`${module().name}说明`)}</div><div class="remove-control"><button class="button ghost small" id="remove-module" type="button">移除入口</button><small>保留配置与资料</small></div></div><div class="module-tabs" role="tablist" aria-label="模块页面"><button id="tab-overview" type="button" role="tab" data-tab="overview" aria-controls="module-panel">概览</button><button id="tab-resources" type="button" role="tab" data-tab="resources" aria-controls="module-panel">资源安装</button><button id="tab-config" type="button" role="tab" data-tab="config" aria-controls="module-panel">接入配置</button><button id="tab-records" type="button" role="tab" data-tab="records" aria-controls="module-panel">运行记录</button></div><section id="module-panel" role="tabpanel"></section>`;
    const panel = root.querySelector('#module-panel');
    root.querySelector('#remove-module').addEventListener('click', async ev => {
      await ctx.action(ev.currentTarget, async () => {
        await ctx.api(`/api/modules/${id}/disable`, { method:'POST', body:{} }); await ctx.refresh(); ctx.notify('入口已移除，配置和资料仍然保留。'); ctx.navigate('home');
      });
    }, { signal:ctx.signal });
    function draw() {
      tabEvents?.abort(); tabEvents = new AbortController();
      if (ctx.signal.aborted) { tabEvents.abort(); return; }
      const signal = tabEvents.signal;
      root.querySelectorAll('[data-tab]').forEach(b => { const active = b.dataset.tab === tab; b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
      panel.setAttribute('aria-labelledby', `tab-${tab}`);
      const m = module();
      if (tab === 'overview') {
        const character = ctx.state.characters.find(c => c.id === ctx.state.selectedCharacterId);
        panel.innerHTML = `<div class="module-overview${m.usesCharacterContext === false ? ' without-character' : ''}"><section class="panel glass"><div class="panel-heading"><h2>功能</h2><button type="button" class="button primary" id="go-config">${icon('settings')}接入配置</button></div><div class="module-flow" aria-label="计划中的模块流程">${flow.map((step,i) => `${i ? icon('arrow') : ''}<span>${e(step)}</span>`).join('')}</div><ul class="capability-list">${m.capabilities.map(c => `<li><span>${e(c.label)}</span><span class="status-chip ${c.status === 'available' ? 'good' : ''}">${c.status === 'available' ? '可使用' : '待接入'}</span></li>`).join('')}</ul>${primaryLink ? `<a class="text-link" href="#/${e(primaryLink.route)}">${e(primaryLink.label)}${icon('arrow')}</a>` : ''}</section>${m.usesCharacterContext === false ? '' : `<aside class="panel glass"><div class="panel-heading"><h2>当前角色</h2><a class="text-link" href="#/characters">管理 ${icon('arrow')}</a></div><div class="binding-summary"><span class="character-avatar">${character ? e([...character.name][0]) : icon('person')}</span><div><strong>${character ? e(character.name) : '未选择'}</strong>${character ? `<small>版本 ${e(character.revision)}</small>` : ''}</div></div><div class="module-tool-section"><div class="heading-title"><h3>接入工具</h3>${help(`计划使用：${m.requirements.join('、')}。${m.optionalIntegrations.length ? `可选协作：${m.optionalIntegrations.join('、')}。` : ''}当前仅保存配置，尚未建立连接。`,'工具接入说明')}</div><ul class="dependency-list">${m.requirements.map(item => `<li>${e(item)}</li>`).join('')}</ul></div></aside>`}</div>`;
        panel.querySelector('#go-config').addEventListener('click', () => selectTab('config'), { signal });
      } else if (tab === 'resources') {
        mountInstallation(panel, { api:ctx.api, ui:ctx.ui, signal, refresh:ctx.refresh }, id);
      } else if (tab === 'config') {
        let savedConfig = m.config;
        let pathChecks = m.checks;
        const values = ctx.drafts.read(draftKey, m.config);
        panel.innerHTML = `<div class="configuration-layout"><section class="panel glass"><div class="panel-heading"><h2>工具配置</h2>${help('保存配置不会连接或启动工具。路径检查仅确认普通本地磁盘上的文件或目录存在，不验证模型可用性。','配置与检查说明')}</div><form id="module-config-form">${m.settings.map(field => `<div class="field"><div class="field-label"><label for="config-${e(field.key)}">${e(field.label)}</label>${field.help ? help(field.help,`${field.label}说明`) : ''}</div><input id="config-${e(field.key)}" name="${e(field.key)}" data-setting="${e(field.key)}" type="${field.type === 'url' ? 'url' : 'text'}" value="${e(values[field.key] || '')}" placeholder="${e(field.placeholder || '')}" maxlength="2048" autocomplete="off" spellcheck="false">${field.type === 'path' ? `<div class="path-result" data-path-result="${e(field.key)}"></div>` : ''}</div>`).join('')}<div class="form-actions"><p id="config-feedback" class="form-feedback" role="status"></p>${m.settings.some(f => f.type === 'path') ? '<button type="button" class="button" id="check-paths">检查路径</button>' : ''}<button type="submit" class="button primary" id="save-module-config">保存配置</button></div></form><details class="setup-guide"><summary>搭建说明</summary><ol>${guide.map(step => `<li>${e(step)}</li>`).join('')}</ol></details></section></div>`;
        const form = panel.querySelector('#module-config-form');
        mountModulePathPickers(form,ctx,id,m.settings);
        const feedback = panel.querySelector('#config-feedback');
        const check = panel.querySelector('#check-paths');
        const currentValues = () => Object.fromEntries(m.settings.map(f => [f.key, form.elements[f.key].value]));
        const sameValues = (a,b) => m.settings.every(f => (a[f.key] || '') === (b[f.key] || ''));
        const updateChecks = () => {
          const dirty = !sameValues(currentValues(), savedConfig);
          if (check) check.disabled = dirty;
          panel.querySelectorAll('[data-path-result]').forEach(node => {
            const key = node.dataset.pathResult; const result = pathChecks?.[key];
            if (currentValues()[key] !== (savedConfig[key] || '')) { node.className = 'path-result'; node.textContent = '修改尚未保存'; return; }
            node.className = `path-result ${result?.status || ''}`;
            node.innerHTML = result ? `${icon(result.status === 'valid' ? 'check' : 'info')}<span>${e(result.message)}</span>` : '';
          });
        };
        form.addEventListener('input', () => { ctx.drafts.write(draftKey, currentValues()); feedback.textContent = '有未保存的修改'; feedback.className = 'form-feedback neutral'; updateChecks(); }, { signal });
        if (id === 'training') {
          const discovery = document.createElement('div'); form.before(discovery);
          mountEnvironmentDiscovery(discovery,{...ctx,signal},{moduleId:id,onSelect:candidate => {
            const selected=Object.hasOwn(candidate.values,'trainerPath')?{pythonPath:'',...candidate.values}:candidate.values;
            for (const field of m.settings) {
              if (Object.hasOwn(selected,field.key)) form.elements[field.key].value=selected[field.key];
            }
            form.dispatchEvent(new Event('input',{bubbles:true}));
          }});
        }
        form.addEventListener('submit', async ev => {
          ev.preventDefault(); const snapshot = currentValues(); const button = form.querySelector('[type="submit"]');
          button.disabled = true; if(check) check.disabled = true; feedback.textContent = '正在保存…'; feedback.className = 'form-feedback neutral';
          try {
            const result = await ctx.api(`/api/modules/${id}/config`, { method:'PUT', body:{ values:snapshot } });
            const saved = result.config;
            savedConfig = saved; pathChecks = result.checks;
            await ctx.refresh();
            ctx.drafts.reconcile(draftKey, snapshot, saved);
            if (signal.aborted || ctx.signal.aborted) return;
            for (const field of m.settings) {
              if (form.elements[field.key].value === snapshot[field.key]) form.elements[field.key].value = saved[field.key] || '';
            }
            feedback.textContent = sameValues(currentValues(), saved) ? '配置已保存，尚未连接外部服务。' : '上一份配置已保存，新的修改仍保留在这里。'; feedback.className = 'form-feedback';
          } catch (error) { feedback.textContent = error.message; feedback.className = 'form-feedback error'; }
          finally { button.disabled = false; if (!signal.aborted) updateChecks(); }
        }, { signal });
        check?.addEventListener('click', async () => {
          check.disabled = true; const save = panel.querySelector('#save-module-config'); save.disabled = true;
          feedback.textContent = '正在检查已保存的路径…'; feedback.className = 'form-feedback neutral';
          try { const result = await ctx.api(`/api/modules/${id}/check-paths`, { method:'POST', body:{} }); pathChecks = result.checks; await ctx.refresh(); if (!signal.aborted) { updateChecks(); feedback.textContent = '检查完成，结果显示在对应路径下方。'; feedback.className = 'form-feedback'; } }
          catch (error) { feedback.textContent = error.message; feedback.className = 'form-feedback error'; }
          finally { save.disabled = false; if (!signal.aborted) updateChecks(); }
        }, { signal });
        updateChecks();
      } else {
        panel.innerHTML = `<div class="panel glass"><div class="panel-heading"><h2>运行记录</h2><button type="button" class="button small" id="refresh-module-events">${icon('activity')}刷新</button></div><div id="module-events">${eventList(ctx.state.events.filter(event => event.moduleId === id), ctx.state.modules)}</div></div>`;
        const refresh = panel.querySelector('#refresh-module-events');
        refresh.addEventListener('click', () => ctx.action(refresh, async () => { await ctx.refresh(); if (!signal.aborted) panel.querySelector('#module-events').innerHTML = eventList(ctx.state.events.filter(event => event.moduleId === id), ctx.state.modules); }), { signal });
      }
    }
    function selectTab(next, focus = false) { tab = next; ctx.ui.moduleTabs[id] = tab; draw(); if (focus) root.querySelector(`[data-tab="${tab}"]`).focus(); }
    root.querySelectorAll('[data-tab]').forEach(button => {
      button.addEventListener('click', () => selectTab(button.dataset.tab), { signal:ctx.signal });
      button.addEventListener('keydown', event => {
        const tabs = ['overview','resources','config','records']; let next;
        if (event.key === 'ArrowRight') next = tabs[(tabs.indexOf(tab)+1)%tabs.length];
        if (event.key === 'ArrowLeft') next = tabs[(tabs.indexOf(tab)+tabs.length-1)%tabs.length];
        if (event.key === 'Home') next = tabs[0]; if (event.key === 'End') next = tabs.at(-1);
        if (next) { event.preventDefault(); selectTab(next,true); }
      }, { signal:ctx.signal });
    });
    ctx.signal.addEventListener('abort', () => tabEvents?.abort(), { once:true });
    draw();
  };
}
