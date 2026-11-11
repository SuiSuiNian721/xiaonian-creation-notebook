import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readdirSync,existsSync,lstatSync,copyFileSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {WorkbenchStore} from './store.mjs';
import {WorkbenchError} from './contracts.mjs';

const sha256=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const json=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});
const quote=identifier=>'"'+identifier.replaceAll('"','""')+'"';
const folders={cards:['card-studio'],drawing:['drawing/images','drawing/uploads'],comfyui:['drawing/downloads','drawing/snapshots'],qq:['qq'],companion:['companion'],'mc-skin':['mc-skin'],'mc-play':['mc-play']};
const tables={drawing:['drawing_workflows','drawing_jobs','drawing_images','drawing_hidden_jobs'],'mc-skin':['mc_skin_uploads','mc_skin_jobs']};

// Synchronous SQLite snapshots hold the JS writer at one event-loop boundary; never copy a WAL database as ordinary bytes.
function snapshotTree(source,target,manifest,base=source){
  mkdirSync(target,{recursive:true});
  for(const entry of readdirSync(source,{withFileTypes:true})){
    if(base===source&&['instances','migrations','resources'].includes(entry.name)||/(?:-wal|-shm)$/.test(entry.name)||['instances.sqlite','instances.lock','mcp-connection.json'].includes(entry.name))continue;
    const from=join(source,entry.name),to=join(target,entry.name);
    if(lstatSync(from).isSymbolicLink())throw new WorkbenchError(409,'旧资料中存在链接目录，迁移已停止并保留原文件。');
    if(entry.isDirectory()){snapshotTree(from,to,manifest,base);continue;}
    if(!entry.isFile())continue;
    if(entry.name.endsWith('.sqlite')){
      const db=new DatabaseSync(from,{readOnly:true});
      try{db.prepare('VACUUM INTO ?').run(to);}finally{db.close();}
      const check=new DatabaseSync(to,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('备份数据库校验失败。');}finally{check.close();}
    }else copyFileSync(from,to);
    manifest.files.push({path:relative(base,from),sha256:sha256(to),sqlite:entry.name.endsWith('.sqlite')});
  }
}
function copyTree(source,target){if(!existsSync(source))return;mkdirSync(target,{recursive:true});for(const entry of readdirSync(source,{withFileTypes:true})){const from=join(source,entry.name),to=join(target,entry.name);if(entry.isDirectory())copyTree(from,to);else copyFileSync(from,to);}}
function recoverStagedRuns(manager){
  const directory=join(manager.dataDir,'migrations','module-instances-v1');if(!existsSync(directory))return;
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;
    const run=join(directory,entry.name),file=join(run,'manifest.json');if(!existsSync(file))continue;
    const manifest=JSON.parse(readFileSync(file,'utf8'));if(!['staged','complete'].includes(manifest.status))continue;
    for(const instance of manifest.instances||[]){if(manager.db.prepare('SELECT id FROM instances WHERE id=?').get(instance.id))continue;const from=manager.directory(instance.id),to=join(run,'staged',instance.id);if(existsSync(from)&&!existsSync(to)){mkdirSync(join(run,'staged'),{recursive:true});renameSync(from,to);}}
    manifest.status='recovered';json(file,manifest);
  }
}
function readBinding(backup){const file=join(backup,'qq','qq.sqlite');if(!existsSync(file))return null;const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare("SELECT value FROM settings WHERE name='bindingId'").get();if(!row)return null;const binding=db.prepare('SELECT snapshot FROM bindings WHERE id=?').get(JSON.parse(row.value));return binding?JSON.parse(binding.snapshot):null;}finally{db.close();}}

