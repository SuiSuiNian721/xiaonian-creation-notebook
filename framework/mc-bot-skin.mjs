import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, inflateSync } from 'node:zlib';
import { WorkbenchError, fields, text } from './contracts.mjs';

const KEY='mc-play.skin',SECRET='mc-play.skin.mineskin-key';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const LIMIT=512*1024,API='https://api.mineskin.org/v2';
const invalid=message=>new WorkbenchError(400,message);
const variant=value=>{if(!['classic','slim'].includes(value))throw invalid('请选择 Steve 或 Alex 体型。');return value;};
const cleanId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:null;

/** Validate the complete PNG, including compressed scanlines, before retaining an upload. */
export function validateBotSkin(value) {
  fields(value,['name','base64','model']);
  const name=text(value.name,'皮肤文件名',200),model=variant(value.model??'classic');
  if(!/\.png$/i.test(name)||/[\\/\x00-\x1f\x7f]/.test(name))throw invalid('请选择 PNG 皮肤文件。');
  if(typeof value.base64!=='string'||value.base64.length>Math.ceil(LIMIT/3)*4||!value.base64.length||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64))throw invalid('皮肤文件无效或超过 512 KiB。');
  const bytes=Buffer.from(value.base64,'base64');
  if(bytes.length>LIMIT||bytes.length<45||!bytes.subarray(0,8).equals(PNG))throw invalid('皮肤不是有效的 PNG 文件。');
  let width,height,depth,color,interlace,ended=false,palette=0,idatEnded=false;
  const compressed=[];
  for(let offset=8;offset<bytes.length;) {
    if(offset+12>bytes.length)throw invalid('PNG 文件不完整。');
    const size=bytes.readUInt32BE(offset),end=offset+12+size;
    if(end>bytes.length)throw invalid('PNG 文件不完整。');
    const tag=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    if(!/^[A-Za-z]{4}$/.test(tag)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw invalid('PNG 校验失败，文件可能已损坏。');
    if(offset===8&&tag!=='IHDR')throw invalid('PNG 缺少图像头。');
    if(tag==='IHDR') {
      if(offset!==8||size!==13)throw invalid('PNG 图像头无效。');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);depth=data[8];color=data[9];interlace=data[12];
      if(width!==64||![32,64].includes(height))throw invalid('请选择 64×64 或旧版 64×32 的 Minecraft 标准皮肤。');
      if(height===32&&model!=='classic')throw invalid('旧版 64×32 皮肤只能使用 Steve 体型。');
      if(!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]}[color]?.includes(depth))||data[10]!==0||data[11]!==0||interlace>1)throw invalid('PNG 编码不受支持，请重新导出标准 PNG。');
    } else if(tag==='PLTE') {
      if(palette||compressed.length||!size||size%3||size>768||[0,4].includes(color)||color===3&&size/3>2**depth)throw invalid('PNG 调色板无效。');
      palette=size/3;
    } else if(tag==='IDAT') {
      if(idatEnded)throw invalid('PNG 像素数据顺序无效。');
      compressed.push(data);
    } else if(tag==='IEND') {
      if(size!==0||end!==bytes.length||!compressed.length)throw invalid('PNG 结尾或像素数据无效。');
      ended=true;
    } else {
      if(compressed.length)idatEnded=true;
      if(tag==='acTL'||tag[0]===tag[0].toUpperCase())throw invalid('请选择静态、标准格式的 PNG 皮肤。');
    }
    offset=end;
  }
  if(!ended||color===3&&!palette)throw invalid('PNG 文件不完整。');
  const channels={0:1,2:3,3:1,4:2,6:4}[color],scans=[];
  const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  for(const [x,y,dx,dy] of passes) {
    const w=Math.ceil((width-x)/dx),h=Math.ceil((height-y)/dy);
    if(w>0&&h>0)scans.push({width:w,height:h,rowBytes:Math.ceil(w*channels*depth/8)});
  }
  const expected=scans.reduce((sum,pass)=>sum+(pass.rowBytes+1)*pass.height,0);
  let raw;
  try{raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{throw invalid('PNG 像素数据损坏或解压长度不正确。');}
  if(raw.length!==expected)throw invalid('PNG 像素数据长度不正确。');
  let offset=0;
  for(const pass of scans) {
    let previous=Buffer.alloc(pass.rowBytes);
    for(let line=0;line<pass.height;line++) {
      const filter=raw[offset++];if(filter>4)throw invalid('PNG 像素过滤方式无效。');
      if(color===3) {
        const row=Buffer.from(raw.subarray(offset,offset+pass.rowBytes));
        for(let index=0;index<row.length;index++) {
          const left=index?row[index-1]:0,up=previous[index],corner=index?previous[index-1]:0;
          let predictor=0;
          if(filter===1)predictor=left;
          else if(filter===2)predictor=up;
          else if(filter===3)predictor=Math.floor((left+up)/2);
          else if(filter===4){const p=left+up-corner,a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-corner);predictor=a<=b&&a<=c?left:b<=c?up:corner;}
          row[index]=(row[index]+predictor)&255;
        }
        for(let x=0;x<pass.width;x++){const bit=x*depth,index=(row[Math.floor(bit/8)]>>(8-depth-bit%8))&((1<<depth)-1);if(index>=palette)throw invalid('PNG 像素引用了不存在的调色板颜色。');}
        previous=row;
      }
      offset+=pass.rowBytes;
    }
  }
  return {bytes,name,model,width,height,hash:createHash('sha256').update(bytes).digest('hex')};
}

