import { readFile, readdir } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { WorkbenchError } from './contracts.mjs';
import { regularLocal } from './training-dataset.mjs';
import { trainingPath } from './training-runtime.mjs';

const engines = new Set(['kohya', 'musubi', 'ai-toolkit', 'diffsynth', 'anima-fast', 'moss']);
const present = value => value !== undefined && value !== null && value !== '';

// csv.DictReader is used by DiffSynth. In particular, commas, doubled quotes
// and newlines inside quoted prompts must not change which columns are paths.
function csvRecords(text) {
  const records = []; let row = [], field = '', quoted = false, started = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && !field) { quoted = true; started = true; }
    else if (character === ',') { row.push(field); field = ''; started = true; }
    else if (character === '\r' || character === '\n') {
      if (started || field || row.length) records.push([...row, field]);
      row = []; field = ''; started = false;
      if (character === '\r' && text[index + 1] === '\n') index++;
    } else { field += character; started = true; }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (started || field || row.length) records.push([...row, field]);
  const headers = records.shift() || [];
  return records.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
}

function referencePath(value, base, label) {
  // Check the raw value before resolving: resolve() could hide a device/UNC
  // prefix or turn a drive-relative path into a different local path.
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/.test(value) || /^[\\/]{2}/.test(value) || /^[A-Za-z]:[^\\/]/.test(value)) throw new WorkbenchError(400, `${label}须为本地绝对路径或相对数据集路径。`);
  if (isAbsolute(value)) return trainingPath(value, label);
  if (!base) throw new WorkbenchError(400, `${label}使用相对路径时需要已启动的训练内核目录，请改用本地绝对路径。`);
  return trainingPath(resolve(base, value), label);
}

