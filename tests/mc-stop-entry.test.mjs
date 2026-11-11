import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('工作台暂停真实 Brain 入口清空自动跟随，动作完成与恢复 AI 均不重启移动',{skip:!existsSync(join(root,'integrations/airi-minecraft/node_modules/tsx/package.json')),timeout:30000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mc-stop-entry-'));
  try{
    const child=spawn(process.execPath,['--no-node-snapshot',join(root,'tests/fixtures/mc-stop-entry.mjs'),directory],{cwd:directory,windowsHide:true});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
    assert.equal(code,0,output);assert.match(output,/MC_STOP_ENTRY_RESULT/);
  }finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});}
});
