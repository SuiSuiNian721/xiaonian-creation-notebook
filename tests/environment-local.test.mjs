import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const { discoverLocalEnvironments } = await import('../framework/environment-local.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const packageSha256 = '77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed';
const criticalFiles = ['node.exe', 'index.js', 'wrapper.node', 'QQNT.dll', 'napcat/napcat.mjs'];

async function fixture(t) {
  assert.equal(typeof discoverLocalEnvironments, 'function', '需要有界只读的本机组件发现函数');
  const root = await mkdtemp(join(tmpdir(), 'environment-local-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function files(root, names) {
  for (const name of names) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# fixture: must never execute\n', 'utf8');
  }
}

async function comfy(root) {
  await files(root, ['main.py', 'server.py', 'nodes.py']);
  await mkdir(join(root, 'comfy'), { recursive: true });
  return root;
}

async function qq(root, manifest = true) {
  await files(root, criticalFiles);
  if (manifest) await writeFile(join(root, 'workbench-qq-runtime.json'), JSON.stringify({
    schemaVersion: 1, version: '4.18.42', packageSha256,
    files: Object.fromEntries(criticalFiles.map(name => [name, 'a'.repeat(64)])),
  }), 'utf8');
  return root;
}

test('没有根目录或不支持的模块不会检查隐式位置', async () => {
  assert.equal(typeof discoverLocalEnvironments, 'function', '需要有界只读的本机组件发现函数');
  for (const options of [{}, { moduleId: 'drawing' }, { moduleId: 'mc-play', roots: [tmpdir()] }]) {
    const result = await discoverLocalEnvironments(options);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.visited, 0);
    assert.equal(typeof result.partial, 'boolean');
    assert.ok(Array.isArray(result.warnings));
  }
});

test('ComfyUI 本体与便携包发现多个候选，排除启动器并稳定去重', async t => {
  const root = await fixture(t);
  const first = await comfy(join(root, 'standalone'));
  const second = await comfy(join(root, 'portable', 'ComfyUI'));
  await files(join(root, 'launcher'), ['main.py', '绘世启动器.exe']);
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root], hints: [second, root] });
  assert.deepEqual(new Set(result.candidates.map(value => value.path)), new Set([first, second]));
  for (const candidate of result.candidates) {
    assert.equal(candidate.kind, 'comfyui');
    assert.equal(candidate.selectable, true);
    assert.deepEqual(candidate.values, {
      comfyPath: candidate.path,
      pythonPath: '',
      outputPath: join(candidate.path, 'output'),
      workflowPath: join(candidate.path, 'user', 'default', 'workflows'),
    });
    assert.equal('serviceUrl' in candidate.values, false);
  }
  const again = await discoverLocalEnvironments({ moduleId: 'comfyui', roots: [root] });
  assert.deepEqual(new Map(again.candidates.map(value => [value.path, value.id])), new Map(result.candidates.map(value => [value.path, value.id])));
});

test('发现不完整的 ComfyUI 时指出缺少的本体文件，不只返回空结果',async t=>{
  const root=await fixture(t),broken=join(root,'ComfyUI');
  await files(broken,['main.py','nodes.py']);await mkdir(join(broken,'comfy'));
  const result=await discoverLocalEnvironments({moduleId:'comfyui',roots:[root]});
  assert.equal(result.candidates.length,0);
  assert.ok(result.issues?.some(issue=>issue.path===broken&&/server\.py/.test(issue.detail)&&/ComfyUI/.test(issue.name)));
});

test('普通 Python 项目的通用文件不能被断言为不完整 ComfyUI',async t=>{
  const root=await fixture(t);await files(join(root,'unrelated-python-project'),['main.py','server.py']);
  const result=await discoverLocalEnvironments({moduleId:'comfyui',roots:[root]});
  assert.deepEqual(result.candidates,[]);assert.deepEqual(result.issues,[]);
});