export async function protectDataset(config, { engine = 'kohya', root: runtimeRoot } = {}) {
  if (!engines.has(engine)) throw new WorkbenchError(400, `此训练引擎没有数据集检查规则：${engine}`);
  const inspected = new Map();
  async function local(value, label, directory = false) {
    const path = trainingPath(value, label);
    try { return { path, info: await regularLocal(path, directory) }; }
    catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError(400, `${label}不存在或不可读取：${path}`);
    }
  }
  async function tree(value, label) {
    const { path } = await local(value, label, true);
    if (inspected.has(path)) return inspected.get(path);
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch { throw new WorkbenchError(400, `${label}不存在或不可读取：${path}`); }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new WorkbenchError(400, `${label}中存在链接或目录联接，请选择实际本地目录：${entry.name}`);
      if (entry.isDirectory()) await tree(join(path, entry.name), label);
    }
    inspected.set(path, entries);
    return entries;
  }
  async function textFile(value, label) {
    const { path, info } = await local(value, label);
    if (info.size > 32 * 1024 * 1024) throw new WorkbenchError(413, `${label}超过 32 MiB。`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)).replace(/^\uFEFF/, ''); }
    catch { throw new WorkbenchError(400, `${label}不可读取或不是有效 UTF-8。`); }
  }
  async function directories(values, label, allowLines = false) {
    if (!present(values)) return;
    if (allowLines && typeof values === 'string') values = values.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!Array.isArray(values)) throw new WorkbenchError(400, `${label}必须是目录数组。`);
    for (const value of values) await tree(value, label);
  }
  async function metadata() {
    const base = trainingPath(config.dataset_base_path, 'dataset_base_path 数据集根目录');
    await local(base, 'dataset_base_path 数据集根目录', true);
    const text = await textFile(config.dataset_metadata_path, 'dataset_metadata_path 元数据');
    let rows;
    try {
      switch (extname(config.dataset_metadata_path).toLowerCase()) {
        case '.json': rows = JSON.parse(text); break;
        case '.jsonl': rows = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); break;
        case '.csv': rows = csvRecords(text); break;
        default: throw new Error('仅支持 CSV / JSON / JSONL');
      }
    } catch (error) { throw new WorkbenchError(400, `数据集元数据解析失败：${error.message}`); }
    if (!Array.isArray(rows) || !rows.length) throw new WorkbenchError(400, '数据集元数据必须是非空记录列表。');
    for (const [index, row] of rows.entries()) {
      if (!row || typeof row !== 'object' || typeof row.image !== 'string' || typeof row.prompt !== 'string') throw new WorkbenchError(400, `数据集元数据第 ${index + 1} 条需要 image 和 prompt 字符串。`);
      await local(referencePath(row.image, base, '元数据 image'), '元数据 image');
      if (config.training_task !== 'image-edit') continue;
      let references = row.edit_image;
      if (typeof references === 'string') {
        try { references = references.trimStart().startsWith('[') ? JSON.parse(references) : [references]; }
        catch { throw new WorkbenchError(400, `元数据第 ${index + 1} 条 edit_image 数组解析失败。`); }
      }
      if (!Array.isArray(references) || !references.length) throw new WorkbenchError(400, `元数据第 ${index + 1} 条 edit_image 需要参考图路径或非空数组。`);
      for (const reference of references) await local(referencePath(reference, base, '元数据 edit_image'), '元数据 edit_image');
    }
  }
  async function kohyaMetadata(value, imageDir) {
    const text = await textFile(value, 'Kohya 元数据');
    let records;
    try { records = JSON.parse(text); } catch { throw new WorkbenchError(400, 'Kohya 元数据 JSON 解析失败。'); }
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new WorkbenchError(400, 'Kohya 元数据必须是图像键到标注的对象。');
    for (const key of Object.keys(records)) {
      // sd-scripts accepts literal paths, image stems relative to image_dir,
      // and NPZ-only data. Check possible references without changing keys or
      // requiring a stem itself to exist; the engine still chooses its input.
      const bases = isAbsolute(key) ? [undefined] : [...new Set([runtimeRoot, imageDir].filter(Boolean))];
      if (!bases.length) bases.push(undefined);
      for (const base of bases) {
        const path = referencePath(key, base, 'Kohya 元数据图像键');
        const stem = path.slice(0, path.length - extname(path).length);
        const candidates = [path, stem + '.npz', stem + '_flip.npz', ...['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.avif', '.jxl', '.npz', '_flip.npz'].flatMap(suffix => [path + suffix, path + suffix.toUpperCase()])];
        for (const candidate of new Set(candidates)) {
          try { await regularLocal(candidate); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
  }
  async function kohyaConfig() {
    const text = await textFile(config.dataset_config, 'dataset_config 数据集配置');
    let parsed;
    try { parsed = parseToml(text); }
    catch { throw new WorkbenchError(400, 'dataset_config 数据集配置 TOML 解析失败。'); }
    // Keep repeats, is_reg, bucket settings and metadata contents untouched.
    // Semantic validity (including duplicates) remains the engine's preflight.
    for (const dataset of Array.isArray(parsed.datasets) ? parsed.datasets : []) {
      for (const subset of Array.isArray(dataset?.subsets) ? dataset.subsets : []) {
        if (present(subset?.image_dir)) await tree(referencePath(subset.image_dir, runtimeRoot, '数据子集 image_dir'), '数据子集 image_dir');
        if (present(subset?.metadata_file)) await kohyaMetadata(referencePath(subset.metadata_file, runtimeRoot, '数据子集 metadata_file'), present(subset.image_dir) ? referencePath(subset.image_dir, runtimeRoot, '数据子集 image_dir') : undefined);
        if (present(subset?.conditioning_data_dir)) await tree(referencePath(subset.conditioning_data_dir, runtimeRoot, '数据子集 conditioning_data_dir'), '数据子集 conditioning_data_dir');
      }
    }
  }

  if (engine === 'moss') {
    const preprocess = config.run_preprocess !== false && config.run_preprocess !== 'false';
    if (preprocess || present(config.src)) await tree(config.src, 'src 数据集目录');
    if (!preprocess) await tree(config.cache_dir, 'cache_dir 缓存目录');
    return;
  }
  if (engine === 'diffsynth') {
    if (config.dataset_format === 'metadata') return metadata();
    const editing = config.training_task === 'image-edit';
    await tree(config.train_data_dir || (editing ? config.output_data_dir : undefined), '训练数据目录');
    if (editing) await directories(config.control_data_dirs ?? config.input_data_dirs, 'Edit 参考图目录');
    return;
  }
  if (engine === 'anima-fast') {
    await tree(config.source_image_dir || config.train_data_dir, 'source_image_dir / train_data_dir 数据集目录');
    if (present(config.resized_image_dir)) await tree(config.resized_image_dir, 'resized_image_dir 训练图片目录');
    return;
  }
  if (engine === 'ai-toolkit') {
    await tree(config.train_data_dir, '训练数据目录');
    await directories(config.control_data_dirs, 'control_data_dirs 参考图目录', true);
    return;
  }
  // These launchers invoke validate_data_dir, which moves loose images into a
  // generated repeat directory. Only Kohya honours dataset_config as an opt-out.
  const entries = await tree(config.train_data_dir, '训练数据目录');
  if (engine === 'kohya') {
    if (present(config.dataset_config)) return kohyaConfig();
    if (present(config.reg_data_dir)) await tree(config.reg_data_dir, 'reg_data_dir 正则化数据目录');
    if (present(config.in_json)) await kohyaMetadata(config.in_json, config.train_data_dir);
    if (config.model_train_type === 'sdxl-finetune') return;
  }
  if (!entries.some(entry => entry.isDirectory() && /^\d+_.+/.test(entry.name))) throw new WorkbenchError(400, `此目录没有重复次数子目录；为保护散图和标注，工作台不会自动整理。${engine === 'kohya' ? '请提供有效的 dataset_config，或自行准备' : '请自行准备'} 10_角色名 这类目录。`);
}
