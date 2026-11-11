import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DrawingDownloads } from '../framework/drawing-downloads.mjs';

const payload = Buffer.alloc(512 * 1024, 23);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(predicate) {
  for (let i = 0; i < 500; i++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待下载状态超时');
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drawing-download-'));
  const comfyPath = options.comfyPath || join(root, 'ComfyUI'); await mkdir(join(comfyPath, 'comfy'), { recursive:true });
  for (const file of ['main.py','server.py','nodes.py']) await writeFile(join(comfyPath, file), '# fixture');
  const settings = new Map(); const requests = [];
  const store = { getSetting:key => structuredClone(settings.get(key)), setSetting:(key, value) => settings.set(key, structuredClone(value)) };
  const flags = { slow:false, ignoreRange:false, wrongRange:false, changeEtag:false, noLength:false, html:false, ...options };
  const server = createServer((req, res) => {
    const content = flags.content || payload;
    requests.push({ range:req.headers.range, ifRange:req.headers['if-range'], url:req.url });
    let offset = Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
    const ranged = Boolean(req.headers.range) && !flags.ignoreRange;
    if (!ranged) offset = 0;
    res.writeHead(ranged ? 206 : 200, {
      'content-type':flags.html ? 'text/html' : 'application/octet-stream',
      etag: flags.changeEtag && ranged ? '"different"' : '"model-v1"',
      ...(!flags.noLength ? { 'content-length':content.length - offset } : {}),
      ...(ranged ? { 'content-range':`bytes ${flags.wrongRange ? offset + 1 : offset}-${content.length - 1}/${content.length}` } : {}),
    });
    let cursor = offset;
    const pump = () => {
      if (res.destroyed) return;
      if (cursor >= content.length) { res.end(); return; }
      const end = Math.min(cursor + 16384, content.length); res.write(content.subarray(cursor, end)); cursor = end;
      if (flags.slow) setTimeout(pump, 12); else setImmediate(pump);
    }; pump();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { comfyPath };
  const args = { store, directory:join(root, 'private'), config:() => config, ...options.engine };
  let downloads = new DrawingDownloads(args);
  t.after(async () => { await downloads.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, {recursive:true, force:true}); });
  return { root, comfyPath, config, flags, requests, settings, store, get downloads() { return downloads; },
    input:(extra = {}) => ({requestId:randomUUID(),url:`http://127.0.0.1:${server.address().port}/model?token=private`,category:'loras',filename:'测试模型.safetensors',sha256:digest(payload),...extra}),
    restart:async () => { await downloads.close(); downloads = new DrawingDownloads(args); },
    completed:async id => until(() => { const task=downloads.get(id); return ['completed','failed','paused','interrupted'].includes(task.status) && task; }),
  };
}

test('真实流式下载完成后才发布模型，校验来源哈希且公开状态不泄露查询令牌', async t => {
  const f=await fixture(t,{slow:true}); const input=f.input(); const task=await f.downloads.start(input);
  assert.equal(task.filename,input.filename); assert.equal(JSON.stringify(task).includes('private'),false);
  await assert.rejects(stat(join(f.comfyPath,'models/loras',input.filename)), {code:'ENOENT'});
  const done=await f.completed(task.id); assert.equal(done.status,'completed',done.error); assert.equal(done.verification,'sha256');
  assert.equal(done.actualSha256,digest(payload)); assert.deepEqual(await readFile(done.target),payload);
  assert.equal(JSON.stringify(f.downloads.list()).includes('token='),false);
});

test('同一请求并发重试只建立一个任务，已占用目标或相同标识不同内容拒绝',async t=>{
  const f=await fixture(t);const input=f.input();const [a,b]=await Promise.all([f.downloads.start(input),f.downloads.start(input)]);
  assert.equal(a.id,b.id);await f.completed(a.id);assert.equal(f.requests.length,1);
  await assert.rejects(f.downloads.start({...input,filename:'另一个.safetensors'}),/请求标识/);
  await assert.rejects(f.downloads.start(f.input()),/已存在|同名/);
  assert.deepEqual(await readFile(f.downloads.get(a.id).target),payload);
});

test('工作流勾选多项可持久排队，仍最多两个并行下载',async t=>{
  const f=await fixture(t,{slow:true});
  const tasks=[];for(let index=0;index<4;index++)tasks.push(await f.downloads.start(f.input({filename:`queued-${index}.safetensors`}),{queue:true}));
  assert.equal(f.downloads.list().length,4);assert.equal(f.downloads.active.size,2);assert.equal(f.downloads.get(tasks[3].id).status,'queued');
  await f.downloads.pause(tasks[3].id);assert.equal(f.downloads.get(tasks[3].id).status,'paused');
  for(const task of tasks.slice(0,3))assert.equal((await f.completed(task.id)).status,'completed');
  assert.equal(f.requests.length,3);
});

test('暂停保留部分文件，继续发送 Range 与 If-Range 并验证最终字节',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());
  await until(()=>f.downloads.get(task.id).downloadedBytes>0);await f.downloads.pause(task.id);
  const paused=f.downloads.get(task.id);assert.equal(paused.status,'paused');assert.ok(paused.downloadedBytes<payload.length);
  await f.downloads.resume(task.id);const done=await f.completed(task.id);assert.equal(done.status,'completed',done.error);
  assert.ok(f.requests.some(r=>/^bytes=[1-9]\d*-$/.test(r.range)&&r.ifRange==='"model-v1"'));assert.deepEqual(await readFile(done.target),payload);
});