test('ComfyUI 检查超时或无权限时保留未完成状态，不能断言缺文件',async()=>{
  const root=resolve(process.platform==='win32'?'C:\\scan-fixture\\ComfyUI':'/scan-fixture/ComfyUI');
  const original={lstat:fs.lstat,opendir:fs.opendir};
  try {
    for(const mode of ['timeout','denied']) {
      fs.lstat=async path=>{
        if(path===join(root,'comfy')&&mode==='timeout')await new Promise(done=>setTimeout(done,60));
        if(path===join(root,'server.py')&&mode==='denied')throw Object.assign(new Error('denied'),{code:'EACCES'});
        return {isDirectory:()=>!String(path).endsWith('.py'),isFile:()=>String(path).endsWith('.py'),isSymbolicLink:()=>false};
      };
      fs.opendir=async()=>({read:async()=>null,close:async()=>{}});syncBuiltinESMExports();
      const result=await discoverLocalEnvironments({moduleId:'comfyui',roots:[root],timeoutMs:mode==='timeout'?25:500});
      assert.equal(result.partial,true);assert.deepEqual(result.candidates,[]);
      if(mode==='timeout')assert.deepEqual(result.issues,[],'超时后不生成缺件结论');
      else {assert.equal(result.issues[0]?.status,'unreadable');assert.match(result.issues[0].detail,/权限|无法|未核实/);assert.doesNotMatch(result.issues[0].detail,/未找到可用/);}
    }
  } finally {Object.assign(fs,original);syncBuiltinESMExports();}
});

test('不完整 NapCat 指出缺失文件与校验清单，普通 QQ 客户端不冒充可用网关',async t=>{
  const root=await fixture(t),broken=await qq(join(root,'NapCat'));
  await rm(join(broken,'wrapper.node'));
  const result=await discoverLocalEnvironments({moduleId:'qq',roots:[root]});
  const candidate=result.candidates.find(item=>item.path===broken);
  assert.equal(candidate.selectable,false);assert.match(candidate.reason,/wrapper\.node/);
  const ordinary=await qq(join(root,'ordinary'),false);
  const other=await discoverLocalEnvironments({moduleId:'qq',roots:[ordinary]});
  assert.match(other.candidates[0].reason,/workbench-qq-runtime\.json/);
});

test('QQ 只允许固定包候选，普通 NapCat 展示原因且日常 QQ 不误报', async t => {
  const root = await fixture(t);
  const fixed = await qq(join(root, 'fixed'));
  const shell = await qq(join(root, 'ordinary'), false);
  await files(join(root, 'daily-qq'), ['QQ.exe', 'QQNT.dll', 'package.json']);
  const before = await readFile(join(fixed, 'workbench-qq-runtime.json'), 'utf8');
  const result = await discoverLocalEnvironments({ moduleId: 'qq', roots: [root] });
  assert.equal(result.candidates.length, 2);
  const ready = result.candidates.find(value => value.path === fixed);
  assert.equal(ready.kind, 'qq-runtime');
  assert.equal(ready.selectable, true);
  assert.deepEqual(ready.values, { installDirectory: fixed });
  const ordinary = result.candidates.find(value => value.path === shell);
  assert.equal(ordinary.selectable, false);
  assert.match(ordinary.reason, /固定包|固定版本/);
  assert.deepEqual(ordinary.values, {});
  assert.equal(await readFile(join(fixed, 'workbench-qq-runtime.json'), 'utf8'), before);
  // 扫描只核对清单与标记；真实文件摘要由采用运行包时的 runtime 验证。
  assert.ok(!JSON.stringify(result).includes('a'.repeat(64)));
});

test('错误、超大和不完整的 QQ 固定清单不能成为可采用候选', async t => {
  const root = await fixture(t);
  const wrong = await qq(join(root, 'wrong-version'));
  await writeFile(join(wrong, 'workbench-qq-runtime.json'), JSON.stringify({ version: 'old', packageSha256 }), 'utf8');
  const oversized = await qq(join(root, 'oversized'));
  await writeFile(join(oversized, 'workbench-qq-runtime.json'), JSON.stringify({ version: '4.18.42', packageSha256, padding: 'x'.repeat(70 * 1024) }), 'utf8');
  const malformed = await qq(join(root, 'malformed'));
  await writeFile(join(malformed, 'workbench-qq-runtime.json'), '{', 'utf8');
  const missing = await qq(join(root, 'missing-file'));
  await rm(join(missing, 'wrapper.node'));
  const result = await discoverLocalEnvironments({ moduleId: 'qq', roots: [root] });
  assert.equal(result.candidates.length, 4);
  assert.ok(result.candidates.every(value => value.selectable === false));
  assert.ok(result.candidates.every(value => Object.keys(value.values).length === 0));
});

