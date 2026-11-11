import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createComponentArchive } from '../framework/component-archive.mjs';
import { OptionalComponents } from '../framework/optional-components.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-components-manager-'));
  const source = join(directory, 'source'); await mkdir(source);
  await writeFile(join(source, 'runner.py'), 'print("组件")\n');
  await writeFile(join(source, 'catalog.json'), '{}');
  await writeFile(join(source, 'source-manifest.json'), '{"format":1,"files":[]}');
  const archive = join(directory, 'training.afcomponent');
  const descriptor = await createComponentArchive({ id: 'training', name: '训练组件', version: '1.0.0', sources: [{ from: source }], output: archive });
  const settings = new Map();
  const store = { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, structuredClone(value)) };
  const dataDir = join(directory, 'profile');
  const config = { dataDir, store, catalog: { format: 1, components: { training: descriptor } }, candidates: {}, ...options };
  const managers = [], cleanups = [];
  function manager(extra = {}) { const controller = new OptionalComponents({ ...config, ...extra }); managers.push(controller); return controller; }
  t.after(async () => {
    for (const controller of managers) {
      try { await controller.close(); } finally { controller.db?.close(); controller.db = null; }
    }
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, source, archive, descriptor, store, dataDir, manager, config, cleanup: callback => cleanups.push(callback) };
}
async function finish(controller, id = 'training') {
  for (let i = 0; i < 200; i++) {
    const component = (await controller.state()).components.find(item => item.id === id);
    if (['completed', 'failed', 'cancelled'].includes(component.task?.status)) return component;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('组件任务没有结束');
}

test('空安装不发下载，真实本地组件安装后跨实例复用且保留个人资料', async t => {
  const f = await fixture(t), controller = f.manager({ fetchImpl: () => assert.fail('本地导入不应联网') });
  assert.equal(controller.resolve('training'), null);
  assert.equal((await controller.state()).components.find(item => item.id === 'training').ready, false);
  await controller.install('training', { file: f.archive });
  const installed = await finish(controller);
  assert.equal(installed.task.status, 'completed', installed.task.error);
  assert.equal(installed.origin, 'managed');
  assert.equal(await readFile(join(controller.resolve('training').path, 'runner.py'), 'utf8'), 'print("组件")\n');
  const peer = f.manager();
  assert.equal(peer.resolve('training').path, controller.resolve('training').path);
  await mkdir(join(f.dataDir, 'training-output'), { recursive: true });
  await writeFile(join(f.dataDir, 'training-output', 'personal.safetensors'), '保留作品');
  const plan = await controller.plan({ id: 'training', action: 'uninstall' });
  assert.ok(plan.bytes > 0);
  await controller.execute({ planId: plan.planId, confirmed: true });
  assert.equal(controller.resolve('training'), null);
  assert.equal(await readFile(join(f.dataDir, 'training-output', 'personal.safetensors'), 'utf8'), '保留作品');
});

test('活动租约跨管理器阻止卸载，释放后才能删除', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const lease = await controller.acquire('training', 'training:test');
  const peer = f.manager();
  await assert.rejects(peer.plan({ id: 'training', action: 'uninstall' }), /使用|活动/);
  lease.retain(process.pid);
  lease.release();
  const plan = await peer.plan({ id: 'training', action: 'uninstall' });
  await peer.execute({ planId: plan.planId, confirmed: true });
  assert.equal(controller.resolve('training'), null);
});

test('外部已有组件只读复用，不提供删除或产生副本', async t => {
  const f = await fixture(t), controller = f.manager({ candidates: { training: [{ path: f.source }] } });
  assert.equal(controller.resolve('training').origin, 'existing');
  const lease = await controller.acquire('training', 'existing');
  assert.equal(lease.path, f.source); lease.release();
  await assert.rejects(controller.plan({ id: 'training', action: 'uninstall' }), /外部|复用|受管/);
  assert.equal(await readFile(join(f.source, 'runner.py'), 'utf8'), 'print("组件")\n');
});

