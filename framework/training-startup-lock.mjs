import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WorkbenchError} from './contracts.mjs';

const processAlive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const starting=(processHeld=true)=>({locked:true,processHeld,reason:'训练后台正在启动，请稍后刷新；需要结束本次启动时可点击“取消启动”。'});

// SQLite owns the actual process lock. The JSON file is diagnostic metadata;
// its presence alone must never become a persistent lock after a process exits.
export class TrainingStartupLock {
  constructor({directory,isProcessAlive=processAlive,legacyGraceMs=5000}){
    this.directory=directory;this.path=join(directory,'startup.lock');this.guardPath=join(directory,'startup-guard.sqlite');
    this.isProcessAlive=isProcessAlive;this.legacyGraceMs=legacyGraceMs;this.lease=null;this.inspection=null;
  }
  async metadata(){
    let info;try{info=await lstat(this.path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new WorkbenchError(409,'无法核实训练启动记录，请保留现场并检查资料目录权限。');
    try{return {value:JSON.parse(await readFile(this.path,'utf8')),mtimeMs:info.mtimeMs};}
    catch(error){if(error.code==='ENOENT')return null;if(error instanceof SyntaxError)return {value:null,mtimeMs:info.mtimeMs};throw error;}
  }
  async gate(){
    await mkdir(this.directory,{recursive:true});let db;
    try{db=new DatabaseSync(this.guardPath);db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');return db;}
    catch(error){db?.close();if([5,6].includes(error.errcode)||['SQLITE_BUSY','SQLITE_LOCKED'].includes(error.code))return null;throw error;}
  }
  unlock(db){try{db.exec('ROLLBACK');}finally{db.close();}}
  legacyActive(record,{workerPid,ready=false}={}){
    if(!record||record.value?.format===2||ready)return false;
    if(this.isProcessAlive(workerPid))return true;
    if(Number.isInteger(record.value?.launcherPid))return this.isProcessAlive(record.value.launcherPid);
    // An old writer may briefly have created an empty file before writing its PID.
    return Date.now()-record.mtimeMs<this.legacyGraceMs;
  }
  inspect(options={}){
    // Status probes briefly take the SQLite guard to recover stale metadata.
    // Queue local probes so they cannot mistake one another for a launcher.
    const pending=(this.inspection||Promise.resolve()).catch(()=>{}).then(()=>this.inspectState(options));
    this.inspection=pending;
    return pending.finally(()=>{if(this.inspection===pending)this.inspection=null;});
  }
  async inspectState(options){
    if(this.lease)return starting();
    const metadata=await this.metadata();
    if(!metadata&&!await lstat(this.guardPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))return {locked:false,recovered:false};
    const db=await this.gate();if(!db)return starting();
    try{
      const current=await this.metadata();if(this.legacyActive(current,options))return starting(false);
      if(current)await rm(this.path,{force:true});
      return {locked:false,recovered:Boolean(current)};
    }finally{this.unlock(db);}
  }
  async acquire(options={}){
    if(this.lease)throw new WorkbenchError(409,starting().reason);
    const db=await this.gate();if(!db)throw new WorkbenchError(409,starting().reason);
    let lease;
    try{
      const current=await this.metadata();if(this.legacyActive(current,options))throw new WorkbenchError(409,starting().reason);
      if(current)await rm(this.path,{force:true});
      const id=randomUUID();let marker;
      // Old versions only know the JSON path. Exclusive creation also prevents
      // a still-running old launcher from racing this protocol's SQLite guard.
      try{marker=await open(this.path,'wx');await marker.writeFile(JSON.stringify({format:2,lockId:id,launcherPid:process.pid,createdAt:new Date().toISOString()}),'utf8');}
      catch(error){if(error.code==='EEXIST')throw new WorkbenchError(409,starting().reason);throw error;}
      finally{await marker?.close();}
      lease={id,releasePromise:null,release:()=>lease.releasePromise??=(async()=>{
        try{if((await this.metadata())?.value?.lockId===id)await rm(this.path,{force:true});}
        finally{try{this.unlock(db);}finally{if(this.lease===lease)this.lease=null;}}
      })()};
      this.lease=lease;return lease;
    }catch(error){this.unlock(db);throw error;}
  }
}
