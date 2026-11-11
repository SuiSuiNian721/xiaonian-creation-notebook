import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';
import {importedCharacter} from '../framework/contracts.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=';
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'workbench-profile-'));
  const app=await createWorkbench({dataDir:directory});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const api=async(path,value)=>{const response=await fetch(app.url+path,{method:value===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});return {status:response.status,...await response.json()};};
  return {app,api};
}
test('用户资料默认为空，部分更新与清除持久化，拒绝非法字段和头像',async t=>{
  const {api}=await fixture(t);
  assert.deepEqual((await api('/api/user-profile')).profile,{displayName:'',avatar:'',identity:'',preferences:''});
  const saved=await api('/api/user-profile',{displayName:'念念',identity:'创作者',preferences:'喜欢简洁的回答',avatar:png});
  assert.equal(saved.status,200);assert.equal(saved.profile.avatar,png);
  assert.equal((await api('/api/user-profile',{identity:''})).profile.displayName,'念念');
  assert.equal((await api('/api/user-profile')).profile.identity,'');
  assert.equal((await api('/api/user-profile',{avatar:'data:image/svg+xml;base64,PHN2Zy8+'})).status,400);
  assert.equal((await api('/api/user-profile',{avatar:'data:image/jpeg;base64,'+png.split(',')[1]})).status,400);
  assert.equal((await api('/api/user-profile',{secret:'x'})).status,400);
  assert.equal((await api('/api/user-profile',{preferences:null})).status,400);
  assert.equal((await api('/api/user-profile',{avatar:''})).profile.avatar,'');
});
test('角色头像随资料导出，修改头像保留人设与原始扩展',async t=>{
  const {api}=await fixture(t);
  const {character}=await api('/api/characters',{name:'小汐',description:'原始人设'});
  const updated=await api('/api/characters/'+character.id+'/avatar',{avatar:png});
  assert.equal(updated.status,200);assert.equal(updated.character.avatar,png);assert.equal(updated.character.description,'原始人设');
  const exported=await api('/api/characters/'+character.id+'/export');
  assert.equal(exported.character.raw.extensions.workbenchAvatar,png);
  assert.equal((await api('/api/characters/'+character.id+'/avatar',{avatar:''})).character.avatar,'');
});
test('独立实例读取全局用户资料，实例内人设头像仍独立',async t=>{
  const {api}=await fixture(t);
  await api('/api/user-profile',{displayName:'念念',identity:'测试身份'});
  const {instance}=await api('/api/instances',{moduleId:'companion-lite',name:'头像测试'});
  assert.ok(instance?.id);
  const result=await api('/instances/'+instance.id+'/api/user-profile');
  assert.equal(result.status,200);assert.equal(result.profile.identity,'测试身份');
  await api('/api/user-profile',{identity:'修改后的身份'});
  assert.equal((await api('/instances/'+instance.id+'/api/user-profile')).profile.identity,'修改后的身份');
});
test('头像更新阻止旧人设覆盖，合法大头像只按导出结构计量一次',async t=>{
  const {api}=await fixture(t);
  const {character}=await api('/api/characters',{name:'头像边界',description:'保留人设'});
  const padded=Buffer.concat([Buffer.from(png.split(',')[1],'base64'),Buffer.alloc(850000)]);
  const avatar='data:image/png;base64,'+padded.toString('base64');
  const updated=await api('/api/characters/'+character.id+'/avatar',{avatar});
  assert.equal(updated.status,200);
  const stale=await api('/api/characters/'+character.id+'/life/profile',{raw:character.raw,revision:character.revision,name:character.name});
  assert.equal(stale.status,409);
  const profile=await api('/api/characters/'+character.id+'/life/profile',{raw:updated.character.raw,revision:updated.character.revision,description:'编辑后的简介'});
  assert.equal(profile.status,200);assert.equal(profile.character.avatar,avatar);
  const exported=await api('/api/characters/'+character.id+'/export');delete exported.status;
  assert.doesNotThrow(()=>importedCharacter({document:exported}));
  const oversized='data:image/png;base64,'+Buffer.concat([padded,Buffer.alloc(900000)]).toString('base64');
  const rejected=await api('/api/characters/'+character.id+'/avatar',{avatar:oversized});
  assert.equal(rejected.status,400);
  assert.equal((await api('/api/state')).characters[0].avatar,avatar);
});
