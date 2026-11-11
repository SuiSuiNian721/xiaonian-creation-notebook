export function createAIModelPicker(root,ctx,{id,value='',placeholder}){
  let control=null,provider=null,models=null,attempted=false,busy=false,error='';
  const status=document.createElement('p'),retry=document.createElement('button');
  status.className='form-feedback';status.setAttribute('role','status');status.id=id+'-status';status.hidden=true;
  retry.type='button';retry.className='button small';retry.textContent='重新读取模型';retry.dataset.modelRetry='';retry.hidden=true;
  const render=()=>{
    if(provider!=='codex'){status.hidden=true;retry.hidden=true;return;}
    const selected=control.value;
    const options=[new Option(placeholder,'')];
    for(const model of models||[])options.push(new Option(model.label,model.id));
    if(selected&&!options.some(option=>option.value===selected)){
      const retained=new Option(selected+'（未列出）',selected);retained.disabled=true;options.push(retained);
    }
    control.replaceChildren(...options);control.value=selected;
    status.textContent=busy?'正在读取模型…':error;status.hidden=!busy&&!error;
    status.className='form-feedback'+(error?' error':'');retry.hidden=!error;retry.disabled=busy;
  };
  const load=async()=>{
    if(busy||ctx.signal.aborted)return;attempted=true;busy=true;error='';render();
    try{
      const result=await ctx.api('/api/ai/codex/models',{signal:ctx.signal,timeoutMs:20000});
      if(ctx.signal.aborted)return;models=result.models;
    }catch(reason){if(ctx.signal.aborted)return;error=reason.message||'模型列表读取失败';}
    finally{busy=false;if(!ctx.signal.aborted)render();}
  };
  retry.addEventListener('click',load,{signal:ctx.signal});
  return {
    update(nextProvider,visible=true){
      if(provider!==nextProvider){
        value=control?.value??value;provider=nextProvider;
        control=document.createElement(provider==='codex'?'select':'input');control.id=id;control.name='model';
        if(provider==='codex')control.append(new Option(value,value));
        else{control.maxLength=200;control.placeholder=placeholder;}
        control.value=value;control.setAttribute('aria-describedby',status.id);
        root.replaceChildren(control,status,retry);render();
      }
      if(provider==='codex'&&visible&&!attempted)void load();
    }
  };
}
