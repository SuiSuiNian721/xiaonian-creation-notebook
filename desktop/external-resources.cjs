const {parseLogTarget}=require('./process-log-window.cjs');

function handleResourceWindowOpen({url},{baseURL,openExternal,openLog,onError=()=>{}}){
  const log=parseLogTarget(baseURL,url);
  if(log){openLog(log);return {action:'deny'};}
  try{
    const target=new URL(url);
    if(target.protocol==='https:'&&!target.username&&!target.password){
      Promise.resolve().then(()=>openExternal(target.href)).catch(onError);
    }
  }catch{ /* Invalid and non-web links stay inside the denied popup request. */ }
  return {action:'deny'};
}

function isWorkbenchClipboardWrite(baseURL,target,permission){
  if(permission!=='clipboard-sanitized-write')return false;
  try{const url=new URL(target);return url.origin===new URL(baseURL).origin&&!url.username&&!url.password;}
  catch{return false;}
}

module.exports={handleResourceWindowOpen,isWorkbenchClipboardWrite};
