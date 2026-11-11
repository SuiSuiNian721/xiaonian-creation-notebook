import {help} from './components.js';

const connectionLabels={disconnected:'未连接世界',connecting:'正在连接…',connected:'已进入世界',disconnecting:'正在断开…',error:'连接失败'};
const generationLabels={idle:'PNG 已保存',uploading:'正在上传到 MineSkin…',waiting:'正在等待 MineSkin 生成纹理…',ready:'兼容纹理已准备',error:'纹理生成失败'};
const applicationLabels={idle:'尚未应用自定义皮肤',generating:'正在准备皮肤…',applying:'正在应用到世界…',applied:'已应用到世界',error:'皮肤应用失败',changed:'皮肤已更改，待重新应用'};

export function drawBotSkin(canvas,image,model='classic') {
  canvas.width=448;canvas.height=304;
  const context=canvas.getContext('2d');context.imageSmoothingEnabled=false;
  const modern=(image.naturalHeight||image.height)===64,arm=modern&&model==='slim'?3:4,scale=8;
  let showHat=modern;
  if(!modern){
    // Minecraft 1.20.1 HttpTexture.doNotchTransparencyHack：旧图右半区没有 alpha<128 时隐藏帽层。
    context.drawImage(image,0,0);
    const pixels=context.getImageData(32,0,32,32).data;
    showHat=pixels.some((value,index)=>index%4===3&&value<128);
    context.clearRect(0,0,canvas.width,canvas.height);
  }
  function face(part,origin,padding=0) {
    const [sx,sy,width,height,x,y,mirror=false]=part;
    const dx=origin+(x-padding)*scale,dy=24+(y-padding)*scale,dw=(width+padding*2)*scale,dh=(height+padding*2)*scale;
    context.save();
    if(mirror){context.translate(dx+dw,dy);context.scale(-1,1);context.drawImage(image,sx,sy,width,height,0,0,dw,dh);}
    else context.drawImage(image,sx,sy,width,height,dx,dy,dw,dh);
    context.restore();
  }
  // 每个视角以躯干左上角为原点；背面左右互换，旧版皮肤的左肢镜像右肢。
  const front=[[8,8,8,8,0,0],[20,20,8,12,0,8],[44,20,arm,12,-arm,8],[modern?36:44,modern?52:20,arm,12,8,8,!modern],[4,20,4,12,0,20],[modern?20:4,modern?52:20,4,12,4,20,!modern]];
  const back=[[24,8,8,8,0,0],[32,20,8,12,0,8],[48+arm,20,arm,12,8,8],[modern?40+arm:48+arm,modern?52:20,arm,12,-arm,8,!modern],[12,20,4,12,4,20],[modern?28:12,modern?52:20,4,12,0,20,!modern]];
  front.forEach(part=>face(part,80));back.forEach(part=>face(part,304));
  if(showHat){face([40,8,8,8,0,0],80,.5);face([56,8,8,8,0,0],304,.5);}
  if(modern){
    const frontOuter=[[20,36,8,12,0,8],[44,36,arm,12,-arm,8],[52,52,arm,12,8,8],[4,36,4,12,0,20],[4,52,4,12,4,20]];
    const backOuter=[[32,36,8,12,0,8],[48+arm,36,arm,12,8,8],[56+arm,52,arm,12,-arm,8],[12,36,4,12,4,20],[12,52,4,12,0,20]];
    frontOuter.forEach(part=>face(part,80,.25));backOuter.forEach(part=>face(part,304,.25));
  }
}