test('固定目录经真实 HTTP 下载，缓存可单独回收且不破坏已安装组件', async t => {
  const f = await fixture(t), bytes = await readFile(f.archive); let requests = 0;
  const server = createServer((req, res) => { requests++; assert.equal(req.url, '/training.afcomponent'); res.writeHead(200, { 'content-length': bytes.length }); res.end(bytes); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const controller = f.manager();
  await controller.setSource({ url: `http://127.0.0.1:${server.address().port}/` });
  await controller.install('training');
  assert.equal((await finish(controller)).task.status, 'completed');
  assert.equal(requests, 1);
  const storage = await controller.storage();
  assert.ok(storage.cacheBytes >= bytes.length);
  const plan = await controller.plan({ id: 'cache', action: 'cleanup' });
  await controller.execute({ planId: plan.planId, confirmed: true });
  assert.equal((await controller.storage()).cacheBytes, 0);
  assert.equal(controller.resolve('training').origin, 'managed');
});

test('未知文件和计划生成后的改变会阻止卸载', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const installed = controller.resolve('training').path;
  const plan = await controller.plan({ id: 'training', action: 'uninstall' });
  await writeFile(join(installed, 'runner.py'), '修改后的内容');
  await assert.rejects(controller.execute({ planId: plan.planId, confirmed: true }), /变化|失效|重新/);
  await writeFile(join(installed, 'personal.txt'), '用户文件');
  await assert.rejects(controller.plan({ id: 'training', action: 'uninstall' }), /未知|清单/);
  assert.equal(await readFile(join(installed, 'personal.txt'), 'utf8'), '用户文件');
});

test('整包损坏只失败当前组件，不产生可用安装', async t => {
  const f = await fixture(t), controller = f.manager();
  await writeFile(f.archive, '损坏压缩包');
  await controller.install('training', { file: f.archive });
  const component = await finish(controller);
  assert.equal(component.task.status, 'failed');
  assert.equal(controller.resolve('training'), null);
  assert.match(component.task.error, /SHA|校验/);
});

function sqliteStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY,value TEXT);');
  return { db, getSetting: key => { const row = db.prepare('SELECT value FROM settings WHERE name=?').get(key); return row && JSON.parse(row.value); }, setSetting: (key, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value)) };
}

test('独立 SQLite 连接并行更新组件记录不会丢失另一个任务', async t => {
  const f = await fixture(t), database = join(f.directory, 'settings.sqlite'), store = sqliteStore(database);
  f.cleanup(() => store.db.close());
  const controller = f.manager({ store }); await controller.ready();
  const barrier = new SharedArrayBuffer(4), moduleUrl = new URL('../framework/optional-components.mjs', import.meta.url).href;
  const script = `
    const {workerData,parentPort}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    (async()=>{
      const {OptionalComponents}=await import(workerData.moduleUrl);
      const db=new DatabaseSync(workerData.database);db.exec('PRAGMA busy_timeout=5000');
      const signal=new Int32Array(workerData.barrier),pause=new Int32Array(new SharedArrayBuffer(4));
      const store={getSetting(key){const row=db.prepare('SELECT value FROM settings WHERE name=?').get(key);Atomics.wait(pause,0,0,4);return row&&JSON.parse(row.value)},setSetting(key,value){db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value))}};
      const manager=new OptionalComponents({dataDir:workerData.dataDir,store,catalog:{format:1,components:{}},candidates:{}});
      await manager.ready();Atomics.add(signal,0,1);Atomics.notify(signal,0);while(Atomics.load(signal,0)<2)Atomics.wait(signal,0,1,1000);
      for(let i=0;i<12;i++)manager.save(value=>{value.tasks[workerData.id]={count:(value.tasks[workerData.id]?.count||0)+1}});
      await manager.close();db.close();parentPort.postMessage('done');
    })().catch(error=>{throw error});`;
  const workers = ['training', 'mc-play'].map(id => new Worker(script, { eval: true, workerData: { moduleUrl, database, dataDir: f.dataDir, barrier, id } }));
  f.cleanup(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(async worker => { const [code] = await once(worker, 'exit'); assert.equal(code, 0); }));
  assert.equal(store.getSetting('optional-components.v1').tasks.training?.count, 12);
  assert.equal(store.getSetting('optional-components.v1').tasks['mc-play']?.count, 12);
});

