import {escape as e,icon} from './components.js';

export function confirmDeleteCharacter(ctx,characterId){
  const character=ctx.state.characters.find(item=>item.id===characterId);if(!character)return;
  const box=document.createElement('dialog');box.className='character-resource-dialog character-delete-dialog';
  box.setAttribute('aria-labelledby','delete-character-title');
  box.innerHTML=`<h2 id="delete-character-title">删除「${e(character.name)}」？</h2><p>角色将移入「已删除角色」，人设、记忆、状态与角色文件归档保留，可以恢复。此操作不会永久删除角色档案。</p><p>其他模块已经导入的人设副本和聊天记录不会删除。</p><p class="form-feedback" role="status" data-delete-feedback></p><div class="form-actions"><button class="button" type="button" data-delete-cancel>取消</button><button class="button danger" type="button" data-delete-confirm>删除角色</button></div>`;
  document.body.append(box);box.showModal();box.querySelector('[data-delete-cancel]').focus();
  box.addEventListener('close',()=>box.remove(),{once:true});ctx.signal.addEventListener('abort',()=>box.close(),{once:true});
  box.querySelector('[data-delete-cancel]').onclick=()=>box.close();
  box.querySelector('[data-delete-confirm]').onclick=event=>void ctx.action(event.currentTarget,async()=>{
    const feedback=box.querySelector('[data-delete-feedback]');
    try{
      await ctx.api('/api/characters/'+encodeURIComponent(characterId),{method:'DELETE'});await ctx.refresh();box.close();
      ctx.notify('角色已移入「已删除角色」。');if(!ctx.signal.aborted)ctx.rerender();
    }catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';}
  });
}

export async function mountDeletedCharacters(root,ctx){
  try{
    const {characters}=await ctx.api('/api/characters/deleted');if(ctx.signal.aborted||!characters.length)return;
    const section=document.createElement('details');section.className='deleted-characters';section.dataset.deletedCharacters='';
    section.innerHTML=`<summary>已删除角色（${characters.length}）</summary><div>${characters.map(character=>`<div class="deleted-character-row"><strong>${e(character.name)}</strong><button type="button" class="button small" data-restore-character="${e(character.id)}">${icon('back')}恢复</button></div>`).join('')}</div>`;
    root.append(section);
    for(const button of section.querySelectorAll('[data-restore-character]'))button.onclick=()=>void ctx.action(button,async()=>{
      await ctx.api('/api/characters/'+encodeURIComponent(button.dataset.restoreCharacter)+'/restore',{method:'POST',body:{}});await ctx.refresh();ctx.notify('角色已恢复。');if(!ctx.signal.aborted)ctx.rerender();
    });
  }catch(error){if(!ctx.signal.aborted)ctx.notify('已删除角色暂时无法读取：'+error.message,true);}
}
