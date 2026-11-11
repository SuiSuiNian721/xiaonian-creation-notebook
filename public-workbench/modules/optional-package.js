import {escape as e,icon,moduleIcon,help} from '../components.js';
import {mountInstallation} from '../installation-view.js';
import {openCharacterLife} from '../character-life.js';

export function packageHeading(root,ctx,id){
  const module=ctx.state.modules.find(item=>item.id===id);
  root.innerHTML=`<div class="module-heading">${moduleIcon(id,'large')}<div class="heading-title"><h1>${e(module.name)}</h1>${help(module.description,module.name+'说明')}</div><div class="remove-control"><button type="button" class="button ghost small" data-package-remove>移除入口</button><small>保留配置与资料</small></div></div>`;
  root.querySelector('[data-package-remove]').addEventListener('click',event=>void ctx.action(event.currentTarget,async()=>{await ctx.disableModule(id);ctx.navigate('home');}),{signal:ctx.signal});
}

export async function mountPackageInstallation(root,ctx,id){
  packageHeading(root,ctx,id);
  root.insertAdjacentHTML('beforeend',`<div class="package-toolbar"><a class="button small" href="/api/modules/${e(id)}/package" download>保存规则包 ${icon('download')}</a><button type="button" class="button small" data-package-import>选择本地规则包</button>${help(id==='companion'?'这里初始化陪伴规则。JSON 规则包不含陪伴运行组件、Live2D ZIP、VRM 或声音模型；运行端将在打开陪伴时单独检查。':'这里初始化角色策略与默认规则，JSON 规则包不包含人物形象或模型权重。','规则包内容说明')}<input type="file" accept=".json,application/json" data-package-file hidden><button type="button" class="button primary" data-package-continue>初始化后继续 ${icon('arrow')}</button></div><p class="form-feedback" data-package-source role="status"></p><div data-package-installation></div>`);
  let importedPackage=null;
  root.querySelector('[data-package-import]').addEventListener('click',()=>root.querySelector('[data-package-file]').click(),{signal:ctx.signal});
  root.querySelector('[data-package-file]').addEventListener('change',async event=>{
    const file=event.currentTarget.files[0],feedback=root.querySelector('[data-package-source]');importedPackage=null;
    if(!file)return;
    try{
      if(file.size>1024*1024)throw new Error('规则包超过 1 MiB，请选择工作台导出的 JSON 规则包。');
      const value=JSON.parse(await file.text());if(ctx.signal.aborted)return;
      if(value.format!=='ai-future-local-module-package'||value.moduleId!==id)throw new Error('这份规则包不属于当前模块。');
      importedPackage=value;feedback.textContent='已选择 '+file.name+'，请查看规则清单后确认。';feedback.className='form-feedback';
    }catch(error){if(!ctx.signal.aborted){feedback.textContent=error.message;feedback.className='form-feedback error';}}
  },{signal:ctx.signal});
  root.querySelector('[data-package-continue]').addEventListener('click',event=>void ctx.action(event.currentTarget,async()=>{
    const state=await ctx.api('/api/modules/'+id+'/resources');
    if(!state.prerequisitesReady)throw new Error('请先完成下方的规则初始化。');
    await ctx.rerender();
  }),{signal:ctx.signal});
  await mountInstallation(root.querySelector('[data-package-installation]'),ctx,id,{getPackage:()=>importedPackage});
}

export async function mountCharacterPackage(root,ctx,id){
  const state=await ctx.api('/api/modules/'+id+'/resources');
  if(ctx.signal.aborted)return;
  if(!state.prerequisitesReady)return mountPackageInstallation(root,ctx,id);
  const full=id==='character-full',mode=full?'full':'lite';
  packageHeading(root,ctx,id);
  root.insertAdjacentHTML('beforeend',`<section class="panel glass character-package"><div class="panel-heading"><h2>${full?'人设、记忆与状态':'人设与记忆'}</h2><span class="status-chip good">已安装</span></div><div class="package-features"><span>基本人设</span><span>长期记忆</span><span>记忆纠正</span>${full?'<span>心情与关系</span><span>场景规则</span><span>表达习惯</span>':''}</div><div class="package-choice"><span class="character-avatar">${icon('person')}</span><div><strong>${e(ctx.characters.getSelected()?.name||'尚未导入人设')}</strong><p>${full?'开启后，角色会参考状态和场景规则来回应。':'使用基本人设和相关记忆回复。'}</p></div></div><div class="form-actions"><p class="form-feedback" role="status" data-package-feedback></p><a class="button" href="#/characters">角色资料</a><button type="button" class="button primary" data-package-edit ${ctx.characters.getSelected()?'':'disabled'}>为此角色使用${full?'完整版':'精简版'}</button></div><details class="setup-guide"><summary>用量与使用范围</summary><p>${full?'正常聊天通常为一次回复加一次综合整理，心情、关系和规则会增加 token 用量。':'开启自动记忆后通常为一次回复加一次记忆整理；关闭自动整理通常只有一次回复。'} QQ 与陪伴使用各自的 AI 接入。这里只选择角色版本，不会自动开始聊天。</p><p>记忆保存在本机，召回内容随对话发送给所选模型。此处只修改当前实例的人设，切换版本仍保留高级配置。</p></details></section><div class="package-toolbar"><button type="button" class="button ghost small" data-package-resources>查看规则文件</button><a class="button ghost small" href="/api/modules/${e(id)}/package" download>保存规则包</a></div><div data-package-resources-panel hidden></div>`);
  root.querySelector('[data-package-edit]').addEventListener('click',event=>{const trigger=event.currentTarget;void ctx.action(trigger,async()=>{
    const character=ctx.characters.getSelected();if(!character)throw new Error('请先选择角色。');
    await ctx.api('/api/characters/'+character.id+'/life/settings',{method:'POST',body:{mode,enabled:true}});
    if(!ctx.signal.aborted)openCharacterLife(ctx,{characterId:character.id,trigger});
  });},{signal:ctx.signal});
  root.querySelector('[data-package-resources]').addEventListener('click',async event=>{
    const panel=root.querySelector('[data-package-resources-panel]');
    panel.hidden=!panel.hidden;event.currentTarget.setAttribute('aria-expanded',String(!panel.hidden));
    if(!panel.hidden&&!panel.childElementCount)await mountInstallation(panel,ctx,id);
  },{signal:ctx.signal});
}
