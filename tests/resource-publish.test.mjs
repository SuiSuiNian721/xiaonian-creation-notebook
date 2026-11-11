import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as download from '../framework/vision-download.mjs';
test('完整资源发布不覆盖后来出现的用户文件，并保留可恢复的分片',async t=>{
  assert.equal(typeof download.publishVerifiedPartial,'function');
  const root=await mkdtemp(join(tmpdir(),'resource-publish-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const partial=join(root,'model.part'),target=join(root,'model.bin');await writeFile(partial,'verified model');await writeFile(target,'user file');
  await assert.rejects(download.publishVerifiedPartial(partial,target,new AbortController().signal),error=>error.status===409);
  assert.equal(await readFile(target,'utf8'),'user file');assert.equal(await readFile(partial,'utf8'),'verified model');
  await rm(target);await download.publishVerifiedPartial(partial,target,new AbortController().signal);
  assert.equal(await readFile(target,'utf8'),'verified model');await assert.rejects(access(partial),{code:'ENOENT'});
});
