import test from 'node:test';
import assert from 'node:assert/strict';
import {moduleDefinitions} from '../framework/registry.mjs';
import {moduleGuides} from '../public-workbench/module-guides.js';
import {preparationFor} from '../public-workbench/resource-preparation.js';

const internalBrand=/\b(?:next[ -]?trainer|airi)\b/i;

test('public module descriptions and setup guidance use product names for embedded runtimes',()=>{
  for(const module of moduleDefinitions){
    const labels=[module.name,module.description,...module.requirements,...module.optionalIntegrations,module.discovery?.name,...module.settings.flatMap(field=>[field.label,field.help,field.placeholder])];
    assert.doesNotMatch(labels.filter(Boolean).join('\n'),internalBrand,module.id);
  }
  for(const [id,guide] of Object.entries(moduleGuides)){
    assert.doesNotMatch(JSON.stringify({title:guide.title,sections:guide.sections,steps:guide.steps?.map(({title,body})=>({title,body}))}),internalBrand,id);
  }
  for(const id of ['training','companion','mc-play']){
    const preparation=preparationFor(id);
    assert.doesNotMatch(JSON.stringify({title:preparation.title,items:preparation.items.map(({title,detail,links})=>({title,detail,links:links?.map(({label})=>label)})),modelSources:preparation.modelSources?.map(({label})=>label)}),internalBrand,id);
  }
});

test('model and external-tool names and verifiable upstream links remain available',()=>{
  assert.ok(moduleDefinitions.find(item=>item.id==='voice').requirements.some(item=>item.includes('MOSS')));
  assert.ok(moduleDefinitions.find(item=>item.id==='comfyui').name.includes('ComfyUI'));
  assert.ok(preparationFor('companion').items.some(item=>item.links?.some(link=>link.url.includes('github.com/moeru-ai/airi/releases'))));
});
