import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {inspectAiriInstall} from './companion-source.mjs';

// Electron 将 app.asar 映射为目录；陪伴发现与启动检查均须读取真实磁盘文件。
let physicalDisk;
try { physicalDisk = createRequire(import.meta.url)('original-fs').promises; } catch {}

const modules = new Set(['drawing', 'comfyui', 'qq', 'mc-skin', 'training', 'companion']);
const skippedNames = new Set([
  '.git', 'node_modules', 'models', 'accounts', 'qqdata', 'logs', 'log', 'output', 'outputs', 'cache', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'site-packages', 'lib', 'lib64', 'include',
  'dataset', 'datasets', 'checkpoints', 'loras', 'embeddings', 'vendor', 'config', 'configs',
  'local storage', 'session storage', 'user data',
]);
// 只限制递归入口；宿主明确传入的 AppData/Local/Programs 等软件位置仍可检查。
const skippedChildren = new Set([
  'windows', 'users', 'programdata', 'appdata', '$recycle.bin', 'system volume information', 'recovery',
  'steamapps', 'steam', 'epic games', 'gog games', 'games', '游戏', '游戏库', 'backup', 'backups', '备份',
]);
const criticalFiles = ['node.exe', 'index.js', 'wrapper.node', 'QQNT.dll', 'napcat/napcat.mjs'];
const manifestName = 'workbench-qq-runtime.json';
const qqVersion = '4.18.42';
const qqPackageSha256 = '77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed';
const manifestLimit = 64 * 1024;
const stopped = Symbol('scan-stopped');
const keyFor = path => process.platform === 'win32' ? path.toLowerCase() : path;
const limit = (value, fallback, ceiling) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.min(Math.floor(value), ceiling) : fallback;
const pythonName = name => /^(?:python|python3)(?:\.exe)?$/i.test(name);

function localPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || value.includes('\0')) return null;
  const path = value.trim();
  if (/^[\\/]{2}/.test(path) || !isAbsolute(path)) return null;
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(path) || /[<>"|?*:]|[ .]$/.test(path.slice(3))) return null;
    if (path.slice(3).split(/[\\/]+/).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  } else if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(path)) return null;
  return resolve(path);
}

function skippedPath(path) {
  return relative(parse(path).root, path).split(sep).some(part => skippedNames.has(part.toLowerCase()));
}

function priority(name, moduleId) {
  const target = moduleId === 'qq' ? /napcat|qq[-_ ]?(?:runtime|shell)/i
    : moduleId === 'companion' ? /airi/i : moduleId === 'training' ? /next[-_ ]?trainer|mikazuki/i
      : moduleId === 'mc-skin' ? /python|^\.?venv$|^scripts$|^bin$/i : /comfy/i;
  if (target.test(name)) return 2;
  return /^(?:apps?|programs?|program files(?: \(x86\))?|software|tools?|portable|train|ai[-_ ]?draw|软件|工具|便携|训练)$/i.test(name) ? 1 : 0;
}

