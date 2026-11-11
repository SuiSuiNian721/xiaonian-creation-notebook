export function voiceReference(result,{text='',name='生成的声音',provider='moss'}={}){
  const url=new URL(result.url,location.href),match=url.pathname.match(/^(?:\/instances\/[a-f0-9-]{36})?\/internal\/voice-audio\/([a-f0-9]{64})\/([a-f0-9]{64})$/);
  if(url.origin!==location.origin||!match||url.search||url.hash)throw new Error('生成音频的地址无效，请重新生成。');
  return {id:match[1],signature:match[2],name,transcript:text,provider:provider==='qwen3-tts'?'qwen3-tts':'moss'};
}

export function referenceURL(reference,ctx){
  const path='/internal/voice-audio/'+reference.id+'/'+reference.signature;
  return ctx.url?ctx.url(path):path;
}
