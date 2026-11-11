import {escape as e,help} from './components.js';
import {mountPathPicker} from './path-picker.js';

export function mountDrawingOutput(root,ctx,preferences={}){
  const key='drawing:output',draft=ctx.drafts.read(key,null);
  let saved=preferences;
  root.innerHTML=`<details class="drawing-output-settings"><summary>输出文件夹</summary><form><div class="field"><div class="field-label"><label for="drawing-output-path">图片输出文件夹</label>${help('留空使用工作台安装目录下的“角色绘图”。每个任务独立保存，修改只影响后续新任务。','输出文件夹说明')}</div><input id="drawing-output-path" type="text" maxlength="4096" value="${e(draft?.outputPath??preferences.customOutputPath??'')}" placeholder="${e(preferences.defaultOutputPath||'工作台安装目录／角色绘图')}" autocomplete="off"></div><div class="drawing-actions"><button type="submit" class="button small">保存</button><button type="button" class="text-link" data-reset-output>恢复默认</button></div><p class="form-feedback" role="status" data-output-feedback></p></form></details>`;
  const input=root.querySelector('input'),form=root.querySelector('form'),feedback=root.querySelector('[data-output-feedback]');
  mountPathPicker(input,ctx,{moduleId:'drawing',target:'drawing-output',field:'outputPath',kind:'directory'});
  input.addEventListener('input',()=>{ctx.drafts.write(key,{outputPath:input.value});feedback.textContent='';},{signal:ctx.signal});
  const reset=root.querySelector('[data-reset-output]');
  async function save(value){
    const before=input.value;form.querySelectorAll('button').forEach(node=>node.disabled=true);
    try{
      saved=await ctx.api('/api/modules/drawing/preferences',{method:'POST',body:{outputPath:value}});
      const latest=ctx.drafts.read(key,null);
      if(!latest||latest.outputPath===before)ctx.drafts.write(key,{outputPath:saved.customOutputPath});
      if(ctx.signal.aborted)return;
      if(input.value===before)input.value=saved.customOutputPath;
      input.placeholder=saved.defaultOutputPath;feedback.className='form-feedback';feedback.textContent='输出文件夹已保存。';
    }catch(error){if(!ctx.signal.aborted){feedback.className='form-feedback error';feedback.textContent=error.message;}}
    finally{if(!ctx.signal.aborted)form.querySelectorAll('button').forEach(node=>node.disabled=false);}
  }
  form.addEventListener('submit',event=>{event.preventDefault();void ctx.action(form.querySelector('[type="submit"]'),()=>save(input.value));},{signal:ctx.signal});
  reset.onclick=()=>void ctx.action(reset,()=>save(''));
}
