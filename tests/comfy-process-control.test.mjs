import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = () => import('../framework/comfy-process-control.mjs');
const executable = 'C:\\Comfy\\python.exe';
const snapshot = { pid: 1234, startedAt: '2026-11-08T01:02:03.1234567Z', executable, args: ['-s', 'main.py', '--port', '18188'], commandHash: 'a'.repeat(64) };
const target = { port: 18188, executable };
const accepted = result => async () => ({ ok: true, result });

test('进程核验使用结构化请求并保留完整创建时间，不把相对入口推断为工作目录', async () => {
  const { inspectLocalComfyProcess } = await adapter();
  const requests = [];
  const result = await inspectLocalComfyProcess(target, { platform: 'win32', runner: async request => { requests.push(request); return { ok: true, result: snapshot }; } });
  assert.deepEqual(requests, [{ action: 'inspect', ...target }]);
  assert.deepEqual(result, snapshot);
  assert.equal(Object.hasOwn(result, 'cwd'), false);
});

test('非 Windows、非法端口和非本地 Python 路径在运行系统脚本前拒绝', async () => {
  const { inspectLocalComfyProcess, stopLocalComfyProcess } = await adapter();
  let called = 0;
  const options = { platform: 'win32', runner: async () => { called++; throw new Error('不应运行'); } };
  for (const value of [{ ...target, port: 0 }, { ...target, port: 65536 }, { ...target, port: '18188' }, { ...target, executable: '\\\\server\\python.exe' }, { ...target, executable: 'python.exe' }, { ...target, executable: 'C:\\python.exe:stream' }, { ...target, executable: 'C:\\bad\npython.exe' }]) await assert.rejects(inspectLocalComfyProcess(value, options), error => error.status === 400);
  await assert.rejects(inspectLocalComfyProcess(target, { ...options, platform: 'linux' }), error => error.status === 503);
  await assert.rejects(stopLocalComfyProcess({ ...target, pid: snapshot.pid }, options), error => error.status === 400);
  for (const invalid of [{ startedAt: { toString: 1 } }, { commandHash: { toString: 1 } }]) await assert.rejects(stopLocalComfyProcess({ ...target, pid: snapshot.pid, startedAt: snapshot.startedAt, commandHash: snapshot.commandHash, ...invalid }, options), error => error.status === 400);
  assert.equal(called, 0);
});

test('操作系统不能核验时保留明确错误，拒绝不同解释器和不完整进程身份', async () => {
  const { inspectLocalComfyProcess } = await adapter();
  await assert.rejects(inspectLocalComfyProcess(target, { platform: 'win32', runner: async () => ({ ok: false, error: { status: 409, message: '端口已有多个监听进程，不能停止。' } }) }), error => error.status === 409 && /多个监听/.test(error.message));
  for (const result of [{ ...snapshot, pid: 0 }, { ...snapshot, executable: 'C:\\other\\python.exe' }, { ...snapshot, startedAt: 'yesterday' }, { ...snapshot, commandHash: 'abc' }, { ...snapshot, args: 'main.py' }]) await assert.rejects(inspectLocalComfyProcess(target, { platform: 'win32', runner: accepted(result) }), error => error.status === 503);
});

test('停止必须提交核验快照，并只接受同一目标的退出确认', async () => {
  const { stopLocalComfyProcess } = await adapter();
  const request = { ...target, pid: snapshot.pid, startedAt: snapshot.startedAt, commandHash: snapshot.commandHash };
  let received;
  assert.deepEqual(await stopLocalComfyProcess(request, { platform: 'win32', runner: async value => { received = value; return { ok: true, result: { stopped: true, pid: snapshot.pid } }; } }), { stopped: true, pid: snapshot.pid });
  assert.deepEqual(received, { action: 'stop', ...request });
  for (const result of [{ stopped: false, pid: snapshot.pid }, { stopped: true, pid: snapshot.pid + 1 }]) await assert.rejects(stopLocalComfyProcess(request, { platform: 'win32', runner: accepted(result) }), error => error.status === 503);
});

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise((done, fail) => server.close(error => error ? fail(error) : done())); return port;
}

async function fixture(t, { entry = 'main.py', relative = false, wrongPort = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'comfy-process-control-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode == null && child.signalCode == null) { const closed = once(child, 'close'); child.kill(); await closed; }
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, entry);
  await writeFile(path, "const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('--bind-port')+1]);http.createServer((_req,res)=>res.end('{}')).listen(port,'127.0.0.1',()=>process.send({ready:true}));\n", 'utf8');
  async function start(port = undefined) {
    port ??= await freePort();
    const child = spawn(process.execPath, [relative ? entry : path, '--port', String(wrongPort ? port === 65535 ? port - 1 : port + 1 : port), '--bind-port', String(port)], { cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`隔离进程提前退出 ${code}: ${errors}`); })]);
    return { child, port };
  }
  return { directory, start };
}

