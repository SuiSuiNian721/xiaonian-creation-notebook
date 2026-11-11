import {escape as e,icon,help as sharedHelp,dateLabel} from './components.js';
import {mountAvatarEditor} from './user-settings.js';
import {mountVisionExtension} from './vision-extension.js';

const sections=[['profile','人设'],['worldbook','世界书'],['memory','记忆'],['media','识图与表情'],['state','状态'],['interaction','互动'],['tools','工具'],['scripts','脚本']];
const help=(text,label)=>sharedHelp(text,label).replace('data-help=','data-life-help=');
const clone=value=>structuredClone(value);
const json=value=>JSON.stringify(value??{},null,2);
const array=value=>Array.isArray(value)?value:[];
const get=(value,path)=>path.split('.').reduce((v,key)=>v?.[key],value);
const put=(value,path,next)=>{const keys=path.split('.');let target=value;for(const key of keys.slice(0,-1))target=target[key]??={};target[keys.at(-1)]=next;};
const list=value=>String(value||'').split(/[\n,，]+/).map(v=>v.trim()).filter(Boolean);
const field=(name,label,value='',{type='text',rows=3,options,wide=false,info='',placeholder='',suggestions,min,max}={})=>`<div class="field${wide?' life-wide':''}"><label for="life-${e(name)}">${e(label)}${info?help(info,label+'说明'):''}</label>${options?`<select id="life-${e(name)}" name="${e(name)}">${options.map(([id,text,disabled])=>`<option value="${e(id)}" ${String(value)===String(id)?'selected':''} ${disabled?'disabled':''}>${e(text)}</option>`).join('')}</select>`:type==='textarea'||type==='json'?`<textarea id="life-${e(name)}" name="${e(name)}" rows="${rows}" placeholder="${e(placeholder)}" ${type==='json'?'class="life-code" spellcheck="false"':''}>${e(value)}</textarea>`:`<input id="life-${e(name)}" name="${e(name)}" type="${type}" value="${e(value)}" placeholder="${e(placeholder)}" ${suggestions?`list="life-${e(name)}-suggestions"`:''} ${min!==undefined?`min="${min}"`:''} ${max!==undefined?`max="${max}"`:''} ${type==='password'?'autocomplete="new-password"':''}>${suggestions?`<datalist id="life-${e(name)}-suggestions">${suggestions.map(item=>`<option value="${e(item)}"></option>`).join('')}</datalist>`:''}`}</div>`;
const toggle=(name,label,value,info='')=>`<label class="life-switch" for="life-${e(name)}"><span>${e(label)}${info?help(info,label+'说明'):''}</span><input id="life-${e(name)}" type="checkbox" name="${e(name)}" ${value?'checked':''}></label>`;
const voiceModeField=v=>field('media.voiceMode','语音发送',v['media.voiceMode']??(v['media.voiceEnabled']?'always':'requested'),{options:[['requested','仅在明确要求时'],['always','每条回复']]});
const heading=(title,action='')=>`<div class="life-section-heading"><h3>${e(title)}</h3>${action}</div>`;
const advanced=(label,content)=>`<details class="life-advanced"><summary>${e(label)}</summary>${content}</details>`;
const button=(label,attribute,extra='')=>`<button type="button" class="button small" ${attribute} ${extra}>${label}</button>`;
const mediaTools={
  voiceTool:{label:'语音工具',kind:'voice',kinds:['voice'],placeholder:'https://your-service.example/tts',info:'把文字转成声音。服务接收 text，返回含 url 或 audio_url 的 JSON。'},
  imageSearchTool:{label:'图片搜索工具',kind:'image-search',kinds:['image-search'],placeholder:'https://your-service.example/search',info:'按关键词查找图片。服务接收 text、query，返回含 url、image_url 或 data[0].url 的 JSON。'},
  imageGenerationTool:{label:'图片生成工具',kind:'drawing',kinds:['drawing','image-generate'],placeholder:'https://your-service.example/generate',info:'可以使用角色绘图里已导入的工作流，也可添加图片生成 API。API 接收 text、query，返回含 url、image_url 或 data[0].url 的 JSON。'},
  visionTool:{label:'图片理解工具',kind:'vision',kinds:['vision'],placeholder:'https://your-service.example/vision',info:'识别用户发送的图片。服务接收 images 图片网址数组及 text，返回含 description 或 text 的 JSON。'},
};
const toolKinds=[['http','通用 API'],['drawing','工作台绘图'],['image-search','图片搜索'],['image-generate','图片生成'],['vision','图片理解'],['voice','语音'],['qzone','心情动态'],['balance','余额查询']];
const toolDefaults={name:'',description:'',url:'',method:'POST',kind:'http',workflowId:'',promptField:'',enabled:false,headers:'{}',inputSchema:'{}'};
const emotionExamples=['开心','难过','惊讶','生气','害羞','平静','困倦'];
const memoryCategories=[['trait','对话对象特点'],['experience','共同经历'],['relationship','关系'],['plan','计划']];
const memoryRealities=[['real','现实'],['story','剧情'],['uncertain','初步理解']];
const memoryConfidences=[['explicit','明确表达'],['inferred','初步理解']];
const memoryPlanStatuses=[['pending','待完成'],['completed','已完成'],['expired','已过期'],['cancelled','已取消']];
const localDateInput=value=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16):'';};
const memoryDate=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';};
let activeEditor;
export function closeCharacterLife(){activeEditor?.();}

