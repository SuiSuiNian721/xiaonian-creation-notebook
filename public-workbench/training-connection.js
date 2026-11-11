import {escape as e,help} from './components.js';
import {mountEnvironmentDiscovery} from './environment-view.js';
import {mountModulePathPickers} from './path-picker.js';
import {mountResourcePreparation,preparationFor,choosePreparedField} from './resource-preparation.js';

export function mountTrainingConnection(root,ctx,{onSaved,onStop}){
  const module=()=>ctx.state.modules.find(m=>m.id==='training');
  let saved=module().config,checks=module().checks||{};
  const values=ctx.drafts.read('module:training',saved);
  root.innerHTML=`<div class="configuration-layout"><section class="panel glass"><div class="panel-heading"><h2>复用训练环境</h2>${help('内核源码由 APP 提供，Python/CUDA 复用已有安装。启动内核与开始训练是两个独立操作。','训练环境说明')}</div><div id="training-environment-discovery"></div><form id="module-config-form">${module().settings.map(f=>`<div class="field"><div class="field-label"><label for="config-${e(f.key)}">${e(f.label)}</label>${f.help?help(f.help,f.label+'说明'):''}</div><input id="config-${e(f.key)}" name="${e(f.key)}" data-setting="${e(f.key)}" type="text" value="${e(values[f.key]||'')}" placeholder="${e(f.placeholder||'')}" spellcheck="false" autocomplete="off"><div class="path-result" data-path-result="${e(f.key)}"></div></div>`).join('')}<div class="form-actions"><p id="config-feedback" class="form-feedback" role="status"></p><button type="button" class="button" id="check-paths">检查路径</button><button type="submit" class="button primary" id="save-module-config">保存配置</button></div></form></section></div><div class="training-connection-footer"><button type="button" class="button" id="training-stop-kernel">停止空闲内核</button>${help('有活动训练任务时不能停止内核。停止训练请在任务详情中操作。','停止内核说明')}<details><summary>自动训练接口</summary><p>MCP 与此页面使用同一个训练队列。开始训练必须提供固定请求编号，超时后先核对提交状态。</p><div class="form-actions"><button class="button" type="button" id="training-enable-mcp">启用 MCP</button><button class="button" type="button" id="training-copy-mcp">复制 MCP 配置</button></div><p id="training-mcp-feedback" role="status"></p></details></div>`;
  const find=s=>root.querySelector(s),form=find('#module-config-form'),feedback=find('#config-feedback');
  mountModulePathPickers(form,ctx,'training',module().settings);
  const preparationRoot=document.createElement('div');find('#training-environment-discovery').before(preparationRoot);
  const preparation=mountResourcePreparation(preparationRoot,ctx,{...preparationFor('training'),open:!values.trainerPath,onTarget:field=>choosePreparedField(form,field)});
  const current=()=>Object.fromEntries(module().settings.map(f=>[f.key,form.elements[f.key].value]));
  function drawChecks(){const value=current();find('#check-paths').disabled=Object.keys(value).some(key=>value[key]!==saved[key]);root.querySelectorAll('[data-path-result]').forEach(node=>{const key=node.dataset.pathResult;node.textContent=value[key]!==saved[key]?'修改尚未保存':checks[key]?.message||'';node.className='path-result '+(checks[key]?.status||'');});}
  const changed=()=>{ctx.drafts.write('module:training',current());feedback.textContent='有未保存的修改';drawChecks();};
  form.addEventListener('input',changed,{signal:ctx.signal});
  mountEnvironmentDiscovery(find('#training-environment-discovery'),ctx,{moduleId:'training',onSelect:candidate=>{const selected=Object.hasOwn(candidate.values,'trainerPath')?{pythonPath:'',...candidate.values}:candidate.values;for(const field of module().settings){if(Object.hasOwn(selected,field.key))form.elements[field.key].value=selected[field.key];}changed();}});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const snapshot=current();find('#save-module-config').disabled=true;
    try{const result=await ctx.api('/api/modules/training/config',{method:'PUT',body:{values:snapshot}});saved=result.config;checks=result.checks||{};ctx.drafts.reconcile('module:training',snapshot,saved);await ctx.refresh();if(ctx.signal.aborted)return;feedback.textContent='配置已保存';drawChecks();onSaved?.();}
    catch(error){feedback.textContent=error.message;feedback.className='form-feedback error';preparation.expand();}
    finally{if(!ctx.signal.aborted)find('#save-module-config').disabled=false;}
  },{signal:ctx.signal});
  find('#check-paths').addEventListener('click',async()=>{
    find('#check-paths').disabled=true;try{checks=(await ctx.api('/api/modules/training/check-paths',{method:'POST',body:{}})).checks;if(!ctx.signal.aborted){feedback.textContent='路径检查完成';drawChecks();if(Object.values(checks).some(check=>['missing','wrong-type','error'].includes(check.status)))preparation.expand();}}catch(error){if(!ctx.signal.aborted){feedback.textContent=error.message;preparation.expand();}}finally{if(!ctx.signal.aborted)drawChecks();}
  },{signal:ctx.signal});
  find('#training-stop-kernel').addEventListener('click',onStop,{signal:ctx.signal});
  const mcpFeedback=(text,error=false)=>{find('#training-mcp-feedback').textContent=text;find('#training-mcp-feedback').className=error?'form-feedback error':'form-feedback';};
  find('#training-enable-mcp').addEventListener('click',async()=>{try{await ctx.api('/api/ai/config',{method:'PUT',body:{mcpEnabled:true}});if(!ctx.signal.aborted)mcpFeedback('MCP 已启用，可以复制连接配置。');}catch(error){if(!ctx.signal.aborted)mcpFeedback(error.message,true);}},{signal:ctx.signal});
  find('#training-copy-mcp').addEventListener('click',async()=>{try{const info=await ctx.api('/api/ai/mcp');if(!info.enabled)throw new Error('请先启用 MCP。');await navigator.clipboard.writeText(JSON.stringify({mcpServers:{'ai-future-training':info.stdio}},null,2));if(!ctx.signal.aborted)mcpFeedback('MCP 配置已复制');}catch(error){if(!ctx.signal.aborted)mcpFeedback(error.message,true);}},{signal:ctx.signal});
  drawChecks();
}
