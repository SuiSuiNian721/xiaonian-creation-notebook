import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadTrainingForm} from '../framework/training-schema.mjs';
import {displaySections,fillTrainingDefaults,fieldLabel} from '../public-workbench/training-form-fields.js';
import * as fieldTools from '../public-workbench/training-form-fields.js';
import {validateTrainingCollection} from '../public-workbench/training-form-collections.js';

const integration=fileURLToPath(new URL('../integrations/next-trainer/',import.meta.url));
const fields=form=>form.sections.flatMap(section=>section.fields);
const catalog=JSON.parse(await readFile(new URL('../integrations/next-trainer/catalog.json',import.meta.url),'utf8')).training_types;
const forms=new Map();
for(const name of new Set(catalog.map(type=>type.schema_name).filter(Boolean)))forms.set(name,await loadTrainingForm(integration,name));

test('all 20 active training schemas retain native parameter coverage and help, including optional engines',()=>{
  assert.equal(forms.size,20);
  assert.equal([...forms.values()].flatMap(fields).length,1488,'条件分支及隐藏常量均保留');
  for(const [name,form] of forms){
    for(const field of fields(form)){
      if((field.hidden&&field.role!=='external-control')||field.key==='model_train_type')continue;
      assert.ok(field.description?.trim(),`${name}/${field.key} 必须有参数说明`);
    }
  }
});

test('optional-engine controls use readable concise labels from native descriptions',()=>{
  const byKey=new Map(fields(forms.get('moss-image-anima-lora')).map(field=>[field.key,field]));
  for(const key of ['epochs','max_steps','rank','grad_checkpointing','model_input_mode']){
    const label=fieldLabel(byKey.get(key));assert.notEqual(label,key,key);assert.ok(label.length<=30,label);
  }
});

test('duration fields follow engine schemas instead of adding Kohya keys to other engines',()=>{
  for(const name of ['qwen-image-21-lora','moss-image-anima-lora','ai-toolkit-flux-lora']){
    const form=forms.get(name),native=new Set(fields(form).map(field=>field.key));
    assert.deepEqual(displaySections(form,{model_train_type:name}).flatMap(section=>section.fields).filter(field=>!native.has(field.key)).map(field=>field.key),[],name);
  }
  assert.ok(displaySections(forms.get('moss-image-lora'),{model_train_type:'moss-image-lora'}).flatMap(section=>section.fields).some(field=>field.key==='max_train_steps'),'Kohya 仍支持按步数');
});

test('AI Toolkit always supplies its native step default even with an old epoch-mode draft',()=>{
  const value=fillTrainingDefaults(forms.get('ai-toolkit-flux-lora'),{model_train_type:'ai-toolkit-flux-lora',custom_option:{keep:true}},{limitMode:'epochs'});
  assert.equal(value.max_train_steps,2000);assert.equal(value.max_train_epochs,undefined);assert.deepEqual(value.custom_option,{keep:true});
});

test('Anima Fast respects its own duration discriminator and imported step-only configs',()=>{
  const form=forms.get('anima-lora-fast');
  const selected=fillTrainingDefaults(form,{model_train_type:'anima-lora-fast',training_duration_mode:'steps',max_train_epochs:3},{limitMode:'epochs'});
  assert.equal(selected.max_train_steps,100);assert.equal(selected.max_train_epochs,undefined);
  const imported=fillTrainingDefaults(form,{model_train_type:'anima-lora-fast',max_train_steps:17});
  assert.equal(imported.training_duration_mode,'steps');assert.equal(imported.max_train_steps,17);assert.equal(imported.max_train_epochs,undefined);
});

test('short native captions are supplemented with useful explanations rather than repeating labels',()=>{
  const form=forms.get('moss-image-lora');
  const find=key=>fields(form).find(field=>field.key===key);
  assert.match(fieldTools.fieldHelp?.(find('gradient_checkpointing'))||'',/重算.*显存|显存.*重算/);
  assert.match(fieldTools.fieldHelp?.(find('gradient_accumulation_steps'))||'',/批次.*更新|更新.*批次/);
});

test('structured sample validation follows Edit requirements and engine-specific limits',()=>{
  const field=fields(forms.get('qwen-image-21-lora')).find(field=>field.key==='preview_samples');
  const sample={prompt:'编辑预览',width:1024,height:1024,seed:42,guidance_scale:4,sample_steps:20,controlImages:[]};
  assert.throws(()=>validateTrainingCollection(field,[JSON.stringify(sample)],{editing:true,schemaName:'qwen-image-21-lora'}),/参考图/);
  sample.controlImages=['E:\\参考.png'];assert.doesNotThrow(()=>validateTrainingCollection(field,[JSON.stringify(sample)],{editing:true,schemaName:'qwen-image-21-lora'}));
  assert.throws(()=>validateTrainingCollection(field,[JSON.stringify({...sample,controlImages:[' ']})],{editing:true}),/参考图/);
  const toolkit=fields(forms.get('klein-lora')).find(field=>field.key==='preview_samples');
  assert.throws(()=>validateTrainingCollection(toolkit,[JSON.stringify({...sample,controlImages:['a','b','c','d']})],{editing:true,schemaName:'klein-lora'}),/3/);
  assert.throws(()=>validateTrainingCollection(toolkit,[JSON.stringify({...sample,prompt:''})],{editing:true,schemaName:'klein-lora'}),/提示词/);
});
