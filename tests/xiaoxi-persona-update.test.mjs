import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {WorkbenchStore} from '../framework/store.mjs';
import {updateXiaoxiPersona} from '../tools/update-xiaoxi-persona.mjs';

test('小汐更新先备份所有目标，只更新旧模板，保留头像、自定义字段与其他资料',async t=>{
  const root=mkdtempSync(join(tmpdir(),'xiaoxi-persona-update-')),dataDir=join(root,'data'),backupDir=join(root,'backup');
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  const legacy=readFileSync(new URL('./fixtures/xiaoxi-legacy.md',import.meta.url),'utf8').replaceAll('\r\n','\n');
  const personality=legacy.split('## 性格\n')[1].split('\n## ')[0].trim();
  const raw={spec:'chara_card_v2',spec_version:'2.0',data:{name:'林小汐',description:legacy,personality,first_mes:'用户自定开场',creator_notes:'从现有小汐人设原文导入，未补写背景、开场或模型。',extensions:{life:'keep'}},extensions:{workbenchAvatar:'existing-avatar',custom:42}};
  const instance='11111111-1111-4111-8111-111111111111',dirs=[dataDir,join(dataDir,'instances',instance)];
  for(const dir of dirs){
    mkdirSync(dir,{recursive:true});const store=new WorkbenchStore(dir);
    const insert=store.db.prepare('INSERT INTO characters VALUES(?, ?, ?, ?, ?, ?)');
    insert.run('original','林小汐',legacy.trim(),6,'2026-11-01',JSON.stringify(raw));
    insert.run('custom','林小汐',legacy+'用户自己的改动',2,'2026-11-01',JSON.stringify({...raw,data:{...raw.data,description:legacy+'用户自己的改动'}}));
    insert.run('raw-custom','林小汐',legacy.trim(),3,'2026-11-01',JSON.stringify({...raw,data:{...raw.data,description:'另写的一版'}}));
    store.setSetting('selectedCharacterId','original');store.setSetting('chat-history',[{text:'保留聊天'}]);
    store.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)').run('avatar','image','旧头像',null,'original','keep.png');store.close();
  }
  const before=dirs.map(dir=>{const db=new DatabaseSync(join(dir,'workbench.sqlite'),{readOnly:true});const snapshot={custom:db.prepare("SELECT * FROM characters WHERE id != 'original'").all(),settings:db.prepare('SELECT * FROM settings').all(),assets:db.prepare('SELECT * FROM assets').all()};db.close();return snapshot;});
  const preview=await updateXiaoxiPersona({dataDir});assert.equal(preview.updated,0);assert.equal(preview.candidates,2);
  const applied=await updateXiaoxiPersona({dataDir,backupDir,apply:true});assert.equal(applied.updated,2);
  for(const [index,dir] of dirs.entries()){
    const db=new DatabaseSync(join(dir,'workbench.sqlite'),{readOnly:true}),row=db.prepare("SELECT * FROM characters WHERE id = 'original'").get(),next=JSON.parse(row.raw);
    assert.match(row.description,/165 cm/);assert.match(row.description,/17 岁/);assert.match(row.description,/安静、克制/);assert.doesNotMatch(row.description,/workflow\.json/);assert.equal(next.data.description,row.description);assert.equal(row.revision,7);
    assert.match(next.data.personality,/沉稳/);assert.doesNotMatch(next.data.personality,/模块|作者|制卡/);assert.equal(next.data.first_mes,raw.data.first_mes);assert.deepEqual(next.extensions,raw.extensions);assert.deepEqual(next.data.extensions,raw.data.extensions);
    assert.deepEqual({custom:db.prepare("SELECT * FROM characters WHERE id != 'original'").all(),settings:db.prepare('SELECT * FROM settings').all(),assets:db.prepare('SELECT * FROM assets').all()},before[index]);db.close();
    const original=new DatabaseSync(join(backupDir,index===0?'global.sqlite':instance+'.sqlite'),{readOnly:true});assert.equal(original.prepare("SELECT raw FROM characters WHERE id = 'original'").get().raw,JSON.stringify(raw));original.close();
  }
  assert.equal((await updateXiaoxiPersona({dataDir,apply:true,backupDir:join(root,'second')})).updated,0,'重复运行不改动已更新角色');
});
