import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const MAX_ENTRIES = 2048;
const SCOPE_DETAIL = '仅检查本地 models/vae_approx 顶层文件；extra_model_paths 和其他外部模型路径未核实。';
const families = [
  [/^taesd_decoder(?:[._-]|$)/i, 'SD1.5'],
  [/^taesdxl_decoder(?:[._-]|$)/i, 'SDXL'],
  [/^taesd3_decoder(?:[._-]|$)/i, 'SD3'],
  [/^taef1_decoder(?:[._-]|$)/i, 'Flux'],
  [/^taef2_decoder(?:[._-]|$)/i, 'Flux2'],
  [/^taeqi2_1_decoder(?:[._-]|$)/i, 'QwenImage2.1'],
  [/^taehv(?:[._-]|$)/i, 'HunyuanVideo'],
  [/^taeh3(?:[._-]|$)/i, 'MiniMaxH3Video'],
  [/^taeltx_2(?:[._-]|$)/i, 'LTX2'],
  [/^lighttaehy1_5(?:[._-]|$)/i, 'HunyuanVideo1.5'],
  [/^lighttaew2_1(?:[._-]|$)/i, 'Wan2.1'],
  [/^lighttaew2_2(?:[._-]|$)/i, 'Wan2.2'],
];

async function localDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\u0000-\u001f\u007f]/.test(value) || process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':'))) throw new Error('目录须为普通本地磁盘的绝对路径。');
  const target = resolve(value); let current = parse(target).root;
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('未扫描符号链接或目录联接。');
    if (!info.isDirectory()) throw new Error('路径包含非目录项目。');
  }
  return target;
}

function decoderFamily(name) {
  if (!/\.(?:safetensors|pth)$/i.test(name) || /(?:^|[._-])encoder(?:[._-]|$)/i.test(name)) return null;
  const known = families.find(([pattern]) => pattern.test(name));
  if (known) return known[1];
  return /(?:^|[._-])decoder(?:[._-]|$)/i.test(name) ? 'unknown' : null;
}

export async function inspectPreviewModels(comfyPath) {
  const result = { status: 'unverified', decoders: [], directory: null, scope: 'local', detail: SCOPE_DETAIL };
  let root;
  try { root = await localDirectory(comfyPath); }
  catch (error) { return { ...result, detail: `本地预览目录未核实：${error.message} ${SCOPE_DETAIL}` }; }
  result.directory = join(root, 'models', 'vae_approx');
  let scanStarted = false;
  try {
    await localDirectory(result.directory);
    scanStarted = true;
    let scanned = 0; const incomplete = new Set();
    for await (const entry of await opendir(result.directory)) {
      if (++scanned > MAX_ENTRIES) { incomplete.add('扫描上限'); break; }
      const family = decoderFamily(entry.name);
      if (!family) continue;
      const info = await lstat(join(result.directory, entry.name));
      if (info.isSymbolicLink()) { incomplete.add('符号链接'); continue; }
      if (!info.isFile()) continue;
      if (!info.size) { incomplete.add('空文件'); continue; }
      result.decoders.push({ name: entry.name, family });
    }
    result.decoders.sort((a, b) => a.name.localeCompare(b.name));
    result.status = result.decoders.length ? 'available' : incomplete.size ? 'unverified' : 'missing';
    result.detail = `${result.decoders.length ? `发现 ${result.decoders.length} 个本地预览解码器候选；家族按文件名识别，权重内容与当前模型架构兼容性未核实。` : incomplete.size ? '本地扫描未完成，无法确认是否缺少解码器。' : '本地目录未发现预览解码器。'}${incomplete.size ? ` 部分目录项未核实（${[...incomplete].join('、')}）。` : ''} ${SCOPE_DETAIL}`;
    return result;
  } catch (error) {
    const missing = !scanStarted && error.code === 'ENOENT';
    return { ...result, status: missing ? 'missing' : 'unverified', detail: `${missing ? '本地预览目录不存在。' : `本地预览目录未核实：${error.message}`} ${SCOPE_DETAIL}` };
  }
}
