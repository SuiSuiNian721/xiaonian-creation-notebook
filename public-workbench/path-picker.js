import {icon} from './components.js';
const bindings=new WeakMap();
export function syncPathPickers(root){root.querySelectorAll('[data-path-field]').forEach(button=>{const input=button.closest('.path-picker')?.querySelector('input');button.disabled=button.dataset.pathBusy==='true'||!input||input.disabled||input.readOnly;});}
export function mountPathPicker(input,ctx,{moduleId,field,target='module',kind,trainingType}={}){
  if(!input||!kind||input.readOnly)return ()=>{};
  bindings.get(input)?.();
  const controller=new AbortController(),wrapper=document.createElement('div');wrapper.className='path-picker';input.before(wrapper);wrapper.append(input);
  const error=document.createElement('p');error.className='path-picker-error form-feedback error';error.hidden=true;error.setAttribute('role','status');wrapper.after(error);
  for(const type of ['model','either'].includes(kind)?['file','directory']:[kind]){const button=document.createElement('button');button.type='button';button.className='button small';button.dataset.pathField=field;button.dataset.pathKind=type;button.innerHTML=icon('folder')+(type==='file'?'选择文件':'选择文件夹');button.setAttribute('aria-label',(type==='file'?'选择文件：':'选择文件夹：')+(input.labels?.[0]?.textContent||field));wrapper.append(button);}
  const dispose=()=>{controller.abort();if(wrapper.contains(input)){wrapper.before(input);wrapper.remove();}error.remove();bindings.delete(input);};bindings.set(input,dispose);
  ctx.signal?.addEventListener('abort',dispose,{once:true,signal:controller.signal});
  wrapper.addEventListener('click',async event=>{
    const button=event.target.closest('[data-path-field]');if(!button||button.disabled||input.disabled||input.readOnly)return;
    const before=input.value;let type;
    try{type=typeof trainingType==='function'?trainingType():trainingType;}catch(failure){error.textContent=failure.message;error.hidden=false;return;}
    wrapper.querySelectorAll('button').forEach(node=>{node.dataset.pathBusy='true';node.disabled=true;});button.setAttribute('aria-busy','true');error.hidden=true;
    try{
      const result=await ctx.api('/api/paths/choose',{method:'POST',body:{moduleId,target,field,kind:button.dataset.pathKind,currentPath:before,...(type?{trainingType:type}:{})},timeoutMs:0,signal:ctx.signal});
      if(controller.signal.aborted||!input.isConnected||input.value!==before||type!==(typeof trainingType==='function'?trainingType():trainingType)||result.cancelled||!result.path)return;
      input.value=result.path;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    }catch(failure){if(!controller.signal.aborted&&input.isConnected){error.textContent=failure.message;error.hidden=false;}}
    finally{wrapper.querySelectorAll('button').forEach(node=>{delete node.dataset.pathBusy;node.removeAttribute('aria-busy');});syncPathPickers(wrapper);}
  },{signal:controller.signal});
  input.addEventListener('input',()=>{error.hidden=true;},{signal:controller.signal});syncPathPickers(wrapper);return dispose;
}
export function mountModulePathPickers(root,ctx,moduleId,fields){return fields.filter(field=>field.type==='path').map(field=>mountPathPicker(root.querySelector('#config-'+CSS.escape(field.key)),ctx,{moduleId,field:field.key,kind:field.pathKind}));}