test('服务忽略 Range 时重新完整下载，不能把两份内容拼接',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());await until(()=>f.downloads.get(task.id).downloadedBytes>0);await f.downloads.pause(task.id);
  f.flags.ignoreRange=true;await f.downloads.resume(task.id);const done=await f.completed(task.id);assert.equal(done.status,'completed',done.error);assert.deepEqual(await readFile(done.target),payload);
});

test('忽略 Range 的新文件与旧部分文件等长时，截断失败不能把旧前缀认作完成',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input({sha256:''}));await until(()=>f.downloads.get(task.id).downloadedBytes>0);await f.downloads.pause(task.id);
  const partial=join(f.root,'private/downloads',task.id+'.part');const size=(await stat(partial)).size;const changed=Buffer.alloc(size,77);
  f.flags.ignoreRange=true;f.flags.content=changed;await chmod(partial,0o444);
  try { await f.downloads.resume(task.id);const failed=await f.completed(task.id);assert.equal(failed.status,'failed'); }
  finally { await chmod(partial,0o666); }
  await f.downloads.resume(task.id);const done=await f.completed(task.id);assert.equal(done.status,'completed',done.error);assert.equal((await readFile(done.target)).equals(changed),true,'最终文件必须是服务器新返回的内容');
});

for(const flag of ['wrongRange','changeEtag'])test(`拒绝续传响应 ${flag}，保留失败记录且不发布`,async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());await until(()=>f.downloads.get(task.id).downloadedBytes>0);await f.downloads.pause(task.id);
  f.flags[flag]=true;await f.downloads.resume(task.id);const failed=await f.completed(task.id);assert.equal(failed.status,'failed');assert.match(failed.error,/续传|范围|内容已变化/);
  await assert.rejects(stat(failed.target),{code:'ENOENT'});
});

test('SHA256 不匹配和 HTML 登录页都不能成为模型文件',async t=>{
  const f=await fixture(t);const bad=await f.downloads.start(f.input({sha256:'0'.repeat(64)}));const failed=await f.completed(bad.id);
  assert.equal(failed.status,'failed');assert.match(failed.error,/SHA256/);await assert.rejects(stat(failed.target),{code:'ENOENT'});
  f.flags.html=true;const html=await f.downloads.start(f.input({filename:'网页.safetensors'}));assert.equal((await f.completed(html.id)).status,'failed');
});

test('无预期哈希时只标记计算本地哈希，未知长度也能完成',async t=>{
  const f=await fixture(t,{noLength:true});const task=await f.downloads.start(f.input({sha256:''}));const done=await f.completed(task.id);
  assert.equal(done.status,'completed',done.error);assert.equal(done.verification,'calculated');assert.equal(done.actualSha256,digest(payload));
});

test('关闭和重启后保持中断，用户继续才联网；固定原安装目标',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());await until(()=>f.downloads.get(task.id).downloadedBytes>0);
  await f.restart();const count=f.requests.length;assert.equal(f.downloads.get(task.id).status,'interrupted');await new Promise(r=>setTimeout(r,50));assert.equal(f.requests.length,count);
  f.config.comfyPath=join(f.root,'other');await f.downloads.resume(task.id);const done=await f.completed(task.id);assert.equal(done.status,'completed',done.error);assert.ok(done.target.startsWith(f.comfyPath));
});

test('并发继续同一任务只创建一个请求，关闭后部分文件不再增长',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());await until(()=>f.downloads.get(task.id).downloadedBytes>0);await f.downloads.pause(task.id);
  await Promise.all([f.downloads.resume(task.id),f.downloads.resume(task.id)]);await until(()=>f.requests.length>=2);await f.downloads.close();
  const partial=join(f.root,'private/downloads',task.id+'.part');const size=(await stat(partial)).size;await new Promise(r=>setTimeout(r,100));
  assert.equal(f.requests.length,2);assert.equal((await stat(partial)).size,size);assert.equal(f.downloads.get(task.id).status,'interrupted');
});

test('空间不足时在接收模型之前失败，且不覆盖既有文件',async t=>{
  const f=await fixture(t,{engine:{statfsImpl:async()=>({bavail:1,bsize:1})}});const task=await f.downloads.start(f.input());const failed=await f.completed(task.id);
  assert.equal(failed.status,'failed');assert.match(failed.error,/空间/);await assert.rejects(stat(failed.target),{code:'ENOENT'});
});

