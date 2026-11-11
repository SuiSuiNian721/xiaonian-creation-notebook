import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const electron='F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
test('Qwen三种模型在桌面独立准备、下载、取消续传和显式绑定',{skip:!existsSync(electron),timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-model-download-ui-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const env={...process.env,AI_FUTURE_VOICE_MODEL_QA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const result=await new Promise((done,reject)=>{const child=spawn(electron,[resolve('tools/qa-voice-model-downloads.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});child.on('error',reject);child.on('exit',code=>done({code,output}));});assert.equal(result.code,0,result.output);
});