export function minecraftTexture(skin,model) {
  const {value,signature}=skin?.texture?.data??{};
  if(typeof value!=='string'||value.length>32000||typeof signature!=='string'||signature.length>16000||!signature)throw new WorkbenchError(502,'皮肤生成服务没有返回有效的签名皮肤。');
  let decoded;try{decoded=JSON.parse(Buffer.from(value,'base64').toString('utf8'));}catch{throw new WorkbenchError(502,'皮肤生成服务返回的皮肤资料无效。');}
  const profile=decoded?.textures?.SKIN;
  let url;try{url=new URL(profile?.url);}catch{throw new WorkbenchError(502,'皮肤生成服务没有返回标准纹理地址。');}
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='textures.minecraft.net'||url.port||url.username||url.password||url.search||url.hash||!/^\/texture\/[a-f0-9]{32,64}$/i.test(url.pathname))throw new WorkbenchError(502,'皮肤生成服务返回了非 Minecraft 标准纹理地址。');
  const actualModel=profile.metadata?.model??'classic';
  if(actualModel!==model)throw new WorkbenchError(502,'生成皮肤的体型与所选体型不一致，请重新生成。');
  url.protocol='https:';
  return {url:url.href,hash:url.pathname.split('/').at(-1).toLowerCase(),model,value,signature,preparedAt:new Date().toISOString()};
}