test('Python 支持已配置文件、便携环境和虚拟环境，不执行程序', async t => {
  const root = await fixture(t);
  const direct = join(root, 'configured', 'python.exe');
  const embedded = join(root, 'portable', 'python_embeded', 'python.exe');
  const virtual = join(root, 'project', '.venv', 'Scripts', 'python.exe');
  await files(root, ['configured/python.exe', 'portable/python_embeded/python.exe', 'project/.venv/Scripts/python.exe', 'fake/python-launcher.exe']);
  const before = await lstat(direct);
  const result = await discoverLocalEnvironments({ moduleId: 'mc-skin', roots: [root], hints: [direct] });
  assert.deepEqual(new Set(result.candidates.map(value => value.path)), new Set([direct, embedded, virtual]));
  for (const candidate of result.candidates) {
    assert.equal(candidate.kind, 'python');
    assert.equal(candidate.selectable, true);
    assert.deepEqual(candidate.values, { pythonPath: candidate.path });
  }
  assert.equal((await lstat(direct)).mtimeMs, before.mtimeMs);
});

test('训练环境用 mikazuki 与启动和依赖标记组合识别，不读取配置', async t => {
  const root = await fixture(t);
  const trainer = join(root, 'tools', 'Next-Trainer');
  await files(trainer, ['run_gui.bat', 'requirements.txt', 'config/private-token.json']);
  await mkdir(join(trainer, 'mikazuki'), { recursive: true });
  await files(join(root, 'fake'), ['run_gui.bat', 'requirements.txt']);
  const result = await discoverLocalEnvironments({ moduleId: 'training', roots: [root] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].kind, 'next-trainer');
  assert.deepEqual(result.candidates[0].values, { trainerPath: trainer, pythonPath: '' });
  assert.equal(result.candidates[0].label, '训练环境');
  assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('mikazuki 兼容训练工具不会仅凭形状标记被标成 Next Trainer 品牌', async t => {
  const root = await fixture(t);
  const trainer = join(root, 'SD-Trainer');
  await files(trainer, ['run_gui.bat', 'requirements.txt']);
  await mkdir(join(trainer, 'mikazuki'), { recursive: true });
  const result = await discoverLocalEnvironments({ moduleId: 'training', roots: [root] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].label, '训练环境 · SD-Trainer');
  assert.deepEqual(result.candidates[0].values, { trainerPath: trainer, pythonPath: '' });
});

test('ComfyUI 与训练候选携带对应 Python，未找到时清空旧绑定，不执行程序', async t => {
  const root = await fixture(t), portable = join(root, 'portable');
  const core = await comfy(join(portable, 'ComfyUI'));
  await files(portable, ['python_embeded/python.exe']);
  const trainer = join(root, 'training', 'Next-Trainer');
  await files(trainer, ['run_gui.bat', 'requirements.txt', '.venv/Scripts/python.exe']);
  await mkdir(join(trainer, 'mikazuki'), {recursive:true});
  const drawing = await discoverLocalEnvironments({moduleId:'comfyui', roots:[core]});
  assert.equal(drawing.candidates[0].values.pythonPath, join(portable, 'python_embeded', 'python.exe'));
  const training = await discoverLocalEnvironments({moduleId:'training', roots:[trainer]});
  assert.equal(training.candidates[0].values.pythonPath, join(trainer, '.venv', 'Scripts', 'python.exe'));
  await rm(join(trainer, '.venv'), {recursive:true});
  assert.equal((await discoverLocalEnvironments({moduleId:'training', roots:[trainer]})).candidates[0].values.pythonPath, '');
});

test('拒绝相对、UNC、设备路径和非字符串路径', async () => {
  assert.equal(typeof discoverLocalEnvironments, 'function', '需要有界只读的本机组件发现函数');
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [
    '.', '..', 'C:relative', '\\relative', '\\\\server\\share', '//server/share',
    '\\\\?\\C:\\ComfyUI', '\\\\.\\PhysicalDrive0', '\\??\\C:\\ComfyUI', 'file:///C:/ComfyUI', null, 123,
  ] });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.visited, 0);
  assert.ok(result.warnings.length > 0);
});

