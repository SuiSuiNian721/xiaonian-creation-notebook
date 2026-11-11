import {escape as e,icon,moduleIcon,help} from '../components.js';
import {mountPathPicker} from '../path-picker.js';
import {mountVoiceStudio} from '../voice-studio.js';
import {saveCharacterResource} from '../character-resources-ui.js';
import {voiceReference} from '../voice-reference.js';

export async function mount(root,ctx){
  return mountWorkspace(root,ctx,'design');
}
export async function mountWorkspace(root,ctx,mode){
  const {config}=await ctx.api('/api/voice/config');if(ctx.signal.aborted)return;
  let state=await ctx.api('/api/voice/state'),voices=[],controller=null,stateTimer=0,stateRequest=0,voiceReadError='';
  const draftKey=(mode==='design'?'voice-design':'voice')+':text',draft=ctx.drafts.read(draftKey,{text:''});
  root.innerHTML=`<div class="module-heading">${moduleIcon('voice','large')}<div class="heading-title"><h1>声音</h1></div></div><div class="voice-mode-tabs" role="tablist" aria-label="声音操作"><button class="button" type="button" role="tab" id="voice-mode-design" data-voice-mode="design" aria-controls="voice-studio-panel">生成音色</button><button class="button" type="button" role="tab" id="voice-mode-clone" data-voice-mode="clone" aria-controls="voice-studio-panel">克隆声音</button></div><div data-voice-studio id="voice-studio-panel" role="tabpanel"></div>
    <section class="panel glass voice-workspace"><div class="panel-heading"><h2>音色库</h2><div class="voice-service-actions"><span data-voice-state role="status"></span><button type="button" class="button small" data-voice-start>启动服务</button><button type="button" class="button small" data-voice-stop>停止服务</button></div></div>
    <form data-voice-form><div class="field"><div class="field-label"><label for="shared-voice">音色</label>${help('生成和克隆的音色保存在同一个音色库，角色、虚拟陪伴与 QQ 可分别选择使用。测试音色不代表任何角色。','共享音色库说明')}</div><div class="voice-selection"><select id="shared-voice" name="voiceId"></select><a class="button" data-voice-export-reference download hidden>另存参考音频</a><button type="button" class="button" data-voice-bind ${ctx.state.selectedCharacterId?'':'disabled'}>用于当前角色</button></div></div>
    <div class="field"><label for="voice-text">台词</label><textarea id="voice-text" name="text" rows="3" maxlength="500" placeholder="用选中的音色朗读其他台词…">${e(draft.text)}</textarea></div>
    <div class="form-actions"><p class="form-feedback" data-voice-feedback role="status" aria-live="polite"></p><button class="button" type="button" data-voice-cancel hidden>取消等待</button><button class="button primary" type="submit" data-voice-generate>${icon('voice')}生成声音</button></div></form>
    <audio data-voice-player controls preload="metadata" hidden aria-label="生成声音试听"></audio><div class="voice-component-actions" data-voice-output-actions hidden><button type="button" class="button small" data-voice-use-reference>用此声音克隆</button><a class="button small" data-voice-export download hidden>另存音频</a><button type="button" class="button small" data-voice-library hidden>保存到角色资料</button></div>
    <details class="setup-guide" data-voice-config ${mode==='design'?'hidden':''}><summary>测试音色服务配置</summary><form data-voice-settings>
    ${[['pythonPath','MOSS Python','选择已安装 MOSS 的 python.exe'],['profilePath','固定音色配置','固定参考配置.json'],['serviceUrl','本机服务地址','http://127.0.0.1:17866']].map(([key,label,placeholder])=>`<div class="field"><label for="voice-${key}">${label}</label><input id="voice-${key}" name="${key}" value="${e(config[key]||'')}" placeholder="${e(placeholder)}" autocomplete="off" spellcheck="false"></div>`).join('')}
    <div class="form-actions"><p class="form-feedback" data-voice-config-feedback role="status"></p><button class="button" type="submit">保存配置</button></div></form><details class="setup-guide"><summary>测试声音服务日志</summary><button type="button" class="button small" data-voice-logs>读取最近日志</button><div data-voice-log-output role="status"></div></details></details></section>`;
  const find=s=>root.querySelector(s),feedback=find('[data-voice-feedback]'),player=find('[data-voice-player]'),select=find('#shared-voice'),input=find('#voice-text');
  let studioController=null,studioMode=ctx.drafts.read('voice:mode',mode),lastSpeech=null;
  async function showStudio(nextMode){
    studioMode=nextMode;ctx.drafts.write('voice:mode',nextMode);studioController?.abort();studioController=new AbortController();
    const studioCtx=Object.create(ctx);studioCtx.signal=AbortSignal.any([ctx.signal,studioController.signal]);
    root.querySelectorAll('[data-voice-mode]').forEach(button=>{const active=button.dataset.voiceMode===nextMode;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;button.classList.toggle('primary',active);});
    const panel=find('[data-voice-studio]'),body=document.createElement('div');panel.replaceChildren(body);panel.setAttribute('aria-labelledby','voice-mode-'+nextMode);
    try{await mountVoiceStudio(body,studioCtx,{mode:nextMode,onUseReference:useReference,onLibraryChanged:refresh,onSaved:async voice=>{await refresh();if(!ctx.signal.aborted){select.value=voice.id;paint();}}});}
    catch(error){if(!studioCtx.signal.aborted){const note=document.createElement('p');note.className='form-feedback error';note.setAttribute('role','status');note.textContent=error.message;body.append(note);}}
  }
  async function useReference(reference){
    ctx.drafts.write('voice:studio',{...ctx.drafts.read('voice:studio',{}),provider:reference.provider,task:'clone',referencePath:'',referenceAudio:reference,transcript:reference.transcript});
    await showStudio('clone');find('#studio-text')?.focus({preventScroll:true});find('[data-voice-studio]')?.scrollIntoView({block:'start'});
  }
  root.querySelectorAll('[data-voice-mode]').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.voiceMode!==studioMode)void showStudio(button.dataset.voiceMode);},{signal:ctx.signal}));
  find('.voice-mode-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'design':event.key==='End'?'clone':studioMode==='design'?'clone':'design';find('[data-voice-mode="'+next+'"]').focus();void showStudio(next);},{signal:ctx.signal});
  find('[data-voice-use-reference]').onclick=()=>{if(lastSpeech)void useReference(lastSpeech).catch(fail);};
  find('[data-voice-library]').onclick=()=>void saveCharacterResource(ctx,{url:player.src,name:'角色声音.wav',kind:'audio',mime:'audio/wav'});
  if(mode!=='design')for(const key of ['pythonPath','profilePath'])mountPathPicker(find('#voice-'+key),ctx,{moduleId:'voice',field:key,kind:'file'});
  function paint(){
    find('[data-voice-state]').textContent=state.busy?'正在生成'+(state.queued?` · 等待 ${state.queued}`:''):state.running?'测试声音服务已就绪':state.lastError||voiceReadError||'测试声音服务未启动';
    find('[data-voice-start]').disabled=!!controller;find('[data-voice-stop]').disabled=!!controller||state.busy||!!state.queued;
    find('[data-voice-generate]').disabled=!!controller||!select.value;find('[data-voice-cancel]').hidden=!controller;input.disabled=!!controller;
    find('[data-voice-bind]').disabled=!ctx.state.selectedCharacterId||!select.value;
    const voice=voices.find(item=>item.id===select.value),output=find('[data-voice-export-reference]');output.hidden=!voice;
    if(voice){const path='/api/voice/voices/'+encodeURIComponent(voice.id)+'/audio';output.href=ctx.url?ctx.url(path):path;output.download=voice.name+'.wav';}else output.removeAttribute('href');
    const legacy=state.configured&&select.value==='xiaoli-warm-bright';find('[data-voice-start]').hidden=!legacy;find('[data-voice-stop]').hidden=!legacy;find('[data-voice-state]').hidden=!legacy;
  }
  function paintVoices(){
    const chosen=select.value;select.innerHTML=voices.length?voices.map(item=>`<option value="${e(item.id)}">${e(item.name)}</option>`).join(''):`<option value="${e(state.configured?state.voiceId||'':'')}">${state.configured?'测试音色 · 温暖清亮':'先创建并保存音色'}</option>`;
    if([...select.options].some(option=>option.value===chosen))select.value=chosen;
  }
  async function updateState(){
    const request=++stateRequest,next=await ctx.api('/api/voice/state',{signal:ctx.signal});
    if(!ctx.signal.aborted&&request===stateRequest)state=next;
  }
  function scheduleState(){
    clearTimeout(stateTimer);if(ctx.signal.aborted)return;
    stateTimer=setTimeout(async()=>{
      try{await updateState();if(!ctx.signal.aborted)paint();}catch{}
      finally{scheduleState();}
    },controller||state.busy||state.queued?1000:3000);
  }
  async function refresh(){
    await updateState();if(ctx.signal.aborted)return;
    try{voices=(await ctx.api('/api/voice/voices',{signal:ctx.signal})).voices;voiceReadError='';}catch(error){voiceReadError='音色读取失败：'+error.message;}
    if(!ctx.signal.aborted){paintVoices();paint();scheduleState();}
  }
  const fail=error=>{if(!ctx.signal.aborted){feedback.className='form-feedback error';feedback.textContent=error.message;}};
  find('[data-voice-logs]').addEventListener('click',event=>void ctx.action(event.currentTarget,async()=>{
    const output=find('[data-voice-log-output]');output.textContent='正在读取测试声音服务日志…';
    try{
      const result=await ctx.api('/api/voice/logs',{signal:ctx.signal});if(ctx.signal.aborted)return;
      output.replaceChildren();if(!result.entries.length){output.textContent='还没有测试声音服务启动日志。新音色任务的错误在上方任务状态中查看。';return;}
      for(const entry of result.entries){const heading=document.createElement('p'),pre=document.createElement('pre');heading.textContent=entry.name+(entry.truncated?'（仅显示末尾）':'');pre.className='life-code';pre.textContent=entry.text;output.append(heading,pre);}
    }catch(error){if(!ctx.signal.aborted)output.textContent=error.message;}
  }),{signal:ctx.signal});
  input.addEventListener('input',()=>ctx.drafts.write(draftKey,{text:input.value}),{signal:ctx.signal});
  select.addEventListener('change',paint,{signal:ctx.signal});
  find('[data-voice-settings]').addEventListener('submit',event=>{
    event.preventDefault();void ctx.action(event.submitter,async()=>{
      const values=Object.fromEntries(new FormData(event.currentTarget));await ctx.api('/api/voice/config',{method:'PUT',body:{values}});
      find('[data-voice-config-feedback]').textContent='配置已保存';await refresh();
    }).catch(fail);
  },{signal:ctx.signal});
  find('[data-voice-start]').addEventListener('click',event=>{void ctx.action(event.currentTarget,async()=>{feedback.className='form-feedback';feedback.textContent='正在启动声音服务…';await ctx.api('/api/voice/start',{method:'POST',body:{},timeoutMs:130000,signal:ctx.signal});await refresh();feedback.textContent='';}).catch(fail);},{signal:ctx.signal});
  find('[data-voice-stop]').addEventListener('click',event=>{void ctx.action(event.currentTarget,async()=>{await ctx.api('/api/voice/stop',{method:'POST',body:{},signal:ctx.signal});await refresh();}).catch(fail);},{signal:ctx.signal});
  find('[data-voice-bind]').addEventListener('click',event=>{void ctx.action(event.currentTarget,async()=>{
    const id=ctx.state.selectedCharacterId;if(!id)return;
    await ctx.api(`/api/characters/${encodeURIComponent(id)}/life/settings`,{method:'POST',body:{media:{voiceEnabled:true,voiceId:select.value,voiceMode:'requested',voiceTool:''}}});
    feedback.className='form-feedback';feedback.textContent='当前角色已使用此音色';
  }).catch(fail);},{signal:ctx.signal});
  find('[data-voice-form]').addEventListener('submit',async event=>{
    event.preventDefault();if(controller||!input.value.trim())return;controller=new AbortController();const current=controller,voiceName=select.selectedOptions[0]?.textContent||'角色声音',voiceId=select.value,provider=voices.find(voice=>voice.id===voiceId)?.provider,text=input.value;
    feedback.className='form-feedback';feedback.textContent='正在排队生成完整声音…';player.pause();lastSpeech=null;find('[data-voice-output-actions]').hidden=true;paint();scheduleState();
    try{
      const result=await ctx.api('/api/voice/speech',{method:'POST',body:{text,voiceId,...(ctx.state.selectedCharacterId?{characterId:ctx.state.selectedCharacterId}:{})},timeoutMs:950000,signal:AbortSignal.any([current.signal,ctx.signal])});
      if(ctx.signal.aborted||current.signal.aborted)return;
      const url=new URL(result.url,location.href);if(url.origin!==location.origin)throw new Error('声音返回了非工作台音频地址。');
      lastSpeech=voiceReference(result,{text,name:voiceName,provider});
      player.src=url.href;player.hidden=false;find('[data-voice-library]').hidden=false;find('[data-voice-output-actions]').hidden=false;const output=find('[data-voice-export]');output.href=url.href;output.download=voiceName+'.wav';output.hidden=false;feedback.textContent='生成完成';
    }catch(error){if(!ctx.signal.aborted){feedback.className='form-feedback'+(current.signal.aborted?'':' error');feedback.textContent=current.signal.aborted?'已取消等待':error.message;}}
    finally{if(controller===current)controller=null;if(!ctx.signal.aborted){await updateState().catch(()=>{});if(!ctx.signal.aborted){paint();scheduleState();}}}
  },{signal:ctx.signal});
  find('[data-voice-cancel]').addEventListener('click',()=>controller?.abort(),{signal:ctx.signal});
  ctx.signal.addEventListener('abort',()=>{clearTimeout(stateTimer);stateRequest++;controller?.abort();studioController?.abort();player.pause();player.removeAttribute('src');},{once:true});
  paintVoices();paint();await refresh();
  if(!ctx.signal.aborted)await showStudio(['design','clone'].includes(studioMode)?studioMode:mode);
}