async function readSkinFile(file,signal) {
  if(file.size>512*1024)throw new Error('PNG 不能超过 512 KiB，请压缩后重试。');
  if(signal.aborted)throw new DOMException('页面已关闭','AbortError');
  const result=await new Promise((resolve,reject)=>{
    const reader=new FileReader(),abort=()=>reader.abort();
    const finish=(action,value)=>{signal.removeEventListener('abort',abort);action(value);};
    reader.onload=()=>finish(resolve,String(reader.result));
    reader.onerror=()=>finish(reject,new Error('无法读取图片，请重新选择 PNG。'));
    reader.onabort=()=>finish(reject,new DOMException('页面已关闭','AbortError'));
    signal.addEventListener('abort',abort,{once:true});reader.readAsDataURL(file);
  });
  const base64=result.slice(result.indexOf(',')+1),signature=atob(base64.slice(0,12));
  if(![137,80,78,71,13,10,26,10].every((byte,index)=>signature.charCodeAt(index)===byte))throw new Error('请选择有效的 PNG 皮肤图片。');
  const image=new Image();image.src='data:image/png;base64,'+base64;
  try{await image.decode();}catch{throw new Error('PNG 无法解码，请重新导出图片后重试。');}
  if(image.naturalWidth!==64||![32,64].includes(image.naturalHeight))throw new Error('皮肤尺寸需为 64×64 或 64×32 像素。');
  return {name:file.name,base64,height:image.naturalHeight};
}