test('真实 Windows 核验随机端口，拒绝过期身份，只停止隔离目标而保留另一进程', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const { inspectLocalComfyProcess, stopLocalComfyProcess } = await adapter();
  const f = await fixture(t), first = await f.start(), other = await f.start();
  const target = { port: first.port, executable: process.execPath };
  const identity = await inspectLocalComfyProcess(target);
  assert.equal(identity.pid, first.child.pid); assert.match(identity.startedAt, /^\d{4}-.*Z$/); assert.match(identity.commandHash, /^[a-f0-9]{64}$/);
  assert.equal(identity.args[0], join(f.directory, 'main.py'));
  for (const changed of [{ startedAt: '2000-01-01T00:00:00.0000000Z' }, { commandHash: '0'.repeat(64) }, { pid: other.child.pid }]) {
    await assert.rejects(stopLocalComfyProcess({ ...target, pid: identity.pid, startedAt: identity.startedAt, commandHash: identity.commandHash, ...changed }), error => error.status === 409);
    assert.equal(first.child.exitCode, null); assert.equal(other.child.exitCode, null);
  }
  const exited = once(first.child, 'exit');
  assert.deepEqual(await stopLocalComfyProcess({ ...target, pid: identity.pid, startedAt: identity.startedAt, commandHash: identity.commandHash }), { stopped: true, pid: identity.pid });
  await exited;
  assert.equal((await fetch(`http://127.0.0.1:${other.port}`)).status, 200);
  assert.equal(other.child.exitCode, null);
});

test('真实 Windows 接受相对 main.py，拒绝其他入口或命令中不匹配的端口', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { inspectLocalComfyProcess } = await adapter();
  const relative = await fixture(t, { relative: true }), valid = await relative.start();
  const result = await inspectLocalComfyProcess({ port: valid.port, executable: process.execPath });
  assert.equal(result.args[0], 'main.py'); assert.equal(Object.hasOwn(result, 'cwd'), false);
  for (const settings of [{ entry: 'other.py' }, { wrongPort: true }]) {
    const f = await fixture(t, settings), actual = await f.start();
    await assert.rejects(inspectLocalComfyProcess({ port: actual.port, executable: process.execPath }), error => error.status === 409 && /入口|端口/.test(error.message));
    assert.equal(actual.child.exitCode, null);
  }
});

test('真实 Windows 过期 CIM TCP 快照不阻断内核核实的当前监听身份', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { inspectLocalComfyProcess } = await adapter();
  const f = await fixture(t), current = await f.start();
  const staleProvider = async request => new Promise((done, fail) => {
    const child = execFile('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
function global:Get-NetTCPConnection {
  [CmdletBinding()] param([int]$LocalPort)
  [pscustomobject]@{State='Listen';OwningProcess=2147483647;CimInstanceProperties=@{State=[pscustomobject]@{Value=2}}}
}
& $env:COMFY_PROCESS_CONTROL_SCRIPT
`], { windowsHide: true, shell: false, timeout: 25000, env: { ...process.env, COMFY_PROCESS_CONTROL_SCRIPT: fileURLToPath(new URL('../tools/ComfyUI-ProcessControl.ps1', import.meta.url)) } }, (error, stdout) => {
      try { done(JSON.parse(stdout)); } catch { fail(error || new Error(stdout)); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
  });
  const identity = await inspectLocalComfyProcess({ port: current.port, executable: process.execPath }, { runner: staleProvider });
  assert.equal(identity.pid, current.child.pid);
  assert.equal(current.child.exitCode, null);
});

test('真实 Windows 同一随机端口立即重启后拒绝旧快照，新身份仍能停止', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { inspectLocalComfyProcess, stopLocalComfyProcess } = await adapter();
  const f = await fixture(t);
  let current = await f.start();
  const target = { port: current.port, executable: process.execPath };
  let identity = await inspectLocalComfyProcess(target);
  for (let restart = 0; restart < 3; restart++) {
    const exited = once(current.child, 'close'); current.child.kill(); await exited;
    current = await f.start(target.port);
    await assert.rejects(stopLocalComfyProcess({ ...target, pid: identity.pid, startedAt: identity.startedAt, commandHash: identity.commandHash }), error => error.status === 409);
    assert.equal(current.child.exitCode, null);
    const next = await inspectLocalComfyProcess(target);
    assert.equal(next.pid, current.child.pid);
    assert.equal(next.commandHash, identity.commandHash, '相同命令也必须依据 PID 和创建时间拒绝旧身份');
    assert.ok(next.pid !== identity.pid || next.startedAt !== identity.startedAt);
    identity = next;
  }
  const exited = once(current.child, 'exit');
  assert.deepEqual(await stopLocalComfyProcess({ ...target, pid: identity.pid, startedAt: identity.startedAt, commandHash: identity.commandHash }), { stopped: true, pid: identity.pid });
  await exited;
});
