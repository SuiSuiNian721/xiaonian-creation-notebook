import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,relative,sep} from 'node:path';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {WorkbenchError} from './contracts.mjs';
import {trainingPath} from './training-runtime.mjs';

const marker='.workbench-training-output.json';
async function checkParents(path){
  let current=path;
  while(true){
    try{
      const info=await lstat(current);
      if(info.isSymbolicLink()||!info.isDirectory())throw new WorkbenchError(400,'输出目录必须位于实际本地文件夹，不能经过链接或已有文件。');
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
}

export async function workflowOutputDirectory({root,owner,id,sourcePath}){
  if(!root)return null;
  const base=trainingPath(root,'训练输出目录');
  if(process.platform==='win32'&&base.slice(2).includes(':'))throw new WorkbenchError(400,'训练输出不支持设备或数据流路径。');
  const suffix=createHash('sha256').update(owner).digest('hex').slice(0,12);
  const destination=join(base,`lora-${id}-${suffix}`),fromSource=relative(sourcePath,destination);
  if(fromSource===''||(!isAbsolute(fromSource)&&fromSource!=='..'&&!fromSource.startsWith('..'+sep)))throw new WorkbenchError(400,'请在原始训练图集之外选择输出目录，避免修改原图集。');
  await checkParents(destination);return destination;
}

export async function prepareWorkflowOutput({directory,owner,id}){
  await checkParents(directory);
  await mkdir(dirname(directory),{recursive:true});
  const identity={format:1,owner,workflowId:id};
  try{
    await mkdir(directory);
    await writeFile(join(directory,marker),JSON.stringify(identity)+'\n',{encoding:'utf8',flag:'wx'});
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    try{
      const file=join(directory,marker),info=await lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw new Error('marker');
      const saved=JSON.parse(await readFile(file,'utf8'));
      if(saved.format!==1||saved.owner!==owner||saved.workflowId!==id)throw new Error('owner');
    }catch{throw new WorkbenchError(409,'输出文件夹已有内容或归属不匹配；请保留已有文件，选择其他位置新建流程。');}
  }
}
