import {escape as e,help,downloadJson} from './components.js';
import {createAIModelPicker} from './ai-model-picker.js';
import {mountCodexDiagnostics} from './codex-diagnostics.js';

const providerName=value=>value==='openai'?'OpenAI 兼容 API':'Codex 桥接';

export async function mountAISettings(root,ctx,{moduleId=null}={}){
  root.innerHTML='<p role="status">正在读取 AI 接入…</p>';
  const scoped=moduleId!==null,prefix=scoped?moduleId+'-ai':'ai';
  const id=name=>prefix+'-'+name,selector=name=>'#'+id(name);
  const base=scoped?'/api/ai/modules/'+encodeURIComponent(moduleId):'/api/ai';
  const draftKey=scoped?'ai:module:'+moduleId:'ai:connection';
  try{
    let original=await ctx.api(base+'/config');if(ctx.signal.aborted)return;
    const own=scoped?{...original.connection,mode:original.mode}:original;
    const saved=ctx.drafts.read(draftKey,own),global=scoped?original.global:original;
    const inherit=value=>'跟随全局'+(value?'（'+value+'）':'');
    root.innerHTML=`<div class="panel-heading"><div class="heading-title"><h2>${scoped?'AI 接入':'全局 AI 接入'}</h2>${scoped?'':help('各模块默认继承这里的连接，也可在模块中覆盖单个字段。保存不会发送模型请求，密钥仅保存在本机。','AI 接入说明')}</div>${scoped?'<a class="text-link" href="#/settings">全局设置</a>':''}</div>
      <form id="${scoped?id('form'):'shared-ai-form'}">
      ${scoped?`<div class="field"><label for="${id('mode')}">连接来源</label><select id="${id('mode')}" name="mode"><option value="global">跟随全局</option><option value="module">自定义部分字段</option></select></div>`:''}
      <fieldset class="ai-connection-fields" id="${id('fields')}"><div class="drawing-setting-grid"><div class="field"><label for="${id('provider')}">接入方式</label><select id="${id('provider')}" name="provider">${scoped?`<option value="">${e(inherit(providerName(global.provider)))}</option>`:''}<option value="codex">Codex 桥接</option><option value="openai">OpenAI 兼容 API</option></select></div><div class="field"><label for="${id('model')}">模型</label><div id="${id('model-picker')}"></div></div></div>
      <fieldset class="ai-connection-fields" id="${id('api-fields')}"><div class="field"><label for="${id('base-url')}">API Base URL</label><input id="${id('base-url')}" name="baseUrl" type="url" value="${e(saved.baseUrl)}" placeholder="${e(scoped?inherit(global.baseUrl):'http://127.0.0.1:17861/v1')}"></div>
      ${scoped?`<div class="field"><label for="${id('key-mode')}">API 密钥</label><select id="${id('key-mode')}" name="keyMode"><option value="inherit">跟随全局密钥</option><option value="custom">单独填写</option><option value="none">不使用密钥</option></select></div>`:''}
      <div class="field" id="${id('key-field')}"><label for="${id('key')}">${scoped?'本模块 API Key':'API Key'}</label><input id="${id('key')}" name="apiKey" type="password" autocomplete="new-password" placeholder="${saved.hasKey?'已保存，留空保留':scoped?'填写本模块密钥':'本地无密钥服务可留空'}">${scoped?'':`<label class="check-label"><input name="clearKey" type="checkbox">清除已保存密钥</label>`}</div><p id="${id('key-note')}" class="form-feedback" hidden></p></fieldset>
      <div class="field" id="${id('effort-field')}"><label for="${id('effort')}">思考档位</label><select id="${id('effort')}" name="reasoningEffort">${[['',scoped?inherit(global.reasoningEffort||'Codex 配置'):'跟随 Codex 配置'],...['low','medium','high','xhigh','max','ultra'].map(value=>[value,value])].map(([value,label])=>`<option value="${value}">${e(label)}</option>`).join('')}</select></div>
      ${scoped?`<div class="field"><label for="${id('enabled')}">启用 AI</label><select id="${id('enabled')}" name="enabled"><option value="inherit">${e(inherit(global.enabled?'已启用':'未启用'))}</option><option value="on">启用</option><option value="off">停用</option></select></div>`:`<label class="check-label"><input name="enabled" type="checkbox" ${saved.enabled?'checked':''}>启用 AI</label>`}</fieldset>
      ${scoped?`<p id="${id('effective')}" class="ai-effective" aria-live="polite"></p>`:`<div class="drawing-toggle-row"><label class="check-label"><input name="mcpEnabled" type="checkbox" ${saved.mcpEnabled?'checked':''}>启用工作台 MCP</label></div>`}
      <div class="form-actions"><p id="${id('feedback')}" class="form-feedback" role="status"></p><button class="button" id="${id('test')}" type="button">测试连接</button><button class="button primary" type="submit">保存${scoped?'接入':'连接'}</button></div></form>
      ${scoped?'':`<details class="setup-guide"><summary>MCP 接入</summary><div class="drawing-actions"><button class="button small" id="mcp-export" type="button">导出客户端配置</button><button class="button small" id="mcp-copy" type="button">复制 HTTP 配置</button></div><p id="mcp-feedback" class="form-feedback" role="status"></p></details>`}`;
    const find=name=>root.querySelector(selector(name)),form=root.querySelector('form');
    for(const field of ['provider','reasoningEffort'])form.elements[field].value=saved[field]||'';
    form.elements.apiKey.value=saved.apiKey||'';
    if(scoped){form.elements.mode.value=saved.mode;form.elements.keyMode.value=saved.keyMode||'inherit';form.elements.enabled.value=saved.enabled===null||saved.enabled===undefined?'inherit':saved.enabled?'on':'off';}
    else form.elements.clearKey.checked=!!saved.clearKey;
    const modelPicker=createAIModelPicker(find('model-picker'),ctx,{id:id('model'),value:saved.model,placeholder:scoped?inherit(global.model||'Codex 配置'):'跟随 Codex 配置'});
    const diagnosticsRoot=document.createElement('div');find('fields').append(diagnosticsRoot);const diagnostics=mountCodexDiagnostics(diagnosticsRoot,ctx);
    modelPicker.update(saved.provider||global.provider,!(scoped&&saved.mode==='global'));
    const read=()=>({provider:form.elements.provider.value,model:form.elements.model.value,baseUrl:form.elements.baseUrl.value,apiKey:scoped&&form.elements.keyMode.value!=='custom'?'':form.elements.apiKey.value,reasoningEffort:form.elements.reasoningEffort.value,
      ...(scoped?{mode:form.elements.mode.value,keyMode:form.elements.keyMode.value,enabled:form.elements.enabled.value==='inherit'?null:form.elements.enabled.value==='on'}:{enabled:form.elements.enabled.checked,mcpEnabled:form.elements.mcpEnabled.checked,clearKey:form.elements.clearKey.checked})});
    const feedback=(message,error=false)=>{if(ctx.signal.aborted)return;find('feedback').textContent=message;find('feedback').className='form-feedback'+(error?' error':'');};
    const comparable=value=>typeof value==='string'?value.trim():value;
    const overridesDiffer=(value,stored)=>['provider','model','baseUrl','reasoningEffort','enabled','keyMode'].some(field=>comparable(value[field])!==stored[field])||!!value.apiKey;
    let dirty=ctx.drafts.read(draftKey,null)!==null,testBusy=false,saving=false;
    const showEffective=()=>{
      if(!scoped)return;const current=original.effective;
      find('effective').textContent='当前生效：'+[providerName(current.provider),current.model||(current.provider==='codex'?'Codex 默认模型':'未设置模型'),current.provider==='codex'?(current.reasoningEffort||'默认思考档位'):current.baseUrl,current.enabled?'已启用':'未启用'].join(' · ');
    };
    const draw=()=>{
      const value=read(),inherited=scoped&&value.mode==='global',provider=value.provider||(scoped?original.global.provider:'codex'),api=provider==='openai';
      modelPicker.update(provider,!inherited);
      diagnostics.update(provider);
      if(scoped)dirty=value.mode!==original.mode||(!inherited&&overridesDiffer(value,original.connection));
      find('fields').hidden=inherited;find('fields').disabled=inherited;find('api-fields').hidden=!api;find('api-fields').disabled=inherited||!api;find('effort-field').hidden=api;
      find('test').disabled=dirty||testBusy||saving;form.querySelector('[type="submit"]').disabled=testBusy||saving;
      find('test').title=dirty?'请先保存修改，再测试已保存的连接。':'';
      if(scoped){
        const ownKey=value.keyMode==='custom';find('key-field').hidden=!ownKey;form.elements.apiKey.disabled=!ownKey;
        const address=value.baseUrl||original.global.baseUrl,usesGlobal=value.keyMode==='inherit'&&original.global.hasKey&&address!==original.global.baseUrl;
        find('key-note').hidden=!usesGlobal;find('key-note').textContent=usesGlobal?'此地址将使用全局 API 密钥。':'';
      }
    };
    form.addEventListener('input',()=>{dirty=true;ctx.drafts.write(draftKey,read());draw();if(!testBusy)feedback(dirty?'请先保存修改，再测试连接。':'');},{signal:ctx.signal});
    form.addEventListener('change',draw,{signal:ctx.signal});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(testBusy||saving)return;const snapshot=read();
      await ctx.action(form.querySelector('[type="submit"]'),async()=>{
        saving=true;draw();
        try{
        const {mode,...connection}=snapshot;
        const body=scoped?(mode==='global'?{mode}:{mode,connection}):snapshot;
        const result=await ctx.api(base+'/config',{method:'PUT',body,timeoutMs:30000});
        if(ctx.signal.aborted)return;
        const retainOverrides=scoped&&mode==='global'&&overridesDiffer(snapshot,result.connection);
        if(!retainOverrides)ctx.drafts.commit(draftKey,snapshot);
        original=result;
        if(JSON.stringify(read())===JSON.stringify(snapshot)){dirty=false;if(!retainOverrides)form.elements.apiKey.value='';if(!scoped)form.elements.clearKey.checked=false;}
        const stored=scoped?result.connection:result;form.elements.apiKey.placeholder=stored.hasKey?'已保存，留空保留':scoped?'填写本模块密钥':'本地无密钥服务可留空';
        feedback(dirty?'接入已保存，后续修改仍保留。':scoped?'模块接入已保存。'+(retainOverrides?'模块覆盖草稿已保留。':''):'共用连接已保存。');showEffective();draw();
        }catch(error){feedback(error.message,true);}
        finally{saving=false;}
      });
      if(!ctx.signal.aborted)draw();
    },{signal:ctx.signal});
    find('test').addEventListener('click',async event=>{
      if(dirty||testBusy)return;
      await ctx.action(event.currentTarget,async()=>{
        testBusy=true;draw();const started=performance.now();
        const waiting=()=>feedback('正在连接并等待模型回复… 已等待 '+Math.floor((performance.now()-started)/1000)+' 秒');
        waiting();const timer=setInterval(waiting,1000),stopTimer=()=>clearInterval(timer);ctx.signal.addEventListener('abort',stopTimer,{once:true});
        try{await ctx.api(base+'/test',{method:'POST',body:{},timeoutMs:185000});feedback('连接成功（用时 '+((performance.now()-started)/1000).toFixed(1)+' 秒）'+(dirty?'；有未保存的修改':''));}
        catch(error){feedback(error.message,true);}
        finally{stopTimer();ctx.signal.removeEventListener('abort',stopTimer);testBusy=false;}
      });
      if(!ctx.signal.aborted)draw();
    },{signal:ctx.signal});
    if(!scoped){
      root.querySelector('#mcp-export').addEventListener('click',event=>ctx.action(event.currentTarget,async()=>{const config=await ctx.api('/api/ai/mcp');downloadJson({mcpServers:{'ai-future-workbench':config.stdio}},'小念的创作笔记-MCP');if(!ctx.signal.aborted)root.querySelector('#mcp-feedback').textContent=config.enabled?'客户端配置已导出。':'配置已导出，请先启用 MCP 并保存。';}),{signal:ctx.signal});
      root.querySelector('#mcp-copy').addEventListener('click',event=>ctx.action(event.currentTarget,async()=>{const config=await ctx.api('/api/ai/mcp');await navigator.clipboard.writeText(JSON.stringify({mcpServers:{'ai-future-workbench':config.http}},null,2));if(!ctx.signal.aborted)root.querySelector('#mcp-feedback').textContent='HTTP 配置已复制；工作台重启端口可能变化，长期使用建议导出客户端配置。';}),{signal:ctx.signal});
    }
    showEffective();draw();if(dirty)feedback('请先保存修改，再测试连接。');
  }catch(error){if(!ctx.signal.aborted)root.innerHTML=`<p class="form-feedback error">${e(error.message)}</p>`;}
}