/** One shared editor keeps the module's connection and selected conversation intact. */
export function openCharacterLife(ctx,{characterId=ctx.state.selectedCharacterId,moduleId='companion',conversationId='',trigger=document.activeElement}={}){
  const forceLite=moduleId==='companion-lite';
  const sharedScopeLabel=ctx.instanceId?'此实例内共享':'此角色内共享';
  activeEditor?.();
  const character=ctx.state.characters.find(value=>value.id===characterId);
  const dialog=document.createElement('dialog');dialog.className='character-life';dialog.dataset.characterLife='';
  dialog.setAttribute('aria-labelledby','character-life-title');
  dialog.innerHTML=`<header class="life-header"><div><h2 id="character-life-title">人设与记忆</h2><p data-life-character>${e(character?.name||'尚未选择角色')}</p></div><button type="button" class="icon-button" data-life-close aria-label="关闭人设与记忆">${icon('close')}</button></header><div class="life-body"><nav class="life-nav" aria-label="角色设置">${sections.map(([id,name])=>`<button type="button" data-life-tab="${id}" aria-current="${id==='profile'?'page':'false'}">${name}</button>`).join('')}</nav><div class="life-main"><div class="life-context" data-life-context hidden></div><form data-life-form><div data-life-content aria-busy="true"><p class="life-empty" role="status">正在读取角色资料…</p></div></form></div></div><footer class="life-footer"><p class="form-feedback" data-life-feedback role="status"></p><div class="life-footer-actions"><button class="button" type="button" data-life-save-media hidden>保存媒体设置</button><button class="button primary" type="submit" form="character-life-form" data-life-save disabled>保存人设</button></div></footer>`;
  dialog.querySelector('.life-header').insertAdjacentHTML('afterend',`<section class="life-mode" aria-label="角色功能"><div class="life-mode-options"><button type="button" data-life-mode="lite" aria-label="使用精简版角色功能" title="角色功能：人设与记忆" aria-pressed="false" disabled><strong>精简版</strong><span>人设与记忆</span></button><button type="button" data-life-mode="full" aria-label="使用完整版角色功能" title="角色功能：人设、记忆、状态、情境与行为规则" aria-pressed="false" disabled><strong>完整版</strong><span>状态、情境与行为规则</span></button></div><p data-life-mode-cost class="life-mode-cost" role="status"></p><details class="life-mode-help"><summary>功能与用量说明</summary><div><p>精简版角色功能根据基本人设和相关记忆回复。完整版还参考心情、精力、关系、世界书和行为规则；切换角色功能会保留已有资料。</p><p>记忆来自已送达或已保存到会话的对话整理，保存在本机；召回内容会发送给所选模型。可以查看来源原话、纠正、归档或删除；删除记忆不会删除原聊天。摘要按会话保留，同一对象的现实记忆可跨会话延续，剧情留在原会话。旧记忆仍按原保存范围使用。</p><p>完整版的心情值等是角色模拟状态，可以手动调整。规则按顺序匹配，判断本身不调用 AI；匹配结果会影响回复方式、群聊旁观和主动联系。</p><p>完整版通常仍是一次回复加一次综合整理，但状态、规则和整理内容更长，通常消耗更多 token。群聊加入判断、主动消息、工具续答、向量召回和媒体服务另计。实际 token 与费用取决于模型、历史长度和服务商，不承诺固定倍数。</p><p>「查看提示词」只在本地编排；「预演回复」会请求 AI，产生用量，不保存预演状态。</p></div></details></section>`);
  dialog.querySelector('[data-life-form]').id='character-life-form';document.body.append(dialog);
  dialog.querySelector('[data-life-mode-cost]').insertAdjacentHTML('afterend','<div class="life-package-links" data-life-packages></div>');
  document.documentElement.dataset.characterLifeOpen='true';dialog.showModal();dialog.querySelector('[data-life-close]').focus();
  const lifetime=new AbortController(),signal=lifetime.signal;
  let requestController=null,view=null,section='profile',editingId='',busy=false,scope='',drafts=Object.create(null),closed=false;
  let memoryOverview=null,memorySubject='',memoryController=null,memoryTimer=null,memoryRequestTimer=null,memoryGeneration=0,memoryError='',memorySnapshot=null,summarySnapshot=null,memoryManualOpen=false,feedbackVersion=0;
  let previewFrames=[],scriptResult=null,helpPopover=null,helpTrigger=null,drawingCatalog=null,drawingLoading=null;
  const drawingFields=new Map();
  const mediaRequests=new Set();
  let visionStatus=null,visionSignature='',visionError='',memeCatalog=null,catalogError='',mediaLoading=null,mediaTesting=false,mediaVersion=0,mediaReloadPending=null,disposeVisionExtension=null;
  const find=selector=>dialog.querySelector(selector);
  function hideLocalHelp(){helpTrigger?.setAttribute('aria-expanded','false');helpTrigger?.removeAttribute('aria-describedby');helpPopover?.remove();helpPopover=null;helpTrigger=null;}
  function showLocalHelp(control){
    if(control===helpTrigger)return;hideLocalHelp();helpTrigger=control;helpPopover=document.createElement('div');helpPopover.id='life-help-tooltip';helpPopover.className='life-help-tooltip';helpPopover.popover='auto';helpPopover.setAttribute('role','tooltip');helpPopover.textContent=control.dataset.lifeHelp;dialog.append(helpPopover);helpPopover.showPopover();
    const rect=control.getBoundingClientRect(),width=helpPopover.offsetWidth,height=helpPopover.offsetHeight;helpPopover.style.left=Math.max(12,Math.min(rect.left,innerWidth-width-12))+'px';helpPopover.style.top=(rect.bottom+height+12<innerHeight?rect.bottom+8:Math.max(12,rect.top-height-8))+'px';control.setAttribute('aria-expanded','true');control.setAttribute('aria-describedby','life-help-tooltip');
  }
  const key=id=>`character-life:${characterId}:${moduleId}:${conversationId}:${id}`;
  const feedback=(message='',error=false)=>{feedbackVersion++;find('[data-life-feedback]').textContent=message;find('[data-life-feedback]').className='form-feedback'+(error?' error':'');};
  const cleanup=()=>{if(closed)return;stash();closed=true;stopMemoryRefresh();disposeVisionExtension?.();requestController?.abort();for(const controller of mediaRequests)controller.abort();lifetime.abort();dialog.close();dialog.remove();delete document.documentElement.dataset.characterLifeOpen;if(trigger?.isConnected)trigger.focus();if(activeEditor===cleanup)activeEditor=null;};
  activeEditor=cleanup;
  if(ctx.instancePersona){
    const actions=document.createElement('div');actions.className='life-persona-actions';actions.dataset.lifePersonaActions='';
    actions.innerHTML=`${button(icon('upload')+'导入人设','data-life-import')}${character?button('另存到角色资料','data-life-export'):''}${button(icon('folder')+'角色文件','data-life-resources')}${help('导入的人设只属于当前实例；另存会在角色资料中创建新副本。未保存的编辑内容不会另存。','实例人设说明')}`;
    find('.life-header').insertBefore(actions,find('[data-life-close]'));
    actions.querySelector('[data-life-import]').addEventListener('click',()=>{if(!busy){stash();void ctx.instancePersona.import({signal});}},{signal});
    actions.querySelector('[data-life-export]')?.addEventListener('click',event=>{stash();void run(event.currentTarget,()=>ctx.instancePersona.export(characterId),'已另存为角色资料中的新角色。');},{signal});
    actions.querySelector('[data-life-resources]').addEventListener('click',()=>{if(!busy){stash();void ctx.instancePersona.resources(characterId);}},{signal});
  }
  ctx.signal?.addEventListener('abort',cleanup,{once:true,signal});
  find('[data-life-close]').addEventListener('click',cleanup,{signal});
  dialog.addEventListener('cancel',event=>{event.preventDefault();cleanup();},{signal});
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cleanup();}},{signal});
  async function request(route='',body,context={moduleId,conversationId}){
    requestController?.abort();const controller=new AbortController();requestController=controller;
    const timer=setTimeout(()=>controller.abort(),route==='simulate'?185000:30000);
    try{
      const query=!route?'?'+new URLSearchParams(context):'';
      const response=await (ctx.fetch||fetch)(`/api/characters/${encodeURIComponent(characterId)}/life${route?'/'+route:''}${query}`,{method:body===undefined?'GET':'POST',signal:controller.signal,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||`读取失败（${response.status}）`);return result;
    }catch(error){if(error.name==='AbortError'&&!closed)throw new Error('请求已取消或超时，草稿仍保留。');throw error;}
    finally{clearTimeout(timer);if(requestController===controller)requestController=null;}
  }
  const read=()=>Object.fromEntries([...find('[data-life-form]').elements].filter(node=>node.name).map(node=>[node.name,node.type==='checkbox'?node.checked:node.value]));
  function stash(){if(!view||!find('[data-life-panel]'))return;const value=read();drafts[section]={values:value,editingId,...(section==='memory'?{memorySnapshot,summarySnapshot,manualOpen:find('[data-life-memory-manual]')?.open??memoryManualOpen}:{})};ctx.drafts.write(key(section),drafts[section]);}
  function values(base){const saved=drafts[section]||ctx.drafts.read(key(section),null);if(saved){editingId=saved.editingId||'';if(section==='memory'){memorySnapshot=saved.memorySnapshot??null;summarySnapshot=saved.summarySnapshot??null;memoryManualOpen=!!saved.manualOpen;}return {...base,...saved.values};}return base;}
  function jsonValue(value,label,expected){let result;try{result=JSON.parse(value||'{}');}catch{throw new Error(label+'不是有效的 JSON，请检查括号与逗号。');}if(expected==='array'&&!Array.isArray(result))throw new Error(label+'必须是数组。');if(expected==='object'&&(!result||typeof result!=='object'||Array.isArray(result)))throw new Error(label+'必须是对象。');return result;}
  function flat(settings){const result={};for(const [name,value] of Object.entries(settings||{})){if(value&&typeof value==='object'&&!Array.isArray(value))for(const [sub,item]of Object.entries(value))result[name+'.'+sub]=item;else result[name]=value;}return result;}
  function settingsFields(items,v){return items.map(([name,label,type='text',options])=>type==='checkbox'?toggle(name,label,v[name]):field(name,label,v[name]??'',{type,options})).join('');}
  function scopeOptions(){const known=array(view.scopes).filter(s=>!forceLite||s.moduleId==='companion-lite').map((s,index)=>{const subject=array(memoryOverview?.subjects||view.memoryOverview?.subjects).find(item=>item.subjectKey===s.subjectKey),label=s.title||s.name||subject?.name||`会话 ${index+1}`;return [s.id,`${s.moduleId==='qq'?'QQ':s.moduleId==='companion-lite'?'精简陪伴':s.moduleId==='companion'?'陪伴':'角色'} · ${label}${subject?` · 会话 ${index+1}`:''}`];});return [['shared',sharedScopeLabel],...known.filter(([id])=>id!=='shared')];}
  function scopeField(name='scope',selected=scope||'shared'){const options=scopeOptions();if(!options.some(([id])=>id===selected))options.push([selected,'原保存范围']);return field(name,'保存范围',selected,{options});}
  function profile(){
    const raw=view.character?.raw||character.raw||{},data=raw.data&&typeof raw.data==='object'?raw.data:raw;
    const v=values({name:view.character?.name||character.name,description:data.description||character.description||'',personality:data.personality||'',scenario:data.scenario||'',first_mes:data.first_mes||'',mes_example:data.mes_example||'',system_prompt:data.system_prompt||'',post_history_instructions:data.post_history_instructions||'',alternate_greetings:json(data.alternate_greetings||[]),raw:json(raw)});
    return `${heading('角色资料')}<div class="life-fields">${field('name','名称',v.name)}${field('personality','性格与表达',v.personality,{type:'textarea',rows:3})}${field('description','人物设定',v.description,{type:'textarea',rows:5,wide:true})}${field('scenario','当前情境',v.scenario,{type:'textarea',wide:true})}${field('first_mes','开场白',v.first_mes,{type:'textarea',wide:true})}${field('mes_example','示例对话',v.mes_example,{type:'textarea',rows:4,wide:true})}</div>${advanced('提示词与原始资料',`<div class="life-fields">${field('system_prompt','系统提示词',v.system_prompt,{type:'textarea',wide:true})}${field('post_history_instructions','对话后的提示词',v.post_history_instructions,{type:'textarea',wide:true})}${field('alternate_greetings','备选开场（JSON）',v.alternate_greetings,{type:'json',wide:true})}${field('raw','完整角色卡（JSON）',v.raw,{type:'json',rows:8,wide:true})}</div>${button('应用原始资料','data-life-apply-raw')}`)}${previewControls()}`;
  }
  function worldbook(){
    const books=array(view.settings.runtime?.worldbooks),entries=books.flatMap(book=>array(book.entries||book));
    const v=values({worldbooks:json(books),'runtime.worldbookBudgetChars':view.settings.runtime?.worldbookBudgetChars??12000,entryName:'',keys:'',secondary_keys:'',content:'',constant:false,enabled:true,selective:false,position:'before_char',depth:4,probability:100,recursive:true});
    return `${heading('外部世界书',button('新增条目','data-life-new'))}<div data-life-items class="life-items">${entries.length?entries.map((item,index)=>`<button type="button" class="life-item" data-life-world-entry="${index}"><strong>${e(item.comment||item.name||'未命名条目')}</strong><span>${e(array(item.keys).join('、')||'常驻条目')}</span></button>`).join(''):'<p class="life-empty">还没有外部条目。角色卡自带的世界书也会参与触发。</p>'}</div><div class="life-fields">${field('entryName','条目名称',v.entryName)}${field('keys','关键词（逗号分隔）',v.keys)}${field('secondary_keys','次条件关键词',v.secondary_keys)}${field('position','插入位置',v.position,{options:[['before_char','人设之前'],['after_char','人设之后'],['depth','指定对话深度']]})}${field('content','内容',v.content,{type:'textarea',rows:5,wide:true})}${field('depth','对话深度',v.depth,{type:'number',min:0})}${field('probability','触发概率（%）',v.probability,{type:'number',min:0,max:100})}${toggle('constant','始终生效',v.constant)}${toggle('enabled','启用条目',v.enabled)}${toggle('selective','同时匹配次条件',v.selective)}${toggle('recursive','允许递归触发',v.recursive)}${field('runtime.worldbookBudgetChars','总预算（字符）',v['runtime.worldbookBudgetChars'],{type:'number',min:0})}</div>${advanced('完整世界书（JSON）',field('worldbooks','外部世界书数组',v.worldbooks,{type:'json',rows:9})+button('应用完整世界书','data-life-apply-books'))}${previewControls()}`;
  }
  function memory(){
    const base={...flat(view.settings),id:'',scope:'shared',content:'',kind:'fact',category:'experience',reality:'uncertain',confidence:'inferred',planStatus:'pending',sourceId:'',sourceQuote:'',pinned:false,status:'active',entities:'[]',relations:'[]',expiresAt:'',recall:'',summaryContent:'',expressionContent:'',expressionSource:'',expressionId:'',expressionEnabled:true};
    const v=values(base);
    const layered=!!memorySnapshot?.layerVersion,oldEntries=array(view.memories).filter(item=>!item.layerVersion);
    return `<div data-life-memory-overview><div class="life-memory-toolbar"><div data-life-memory-subject></div><div data-life-memory-status role="status"><span data-life-memory-status-label tabindex="-1"></span>${help('仅整理工作台保存的可靠对话。其他陪伴应用的旧历史不会自动读取。','自动整理范围')}<time data-life-memory-updated hidden></time><p class="form-feedback error" data-life-memory-error hidden><span data-life-memory-error-message></span> ${button('重试读取','data-life-memory-refresh','hidden')}${button('重试整理','data-life-memory-organize','hidden')}</p></div></div><div data-life-memory-summary></div><div data-life-memory-traits></div><div data-life-memory-experiences></div><div data-life-memory-plans></div></div>
      ${summarySnapshot?`<div class="life-memory-correction" data-life-memory-summary-editor>${field('summaryContent','纠正会话摘要',v.summaryContent,{type:'textarea',rows:4})}<div class="life-item-actions">${button('保存摘要','data-life-memory-summary-save')}${button('取消纠正','data-life-memory-summary-cancel')}</div></div>`:''}
      ${layered?memoryEditor(v,true):''}
      <details class="life-advanced life-memory-manual" data-life-memory-manual ${memoryManualOpen||!layered&&editingId?'open':''}><summary>旧记忆与手动记录</summary>${heading('手动记录',button('新建记忆','data-life-new'))}<div class="life-recall">${field('recall','查找与召回',v.recall)}${button('召回','data-life-recall')}</div><div data-life-recall-result class="life-recall-result" aria-live="polite"></div><div class="life-items" data-life-items>${oldEntries.length?oldEntries.map(memoryRow).join(''):'<p class="life-empty">还没有手动记录。</p>'}</div>${!layered?memoryEditor(v,false):''}</details>
      ${advanced('记忆策略',`<div class="life-fields">${settingsFields([['memory.enabled','使用长期记忆','checkbox'],['memory.autoExtract','自动整理已保存对话','checkbox'],['memory.continuity','同一对象的现实记忆跨会话延续','checkbox'],['memory.sharing','旧记忆跨会话使用','select',[['conversation','按原会话使用'],['character',sharedScopeLabel]]],['memory.halfLifeDays','衰减周期（天）','number'],['memory.maxRecall','每次最多召回','number']],v)}</div>${button('保存记忆策略','data-life-save-memory-settings')}`)}${heading('表达习惯')}<div class="life-items">${array(view.expressions).map(item=>`<article class="life-memory"><div><strong>${e(item.content)}</strong><small>${e(item.sourceQuote||'手动录入')}</small></div><div class="life-item-actions">${button(item.enabled?'停用':'启用',`data-life-expression-toggle="${e(item.id)}"`)}${button('编辑',`data-life-expression-edit="${e(item.id)}"`)}${button('删除',`data-life-delete="expressions" data-id="${e(item.id)}"`)}</div></article>`).join('')}</div><div class="life-fields">${field('expressionContent','表达习惯',v.expressionContent,{type:'textarea',wide:true})}${field('expressionSource','来源',v.expressionSource)}${toggle('expressionEnabled','启用这条表达',v.expressionEnabled)}</div><input type="hidden" name="expressionId" value="${e(v.expressionId)}">${button('保存表达','data-life-save-expression')}`;
  }
  function memoryEditor(v,layered){
    const subjects=array(memoryOverview?.subjects),subject=subjects.find(item=>item.subjectKey===memorySnapshot?.subjectKey);
    return `<div class="life-memory-correction" data-life-memory-editor>${layered?heading('纠正记忆'+(subject?' · '+subjectLabel(subject,subjects):''),button('结束纠正','data-life-memory-cancel')):''}<div class="life-fields">${field('content',editingId?'纠正内容':'记忆内容',v.content,{type:'textarea',wide:true})}${layered?field('category','分类',v.category,{options:memoryCategories})+field('reality','现实或剧情',v.reality,{options:memoryRealities})+field('confidence','理解依据',v.confidence,{options:memoryConfidences})+`<div data-life-memory-plan ${v.category!=='plan'?'hidden':''}>${field('planStatus','计划状态',v.planStatus||'pending',{options:memoryPlanStatuses})}</div>`:scopeField('scope',v.scope)+field('kind','类型',v.kind,{options:[['fact','事实'],['preference','偏好'],['relationship','关系'],['plan','计划'],['story','剧情']]})+field('sourceQuote','来源原文',v.sourceQuote,{type:'textarea',wide:true})+field('sourceId','来源消息 ID',v.sourceId)}${field('expiresAt','到期时间（可留空）',v.expiresAt,{type:'datetime-local'})}${toggle('pinned','置顶保留',v.pinned)}</div>${layered?memorySources(memorySnapshot):advanced('关联关系（JSON）',field('entities','实体',v.entities,{type:'json'})+field('relations','关系',v.relations,{type:'json'}))}</div>`;
  }
  function memorySources(item){
    const evidence=array(item.evidence).length?item.evidence:item.sourceQuote?[{quote:item.sourceQuote,createdAt:item.sourceCreatedAt||item.createdAt}]:[];
    return evidence.length?`<details class="life-memory-source" data-life-memory-source="${e(item.id)}"><summary>查看来源${evidence.length>1?`（${evidence.length}）`:''}</summary>${evidence.map(source=>`<blockquote><p>${e(source.quote)}</p>${source.createdAt?`<time datetime="${e(source.createdAt)}">${e(memoryDate(source.createdAt))}</time>`:''}</blockquote>`).join('')}</details>`:'';
  }
  function memoryRow(item){
    const labels=item.layerVersion?[Object.fromEntries(memoryRealities)[item.reality],Object.fromEntries(memoryConfidences)[item.confidence],item.category==='relationship'?'关系':'',item.category==='plan'?Object.fromEntries(memoryPlanStatuses)[item.planStatus]:'']:[];
    if(item.status==='archived')labels.push('已归档');if(item.pinned)labels.push('已置顶');
    return `<article class="life-memory" data-life-memory-id="${e(item.id)}"><strong>${e(item.content)}</strong><div class="life-memory-meta">${[...new Set(labels.filter(Boolean))].map(label=>`<span>${e(label)}</span>`).join('')}${item.expiresAt?`<span>到期 ${e(memoryDate(item.expiresAt))}</span>`:''}</div>${memorySources(item)}<div class="life-item-actions">${button(item.pinned?'取消置顶':'置顶',`data-life-pin="${e(item.id)}"`,`aria-pressed="${!!item.pinned}"`)}${button('纠正',`data-life-edit="${e(item.id)}"`)}${button(item.status==='archived'?'恢复':'归档',`data-life-archive="${e(item.id)}"`)}${button('删除',`data-life-delete="memories" data-id="${e(item.id)}"`)}</div></article>`;
  }
  const memoryEntries=()=>[...array(memoryOverview?.traits),...array(memoryOverview?.experiences),...array(memoryOverview?.plans),...array(memoryOverview?.oldEntries),...array(view?.memories)];
  const memoryItem=id=>memoryEntries().find(item=>item.id===id);
  const memoryOrder=items=>[...array(items)].sort((a,b)=>(a.status==='archived')-(b.status==='archived')||(b.pinned===true)-(a.pinned===true)||(a.category==='plan'&&a.planStatus!=='pending')-(b.category==='plan'&&b.planStatus!=='pending'));
  function subjectLabel(subject,subjects){
    if(subject.channel==='group'){const duplicate=subjects.some(item=>item.subjectKey!==subject.subjectKey&&item.channel==='group'&&item.peerId===subject.peerId&&item.name===subject.name);return `${subject.name} · 群 ${subject.peerId}${duplicate?' · QQ '+subject.userId:''}`;}
    if(subject.moduleId!=='qq')return `${subject.name}（本机）`;
    return subjects.filter(item=>item.name===subject.name).length>1?`${subject.name} · QQ ${subject.userId}`:subject.name;
  }
  function updateMemoryPart(selector,html){
    const target=find(selector);if(!target||target.dataset.rendered===html||target.contains(document.activeElement))return;
    const selection=window.getSelection();
    if(selection&&!selection.isCollapsed&&Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index)).some(range=>range.intersectsNode(target)))return;
    const opened=[...target.querySelectorAll('details[open][data-life-memory-source]')].map(node=>node.dataset.lifeMemorySource);
    target.innerHTML=html;target.dataset.rendered=html;
    for(const id of opened)target.querySelector(`[data-life-memory-source="${CSS.escape(id)}"]`)?.setAttribute('open','');
  }
  function updateMemoryOverview(){
    if(closed||section!=='memory'||!find('[data-life-memory-overview]'))return;
    const overview=memoryOverview,job=overview?.jobStatus||{},hasContent=!!overview?.summary?.content||['traits','experiences','plans'].some(name=>array(overview?.[name]).length),subjects=array(overview?.subjects);
    updateMemoryPart('[data-life-memory-subject]',subjects.length?field('memorySubject','对话对象',memorySubject,{options:subjects.map(subject=>[subject.subjectKey,subjectLabel(subject,subjects)])}):'');
    const statuses={running:`正在自动整理${job.total?` · ${job.processed||0} / ${job.total}`:''}`,queued:'等待自动整理',failed:'自动整理暂时失败',paused:'自动整理已暂停',idle:job.total?job.processed>=job.total?'当前历史已整理':'等待自动整理':hasContent?'等待新对话':'等待已保存对话'};
    const status=memoryError?'记忆读取失败':statuses[job.status]||'正在读取记忆…';
    const label=find('[data-life-memory-status-label]'),updated=find('[data-life-memory-updated]'),retryRead=find('[data-life-memory-refresh]'),retryOrganize=find('[data-life-memory-organize]');
    label.textContent=status;label.className=memoryError||job.status==='failed'?'error':'';
    updated.hidden=!overview?.lastUpdated;updated.textContent=overview?.lastUpdated?'更新于 '+dateLabel(overview.lastUpdated):'';if(overview?.lastUpdated)updated.dateTime=overview.lastUpdated;
    const reading=!!memoryError,organizing=!reading&&job.status==='failed',message=reading?memoryError:organizing?job.error||'请稍后重试。':'';
    if(document.activeElement===retryRead&&!reading||document.activeElement===retryOrganize&&!organizing)label.focus({preventScroll:true});
    retryRead.hidden=!reading;retryOrganize.hidden=!organizing;find('[data-life-memory-error-message]').textContent=message;find('[data-life-memory-error]').hidden=!message;
    const summary=overview?.summary;
    updateMemoryPart('[data-life-memory-summary]',`${heading('会话摘要',summary?.content?button('纠正','data-life-memory-summary-edit'):'')}<p class="life-memory-summary">${e(summary?.content||'这段会话还没有摘要。')}</p>`);
    for(const [name,title,empty]of [['traits','对话对象特点','还没有记录到特点。'],['experiences','共同经历与关系','还没有共同经历记录。'],['plans','计划与待办','目前没有计划。']])updateMemoryPart(`[data-life-memory-${name}]`,heading(title)+memoryOrder(overview?.[name]).map(memoryRow).join('')+(array(overview?.[name]).length?'':`<p class="life-empty">${empty}</p>`));
  }
  function stopMemoryRefresh(){clearTimeout(memoryTimer);clearTimeout(memoryRequestTimer);memoryTimer=null;memoryRequestTimer=null;memoryGeneration++;memoryController?.abort();memoryController=null;}
  function scheduleMemoryRefresh(){
    if(closed||section!=='memory'||busy||memoryController||memoryTimer)return;
    memoryTimer=setTimeout(()=>{memoryTimer=null;void refreshMemory();},['queued','running'].includes(memoryOverview?.jobStatus?.status)?3000:10000);
  }
  async function refreshMemory(){
    if(closed||section!=='memory'||memoryController)return;
    clearTimeout(memoryTimer);memoryTimer=null;
    const generation=memoryGeneration,controller=new AbortController(),query=new URLSearchParams({moduleId,conversationId,...(memorySubject?{subjectKey:memorySubject}:{})});memoryController=controller;
    const timer=setTimeout(()=>controller.abort(),30000);memoryRequestTimer=timer;
    try{
      const response=await (ctx.fetch||fetch)(`/api/characters/${encodeURIComponent(characterId)}/life/memory/overview?${query}`,{signal:controller.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error||`读取失败（${response.status}）`);
      if(closed||section!=='memory'||generation!==memoryGeneration||memoryController!==controller)return;
      memoryOverview=result;memorySubject=result.selectedSubject?.subjectKey||memorySubject;memoryError='';updateMemoryOverview();
    }catch(error){if(!closed&&section==='memory'&&generation===memoryGeneration&&memoryController===controller){memoryError=error.name==='AbortError'?'读取超时，已有内容和草稿仍保留。':error.message;updateMemoryOverview();}}
    finally{clearTimeout(timer);if(memoryRequestTimer===timer)memoryRequestTimer=null;if(memoryController===controller){memoryController=null;scheduleMemoryRefresh();}}
  }
  async function selectMemorySubject(next){
    stash();window.getSelection()?.removeAllRanges();stopMemoryRefresh();memorySubject=next;memoryError='';
    memoryOverview={...memoryOverview,selectedSubject:array(memoryOverview?.subjects).find(subject=>subject.subjectKey===next)||null,traits:[],experiences:[],plans:[]};updateMemoryOverview();await refreshMemory();
  }
  async function saveSummary(){
    if(!summarySnapshot)return;stash();const submitted=read().summaryContent,snapshot=clone(summarySnapshot);
    await run(find('[data-life-memory-summary-save]'),async()=>{await request('memory/summary',{moduleId,conversationId,content:submitted,revision:snapshot.revision??0});summarySnapshot=null;const draft=drafts.memory;if(draft){draft.summarySnapshot=null;delete draft.values.summaryContent;ctx.drafts.write(key('memory'),draft);}await reload();});
  }
  function statePanel(){
    const s=view.state||{},v=values({mood:s.mood||'',energy:s.energy??50,relationship:typeof s.relationship==='string'?s.relationship:json(s.relationship||{}),activity:s.activity||'',plot:typeof s.plot==='string'?s.plot:json(s.plot||{}),variables:json(s.variables||{}),diary:'',diaryMood:s.mood||''});
    return `${heading('此刻的状态')}<div class="life-fields">${field('mood','心情',v.mood)}${field('energy','精力',v.energy,{type:'number',min:0,max:100})}${field('activity','正在做的事',v.activity,{wide:true})}${field('relationship','关系',v.relationship,{type:'textarea',wide:true})}${field('plot','剧情进展',v.plot,{type:'textarea',wide:true})}${field('variables','剧情变量（JSON）',v.variables,{type:'json',rows:8,wide:true})}</div>${heading('日记与反思')}<div class="life-diary">${array(view.diary).slice(0,30).map(entry=>`<article><small>${e(dateLabel(entry.createdAt))} ${e(entry.mood||'')}</small><p>${e(entry.content)}</p></article>`).join('')||'<p class="life-empty">还没有日记。</p>'}</div>${field('diary','写一条日记',v.diary,{type:'textarea'})}${field('diaryMood','记录时的心情',v.diaryMood)}${button('记下来','data-life-diary')}`;
  }
  function interaction(){
    const v=values(flat(view.settings));
    return `${heading('对话习惯')}<div class="life-fields">${settingsFields([['enabled','启用连续陪伴','checkbox'],['behavior.learnStyle','学习表达习惯','checkbox'],['behavior.replyMaxChars','回复字数上限','number'],['behavior.typingDelayMs','回复等待（毫秒）','number'],['behavior.groupEvery','群聊每隔几条参与','number']],v)}</div>${heading('主动联系')}<div class="life-fields">${settingsFields([['behavior.proactiveEnabled','主动发起聊天','checkbox'],['behavior.proactiveIntervalMinutes','联系间隔（分钟）','number'],['behavior.dailyLimit','每日主动消息上限','number'],['behavior.quietStart','安静时段开始','time'],['behavior.quietEnd','安静时段结束','time']],v)}</div>${heading('动态、求助与余额')}<div class="life-fields">${settingsFields([['automation.qzoneEnabled','允许发布心情动态','checkbox'],['automation.helpEnabled','允许向持有者求助','checkbox'],['automation.ownerId','持有者 QQ'],['automation.balanceEnabled','余额不足时提醒','checkbox'],['automation.balanceUrl','余额查询地址','url'],['automation.balancePath','余额字段路径'],['automation.lowBalance','提醒阈值','number']],v)}</div>${heading('待处理的行动')}<div class="life-items">${array(view.actions).map(item=>`<article class="life-memory"><div><strong>${e(item.text||item.kind)}</strong><small>${e(item.status)} · ${e(dateLabel(item.createdAt))}</small></div><div class="life-item-actions">${button('执行',`data-life-action="deliver" data-id="${e(item.id)}"`,item.status!=='pending'?'disabled':'')}${button('忽略',`data-life-action="dismiss" data-id="${e(item.id)}"`,item.status!=='pending'?'disabled':'')}</div></article>`).join('')||'<p class="life-empty">暂无待处理行动。</p>'}</div>`;
  }
  function tools(){
    const v=values({...flat(view.settings),...toolDefaults,memes:json(view.settings.media?.memes||[]),expressionMap:json(view.settings.media?.expressionMap||{})});
    const selectedKind=Object.values(mediaTools).find(item=>item.kinds.includes(v.kind));
    return `${heading('工具目录',button('新增工具','data-life-new'))}<div class="life-items" data-life-items>${array(view.tools).map(item=>`<button type="button" class="life-item" data-life-tool="${e(item.id)}"><strong>${e(item.name)}</strong><span>${e(toolKinds.find(([kind])=>kind===item.kind)?.[1]||item.kind)} · ${item.enabled?'已启用':'未启用'}</span></button>`).join('')||'<p class="life-empty">尚未添加工具，可从下方媒体用途开始添加。</p>'}</div>
      <div class="life-fields">${field('name','工具名称',v.name,{placeholder:'例如：我的图片搜索'})}${field('kind','用途',v.kind,{options:toolKinds})}${field('description','用途说明',v.description,{type:'textarea',wide:true,placeholder:'告诉角色什么时候使用这个工具'})}${v.kind==='drawing'?drawingControls(v):field('url','服务地址',v.url,{type:'url',wide:true,placeholder:selectedKind?.placeholder||'https://your-service.example/api',info:'填写实际工具接口的完整 HTTP(S) 地址，不是服务首页。'+(selectedKind?.info||'请求字段由输入格式定义，需与服务接口一致。')})+field('method','请求方式',v.method,{options:[['POST','POST'],['GET','GET']]})}${toggle('enabled','启用此工具',v.enabled)}</div>
      ${advanced('请求参数',(v.kind==='drawing'?'':field('headers','请求头（JSON）',v.headers,{type:'json',info:'按服务要求填写，例如 {"Authorization":"Bearer 你的密钥"}；不需要时保留 {}。'}))+field('inputSchema','输入格式（JSON Schema）',v.inputSchema,{type:'json',info:'描述工具接收的参数，不会自动转换接口协议。媒体用途会发送说明中列出的字段，服务需要支持这些字段。'}))}${editingId?button('删除工具',`data-life-delete="tools" data-id="${e(editingId)}"`):''}
      ${heading('媒体与形象')}<div class="life-fields">${toggle('media.voiceEnabled','回复时使用声音',v['media.voiceEnabled'])}${voiceModeField(v)}${Object.keys(mediaTools).map(name=>mediaToolField(name,v)).join('')}</div>
      ${mediaAssets(v)}${advanced('手动编辑表情包与动作 JSON',field('memes','表情包素材（JSON）',v.memes,{type:'json',rows:6})+field('expressionMap','形象动作映射（JSON）',v.expressionMap,{type:'json',rows:5}))}`;
  }
  const mediaFields=['visionNative','localVisionEnabled','localVisionBaseUrl','localVisionModel','localVisionKey','clearLocalVisionKey','publicMemesEnabled'];
  const localSignature=v=>JSON.stringify(['localVisionEnabled','localVisionBaseUrl','localVisionModel','localVisionKey','clearLocalVisionKey'].map(name=>v['media.'+name]??(name.endsWith('Enabled')||name==='clearLocalVisionKey'?false:'')));
  const savedMediaValues=()=>({...flat(view.settings),'media.localVisionKey':'','media.clearLocalVisionKey':false});
  function media(){
    const v=values(savedMediaValues());
    return `${heading('QQ 识图')}<div class="life-vision-status" data-life-native-status role="status"></div><div class="life-fields">${field('media.visionNative','QQ 聊天模型识图能力',v['media.visionNative']||'auto',{options:[['auto','自动判断'],['supported','支持图片'],['unsupported','不支持图片']],info:'只用于 QQ 收到的图片。自动判断依据模型资料；手动指定不会测试实际图片。'})}</div><div data-life-local-vision>${heading('本机视觉辅助')}<p class="life-vision-requirement">需要支持图片输入的视觉语言模型，如 Qwen3.5 或 Qwen-VL。</p><div data-life-vision-extension></div><details class="life-vision-guide"><summary>已有服务怎么接入？</summary><dl><dt>模型能力</dt><dd>需要能读取图片。仅支持文字推理的模型、绘图模型文件不能直接接入这里。</dd><dt>服务地址</dt><dd>填写已启动的 OpenAI 兼容服务地址，包含 /v1；服务需要接受 chat/completions 中的 image_url 图像输入。</dd><dt>模型标识</dt><dd>填写服务 /v1/models 返回的模型 ID。文件路径只有在服务将它用作模型 ID 时才有效。</dd><dt>GGUF 模型</dt><dd>视觉模型还需要配套的 mmproj 视觉投影文件；只下载主模型无法完成识图。</dd></dl></details>${toggle('media.localVisionEnabled','使用本机视觉辅助',v['media.localVisionEnabled'], 'QQ 聊天模型不能读取图片或能力未确认时，先由本机模型描述图片。')}<div class="life-fields" data-life-local-fields>${field('media.localVisionBaseUrl','服务地址',v['media.localVisionBaseUrl'],{type:'url',wide:true,placeholder:'http://127.0.0.1:端口/v1',info:'填写兼容 OpenAI 的图文服务地址，包含 /v1。仅填写地址不会启动外部服务。'})}${field('media.localVisionModel','模型标识',v['media.localVisionModel'],{wide:true,placeholder:'服务 /v1/models 返回的模型 ID',info:'填写服务提供的模型 ID，而不是任意模型文件路径。千问扩展包启动后可自动填入。'})}${field('media.localVisionKey','API 密钥',v['media.localVisionKey'],{type:'password',info:view.settings.media?.localVisionKey?'已保存密钥；留空保留。':'外部服务无需密钥时留空；扩展包会自动填入本机密钥。'})}${toggle('media.clearLocalVisionKey','清除已保存的密钥',v['media.clearLocalVisionKey'])}</div><div class="life-vision-test">${button('测试当前填写','data-life-test-vision')}<p class="life-note" data-life-local-status role="status"></p></div></div>${heading('公开表情库')}${toggle('media.publicMemesEnabled','使用公开表情库',v['media.publicMemesEnabled'])}<div data-life-meme-catalog aria-live="polite"></div>`;
  }
  function mediaPatch(v){return {media:Object.fromEntries(mediaFields.filter(name=>v['media.'+name]!==undefined).map(name=>[name,v['media.'+name]]))};}
  async function mediaRequest(route,body,controller=new AbortController()){
    mediaRequests.add(controller);const timer=setTimeout(()=>controller.abort(),35000);
    try{
      const response=await (ctx.fetch||fetch)(`/api/characters/${encodeURIComponent(characterId)}/life/${route}?moduleId=qq`,{method:body===undefined?'GET':'POST',signal:controller.signal,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||`读取失败（${response.status}）`);return result;
    }catch(error){if(error.name==='AbortError')throw new Error('请求已取消或超时，填写内容仍保留。');throw error;}
    finally{clearTimeout(timer);mediaRequests.delete(controller);}
  }
  function updateMediaStatus(){
    if(closed||section!=='media'||!find('[data-life-native-status]'))return;
    const v=read(),override=v['media.visionNative'],native=override==='supported'||override==='unsupported'?override:visionStatus?.native?.source==='override'?'unknown':visionStatus?.native?.status||'unknown';
    const labels={supported:'当前模型支持读取图片',unsupported:'当前模型无法读取图片',unknown:'识图能力未验证'};
    find('[data-life-native-status]').innerHTML=`<strong>${e(labels[native]||labels.unknown)}</strong>${visionStatus?.native?.model?`<span>${e(visionStatus.native.model)}</span>`:''}${visionError?`<p class="form-feedback error">${e(visionError)} ${button('重试','data-life-refresh-vision')}</p>`:override==='auto'&&visionStatus?.native?.source==='metadata'?'<small>依据模型资料，未测试实际图片</small>':''}`;
    find('[data-life-local-vision]').hidden=native==='supported';
    find('[data-life-local-fields]').hidden=!v['media.localVisionEnabled'];
    const status=find('[data-life-local-status]'),current=localSignature(v)===visionSignature,local=visionStatus?.local;
    status.className='life-note'+(current&&local?.status==='unavailable'?' error':'');
    status.textContent=mediaTesting?'正在测试，填写内容不会保存…':!v['media.localVisionEnabled']?'本机视觉辅助已关闭':!current?'设置已修改，尚未验证':local?.status==='available'?local.evidence==='sample-image-accepted'?'已通过样图输入测试；真实 QQ 图片效果需另行确认。':'模型资料声明支持图片，尚未测试实际图片。':local?.reason||'尚未验证本机视觉服务。';
    find('[data-life-test-vision]').disabled=mediaTesting||busy||!v['media.localVisionEnabled'];
    const target=find('[data-life-meme-catalog]');
    if(memeCatalog){
      const link=(label,url)=>{try{const parsed=new URL(url);if(['https:','http:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password)return `<a href="${e(parsed.href)}" target="_blank" rel="noreferrer">${e(label)}</a>`;}catch{}return e(label);};
      const source=memeCatalog.source||{},licenseUrl=source.repository&&source.revision?`https://github.com/${source.repository}/blob/${source.revision}/LICENSE-ASSETS`:'https://creativecommons.org/licenses/by-nc/4.0/';
      target.innerHTML=`<p class="life-meme-total">${e(memeCatalog.count)} 张表情</p>${array(memeCatalog.packs).map(pack=>`<div class="life-media-row"><strong>${e(pack.title||pack.key)}</strong><span>${e(pack.count??'')} 张</span></div>`).join('')}<p class="life-meme-license">作者：${e(memeCatalog.attribution?.author||'原作者')} ${array(memeCatalog.attribution?.links).map(item=>link(item.label,item.url)).join(' · ')}<br>仅限非商业使用 · ${link('表情包许可',licenseUrl)} · ${link('CC BY-NC 4.0','https://creativecommons.org/licenses/by-nc/4.0/')}</p>`;
    }else target.innerHTML=catalogError?`<p class="form-feedback error">${e(catalogError)} ${button('重试','data-life-refresh-vision')}</p>`:'<p class="life-note">正在读取表情库…</p>';
  }
  async function loadMediaStatus({refresh=false}={}){
    if(closed)return;
    if(mediaLoading){if(refresh||!visionStatus)mediaReloadPending={version:mediaVersion,explicit:refresh};return;}
    const signature=localSignature(savedMediaValues()),version=mediaVersion,fetchStatus=!visionStatus||refresh;
    mediaLoading=(async()=>{
      const results=await Promise.allSettled([visionStatus&&!refresh?Promise.resolve(visionStatus):mediaRequest('vision/status'),memeCatalog?Promise.resolve(memeCatalog):mediaRequest('memes/catalog')]);
      if(closed)return;
      if(version===mediaVersion&&fetchStatus){if(results[0].status==='fulfilled'){visionStatus=results[0].value;visionSignature=signature;visionError='';}else visionError=results[0].reason.message;}
      if(results[1].status==='fulfilled'){memeCatalog=results[1].value;catalogError='';}else catalogError=results[1].reason.message;
      updateMediaStatus();
    })();
    try{await mediaLoading;}finally{mediaLoading=null;const pending=mediaReloadPending;mediaReloadPending=null;if(pending&&!closed&&pending.version===mediaVersion&&(pending.explicit||!visionStatus))void loadMediaStatus({refresh:true});}
  }
  async function testVision(){
    if(mediaTesting||busy)return;stash();const submitted=read(),signature=localSignature(submitted);
    mediaTesting=true;const version=++mediaVersion;updateMediaStatus();feedback('正在测试，不保存设置…');
    const current=()=>!closed&&section==='media'&&version===mediaVersion&&localSignature(read())===signature;
    try{
      const result=await mediaRequest('vision/test',mediaPatch(submitted));
      if(current()){visionStatus=result;visionSignature=signature;visionError='';feedback(result.local?.status==='unavailable'?'本机视觉验证失败，填写内容仍保留。':'测试完成，设置尚未保存。',result.local?.status==='unavailable');}
    }catch(error){if(current())feedback(error.message,true);}
    finally{mediaTesting=false;if(!closed)updateMediaStatus();}
  }
  async function saveMedia(){
    stash();const submitted=clone(read());
    const result=await request('settings',mediaPatch(submitted));
    if(closed)return;
    const current=drafts.media?.values||ctx.drafts.read(key('media'),null)?.values||submitted,remaining={};
    for(const [name,value] of Object.entries(current))if(value!==submitted[name])remaining[name]=value;
    const snapshot=drafts.media;ctx.drafts.commit(key('media'),snapshot);delete drafts.media;
    if(Object.keys(remaining).length){drafts.media={values:remaining,editingId:''};ctx.drafts.write(key('media'),drafts.media);}
    view={...view,...result};visionStatus=null;visionSignature='';mediaVersion++;draw();
  }
  function mediaToolField(name,v){
    const meta=mediaTools[name],selected=v['media.'+name]||'',all=array(view.tools);
    const available=all.filter(tool=>tool.enabled&&(meta.kinds.includes(tool.kind)||tool.kind==='http'));
    const nativeVoice=name==='voiceTool'&&moduleId==='companion';
    const options=[['',nativeVoice?'使用陪伴模块声音':available.length?'不使用':`暂无已启用的${meta.label}`],...available.map(tool=>[tool.id,tool.name])];
    if(selected&&!available.some(tool=>tool.id===selected)){
      const old=all.find(tool=>tool.id===selected);options.push([selected,old?old.name+(old.enabled?'（用途不匹配）':'（未启用）'):'原选择已不可用',true]);
    }
    const info=meta.info+' 下拉列表来自上方已保存并启用的对应用途工具或通用 API。'+(nativeVoice?'留空时沿用陪伴模块的声音设置。':'');
    return `<div class="life-media-tool">${field('media.'+name,meta.label,selected,{options,info})}${button('添加'+meta.label,`data-life-add-media-tool="${name}"`)}</div>`;
  }
  function mediaAssets(v){
    let memes=[],mapping={},error='';
    try{memes=jsonValue(v.memes,'表情包素材','array');mapping=jsonValue(v.expressionMap,'形象动作映射','object');}catch(reason){error=`<p class="form-feedback error">${e(reason.message)} 可在下方手动编辑表情包与动作 JSON。</p>`;}
    const memeList=memes.map(item=>`<div class="life-media-row"><div><strong>${e(item?.name||'未命名表情包')}</strong><small>${e(array(item?.tags).join('、')||'不限情绪')}</small></div>${button('移除',`data-life-remove-meme="${e(item?.id||'')}"`,`aria-label="移除表情包 ${e(item?.name||'未命名')}"`)}</div>`).join('');
    const mappingList=Object.entries(mapping).map(([name,action])=>`<div class="life-media-row"><span>${e(name)} → ${e(action)}</span>${button('移除',`data-life-remove-mapping="${e(name)}"`,`aria-label="移除动作映射 ${e(name)}"`)}</div>`).join('');
    return `${heading('表情包')}${error}<div data-life-meme-list>${memeList||'<p class="life-empty">还没有表情包，添加第一张图片。</p>'}</div>
      <div class="life-fields">${field('memeName','表情包名称',v.memeName||'',{placeholder:'例如：开心猫猫'})}${field('memeUrl','图片直链',v.memeUrl||'',{placeholder:'https://your-images.example/happy.png',info:'填写能直接打开图片的 HTTP(S) 网址，不是网页分享链接或本地文件路径。此处登记已有图片，不会生成或上传图片。'})}${field('memeTags','适用情绪（逗号分隔）',v.memeTags||'',{placeholder:'例如：开心,感谢',info:'帮助角色按情绪选图。支持中文或英文逗号；留空表示不限情绪。'})}</div>${button('加入表情包列表','data-life-add-meme')}
      ${heading('情绪与形象动作')}<div data-life-mapping-list>${mappingList||'<p class="life-empty">还没有动作映射，按模型已有名称添加。</p>'}</div>
      <div class="life-fields">${field('expressionName','情绪名称',v.expressionName||'',{placeholder:'例如：开心',suggestions:emotionExamples,info:'角色表达的情绪，例如开心、难过；映射后会发送右侧填写的模型名称。'})}${field('expressionAction','模型表情／动作名',v.expressionAction||'',{placeholder:'例如：happy（以模型实际名称为准）',info:'名称来自已导入模型或动作配置，大小写需要一致。如果模型含有 happy，就可把“开心”映射到 happy。这里只对应名称，不会创建动作。形象在“虚拟陪伴 → 设置 → 角色模型”中导入；当前还不能自动读取可用名称。'})}</div>${button('加入动作映射','data-life-add-expression-map')}`;
  }
  function drawingControls(v){
    const workflows=[['','选择已导入的工作流'],...array(drawingCatalog?.workflows).map(item=>[item.id,item.name])];
    if(v.workflowId&&!workflows.some(([id])=>id===v.workflowId))workflows.push([v.workflowId,v.workflowId]);
    const prompts=[['','自动识别'],...array(drawingFields.get(v.workflowId)).filter(item=>item.type==='text').map(item=>[item.key,`${item.group||item.input} · ${item.key}`])];
    if(v.promptField&&!prompts.some(([id])=>id===v.promptField))prompts.push([v.promptField,v.promptField]);
    return field('workflowId','绘图工作流',v.workflowId,{options:workflows})+field('promptField','提示词字段',v.promptField,{options:prompts})+button('刷新工作流','data-life-drawing-refresh');
  }
  async function drawingRequest(path){const response=await (ctx.fetch||fetch)('/api/modules/drawing/'+path,{signal});const result=await response.json();if(!response.ok)throw new Error(result.error||'无法读取绘图工作流。');return result;}
  function drawingSchema(fields){return {type:'object',properties:{prompt:{type:'string',description:'写入选定提示词字段的画面描述'},values:{type:'object',properties:Object.fromEntries(fields.map(item=>[item.key,{type:item.type==='number'?'number':item.type==='boolean'?'boolean':'string',description:`${item.group||''} ${item.input}`.trim(),...(item.choices?{enum:item.choices}:{}),...(item.min!==undefined?{minimum:item.min}:{}),...(item.max!==undefined?{maximum:item.max}:{})}])),additionalProperties:false}},additionalProperties:false};}
  async function loadDrawingOptions({refresh=false,generateSchema=false}={}){
    try{
      if(refresh)drawingCatalog=null;
      if(!drawingCatalog){drawingLoading??=drawingRequest('state').finally(()=>{drawingLoading=null;});drawingCatalog=await drawingLoading;}
      if(closed||section!=='tools'||read().kind!=='drawing')return;
      let v=read();const selected=v.workflowId;
      if(selected&&(!drawingFields.has(selected)||refresh))drawingFields.set(selected,array((await drawingRequest('workflows/'+encodeURIComponent(selected))).fields));
      if(closed||section!=='tools'||read().kind!=='drawing'||read().workflowId!==selected)return;
      v=read();const fields=drawingFields.get(selected)||[];
      if(generateSchema){
        v.inputSchema=json(drawingSchema(fields));
        const prompts=fields.filter(item=>item.type==='text'&&/^(text|prompt|positive_prompt)$/.test(item.input)&&!/(negative|负向|负面)/i.test(item.group||''));
        v.promptField=prompts.length===1?prompts[0].key:'';
      }
      edit(v,editingId);
      if(!drawingCatalog.workflows?.length)feedback('请先在角色绘图中导入工作流。');
      else if(selected&&!fields.length)feedback('工作流字段尚未就绪，请先连接 ComfyUI，再刷新工作流。');
    }catch(error){if(!closed)feedback(error.message,true);}
  }
  function scripts(){
    const raw=view.character?.raw||{},data=raw.data||raw,v=values({...flat(view.settings),extensions:json(data.extensions||{})});
    return `${heading('模板与变量')}<div class="life-fields">${toggle('runtime.templatesEnabled','运行角色模板',v['runtime.templatesEnabled'])}${field('runtime.dialect','变量更新语法',v['runtime.dialect']||'auto',{options:[['auto','自动识别'],['mvu','MVU'],['json-patch','JSON Patch'],['legacy','旧式变量语法']]})}</div>${heading('角色脚本')}${toggle('runtime.scriptsEnabled','信任并运行此角色的脚本',v['runtime.scriptsEnabled'])}<p class="life-trust">启用后，角色卡脚本可以更新角色变量、预演消息和提示词。仅对你信任的角色卡启用。</p>${advanced('正则与脚本扩展（JSON）',field('extensions','角色扩展字段',v.extensions,{type:'json',rows:12}))}${advanced('兼容范围',`<pre class="life-code">${e(json(view.compatibility))}</pre>`)}${previewControls()}`;
  }
  function previewControls(){return `<details class="life-preview"><summary>预演与触发检查</summary><div class="life-preview-fields">${field('previewText','试着说一句',drafts[section]?.values?.previewText||'')}${button('查看提示词','data-life-preview')}${button('预演回复','data-life-simulate')}${button('取消','data-life-cancel','hidden')}</div><p class="life-note">使用已保存的资料；预演不发送到 QQ。</p><div data-life-preview-result aria-live="polite"></div></details>`;}
  function supplementalFields(){
    const saved=drafts[section]||ctx.drafts.read(key(section),null),v=saved?.values||{},panel=find('[data-life-panel]');
    if(section==='profile'){
      const avatarEditor=document.createElement('div');avatarEditor.className='profile-avatar-editor life-profile-avatar';panel.prepend(avatarEditor);
      mountAvatarEditor(avatarEditor,{avatar:view.character.avatar,name:view.character.name,signal,onChange:async avatar=>{
        const result=await ctx.api(`/api/characters/${encodeURIComponent(characterId)}/avatar`,{method:'POST',body:{avatar}});
        view.character=result.character;
        if(section==='profile')stash();
        const profileDraft=drafts.profile||ctx.drafts.read(key('profile'),null);
        if(profileDraft?.values.raw){try{const draftRaw=JSON.parse(profileDraft.values.raw);draftRaw.extensions={...draftRaw.extensions,workbenchAvatar:avatar};profileDraft.values.raw=json(draftRaw);drafts.profile=profileDraft;ctx.drafts.write(key('profile'),profileDraft);}catch{ /* 保留尚未写完的 JSON 草稿。 */ }}
        const rawInput=find('[name="raw"]');if(rawInput&&profileDraft)rawInput.value=profileDraft.values.raw;
        window.dispatchEvent(new CustomEvent('workbench:character-avatar-changed',{detail:{character:result.character}}));
        await ctx.refresh();ctx.notify('角色头像已保存。');
      }});
      const raw=view.character?.raw||{},data=raw.data||raw;
      const defaultOrder=['description','personality','scenario','system_prompt','mes_example'];
      let order;try{order=v.promptOrder?JSON.parse(v.promptOrder):data.extensions?.workbench?.prompt_order||defaultOrder;}catch{order=defaultOrder;}
      const labels={description:'人物设定',personality:'性格与表达',scenario:'当前情境',system_prompt:'系统提示词',mes_example:'示例对话'};
      panel.insertAdjacentHTML('beforeend',advanced('提示词顺序',`<input type="hidden" name="promptOrder" value="${e(json(order))}"><ol class="life-prompt-order">${order.map((name,index)=>`<li><span>${e(labels[name]||name)}</span><div>${button('上移',`data-life-order-move="${index}" data-delta="-1"`,index===0?'disabled':'')}${button('下移',`data-life-order-move="${index}" data-delta="1"`,index===order.length-1?'disabled':'')}</div></li>`).join('')}</ol>`));
    }else if(section==='worldbook'){
      panel.insertAdjacentHTML('beforeend',advanced('触发细节',`<div class="life-fields">${field('secondaryLogic','次条件规则',v.secondaryLogic??0,{options:[[0,'任意一个命中'],[3,'全部命中'],[1,'不能全部命中'],[2,'全部不能命中']]})}${field('scanDepth','扫描最近对话数',v.scanDepth??2,{type:'number',min:0})}${field('insertionOrder','条目顺序',v.insertionOrder??100,{type:'number'})}</div>`));
    }else if(section==='memory'){
      const sharing=find('[name="memory.sharing"]');sharing.replaceChildren(new Option('按原会话使用','conversation'),new Option(sharedScopeLabel,'character'));sharing.value=v['memory.sharing']||view.settings.memory.sharing;
      const config=view.settings.memory.embedding||{};
      panel.insertAdjacentHTML('beforeend',advanced('向量召回服务',`<div class="life-fields">${toggle('memory.embedding.enabled','使用向量召回',v['memory.embedding.enabled']??config.enabled)}${field('memory.embedding.baseUrl','兼容服务地址',v['memory.embedding.baseUrl']??config.baseUrl,{type:'url',wide:true})}${field('memory.embedding.model','向量模型',v['memory.embedding.model']??config.model)}${field('memory.embedding.apiKey','API 密钥',v['memory.embedding.apiKey']??'',{type:'password',info:config.apiKey?'已保存密钥；留空保留。':'填写你自己的服务密钥。'})}${toggle('memory.embedding.clearApiKey','清除已保存的密钥',v['memory.embedding.clearApiKey']??false)}</div>${button('保存召回设置','data-life-save-memory-settings')}`));
    }else if(section==='interaction'){
      panel.querySelector('label[for="life-behavior.replyMaxChars"]').textContent='回复长度参考（字）';
      panel.querySelector('label[for="life-behavior.groupEvery"]').innerHTML=`群聊观察间隔（条）${help('达到间隔后，角色会判断是否适合加入当前讨论，不保证每次回应。','群聊观察间隔说明')}`;
      const options=[['','未选择'],...array(view.tools).map(tool=>[tool.id,tool.name])];
      panel.insertAdjacentHTML('beforeend',`${heading('发布与查询工具')}<div class="life-fields">${field('automation.qzoneTool','心情动态工具',v['automation.qzoneTool']??view.settings.automation.qzoneTool,{options})}${field('automation.balanceTool','余额查询工具',v['automation.balanceTool']??view.settings.automation.balanceTool,{options})}</div>`);
      for(const action of array(view.actions).filter(item=>item.kind==='balance'||item.kind==='help'&&item.moduleId==='companion')){
        const control=panel.querySelector(`[data-life-action="deliver"][data-id="${CSS.escape(action.id)}"]`);if(control){control.textContent='知道了';control.dataset.lifeAction='acknowledge';}
      }
    }else if(section==='tools'){
      if(read().kind==='drawing'&&(!drawingCatalog||read().workflowId&&!drawingFields.has(read().workflowId)))void loadDrawingOptions();
    }else if(section==='scripts'){
      const dialect=find('[name="runtime.dialect"]');dialect.replaceChildren(...[['auto','自动识别'],['native','原生变量语法'],['mvu','MVU'],['json-patch','JSON Patch'],['rfc6902','RFC 6902']].map(([id,label])=>new Option(label,id)));dialect.value=v['runtime.dialect']??view.settings.runtime.dialect;
      panel.insertAdjacentHTML('beforeend',`${heading('脚本预演')}${field('scriptCode','JavaScript',v.scriptCode||'',{type:'json',rows:8})}${button('运行预演','data-life-run-script')}${button('应用预演变量','data-life-apply-script','disabled')}<div data-life-script-result aria-live="polite"></div>${heading('HTML 状态栏')}${view.display?.html?.length?button('查看当前状态栏','data-life-current-display'):''}${field('htmlCode','HTML',v.htmlCode||'',{type:'json',rows:6})}${button('预览状态栏','data-life-render-html')}<div data-life-html-result></div>`);
      const raw=view.character?.raw||{},data=raw.data||raw,scripts=array(data.extensions?.tavern_helper?.scripts);
      const codeField=panel.querySelector('[name="scriptCode"]').closest('.field');
      codeField.insertAdjacentHTML('beforebegin',`<div class="life-items">${scripts.filter(item=>typeof item.content==='string').map(item=>`<button type="button" class="life-item" data-life-load-script="${e(item.id)}"><strong>${e(item.name||'角色脚本')}</strong><span>${item.enabled===false?'未启用':'已启用'}</span></button>`).join('')}</div><div class="life-fields">${field('scriptName','脚本名称',v.scriptName||'')}${toggle('scriptEnabled','在对话中运行此脚本',v.scriptEnabled??true)}</div><input type="hidden" name="scriptId" value="${e(v.scriptId||'')}">`);
      codeField.insertAdjacentHTML('afterend',`${button('保存到角色','data-life-save-card-script')}${button('新建脚本','data-life-new-script')}`);
    }else if(section==='state'&&view.display?.html?.length){
      panel.insertAdjacentHTML('afterbegin',`${heading('当前状态栏',button('查看','data-life-current-display'))}<div data-life-html-result></div>`);
    }
  }
  function draw(){
    if(!view||closed)return;disposeVisionExtension?.();disposeVisionExtension=null;previewFrames=[];hideLocalHelp();
    if(!fullLayout()&&!['profile','memory','media'].includes(section)){section='profile';editingId='';}
    const renderers={profile,worldbook,memory,media,state:statePanel,interaction,tools,scripts};
    find('[data-life-content]').innerHTML=`<section data-life-panel="${section}">${renderers[section]()}</section>`;supplementalFields();find('[data-life-content]').setAttribute('aria-busy','false');
    if(section==='profile'){
      const selected=view.settings.media?.voiceId||'';
      const options=[['','不使用共享音色']];if(selected)options.push([selected,selected==='xiaoli-warm-bright'?'测试音色 · 温暖清亮':selected]);
      find('[data-life-panel]').insertAdjacentHTML('beforeend',`${heading('声音')}<div class="life-fields">${field('media.voiceId','共享音色',selected,{options})}${toggle('media.voiceEnabled','回复时使用声音',view.settings.media?.voiceEnabled)}${voiceModeField(flat(view.settings))}</div>${button('保存声音设置','data-life-save-shared-voice')}`);
      const select=find('[name="media.voiceId"]');
      void (async()=>{const response=await (ctx.fetch||fetch)('/api/voice/voices',{signal});if(!response.ok)throw new Error('暂时无法读取音色库');return response.json();})().then(({voices})=>{
        if(signal.aborted||closed||!select.isConnected)return;
        const chosen=select.value,previous=select.selectedOptions[0]?.textContent||chosen;
        const entries=[['','不使用共享音色'],...voices.map(item=>[item.id,item.name])];
        if(chosen&&!entries.some(([id])=>id===chosen))entries.push([chosen,previous]);
        select.innerHTML=entries.map(([id,name])=>`<option value="${e(id)}">${e(name)}</option>`).join('');select.value=chosen;
      }).catch(()=>{});
    }
    dialog.querySelectorAll('[data-life-tab]').forEach(node=>node.setAttribute('aria-current',node.dataset.lifeTab===section?'page':'false'));
    find('[data-life-save]').textContent=({profile:'保存人设',worldbook:'保存条目',memory:editingId?'保存纠正':memoryManualOpen?'记住这件事':'手动记录',media:'保存识图与表情',state:'保存状态',interaction:'保存互动设置',tools:editingId?'保存工具':'添加工具',scripts:'保存脚本设置'})[section];find('[data-life-save]').disabled=busy;
    find('[data-life-save-media]').hidden=section!=='tools';
    find('[data-life-character]').textContent=view.character?.name||character.name;
    const context=find('[data-life-context]');context.hidden=!['memory','state'].includes(section);context.innerHTML=field('viewScope','当前会话',scope,{options:scopeOptions()});
    context.querySelector('select').value=scope;
    context.querySelector('select').addEventListener('change',event=>void changeScope(event.target.value),{signal});
    modeControls();
    if(section==='memory'){updateMemoryOverview();if(!memoryController&&!memoryTimer)void refreshMemory();}else stopMemoryRefresh();
    if(section==='media'){
      updateMediaStatus();void loadMediaStatus();
      disposeVisionExtension=mountVisionExtension(find('[data-life-vision-extension]'),{fetchImpl:ctx.fetch||fetch,signal,
        draftToken:()=>JSON.stringify([mediaVersion,busy,localSignature(read())]),
        applyConnection:media=>{
          for(const name of ['localVisionEnabled','localVisionBaseUrl','localVisionModel','localVisionKey','clearLocalVisionKey']){
            const input=find(`[name="media.${name}"]`);if(!input||media?.[name]===undefined)continue;
            if(input.type==='checkbox')input.checked=media[name];else input.value=media[name];
          }
          mediaVersion++;visionSignature='';stash();updateMediaStatus();feedback('已填入千问视觉连接，尚未保存。');
        }});
    }
  }
  const fullLayout=()=>!forceLite&&view.settings.mode==='full'&&view.capabilities?.full!==false;
  function modeButtons(){
    dialog.querySelectorAll('[data-life-mode]').forEach(node=>{const mode=node.dataset.lifeMode;node.disabled=busy||view.capabilities?.[mode]===false||forceLite;node.setAttribute('aria-pressed',String(mode===(forceLite?'lite':view.settings.mode)));});
  }
  function modeControls(){
    const full=fullLayout(),panel=find('[data-life-panel]');
    modeButtons();
    find('[data-life-packages]').innerHTML=view.capabilities?.lite===false?button('打开角色资料','data-life-get-mode="library"'):'';
    if(!view.settings.enabled&&view.capabilities?.lite!==false)find('[data-life-packages]').insertAdjacentHTML('beforeend',button('启用人设与记忆','data-life-enable'));
    dialog.querySelectorAll('[data-life-tab]').forEach(node=>{node.hidden=!full&&!['profile','memory','media'].includes(node.dataset.lifeTab);});
    find('[data-life-mode-cost]').textContent=view.capabilities?.lite===false?'角色组件尚未安装，已有资料保留。安装后才能使用长期记忆与状态。':!view.settings.enabled?'连续陪伴已停用，记忆和状态不会参与生成。':full?'正常聊天通常为 1 次回复 + 1 次综合整理；状态和规则会增加 token 用量。':view.settings.memory.enabled&&view.settings.memory.autoExtract?'正常聊天通常为 1 次回复 + 1 次记忆整理。关闭自动整理可减少请求。':'正常聊天通常只请求 1 次回复；自动记忆整理已关闭。';
    if(section==='profile'&&!full)panel.querySelectorAll('.life-advanced').forEach(node=>node.hidden=true);
    if(section==='memory'&&!full){
      const expressionHeading=[...panel.querySelectorAll('.life-section-heading')].find(node=>node.textContent==='表达习惯');
      for(let node=expressionHeading;node&&!node.matches('details');node=node.nextElementSibling)node.hidden=true;
      panel.querySelectorAll('.life-advanced').forEach(node=>{if(node.querySelector('summary')?.textContent==='关联关系（JSON）')node.hidden=true;});
    }
    if(section==='state'){
      const v=values({moodValue:view.state.moodValue??50,relationshipValue:view.state.relationshipValue??20,'decision.enabled':view.settings.decision?.enabled??true,decisionRules:json(view.settings.decision?.rules||[])});
      panel.querySelector('.life-fields').insertAdjacentHTML('afterbegin',field('moodValue','心情值（0–100）',v.moodValue,{type:'number',min:0,max:100})+field('relationshipValue','关系值（0–100）',v.relationshipValue,{type:'number',min:0,max:100}));
      const rules=jsonValue(v.decisionRules,'行为规则','array');
      const ruleFields=[['environment','环境',[['any','任何环境'],['private','私聊'],['group','群聊'],['proactive','主动联系']]],['field','观察数值',[['moodValue','心情值'],['energy','精力'],['relationshipValue','关系值']]],['operator','条件',[['lte','小于或等于'],['gte','大于或等于']]],['choice','选择',[['brief','简短回应'],['gentle','温和回应'],['familiar','熟悉自然'],['observe','先旁观／暂不主动联系']]]];
      panel.insertAdjacentHTML('beforeend',`${heading('根据状态做选择',button('添加规则','data-life-add-rule'))}<p class="life-note">规则从上往下匹配，优先使用第一条符合的规则。旁观只影响未被提及的群聊和主动联系，直接对话仍会回应。</p>${toggle('decision.enabled','启用条件规则',v['decision.enabled'])}<input type="hidden" name="decisionRules" value="${e(v.decisionRules)}"><div class="life-rules">${rules.map((rule,index)=>{const get=key=>v['rule'+index+'_'+key]??rule[key];return `<fieldset class="life-rule"><legend>规则 ${index+1}</legend><div class="life-fields">${field('rule'+index+'_name','名称',get('name'))}${toggle('rule'+index+'_enabled','启用',get('enabled'))}${ruleFields.map(([key,label,options])=>field('rule'+index+'_'+key,label,get(key),{options})).join('')}${field('rule'+index+'_value','阈值（0–100）',get('value'),{type:'number',min:0,max:100})}${field('rule'+index+'_instruction','这时怎样回应',get('instruction'),{type:'textarea',wide:true})}</div>${button('移除规则',`data-life-remove-rule="${index}"`)}</fieldset>`;}).join('')}</div>${button('保存行为规则','data-life-save-decision')}`);
      const decision=view.decision;if(decision)panel.insertAdjacentHTML('beforeend',`<p class="life-note">当前匹配：${e(decision.reason||decision.choice)}</p>`);
      variableRuleControls(panel);
    }
  }
  function variableRuleControls(panel){
    const v=values({'variableUpdates.enabled':view.settings.variableUpdates?.enabled??true,variableRules:json(view.settings.variableUpdates?.rules||[])});
    const rules=jsonValue(v.variableRules,'变量更新规则','array');
    panel.insertAdjacentHTML('beforeend',`${heading('变量怎样变化',button('添加更新规则','data-life-add-variable-rule'))}${toggle('variableUpdates.enabled','启用变量更新规则',v['variableUpdates.enabled'], '数值条件由本机判断；语义事件复用每轮综合整理，不会每条规则再请求一次 AI。规则和依据会增加 token。')}<input type="hidden" name="variableRules" value="${e(v.variableRules)}"><div class="life-rules">${rules.map((rule,index)=>{
      const get=key=>v['vr'+index+'_'+key]??rule[key],item=(key,label,options={})=>field('vr'+index+'_'+key,label,get(key)??'',options);
      return `<details class="life-rule" ${rules.length===1?'open':''}><summary>${index+1}. ${e(get('name'))}</summary><div class="life-fields">${item('name','名称')}${toggle('vr'+index+'_enabled','启用',get('enabled'))}${item('path','更新哪个变量',{info:'内置值：moodValue（心情）、energy（精力）、relationshipValue（关系）。自定义示例：variables.trust。'})}${item('type','类型',{options:[['number','数值'],['string','文字'],['boolean','是或否']]})}${item('initial','初始值',{info:'只用于还不存在的自定义变量，不覆盖当前值。是或否填写 true 或 false。'})}${item('environment','在哪种环境',{options:[['any','任何环境'],['private','私聊'],['group','群聊'],['proactive','主动联系']]})}${item('trigger','什么时候更新',{options:[['condition','满足数值或状态条件'],['semantic','对话中发生了某件事']]})}${item('event','事件说明',{type:'textarea',info:'选择事件触发时填写，例如：对方明确安慰了角色。需要模型给出本轮原话依据；判断可能出错，可以查看变化记录。'})}${item('conditionPath','条件观察哪个变量',{info:'选择条件触发时使用，例如 energy 或 variables.trust。'})}${item('operator','比较方式',{options:[['lte','小于或等于'],['gte','大于或等于'],['eq','等于']]})}${item('threshold','比较值',{info:'数值直接填写，是或否填 true / false，文字直接填写。'})}${item('operation','怎样更新',{options:[['add','增加或减少'],['set','设为指定值']]})}${item('value','更新值',{info:'减少请填负数。文字和是或否使用“设为指定值”。数值会受每轮上限限制。'})}${item('min','数值下限',{type:'number'})}${item('max','数值上限',{type:'number'})}${item('maxDelta','每轮最多变化',{type:'number',info:'仅数值变量使用。内置值为 0–100，每轮最多变化 10。同一变量按从上到下第一条匹配规则执行。'})}</div><div class="life-section-heading">${button('上移',`data-life-variable-move="${index}" data-delta="-1"`,index===0?'disabled':'')}${button('下移',`data-life-variable-move="${index}" data-delta="1"`,index===rules.length-1?'disabled':'')}${button('移除',`data-life-remove-variable-rule="${index}"`)}</div></details>`;
    }).join('')}</div>${button('保存更新规则','data-life-save-variable-rules')}${advanced('查看变量变化记录',array(view.variableChanges).length?`<div class="life-list">${view.variableChanges.map(change=>`<article class="life-item"><strong>${e(change.path)}：${e(JSON.stringify(change.before))} → ${e(JSON.stringify(change.after))}</strong><p>${e(change.reason)}</p>${change.sourceQuote?`<blockquote>${e(change.sourceQuote)}</blockquote>`:''}<small>${e(dateLabel(change.updatedAt))} · ${e(change.conversationScope||change.scope)}</small></article>`).join('')}</div>`:'<p class="life-empty">还没有变量更新记录。</p>')}`);
  }
  function editedVariableRules(strict=false){
    const v=read(),parse=(value,type)=>{
      if(type==='number'){if(strict&&(String(value).trim()===''||!Number.isFinite(Number(value))))throw new Error('数值变量需要填写有效数字。');return Number(value);}
      if(type==='boolean'){if(strict&&!['true','false'].includes(String(value)))throw new Error('是或否请填写 true 或 false。');return String(value)==='true';}return String(value);
    };
    const edited=jsonValue(v.variableRules,'变量更新规则','array').map((rule,index)=>{
      const next={...rule};for(const key of ['name','enabled','path','type','initial','environment','trigger','event','conditionPath','operator','threshold','operation','value','min','max','maxDelta'])next[key]=v['vr'+index+'_'+key]??rule[key];
      next.thresholdType=rule.thresholdType??typeof rule.threshold;
      return next;
    });
    if(strict)for(const next of edited){next.initial=parse(next.initial,next.type);next.value=parse(next.value,next.type);for(const key of ['min','max','maxDelta'])if(next.type==='number')next[key]=parse(next[key],'number');else delete next[key];const observed=edited.find(item=>item.path===next.conditionPath);const current=get(view.state,next.conditionPath);const thresholdType=next.operator!=='eq'||['moodValue','energy','relationshipValue'].includes(next.conditionPath)?'number':observed?.type||(['number','string','boolean'].includes(typeof current)?typeof current:next.thresholdType);next.threshold=parse(next.threshold,thresholdType);delete next.thresholdType;}
    return edited;
  }
  function replaceVariableDraft(rules){const v=read();for(const name of Object.keys(v))if(/^vr\d+_/.test(name))delete v[name];v.variableRules=json(rules);drafts[section]={values:v,editingId};ctx.drafts.write(key(section),drafts[section]);draw();}
  function editedRules(){const v=read();return jsonValue(v.decisionRules,'行为规则','array').map((rule,index)=>({...rule,...Object.fromEntries(['name','enabled','environment','field','operator','choice','instruction','value'].map(key=>[key,key==='value'?Number(v['rule'+index+'_'+key]):v['rule'+index+'_'+key]]))}));}
  function replaceRuleDraft(rules){const v=read();for(const name of Object.keys(v))if(/^rule\d+_/.test(name))delete v[name];v.decisionRules=json(rules);drafts[section]={values:v,editingId};ctx.drafts.write(key(section),drafts[section]);draw();}
  async function changeScope(next){
    const select=find('[name="viewScope"]');if(select)select.value=scope;
    if(busy||closed||next===scope)return;
    const found=array(view.scopes).find(s=>s.id===next);if(next!=='shared'&&!found||forceLite&&found&&found.moduleId!=='companion-lite')return;
    stash();stopMemoryRefresh();
    const context={moduleId:forceLite?'companion-lite':found?.moduleId||'companion',conversationId:found?.conversationId||''};
    await run(null,async()=>{
      const nextView=await request('',undefined,context);if(closed)return;
      // The form and its save/draft target change together only after a successful read.
      view=nextView;scope=next;moduleId=context.moduleId;conversationId=context.conversationId;
      memoryOverview=view.memoryOverview;memorySubject=memoryOverview?.selectedSubject?.subjectKey||'';memoryError='';memorySnapshot=null;summarySnapshot=null;memoryManualOpen=false;drafts={};editingId='';draw();
    },'已切换会话');
  }
  async function load(){
    if(!character){
      dialog.classList.add('character-life-empty');find('[data-life-character]').textContent=moduleId==='qq'?'尚未绑定角色':'尚未导入人设';
      find('.life-mode').hidden=true;find('.life-nav').hidden=true;find('.life-body').classList.add('life-body-empty');find('.life-footer-actions').hidden=true;
      find('[data-life-content]').innerHTML=ctx.instancePersona?`<p class="life-empty">${moduleId==='qq'&&ctx.state.characters.length?'尚未绑定角色。可在 QQ 的「连接与角色」中保存扮演角色，或在这里导入人设。':'尚未导入人设。'}</p>`:'<p class="life-empty">请先选择角色。QQ 需要先保存扮演角色。</p><a class="button" href="#/characters">打开角色资料</a>';
      find('[data-life-import]')?.classList.add('primary');find('[data-life-content]').setAttribute('aria-busy','false');return;
    }
    try{view=await request();if(closed)return;scope=view.state?.scope||'shared';memoryOverview=view.memoryOverview;memorySubject=memoryOverview?.selectedSubject?.subjectKey||'';draw();}
    catch(error){if(closed)return;find('[data-life-content]').innerHTML=`<div class="life-empty"><p>${e(error.message)}</p>${button('重新读取','data-life-retry')}</div>`;find('[data-life-content]').setAttribute('aria-busy','false');feedback('读取失败，点击重试。',true);}
  }
  async function reload(){view=await request();if(closed)return;if(section==='memory')await refreshMemory();else{memoryOverview=view.memoryOverview;memorySubject=memoryOverview?.selectedSubject?.subjectKey||memorySubject;}draw();}
  async function run(node,operation,success=''){
    if(busy)return;busy=true;
    const protectFeedback=section==='memory';
    if(section==='memory')stopMemoryRefresh();
    const previousRevision=view?.character?.revision;
    const locked=[...dialog.querySelectorAll('input,textarea,select,[data-life-tab],[data-life-mode],[data-life-form] button,[data-life-save],[data-life-save-media],[data-life-persona-actions] button')].map(control=>[control,control.disabled]);
    locked.forEach(([control])=>control.disabled=true);feedback('正在保存…');const submittedFeedback=feedbackVersion;
    try{await operation();if(!closed&&(!protectFeedback||submittedFeedback===feedbackVersion))feedback(success||(moduleId==='qq'&&view?.character?.revision!==previousRevision?'已保存。QQ 使用新版本需重新绑定。':'已保存'));}
    catch(error){if(!closed&&(!protectFeedback||submittedFeedback===feedbackVersion))feedback(error.message,true);}
    finally{busy=false;if(!closed){locked.forEach(([control,disabled])=>{if(control.isConnected&&control.disabled)control.disabled=disabled;});if(node?.isConnected)node.disabled=false;find('[data-life-save]').disabled=!view;if(view)modeButtons();if(section==='media')updateMediaStatus();if(section==='memory')scheduleMemoryRefresh();}}
  }
  function settingsPatch(v,prefixes){const result={};for(const [name,value]of Object.entries(v)){if(!prefixes.some(prefix=>name===prefix||name.startsWith(prefix+'.')))continue;const input=find(`[name="${CSS.escape(name)}"]`);put(result,name,input?.type==='number'?Number(value):value);}return result;}
  function syncVoiceModeDrafts(mode){for(const id of ['profile','tools']){const saved=drafts[id]||ctx.drafts.read(key(id),null);if(!saved?.values)continue;saved.values['media.voiceMode']=mode;drafts[id]=saved;ctx.drafts.write(key(id),saved);}}
  function resetDraft(){const snapshot=drafts[section];if(snapshot)ctx.drafts.commit(key(section),snapshot);delete drafts[section];editingId='';if(section==='memory')memorySnapshot=null;}
  function mergedProfile(v){
    const raw=clone(view.character?.raw||character.raw||{}),data=raw.data&&typeof raw.data==='object'?raw.data:raw;
    if(!v.name.trim())throw new Error('请填写角色名称。');
    for(const name of ['name','description','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions'])data[name]=v[name];
    data.alternate_greetings=jsonValue(v.alternate_greetings,'备选开场','array');
    data.extensions??={};data.extensions.workbench??={};data.extensions.workbench.prompt_order=jsonValue(v.promptOrder,'提示词顺序','array');
    return {raw,name:v.name.trim(),description:v.description,revision:view.character?.revision||character.revision};
  }
  async function save(){if(section==='media'){await run(find('[data-life-save]'),saveMedia);return;}if(section==='memory'&&!editingId&&!read().content?.trim()&&!find('[data-life-memory-manual]')?.open){find('[data-life-memory-manual]').open=true;memoryManualOpen=true;find('[data-life-save]').textContent='记住这件事';find('[name="content"]')?.focus();return;}stash();const v=read();await run(find('[data-life-save]'),async()=>{
    if(section==='profile')await request('profile',mergedProfile(v));
    else if(section==='worldbook'){
      if(!v.content.trim())throw new Error('请填写世界书条目内容。');
      const books=jsonValue(v.worldbooks,'完整世界书','array'),entry={comment:v.entryName,keys:list(v.keys),secondary_keys:list(v.secondary_keys),content:v.content,constant:v.constant,enabled:v.enabled,selective:v.selective,position:v.position,insertion_order:Number(v.insertionOrder),extensions:{depth:Number(v.depth),probability:Number(v.probability),useProbability:true,scan_depth:Number(v.scanDepth),selectiveLogic:Number(v.secondaryLogic),excludeRecursion:!v.recursive,preventRecursion:!v.recursive}};
      if(!books.length)books.push({name:'工作台世界书',entries:[]});let remaining=Number(editingId),replaced=false;
      if(editingId!=='')for(const book of books){const entries=Array.isArray(book)?book:book.entries||[];if(remaining<entries.length){entries[remaining]={...entries[remaining],...entry,extensions:{...entries[remaining].extensions,...entry.extensions}};replaced=true;break;}remaining-=entries.length;}
      if(!replaced){if(Array.isArray(books[0]))books[0].push(entry);else(books[0].entries??=[]).push(entry);}
      await request('settings',{runtime:{worldbooks:books,worldbookBudgetChars:Number(v['runtime.worldbookBudgetChars'])}});
    }else if(section==='memory'){
      if(!v.content.trim())throw new Error('请填写要记住的内容。');
      const previous=memorySnapshot;
      await request('memories',previous?.layerVersion?{id:previous.id,revision:previous.revision,content:v.content,category:v.category,reality:v.reality,confidence:v.confidence,planStatus:v.planStatus,pinned:v.pinned,expiresAt:v.expiresAt?new Date(v.expiresAt).toISOString():null}:{...(previous?{id:previous.id,revision:previous.revision}:{}),scope:v.scope,content:v.content,kind:v.kind,sourceId:v.sourceId,sourceQuote:v.sourceQuote,pinned:v.pinned,status:previous?.status||'active',entities:jsonValue(v.entities,'实体','array'),relations:jsonValue(v.relations,'关系','array'),expiresAt:v.expiresAt?new Date(v.expiresAt).toISOString():null});
    }else if(section==='state')await request('state',{scope,revision:view.state?.revision,sharedRevision:view.state?.sharedRevision,state:{mood:v.mood,moodValue:Number(v.moodValue),energy:Number(v.energy),relationshipValue:Number(v.relationshipValue),relationship:v.relationship,activity:v.activity,plot:v.plot,variables:jsonValue(v.variables,'剧情变量','object')}});
    else if(section==='interaction')await request('settings',settingsPatch(v,['enabled','behavior','automation']));
    else if(section==='tools'){
      if(!v.name.trim())throw new Error('请填写工具名称。');
      if(v.kind==='drawing'?!v.workflowId:!v.url?.trim())throw new Error(v.kind==='drawing'?'请选择已导入的绘图工作流。':'请填写服务地址。');
      await request('tools',{...(editingId?{id:editingId}:{}),name:v.name,description:v.description,url:v.kind==='drawing'?'workbench:drawing':v.url,method:v.kind==='drawing'?'POST':v.method,kind:v.kind,...(v.kind==='drawing'?{workflowId:v.workflowId,promptField:v.promptField}:{}),enabled:v.enabled,headers:jsonValue(v.headers||'{}','请求头','object'),inputSchema:jsonValue(v.inputSchema,'输入格式','object')});
    }else if(section==='scripts'){
      const raw=clone(view.character?.raw||character.raw||{}),data=raw.data||raw;data.extensions=jsonValue(v.extensions,'角色扩展','object');
      await request('profile',{raw,name:view.character?.name||character.name,description:view.character?.description||'',revision:view.character?.revision||character.revision});
      await request('settings',settingsPatch(v,['runtime']));
    }
    const retain={
      memory:name=>name.startsWith('memory.')||name.startsWith('expression')||name==='recall'||name==='summaryContent',
      state:name=>name==='diary'||name==='diaryMood'||name.startsWith('decision')||name.startsWith('variableRules')||name.startsWith('variableUpdates')||/^(?:rule|vr)\d+_/.test(name),
      tools:name=>name.startsWith('media.')||['memes','expressionMap','memeName','memeUrl','memeTags','expressionName','expressionAction'].includes(name),
      scripts:name=>['scriptCode','scriptName','scriptId','scriptEnabled','htmlCode','previewText'].includes(name),
      profile:name=>name==='raw'&&v.raw!==json(view.character?.raw||character.raw),
    }[section];
    const remaining=retain?Object.fromEntries(Object.entries(v).filter(([name])=>retain(name))):{};
    resetDraft();if(Object.keys(remaining).length){drafts[section]={values:remaining,editingId:'',...(section==='memory'?{summarySnapshot,manualOpen:memoryManualOpen}:{})};ctx.drafts.write(key(section),drafts[section]);}
    await reload();if(section==='profile'||section==='scripts')await ctx.refresh();
  });}
  function edit(values,id='',snapshot){stash();if(section==='memory'&&snapshot){memorySnapshot=clone(snapshot);memoryManualOpen=!snapshot.layerVersion;}editingId=id;drafts[section]={values:{...read(),...values},editingId:id,...(section==='memory'?{memorySnapshot,summarySnapshot,manualOpen:memoryManualOpen}:{})};ctx.drafts.write(key(section),drafts[section]);draw();find('[name="content"], [name="name"], [name="entryName"]')?.focus();}
  function clearMemoryEditor(){
    stash();const remaining=Object.fromEntries(Object.entries(read()).filter(([name])=>name.startsWith('memory.')||name.startsWith('expression')||['recall','summaryContent'].includes(name)));
    resetDraft();drafts.memory={values:remaining,editingId:'',memorySnapshot:null,summarySnapshot,manualOpen:memoryManualOpen};ctx.drafts.write(key('memory'),drafts.memory);draw();
  }
  async function remove(route,id){
    const result=await confirmDelete(route);if(!result)return;
    await run(null,async()=>{await request(route+'/delete',{id});stash();if(route!=='memories'||editingId===id)resetDraft();await reload();});
  }
  function confirmDelete(route){return new Promise(resolve=>{const box=document.createElement('div');box.className='life-delete-confirm';box.setAttribute('role','alert');box.innerHTML=`<p>删除${({memories:'这条记忆',expressions:'这条表达',tools:'这个工具'})[route]}后无法恢复。${route==='memories'?'原聊天会保留。':''}</p>${button('确认删除','data-confirm-delete')}${button('取消','data-cancel-delete')}`;find('[data-life-content]').prepend(box);box.querySelector('[data-cancel-delete]').focus();box.querySelector('[data-confirm-delete]').onclick=()=>{box.remove();resolve(true);};box.querySelector('[data-cancel-delete]').onclick=()=>{box.remove();resolve(false);};signal.addEventListener('abort',()=>resolve(false),{once:true});});}
  function safeItem(item){const {createdAt,updatedAt,accessCount,lastAccessAt,retrieval,score,...value}=item;return value;}
  async function preview(simulate){
    if(busy)return;stash();busy=true;find('[data-life-save]').disabled=true;const cancel=find('[data-life-cancel]');cancel.hidden=false;feedback(simulate?'正在预演…':'正在编排提示词…');
    try{
      const result=await request(simulate?'simulate':'preview',{moduleId,...(conversationId?{conversationId}:{}),text:read().previewText||'',userName:'你'});if(closed)return;
      const target=find('[data-life-preview-result]');target.innerHTML=`${result.text?`<p class="life-preview-reply">${e(result.text)}</p>`:''}<details open><summary>${simulate?'预演记录':'提示词与触发轨迹'}</summary><pre class="life-code">${e(json(result))}</pre></details>`;
      for(const item of array(result.html))await mountPreviewFrame(target,typeof item==='string'?item:item.html,result.state?.variables??view.state?.variables);
      feedback('预演完成');
    }catch(error){if(!closed)feedback(error.message,true);}
    finally{busy=false;if(!closed){cancel.hidden=true;find('[data-life-save]').disabled=false;}}
  }
  async function mountPreviewFrame(target,html,variables=view.state?.variables){
    const frame=document.createElement('iframe'),nonce=crypto.randomUUID();frame.title='角色状态栏预览';frame.className='life-script-frame';frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';
    const bridge=`(()=>{const nonce=${JSON.stringify(nonce)};let serial=0;const pending=new Map();window.characterBridge=(action,payload)=>new Promise((resolve,reject)=>{const requestId=String(++serial);pending.set(requestId,{resolve,reject});parent.postMessage({channel:'workbench-character-frame',nonce,requestId,action,payload},'*');});window.addEventListener('message',event=>{const data=event.data;if(event.source!==parent||data?.nonce!==nonce||data.channel!=='workbench-character-frame-result')return;const request=pending.get(data.requestId);if(request){pending.delete(data.requestId);data.error?request.reject(new Error(data.error)):request.resolve(data.value);}});for(const action of ['getVariables','getMvuData','getChatMessages','replaceVariables','updateVariables','createChatMessages'])window[action]=payload=>window.characterBridge(action,payload);})();`;
    const documentHTML=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:14px 'Segoe UI','Microsoft YaHei UI',sans-serif;color:${document.documentElement.dataset.theme==='dark'?'#eceafa':'#343866'};margin:14px}button,input{font:inherit}</style><script>${bridge}<\/script></head><body>${html}</body></html>`;
    const result=await request('frame',{html:documentHTML});if(closed)return;
    frame.src=result.url;const record={frame,nonce,variables:clone(variables||{}),messages:[],scope,revision:view.state?.revision,sharedRevision:view.state?.sharedRevision};previewFrames.push(record);target.append(frame);
    const apply=document.createElement('button');apply.type='button';apply.className='button small';apply.dataset.lifeApplyFrame=nonce;apply.textContent='应用状态栏变量';target.append(apply);
  }
  window.addEventListener('message',event=>{
    const data=event.data,record=previewFrames.find(item=>event.source===item.frame.contentWindow&&data?.nonce===item.nonce);if(!record||data.channel!=='workbench-character-frame'||typeof data.requestId!=='string')return;
    let value,error;try{if(data.action==='getVariables'||data.action==='getMvuData')value=clone(record.variables);else if(data.action==='replaceVariables'||data.action==='updateVariables'){if(!data.payload||typeof data.payload!=='object'||Array.isArray(data.payload))throw new Error('变量必须是对象。');record.variables=data.action==='replaceVariables'?clone(data.payload):{...record.variables,...clone(data.payload)};value=clone(record.variables);}else if(data.action==='getChatMessages')value=clone(record.messages);else if(data.action==='createChatMessages'){record.messages.push(...array(data.payload));value=clone(record.messages);}else throw new Error('此 API 尚未开放。');}catch(cause){error=cause.message;}record.frame.contentWindow.postMessage({channel:'workbench-character-frame-result',nonce:record.nonce,requestId:data.requestId,value,error},'*');
  },{signal});
  find('[data-life-form]').addEventListener('input',event=>{if(event.target.name==='memorySubject')return;stash();feedback('未保存的修改');if(section==='media')updateMediaStatus();},{signal});
  find('[data-life-form]').addEventListener('change',event=>{if(event.target.name==='memorySubject'){void selectMemorySubject(event.target.value);return;}stash();if(section==='memory'&&event.target.name==='category'&&find('[data-life-memory-plan]'))find('[data-life-memory-plan]').hidden=event.target.value!=='plan';if(section==='media')updateMediaStatus();if(section==='tools'&&event.target.name==='kind'){draw();if(read().kind==='drawing')void loadDrawingOptions({generateSchema:read().inputSchema==='{}'});}else if(section==='tools'&&event.target.name==='workflowId')void loadDrawingOptions({generateSchema:true});},{signal});
  find('[data-life-form]').addEventListener('toggle',event=>{if(event.target.matches('[data-life-memory-manual]')){memoryManualOpen=event.target.open;if(section==='memory'&&!editingId)find('[data-life-save]').textContent=memoryManualOpen?'记住这件事':'手动记录';}},{signal,capture:true});
  find('[data-life-form]').addEventListener('submit',event=>{event.preventDefault();void save();},{signal});
  dialog.addEventListener('focusin',event=>{const control=event.target.closest('[data-life-help]');if(control)showLocalHelp(control);else hideLocalHelp();},{signal});
  dialog.addEventListener('pointerover',event=>{const control=event.target.closest('[data-life-help]');if(control)showLocalHelp(control);},{signal});
  dialog.addEventListener('pointerout',event=>{if(event.target.closest('[data-life-help]')&&document.activeElement!==helpTrigger)hideLocalHelp();},{signal});
  dialog.addEventListener('click',event=>{
    const node=event.target.closest('button');if(!node)return;
    if(node.hasAttribute('data-life-help')){showLocalHelp(node);return;}
    if(node.hasAttribute('data-life-get-mode')){cleanup();ctx.navigate('characters');return;}
    if(node.hasAttribute('data-life-enable')){if(busy||!view)return;void run(node,async()=>{await request('settings',{enabled:true});await reload();});return;}
    if(node.hasAttribute('data-life-mode')){if(busy||!view||forceLite||view.capabilities?.[node.dataset.lifeMode]===false||node.dataset.lifeMode===view.settings.mode)return;stash();void run(node,async()=>{await request('settings',{mode:node.dataset.lifeMode});await reload();});}
    else if(node.hasAttribute('data-life-add-rule')){if(busy)return;const rules=editedRules();if(rules.length>=32){feedback('最多设置 32 条规则。',true);return;}replaceRuleDraft([...rules,{id:crypto.randomUUID(),name:'新规则',enabled:true,environment:'any',field:'energy',operator:'lte',value:30,choice:'brief',instruction:'根据当前精力简短回应。'}]);}
    else if(node.hasAttribute('data-life-remove-rule')){if(!busy)replaceRuleDraft(editedRules().filter((_,index)=>index!==Number(node.dataset.lifeRemoveRule)));}
    else if(node.hasAttribute('data-life-save-decision')){stash();void run(node,async()=>{await request('settings',{decision:{enabled:read()['decision.enabled'],rules:editedRules()}});await reload();});}
    else if(node.hasAttribute('data-life-add-variable-rule')){if(busy)return;const rules=editedVariableRules();if(rules.length>=32){feedback('最多设置 32 条变量规则。',true);return;}replaceVariableDraft([...rules,{id:crypto.randomUUID(),name:'被安慰后心情好一点',enabled:true,path:'moodValue',type:'number',initial:50,min:0,max:100,maxDelta:5,trigger:'semantic',environment:'any',conditionPath:'moodValue',operator:'gte',threshold:0,event:'对方明确安慰或鼓励了角色',operation:'add',value:3}]);}
    else if(node.hasAttribute('data-life-remove-variable-rule')){if(!busy)replaceVariableDraft(editedVariableRules().filter((_,index)=>index!==Number(node.dataset.lifeRemoveVariableRule)));}
    else if(node.hasAttribute('data-life-variable-move')){if(busy)return;const rules=editedVariableRules(),index=Number(node.dataset.lifeVariableMove),next=index+Number(node.dataset.delta);if(next>=0&&next<rules.length){[rules[index],rules[next]]=[rules[next],rules[index]];replaceVariableDraft(rules);}}
    else if(node.hasAttribute('data-life-save-variable-rules')){stash();void run(node,async()=>{await request('settings',{variableUpdates:{enabled:read()['variableUpdates.enabled'],rules:editedVariableRules(true)}});await reload();});}
    else if(node.hasAttribute('data-life-tab')){if(busy||node.hidden)return;stash();stopMemoryRefresh();section=node.dataset.lifeTab;editingId='';feedback();draw();}
    else if(node.hasAttribute('data-life-memory-refresh')){stopMemoryRefresh();void refreshMemory();}
    else if(node.hasAttribute('data-life-memory-organize'))void run(node,async()=>{await request('memory/organize',{moduleId,conversationId,retry:true});await refreshMemory();});
    else if(node.hasAttribute('data-life-memory-summary-edit')){stash();summarySnapshot=clone(memoryOverview?.summary||{revision:0});const draft=drafts.memory;draft.summarySnapshot=summarySnapshot;draft.values.summaryContent=summarySnapshot.content||'';ctx.drafts.write(key('memory'),draft);draw();find('[name="summaryContent"]')?.focus();}
    else if(node.hasAttribute('data-life-memory-summary-save'))void saveSummary();
    else if(node.hasAttribute('data-life-memory-summary-cancel')){stash();summarySnapshot=null;drafts.memory.summarySnapshot=null;delete drafts.memory.values.summaryContent;ctx.drafts.write(key('memory'),drafts.memory);draw();}
    else if(node.hasAttribute('data-life-memory-cancel'))clearMemoryEditor();
    else if(node.hasAttribute('data-life-retry'))void load();
    else if(node.hasAttribute('data-life-test-vision'))void testVision();
    else if(node.hasAttribute('data-life-refresh-vision'))void loadMediaStatus({refresh:true});
    else if(node.hasAttribute('data-life-drawing-refresh'))void loadDrawingOptions({refresh:true});
    else if(node.hasAttribute('data-life-add-media-tool')){
      const meta=mediaTools[node.dataset.lifeAddMediaTool];if(!meta||busy)return;
      edit({...toolDefaults,name:meta.kind==='drawing'?'工作台绘图':meta.label,kind:meta.kind,enabled:true},'');
      find(meta.kind==='drawing'?'[name="workflowId"]':'[name="url"]')?.focus();
      feedback(meta.kind==='drawing'?'选择工作流并保存工具，再在下方选择。':'填写服务地址并保存工具，再在下方选择。');
    }
    else if(node.hasAttribute('data-life-new')){if(section==='tools')edit({...toolDefaults},'');else if(section==='memory'){memoryManualOpen=true;clearMemoryEditor();find('[data-life-memory-manual]').open=true;find('[name="content"]')?.focus();}else{resetDraft();draw();}}
    else if(node.hasAttribute('data-life-order-move')){
      const order=jsonValue(read().promptOrder,'提示词顺序','array'),index=Number(node.dataset.lifeOrderMove),next=index+Number(node.dataset.delta);if(next>=0&&next<order.length){[order[index],order[next]]=[order[next],order[index]];edit({promptOrder:json(order)},editingId);find('[name="promptOrder"]').closest('details').open=true;feedback('未保存的修改');}
    }
    else if(node.hasAttribute('data-life-load-script')){
      const raw=view.character.raw,data=raw.data||raw,item=array(data.extensions?.tavern_helper?.scripts).find(item=>item.id===node.dataset.lifeLoadScript);
      if(item)edit({scriptId:item.id,scriptName:item.name||'',scriptCode:item.content,scriptEnabled:item.enabled!==false},editingId);
    }
    else if(node.hasAttribute('data-life-new-script'))edit({scriptId:'',scriptName:'',scriptCode:'',scriptEnabled:true},editingId);
    else if(node.hasAttribute('data-life-save-card-script'))void run(node,async()=>{
      const v=read();if(!v.scriptName.trim()||!v.scriptCode.trim())throw new Error('请填写脚本名称与代码。');
      const raw=clone(view.character.raw),data=raw.data||raw,extensions=jsonValue(v.extensions,'角色扩展','object');extensions.tavern_helper??={};const scripts=extensions.tavern_helper.scripts??=[];
      if(!Array.isArray(scripts))throw new Error('当前脚本库不是数组，请在扩展字段中整理后保存。');
      const id=v.scriptId||crypto.randomUUID(),index=scripts.findIndex(item=>item.id===id),item={...(index>=0?scripts[index]:{}),id,name:v.scriptName,content:v.scriptCode,enabled:v.scriptEnabled};
      if(index>=0)scripts[index]=item;else scripts.push(item);data.extensions=extensions;
      await request('profile',{raw,name:view.character.name,description:view.character.description,revision:view.character.revision});
      edit({extensions:json(extensions),scriptId:id},editingId);await reload();await ctx.refresh();
    });
    else if(node.hasAttribute('data-life-edit')){const item=memoryItem(node.dataset.lifeEdit);if(item)edit({...item,entities:json(item.entities||[]),relations:json(item.relations||[]),expiresAt:localDateInput(item.expiresAt)},item.id,item);}
    else if(node.hasAttribute('data-life-tool')){const item=view.tools.find(item=>item.id===node.dataset.lifeTool);edit({...item,headers:json(item.headers),inputSchema:json(item.inputSchema)},item.id);}
    else if(node.hasAttribute('data-life-world-entry')){
      const index=Number(node.dataset.lifeWorldEntry),item=array(view.settings.runtime.worldbooks).flatMap(book=>array(book.entries||book))[index],extra=item.extensions||{};
      edit({entryName:item.comment||item.name||'',keys:array(item.keys||item.key).join(', '),secondary_keys:array(item.secondary_keys||item.keysecondary).join(', '),content:item.content||'',constant:!!item.constant,enabled:item.enabled!==false,selective:!!item.selective,position:item.position===4?'depth':item.position||'before_char',depth:extra.depth??item.depth??4,probability:extra.probability??item.probability??100,recursive:!(extra.excludeRecursion??item.excludeRecursion??false),secondaryLogic:extra.selectiveLogic??item.selectiveLogic??0,scanDepth:extra.scan_depth??extra.scanDepth??item.scanDepth??2,insertionOrder:item.insertion_order??item.order??100},String(index));
    }
    else if(node.hasAttribute('data-life-pin')||node.hasAttribute('data-life-archive')){const id=node.dataset.lifePin||node.dataset.lifeArchive,item=memoryItem(id);if(item)void run(node,async()=>{await request('memories',{id:item.id,content:item.content,revision:item.revision,...(node.hasAttribute('data-life-pin')?{pinned:!item.pinned}:{status:item.status==='archived'?'active':'archived'})});stash();await reload();});}
    else if(node.hasAttribute('data-life-delete'))void remove(node.dataset.lifeDelete,node.dataset.id);
    else if(node.hasAttribute('data-life-recall'))void run(node,async()=>{const result=await request('recall',{moduleId,...(conversationId?{conversationId}:{}),text:read().recall});find('[data-life-recall-result]').innerHTML=array(result.memories).map(item=>`<p>${e(item.content)}</p>`).join('')||'没有找到相关记忆。';});
    else if(node.hasAttribute('data-life-save-memory-settings'))void run(node,async()=>{await request('settings',settingsPatch(read(),['memory']));stash();await reload();});
    else if(node.hasAttribute('data-life-save-expression'))void run(node,async()=>{const v=read();if(!v.expressionContent.trim())throw new Error('请填写表达习惯。');await request('expressions',{...(v.expressionId?{id:v.expressionId}:{}),content:v.expressionContent,sourceQuote:v.expressionSource,scope:v.scope||scope,enabled:v.expressionEnabled});edit({expressionContent:'',expressionSource:'',expressionId:''},editingId);await reload();});
    else if(node.hasAttribute('data-life-expression-edit')){const item=view.expressions.find(item=>item.id===node.dataset.lifeExpressionEdit);edit({expressionContent:item.content,expressionSource:item.sourceQuote||'',expressionId:item.id,expressionEnabled:item.enabled,scope:item.scope},editingId);find('[name="expressionContent"]').focus();}
    else if(node.hasAttribute('data-life-expression-toggle'))void run(node,async()=>{const item=view.expressions.find(item=>item.id===node.dataset.lifeExpressionToggle);await request('expressions',{...safeItem(item),enabled:!item.enabled});stash();await reload();});
    else if(node.hasAttribute('data-life-diary'))void run(node,async()=>{const v=read();if(!v.diary.trim())throw new Error('日记还没有内容。');await request('diary',{scope,content:v.diary,mood:v.diaryMood});edit({diary:''},editingId);await reload();});
    else if(node.hasAttribute('data-life-save-shared-voice'))void run(node,async()=>{const v=read();await request('settings',{media:{voiceId:v['media.voiceId'],voiceEnabled:v['media.voiceEnabled'],voiceMode:v['media.voiceMode'],...(v['media.voiceId']?{voiceTool:''}:{})}});stash();syncVoiceModeDrafts(v['media.voiceMode']);await reload();});
    else if(node.hasAttribute('data-life-save-media'))void run(node,async()=>{const v=read(),patch=settingsPatch(v,['media']);patch.media.memes=jsonValue(v.memes,'表情包素材','array');patch.media.expressionMap=jsonValue(v.expressionMap,'形象动作映射','object');await request('settings',patch);stash();syncVoiceModeDrafts(v['media.voiceMode']);await reload();});
    else if(node.hasAttribute('data-life-add-meme')){
      try{const v=read();if(!v.memeName.trim()||!v.memeUrl.trim())throw new Error('请填写表情包名称与图片直链。');let url;try{url=new URL(v.memeUrl.trim());}catch{}if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('图片直链需要完整的 HTTP(S) 网址，不能填写本地路径或带凭据的地址。');const memes=jsonValue(v.memes,'表情包素材','array');memes.push({id:crypto.randomUUID(),name:v.memeName.trim(),url:v.memeUrl.trim(),tags:list(v.memeTags)});edit({memes:json(memes),memeName:'',memeUrl:'',memeTags:''},editingId);find('[name="memeName"]').focus();feedback('已加入草稿，点击「保存媒体设置」生效。');}catch(error){feedback(error.message,true);}
    }
    else if(node.hasAttribute('data-life-add-expression-map')){
      try{const v=read(),name=v.expressionName.trim();if(!name||!v.expressionAction.trim())throw new Error('请填写情绪与模型表情／动作名。');const map=jsonValue(v.expressionMap,'形象动作映射','object');if(['__proto__','constructor','prototype'].includes(name))throw new Error('请换一个情绪名称。');map[name]=v.expressionAction.trim();edit({expressionMap:json(map),expressionName:'',expressionAction:''},editingId);find('[name="expressionName"]').focus();feedback('已加入草稿，点击「保存媒体设置」生效。');}catch(error){feedback(error.message,true);}
    }
    else if(node.hasAttribute('data-life-remove-meme')||node.hasAttribute('data-life-remove-mapping')){
      try{const v=read();if(node.hasAttribute('data-life-remove-meme')){const memes=jsonValue(v.memes,'表情包素材','array'),id=node.dataset.lifeRemoveMeme;if(!id||memes.filter(item=>item?.id===id).length!==1)throw new Error('表情包标识已变化、缺失或重复，请先在 JSON 中修正并保存。');edit({memes:json(memes.filter(item=>item?.id!==id))},editingId);find('[name="memeName"]').focus();}else{const map=jsonValue(v.expressionMap,'形象动作映射','object');delete map[node.dataset.lifeRemoveMapping];edit({expressionMap:json(map)},editingId);find('[name="expressionName"]').focus();}feedback('已移出草稿，保存媒体设置后生效。');}catch(error){feedback(error.message,true);}
    }
    else if(node.hasAttribute('data-life-run-script'))void run(node,async()=>{
      const code=read().scriptCode;if(!code.trim())throw new Error('请先填写脚本代码。');stash();scriptResult=await request('scripts/preview',{code,scope,messages:[]});
      const target=find('[data-life-script-result]');target.innerHTML=`<pre class="life-code">${e(json(scriptResult))}</pre>`;
      for(const item of array(scriptResult.html))await mountPreviewFrame(target,typeof item==='string'?item:item.html,scriptResult.variables??view.state?.variables);
      find('[data-life-apply-script]').disabled=!scriptResult.variables;
    });
    else if(node.hasAttribute('data-life-apply-script'))void run(node,async()=>{
      if(!scriptResult?.variables)throw new Error('请先成功运行脚本预演。');await request('state',{scope,revision:view.state?.revision,state:{variables:scriptResult.variables}});view=await request();feedback('预演变量已保存');
    });
    else if(node.hasAttribute('data-life-apply-frame'))void run(node,async()=>{
      const record=previewFrames.find(item=>item.nonce===node.dataset.lifeApplyFrame);if(!record)throw new Error('此状态栏预演已失效，请重新预览。');
      await request('state',{scope:record.scope,revision:record.revision,sharedRevision:record.sharedRevision,state:{variables:record.variables}});view=await request();record.revision=view.state?.revision;record.sharedRevision=view.state?.sharedRevision;
    });
    else if(node.hasAttribute('data-life-render-html'))void run(node,async()=>{
      const html=read().htmlCode;if(!html.trim())throw new Error('请先填写 HTML。');stash();const target=find('[data-life-html-result]');target.replaceChildren();await mountPreviewFrame(target,html);
    });
    else if(node.hasAttribute('data-life-current-display'))void run(node,async()=>{
      const target=find('[data-life-html-result]');target.replaceChildren();for(const item of array(view.display?.html))await mountPreviewFrame(target,typeof item==='string'?item:item.html);
    });
    else if(node.hasAttribute('data-life-action'))void run(node,async()=>{await request('actions',{id:node.dataset.id,operation:node.dataset.lifeAction});await reload();});
    else if(node.hasAttribute('data-life-preview'))void preview(false);
    else if(node.hasAttribute('data-life-simulate'))void preview(true);
    else if(node.hasAttribute('data-life-cancel'))requestController?.abort();
    else if(node.hasAttribute('data-life-apply-raw'))void run(node,async()=>{const raw=jsonValue(read().raw,'原始角色卡','object'),data=raw.data||raw;if(!data.name?.trim())throw new Error('原始资料需要 name 字段。');raw.extensions={...raw.extensions,workbenchAvatar:view.character.avatar||''};await request('profile',{raw,name:data.name,description:data.description||'',revision:view.character.revision});resetDraft();await reload();await ctx.refresh();});
    else if(node.hasAttribute('data-life-apply-books'))void run(node,async()=>{await request('settings',{runtime:{worldbooks:jsonValue(read().worldbooks,'完整世界书','array'),worldbookBudgetChars:Number(read()['runtime.worldbookBudgetChars'])}});resetDraft();await reload();});
  },{signal});
  void load();return cleanup;
}
