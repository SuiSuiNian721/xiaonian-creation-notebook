import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const electron='F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
test('声音生成与克隆桌面完成试听、保存、共享、绑定、取消和下载进度',{skip:!existsSync(electron),timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-studio-ui-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  const env={...process.env,AI_FUTURE_VOICE_STUDIO_QA_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;delete env.AI_FUTURE_VOICE_REAL;
  const result=await new Promise((done,reject)=>{const child=spawn(electron,[resolve('tools/qa-voice-studio.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});child.on('error',reject);child.on('exit',code=>done({code,output}));});
  assert.equal(result.code,0,result.output);const report=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));assert.equal(report.ok,true);assert.equal(report.realInference,false);assert.equal(report.voices.length,3);assert.equal(report.batch.length,2);
});