// 单个不可取消的系统文件请求可能迟到完成；停止后只关闭其句柄，不再继续遍历。
function scanBudget({ signal, timeoutMs, warn }) {
  let ended = false, finish;
  const deadline = Date.now() + timeoutMs;
  const cancellation = new Promise(done => { finish = done; });
  const stop = warning => {
    if (ended) return;
    ended = true;
    warn(warning);
    finish(stopped);
  };
  const abort = () => stop('扫描已取消，已找到的候选仍可查看。');
  const check = () => {
    if (signal?.aborted) abort();
    else if (Date.now() >= deadline) stop('已达到扫描时间上限，可指定目录后重新扫描。');
    return !ended;
  };
  const timer = setTimeout(() => stop('已达到扫描时间上限，可指定目录后重新扫描。'), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  return {
    check, stop, get ended() { return ended; },
    async run(operation, cleanup) {
      if (!check()) return stopped;
      const pending = Promise.resolve().then(operation);
      if (cleanup) pending.then(value => {
        if (ended) cleanup(value).catch(() => {});
      }, () => {});
      return Promise.race([pending, cancellation]);
    },
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}

export async function discoverLocalEnvironments({
  moduleId, roots, hints = [], explicitPaths = [], selectedRoots = [], signal, maxDirectories = 1200, maxDepth = 4, timeoutMs = 6000, maxResults = 40,
} = {}) {
  const result = { candidates: [], issues: [], partial: false, warnings: [], visited: 0 };
  if (!modules.has(moduleId)) return result;
  const disk = moduleId === 'companion' ? physicalDisk : null;
  const explicit = new Set((Array.isArray(explicitPaths) ? explicitPaths : []).map(localPath).filter(Boolean).map(keyFor));
  const selected = new Set((Array.isArray(selectedRoots) ? selectedRoots : []).map(localPath).filter(Boolean).map(keyFor));
  const inputs = [...(Array.isArray(explicitPaths) ? explicitPaths : []), ...(Array.isArray(hints) ? hints : []), ...(Array.isArray(roots) ? roots : [])];
  if (!inputs.length) return result;
  maxDirectories = limit(maxDirectories, 1200, 10000);
  maxDepth = limit(maxDepth, 4, 12);
  maxResults = limit(maxResults, 40, 200);
  timeoutMs = limit(timeoutMs, 6000, 30000);
  const warnings = new Set();
  const warn = text => {
    result.partial = true;
    if (warnings.size < 12) warnings.add(text);
  };
  const budget = scanBudget({ signal, timeoutMs, warn });
  const queued = new Set(), seen = new Set(), candidateKeys = new Set(), queue = [];
  const missingExplicit = new Set();
  let sequence = 0, entries = 0, inspectionError = false;
  const pendingLimit = Math.min(20000, maxDirectories * 2);
  const entryLimit = Math.min(100000, Math.max(2000, maxDirectories * 32));

  function orderQueue() {
    // 根目录先于推导出的子目录；之后优先沿常见软件路径继续，普通目录保持宽度优先。
    queue.sort((a, b) => Number(b.initial) - Number(a.initial) || b.rank - a.rank || a.depth - b.depth || a.sequence - b.sequence);
    if (queue.length > pendingLimit) {
      for (const item of queue.splice(pendingLimit)) queued.delete(keyFor(item.path));
      warn('已达到扫描目录队列上限，可指定目录后重新扫描。');
    }
  }

  async function stat(path) {
    try {
      const value = await budget.run(() => (disk?.lstat || lstat)(path));
      return value === stopped ? null : value;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) { inspectionError = true;warn('部分目录或文件无法读取，已跳过。'); }
      return null;
    }
  }

  async function checkedPath(path) {
    let current = parse(path).root;
    let value = await stat(current);
    if (!value?.isDirectory() || value.isSymbolicLink()) return null;
    const parts = relative(current, path).split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      value = await stat(current);
      if (!value || value.isSymbolicLink() || (index < parts.length - 1 && !value.isDirectory())) return null;
    }
    return value;
  }

  async function childStat(base, path, type = 'file') {
    let current = base, value;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      value = await stat(current);
      if (value?.isSymbolicLink()) { inspectionError = true;return null; }
      if (!value || (index < parts.length - 1 && !value.isDirectory())) return null;
    }
    return (type === 'directory' ? value?.isDirectory() : value?.isFile()) ? value : null;
  }

  function add(kind, path, label, values, selectable = true, reason) {
    if (!budget.check()) return;
    const key = kind + '\0' + keyFor(path);
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    result.candidates.push({ id: kind + '-' + createHash('sha256').update(key).digest('hex').slice(0, 20),
      kind, label, path, values, selectable, ...(reason ? { reason } : {}) });
    if (result.candidates.length >= maxResults) budget.stop('已达到候选数量上限，可指定目录后重新扫描。');
  }

  async function readManifest(path, expected) {
    if (!expected || expected.size > manifestLimit) return null;
    let handle;
    try {
      // NOFOLLOW 在支持的平台拒绝末级链接；祖先和 Windows 联接由逐级 lstat 检查。
      handle = await budget.run(() => open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)), value => value.close());
      if (handle === stopped) { handle = null; return null; }
      const actual = await budget.run(() => handle.stat());
      if (actual === stopped || !actual.isFile() || actual.size > manifestLimit || actual.ino !== expected.ino || actual.dev !== expected.dev) return null;
      const bytes = Buffer.alloc(manifestLimit + 1);
      const read = await budget.run(() => handle.read(bytes, 0, bytes.length, 0));
      if (read === stopped || read.bytesRead > manifestLimit) return null;
      const value = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
    finally {
      if (handle) {
        const closing = handle.close().catch(() => {});
        if (!budget.ended) await closing;
      }
    }
  }

  function issue(name,path,missing,detail) {
    if (!budget.check() || result.issues.length >= maxResults) return;
    result.issues.push({name,path,...(moduleId==='companion'&&explicit.has(keyFor(path))?{explicit:true}:{}),status:inspectionError?'unreadable':'incomplete',detail:inspectionError
      ? '这些文件或目录尚未核实：'+missing.join('、')+'。请检查访问权限或链接位置后重新扫描。' : detail});
  }

  async function pairedPython(path, locations) {
    for (const location of locations) {
      const candidate = resolve(path, location);
      if ((await checkedPath(candidate))?.isFile()) return candidate;
      if (!budget.check()) break;
    }
    return '';
  }

  async function inspect(path) {
    inspectionError = false;
    if (moduleId === 'companion') {
      const named = /airi/i.test(basename(path)), executable = Boolean(await childStat(path,'airi.exe'));
      const bound = explicit.has(keyFor(path)), searchRoot = selected.has(keyFor(path));
      const expected = named || executable || bound || searchRoot;
      const archive = await childStat(path,'resources/app.asar');
      if (!archive) {
        const identified = executable || named && Boolean(await childStat(path,'resources','directory'));
        if (identified || bound || expected && inspectionError) issue('陪伴运行组件',path,['resources/app.asar'],'未找到可用的运行组件 resources/app.asar，请选择完整的组件安装目录。');
        else if (searchRoot) missingExplicit.add(path);
        return false;
      }
      const installation = await budget.run(() => inspectAiriInstall(path));
      if (installation === stopped) return true;
      if (expected || installation.recognized) add('companion-runtime',path,'陪伴运行组件',installation.available?{airiPath:path}:{},installation.available,installation.reason);
      return true;
    }
    if (moduleId === 'drawing' || moduleId === 'comfyui') {
      const main = await childStat(path,'main.py');
      if (!main && !/comfyui/i.test(basename(path))) return false;
      const markers = [['main.py',main],['server.py',await childStat(path,'server.py')],['nodes.py',await childStat(path,'nodes.py')],['comfy/',await childStat(path,'comfy','directory')]];
      const missing = markers.filter(([,found])=>!found).map(([name])=>name);
      if (missing.length) {
        if ((/comfyui/i.test(basename(path)) || markers[3][1]) && markers.filter(([,found])=>found).length >= 2) issue('ComfyUI 本体',path,missing,'未找到可用的本体文件或目录：'+missing.join('、')+'。请选择完整的 ComfyUI 本体目录。');
        return false;
      }
      add('comfyui', path, 'ComfyUI · ' + basename(path), {
        comfyPath: path, pythonPath: await pairedPython(path, ['.venv/Scripts/python.exe','venv/Scripts/python.exe','.venv/bin/python','venv/bin/python','../python_embeded/python.exe','../python/python.exe']), outputPath: join(path, 'output'), workflowPath: join(path, 'user', 'default', 'workflows'),
      });
      return true;
    }
    if (moduleId === 'training') {
      if (!await childStat(path, 'mikazuki', 'directory')) return false;
      const requirements = await childStat(path,'requirements.txt');
      for (const file of ['run_gui.bat', 'run_gui.ps1', 'run_gui.sh', 'run_gui_source.bat', 'run_gui_source.ps1']) {
        if (await childStat(path, file)) {
          if (!requirements) {
            issue('训练环境',path,['requirements.txt'],'未找到可用的依赖清单 requirements.txt，请选择完整的训练器目录。');
            return false;
          }
          const label = /^next[-_ ]?trainer$/i.test(basename(path)) ? '训练环境' : '训练环境 · ' + basename(path);
          add('next-trainer', path, label, { trainerPath: path, pythonPath: await pairedPython(path, ['../python_embeded/python.exe','python_embeded/python.exe','.venv/Scripts/python.exe','.venv/bin/python']) });
          return true;
        }
      }
      if (requirements) issue('训练环境',path,['run_gui 启动脚本'],'未找到 run_gui.bat、run_gui.ps1 或对应的训练器启动脚本，请选择完整的训练器目录。');
      return false;
    }
    if (moduleId === 'qq') {
      const entry = await childStat(path,'index.js');
      if (!entry && !/napcat/i.test(basename(path))) return false;
      const shell = await childStat(path, 'napcat/napcat.mjs');
      const manifestFile = await childStat(path, manifestName);
      if (!shell && !manifestFile) return false;
      const manifest = await readManifest(join(path, manifestName), manifestFile);
      const reasons = [];
      if (!manifestFile) reasons.push('未找到可用的工作台校验清单 '+manifestName);
      else if (!manifest) reasons.push('工作台校验清单 '+manifestName+' 无法读取或解析');
      else if (manifest.schemaVersion !== 1 || manifest.version !== qqVersion || manifest.packageSha256 !== qqPackageSha256) reasons.push('工作台固定版本清单不匹配，需要 NapCat '+qqVersion);
      const missing = [],unverified = [];
      for (const file of criticalFiles) {
        if (!await childStat(path,file)) missing.push(file);
        if (manifest && (typeof manifest.files?.[file] !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.files[file]))) unverified.push(file);
      }
      if (missing.length) reasons.push((inspectionError?'尚未核实运行文件，请检查权限或链接位置：':'未找到可用的运行文件：')+missing.join('、'));
      if (unverified.length) reasons.push('校验清单缺少文件摘要：'+unverified.join('、'));
      if (!reasons.length) add('qq-runtime', path, 'NapCat QQ 运行端 · ' + qqVersion, { installDirectory: path });
      else add('napcat', path, 'NapCat 组件 · ' + basename(path), {}, false, reasons.join('；')+'。请通过工作台安装固定版本运行包。');
      return true;
    }
    return false;
  }

  async function scanDirectory(item) {
    inspectionError = false;
    const value = await checkedPath(item.path);
    if (moduleId === 'companion' && explicit.has(keyFor(item.path)) && !value?.isDirectory()) {
      issue('陪伴运行组件',item.path,['安装目录'],'未找到可用的组件安装目录，请选择现有的完整组件文件夹。');
      return;
    }
    if (!value || !budget.check()) return;
    if (value.isFile()) {
      if (moduleId === 'mc-skin' && pythonName(basename(item.path))) add('python', item.path, 'Python · ' + basename(dirname(item.path)), { pythonPath: item.path });
      return;
    }
    if (!value.isDirectory()) return;
    result.visited++;
    if (await inspect(item.path) || !budget.check()) return;
    let directory;
    const children = [[], [], []];
    const capacity = pendingLimit;
    try {
      directory = await budget.run(() => (disk?.opendir || opendir)(item.path, { bufferSize: 32 }), value => value.close());
      if (directory === stopped) { directory = null; return; }
      while (budget.check()) {
        const entry = await budget.run(() => directory.read());
        if (entry === stopped || !entry) break;
        if (++entries > entryLimit) { budget.stop('已达到目录条目上限，可指定目录后重新扫描。'); break; }
        if (entry.isSymbolicLink()) continue;
        const child = join(item.path, entry.name);
        if (moduleId === 'mc-skin' && entry.isFile() && pythonName(entry.name)) {
          if (await childStat(item.path, entry.name)) add('python', child, 'Python · ' + basename(item.path), { pythonPath: child });
          continue;
        }
        if (!entry.isDirectory() || skippedNames.has(entry.name.toLowerCase()) || skippedChildren.has(entry.name.toLowerCase()) || queued.has(keyFor(child)) || seen.has(keyFor(child))) continue;
        if (item.depth >= maxDepth) { warn('已达到扫描深度上限，可指定目录后重新扫描。'); continue; }
        const rank = Math.max(item.rank, priority(entry.name, moduleId));
        const total = children.reduce((sum, group) => sum + group.length, 0);
        if (total >= capacity) {
          warn('已达到扫描目录数量上限，可指定目录后重新扫描。');
          const replace = children.findIndex(group => group.length > 0);
          if (replace < 0 || replace >= rank) continue;
          children[replace].pop();
        }
        children[rank].push({ path: child, depth: item.depth + 1, rank, initial: false, sequence: sequence++ });
      }
    } catch {
      warn('部分目录无法列出，已跳过。');
    } finally {
      if (directory) {
        const closing = directory.close().catch(() => {});
        if (!budget.ended) await closing;
      }
    }
    for (const group of children.reverse()) for (const child of group) {
      queued.add(keyFor(child.path));
      queue.push(child);
    }
    orderQueue();
  }

  try {
    if (!budget.check()) return result;
    if (!maxDirectories || !maxResults) {
      budget.stop(!maxDirectories ? '已达到扫描目录数量上限，可指定目录后重新扫描。' : '已达到候选数量上限，可指定目录后重新扫描。');
      return result;
    }
    for (const input of inputs) {
      if (!budget.check()) break;
      const path = localPath(input);
      if (!path) { warn('已跳过非普通本地绝对路径。'); continue; }
      if (skippedPath(path) || queued.has(keyFor(path))) continue;
      if (queue.length >= pendingLimit) { warn('已达到扫描目录队列上限，可指定目录后重新扫描。'); break; }
      queued.add(keyFor(path));
      queue.push({ path, depth: 0, rank: priority(basename(path), moduleId), initial: true, sequence: sequence++ });
    }
    while (queue.length && budget.check()) {
      if (result.visited >= maxDirectories) { budget.stop('已达到扫描目录数量上限，可指定目录后重新扫描。'); break; }
      const item = queue.shift();
      queued.delete(keyFor(item.path));
      seen.add(keyFor(item.path));
      await scanDirectory(item);
    }
    // 用户也可能选择软件的父目录；只有完整扫描仍没有组件线索时才解释该选择。
    if (!result.partial && !result.candidates.length && !result.issues.length) {
      inspectionError = false;
      for (const path of missingExplicit) issue('陪伴运行组件',path,['resources/app.asar'],'此扫描目录中未找到可用的陪伴运行组件 resources/app.asar，请选择完整的组件安装目录。');
    }
    return result;
  } finally {
    budget.dispose();
    result.warnings = [...warnings];
  }
}
