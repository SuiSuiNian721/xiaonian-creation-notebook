import {escape as e} from './components.js';

export function mountWorkflowSearch(root,ctx,onImport){
  let files=ctx.ui.drawingLocalFiles||[];
  root.innerHTML=`<div class="field"><input type="search" id="workflow-keyword" aria-label="关键词检索本地工作流" placeholder="关键词检索工作流" value="${e(ctx.ui.drawingWorkflowKeyword||'')}"></div><div data-local-workflow-results></div>`;
  const input=root.querySelector('input'),results=root.querySelector('[data-local-workflow-results]');
  function render(){
    const terms=input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matched=files.filter(file=>terms.every(term=>file.name.toLocaleLowerCase().includes(term)));
    results.innerHTML=matched.length?`<ul class="drawing-local-files">${matched.map(file=>`<li><span>${e(file.name)}</span><button type="button" class="button small" data-import-local="${e(file.key)}">导入</button></li>`).join('')}</ul>`:ctx.ui.drawingLocalFiles?`<p class="form-feedback" role="status">${files.length?'没有匹配的工作流':'未扫描到本地工作流'}</p>`:'';
    results.querySelectorAll('[data-import-local]').forEach(button=>button.onclick=()=>onImport(button,files.find(file=>file.key===button.dataset.importLocal)));
  }
  input.addEventListener('input',()=>{ctx.ui.drawingWorkflowKeyword=input.value;render();},{signal:ctx.signal});
  render();
  return {setFiles(next){files=next;ctx.ui.drawingLocalFiles=next;render();}};
}