test('开始记录保存失败会释放操作锁，之后仍能重新安装', async t => {
  const f = await fixture(t), write = f.store.setSetting; let failWrite = true;
  f.store.setSetting = (key, value) => { if (failWrite) throw new Error('模拟磁盘写入失败'); write(key, value); };
  const controller = f.manager();
  await assert.rejects(controller.install('training', { file: f.archive }), /写入失败/);
  assert.equal(controller.jobs.has('training'), false);
  assert.equal(controller.db.prepare('SELECT count(*) AS count FROM operations').get().count, 0);
  failWrite = false;
  await controller.install('training', { file: f.archive });
  assert.equal((await finish(controller)).task.status, 'completed');
});

test('结束记录保存失败可见且不会留下本进程互斥锁', async t => {
  const f = await fixture(t), write = f.store.setSetting;
  f.store.setSetting = (key, value) => { if (value.tasks?.training?.status === 'completed') throw new Error('模拟结束保存失败'); write(key, value); };
  const controller = f.manager();
  await controller.install('training', { file: f.archive });
  const pending = controller.jobs.get('training').promise;
  await pending.catch(() => {});
  assert.equal(controller.jobs.has('training'), false);
  assert.equal(controller.db.prepare('SELECT count(*) AS count FROM operations').get().count, 0);
  const current = (await controller.state()).components.find(item => item.id === 'training');
  assert.equal(current.task.status, 'failed');
  assert.match(current.task.error, /保存失败/);
  f.store.setSetting = write;
  const peer = f.manager(), plan = await peer.plan({ id: 'training', action: 'uninstall' });
  await peer.execute({ planId: plan.planId, confirmed: true });
  await peer.install('training', { file: f.archive }); await finish(peer);
  assert.equal((await finish(controller)).task.status, 'completed');
});

test('升级后的已登记旧版本可回收，当前版本及未知目录保留', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const previous = controller.resolve('training').path;
  const archive = join(f.directory, 'training-next.afcomponent');
  const descriptor = await createComponentArchive({ id: 'training', version: '2.0.0', sources: [{ from: f.source }], output: archive });
  const peer = f.manager({ catalog: { format: 1, components: { training: descriptor } } });
  await peer.install('training', { file: archive }); assert.equal((await finish(peer)).task.status, 'completed');
  const current = peer.resolve('training').path, unknown = join(peer.directory, 'packages', 'personal-folder');
  await mkdir(unknown); await writeFile(join(unknown, 'personal.txt'), '保留');
  const storage = await peer.storage();
  assert.ok(storage.trees?.some(tree => tree.path === previous), '旧版本必须进入回收清单');
  assert.ok(!storage.trees.some(tree => tree.path === current || tree.path === unknown));
  const plan = await peer.plan({ id: 'cache', action: 'cleanup' });
  await peer.execute({ planId: plan.planId, confirmed: true });
  await assert.rejects(stat(previous), { code: 'ENOENT' });
  assert.equal(await readFile(join(current, 'runner.py'), 'utf8'), 'print("组件")\n');
  assert.equal(await readFile(join(unknown, 'personal.txt'), 'utf8'), '保留');
});

