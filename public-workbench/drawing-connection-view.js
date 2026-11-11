import { escape as e, help } from './components.js';
import { mountEnvironmentDiscovery } from './environment-view.js';
import {mountModulePathPickers} from './path-picker.js';
import {mountResourcePreparation,preparationFor,choosePreparedField} from './resource-preparation.js';

const API = '/api/modules/drawing';

export function mountConnection(root, ctx, {launcher=false}={}) {
  const {signal} = ctx;
  const module = ctx.state.modules.find(item => item.id === 'drawing');
  const fields = module.settings.filter(field => launcher ? field.key !== 'workflowPath' : field.key !== 'comfyPath');
  const key = 'module:drawing';
  let saved = module.config;
  const values = {...saved,...ctx.drafts.read(key,{})};
  if (!values.serviceUrl?.trim()) values.serviceUrl='http://127.0.0.1:8188';
  root.innerHTML = `<section class="panel glass drawing-config"><div class="panel-heading"><h2>${launcher ? 'ComfyUI 环境' : '绘图连接'}</h2>${launcher ? '<button class="button small" type="button" id="discover-comfy">检测本机 ComfyUI</button>' : help('与 ComfyUI 启动器共用服务地址及服务输出目录；也可直接连接远端 ComfyUI。角色作品的保存位置在绘图页设置。','绘图连接说明')}</div>
    <div data-environment-root></div><form id="module-config-form">${fields.map(field => `<div class="field"><div class="field-label"><label for="config-${e(field.key)}">${e(field.label)}</label>${help(field.help,field.label+'说明')}</div><input id="config-${e(field.key)}" name="${e(field.key)}" type="${field.type==='url'?'url':'text'}" value="${e(values[field.key] || '')}" placeholder="${e(field.placeholder)}"><p class="path-result" data-path-result="${e(field.key)}"></p></div>`).join('')}
    <div class="form-actions"><p class="form-feedback" role="status" id="config-feedback"></p><button type="button" id="check-paths" class="button">检查路径</button><button type="submit" id="save-module-config" class="button primary">保存配置</button></div></form>
    </section>`;
  const find = selector => root.querySelector(selector);
  const form = find('#module-config-form');
  const runtimeKey = 'drawing:runtime';
  let savedPython = null, pythonReady = false;
  const pythonField = document.createElement('div');pythonField.className='field';
  pythonField.innerHTML=`<div class="field-label"><label for="connection-python">Python 可执行文件</label>${help('用于本机 ComfyUI 启动与工作流转换。采用环境会同步填入配套 Python；留空会自动查找。保存不会启动服务。','ComfyUI Python 说明')}</div><input id="connection-python" name="pythonPath" type="text" placeholder="自动选择本体对应的 Python" autocomplete="off">`;
  find('.form-actions').before(pythonField);
  const pythonInput=find('#connection-python');pythonInput.value=ctx.drafts.read(runtimeKey,{}).pythonPath ?? '';
  pythonInput.addEventListener('input',()=>ctx.drafts.write(runtimeKey,{...ctx.drafts.read(runtimeKey,{}),pythonPath:pythonInput.value}),{signal});
  mountModulePathPickers(form,ctx,launcher?'comfyui':'drawing',fields);
  let preparation;
  if(launcher){const target=document.createElement('div');form.before(target);preparation=mountResourcePreparation(target,ctx,{...preparationFor('comfyui'),open:!values.comfyPath,onTarget:field=>choosePreparedField(form,field)});}
  const read = () => ({...saved,...ctx.drafts.read(key,{}),...Object.fromEntries(fields.map(field => [field.key,form.elements[field.key].value]))});
  const saveDraft = () => ctx.drafts.write(key,{...ctx.drafts.read(key,{}),...read()});
  const feedback = (message,error=false) => { if (!signal.aborted) { const node=find('#config-feedback'); node.textContent=message; node.className='form-feedback'+(error?' error':''); } };
  const run = (button,job) => ctx.action(button,async () => { try { await job(); } catch(error) { feedback(error.message,true);preparation?.expand(); } });
  const dirty = () => module.settings.some(field => (read()[field.key] || '') !== (saved[field.key] || '')) || pythonInput.value!==savedPython;
  const update = () => { if (!signal.aborted) { find('#check-paths').disabled=dirty();find('#save-module-config').disabled=!pythonReady; } };
  form.addEventListener('input',() => { saveDraft(); feedback('有未保存的修改'); update(); },{signal});
  mountEnvironmentDiscovery(find('[data-environment-root]'),ctx,{moduleId:launcher ? 'comfyui' : 'drawing',onSelect:candidate => {
    const current = read();
    const selected = Object.fromEntries(['comfyPath','outputPath','workflowPath'].filter(name => Object.hasOwn(candidate.values,name) && (name==='comfyPath' || !current[name])).map(name => [name,candidate.values[name]]));
    ctx.drafts.write(key,{...current,...selected});
    for (const [name,value] of Object.entries(selected)) if (form.elements[name]) form.elements[name].value=value;
    pythonInput.value=candidate.values.pythonPath ?? '';
    pythonInput.dispatchEvent(new Event('input',{bubbles:true}));
  }});
  form.addEventListener('submit',event => {
    event.preventDefault(); if(!pythonReady)return;const submitted=read(),submittedPython=pythonInput.value;
    void run(find('#save-module-config'),async () => {
      const result=await ctx.api(API+'/config',{method:'PUT',body:{values:submitted,runtimeSettings:{pythonPath:submittedPython}}});
      saved=result.config; ctx.drafts.reconcile(key,submitted,saved);
      savedPython=result.runtimeSettings.pythonPath;
      const draft=ctx.drafts.read(runtimeKey,{});
      if(draft.pythonPath===submittedPython){draft.pythonPath=savedPython;ctx.drafts.write(runtimeKey,draft);}
      if (signal.aborted) return;
      if(pythonInput.value===submittedPython)pythonInput.value=savedPython;
      for (const field of fields) if (form.elements[field.key].value===submitted[field.key]) form.elements[field.key].value=saved[field.key] || '';
      feedback(dirty() ? '已保存提交时的配置，仍有新修改。' : '配置已保存'); update(); await ctx.refresh();
    });
  },{signal});
  find('#check-paths').onclick=event => run(event.currentTarget,async () => {
    const result=await ctx.api(API+'/check-paths',{method:'POST',body:{}});
    if (signal.aborted) return;
    for (const [name,value] of Object.entries(result.checks)) {
      const node=find(`[data-path-result="${CSS.escape(name)}"]`); if (!node) continue;
      node.textContent=value.message; node.className='path-result '+value.status;
      if(['missing','wrong-type','error'].includes(value.status))preparation?.expand();
    }
  });
  if (launcher) find('#discover-comfy').onclick=event => run(event.currentTarget,async () => {
    const submitted=read(); const detected=await ctx.api(API+'/discover',{method:'POST',body:{comfyPath:submitted.comfyPath}});
    if (signal.aborted) return;
    for (const [name,value] of Object.entries(detected)) if (form.elements[name] && form.elements[name].value===submitted[name] && (name==='comfyPath' || !submitted[name])) form.elements[name].value=value;
    saveDraft(); feedback('已找到 ComfyUI 本体，请保存配置。'); update();
  });
  void ctx.api(API+'/runtime').then(runtime=>{
    if(signal.aborted)return;savedPython=runtime.settings.pythonPath || '';
    pythonInput.value=ctx.drafts.read(runtimeKey,{}).pythonPath ?? savedPython;
  }).catch(error=>feedback('无法读取 Python 启动设置：'+error.message,true)).finally(()=>{pythonReady=true;update();});
  update();
}
