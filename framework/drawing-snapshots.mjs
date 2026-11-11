import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchError, fields, text, identifier } from './contracts.mjs';
import { insideDirectory } from './drawing-files.mjs';
import { exists, digest } from './drawing-repositories.mjs';
import { readRepositories, publicRepository } from './drawing-inventory.mjs';

export const CONFIG_FILES=Object.freeze(['extra_model_paths.yaml','user/default/comfy.settings.json']);
export const SNAPSHOT_SCOPE='保存 Git 提交、分支与启用状态、运行设置和选定配置文件；Python 依赖仅保存清单，不能自动回退 Python 环境。不删除后来新增的模型或插件。';
export async function readConfigFiles(comfyPath){
  const files=[];
  for(const relativePath of CONFIG_FILES){
    const target=await insideDirectory(comfyPath,relativePath);const stat=await exists(target);
    if(!stat){files.push({relativePath,exists:false});continue;}
    if(!stat.isFile()||stat.size>4*1024*1024)throw new WorkbenchError(400,`配置文件不是普通小型文件：${relativePath}`);
    const bytes=await readFile(target);files.push({relativePath,exists:true,sha256:digest(bytes),bytes:bytes.toString('base64')});
  }
  return files;
}
export class DrawingSnapshots {
  constructor(manager){this.manager=manager;this.index=manager.store.getSetting('drawing.snapshots')||[];}
  list(){return structuredClone(this.index.slice().reverse());}
  async get(id){
    identifier(id,'快照标识');if(!this.index.find(item=>item.id===id))throw new WorkbenchError(404,'找不到快照。');
    const file=await insideDirectory(this.manager.directory,'snapshots',id,'snapshot.json');
    const snapshot=JSON.parse(await readFile(file,'utf8'));if(snapshot.id!==id)throw new WorkbenchError(409,'快照记录不一致。');return snapshot;
  }
  async create(value={},context={}){
    fields(value,['name']);const name=text(value.name??'环境快照','快照名称',120,{empty:true})||'环境快照';
    const m=this.manager;const configKey=m.configFingerprint();const runtimeSettings=m.drawing.runtime.settings();const configuredRoot=await m.root();
    if(context.comfyPath&&context.comfyPath!==configuredRoot)throw new WorkbenchError(409,'快照目标与当前环境配置不一致，请重新预览。');
    const comfyPath=context.comfyPath||configuredRoot;const warnings=[];
    const assertCurrent=()=>{m.open();if(context.signal?.aborted)throw new WorkbenchError(409,'快照已取消。');if(configKey!==m.configFingerprint())throw new WorkbenchError(409,'快照期间环境配置发生变化，请重新创建快照。');};
    assertCurrent();
    const repositories=await readRepositories(comfyPath,m.repositories,{signal:context.signal,warnings});
    const files=await readConfigFiles(comfyPath);
    let executable;try{executable=await m.python(comfyPath,runtimeSettings);}catch(error){warnings.push(error.message);}
    const safely=async args=>{if(!executable)return {code:null,error:'Python 路径不可用。',stdout:'',stderr:''};try{return await m.runner(executable,args,{cwd:comfyPath,signal:context.signal,timeoutMs:30000,maxBytes:1024*1024});}catch(error){return {code:null,error:error.message,stdout:'',stderr:''};}};
    const version=await safely(['-I','--version']);const freeze=await safely(['-I','-m','pip','freeze']);
    for(const [label,result] of [['Python 版本',version],['pip freeze',freeze]])if(result.code!==0||result.error)warnings.push(`${label} 未完整记录：${result.error||result.stderr||result.code}`);
    assertCurrent();
    const snapshot={id:randomUUID(),name,createdAt:new Date().toISOString(),comfyPath,reason:context.reason||'manual',scope:SNAPSHOT_SCOPE,repositories:repositories.map(publicRepository),runtimeSettings,files,python:{executable:executable||null,version,freeze},warnings};
    const file=await insideDirectory(m.directory,'snapshots',snapshot.id,'snapshot.json');await mkdir(dirname(file),{recursive:true});
    await writeFile(file,JSON.stringify(snapshot,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
    assertCurrent();
    this.index.push({id:snapshot.id,name,createdAt:snapshot.createdAt,comfyPath,reason:snapshot.reason,warnings});
    try{m.store.setSetting('drawing.snapshots',this.index);}catch(error){this.index.pop();throw error;}
    return snapshot;
  }
  async restoreFiles(snapshot,root,configKey){
    const assertCurrent=()=>{if(configKey!==this.manager.configFingerprint())throw new WorkbenchError(409,'恢复期间环境配置发生变化，已停止后续写入；部分仓库或文件可能已恢复，当前运行设置已保留。');};
    assertCurrent();
    for(const file of snapshot.files){
      if(!CONFIG_FILES.includes(file.relativePath))throw new WorkbenchError(409,'快照含不支持的配置路径。');
      if(!file.exists)continue;const bytes=Buffer.from(file.bytes,'base64');
      if(digest(bytes)!==file.sha256)throw new WorkbenchError(409,'快照配置备份校验失败。');
      const target=await insideDirectory(root,file.relativePath);await mkdir(dirname(target),{recursive:true});
      await writeFile(target,bytes);
    }
    assertCurrent();this.manager.drawing.runtime.saveSettings(snapshot.runtimeSettings);
  }
}