test('已登记旧版本出现未知文件或 junction 时回收拒绝删除', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const previous = controller.resolve('training').path;
  const archive = join(f.directory, 'training-next.afcomponent');
  const descriptor = await createComponentArchive({ id: 'training', version: '2.0.0', sources: [{ from: f.source }], output: archive });
  const peer = f.manager({ catalog: { format: 1, components: { training: descriptor } } });
  await peer.install('training', { file: archive }); await finish(peer);
  await writeFile(join(previous, 'personal.txt'), '不能删除');
  await assert.rejects(peer.plan({ id: 'cache', action: 'cleanup' }), /未知/);
  await rm(join(previous, 'personal.txt'));
  const external = join(f.directory, 'external'); await mkdir(external); await writeFile(join(external, 'personal.txt'), '外部保留');
  await symlink(external, join(previous, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(peer.plan({ id: 'cache', action: 'cleanup' }), /链接|junction/);
  assert.equal(await readFile(join(external, 'personal.txt'), 'utf8'), '外部保留');
});

async function interruptInstall(f, database, phase) {
  const moduleUrl = new URL('../framework/optional-components.mjs', import.meta.url).href;
  const script = `
    import {DatabaseSync} from 'node:sqlite';
    const [moduleUrl,dataDir,database,archive,json,phase]=process.argv.slice(1);
    const {OptionalComponents}=await import(moduleUrl),db=new DatabaseSync(database);
    const store={getSetting(key){const row=db.prepare('SELECT value FROM settings WHERE name=?').get(key);return row&&JSON.parse(row.value)},setSetting(key,value){if(phase==='published'&&value.installed.training)process.exit(39);db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value))}};
    const manager=new OptionalComponents({dataDir,store,catalog:{format:1,components:{training:JSON.parse(json)}},candidates:{}});
    await manager.install('training',{file:archive});
    const task=manager.jobs.get('training').task;
    if(phase==='extracting')Object.defineProperty(task,'completedBytes',{get(){return 0},set(value){if(value>0)process.exit(37)}});
    await manager.jobs.get('training').promise;process.exit(38);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, f.dataDir, database, f.archive, JSON.stringify(f.descriptor), phase], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit'); assert.equal(code, phase === 'extracting' ? 37 : 39, stderr);
}

test('安装子进程中断后的已登记暂存可回收并重新安装', async t => {
  const f = await fixture(t), database = join(f.directory, 'settings.sqlite'), store = sqliteStore(database);
  f.cleanup(() => store.db.close());
  await interruptInstall(f, database, 'extracting');
  const controller = f.manager({ store }), packages = join(controller.directory, 'packages');
  const staging = (await readdir(packages)).filter(name => name.startsWith('.staging-')); assert.equal(staging.length, 1);
  const plan = await controller.plan({ id: 'cache', action: 'cleanup' });
  assert.ok(plan.bytes > 0, '中断暂存应计入可回收空间');
  await controller.execute({ planId: plan.planId, confirmed: true });
  await assert.rejects(stat(join(packages, staging[0])), { code: 'ENOENT' });
  await controller.install('training', { file: f.archive });
  assert.equal((await finish(controller)).task.status, 'completed');
});

test('发布目录完成但记录未保存时可复核恢复，且不重新读取组件包', async t => {
  const f = await fixture(t), database = join(f.directory, 'settings.sqlite'), store = sqliteStore(database);
  f.cleanup(() => store.db.close());
  await interruptInstall(f, database, 'published');
  const controller = f.manager({ store, fetchImpl: () => assert.fail('恢复不应下载') });
  assert.equal(controller.resolve('training'), null);
  await controller.install('training', { file: join(f.directory, '不存在.afcomponent') });
  assert.equal((await finish(controller)).task.status, 'completed');
  const lease = await controller.acquire('training', 'recovered'); lease.release();
  assert.equal((await controller.storage()).cacheBytes, 0);
});

test('取消解压清理本次暂存，释放锁后可再次安装', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive });
  const job = controller.jobs.get('training'); let cancelled;
  Object.defineProperty(job.task, 'completedBytes', { get() { return 0; }, set(value) { if (value > 0 && !cancelled) cancelled = controller.cancel('training'); } });
  await job.promise; await cancelled;
  assert.equal((await controller.state()).components.find(item => item.id === 'training').task.status, 'cancelled');
  assert.equal(controller.resolve('training'), null);
  assert.deepEqual(await readdir(join(controller.directory, 'packages')), []);
  assert.equal(controller.db.prepare('SELECT count(*) AS count FROM operations').get().count, 0);
  await controller.install('training', { file: f.archive });
  assert.equal((await finish(controller)).task.status, 'completed');
});

test('旧版本计划生成后的文件修改会阻止回收，个人修改保持原样', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const previous = controller.resolve('training').path, archive = join(f.directory, 'training-next.afcomponent');
  const descriptor = await createComponentArchive({ id: 'training', version: '2.0.0', sources: [{ from: f.source }], output: archive });
  const peer = f.manager({ catalog: { format: 1, components: { training: descriptor } } });
  await peer.install('training', { file: archive }); await finish(peer);
  const plan = await peer.plan({ id: 'cache', action: 'cleanup' });
  await writeFile(join(previous, 'runner.py'), '个人修改');
  await assert.rejects(peer.execute({ planId: plan.planId, confirmed: true }), /改变|变化/);
  assert.equal(await readFile(join(previous, 'runner.py'), 'utf8'), '个人修改');
});

test('卸载删除完成但保存失败后能重新确认并完成登记回收', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const plan = await controller.plan({ id: 'training', action: 'uninstall' }), write = f.store.setSetting;
  f.store.setSetting = (key, value) => { if (!value.installed.training) throw new Error('模拟卸载保存失败'); write(key, value); };
  await assert.rejects(controller.execute({ planId: plan.planId, confirmed: true }), /保存失败/);
  f.store.setSetting = write;
  const interrupted = (await controller.state()).components.find(item => item.id === 'training');
  assert.equal(interrupted.ready, false); assert.equal(interrupted.managed, true); assert.equal(interrupted.canResumeUninstall, true);
  const retry = await controller.plan({ id: 'training', action: 'uninstall' });
  await controller.execute({ planId: retry.planId, confirmed: true });
  assert.equal(f.store.getSetting('optional-components.v1').installed.training, undefined);
  await controller.install('training', { file: f.archive });
  assert.equal((await finish(controller)).task.status, 'completed');
});

test('有移除登记的部分卸载可继续，但未知文件仍阻止删除', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const directory = controller.resolve('training').path;
  controller.db.prepare('UPDATE trees SET kind=? WHERE path=?').run('removing', directory);
  assert.equal(controller.resolve('training'), null, '已开始卸载的组件不能再启动');
  await rm(join(directory, '.component-owner.json')); await rm(join(directory, '.component-manifest.json')); await rm(join(directory, 'catalog.json'));
  const interrupted = (await controller.state()).components.find(item => item.id === 'training');
  assert.equal(interrupted.ready, false); assert.equal(interrupted.managed, true); assert.equal(interrupted.canResumeUninstall, true);
  await writeFile(join(directory, 'personal.txt'), '保留');
  await assert.rejects(controller.plan({ id: 'training', action: 'uninstall' }), /未知/);
  await rm(join(directory, 'personal.txt'));
  const retry = await controller.plan({ id: 'training', action: 'uninstall' });
  await controller.execute({ planId: retry.planId, confirmed: true });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('关闭等待已经开始的卸载并立即拒绝新安装', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.install('training', { file: f.archive }); await finish(controller);
  const plan = await controller.plan({ id: 'training', action: 'uninstall' });
  let enter, resume; const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { resume = resolve; });
  const snapshot = controller.snapshot.bind(controller);
  controller.snapshot = async (...args) => { enter(); await gate; return snapshot(...args); };
  const executing = controller.execute({ planId: plan.planId, confirmed: true });
  await entered;
  let closed = false; const closing = controller.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, '卸载尚未完成时不得关闭管理器');
    await assert.rejects(controller.install('training', { file: f.archive }), /关闭/);
  } finally { resume(); await executing; await closing; }
  assert.equal(controller.resolve('training'), null);
});

test('未使用的管理器关闭后不接受新操作，也不创建资源目录', async t => {
  const f = await fixture(t), controller = f.manager();
  await controller.close();
  await assert.rejects(controller.state(), /关闭/);
  await assert.rejects(stat(controller.directory), { code: 'ENOENT' });
});
