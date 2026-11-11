import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {readableLocalPath}=await import('../framework/resource-local-path.mjs').catch(()=>({}));
test('只读本地资源允许显式目录联接，仍拒绝共享路径和链接循环',async t=>{
  assert.equal(typeof readableLocalPath,'function');
  const root=await mkdtemp(join(tmpdir(),'readable-resource-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const actual=join(root,'actual');await mkdir(actual);await writeFile(join(actual,'config.json'),'{}');
  await symlink(actual,join(root,'model-link'),process.platform==='win32'?'junction':'dir');
  assert.equal(await readableLocalPath(join(root,'model-link','config.json')),join(actual,'config.json'));
  await assert.rejects(readableLocalPath('\\\\server\\weights'),/本地|绝对/);
  await symlink(join(root,'loop-b'),join(root,'loop-a'),process.platform==='win32'?'junction':'dir');
  await symlink(join(root,'loop-a'),join(root,'loop-b'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(readableLocalPath(join(root,'loop-a')),/循环|过多/);
});
