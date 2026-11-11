import {lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,parse,resolve,sep} from 'node:path';
import {WorkbenchError,fields,knownModule,text,identifier} from './contracts.mjs';
import {trainingPathKind} from '../public-workbench/path-kinds.js';
import {readableLocalPath} from './resource-local-path.mjs';

const voicePaths={referencePath:['参考录音','file'],pythonPath:['MOSS Python','file'],generatorPath:['生成模型','directory'],clonePath:['克隆模型','directory'],codecPath:['音频编解码器','directory'],qwenPythonPath:['Qwen Python','file'],qwenSourcePath:['Qwen 源码','directory'],qwenBasePath:['Qwen Base 模型','directory'],qwenCustomVoicePath:['Qwen CustomVoice 模型','directory'],qwenDesignPath:['Qwen VoiceDesign 模型','directory']};

function localPath(value){
  const path=text(value,'路径',4096);
  if(!isAbsolute(path)||/^[\\/]{2}/.test(path)||process.platform==='win32'&&(!/^[A-Za-z]:[\\/]/.test(path)||path.slice(2).includes(':')))throw new WorkbenchError(400,'请选择普通本地磁盘的绝对路径。');
  return resolve(path);
}
export class PathPicker{
  constructor({store,choosePath,chooseDirectory,trainingForm}){this.store=store;this.open=choosePath;this.openDirectory=chooseDirectory;this.trainingForm=trainingForm;this.busy=false;this.closed=false;}
  active(id){
    if(this.closed)throw new WorkbenchError(503,'工作台正在关闭。');
    const scope=this.store.getSetting('instance.identity')?.moduleId;
    if(scope&&scope!==id&&!(scope==='comfyui'&&id==='drawing'))throw new WorkbenchError(409,'这个路径不属于当前模块实例。');
    if(!this.store.module(id).enabled)throw new WorkbenchError(409,'模块已停用。');
  }
  async choose(value){
    fields(value,['moduleId','target','field','trainingType','kind','currentPath']);
    const module=knownModule(value.moduleId);identifier(value.field,'路径字段');this.active(module.id);
    if(!['file','directory'].includes(value.kind)||!['module','training','pipeline','drawing-output'].includes(value.target))throw new WorkbenchError(400,'请选择文件或文件夹。');
    let field,kind;
    if(value.target==='module'){
      field=module.settings.find(field=>field.key===value.field&&field.type==='path');kind=field?.pathKind;
      if(!field&&['voice','voice-design'].includes(module.id)&&Object.hasOwn(voicePaths,value.field)){
        const [label,pathKind]=voicePaths[value.field];field={key:value.field,label};kind=pathKind;
      }
    }
    else if(module.id==='drawing'&&value.target==='drawing-output'&&value.field==='outputPath'){field={key:value.field,label:'角色绘图输出文件夹'};kind='directory';}
    else if(module.id==='training'&&value.target==='training'){
      identifier(value.trainingType,'训练类型');const form=await this.trainingForm(value.trainingType);
      field=form.sections.flatMap(section=>section.fields).find(field=>field.key===value.field&&[value.kind,'model','either'].includes(trainingPathKind(field,value.trainingType)));kind=trainingPathKind(field,value.trainingType);
    }else if(module.id==='training'&&value.target==='pipeline'&&['sourcePath','detectorPath','captionModelPath'].includes(value.field)){field={key:value.field,label:{sourcePath:'训练图集',detectorPath:'裁切模型目录',captionModelPath:'描述模型目录'}[value.field]};kind='directory';}
    if(!field||!kind||!['model','either'].includes(kind)&&kind!==value.kind)throw new WorkbenchError(400,'这个字段不支持所选路径类型。');
    let defaultPath=homedir();
    if(value.currentPath!==undefined&&text(value.currentPath,'当前路径',4096,{empty:true})){
      if(/^[\\/]{2}/.test(value.currentPath))throw new WorkbenchError(400,'请使用普通本地磁盘路径。');
      if(isAbsolute(value.currentPath))defaultPath=localPath(value.currentPath);
    }
    if(this.busy)throw new WorkbenchError(409,'已有路径选择窗口，请先完成选择。');
    const chooser=this.open||(value.kind==='directory'?this.openDirectory:null);
    if(typeof chooser!=='function')throw new WorkbenchError(409,'请在桌面工作台选择路径，或直接填写本地路径。');
    this.active(module.id);this.busy=true;
    try{
      const selected=await chooser({moduleId:module.id,kind:value.kind,title:'选择'+(field.label||field.description?.split(/[。\n]/)[0]||value.field),purpose:'path',defaultPath,allowCreate:value.kind==='directory'&&['outputPath','workspacePath','output_dir','logging_dir'].includes(value.field),...(kind==='file'||kind==='model'?{filters:[{name:'所有文件',extensions:['*']}]}:{})});
      this.active(module.id);if(!selected)return {path:null,cancelled:true};
      if(value.target==='module'&&['voice','voice-design'].includes(module.id)){
        const path=await readableLocalPath(localPath(selected)),info=await lstat(path);
        if(value.kind==='directory'?!info.isDirectory():!info.isFile())throw new WorkbenchError(400,'所选项目与文件／文件夹类型不符。');
        return {path,cancelled:false};
      }
      const path=localPath(selected);let cursor=parse(path).root;
      for(const part of path.slice(cursor.length).split(sep).filter(Boolean)){cursor=resolve(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw new WorkbenchError(400,'路径不能使用符号链接或目录联接。');}
      const info=await lstat(path);if(value.kind==='directory'?!info.isDirectory():!info.isFile())throw new WorkbenchError(400,'所选项目与文件／文件夹类型不符。');
      return {path,cancelled:false};
    }finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