export function mountBotSkin(root,ctx,{state,onState}={}) {
  const {signal}=ctx,find=selector=>root.querySelector(selector);
  const api=(path,method,body)=>ctx.api('/api/modules/mc-play'+path,{method,body,timeoutMs:20000});
  let current=state,pending=false,chosenModel=state?.skin?.image?.model||'classic';
  let previewSignature='',previewToken=0,loadedImage,loadedUrl='';
  root.innerHTML=`<section class="panel glass mc-bot-skin-panel"><div class="panel-heading"><h2>机器人皮肤</h2><div class="mc-bot-skin-identity"><strong data-bot-skin-player></strong><span class="status-chip" data-bot-skin-connection></span></div></div><div class="mc-bot-skin-layout"><figure class="mc-bot-skin-figure"><div class="mc-bot-skin-stage"><div class="quiet-empty" data-bot-skin-empty>导入一张 Minecraft 皮肤</div><canvas data-bot-skin-preview width="448" height="304" role="img" aria-label="Minecraft 皮肤正面与背面预览" hidden></canvas><span data-bot-skin-preview-loading role="status" hidden>正在读取预览…</span></div><figcaption data-bot-skin-captions hidden><span>正面</span><span>背面</span></figcaption><p class="form-feedback error" data-bot-skin-preview-error role="status" hidden></p></figure><div class="mc-bot-skin-controls"><div class="mc-bot-skin-file-row"><span data-bot-skin-filename>尚未导入 PNG</span><button type="button" class="button" data-bot-skin-replace>导入 PNG</button><input type="file" accept="image/png,.png" data-bot-skin-file aria-label="导入 Minecraft 皮肤 PNG" hidden></div><div class="field"><div class="field-label"><label for="mc-bot-skin-model">角色模型</label>${help('Steve 为 4 像素宽手臂，Alex 为 3 像素宽手臂。64×32 旧版皮肤仅支持 Steve，左臂和左腿会按游戏规则镜像。','角色模型说明')}</div><select id="mc-bot-skin-model" data-bot-skin-model><option value="classic">Classic / Steve</option><option value="slim">Slim / Alex</option></select></div><div class="form-actions mc-bot-skin-actions"><button type="button" class="button primary" data-bot-skin-apply>上传并应用</button><button type="button" class="button" data-bot-skin-reset>恢复默认</button>${help('恢复这个世界为机器人提供的默认皮肤；已导入的 PNG 会保留。','恢复默认皮肤说明')}</div><div class="mc-bot-skin-gate" data-bot-skin-gate><span data-bot-skin-gate-label></span>${help('','皮肤应用条件')}</div><p class="mc-bot-skin-upload-note" data-bot-skin-upload-note hidden>上传并应用会把 PNG 发送到 MineSkin，生成其他玩家也能看到的皮肤。</p><div class="mc-bot-skin-status"><p class="form-feedback" data-bot-skin-generation role="status" hidden></p><p class="form-feedback" data-bot-skin-application role="status"></p><p class="form-feedback" data-bot-skin-feedback role="status" hidden></p></div><details class="mc-bot-skin-key" data-bot-skin-key-settings><summary>MineSkin API Key<span class="mc-secondary" data-bot-skin-key-state></span></summary><form data-bot-skin-key-form><div class="field"><div class="field-label"><label for="mc-bot-skin-key">API Key</label>${help('可选。使用自己的 MineSkin API Key 可按该账号的额度生成皮肤；工作台只显示是否已保存。','MineSkin API Key 说明')}</div><input id="mc-bot-skin-key" data-bot-skin-key type="password" autocomplete="new-password" spellcheck="false" maxlength="512" placeholder="输入新的 API Key"></div><div class="form-actions"><button type="submit" class="button small" data-bot-skin-key-save>保存 Key</button><button type="button" class="button ghost small" data-bot-skin-key-clear>清除 Key</button></div></form></details></div></div></section>`;

  function feedback(message='',error=false) {
    if(signal.aborted)return;
    const node=find('[data-bot-skin-feedback]');node.textContent=message;node.hidden=!message;node.className='form-feedback'+(error?' error':'');
  }
  async function preview(image) {
    const canvas=find('[data-bot-skin-preview]'),empty=find('[data-bot-skin-empty]'),captions=find('[data-bot-skin-captions]');
    empty.hidden=!!image;
    if(!image){previewToken++;previewSignature='';canvas.hidden=true;captions.hidden=true;return;}
    const signature=[image.id,image.previewUrl,image.model].join('|');if(signature===previewSignature)return;
    previewSignature=signature;const token=++previewToken;
    find('[data-bot-skin-preview-error]').hidden=true;
    find('[data-bot-skin-preview-loading]').hidden=false;
    try{
      let source=loadedImage;
      if(loadedUrl!==image.previewUrl){source=new Image();source.src=image.previewUrl;await source.decode();}
      if(signal.aborted||token!==previewToken)return;
      loadedImage=source;loadedUrl=image.previewUrl;drawBotSkin(canvas,source,image.model);
      canvas.hidden=false;captions.hidden=false;canvas.dataset.ready='true';
    }catch(error){
      if(signal.aborted||token!==previewToken)return;
      const node=find('[data-bot-skin-preview-error]');node.textContent='预览读取失败，请重新打开皮肤页。';node.hidden=false;
    }finally{if(!signal.aborted&&token===previewToken)find('[data-bot-skin-preview-loading]').hidden=true;}
  }
  function update(next=current) {
    if(signal.aborted)return;
    current=next;
    const skin=current?.skin||{},connection=current?.connection||{},image=skin.image,busy=pending||skin.busy;
    const online=connection.status==='connected',supported=online&&connection.skinProtocol===1;
    find('[data-bot-skin-player]').textContent=connection.playerName||current?.config?.playerName||'';
    const status=find('[data-bot-skin-connection]');status.textContent=connectionLabels[connection.status]||'未连接世界';status.className='status-chip'+(online?' good':'');
    find('[data-bot-skin-filename]').textContent=image?`${image.name} · ${image.width}×${image.height}`:'尚未导入 PNG';
    const replace=find('[data-bot-skin-replace]');replace.textContent=image?'更换 PNG':'导入 PNG';replace.disabled=!!busy;
    find('[data-bot-skin-file]').disabled=!!busy;
    const model=find('[data-bot-skin-model]');model.disabled=!!busy;model.querySelector('[value="slim"]').disabled=image?.height===32;
    if(!pending){chosenModel=image?.model||chosenModel;model.value=chosenModel;}
    const apply=find('[data-bot-skin-apply]');apply.textContent=skin.texture?'应用到世界':'上传并应用';apply.disabled=!!busy||!supported||!image;
    find('[data-bot-skin-reset]').disabled=!!busy||!supported;
    find('[data-bot-skin-gate]').hidden=supported;
    find('[data-bot-skin-gate-label]').textContent=online?'运行端需更新':'连接后可应用';
    find('[data-bot-skin-gate] [data-help]').dataset.help=online?'当前运行端尚未提供皮肤应用能力。请更新运行组件并重新连接世界。':'先在陪玩页连接世界，再应用或恢复皮肤。';
    find('[data-bot-skin-upload-note]').hidden=!image||!!skin.texture;
    const generation=skin.generation||{},generationNode=find('[data-bot-skin-generation]');
    generationNode.hidden=!image;generationNode.textContent=generation.message||(skin.texture?'兼容纹理已准备':generationLabels[generation.status||'idle'])||'';generationNode.className='form-feedback'+(generation.status==='error'?' error':'');
    const application=skin.application||{},applicationNode=find('[data-bot-skin-application]');
    applicationNode.textContent=application.message||(application.status==='applied'&&application.mode==='default'?'已恢复世界默认皮肤':applicationLabels[application.status||'idle'])||'';applicationNode.className='form-feedback'+(application.status==='error'?' error':'');
    find('[data-bot-skin-key-state]').textContent=skin.hasApiKey?'已设置':'可选';
    find('[data-bot-skin-key]').disabled=!!busy;
    find('[data-bot-skin-key-save]').disabled=!!busy||!find('[data-bot-skin-key]').value.trim();
    find('[data-bot-skin-key-clear]').disabled=!!busy||!skin.hasApiKey;
    void preview(image);
  }
  async function run(job,message='') {
    if(signal.aborted||pending||current?.skin?.busy)return;
    pending=true;feedback();update();
    try{
      const result=await job();if(signal.aborted||!result)return;
      current=result;onState?.(result);feedback(message);
    }catch(error){if(!signal.aborted)feedback(error.message,true);}
    finally{pending=false;if(!signal.aborted)update();}
  }
  const on=(selector,event,listener)=>find(selector).addEventListener(event,listener,{signal});
  on('[data-bot-skin-replace]','click',()=>find('[data-bot-skin-file]').click());
  on('[data-bot-skin-file]','change',event=>{
    const file=event.target.files?.[0];event.target.value='';if(!file)return;
    void run(async()=>{const input=await readSkinFile(file,signal);if(signal.aborted)return;return api('/skin','PUT',{name:input.name,base64:input.base64,model:input.height===32?'classic':chosenModel});});
  });
  on('[data-bot-skin-model]','change',event=>{
    chosenModel=event.target.value;if(!current?.skin?.image)return;
    void run(()=>api('/skin','PATCH',{model:chosenModel}));
  });
  on('[data-bot-skin-apply]','click',()=>void run(()=>api('/skin/apply','POST',{})));
  on('[data-bot-skin-reset]','click',()=>void run(()=>api('/skin/reset','POST',{})));
  on('[data-bot-skin-key]','input',()=>update());
  on('[data-bot-skin-key-form]','submit',event=>{
    event.preventDefault();const key=find('[data-bot-skin-key]'),apiKey=key.value.trim();if(!apiKey)return;
    void run(async()=>{const result=await api('/skin','PATCH',{apiKey});if(!signal.aborted&&key.value.trim()===apiKey)key.value='';return result;},'API Key 已保存。');
  });
  on('[data-bot-skin-key-clear]','click',()=>void run(async()=>{const result=await api('/skin','PATCH',{clearApiKey:true});if(!signal.aborted)find('[data-bot-skin-key]').value='';return result;},'API Key 已清除。'));
  signal.addEventListener('abort',()=>{previewToken++;},{once:true});
  update();return {update,error:message=>feedback(message,true)};
}
