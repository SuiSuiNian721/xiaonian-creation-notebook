import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const python=process.env.NEXT_TRAINER_KOHYA_PYTHON;
test('SDXL checkpoint loader supports old and current CLIP layouts with strict tensor checks', {skip:!python,timeout:60000}, async()=>{
  const child=spawn(python,['-X','utf8','-B',fileURLToPath(new URL('./test_sdxl_clip_loading.py',import.meta.url))],{windowsHide:true,env:{...process.env,HF_HUB_OFFLINE:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});
  assert.equal(code,0,output);assert.match(output,/Ran 4 tests/);
});
