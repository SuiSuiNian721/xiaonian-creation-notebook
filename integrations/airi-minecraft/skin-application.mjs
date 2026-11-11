const identity=value=>String(value??'').replaceAll('-','').toLowerCase();
const matches=(profile,expected)=>profile&&profile.hash===expected.hash&&(expected.hash===null||profile.model===expected.model&&profile.signed);

/** Read a server-supplied player profile, never the signing account's profileId. */
export function playerInfoSkin(packet,uuid) {
  if(!uuid||!(packet?.action?.add_player||packet?.action==='add_player'||packet?.action===0))return;
  const player=packet.data?.find(item=>identity(item.uuid)===identity(uuid));if(!player)return;
  const properties=player.player?.properties??player.properties;
  if(!Array.isArray(properties))return;
  const texture=properties.find(property=>property.name==='textures');
  if(!texture)return {hash:null,model:'classic',signed:false};
  if(typeof texture.value!=='string'||texture.value.length>32000)return;
  let data;try{data=JSON.parse(Buffer.from(texture.value,'base64').toString('utf8'));}catch{return;}
  if(!data?.textures||typeof data.textures!=='object')return;
  if(!data.textures.SKIN)return {hash:null,model:'classic',signed:!!texture.signature};
  let url;try{url=new URL(data.textures.SKIN.url);}catch{return;}
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='textures.minecraft.net'||url.port||url.username||url.password||url.search||url.hash||!/^\/texture\/[a-f0-9]{32,64}$/i.test(url.pathname))return;
  const model=data.textures.SKIN.metadata?.model??'classic';if(!['classic','slim'].includes(model))return;
  return {hash:url.pathname.split('/').at(-1).toLowerCase(),model,signed:typeof texture.signature==='string'&&texture.signature.length>0};
}

export function createSkinApplication(bot,{timeoutMs=90000,onObserved=()=>{}}={}) {
  let current=null,pending=null,closed=false;
  const receive=packet=>{
    const profile=playerInfoSkin(packet,bot._client.uuid);if(!profile)return;
    current=profile;onObserved({...profile});
    if(pending&&matches(profile,pending.expected))pending.finish(null,{...profile});
  };
  const serverMessage=packet=>{
    if(!pending)return;
    const content=packet?.content??packet?.formattedMessage??'';
    const value=typeof content==='string'?content:JSON.stringify(content);
    if(/command\.unknown\.(?:command|argument)|commands\.generic\.permission|skinrestorer[^"\s]*\.(?:error|failure|failed|no_permission|permission_denied)/i.test(value))pending.finish(new Error('世界未启用 SkinRestorer 换肤命令，或 Bot 没有换肤权限。请检查世界端模组和权限后重试。'));
  };
  const close=(message='皮肤操作已关闭。')=>{
    if(closed)return;closed=true;
    pending?.finish(new Error(message));bot._client.off('player_info',receive);bot._client.off('system_chat',serverMessage);bot.off('end',ended);
  };
  const ended=()=>close('游戏连接已断开，皮肤应用未完成。');
  bot._client.on('player_info',receive);bot._client.on('system_chat',serverMessage);bot.on('end',ended);
  return {
    current:()=>current?{...current}:null,
    close,
    async apply(value,{signal}={}) {
      if(closed)throw new Error('游戏连接已关闭。');
      if(pending)throw new Error('正在等待上一次皮肤应用完成。');
      if(signal?.aborted)throw new Error('皮肤应用已取消。');
      let command,expected;
      if(value?.reset===true){command='/skin clear';expected={hash:null,model:'classic'};}
      else {
        if(!['classic','slim'].includes(value?.model)||typeof value?.url!=='string'||!/^https:\/\/textures\.minecraft\.net\/texture\/[a-f0-9]{32,64}$/i.test(value.url)||value.hash!==value.url.split('/').at(-1).toLowerCase())throw new Error('皮肤纹理地址或体型无效。');
        command=`/skin set web ${value.model} "${value.url}"`;expected={hash:value.hash,model:value.model};
      }
      if(matches(current,expected))return {...current};
      // Once a command is sent, a previous profile can no longer confirm a new operation.
      current=null;
      return new Promise((resolve,reject)=>{
        const operation={expected,finish:null};
        let timer;
        const abort=()=>operation.finish(new Error('皮肤应用已取消。'));
        operation.finish=(error,result)=>{
          if(pending!==operation)return;
          pending=null;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){current=null;reject(error);}else resolve(result);
        };
        pending=operation;signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>operation.finish(new Error('服务器尚未确认皮肤。请检查 SkinRestorer 和网络后重新应用。')),timeoutMs);
        try{bot.chat(command);}catch{operation.finish(new Error('无法向世界发送换肤操作。'));}
      });
    },
  };
}
