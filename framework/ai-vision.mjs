import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { WorkbenchError } from './contracts.mjs';

export async function visionMessages(messages,images){
  if(!Array.isArray(images)||images.length>4)throw new WorkbenchError(400,'一次最多提供四张制作参考。');
  if(!images.length)return messages;
  const content=[];
  for(const image of images){
    if(!image||typeof image.path!=='string'||!['image/png','image/jpeg','image/webp'].includes(image.mime))throw new WorkbenchError(400,'视觉输入格式无效。');
    const bytes=await readFile(image.path);if(bytes.length>8*1024*1024)throw new WorkbenchError(400,'参考图不能超过 8 MiB。');
    content.push({type:'image_url',image_url:{url:`data:${image.mime};base64,${bytes.toString('base64')}`}});
  }
  const next=messages.map(message=>({...message}));const last=next.findLast(message=>message.role==='user');
  if(!last)throw new WorkbenchError(400,'视觉请求需要制作要求。');
  last.content=[{type:'text',text:last.content},...content];return next;
}

// The bundled card bridge owns process lifecycle and authentication. This local
// transport adds official turn/start input items without modifying its snapshot.
export function codexInputTransport(items,{spawnProcess=spawn,outputSchema}={}){
  return (...args)=>{
    const child=spawnProcess(...args);const write=child.stdin.write.bind(child.stdin);
    child.stdin.write=(chunk,...writeArgs)=>{
      let message;try{message=JSON.parse(String(chunk));}catch{return write(chunk,...writeArgs);}
      if(message.method==='turn/start'){
        message.params.input.push(...items);
        if(outputSchema)message.params.outputSchema=outputSchema;
        return write(JSON.stringify(message)+'\n',...writeArgs);
      }
      return write(chunk,...writeArgs);
    };
    return child;
  };
}
