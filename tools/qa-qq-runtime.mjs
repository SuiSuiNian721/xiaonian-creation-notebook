import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQRuntime, QQ_PACKAGE } from '../framework/qq-runtime.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=resolve(process.env.AI_FUTURE_QQ_QA_DIR||join(root,'qa','qq-runtime-'+Date.now()));
const archive=resolve(process.env.AI_FUTURE_QQ_PACKAGE||join(root,'artifacts/qq-runtime/NapCat.Shell.Windows.Node-v4.18.42.zip'));
await mkdir(directory,{recursive:true});
const runtime=new QQRuntime({dataDir:join(directory,'data'),fetchImpl:async(url,options)=>String(url)===QQ_PACKAGE.url?new Response(Readable.toWeb(createReadStream(archive))):fetch(url,options)});
const report={at:new Date().toISOString(),version:QQ_PACKAGE.version,packageSha256:QQ_PACKAGE.sha256,loginAttempted:false,qrAvailable:false,accountLoggedIn:false,processStopped:false};
try{
  await runtime.install({directory:join(directory,'runtime'),report:()=>{}});
  report.installed=await runtime.verify();
  let state=await runtime.startLogin();report.loginAttempted=true;
  const deadline=Date.now()+20000;
  while(!state.login.qrcodeUrl&&state.login.status!=='online'&&Date.now()<deadline){await new Promise(done=>setTimeout(done,1000));state=await runtime.pollLogin({sessionId:state.login.sessionId});}
  report.status=state.login.status;report.qrAvailable=!!state.login.qrcodeUrl;report.accountLoggedIn=state.login.status==='online';
  assert.equal(report.accountLoggedIn,false,'隔离预登录验证不得恢复任何已有账号');
  assert.equal(report.qrAvailable,true,'应能从实际运行端取得可编码的登录内容');
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  try{await runtime.stop();await runtime.close();report.processStopped=!runtime.state().running;}catch(error){report.stopError=error.message;process.exitCode=1;}
  await writeFile(join(directory,'runtime-result.json'),JSON.stringify(report,null,2)+'\n','utf8');
}
console.log(JSON.stringify({...report,directory},null,2));
