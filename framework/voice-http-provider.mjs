import {writeFile} from 'node:fs/promises';
import {WorkbenchError} from './contracts.mjs';
import {completeWav} from './voice.mjs';

/** OpenAI speech PCM is 24 kHz mono signed little-endian PCM16. */
export function pcmVoiceWav(pcm){
  if(!pcm.length||pcm.length%2||pcm.length>32*1024*1024-44)throw new WorkbenchError(502,'HTTP 声音接口未返回有效的 24 kHz PCM16 音频。');
  const wav=Buffer.alloc(pcm.length+44);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);return wav;
}

export async function runHttpVoice(request,{config,fetchImpl=fetch,signal,timeoutMs=90000}={}){
  if(request.mode!=='synthesis')throw new WorkbenchError(400,'此 HTTP 接口不支持声音克隆或文本设计。');
  const response=await fetchImpl(config.httpUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(config.httpApiKey?{Authorization:'Bearer '+config.httpApiKey}:{})},body:JSON.stringify({model:request.model,input:request.text,voice:request.speaker,response_format:'pcm'}),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(Math.min(timeoutMs,90000))])});
  if(!response.ok)throw new WorkbenchError(502,`HTTP 声音接口返回 ${response.status}。`);
  const parts=[];let length=0;
  for await(const chunk of response.body||[]){length+=chunk.length;if(length>32*1024*1024)throw new WorkbenchError(502,'HTTP 声音响应超过 32 MiB。');parts.push(Buffer.from(chunk));}
  const bytes=Buffer.concat(parts),isWav=bytes.toString('latin1',0,4)==='RIFF';
  if(isWav&&!completeWav(bytes))throw new WorkbenchError(502,'HTTP 声音接口 WAV 需要为完整的 24 kHz 单声道 PCM16。');
  const mime=response.headers.get('content-type')||'';
  if(!isWav&&/json|text|mpeg|mp3|ogg|flac/i.test(mime))throw new WorkbenchError(502,'HTTP 声音接口需要支持 response_format=pcm。');
  await writeFile(request.output,isWav?bytes:pcmVoiceWav(bytes),{flag:'wx'});
}
