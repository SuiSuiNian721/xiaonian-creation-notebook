import {lstat} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkbenchError,fields} from './contracts.mjs';
import {checkedLocalPath} from './drawing-files.mjs';

const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const drawingInstallationDirectory=basename(sourceRoot)==='app'&&basename(dirname(sourceRoot))==='resources'?resolve(sourceRoot,'../..'):sourceRoot;

export function drawingPreferences(store,installationDirectory=drawingInstallationDirectory){
  const saved=store.getSetting('drawing.preferences')||{},defaultOutputPath=join(installationDirectory,'角色绘图');
  return {outputPath:saved.outputPath||defaultOutputPath,customOutputPath:saved.outputPath||'',defaultOutputPath,openBrowser:saved.openBrowser===true};
}

export async function saveDrawingPreferences(store,value,installationDirectory){
  fields(value,['outputPath','openBrowser']);const patch={};
  if(Object.hasOwn(value,'openBrowser')){
    if(typeof value.openBrowser!=='boolean')throw new WorkbenchError(400,'请选择是否打开浏览器前端。');
    patch.openBrowser=value.openBrowser;
  }
  if(Object.hasOwn(value,'outputPath')){
    if(typeof value.outputPath!=='string'||value.outputPath.length>4096)throw new WorkbenchError(400,'请填写有效的输出文件夹路径。');
    patch.outputPath=value.outputPath.trim()?await checkedLocalPath(value.outputPath.trim()):'';
    if(patch.outputPath){
      try{if(!(await lstat(patch.outputPath)).isDirectory())throw new WorkbenchError(400,'输出路径需要是文件夹。');}
      catch(error){if(error.code==='ENOTDIR')throw new WorkbenchError(400,'输出路径的上级需要是文件夹。');if(error.code!=='ENOENT')throw error;}
    }
  }
  // Merge after asynchronous validation so another setting saved meanwhile survives.
  store.setSetting('drawing.preferences',{...store.getSetting('drawing.preferences'),...patch});
  return drawingPreferences(store,installationDirectory);
}

export const drawingJobOutputDirectory=job=>job.outputLayout==='task'?join(job.outputPath,job.id):join(job.outputPath,'AI未来工作台',job.id);
