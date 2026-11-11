import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterResources} from '../framework/character-resources.mjs';
async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'resource-categories-')),store=new WorkbenchStore(dataDir);
  const character=newCharacter({name:'念念'});store.saveCharacter(character);
  t.after(async()=>{store.close();await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,store,character,resources:new CharacterResources({store,dataDir})};
}
test('角色卡按真实角色结构验证，保存不会自动覆盖现有人设',async t=>{
  const {resources,character,store}=await fixture(t);
  const base64=Buffer.from(JSON.stringify({spec:'chara_card_v2',data:{name:'小汐',description:'角色'}})).toString('base64');
  const card=await resources.add(character.id,{name:'小汐.json',kind:'card',base64});
  assert.equal(card.kind,'card');assert.equal(store.requireCharacter(character.id).name,'念念');
  await assert.rejects(resources.add(character.id,{name:'workflow.json',kind:'card',base64:Buffer.from('{"nodes":[]}').toString('base64')}),/角色卡/);
  await assert.rejects(resources.add(character.id,{name:'named-workflow.json',kind:'card',base64:Buffer.from('{"name":"绘图流程","nodes":[]}').toString('base64')}),/角色卡/);
});
test('超过上传上限的 LoRA 只关联共享位置，多角色不复制权重且修改后不能冒用旧结果',async t=>{
  const {resources,character,dataDir,store}=await fixture(t);
  assert.equal(typeof resources.addReference,'function');
  const path=join(dataDir,'shared.safetensors'),handle=await open(path,'w');await handle.truncate(64*1024*1024);await handle.close();
  const first=await resources.addReference(character.id,{name:'角色LoRA',kind:'lora',path,baseFamily:'sdxl'});
  const other=newCharacter({name:'茉茉'});store.saveCharacter(other);
  const second=await resources.addReference(other.id,{name:'共用LoRA',kind:'lora',path,baseFamily:'sdxl'});
  assert.equal(first.reference.locationId,second.reference.locationId);
  assert.equal((await readdir(join(dataDir,'character-resources'))).length,0);
  assert.equal(resources.list(character.id)[0].kind,'lora');
  assert.equal((await resources.file(character.id,first.id)).path,path);
  await writeFile(path,'changed');await assert.rejects(resources.file(character.id,first.id),/变化|重新/);
});
test('旧角色卡迁移不改文件；已删除角色恢复后仍可整理分类',async t=>{
  const {resources,character,store}=await fixture(t),bytes=Buffer.from('{"name":"旧版小汐","description":"保留原文"}');
  const resource=await resources.add(character.id,{kind:'workflow',name:'old.json',base64:bytes.toString('base64')});
  store.archiveCharacter(character.id);await resources.migrateLegacy();store.restoreCharacter(character.id);
  const revision=store.requireCharacter(character.id).revision;await resources.migrateLegacy();
  assert.equal(resources.list(character.id)[0].kind,'card');assert.equal(store.requireCharacter(character.id).revision,revision+1);
  assert.deepEqual((await resources.file(character.id,resource.id)).bytes,bytes);
});
