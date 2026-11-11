import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
const adapter=await import('../desktop/companion-presentation.cjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});

function fixture(selected,builtinModels=[],kind='stage'){
  assert.equal(typeof adapter.installCompanionPresentation,'function');
  const listeners=[];const subscribe=callback=>listeners.push(callback);
  const selection={selected,$subscribe:subscribe};
  const imported={id:'display-model-mine',name:'念念的模型.vrm',type:'file'};
  const models={displayModels:[{id:'preset-live2d-1',name:'Hiyori'},imported],$subscribe:subscribe,getDisplayModel:async id=>id==='display-model-mine'?imported:{id},loadDisplayModelsFromIndexedDB:async()=>{}};
  const stage={$subscribe:subscribe,stageModelSelectedDisplayModel:imported,stageModelSelectedUrl:'blob:mine',stageModelRenderer:'vrm'};
  Object.defineProperty(stage,'stageModelSelected',{get:()=>selection.selected,set:value=>{selection.selected=value;}});
  const pinia={_s:new Map([['display-models',models],['settings-stage-model',stage],['settings-stage-model-selection',selection]])};
  const storage=new Map(selected===undefined?[]:[['settings/stage/model',selected]]),reports=[];
  const context={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},document:{querySelector:selector=>selector==="#app"?({__vue_app__:{config:{globalProperties:{$pinia:pinia}}}}):null,documentElement:{dataset:{}},head:null},window:{electron:{ipcRenderer:{send:(_channel,state)=>reports.push(state)}}},MutationObserver:class {observe(){}},queueMicrotask:callback=>callback(),addEventListener:()=>{}};
  context.presentationConfig={kind,builtinModels};
  runInNewContext('('+adapter.installCompanionPresentation.toString()+')(presentationConfig)',context);
  return {selection,models,stage,storage,listeners,reports,imported};
}

test('默认和已选示例模型均清空，预置目录与查询不再提供示例模型',async()=>{
  const data=fixture('preset-live2d-1');
  assert.equal(data.storage.get('settings/stage/model'),'');assert.equal(data.selection.selected,'');
  assert.deepEqual(data.models.displayModels,[data.imported]);
  assert.equal(await data.models.getDisplayModel('preset-vrm-1'),undefined);
  assert.equal(fixture(undefined).storage.get('settings/stage/model'),'');
});

test('个人模型选择和数据保持原样，并向宿主报告可用状态',async()=>{
  const data=fixture('display-model-mine');
  assert.equal(data.storage.get('settings/stage/model'),'display-model-mine');
  assert.equal(data.selection.selected,'display-model-mine');
  assert.equal(await data.models.getDisplayModel('display-model-mine'),data.imported);
  assert.equal(data.reports.at(-1).available,true);assert.equal(data.reports.at(-1).name,'念念的模型.vrm');
});

test('角色切换再次带入示例选择时仅清空运行选择，不改写角色卡',()=>{
  const data=fixture('display-model-mine');
  data.selection.selected='preset-vrm-2';for(const listener of data.listeners)listener();
  assert.equal(data.selection.selected,'');assert.equal(data.reports.at(-1).available,false);
});

const whale={id:'display-model-builtin-ds-whale',name:'DS 鲸鱼娘',format:'live2d-zip',type:'url',url:'file:///models/ds-whale.zip',previewImage:'file:///models/preview.png',importedAt:0};
test('内置鲸鱼娘可查询并供新资料选用，目录重新载入后仍只有一份',async()=>{
  const data=fixture(undefined,[whale]);
  assert.equal(data.selection.selected,whale.id);
  assert.equal(await data.models.getDisplayModel(whale.id),whale);
  data.models.displayModels=[data.imported,{id:'preset-vrm-1'}];
  for(const listener of data.listeners)listener();
  for(const listener of data.listeners)listener();
  assert.equal(data.models.displayModels.filter(item=>item.id===whale.id).length,1);
  assert.ok(data.models.displayModels.includes(data.imported));
});
test('添加内置模型保留个人选择和明确留空，已选内置模型可重启恢复',()=>{
  assert.equal(fixture('display-model-mine',[whale]).selection.selected,'display-model-mine');
  assert.equal(fixture('',[whale]).selection.selected,'');
  assert.equal(fixture(whale.id,[whale]).selection.selected,whale.id);
});
test('辅助和设置窗口不会清空主舞台的持久化选择',()=>{
  for(const kind of ['auxiliary','settings','chat']){
    assert.equal(fixture(undefined,[whale],kind).storage.has('settings/stage/model'),false);
    assert.equal(fixture(whale.id,[whale],kind).storage.get('settings/stage/model'),whale.id);
  }
});