test('文件已下载完整但发布失败时可直接重新校验发布，不请求无效末尾范围',async t=>{
  const f=await fixture(t);const task=await f.downloads.start(f.input());const done=await f.completed(task.id);assert.equal(done.status,'completed');
  // Wait for post-publication cleanup before constructing the simulated pre-publication crash state.
  await f.downloads.close();
  const partial=join(f.root,'private/downloads',task.id+'.part');await writeFile(partial,payload);await rm(done.target);
  const saved=f.settings.get('drawing.downloads');saved[0].status='interrupted';saved[0].error='模拟发布前断电';f.settings.set('drawing.downloads',saved);
  await f.restart();const count=f.requests.length;await f.downloads.resume(task.id);const restored=await f.completed(task.id);
  assert.equal(restored.status,'completed',restored.error);assert.equal(f.requests.length,count);assert.deepEqual(await readFile(restored.target),payload);
});

test('满长部分文件未写入完成标记时安全重新下载，不反复请求末尾Range',async t=>{
  const f=await fixture(t);const task=await f.downloads.start(f.input({sha256:''}));const done=await f.completed(task.id);await f.downloads.close();
  const partial=join(f.root,'private/downloads',task.id+'.part');await writeFile(partial,payload);await rm(done.target);
  const saved=f.settings.get('drawing.downloads');Object.assign(saved[0],{status:'interrupted',downloadComplete:false,actualSha256:null});f.settings.set('drawing.downloads',saved);
  await f.restart();const count=f.requests.length;await f.downloads.resume(task.id);const restored=await f.completed(task.id);
  assert.equal(restored.status,'completed',restored.error);assert.equal(f.requests.length,count+1);assert.equal(f.requests.at(-1).range,undefined);
});

test('完成状态落盘后清理前崩溃，重启回收自己的私有部分文件与发布副本',async t=>{
  const f=await fixture(t);const task=await f.downloads.start(f.input());const done=await f.completed(task.id);await f.downloads.close();
  const partial=join(f.root,'private/downloads',task.id+'.part'),stageRoot=join(f.comfyPath,'temp/ai-future-downloads');await mkdir(stageRoot,{recursive:true});const staged=join(stageRoot,task.id+'.part');
  await writeFile(partial,payload);await writeFile(staged,payload);await f.restart();await f.downloads.close();
  await assert.rejects(stat(partial),{code:'ENOENT'});await assert.rejects(stat(staged),{code:'ENOENT'});assert.equal(digest(await readFile(done.target)),digest(payload));
});

test('下载期间目标被另一个程序创建时保留原文件',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());await mkdir(join(f.comfyPath,'models/loras'),{recursive:true});await writeFile(task.target,'原文件');
  const failed=await f.completed(task.id);assert.equal(failed.status,'failed');assert.equal(await readFile(task.target,'utf8'),'原文件');
});

test('拒绝路径穿越、可执行扩展、设备名、URL认证及链接目标',async t=>{
  const f=await fixture(t);for(const patch of [{category:'../outside'},{filename:'../x.safetensors'},{filename:'node.py'},{filename:'NUL.safetensors'},{url:'https://name:secret@example.com/model'}]) await assert.rejects(f.downloads.start(f.input(patch)));
  const outside=join(f.root,'outside');await mkdir(outside);await mkdir(join(f.comfyPath,'models'),{recursive:true});await symlink(outside,join(f.comfyPath,'models/loras'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.downloads.start(f.input()),/链接|联接/);assert.equal(f.requests.length,0);
});

test('下载中的存储故障停止任务并留下可见错误，不产生未处理后台拒绝',async t=>{
  const f=await fixture(t,{slow:true});const task=await f.downloads.start(f.input());
  f.store.setSetting=()=>{throw new Error('数据库只读');};await new Promise(r=>setTimeout(r,100));
  await f.downloads.close();assert.equal(f.downloads.get(task.id).status,'failed');assert.match(f.downloads.get(task.id).error,/保存下载记录/);
});

test('重启继续回收本任务的发布中间文件，跨卷发布仍校验并保留其他任务文件',async t=>{
  const qaRoot=join(process.cwd(),'qa','drawing-manager');await mkdir(qaRoot,{recursive:true});
  const external=await mkdtemp(join(qaRoot,'cross-volume-'));t.after(()=>rm(external,{recursive:true,force:true}));
  const f=await fixture(t,{slow:true,comfyPath:join(external,'ComfyUI')});const task=await f.downloads.start(f.input());await until(()=>f.downloads.get(task.id).downloadedBytes>0);await f.downloads.pause(task.id);
  const stageRoot=join(f.comfyPath,'temp/ai-future-downloads');await mkdir(stageRoot,{recursive:true});
  const staged=join(stageRoot,task.id+'.part'),other=join(stageRoot,'another-task.part');await writeFile(staged,Buffer.alloc(1024));await writeFile(other,'其他任务');
  await f.restart();await f.downloads.resume(task.id);const done=await f.completed(task.id);assert.equal(done.status,'completed',done.error);await f.downloads.close();
  await assert.rejects(stat(staged),{code:'ENOENT'});assert.equal(await readFile(other,'utf8'),'其他任务');assert.equal(digest(await readFile(done.target)),digest(payload));
  t.diagnostic(`源磁盘 dev=${(await stat(f.root)).dev}，目标磁盘 dev=${(await stat(f.comfyPath)).dev}`);
});
