import { fields } from './contracts.mjs';

// 返回 true 表示已处理；调用者继续使用原服务器的异常和鉴权处理。
export async function handleDrawingCompletionHttp({req,res,pathname,readBody,json,completion}) {
  const prefix='/api/modules/drawing/completion';if(pathname!==prefix&&!pathname.startsWith(prefix+'/'))return false;
  const tail=pathname.slice(prefix.length).split('/').filter(Boolean);
  let result;
  if(req.method==='GET'&&tail.length===0)result={reports:completion.list()};
  else if(req.method==='GET'&&tail.length===1)result=completion.get(tail[0]);
  else if(req.method==='POST') {
    const value=await readBody(req);
    if(!tail.length)result=await completion.start(value);
    else if(tail.length===2&&tail[1]==='search')result=await completion.search(tail[0],value);
    else if(tail.length===2&&tail[1]==='cancel'){fields(value,[]);result=await completion.cancel(tail[0]);}
    else if(tail.length===2&&tail[1]==='downloads')result=await completion.download(tail[0],value);
    else if(tail.length===2&&tail[1]==='node-plan')result=await completion.planNode(tail[0],value);
    else if(tail.length===2&&tail[1]==='copy')result=await completion.copy(tail[0],value);
    else return false;
  } else return false;
  json(res,200,result);return true;
}
