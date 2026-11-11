import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('MC 指定坐标建造使用原生方块、验证结果并保护已有方块',{
  skip:!existsSync(join(root,'integrations/airi-minecraft/node_modules/tsx/package.json')),timeout:30000,
},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mc-build-'));
  try{
    const child=spawn(process.execPath,['--no-node-snapshot',join(root,'tests/fixtures/mc-build.mjs'),directory],{cwd:directory,windowsHide:true});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
    assert.equal(code,0,output);assert.match(output,/MC_BUILD_RESULT/);
  }finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});}
});
