import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

// Only the known imported template is eligible. User-authored variants are never guessed.
const LEGACY_DESCRIPTION_SHA256='65caa5b7b6a7e3648f17a587c739e878f72a407fac65c317b0f924d65b029ac5';
const LEGACY_PERSONALITY=[
  '- 你沉稳细致，愿意认真听，也会记录已经确认的决定与进度。',
  '- 你循序渐进，一次只推进一个模块，不一次塞给用户整张表。',
  '- 你不逼用户填满固定结构或条数，写到够具体、能演即可；全是空泛标签时才追问相关情境。',
  '- 你专业但温和。用户已经说清要写什么时直接继续，有真正影响方向的歧义再确认。',
  '- 你会追问澄清，但不替用户拍板设定；用户是作者，你是助手。',
].join('\n');
const normalize=value=>typeof value==='string'?value.replaceAll('\r\n','\n').trim():'';
const hash=value=>createHash('sha256').update(normalize(value)).digest('hex');
const inside=(root,target)=>{const rel=relative(root,target);return !rel||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};

export async function updateXiaoxiPersona({dataDir,backupDir,apply=false}={}){
  if(typeof dataDir!=='string'||!isAbsolute(dataDir))throw new Error('需要明确的资料目录绝对路径。');
  dataDir=realpathSync(dataDir);
  const description=normalize(readFileSync(new URL('../integrations/xiaoxi/workflow/小汐.md',import.meta.url),'utf8'));
  const personality=description.split('## 性格与思考\n')[1]?.split('\n## ')[0].trim();
  if(!personality)throw new Error('新小汐人设缺少性格正文，未更新资料。');
  const sources=[{scope:'global',file:join(dataDir,'workbench.sqlite')}],instances=join(dataDir,'instances');
  if(existsSync(instances)){
    if(lstatSync(instances).isSymbolicLink())throw new Error('实例目录是链接，未更新资料。');
    for(const entry of readdirSync(instances,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/i.test(entry.name))continue;
      sources.push({scope:entry.name,file:join(instances,entry.name,'workbench.sqlite')});
    }
  }
  const snapshots=[],scopes=[];
  for(const source of sources){
    if(!existsSync(source.file))continue;
    if(lstatSync(source.file).isSymbolicLink())throw new Error('资料库是链接，未更新：'+source.scope);
    const db=new DatabaseSync(source.file,{readOnly:true}),targets=[],skipped=[];
    try{
      for(const row of db.prepare('SELECT * FROM characters WHERE name = ?').all('林小汐')){
        const raw=JSON.parse(row.raw);
        if(hash(row.description)!==LEGACY_DESCRIPTION_SHA256||hash(raw.data?.description)!==LEGACY_DESCRIPTION_SHA256){
          skipped.push({id:row.id,reason:normalize(row.description)===description?'already-current':'customized'});continue;
        }
        const next=structuredClone(raw);next.data.description=description;
        if(normalize(next.data.personality)===LEGACY_PERSONALITY)next.data.personality=personality;
        if(next.data.creator_notes==='从现有小汐人设原文导入，未补写背景、开场或模型。')next.data.creator_notes='已更新为天文学研究员林小汐；保留原有头像、聊天与记忆。';
        targets.push({row,next:JSON.stringify(next)});
      }
    }finally{db.close();}
    scopes.push({scope:source.scope,targets:targets.map(({row})=>row.id),skipped});
    if(targets.length)snapshots.push({...source,targets});
  }
  const report={apply,candidates:snapshots.reduce((count,source)=>count+source.targets.length,0),updated:0,scopes};
  if(!apply||!report.candidates)return report;
  if(typeof backupDir!=='string'||!isAbsolute(backupDir)||inside(dataDir,resolve(backupDir)))throw new Error('应用更新前，需要指定资料目录之外的新备份目录。');
  if(inside(dataDir,realpathSync(resolve(backupDir,'..'))))throw new Error('备份目录不能通过链接指向活动资料内。');
  mkdirSync(backupDir);report.backupDir=realpathSync(backupDir);
  const record=()=>writeFileSync(join(report.backupDir,'update.json'),JSON.stringify(report,null,2)+'\n','utf8');
  // Back up every affected database, including WAL content, before the first update.
  for(const source of snapshots){
    const db=new DatabaseSync(source.file,{readOnly:true});
    try{await backup(db,join(report.backupDir,source.scope+'.sqlite'));}finally{db.close();}
  }
  record();
  for(const source of snapshots){
    const db=new DatabaseSync(source.file);
    try{
      db.exec('BEGIN IMMEDIATE');
      for(const {row,next} of source.targets){
        const result=db.prepare('UPDATE characters SET description=?,raw=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND description=? AND raw=?')
          .run(description,next,new Date().toISOString(),row.id,row.revision,row.description,row.raw);
        if(result.changes!==1)throw new Error('检查后角色资料已发生变化，已停止更新：'+source.scope+'/'+row.id);
      }
      db.exec('COMMIT');report.updated+=source.targets.length;record();
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');report.error=error.message;record();throw error;}
    finally{db.close();}
  }
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{'data-dir':{type:'string'},'backup-dir':{type:'string'},apply:{type:'boolean',default:false}}});
  console.log(JSON.stringify(await updateXiaoxiPersona({dataDir:values['data-dir'],backupDir:values['backup-dir'],apply:values.apply}),null,2));
}
