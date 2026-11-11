import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
import {createRequire} from 'node:module';

async function fixture(t,options={}){
  const directory=await mkdtemp(join(tmpdir(),'workbench-paths-')),folder=join(directory,'中文输出'),file=join(directory,'底模.safetensors');await mkdir(folder);await writeFile(file,'fixture');
  const calls=[],control={selected:file};
  const app=await createWorkbench({dataDir:join(directory,'profile'),instances:false,choosePath:async value=>{calls.push(value);return control.pending?new Promise(done=>{control.release=done;}):control.selected;},...options});
  app.context.store.setEnabled('drawing',true);app.context.store.setEnabled('training',true);
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const choose=async body=>{const response=await fetch(app.url+'/api/paths/choose',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  return {app,directory,folder,file,calls,control,choose};
}
test('模型文件与绘图／训练输出使用真实字段选择，选择本身不保存或启动',async t=>{
  const f=await fixture(t),before=f.app.context.store.module('training').config;
  const model=await f.choose({moduleId:'training',target:'training',trainingType:'moss-image-lora',field:'pretrained_model_name_or_path',kind:'file',currentPath:''});
  assert.equal(model.status,200);assert.equal(model.path,f.file);assert.equal(f.calls[0].kind,'file');
  f.control.selected=f.folder;
  for(const body of [{moduleId:'drawing',target:'module',field:'outputPath',kind:'directory'},{moduleId:'training',target:'module',field:'outputPath',kind:'directory'},{moduleId:'training',target:'training',trainingType:'moss-image-lora',field:'output_dir',kind:'directory'}]){
    assert.equal((await f.choose({...body,currentPath:f.folder})).path,f.folder);assert.equal(f.calls.at(-1).allowCreate,true);
  }
  assert.deepEqual(f.app.context.store.module('training').config,before);assert.equal((await f.app.context.ensureTraining()).runtime.child,undefined);
  assert.equal((await f.choose({moduleId:'drawing',target:'drawing-output',field:'outputPath',kind:'directory',currentPath:f.folder})).path,f.folder);
  assert.equal(f.calls.at(-1).allowCreate,true);
});
test('取消不返回新路径，错误字段和目录／文件类型在弹窗前后校验',async t=>{
  const f=await fixture(t),request={moduleId:'training',target:'training',trainingType:'moss-image-lora',field:'pretrained_model_name_or_path',kind:'file',currentPath:''};
  f.control.selected=null;assert.equal((await f.choose(request)).cancelled,true);
  const count=f.calls.length;
  for(const body of [{...request,field:'learning_rate'},{...request,kind:'directory'},{...request,moduleId:'qq'},{...request,currentPath:'\\\\server\\private'},{...request,unexpected:true}])assert.ok((await f.choose(body)).status>=400);
  assert.equal(f.calls.length,count);
  f.control.selected=f.folder;assert.equal((await f.choose(request)).status,400);
});

test('合并后的两个历史声音实例均可选择生成模型与克隆录音',async t=>{
  const f=await fixture(t);
  for(const moduleId of ['voice','voice-design']){
    f.app.context.store.setEnabled(moduleId,true);
    f.control.selected=f.file;
    assert.equal((await f.choose({moduleId,target:'module',field:'referencePath',kind:'file'})).path,f.file);
    f.control.selected=f.folder;
    assert.equal((await f.choose({moduleId,target:'module',field:'generatorPath',kind:'directory'})).path,f.folder);
  }
});
test('选择期间拒绝重复弹窗，停用模块后迟到结果不回填',async t=>{
  const f=await fixture(t),request={moduleId:'drawing',target:'module',field:'outputPath',kind:'directory',currentPath:''};f.control.pending=true;
  const pending=f.choose(request);await Promise.race([pending.then(()=>assert.fail('目录选择没有进入原生弹窗')),new Promise(done=>{const timer=setInterval(()=>{if(f.control.release){clearInterval(timer);done();}},5);timer.unref();})]);
  assert.equal((await f.choose(request)).status,409);f.app.context.store.setEnabled('drawing',false);f.control.release(f.folder);assert.equal((await pending).status,409);
});
test('桌面原生选择器区分文件与文件夹，所有来源共用单窗口与取消处理',async()=>{
  const require=createRequire(import.meta.url);let createPathDialogs;try{({createPathDialogs}=require('../desktop/path-picker.cjs'));}catch{}
  assert.equal(typeof createPathDialogs,'function');
  const calls=[];let release;const window={isDestroyed:()=>false},dialogs=createPathDialogs({getWindow:()=>window,dialog:{showOpenDialog:async(parent,options)=>{calls.push({parent,options});return new Promise(done=>{release=done;});}}});
  const first=dialogs.choosePath({kind:'file',title:'选择模型',defaultPath:'E:\\模型'});
  assert.deepEqual(calls[0].options.properties,['openFile']);await assert.rejects(dialogs.chooseDirectory({purpose:'environment'}),/选择窗口/);
  release({canceled:true,filePaths:[]});assert.equal(await first,null);
  const output=dialogs.choosePath({kind:'directory',allowCreate:true,title:'选择输出'});assert.deepEqual(calls[1].options.properties,['openDirectory','createDirectory']);release({canceled:false,filePaths:['E:\\输出']});assert.equal(await output,'E:\\输出');
});
test('实际模块实例继承桌面选择器，并阻止跨实例类型的路径请求',async t=>{
  const f=await fixture(t,{instances:true});
  const request=async(path,body)=>{const response=await fetch(f.app.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  const {instance}=await request('/api/instances',{moduleId:'training'});await request('/api/instances/'+instance.id+'/start',{});
  const base='/instances/'+instance.id+'/api/paths/choose';
  assert.equal((await request(base,{moduleId:'training',target:'training',trainingType:'moss-image-lora',field:'pretrained_model_name_or_path',kind:'file',currentPath:''})).path,f.file);
  const before=f.calls.length;assert.equal((await request(base,{moduleId:'drawing',target:'module',field:'outputPath',kind:'directory'})).status,409);assert.equal(f.calls.length,before);
});
test('通用文件或目录字段和无独立 schema 的已内置训练类型仍能选择路径',async t=>{
  const f=await fixture(t);f.app.context.store.setEnabled('voice',true);
  assert.equal((await f.choose({moduleId:'voice',target:'module',field:'modelPath',kind:'file'})).path,f.file);
  f.control.selected=f.folder;
  assert.equal((await f.choose({moduleId:'voice',target:'module',field:'modelPath',kind:'directory'})).path,f.folder);
  assert.equal((await f.choose({moduleId:'training',target:'training',trainingType:'flux-finetune',field:'output_dir',kind:'directory'})).path,f.folder);
  const before=f.calls.length;assert.ok((await f.choose({moduleId:'training',target:'training',trainingType:'non-existent',field:'output_dir',kind:'directory'})).status>=400);assert.equal(f.calls.length,before);
});

test('原生参考目录与预览参考图数组支持逐项选择，普通数组仍不能选择路径',async t=>{
  const f=await fixture(t),request={moduleId:'training',target:'training',trainingType:'qwen-image-21-lora',currentPath:''};
  f.control.selected=f.folder;
  assert.equal((await f.choose({...request,field:'input_data_dirs',kind:'directory'})).path,f.folder);
  assert.equal((await f.choose({...request,field:'dit_path',kind:'directory'})).path,f.folder,'分片模型原生允许目录');
  f.control.selected=f.file;
  assert.equal((await f.choose({...request,field:'preview_samples',kind:'file'})).path,f.file);
  const before=f.calls.length;
  assert.equal((await f.choose({...request,field:'input_data_dirs',kind:'file'})).status,400);
  assert.equal((await f.choose({...request,trainingType:'moss-image-lora',field:'network_args_custom',kind:'directory'})).status,400);
  assert.equal(f.calls.length,before);
});
