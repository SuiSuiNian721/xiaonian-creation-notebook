import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,rename,lstat,readdir,open} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkbenchError} from './contracts.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const coordinators=new Map();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canceled=()=>new WorkbenchError(409,'声音请求已取消。');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const VOICE_ID='xiaoli-warm-bright';
const MAX_AUDIO_BYTES=32*1024*1024;
const check=signal=>{if(signal?.aborted)throw canceled();};

export function completeWav(bytes){
  if(bytes.length<44||bytes.length>MAX_AUDIO_BYTES||bytes.toString('latin1',0,4)!=='RIFF'||bytes.toString('latin1',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)return false;
  let format=false,data=false,offset=12;
  while(offset+8<=bytes.length){
    const type=bytes.toString('latin1',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8,end=start+length;
    if(end>bytes.length)return false;
    if(type==='fmt '){
      if(format||length<16||bytes.readUInt16LE(start)!==1||bytes.readUInt16LE(start+2)!==1||bytes.readUInt32LE(start+4)!==24000||bytes.readUInt32LE(start+8)!==48000||bytes.readUInt16LE(start+12)!==2||bytes.readUInt16LE(start+14)!==16)return false;
      format=true;
    }else if(type==='data'){if(data||!format||length<2||length%2)return false;data=true;}
    offset=end+(length%2);
  }
  return format&&data&&offset===bytes.length;
}

function abortable(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(canceled());
  return new Promise((resolvePromise,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(canceled());};
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolvePromise(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}

async function regularFile(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw new WorkbenchError(400,'声音配置或音频必须是普通本地文件。');return stat;}
async function atomicJSON(path,value){const temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,path);}
async function terminate(child){
  if(!child||child.exitCode!==null)return;
  if(process.platform==='win32')await new Promise(done=>{const task=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});task.once('error',()=>{child.kill();done();});task.once('close',done);});
  else child.kill();
}

/** 所有入口只共享音色配方与音频，不共享角色聊天内容或会话状态。 */
export class SharedVoice {
  constructor({store,globalStore=store,dataDir,sharedDirectory=dataDir,baseUrl=()=>'',fetchImpl=fetch,timeoutMs=900000}){
    this.store=globalStore;this.directory=join(resolve(sharedDirectory),'shared-voice');this.baseUrl=baseUrl;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
    this.closed=false;this.lastError=null;this.lastResult=null;this.cachedEntry=null;
    let coordinator=coordinators.get(this.directory);
    if(!coordinator){coordinator={tail:Promise.resolve(),queued:0,active:0,users:new Set(),controllers:new Set(),child:null,startPromise:null};coordinators.set(this.directory,coordinator);}
    this.coordination=coordinator;coordinator.users.add(this);
  }
  config(){return this.store.module('voice').config;}
  async logs(){
    const directory=join(this.directory,'logs');let files;
    try{
      const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new WorkbenchError(400,'声音日志目录需要是普通本地文件夹。');
      files=await readdir(directory,{withFileTypes:true});
    }catch(error){if(error.code==='ENOENT')return {directory,entries:[]};throw error;}
    const names=files.filter(file=>file.isFile()&&/^\d+-[a-f0-9]+\.(?:stdout|stderr)\.log$/.test(file.name)).map(file=>file.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,4);
    const entries=[];
    for(const name of names){
      const path=join(directory,name);await regularFile(path);const file=await open(path,'r');
      try{
        const stat=await file.stat(),length=Math.min(stat.size,16384),bytes=Buffer.alloc(length);
        const {bytesRead}=await file.read(bytes,0,length,Math.max(0,stat.size-length));
        const text=bytes.subarray(0,bytesRead).toString('utf8').replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [已隐藏]').replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*["']?)[^\s"',;}]+/gi,'$1[已隐藏]');
        entries.push({name,text,truncated:stat.size>length});
      }finally{await file.close();}
    }
    return {directory,entries};
  }
  state(){const config=this.config();return {configured:!!(config.profilePath&&config.serviceUrl),serviceUrl:config.serviceUrl||'',voiceId:VOICE_ID,busy:this.coordination.active>0,queued:this.coordination.queued,running:!!this.coordination.child,lastError:this.lastError,lastResult:this.lastResult};}
  async status(){
    if(!this.state().configured)return this.state();
    try{const entry=await this.entry(),health=await this.health(entry);if(!health)return {...this.state(),running:false};await this.verify(entry);return {...this.state(),running:true,busy:this.state().busy||health.busy};}
    catch(error){return {...this.state(),running:false,lastError:error.message};}
  }
  entry(){
    const coordinator=this.coordination;
    const task=(coordinator.entryTail??Promise.resolve()).catch(()=>{}).then(()=>this.readEntry());
    coordinator.entryTail=task.catch(()=>{});return task;
  }
  async readEntry(){
    if(this.closed)throw canceled();
    const config=this.config();
    if(!config.profilePath||!config.serviceUrl)throw new WorkbenchError(409,'请在角色声音中配置固定音色文件与本机语音服务地址。');
    let url;try{url=new URL(config.serviceUrl);}catch{throw new WorkbenchError(400,'语音服务地址无效。');}
    if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||!url.port)throw new WorkbenchError(400,'MOSS 服务需要带端口的本机 HTTP 根地址。');
    let bytes,profile;try{const stat=await regularFile(config.profilePath);if(stat.size>1024*1024)throw new Error('size');bytes=await readFile(config.profilePath);profile=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new WorkbenchError(400,'无法读取固定音色配置，请选择有效的 JSON 配方。');}
    if(!/^[a-f0-9]{64}$/i.test(profile.reference_sha256??''))throw new WorkbenchError(400,'固定音色配置缺少参考音频 SHA256。');
    await mkdir(this.directory,{recursive:true});
    const privatePath=join(this.directory,'service.json');let secret;
    try{await regularFile(privatePath);secret=JSON.parse(await readFile(privatePath,'utf8'));if(secret.service!=='moss-character-voice'||!/^[a-f0-9]{64}$/.test(secret.token??''))throw new Error('invalid');}
    catch(error){if(error.code!=='ENOENT')throw new WorkbenchError(409,'本机声音服务凭据无效，请检查服务配置。');secret={version:1,service:'moss-character-voice',token:randomBytes(32).toString('hex')};}
    const desired={...secret,profilePath:resolve(config.profilePath),voiceId:VOICE_ID,voiceName:'测试音色 · 温暖清亮'};
    if(JSON.stringify(desired)!==JSON.stringify(secret))await atomicJSON(privatePath,desired);
    const entry={url:url.origin,token:desired.token,privatePath,profilePath:desired.profilePath,profileSha256:hash(bytes),referenceSha256:profile.reference_sha256.toLowerCase(),voiceName:desired.voiceName,pythonPath:config.pythonPath||''};
    this.cachedEntry=entry;return entry;
  }
  async json(entry,path,{method='GET',body,timeout=5000}={}){
    let response;
    try{response=await this.fetch(entry.url+path,{method,redirect:'error',signal:AbortSignal.timeout(timeout),headers:{authorization:'Bearer '+entry.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch{throw new WorkbenchError(503,'无法连接本机声音服务，请检查服务是否已启动。');}
    let value;try{value=await response.json();}catch{throw new WorkbenchError(502,'本机声音服务返回了无效数据。');}
    if(!response.ok)throw new WorkbenchError(response.status,typeof value.error==='string'?value.error:value.error?.message||'声音服务请求失败。');
    return value;
  }
  async health(entry){
    let response;try{response=await this.fetch(entry.url+'/health',{redirect:'error',signal:AbortSignal.timeout(1500)});}catch{return null;}
    let value;try{value=await response.json();}catch{throw new WorkbenchError(409,'此端口不是工作台 MOSS 声音服务。');}
    if(!response.ok||value.service!=='moss-character-voice'||value.version!==1)throw new WorkbenchError(409,'此端口已被其他服务占用。');return value;
  }
  async verify(entry){
    const value=await this.json(entry,'/v1/voices');const voice=value.voices?.find(item=>item.id===VOICE_ID);
    if(!voice||voice.profileSha256!==entry.profileSha256||voice.referenceSha256.toLowerCase()!==entry.referenceSha256)throw new WorkbenchError(409,'运行中的音色与固定配方不一致，请停止服务后重新启动。');
    return {voices:[{id:voice.id,name:voice.name,profileSha256:voice.profileSha256,referenceSha256:voice.referenceSha256}]};
  }
  async voices(){
    const saved=this.studio?.voices()??[];
    try{const entry=await this.entry(),result=await this.verify(entry);return {voices:[...result.voices.map(voice=>({...voice,name:'测试音色 · 温暖清亮',source:'test'})),...saved]};}
    catch(error){if(this.studio)return {voices:[...(this.state().configured?[{id:VOICE_ID,name:'测试音色 · 温暖清亮',source:'test'}]:[]),...saved],serviceError:error.message};throw error;}
  }
  async start(){
    const entry=await this.entry(),coordinator=this.coordination;
    if(coordinator.startPromise)return coordinator.startPromise;
    const starting=(async()=>{
      if(await this.health(entry))return this.verify(entry);
      if(!entry.pythonPath)throw new WorkbenchError(409,'请先选择 MOSS Python 解释器。');
      try{await regularFile(entry.pythonPath);}catch{throw new WorkbenchError(400,'找不到 MOSS Python 解释器。');}
      const logs=join(this.directory,'logs');await mkdir(logs,{recursive:true});
      const stamp=Date.now()+'-'+randomBytes(3).toString('hex');const stdout=createWriteStream(join(logs,stamp+'.stdout.log')),stderr=createWriteStream(join(logs,stamp+'.stderr.log'));
      const child=spawn(entry.pythonPath,['-B','-u',join(root,'integrations','moss-voice','server.py'),'--config',entry.privatePath,'--port',new URL(entry.url).port],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});
      child.stdout.pipe(stdout);child.stderr.pipe(stderr);coordinator.child=child;
      let failed=false;child.once('error',()=>{failed=true;});child.once('exit',()=>{if(coordinator.child===child)coordinator.child=null;stdout.end();stderr.end();});
      const deadline=Date.now()+120000;
      while(Date.now()<deadline){
        if(this.closed||failed||child.exitCode!==null)break;
        const status=await this.health(entry);if(status)return this.verify(entry);
        await delay(250);
      }
      await terminate(child);throw new WorkbenchError(503,'MOSS 声音服务未能启动，请查看声音服务日志。');
    })();coordinator.startPromise=starting;
    try{return await starting;}catch(error){this.lastError=error.message;throw error;}finally{if(coordinator.startPromise===starting)coordinator.startPromise=null;}
  }
  async stop(){
    if(this.coordination.active||this.coordination.queued)throw new WorkbenchError(409,'仍有声音正在生成或排队，请先取消并等待当前生成结束。');
    const entry=await this.entry();if(await this.health(entry))await this.json(entry,'/shutdown',{method:'POST',body:{}});
    const child=this.coordination.child;if(child){await Promise.race([new Promise(done=>child.once('exit',done)),delay(2000)]);await terminate(child);}return {stopped:true};
  }
  async synthesize({text,voiceId=VOICE_ID,characterId=null,moduleId='voice',requestId=null,signal}={}){
    check(signal);if(this.closed)throw canceled();
    if(voiceId!==VOICE_ID&&this.studio){
      const result=await this.studio.synthesize({text,voiceId,characterId,moduleId,requestId,signal});
      return {...result,url:this.baseUrl().replace(/\/$/,'')+'/internal/voice-audio/'+result.id+'/'+new URL(result.url,'http://localhost').pathname.split('/').at(-1)};
    }
    if(typeof text!=='string'||!text.trim()||text.trim().length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new WorkbenchError(400,'每次声音台词需要 1–500 个字符。');
    if(voiceId!==VOICE_ID)throw new WorkbenchError(400,'未找到指定音色，不会自动替换声音。');
    const entry=await this.entry(),coordinator=this.coordination;check(signal);
    if(coordinator.queued>=8)throw new WorkbenchError(429,'声音等待队列已满，请稍后重试。');
    const input=text.trim(),id=hash(JSON.stringify([entry.profileSha256,voiceId,input]));coordinator.queued++;
    const task=coordinator.tail.catch(()=>{}).then(async()=>{
      coordinator.queued--;check(signal);if(this.closed)throw canceled();coordinator.active++;
      try{
        const cached=await this.cached(id,entry);if(cached){const result={...cached,characterId,moduleId,requestId};this.lastResult=result;return result;}
        await this.start();check(signal);
        const controller=new AbortController();coordinator.controllers.add(controller);
        const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
        try{
          let response;try{response=await this.fetch(entry.url+'/v1/audio/speech',{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:'Bearer '+entry.token,'content-type':'application/json'},body:JSON.stringify({input,voice:voiceId,model:'moss-tts-local',response_format:'wav'})});}
          catch{if(this.closed)throw canceled();throw new WorkbenchError(504,'声音生成未完成，连接已中断或等待超时。');}
          if(!response.ok){let value;try{value=await response.json();}catch{}throw new WorkbenchError(response.status,value?.error?.message||'声音生成失败，请检查声音服务。');}
          if(response.headers.get('x-voice-id')!==voiceId||response.headers.get('x-voice-profile-sha256')!==entry.profileSha256||response.headers.get('x-reference-sha256')?.toLowerCase()!==entry.referenceSha256)throw new WorkbenchError(502,'声音服务返回的音色身份不一致。');
          const chunks=[];let size=0;if(Number(response.headers.get('content-length'))>MAX_AUDIO_BYTES){await response.body?.cancel();throw new WorkbenchError(502,'语音结果超过允许大小。');}
          for await(const chunk of response.body){size+=chunk.length;if(size>MAX_AUDIO_BYTES){controller.abort();throw new WorkbenchError(502,'语音结果超过允许大小。');}chunks.push(chunk);}
          const bytes=Buffer.concat(chunks);if(!completeWav(bytes))throw new WorkbenchError(502,'声音服务没有返回完整 WAV 音频。');
          check(signal);if(this.closed)throw canceled();
          const cache=join(this.directory,'audio');await mkdir(cache,{recursive:true});await writeFile(join(cache,id+'.wav'),bytes);
          const metadata={id,voiceId,profileSha256:entry.profileSha256,referenceSha256:entry.referenceSha256,sha256:hash(bytes),bytes:bytes.length,characterId,moduleId,requestId,createdAt:new Date().toISOString()};
          await atomicJSON(join(cache,id+'.json'),metadata);
          const result=this.result(metadata,entry);this.lastResult=result;this.lastError=null;return result;
        }finally{clearTimeout(timer);coordinator.controllers.delete(controller);}
      }catch(error){if(error.status!==409)this.lastError=error.message;throw error;}finally{coordinator.active--;}
    });coordinator.tail=task.catch(()=>{});
    return abortable(task,signal);
  }
  result(metadata,entry){const signature=createHmac('sha256',entry.token).update('voice-audio:'+metadata.id).digest('hex');return {type:'record',...metadata,url:this.baseUrl().replace(/\/$/,'')+'/internal/voice-audio/'+metadata.id+'/'+signature};}
  async cached(id,entry){
    try{const path=join(this.directory,'audio',id+'.json');await regularFile(path);const metadata=JSON.parse(await readFile(path,'utf8'));if(metadata.id!==id||metadata.profileSha256!==entry.profileSha256)return null;const wav=join(this.directory,'audio',id+'.wav');await regularFile(wav);const bytes=await readFile(wav);if(hash(bytes)!==metadata.sha256||!completeWav(bytes))return null;return this.result(metadata,entry);}catch{return null;}
  }
  async audio(id,signature){
    if(this.studio?.acceptsAudio(id,signature))return this.studio.audio(id,signature);
    if(!/^[a-f0-9]{64}$/.test(id)||!/^[a-f0-9]{64}$/.test(signature))throw new WorkbenchError(403,'声音地址无效。');
    const entry=await this.entry();const expected=createHmac('sha256',entry.token).update('voice-audio:'+id).digest('hex');
    if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))throw new WorkbenchError(403,'声音地址签名无效。');
    const metadataPath=join(this.directory,'audio',id+'.json'),path=join(this.directory,'audio',id+'.wav');
    try{await regularFile(metadataPath);await regularFile(path);const metadata=JSON.parse(await readFile(metadataPath,'utf8'));const bytes=await readFile(path);if(hash(bytes)!==metadata.sha256||!completeWav(bytes))throw new Error('changed');return {bytes,mime:'audio/wav'};}catch{throw new WorkbenchError(404,'声音文件不存在或已改变。');}
  }
  async close(){
    if(this.closed)return;this.closed=true;const coordinator=this.coordination;coordinator.users.delete(this);
    if(!coordinator.users.size){for(const controller of coordinator.controllers)controller.abort();await terminate(coordinator.child);coordinators.delete(this.directory);}
  }
}