export function migrateLegacy(manager,{fault,sanitize=value=>structuredClone(value)}={}) {
  const previous=manager.db.prepare("SELECT value FROM metadata WHERE key='legacy-v1'").get();
  if(previous)return {...JSON.parse(previous.value),alreadyMigrated:true,instances:manager.list()};
  if(manager.runtimes.size||manager.operations.size)throw new WorkbenchError(409,'请在启动实例前迁移旧资料。');
  recoverStagedRuns(manager);
  const source=manager.store,enabled=source.state().modules.filter(module=>module.enabled);
  const runId=randomUUID(),run=join(manager.dataDir,'migrations','module-instances-v1',runId),backup=join(run,'backup');
  const manifest={schemaVersion:1,runId,status:'preparing',createdAt:new Date().toISOString(),files:[],instances:[],archivedSharedRecords:0,originalsPreserved:true};
  mkdirSync(run,{recursive:true});const manifestFile=join(run,'manifest.json'),moved=[];
  try{
    snapshotTree(manager.dataDir,backup,manifest);manifest.status='backed-up';json(manifestFile,manifest);fault?.('after-backup');
    const original=Object.create(WorkbenchStore.prototype);original.db=new DatabaseSync(join(backup,'workbench.sqlite'),{readOnly:true});
    try{
      const binding=readBinding(backup),selected=original.getSetting('selectedCharacterId');
      const lifeFile=join(backup,'character-life','life.sqlite'),life=existsSync(lifeFile)?new DatabaseSync(lifeFile,{readOnly:true}):null;
      const lifeRows=life?.prepare('SELECT * FROM records').all()||[];life?.close();
      manifest.archivedSharedRecords=lifeRows.filter(row=>row.scope==='shared'&&!['settings','profile','tool'].includes(row.kind)).length;
      for(const module of enabled){
        const id=randomUUID(),stage=join(run,'staged',id),local=new WorkbenchStore(stage),at=new Date().toISOString();
        try{
          local.setEnabled(module.id,true);local.saveConfig(module.id,module.config);local.setSetting('instance.identity',{id,moduleId:module.id,legacy:true});local.setSetting('preferences',original.getSetting('preferences'));
          // Explicit module overrides migrate once; global connection credentials stay in the source archive.
          const settings=original.db.prepare('SELECT name,value FROM settings').all();
          for(const setting of settings){
            const drawingSetting=setting.name.startsWith('drawing.');
            const owned=drawingSetting?(module.id==='drawing'&&setting.name==='drawing.clientId'||module.id==='comfyui'&&setting.name!=='drawing.clientId'):setting.name.startsWith(module.id+'.');
            if(owned||setting.name==='ai.module.'+module.id||setting.name==='module.resources.'+module.id){const value=JSON.parse(setting.value);if(setting.name==='module.resources.'+module.id)value.task=null;local.setSetting(setting.name,value);}
          }
          const character=module.id==='qq'?(binding?{id:binding.characterId,name:binding.name,description:binding.description||'',raw:binding.raw||{},revision:binding.revision||1,assets:[]}:null):original.character(selected);
          if(character){local.saveCharacter(sanitize(character),true);local.selectCharacter(character.id);}
          const records=lifeRows.filter(row=>row.scope.startsWith(module.id+':')||(()=>{try{return JSON.parse(row.data).moduleId===module.id;}catch{return false;}})()||character&&row.character_id===character.id&&['settings','profile','tool'].includes(row.kind)).map(row=>['settings','profile','tool'].includes(row.kind)?{...row,data:JSON.stringify(sanitize(JSON.parse(row.data)))}:row);
          for(const row of records)if(!local.character(row.character_id)){const historical=original.character(row.character_id);if(historical)local.saveCharacter(historical,true);}
          if(records.length){mkdirSync(join(stage,'character-life'),{recursive:true});const db=new DatabaseSync(join(stage,'character-life','life.sqlite'));try{db.exec('CREATE TABLE records(character_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(character_id,kind,id));PRAGMA user_version=1');const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)');for(const row of records)insert.run(row.character_id,row.kind,row.id,row.scope,row.data,row.updated_at);}finally{db.close();}}
          for(const name of tables[module.id]||[]){const definition=original.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);if(!definition)continue;local.db.exec(definition.sql);for(const row of original.db.prepare('SELECT * FROM '+quote(name)).all()){const keys=Object.keys(row);local.db.prepare('INSERT INTO '+quote(name)+'('+keys.map(quote).join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(key=>row[key]));}}
          for(const event of original.events(module.id)){if(event.characterId&&!local.character(event.characterId)){const historical=original.character(event.characterId);if(historical)local.saveCharacter(historical,true);}if(!event.characterId||local.character(event.characterId))local.event(event);}
          for(const folder of folders[module.id]||[])copyTree(join(backup,folder),join(stage,folder));
          if(module.id==='comfyui'&&existsSync(join(backup,'drawing','comfy-startup.log'))){mkdirSync(join(stage,'drawing'),{recursive:true});copyFileSync(join(backup,'drawing','comfy-startup.log'),join(stage,'drawing','comfy-startup.log'));}
          manifest.instances.push({id,moduleId:module.id,name:module.name,createdAt:at,personaId:character?.id??null,records:records.length});
        }finally{local.close();}
        fault?.('after-instance',module.id);
      }
    }finally{original.close();}
    manifest.status='staged';json(manifestFile,manifest);
    // Publish the registry only after every independent profile has been prepared successfully.
    manager.db.exec('BEGIN IMMEDIATE');
    try{
      for(const instance of manifest.instances){const from=join(run,'staged',instance.id),to=manager.directory(instance.id);renameSync(from,to);moved.push({from,to});manager.db.prepare('INSERT INTO instances VALUES(?,?,?,?,?,?,NULL)').run(instance.id,instance.moduleId,instance.name,1,instance.createdAt,instance.createdAt);}
      fault?.('before-commit');manifest.status='complete';json(manifestFile,manifest);
      const result={runId,manifestPath:manifestFile,backupPath:backup,archivedSharedRecords:manifest.archivedSharedRecords};
      manager.db.prepare("INSERT INTO metadata VALUES('legacy-v1',?)").run(JSON.stringify(result));manager.db.exec('COMMIT');return {...result,instances:manager.list()};
    }catch(error){manager.db.exec('ROLLBACK');throw error;}
  }catch(error){for(const item of moved.reverse())renameSync(item.to,item.from);manifest.status='failed';manifest.error=String(error.message).slice(0,1000);json(manifestFile,manifest);throw error;}
}
