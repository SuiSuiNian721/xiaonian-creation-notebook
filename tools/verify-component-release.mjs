import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { OptionalComponents } from '../framework/optional-components.mjs';
import { assertOrdinaryComponentPath, hashComponentFile } from '../framework/component-archive.mjs';
import { WorkbenchStore } from '../framework/store.mjs';
import { verifyKernel } from '../framework/training-runtime.mjs';
import { minecraftRuntimeLaunch } from '../framework/mc-runtime-launch.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runMinecraftSelfTest(directory) {
  const launch = minecraftRuntimeLaunch({ runtimeRoot: directory, nodePath: resolve(directory, 'runtime/node.exe'), args: ['--self-test'] });
  const child = spawn(launch.command, launch.args, { ...launch.options, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, `已安装 MC 组件自检失败：${stderr || stdout || signal}`);
  const result = stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.ok === true && value?.isolatedPlanner === true);
  assert.ok(result, 'MC 自检没有确认隔离执行器可用');
  return { executable: launch.command, args: launch.args, esbuildBinaryPath: launch.options.env.ESBUILD_BINARY_PATH, code, result, stdout: stdout.trim(), stderr: stderr.trim() };
}

function archiveServer(catalog, directory, requests) {
  const archives = new Map(Object.values(catalog.components).map(descriptor => ['/' + descriptor.file, descriptor]));
  return createServer((request, response) => {
    const descriptor = archives.get(request.url);
    if (!descriptor || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404); response.end(); return; }
    let start = 0;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-$/.exec(request.headers.range);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= descriptor.bytes) { response.writeHead(416); response.end(); return; }
      start = Number(match[1]);
    }
    const status = start ? 206 : 200;
    const record = { at: new Date().toISOString(), id: descriptor.id, method: request.method, path: request.url, status, start, bytes: 0, completed: false };
    requests.push(record);
    response.writeHead(status, {
      'content-type': 'application/octet-stream', 'content-length': descriptor.bytes - start,
      'accept-ranges': 'bytes', ...(start ? { 'content-range': `bytes ${start}-${descriptor.bytes - 1}/${descriptor.bytes}` } : {}),
    });
    if (request.method === 'HEAD') { record.completed = true; response.end(); return; }
    const stream = createReadStream(resolve(directory, descriptor.file), { start });
    stream.on('data', chunk => { record.bytes += chunk.length; });
    pipeline(stream, response).then(() => { record.completed = true; }).catch(error => { record.error = error.message; });
  });
}

async function waitForInstall(manager, id, timeoutMs, onProgress) {
  const deadline = Date.now() + timeoutMs;
  const stages = [];
  while (Date.now() < deadline) {
    const component = (await manager.state()).components.find(item => item.id === id);
    const task = component?.task;
    if (task?.stage && stages.at(-1)?.stage !== task.stage) {
      stages.push({ at: new Date().toISOString(), stage: task.stage });
      onProgress(`${id}: ${task.stage}`);
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task?.status)) {
      assert.equal(task.status, 'completed', `${id} 安装失败：${task.error || task.status}`);
      assert.equal(component.origin, 'managed');
      return { component, stages };
    }
    await delay(250);
  }
  await manager.cancel(id);
  throw new Error(`${id} 安装超过 ${timeoutMs} 毫秒，已取消。`);
}

