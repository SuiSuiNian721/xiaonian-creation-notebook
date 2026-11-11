// Runs in the isolated native renderer. Only runtime model selection is changed;
// character cards and user model files are never rewritten.
function installCompanionPresentation(config){
  const preset=id=>typeof id==='string'&&id.startsWith('preset-');
  const builtinModels=config.builtinModels||[];
  const previous=localStorage.getItem('settings/stage/model');
  const managesSelection=config.kind==='stage';
  const initialBuiltin=managesSelection?(builtinModels.find(model=>model.id===previous)||((previous===null||preset(previous))?builtinModels[0]:null)):null;
  if(managesSelection&&(previous===null||preset(previous)||initialBuiltin))localStorage.setItem('settings/stage/model','');
  if(initialBuiltin?.initialView&&previous===null){
    for(const [key,value] of Object.entries(initialBuiltin.initialView)){
      const storageKey='settings/live2d/'+key;
      if(localStorage.getItem(storageKey)===null)localStorage.setItem(storageKey,JSON.stringify(value));
    }
  }
  const copy=new Map([
    ['Audio Input Device','麦克风'],['Select the audio input device for your hearing module.','选择用于语音输入的麦克风。'],
    ['Auto-send Settings','自动发送'],['Configure automatic sending of transcribed text to chat','设置识别文字后的发送方式。'],['Auto-send transcribed text','自动发送识别文字'],
    ['Automatically send transcribed text to chat after a delay. This may consume tokens, so disable if you want to manually review and edit transcriptions before sending.','识别后稍等片刻自动发到聊天，这会调用对话模型。想先检查或修改识别结果，可以关闭此项。'],
    ['Use Custom SSML','自定义语音标记'],['Enable to input raw SSML instead of plain text','使用 SSML 调整停顿、语速等朗读方式。'],
    ['Vision capture cadence','画面采集'],['Tune how frequently the vision ticker captures a frame.','设置画面采集的间隔。'],['Capture interval','采集间隔'],['Lower values capture more frequently and may increase resource use.','间隔越短，采集越频繁，占用也会增加。'],
    ['TICKER','采集状态'],['Idle','未启动'],['Last capture','上次采集'],['Never','尚无'],['CAPTURES','采集次数'],['Last update','上次更新'],['CONTEXT UPDATES','上下文更新'],
    ['No audio input device','未找到麦克风'],['Input sensitivity','收音灵敏度'],['Advanced Settings','高级设置'],['Select a provider','选择服务'],['Select voice','选择声音'],['No provider configured','尚未配置服务'],
    ['Input Level','输入音量'],['Sensitivity','收音灵敏度'],['Adjust the threshold for speech detection','设置多大的声音会被识别为说话。'],['Silence','静音'],['Volume Based','按音量判断'],['Model Based','用模型判断'],['Use AI models for more accurate speech detection','使用模型判断是否有人在说话。'],
    ['听觉测试面板','麦克风测试'],['通过当前的听觉管线监听，并在下方保留每一段完成的语音转写。','对着麦克风说话，识别出的文字会显示在这里。'],
  ]);
  let installed=false,scheduled=false;
  const refresh=()=>{
    scheduled=false;
    if(document.documentElement)document.documentElement.dataset.companionView=config.kind;
    const route=(globalThis.location?.hash||'').split('?')[0].replace(/^#/,'');
    if(document.documentElement)document.documentElement.dataset.companionRoute=route;
    if(config.kind==='chat'){
      const titleBar=document.querySelector('[fixed][top="0"][drag-region]');
      if(titleBar){const walker=document.createTreeWalker(titleBar,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode()))if(node.data.trim()==='Chat')node.data=node.data.replace('Chat','聊天');}
    }
    if(route==='/settings/models'){
      for(const panel of document.querySelectorAll('[class*="before-position-absolute"]'))if(/Neuro-sama|Grok Ani/.test(panel.textContent))panel.hidden=true;
      for(const button of document.querySelectorAll('button'))if(/Godot/.test(button.textContent))button.hidden=true;
    }
    if(/^\/settings\/modules\/(?:hearing|speech|vision)$/.test(route)&&document.body){
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())){
        if(node.parentElement?.closest('script,style,pre,code,textarea,input,[contenteditable]'))continue;
        const original=node.data.trim(),translated=copy.get(original);
        if(translated)node.data=node.data.replace(original,translated);
      }
    }
    if(config.styles&&document.head&&!document.querySelector('style[data-companion-presentation]')){
      const style=document.createElement('style');style.dataset.companionPresentation='';style.textContent=config.styles;document.head.append(style);
    }
    if(installed)return;
    const pinia=document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia;
    const models=pinia?._s.get('display-models'),stage=pinia?._s.get('settings-stage-model'),selection=pinia?._s.get('settings-stage-model-selection');
    if(!models||!stage||!selection)return;
    installed=true;
    const lookup=models.getDisplayModel.bind(models);
    models.getDisplayModel=id=>preset(id)?Promise.resolve(undefined):builtinModels.some(model=>model.id===id)?Promise.resolve(builtinModels.find(model=>model.id===id)):lookup(id);
    let enforcing=false,lastReport='';
    const enforce=()=>{
      if(enforcing)return;enforcing=true;
      try{
        if(models.displayModels.some(model=>preset(model.id)))models.displayModels=models.displayModels.filter(model=>!preset(model.id));
        const missing=builtinModels.filter(model=>!models.displayModels.some(item=>item.id===model.id));
        if(missing.length)models.displayModels=[...models.displayModels,...missing];
        if(managesSelection&&preset(selection.selected))selection.selected='';
        const model=stage.stageModelSelectedDisplayModel;
        const available=!!selection.selected&&!preset(selection.selected)&&model?.id===selection.selected&&!!stage.stageModelSelectedUrl&&stage.stageModelRenderer!=='disabled';
        const state={available,id:available?String(model.id):null,name:available?String(model.name||'角色模型'):''};
        const serialized=JSON.stringify(state);
        if(serialized!==lastReport){lastReport=serialized;window.electron?.ipcRenderer.send('ai-future:companion:presentation',state);}
      }finally{enforcing=false;}
    };
    for(const store of [models,stage,selection])store.$subscribe(enforce,{flush:'sync',detached:true});
    if(initialBuiltin)selection.selected=initialBuiltin.id;
    enforce();
  };
  const schedule=()=>{if(!scheduled){scheduled=true;queueMicrotask(refresh);}};
  new MutationObserver(schedule).observe(document,{childList:true,subtree:true});
  addEventListener('DOMContentLoaded',schedule,{once:true});
  addEventListener('hashchange',schedule);
  schedule();
}
module.exports={installCompanionPresentation};
