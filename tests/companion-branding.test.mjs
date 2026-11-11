import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
const branding=await import('../desktop/companion-branding.cjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});

test('平台展示文案移除上游品牌，保留接口键与真实链接',()=>{
  assert.equal(typeof branding.companionBranding,'function');
  const original={'airi-card':{title:'AIRI 角色卡',description:'使用 AIRI 角色卡预设'},connection:{description:'AIRI 会生成一个令牌。',url:'https://airi.moeru.ai/docs/'}};
  const result=branding.companionBranding(original,'messages');
  assert.equal(result['airi-card'].title,'角色卡');assert.doesNotMatch(result.connection.description,/AIRI/i);
  assert.equal(result.connection.url,original.connection.url);assert.equal(original['airi-card'].title,'AIRI 角色卡');
});

test('运行界面的标题使用平台名称，技术标识保持原样',()=>{
  assert.equal(typeof branding.companionBranding,'function');
  assert.equal(branding.companionBranding('Project AIRI'),'小念的创作笔记');
  assert.equal(branding.companionBranding('Welcome to AIRI'),'虚拟陪伴');
  assert.equal(branding.companionBranding('AIRI'),'虚拟陪伴');
  assert.equal(branding.companionBranding('AIRI_SERVER_PORT'),'AIRI_SERVER_PORT');
  assert.equal(branding.companionBranding('AIRI 官方提供商'),'第三方云端服务');
});

test('展示适配保留真实路径和第三方署名，只替换产品文案',()=>{
  for(const value of [
    'E:\\AIRI\\resources\\app.asar',
    '模型位置："E:\\My AIRI App\\角色.vrm"',
    '/opt/AIRI/resources/app.asar',
    'Copyright (c) 2024 AIRI contributors',
    'AIRI is distributed under the MIT License.',
    '@proj-airi/server-sdk',
    'ai.moeru.airi',
    'airi-card',
  ])assert.equal(branding.companionBranding(value),value);
  assert.equal(branding.companionBranding('AIRI Editor'),'角色编辑器');
  assert.equal(branding.companionBranding('AIRI 运行组件：E:\\AIRI\\resources\\app.asar'),'虚拟陪伴 运行组件：E:\\AIRI\\resources\\app.asar');
});

test('展示品牌适配不会持久化改写用户角色内容或模型声音路径',()=>{
  const writes=[];
  const card={name:'AIRI',description:'我为 AIRI 写的自定义内容',systemPrompt:'AIRI 是我的角色',extensions:{airi:{voice_id:'E:\\AIRI\\custom-voice.wav'}}};
  const cards={getCard:()=>card,updateCard:(id,updates)=>{writes.push({id,updates});return Promise.resolve();}};
  const app={_context:{provides:{}},config:{globalProperties:{$pinia:{_s:new Map([['airi-card',cards]])}}}};
  const context={document:{querySelector:()=>({__vue_app__:app}),querySelectorAll:()=>[],title:'虚拟陪伴'},location:{hash:'#/chat'},MutationObserver:class {observe(){}},queueMicrotask:callback=>callback(),addEventListener:()=>{}};
  runInNewContext('('+branding.companionBranding.toString()+')({},"install")',context);
  assert.deepEqual(writes,[]);
  assert.equal(card.extensions.airi.voice_id,'E:\\AIRI\\custom-voice.wav');
});

test('来源链接的署名属性保持原样，窗口标题仍使用工作台名称',()=>{
  const attributes=new Map([['title','AIRI'],['aria-label','Project AIRI']]);
  const link={tagName:'A',closest:()=>link,getAttribute:key=>attributes.get(key)??null,setAttribute:(key,value)=>attributes.set(key,value)};
  const context={document:{querySelector:()=>null,querySelectorAll:()=>[link],title:'AIRI'},location:{hash:'#/chat'},MutationObserver:class {observe(){}},queueMicrotask:callback=>callback(),addEventListener:()=>{}};
  runInNewContext('('+branding.companionBranding.toString()+')({},"install")',context);
  assert.equal(context.document.title,'虚拟陪伴');
  assert.equal(attributes.get('title'),'AIRI');assert.equal(attributes.get('aria-label'),'Project AIRI');
});
