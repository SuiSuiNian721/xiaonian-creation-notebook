import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchError } from '../contracts.mjs';

export class LifeStore {
  constructor(dataDir,clock=Date.now){
    const directory=join(dataDir,'character-life');mkdirSync(directory,{recursive:true});
    this.clock=clock;this.db=new DatabaseSync(join(directory,'life.sqlite'));
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>1){this.db.close();throw new WorkbenchError(409,'角色系统数据库版本高于当前程序。');}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(character_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(character_id,kind,id));
      CREATE INDEX IF NOT EXISTS records_scope ON records(character_id,kind,scope);
      PRAGMA user_version=1;`);
    // 已开始发送但没有确认的任务不能因重启再次外发。
    for(const row of this.allKind('action'))if(row.data.status==='sending')this.put(row.character_id,'action',{...row.data,status:'unknown',error:'工作台在确认前关闭，未重试。'});
  }
  now(){return new Date(this.clock()).toISOString();}
  get(characterId,kind,id){const row=this.db.prepare('SELECT data FROM records WHERE character_id=? AND kind=? AND id=?').get(characterId,kind,id);return row?JSON.parse(row.data):null;}
  list(characterId,kind){return this.db.prepare('SELECT data FROM records WHERE character_id=? AND kind=? ORDER BY updated_at DESC,rowid DESC').all(characterId,kind).map(row=>JSON.parse(row.data));}
  allKind(kind){return this.db.prepare('SELECT character_id,data FROM records WHERE kind=?').all(kind).map(row=>({...row,data:JSON.parse(row.data)}));}
  put(characterId,kind,value){
    const at=this.now(),id=value.id??randomUUID();const previous=this.get(characterId,kind,id);
    const record={...value,id,scope:value.scope??'shared',createdAt:previous?.createdAt??value.createdAt??at,updatedAt:at};
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?) ON CONFLICT(character_id,kind,id) DO UPDATE SET scope=excluded.scope,data=excluded.data,updated_at=excluded.updated_at').run(characterId,kind,id,record.scope,JSON.stringify(record),at);
    return record;
  }
  delete(characterId,kind,id){return this.db.prepare('DELETE FROM records WHERE character_id=? AND kind=? AND id=?').run(characterId,kind,id).changes>0;}
  transaction(action){
    if(this.inTransaction)return action();
    this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;
    try{const value=action();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}finally{this.inTransaction=false;}
  }
  close(){this.db.close();}
}
