import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorkbenchError, fields } from './contracts.mjs';
import { QQProcessHost } from './qq-process.mjs';
import {acquireResourceStorageLease,beginManagedRoot,recordManagedTree} from './resource-storage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const QQ_PACKAGE = Object.freeze({
  version:'4.18.42', downloadBytes:124162399,
  url:'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip',
  sha256:'77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed',
});
export const qqResourceCatalog = Object.freeze({revision:'napcat-windows-node-4.18.42-v1',resources:Object.freeze([Object.freeze({
  id:'qq-napcat',name:'NapCat Windows 独立运行端',version:QQ_PACKAGE.version,status:'available',required:true,adapterId:'qq-napcat',
  sourceLabel:'NapNeko / NapCatQQ（限非商业用途）',downloadBytes:QQ_PACKAGE.downloadBytes,installedBytes:361715623,
})])});
const criticalFiles=['node.exe','index.js','wrapper.node','QQNT.dll','napcat/napcat.mjs'];
const manifestName='workbench-qq-runtime.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(message,status=409)=>new WorkbenchError(status,message);
const account=value=>typeof value==='string'&&/^\d{1,20}$/.test(value);

function safeDirectory(value) {
  if(typeof value!=='string'||!isAbsolute(value)||!/^([A-Za-z]:[\\/]|\/)/.test(value)||value.startsWith('\\\\'))throw fail('请选择普通本地磁盘上的绝对路径。',400);
  const absolute=resolve(value);
  if(absolute.startsWith('\\\\')||(process.platform==='win32'&&!/^[A-Za-z]:[\\/]/.test(absolute)))throw fail('QQ 运行目录只支持普通本地磁盘路径。',400);
  const base=parse(absolute).root;
  let current=base;
  for(const part of relative(base,absolute).split(sep).filter(Boolean)) {
    current=join(current,part);
    if(existsSync(current)&&(!lstatSync(current).isDirectory()||lstatSync(current).isSymbolicLink()))throw fail('QQ 运行目录不能包含文件、符号链接或目录联接。',400);
  }
  return absolute;
}
function saveJson(file,value) {
  if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw fail('QQ 配置不能使用链接。');
  const temporary=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temporary,file);
}
async function freePort() {
  const server=createServer();await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  const port=server.address().port;await new Promise(done=>server.close(done));return port;
}
export class QQRuntime {
  constructor({dataDir,storageDataDir=dataDir,fetchImpl=fetch,spawnImpl=spawn,processHost,extractImpl,allocatePort=freePort,packageSpec=QQ_PACKAGE,startupTimeoutMs=30000,onEvent=()=>{},coordination}) {
    this.dataDir=resolve(dataDir);this.storageDataDir=resolve(storageDataDir);this.root=safeDirectory(join(this.dataDir,'qq'));mkdirSync(this.root,{recursive:true});
    this.file=join(this.root,'runtime.json');this.fetch=fetchImpl;this.spawn=spawnImpl;this.extract=extractImpl;this.allocatePort=allocatePort;this.package=packageSpec;
    if(coordination)this.allocatePort=()=>coordination.allocatePort(allocatePort);
    this.timeout=startupTimeoutMs;this.onEvent=onEvent;this.child=null;this.closed=false;this.credential='';this.starting=null;this.installing=null;this.generation=0;this.stopPromise=null;
    this.abort=new AbortController();this.login={sessionId:null,status:'logged_out',accountId:null,nickname:'',qrcodeUrl:null,error:null};
    this.installation={status:'missing',version:packageSpec.version,installDirectory:'',progress:0,error:null};
    this.config=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{schemaVersion:1,mode:'managed',slotId:randomUUID(),installDirectory:'',accountId:'',wsUrl:'',externalToken:'',webToken:randomBytes(32).toString('hex'),onebotToken:randomBytes(32).toString('hex')};
    if(this.config.schemaVersion!==1||!account(this.config.accountId||'0')||!/^[a-f0-9-]{36}$/i.test(this.config.slotId)||!['managed','external'].includes(this.config.mode))throw fail('QQ 运行配置版本或内容无效，原配置已保留。');
    if(!existsSync(this.file))saveJson(this.file,this.config);
    this.slot=safeDirectory(join(this.root,'accounts',this.config.slotId));mkdirSync(this.slot,{recursive:true});
    this.processHost=processHost||new QQProcessHost({slot:this.slot,spawnImpl});
    this.inspect();
    this.ready=this.restore().catch(error=>{this.recoveryError=error;this.login.error=error instanceof WorkbenchError?error.message:'QQ 后台暂时无法恢复，请稍后重试。';});
  }
  async restore(){
    if(this.config.mode!=='managed')return;
    const state=await this.processHost.recover();if(this.closed||!state)return;
    this.child=state;this.webPort=state.webPort;this.onebotPort=state.onebotPort;
    this.login={sessionId:randomUUID(),status:'starting',accountId:null,nickname:'',qrcodeUrl:null,error:null};
    await this.authenticate();if(!this.closed)await this.pollLogin({sessionId:this.login.sessionId});
  }
  async sync(){
    await this.ready;if(this.closed||this.config.mode!=='managed')return;
    if(this.syncing)return this.syncing;
    this.syncing=(async()=>{
      if(this.recoveryError){try{await this.restore();this.recoveryError=null;}catch(error){this.recoveryError=error;this.login.error=error instanceof WorkbenchError?error.message:'QQ 后台暂时无法恢复。';}return;}
      if(!this.child)return;
      const state=await this.processHost.recover();
      if(!state){this.child=null;this.runtimeLease?.();this.runtimeLease=null;this.credential='';this.login={...this.login,sessionId:null,status:'offline',qrcodeUrl:null,error:'QQ 后台已退出，资料仍保留。'};return;}
      await this.pollLogin({sessionId:this.login.sessionId});
    })();
    try{return await this.syncing;}finally{this.syncing=null;}
  }
  inspect() {
    if(this.config.installDirectory) {
      const target=safeDirectory(this.config.installDirectory);this.installation.installDirectory=target;
      if(!this.installing) this.installation.status=existsSync(join(target,manifestName))?'ready':'missing';
    }
  }
  adoptSharedInstallation(directory){
    if(this.config.installDirectory||this.child||this.starting||this.installing||!existsSync(join(directory,manifestName)))return;
    this.config.installDirectory=safeDirectory(directory);saveJson(this.file,this.config);this.inspect();
  }
  state({includeQr=false}={}) {
    return {mode:this.config.mode,running:!!this.child,installation:{...this.installation},
      login:{...this.login,...(!includeQr?{qrcodeUrl:null}:{})},external:{wsUrl:this.config.wsUrl,accountId:this.config.accountId,hasToken:!!this.config.externalToken}};
  }
  async configure(value,{beforeChange}={}) {
    await this.ready;await this.syncing;
    fields(value,['mode','installDirectory','wsUrl','token','accountId','clearToken']);
    if(this.closed)throw fail('QQ 运行端正在关闭。');
    if(this.starting||this.installing||this.stopPromise)throw fail('QQ 正在切换状态，请稍后修改运行配置。');
    const generation=this.generation,original=JSON.stringify(this.config);
    const next={...this.config};
    if(value.mode!==undefined){if(!['managed','external'].includes(value.mode))throw fail('请选择受管运行端或已有正向网关。',400);next.mode=value.mode;}
    if(value.installDirectory!==undefined)next.installDirectory=safeDirectory(value.installDirectory);
    if(value.accountId!==undefined){if(value.accountId!==''&&!account(value.accountId))throw fail('QQ 账号应为数字标识。',400);next.accountId=value.accountId;}
    if(value.wsUrl!==undefined) {
      let address;try{address=new URL(value.wsUrl);}catch{throw fail('请输入有效的正向 WebSocket 地址。',400);}
      if(!['ws:','wss:'].includes(address.protocol)||address.username||address.password||address.hash)throw fail('已有网关需要 WS / WSS 正向地址。',400);
      const tokens=address.searchParams.getAll('access_token');if(tokens.length>1)throw fail('网关地址中存在重复访问令牌，请使用单独的令牌输入框。',400);
      const token=tokens[0];if(token?.length>4096)throw fail('访问令牌过长。',400);
      if(token)next.externalToken=token;address.searchParams.delete('access_token');
      if(address.search)throw fail('请将令牌填写在单独的输入框，网关地址不支持其他查询参数。',400);
      next.wsUrl=address.href;
    }
    if(value.token!==undefined){if(typeof value.token!=='string'||value.token.length>4096)throw fail('访问令牌格式无效。',400);if(value.token)next.externalToken=value.token;}
    if(value.clearToken===true)next.externalToken='';
    if(next.mode==='external'&&(!next.wsUrl||!account(next.accountId)))throw fail('已有网关需要地址和预期机器人 QQ 号。',400);
    if(value.installDirectory!==undefined){
      await this.verify(next.installDirectory);
      if(this.closed||generation!==this.generation||original!==JSON.stringify(this.config)||this.starting||this.installing||this.stopPromise)throw fail('QQ 运行状态或配置已变化，请重新选择组件。');
    }
    if(JSON.stringify(next)===JSON.stringify(this.config))return this.state();
    if((this.child||this.recoveryError)&&!beforeChange)throw fail('请先停止 QQ，再修改运行配置。');
    if(beforeChange)await beforeChange();
    if(original!==JSON.stringify(this.config))throw fail('QQ 配置已经变化，请核对后重新保存。');
    if(this.closed||this.child||this.recoveryError||this.starting||this.installing||this.stopPromise)throw fail('QQ 尚未停止，运行配置未修改。');
    ++this.generation;
    saveJson(this.file,next);this.config=next;this.inspect();return this.state();
  }
  async verify(directory=this.config.installDirectory) {
    const target=safeDirectory(directory);let manifest;
    try{manifest=JSON.parse(await readFile(join(target,manifestName),'utf8'));}catch(error){throw fail(error instanceof SyntaxError?'NapCat QQ 运行端的校验清单 '+manifestName+' 不是有效 JSON，请重新安装固定版本组件。':'未找到可读取的 NapCat QQ 工作台校验清单 '+manifestName+'，请先安装固定版本组件。');}
    if(manifest?.version!==this.package.version||manifest?.packageSha256!==this.package.sha256)throw fail('NapCat QQ 运行端校验清单不匹配，需要工作台固定版本 '+this.package.version+'。');
    for(const file of criticalFiles){
      const path=join(target,file);safeDirectory(dirname(path));
      if(!existsSync(path))throw fail('NapCat QQ 运行端缺少文件 '+file+'，请重新安装固定版本组件。');
      const entry=lstatSync(path);if(entry.isSymbolicLink()||!entry.isFile())throw fail('NapCat QQ 运行文件 '+file+' 不是普通本地文件，请重新安装固定版本组件。');
      let bytes;try{bytes=await readFile(path);}catch{throw fail('无法读取 NapCat QQ 运行文件 '+file+'，请检查访问权限。');}
      if(hash(bytes)!==manifest.files?.[file])throw fail('NapCat QQ 运行文件 '+file+' 校验失败，文件可能已经修改。');
    }
    return true;
  }
  async install({directory,signal,report=()=>{}}) {
    await this.ready;
    if(this.closed||this.child||this.recoveryError||this.starting)throw fail('QQ 正在运行或工作台正在关闭，暂不能安装。');
    if(this.installing)return this.installing;
    const base=safeDirectory(directory),target=join(base,'NapCat-'+this.package.version);
    const run=async()=>{
      const cancelled=AbortSignal.any([this.abort.signal,...(signal?[signal]:[])]);cancelled.throwIfAborted();
      mkdirSync(base,{recursive:true});
      if(existsSync(target)){await this.verify(target);cancelled.throwIfAborted();this.config.installDirectory=target;saveJson(this.file,this.config);this.installation={status:'ready',version:this.package.version,installDirectory:target,progress:1,error:null};return;}
      const id=randomUUID(),archive=join(base,'.workbench-qq-'+id+'.zip'),staging=join(base,'.workbench-qq-'+id);
      this.installation={status:'downloading',version:this.package.version,installDirectory:target,progress:0,error:null};
      try{
        const response=await this.fetch(this.package.url,{signal:cancelled,redirect:'follow'});
        if(!response.ok||!response.body)throw fail('无法下载 QQ 运行包，请检查网络后重试。',502);
        const digest=createHash('sha256');let size=0;
        const meter=new Transform({transform:(chunk,_encoding,done)=>{
          size+=chunk.length;if(size>256*1024*1024){done(fail('QQ 运行包超过预期大小。',502));return;}
          digest.update(chunk);this.installation.progress=Math.min(size/this.package.downloadBytes,0.99);
          report({stage:'下载 QQ 独立运行端',completedBytes:size,totalBytes:this.package.downloadBytes});done(null,chunk);
        }});
        await pipeline(response.body,meter,createWriteStream(archive,{flags:'wx'}),{signal:cancelled});
        if(digest.digest('hex')!==this.package.sha256)throw fail('QQ 安装包 SHA256 校验失败，未发布安装内容。',502);
        this.installation.status='extracting';report({stage:'校验完成，正在解压',completedBytes:size,totalBytes:size});
        await mkdir(staging);const ownership=await beginManagedRoot({dataDir:this.storageDataDir,root:staging});
        if(this.extract)await this.extract(archive,staging,cancelled);
        else await this.runExtractor(archive,staging,cancelled);
        cancelled.throwIfAborted();const files={};
        for(const file of criticalFiles){const path=join(staging,file);safeDirectory(dirname(path));if(lstatSync(path).isSymbolicLink())throw fail('QQ 安装包包含不支持的链接。');files[file]=hash(await readFile(path));}
        await writeFile(join(staging,manifestName),JSON.stringify({schemaVersion:1,version:this.package.version,packageSha256:this.package.sha256,files},null,2)+'\n',{encoding:'utf8'});
        await this.verify(staging);cancelled.throwIfAborted();await rename(staging,target);
        await recordManagedTree({dataDir:this.storageDataDir,ownership:{...ownership,root:target},id:'qq-runtime-'+hash(target),name:'NapCat '+this.package.version,family:'qq'});
        cancelled.throwIfAborted();this.config.installDirectory=target;saveJson(this.file,this.config);
        this.installation={status:'ready',version:this.package.version,installDirectory:target,progress:1,error:null};
        this.onEvent({kind:'qq.runtime.installed',message:'QQ 独立运行端已安装并通过校验。'});
      }catch(error){this.installation.status='error';this.installation.error=cancelled.aborted?'QQ 安装已中断。':error instanceof WorkbenchError?error.message:'QQ 安装失败，请检查安装位置和网络。';throw fail(this.installation.error,502);}
      finally{
        // 只清理本次创建的随机暂存目标，且必须位于用户选择的安装目录。
        for(const path of [archive,staging]){const child=relative(base,resolve(path));if(child&&child!=='..'&&!child.startsWith('..'+sep)&&!isAbsolute(child))await rm(path,{recursive:true,force:true}).catch(()=>{});}
      }
    };
    const release=acquireResourceStorageLease(this.storageDataDir,'qq');this.installing=run();try{return await this.installing;}finally{this.installing=null;release();}
  }
  async runExtractor(archive,destination,signal) {
    await new Promise((done,reject)=>{
      const child=spawn('pwsh',['-NoProfile','-NonInteractive','-File',join(root,'tools/qq-extract.ps1'),'-Archive',archive,'-Destination',destination],{windowsHide:true,stdio:['ignore','ignore','pipe']});
      let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});
      const abort=()=>child.kill();signal.addEventListener('abort',abort,{once:true});
      child.once('error',()=>reject(fail('无法启动 PowerShell 7 解压 QQ 安装包。',503)));
      child.once('close',code=>{signal.removeEventListener('abort',abort);code===0?done():reject(fail('QQ 安装包解压失败，未发布安装内容。',502));});
      if(signal.aborted)abort();
    });
  }
  async startLogin() {
    await this.ready;
    if(this.closed)throw fail('QQ 运行端正在关闭。');
    if(this.stopPromise)throw fail('QQ 正在停止，请稍后重新扫码。');
    if(this.installing)throw fail('QQ 组件正在安装，请等待安装完成。');
    if(this.config.mode!=='managed')throw fail('已有网关请在其管理界面扫码，再连接正向 WebSocket。');
    if(this.starting)return this.starting;
    if(this.recoveryError||this.syncing){await this.sync();if(this.recoveryError)throw this.recoveryError;}
    if(this.child&&this.login.sessionId){await this.authenticate();return this.pollLogin({sessionId:this.login.sessionId});}
    const generation=++this.generation;
    // Launch holds the lease until the persistent daemon process record takes over.
    this.runtimeLease ||= acquireResourceStorageLease(this.storageDataDir,'qq');this.starting=this.launch(generation);try{return await this.starting;}finally{this.starting=null;this.runtimeLease?.();this.runtimeLease=null;}
  }
  async launch(generation) {
    const current=()=>{if(generation!==this.generation||this.closed)throw fail('QQ 登录已取消或工作台已关闭。');};
    await this.verify();current();
    const dataPath=safeDirectory(join(this.slot,'qqdata')),workPath=safeDirectory(join(this.slot,'napcat'));
    await mkdir(dataPath,{recursive:true});await mkdir(join(workPath,'config'),{recursive:true});
    this.webPort=await this.allocatePort();this.onebotPort=await this.allocatePort();
    current();
    await writeFile(join(workPath,'config/webui.json'),JSON.stringify({host:'127.0.0.1',port:this.webPort,token:this.config.webToken,loginRate:30,autoLoginAccount:''}),{encoding:'utf8',mode:0o600});
    // 每次扫码前关闭上次保存的 OneBot 服务，身份核对后再明确打开。
    const disabled={network:{httpServers:[],httpClients:[],httpSseServers:[],websocketServers:[],websocketClients:[],plugins:[]}};
    await writeFile(join(workPath,'config/onebot11.json'),JSON.stringify(disabled),{encoding:'utf8',mode:0o600});
    if(this.config.accountId)await writeFile(join(workPath,'config/onebot11_'+this.config.accountId+'.json'),JSON.stringify(disabled),{encoding:'utf8',mode:0o600});
    current();
    const env={};for(const key of ['PATH','SystemRoot','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
    Object.assign(env,{NAPCAT_QQ_DATA_DIR:dataPath,NAPCAT_WORKDIR:workPath});
    this.login={sessionId:randomUUID(),status:'starting',accountId:null,nickname:'',qrcodeUrl:null,error:null};
    try{this.child=await this.processHost.start({command:join(this.config.installDirectory,'node.exe'),args:[join(this.config.installDirectory,'index.js')],options:{cwd:this.config.installDirectory,env,windowsHide:true,stdio:'ignore'},webPort:this.webPort,onebotPort:this.onebotPort});}
    catch(error){throw error instanceof WorkbenchError?error:fail('无法启动 QQ 独立运行端，请检查组件。',503);}
    this.credential='';current();
    const deadline=Date.now()+this.timeout;
    while(Date.now()<deadline){
      if(generation!==this.generation||this.closed)throw fail('QQ 登录已取消。');
      if(!this.child||this.login.status==='error')throw fail(this.login.error||'QQ 运行端已退出，请检查组件。',503);
      try{await this.authenticate();return await this.pollLogin({sessionId:this.login.sessionId});}catch(error){if(generation!==this.generation)throw fail('QQ 登录已取消。');}
      await new Promise(done=>setTimeout(done,250));
    }
    throw fail('QQ 管理端暂未就绪，已保留后台进程，请稍后重接或停止 QQ。',503);
  }
  async request(path,value={},authenticated=true) {
    const response=await this.fetch('http://127.0.0.1:'+this.webPort+'/api/'+path,{method:'POST',redirect:'error',
      signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)]),headers:{'content-type':'application/json',...(authenticated?{authorization:'Bearer '+this.credential}:{})},body:JSON.stringify(value)});
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>1024*1024)throw fail('QQ 管理接口返回内容过大。',502);
    let result;try{result=JSON.parse(bytes);}catch{throw fail('QQ 管理接口未返回有效数据。',502);}
    if(!response.ok||result.code!==0)throw fail('QQ 管理接口暂不可用，请重新登录或稍后重试。',502);
    return result.data;
  }
  async authenticate() {
    const data=await this.request('auth/login',{hash:hash(this.config.webToken+'.napcat')},false);
    if(typeof data?.Credential!=='string'||!data.Credential)throw fail('QQ 管理端认证失败。',502);this.credential=data.Credential;
  }
  current(sessionId) {
    if(this.closed||!this.child||!sessionId||sessionId!==this.login.sessionId)throw fail('QQ 登录会话已失效，请重新连接登录端。');
  }
  async pollLogin({sessionId}={}) {
    this.current(sessionId);const generation=this.generation;
    let status;try{status=await this.request('QQLogin/CheckLoginStatus');}catch{await this.authenticate();status=await this.request('QQLogin/CheckLoginStatus');}
    this.current(sessionId);if(generation!==this.generation)throw fail('QQ 登录会话已失效。');
    if(status?.isLogin===true&&status.coreReady!==false) {
      const info=await this.request('QQLogin/GetQQLoginInfo');this.current(sessionId);
      const id=String(info?.uin??info?.user_id??'');
      if(!account(id))throw fail('QQ 没有返回有效的登录账号。',502);
      if(this.config.accountId&&this.config.accountId!==id){this.login.status='identity_mismatch';this.login.error='实际 QQ 账号与已绑定账号不一致，请断开后重新配置。';throw fail(this.login.error);}
      if(this.login.status!=='online') {
        const config={network:{httpServers:[],httpSseServers:[],httpClients:[],websocketClients:[],plugins:[],websocketServers:[{name:'AI-Future-Workbench',enable:true,host:'127.0.0.1',port:this.onebotPort,messagePostFormat:'array',reportSelfMessage:false,token:this.config.onebotToken,enableForcePushEvent:true,debug:false,heartInterval:15000}]}};
        let saved;try{saved=JSON.parse(readFileSync(join(this.slot,'napcat/config/onebot11_'+id+'.json'),'utf8'));}catch{}
        const existing=saved?.network?.websocketServers?.find(server=>server.name==='AI-Future-Workbench');
        if(!existing?.enable||existing.host!=='127.0.0.1'||existing.port!==this.onebotPort||existing.token!==this.config.onebotToken)await this.request('OB11Config/SetConfig',{config:JSON.stringify(config)});
        this.current(sessionId);
      }
      if(this.config.accountId!==id){this.config.accountId=id;saveJson(this.file,this.config);}
      this.login={sessionId,status:'online',accountId:id,nickname:String(info.nick??info.nickname??''),qrcodeUrl:null,error:null};
    }else{
      let qr=status?.qrcodeurl;
      if(!qr){try{qr=(await this.request('QQLogin/GetQQLoginQrcode'))?.qrcode;}catch{}}
      this.current(sessionId);
      this.login.status=status?.isOffline?'offline':status?.qrLoginAccepted?'confirming':'waiting_qrcode';
      this.login.qrcodeUrl=typeof qr==='string'&&qr.length<8192?qr:null;
      this.login.error=status?.loginError?'QQ 需要在手机端确认或重新验证，请查看手机 QQ。':null;
    }
    return this.state({includeQr:true});
  }
  async refreshLogin({sessionId}={}) {
    this.current(sessionId);if(this.login.status==='online')throw fail('QQ 已在线，无需刷新二维码。');
    const data=await this.request('QQLogin/RefreshQRcode');this.current(sessionId);
    this.login={...this.login,sessionId:randomUUID(),status:'waiting_qrcode',qrcodeUrl:typeof data?.qrcodeurl==='string'?data.qrcodeurl:null,error:null};
    return this.state({includeQr:true});
  }
  async cancelLogin({sessionId}={}){this.current(sessionId);await this.stop();return this.state();}
  connection() {
    if(this.config.mode==='external') {
      if(!this.config.wsUrl||!account(this.config.accountId))throw fail('请先填写网关地址和机器人 QQ 号。');
      return {wsUrl:this.config.wsUrl,token:this.config.externalToken,expectedAccountId:this.config.accountId};
    }
    if(!this.child||this.login.status!=='online')throw fail('QQ 尚未登录在线，或登录账号不一致。');
    return {wsUrl:'ws://127.0.0.1:'+this.onebotPort,token:this.config.onebotToken,expectedAccountId:this.login.accountId};
  }
  async stop() {
    if(this.stopPromise)return this.stopPromise;
    this.stopPromise=(async()=>{
      await this.ready;++this.generation;this.login={...this.login,sessionId:null,status:'logged_out',qrcodeUrl:null};
      if(this.config.mode==='managed')await this.processHost.stop();this.child=null;this.runtimeLease?.();this.runtimeLease=null;this.recoveryError=null;this.credential='';
    })();
    try{await this.stopPromise;}finally{this.stopPromise=null;}
  }
  async close(){this.closed=true;++this.generation;this.abort.abort();try{await this.processHost.close();await this.installing?.catch(()=>{});}finally{this.runtimeLease?.();this.runtimeLease=null;}}
}