export async function verifyComponentRelease({ catalogPath = resolve(projectRoot, 'artifacts/optional-components/catalog.json'), output = resolve(projectRoot, 'artifacts/optional-components-validation'), timeoutMs = 20 * 60 * 1000, onProgress = message => console.error(message) } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60 * 60 * 1000, '验收超时参数无效');
  catalogPath = resolve(catalogPath); output = resolve(output);
  await assertOrdinaryComponentPath(catalogPath);
  await assertOrdinaryComponentPath(output, { allowMissing: true });
  await assertOrdinaryComponentPath(resolve(output, 'profiles'), { allowMissing: true });
  await mkdir(resolve(output, 'profiles'), { recursive: true });
  const dataDir = await mkdtemp(resolve(output, 'profiles/verification-'));
  const reportPath = resolve(output, 'report.json');
  const report = {
    format: 1, runId: randomUUID(), startedAt: new Date().toISOString(), status: 'running',
    catalogPath, dataDir, reportPath, nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
    scope: { existingCandidates: false, localSourceDirectories: false, minecraftSelfTestOnly: true, trainingStarted: false },
    steps: [], requests: [], components: {},
  };
  const managers = [], stores = [], leases = new Set();
  let server;
  const saveReport = async () => {
    const contents = JSON.stringify(report, null, 2) + '\n';
    await writeFile(resolve(dataDir, 'validation-report.json'), contents, 'utf8');
    const temporary = resolve(output, `report-${report.runId}.tmp`);
    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, reportPath);
  };
  const step = async (name, action) => {
    onProgress(name);
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' };
    report.steps.push(entry); await saveReport();
    try { entry.result = await action(); entry.status = 'passed'; return entry.result; }
    catch (error) { entry.status = 'failed'; entry.error = error.message; throw error; }
    finally { entry.finishedAt = new Date().toISOString(); await saveReport(); }
  };
  try {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    assert.deepEqual(Object.keys(catalog.components || {}).sort(), ['mc-play', 'training']);
    const managerConfig = { dataDir, catalog, candidates: {}, sourceDirectories: [] };
    const store = new WorkbenchStore(dataDir); stores.push(store);
    const manager = new OptionalComponents({ ...managerConfig, store }); managers.push(manager);
    const peerStore = new WorkbenchStore(dataDir); stores.push(peerStore);
    const peer = new OptionalComponents({ ...managerConfig, store: peerStore }); managers.push(peer);
    await manager.ready(); await peer.ready();
    const sentinel = { id: `validation-${report.runId}`, name: '组件验收角色哨兵', description: '卸载组件后仍应保留', revision: 1, raw: { marker: report.runId }, assets: [] };
    const savedCharacter = store.saveCharacter(sentinel);
    store.selectCharacter(savedCharacter.id);
    const sentinelFiles = new Map([
      ['characters/validation-character.json', JSON.stringify(sentinel, null, 2)],
      ['training-output/personal.safetensors', `这是验收哨兵，并非模型权重。\n${report.runId}\n`],
    ]);
    for (const [path, contents] of sentinelFiles) { await mkdir(dirname(resolve(dataDir, path)), { recursive: true }); await writeFile(resolve(dataDir, path), contents, 'utf8'); }
    await step('核对真实发布文件与空资料状态', async () => {
      const checked = {};
      for (const [id, descriptor] of Object.entries(catalog.components)) {
        const archive = resolve(dirname(catalogPath), descriptor.file);
        await assertOrdinaryComponentPath(archive);
        assert.equal((await stat(archive)).size, descriptor.bytes);
        assert.equal(await hashComponentFile(archive), descriptor.sha256);
        assert.equal(manager.resolve(id), null); assert.equal(peer.resolve(id), null);
        checked[id] = { file: descriptor.file, bytes: descriptor.bytes, installedBytes: descriptor.installedBytes, sha256: descriptor.sha256, version: descriptor.version };
      }
      report.components = checked;
      return checked;
    });
    server = archiveServer(catalog, dirname(catalogPath), report.requests);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    report.source = `http://127.0.0.1:${server.address().port}/`;
    await manager.setSource({ url: report.source });
    for (const id of ['mc-play', 'training']) {
      const descriptor = catalog.components[id];
      await step(`${id} 通过本机 HTTP 下载、校验并安装`, async () => {
        const started = await manager.install(id);
        assert.equal(started.reused, undefined, '初次安装不得复用源目录');
        const { component, stages } = await waitForInstall(manager, id, timeoutMs, onProgress);
        assert.ok(report.requests.some(request => request.id === id && request.method === 'GET' && request.bytes === descriptor.bytes && request.completed), '没有完整 HTTP 下载证据');
        const storage = await manager.storage();
        const cache = storage.caches.find(file => file.path.endsWith(`${id}-${descriptor.sha256}.afcomponent`));
        assert.ok(cache, '下载缓存未进入管理器登记');
        assert.equal(await hashComponentFile(cache.path), descriptor.sha256);
        return { path: component.path, origin: component.origin, version: component.version, stages, cachePath: cache.path, downloadedSha256: descriptor.sha256 };
      });
      const installed = manager.resolve(id);
      await step(`${id} 跨实例复用`, async () => {
        assert.equal(peer.resolve(id)?.path, installed.path);
        const requestsBefore = report.requests.length;
        const reused = await peer.install(id);
        assert.equal(reused.reused, true);
        assert.equal(reused.component.path, installed.path);
        assert.equal(report.requests.length, requestsBefore, '复用不应重复下载');
        return { path: installed.path, reused: true, additionalRequests: 0, independentStoreConnections: true };
      });
      const removal = await manager.plan({ id, action: 'uninstall' });
      const lease = await peer.acquire(id, `component-release-validation:${report.runId}`); leases.add(lease);
      await step(`${id} 活动引用阻止跨实例卸载`, async () => {
        assert.equal(lease.path, installed.path);
        const active = (await manager.state()).components.find(item => item.id === id).users;
        assert.ok(active.some(user => user.owner === `component-release-validation:${report.runId}`));
        await assert.rejects(manager.plan({ id, action: 'uninstall' }), /使用|活动/);
        await assert.rejects(manager.execute({ planId: removal.planId, confirmed: true }), /使用|活动/);
        assert.equal(manager.resolve(id)?.path, installed.path);
        return { activeUsers: active, newPlanBlocked: true, existingPlanBlocked: true };
      });
      await step(`${id} 已安装内容自检`, async () => {
        if (id === 'mc-play') return runMinecraftSelfTest(lease.path);
        const manifest = await verifyKernel(lease.path);
        return { version: manifest.version, kernelRevision: manifest.kernelRevision, verifiedSourceFiles: manifest.files.length, sourceCommit: manifest.source?.commit };
      });
      await lease.release(); leases.delete(lease);
      await step(`${id} 释放引用后卸载`, async () => {
        const result = await manager.execute({ planId: removal.planId, confirmed: true });
        assert.equal(result.completed, true);
        assert.equal(manager.resolve(id), null); assert.equal(peer.resolve(id), null);
        await assert.rejects(stat(installed.path), { code: 'ENOENT' });
        return result;
      });
    }
    await step('清理实际下载缓存', async () => {
      const before = await manager.storage();
      assert.equal(before.cacheBytes, Object.values(catalog.components).reduce((sum, item) => sum + item.bytes, 0));
      const plan = await manager.plan({ id: 'cache', action: 'cleanup' });
      const result = await manager.execute({ planId: plan.planId, confirmed: true });
      assert.equal(result.completed, true);
      const after = await manager.storage(); assert.equal(after.cacheBytes, 0);
      assert.deepEqual(await readdir(resolve(manager.directory, 'downloads')), []);
      assert.deepEqual(await readdir(resolve(manager.directory, 'packages')), []);
      return { beforeBytes: before.cacheBytes, afterBytes: after.cacheBytes, reclaimedBytes: result.reclaimedBytes };
    });
    await step('核对角色、训练产物与数据库哨兵仍然保留', async () => {
      const files = [];
      for (const [path, contents] of sentinelFiles) {
        assert.equal(await readFile(resolve(dataDir, path), 'utf8'), contents);
        files.push({ path: resolve(dataDir, path), sha256: await hashComponentFile(resolve(dataDir, path)), preserved: true });
      }
      assert.deepEqual(peerStore.character(savedCharacter.id), savedCharacter);
      assert.equal(peerStore.getSetting('selectedCharacterId'), savedCharacter.id);
      return { files, databaseCharacterId: savedCharacter.id, databaseCharacterPreserved: true, selectionPreserved: true };
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const lease of leases) try { await lease.release(); } catch (error) { cleanupErrors.push(error.message); }
    for (const manager of managers.reverse()) try { await manager.close(); } catch (error) { cleanupErrors.push(error.message); }
    for (const store of stores.reverse()) try { store.close(); } catch (error) { cleanupErrors.push(error.message); }
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.status = 'failed'; }
    report.finishedAt = new Date().toISOString(); await saveReport();
    if (cleanupErrors.length && !report.error) throw new Error('验收资源关闭失败：' + cleanupErrors.join('；'));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, output: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('node tools/verify-component-release.mjs [--catalog <catalog.json>] [--output <验收报告目录>] [--timeout-ms <单组件安装超时>]\n始终新建隔离 profile，保留角色与训练哨兵；不连接游戏、不启动训练。');
  else {
    const report = await verifyComponentRelease({ ...(values.catalog ? { catalogPath: values.catalog } : {}), ...(values.output ? { output: values.output } : {}), ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}) });
    console.log(JSON.stringify({ status: report.status, reportPath: report.reportPath, dataDir: report.dataDir, steps: report.steps.length }, null, 2));
  }
}
