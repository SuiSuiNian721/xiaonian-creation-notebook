import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visionMessages,codexInputTransport } from '../framework/ai-vision.mjs';

test('参考图作为视觉内容加入制作要求，原对话不被修改',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ai-future-vision-'));
  try{
    const path=join(directory,'reference.png');const bytes=Buffer.from([137,80,78,71]);await writeFile(path,bytes);
    const original=[{role:'system',content:'规则'},{role:'user',content:'按参考制作'}];
    const result=await visionMessages(original,[{path,mime:'image/png'}]);
    assert.equal(original[1].content,'按参考制作');
    assert.deepEqual(result[1].content,[{type:'text',text:'按参考制作'},{type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64')}}]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Codex 传输只扩展 turn/start，实际带入 skill 与 localImage',()=>{
  const stdin=new PassThrough();const lines=[];stdin.on('data',chunk=>lines.push(JSON.parse(String(chunk))));
  const items=[{type:'skill',name:'minecraft-pixel-skin',path:'C:/skill/SKILL.md'},{type:'localImage',path:'C:/work/reference.png'}];
  const child=codexInputTransport(items,{spawnProcess:()=>({stdin})})('codex',[]);
  child.stdin.write(JSON.stringify({id:1,method:'thread/start',params:{}})+'\n');
  child.stdin.write(JSON.stringify({id:2,method:'turn/start',params:{input:[{type:'text',text:'$minecraft-pixel-skin 制作皮肤'}]}})+'\n');
  assert.deepEqual(lines[0].params,{});assert.deepEqual(lines[1].params.input.slice(1),items);
});
