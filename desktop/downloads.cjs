const {dirname,extname,isAbsolute,join}=require('node:path');

const instancePrefix=/^\/instances\/[a-f0-9-]{36}(?=\/)/i;
function localURL(value,base){
  try{const url=new URL(value);return url.origin===base.origin&&!url.username&&!url.password?url:null;}catch{return null;}
}
function isWorkbenchExport(baseURL,sourceURL,downloadURL){
  let base;try{base=new URL(baseURL);}catch{return false;}
  if(!['http:','https:'].includes(base.protocol))return false;
  const source=localURL(sourceURL,base),download=localURL(downloadURL,base);
  if(!source||!download)return false;
  const page=source.pathname.replace(instancePrefix,'');
  if(!/^(?:\/|\/index\.html|\/process-log\.html|\/card-studio\/?(?:index\.html)?)$/.test(page))return false;
  if(download.protocol==='blob:')return true;
  if(download.protocol!==base.protocol)return false;
  const path=download.pathname.replace(instancePrefix,'');
  return /^\/api\/modules\/drawing\/(?:images|results)\/[A-Za-z0-9-]+$/.test(path)
    ||/^\/api\/modules\/mc-skin\/files\/[A-Za-z0-9-]+\/[A-Za-z0-9.-]+$/.test(path)
    ||/^\/api\/characters\/[A-Za-z0-9-]+\/resources\/[A-Za-z0-9-]+\/file$/.test(path)
    ||/^\/api\/modules\/[A-Za-z0-9-]+\/package$/.test(path)
    ||/^\/card-studio\/api\/artifact-file\/[^/]+$/.test(path)
    ||/^\/internal\/voice-audio\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(path)
    ||/^\/api\/voice\/voices\/voice-[a-f0-9-]{36}\/audio$/.test(path);
}

function installWorkbenchDownloads({session,getBaseURL,getDownloadsPath}){
  let lastDirectory='';
  const onDownload=(_event,item,contents)=>{
    if(!contents||contents.isDestroyed())return;
    const base=getBaseURL(),source=contents.getURL(),url=item.getURL();
    if(!isWorkbenchExport(base,source,url)||(item.getURLChain?.()||[url]).some(value=>!isWorkbenchExport(base,source,value)))return;
    const name=(item.getFilename()||'工作台导出').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,180).replace(/[. ]+$/,'')||'工作台导出';
    const extension=extname(name).slice(1).toLowerCase(),audio=/^(wav|mp3|ogg|flac)$/.test(extension),picture=/^(png|jpg|jpeg|webp|gif|bmp)$/.test(extension);
    item.setSaveDialogOptions({title:audio?'另存音频':picture?'另存图片':extension==='log'?'导出日志':'导出文件',buttonLabel:'保存',defaultPath:join(lastDirectory||getDownloadsPath(),name),
      ...(/^[a-z0-9]{1,12}$/.test(extension)?{filters:[{name:extension.toUpperCase()+' 文件',extensions:[extension]},{name:'所有文件',extensions:['*']}]}:{})});
    // Electron owns the save dialog, overwrite confirmation and cancellation.
    // Only a completed download changes the next dialog's default directory.
    item.once('done',(_event,state)=>{const path=state==='completed'?item.getSavePath():'';if(path&&isAbsolute(path))lastDirectory=dirname(path);});
  };
  session.on('will-download',onDownload);
  return ()=>session.removeListener('will-download',onDownload);
}
module.exports={installWorkbenchDownloads};