export class MinecraftBotSkin {
  constructor({store,dataDir,fetchImpl=fetch,pollIntervalMs=1500,timeoutMs=180000}) {
    this.store=store;this.directory=join(dataDir,'mc-play','skins');this.fetch=fetchImpl;
    this.pollIntervalMs=pollIntervalMs;this.timeoutMs=timeoutMs;this.operation=null;this.closed=false;
    this.generation={status:this.record()?.texture?'ready':'idle',message:''};
  }
  record(){return this.store.getSetting(KEY)??null;}
  state() {
    const saved=this.record(),image=saved?{id:saved.id,name:saved.name,model:saved.model,width:saved.width,height:saved.height,previewUrl:'/api/modules/mc-play/skin/image?revision='+saved.id}:null;
    const texture=saved?.texture?{url:saved.texture.url,model:saved.texture.model,preparedAt:saved.texture.preparedAt}:null;
    return {image,texture,generation:{...this.generation},hasApiKey:!!this.store.getSetting(SECRET)};
  }
  file(){const hash=this.record()?.hash;if(!/^[a-f0-9]{64}$/.test(hash??''))throw new WorkbenchError(404,'还没有保存 Bot 皮肤。');return join(this.directory,hash+'.png');}
  image(revision) {
    const saved=this.record();if(!saved||revision&&revision!==saved.id)throw new WorkbenchError(404,'找不到这份 Bot 皮肤。');
    try{return {bytes:readFileSync(this.file()),name:saved.name};}catch(error){if(error instanceof WorkbenchError)throw error;throw new WorkbenchError(404,'皮肤文件已丢失，请重新导入。');}
  }
  invalidate(){
    const operation=this.operation;this.operation=null;operation?.controller.abort();
    if(operation)this.generation={status:this.record()?.texture?'ready':'idle',message:'皮肤生成已取消，可重新应用。'};
  }
  save(value) {
    const {bytes,...metadata}=validateBotSkin(value);
    mkdirSync(this.directory,{recursive:true});
    const file=join(this.directory,metadata.hash+'.png');
    if(!existsSync(file)||!readFileSync(file).equals(bytes)) {
      const temporary=join(this.directory,randomUUID()+'.tmp');
      try{writeFileSync(temporary,bytes,{mode:0o600});renameSync(temporary,file);}
      finally{if(existsSync(temporary))unlinkSync(temporary);}
    }
    this.invalidate();this.store.setSetting(KEY,{...metadata,id:randomUUID(),texture:null});
    this.generation={status:'idle',message:'皮肤已保存，尚未应用到世界。'};return this.state();
  }
  configure(value) {
    fields(value,['model','apiKey','clearApiKey']);
    const saved=this.record();
    if(value.model!==undefined){variant(value.model);if(saved?.height===32&&value.model==='slim')throw invalid('旧版 64×32 皮肤只能使用 Steve 体型。');}
    if(value.clearApiKey!==undefined&&typeof value.clearApiKey!=='boolean')throw invalid('清除密钥选项无效。');
    if(value.apiKey!==undefined&&(typeof value.apiKey!=='string'||value.apiKey.length>512||/[\s\x00-\x1f\x7f]/.test(value.apiKey)))throw invalid('MineSkin 密钥格式无效。');
    if(value.model!==undefined&&saved&&saved.model!==value.model) {
      this.invalidate();this.store.setSetting(KEY,{...saved,id:randomUUID(),model:value.model,texture:null});this.generation={status:'idle',message:'体型已修改，需要重新应用。'};
    }
    if(value.clearApiKey)this.store.setSetting(SECRET,null);
    else if(value.apiKey)this.store.setSetting(SECRET,value.apiKey);
    return this.state();
  }
  clear(){this.invalidate();this.store.setSetting(KEY,null);this.generation={status:'idle',message:''};return this.state();}
  current(operation){return !this.closed&&this.operation===operation&&!operation.signal.aborted&&this.record()?.id===operation.imageId;}
  assertCurrent(operation){if(!this.current(operation))throw new WorkbenchError(409,'皮肤已更换或应用已取消，旧结果已丢弃。');}
  async request(path,options,operation) {
    for(let attempt=0;attempt<5;attempt++) {
      this.assertCurrent(operation);
      const signal=AbortSignal.any([operation.signal,AbortSignal.timeout(25000)]);
      const headers={'User-Agent':'AI-Future-Workbench/1.0 (Minecraft bot skins)',Accept:'application/json'};
      const key=this.store.getSetting(SECRET);if(key)headers.Authorization='Bearer '+key;
      let result;
      try{result=await this.fetch(API+path,{...options,headers,signal,redirect:'error'});}catch{this.assertCurrent(operation);throw new WorkbenchError(502,'无法连接皮肤生成服务，请检查网络后重新应用。');}
      this.assertCurrent(operation);
      if(result.status===429&&attempt<4) {
        const seconds=Math.max(1,Math.min(30,Number(result.headers.get('retry-after'))||3));
        this.generation={status:'waiting',message:'皮肤生成服务繁忙，正在等待重试…'};
        await result.body?.cancel();await delay(seconds*1000,undefined,{signal:operation.signal});continue;
      }
      if(result.status===404&&options.method==='GET'&&path.startsWith('/queue/')) {
        await result.body?.cancel();
        this.assertCurrent(operation);
        if(attempt===4)throw new WorkbenchError(502,'皮肤生成服务已受理上传，但队列结果暂时不可用。图片已保留，请稍后重新应用。');
        this.generation={status:'waiting',message:'生成队列暂时不可用，正在重新查询同一任务…'};
        await delay(this.pollIntervalMs,undefined,{signal:operation.signal});continue;
      }
      if(!result.ok){await result.body?.cancel();throw new WorkbenchError(502,result.status===401||result.status===403?'皮肤生成服务拒绝请求，可在生成设置中填写有效的 MineSkin 密钥后重试。':result.status===429?'皮肤生成服务请求过于频繁，请稍后重新应用。':'皮肤生成服务未能处理图片，请稍后重新应用。');}
      let value;try{value=await result.json();}catch{throw new WorkbenchError(502,'皮肤生成服务返回的数据无法读取。');}
      this.assertCurrent(operation);if(value.success===false)throw new WorkbenchError(502,'皮肤生成失败，请检查图片并重新应用。');
      return value;
    }
  }
  async prepare({signal}={}) {
    if(this.closed)throw new WorkbenchError(409,'MC 陪玩正在关闭。');
    const saved=this.record();if(!saved)throw new WorkbenchError(409,'请先导入 Bot 的 PNG 皮肤。');
    if(signal?.aborted)throw new WorkbenchError(409,'皮肤应用已取消。');
    if(saved.texture)return structuredClone(saved.texture);
    if(this.operation)throw new WorkbenchError(409,'当前皮肤正在生成，请等待完成。');
    const controller=new AbortController(),operation={imageId:saved.id,controller,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs),...(signal?[signal]:[])])};
    this.operation=operation;this.generation={status:'uploading',message:'正在生成可供联机玩家显示的皮肤…'};
    try {
      const form=new FormData();form.set('file',new Blob([this.image(saved.id).bytes],{type:'image/png'}),'skin.png');form.set('variant',saved.model);form.set('visibility','unlisted');
      let result=await this.request('/queue',{method:'POST',body:form},operation);
      const jobId=cleanId(result.job?.id);
      // Query the accepted job immediately; transient missing jobs retry without resubmission.
      while(result.job?.status!=='completed') {
        if(result.job?.status==='failed')throw new WorkbenchError(502,'皮肤生成失败，请检查 PNG 并重新应用。');
        if(!jobId||!['waiting','active','processing'].includes(result.job?.status))throw new WorkbenchError(502,'皮肤生成服务返回了未知任务状态。');
        this.generation={status:'waiting',message:'正在等待皮肤生成完成…'};
        result=await this.request('/queue/'+jobId,{method:'GET'},operation);
        if(result.job?.status!=='completed')await delay(this.pollIntervalMs,undefined,{signal:operation.signal});
      }
      if(!result.skin) {
        const skinId=cleanId(result.job?.result);if(!skinId)throw new WorkbenchError(502,'皮肤生成服务没有返回生成结果。');
        result=await this.request('/skins/'+skinId,{method:'GET'},operation);
      }
      const prepared=minecraftTexture(result.skin,saved.model);this.assertCurrent(operation);
      this.store.setSetting(KEY,{...saved,texture:prepared});this.generation={status:'ready',message:'皮肤已生成，可以应用到世界。'};
      return structuredClone(prepared);
    } catch(error) {
      if(this.operation===operation) this.generation={status:operation.signal.aborted?'idle':'error',message:operation.signal.aborted?'皮肤生成已取消，可重新应用。':error instanceof WorkbenchError?error.message:'皮肤生成失败，请重新应用。'};
      throw error instanceof WorkbenchError?error:new WorkbenchError(operation.signal.aborted?409:502,operation.signal.aborted?'皮肤生成已取消。':'皮肤生成失败，请重新应用。');
    } finally {if(this.operation===operation)this.operation=null;}
  }
  close(){this.closed=true;this.invalidate();}
}
