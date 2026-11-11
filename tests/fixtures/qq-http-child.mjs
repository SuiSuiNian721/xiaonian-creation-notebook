import {createServer} from 'node:http';
import {appendFile,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const work=process.env.NAPCAT_WORKDIR;
const web=JSON.parse(await readFile(join(work,'config/webui.json'),'utf8'));
const server=createServer(async(req,res)=>{
  const chunks=[];for await(const bytes of req)chunks.push(bytes);
  const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  await appendFile(join(work,'calls.txt'),req.url+'\n','utf8');
  let data;
  if(req.url==='/api/auth/login')data={Credential:'fixture-credential'};
  else if(req.headers.authorization!=='Bearer fixture-credential'){res.end(JSON.stringify({code:1}));return;}
  else if(req.url.endsWith('CheckLoginStatus'))data={isLogin:true,coreReady:true};
  else if(req.url.endsWith('GetQQLoginInfo'))data={uin:'70001',nick:'隔离测试账号'};
  else if(req.url.endsWith('SetConfig')){await writeFile(join(work,'config/onebot11_70001.json'),value.config,'utf8');data=null;}
  else{res.end(JSON.stringify({code:1}));return;}
  res.end(JSON.stringify({code:0,data}));
});
server.listen(web.port,'127.0.0.1');