test('不跟随子目录联接、路径祖先联接和 ComfyUI 标记联接', async t => {
  const root = await fixture(t);
  const outside = await comfy(join(root, 'outside'));
  const scanned = join(root, 'scanned');
  await mkdir(scanned);
  await symlink(outside, join(scanned, 'linked-package'), 'junction');
  const fake = join(scanned, 'linked-marker');
  await files(fake, ['main.py', 'server.py', 'nodes.py']);
  await symlink(join(outside, 'comfy'), join(fake, 'comfy'), 'junction');
  const parentLink = join(root, 'parent-link');
  await symlink(root, parentLink, 'junction');
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [scanned], hints: [join(parentLink, 'outside')] });
  assert.deepEqual(result.candidates, []);
});

test('QQ 关键文件目录经过联接时仅展示不可采用组件', async t => {
  const root = await fixture(t);
  const runtime = await qq(join(root, 'runtime'));
  const external = join(root, 'external');
  await files(external, ['napcat.mjs']);
  await rm(join(runtime, 'napcat'), { recursive: true });
  await symlink(external, join(runtime, 'napcat'), 'junction');
  const result = await discoverLocalEnvironments({ moduleId: 'qq', roots: [runtime] });
  assert.ok(result.candidates.every(value => value.selectable === false));
});

test('跳过模型、依赖、账号、日志与输出缓存目录，即使它们是提示路径', async t => {
  const root = await fixture(t);
  const skipped = ['models', 'node_modules', '.git', 'accounts', 'qqdata', 'logs', 'output', 'cache'];
  for (const name of skipped) await comfy(join(root, name, 'hidden-comfy'));
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root], hints: [join(root, 'accounts', 'hidden-comfy')] });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.visited, 1);
});

test('深度预算截断时明确返回 partial 和警告', async t => {
  const root = await fixture(t);
  await comfy(join(root, 'nested', 'ComfyUI'));
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root], maxDepth: 0 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.visited, 1);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.length > 0);
});

test('目录预算内优先常见软件目录，队列不会绕过目录上限', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '000-unrelated'));
  const core = await comfy(join(root, 'ComfyUI'));
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root], maxDirectories: 2 });
  assert.equal(result.visited, 2);
  assert.deepEqual(result.candidates.map(value => value.path), [core]);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.length > 0);
});

test('多个根目录共用预算时，优先继续软件路径而不是耗尽于普通目录', async t => {
  const root = await fixture(t);
  const noisy = join(root, 'home');
  const software = join(root, 'disk');
  for (let index = 0; index < 12; index++) await mkdir(join(noisy, 'general-' + index), { recursive: true });
  const core = await comfy(join(software, 'ai draw', 'ComfyUI-aki-v2', 'ComfyUI'));
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [noisy, software], maxDirectories: 5 });
  assert.deepEqual(result.candidates.map(value => value.path), [core]);
  assert.ok(result.visited <= 5);
  assert.equal(result.partial, true);
});

test('不会枚举系统、缓存和备份目录，但显式软件根仍可检查', async t => {
  const root = await fixture(t);
  for (const name of ['Windows', 'Users', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'AppData', 'backup', 'backups', '备份']) {
    await comfy(join(root, name, 'hidden-comfy'));
  }
  const allowed = await comfy(join(root, 'AppData', 'Local', 'Programs', 'ComfyUI'));
  const explicitBackup = join(root, 'backup', 'hidden-comfy');
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root, allowed, explicitBackup] });
  assert.deepEqual(new Set(result.candidates.map(value => value.path)), new Set([allowed, explicitBackup]));
});

test('结果预算不会越界并告知扫描截断', async t => {
  const root = await fixture(t);
  await comfy(join(root, 'first'));
  await comfy(join(root, 'second'));
  const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root], maxResults: 1 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.length > 0);
});

test('零耗时预算和已取消信号立即结束，不残留继续扫描', async t => {
  const root = await fixture(t);
  await comfy(root);
  const abort = new AbortController();
  abort.abort();
  for (const limits of [{ timeoutMs: 0 }, { signal: abort.signal }, { maxDirectories: 0 }, { maxResults: 0 }]) {
    const result = await discoverLocalEnvironments({ moduleId: 'drawing', roots: [root], ...limits });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.visited, 0);
    assert.equal(result.partial, true);
    assert.ok(result.warnings.length > 0);
  }
});
