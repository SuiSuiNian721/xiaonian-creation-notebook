import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const WORKBENCH_VERSION = '1.0.0';
export const BASE_PACKAGE_MAX_BYTES = 450 * 1024 ** 2;
export const WORKBENCH_FILES = [
  'desktop/workbench.cjs', 'desktop/external-resources.cjs', 'desktop/path-picker.cjs', 'desktop/downloads.cjs',
  'desktop/workbench-preload.cjs', 'desktop/workbench-immersion.cjs',
  'desktop/companion-*.cjs', 'desktop/companion-*.mjs',
  'desktop/process-stdio.cjs', 'desktop/process-log-window.cjs',
  'framework/**', 'resources/media/**', 'resources/voice/**', 'resources/companion/**', 'public-workbench/**',
  'integrations/xiaoxi/**', 'integrations/comfy/**', 'integrations/moss-voice/**',
  'integrations/qwen-voice/**', 'integrations/minecraft-pixel-skin/**', 'integrations/minecraft-skin/**',
  '!integrations/airi-minecraft/**', '!integrations/next-trainer/**',
  '!**/__pycache__/**', '!**/*.pyc',
  'tools/workbench-mcp.mjs', 'tools/qq-extract.ps1', 'tools/ComfyUI-ProcessControl.ps1',
  'tools/qa-workbench.mjs', 'tools/qa-companion.mjs', 'tools/qa-card-studio.mjs',
  'tools/qa-drawing.mjs', 'tools/qa-drawing-manager.mjs', 'tools/qa-launcher-split.mjs',
  'tools/qa-process-log.mjs', 'tools/qa-mc-skin.mjs', 'tools/skin-qa-fixture.mjs',
  'package.json', 'WORKBENCH.md', 'docs/workbench-*.md', 'THIRD_PARTY_NOTICES.md',
  'LICENSE', 'NOTICE', 'LICENSING.md',
];

export function createWorkbenchBuildConfig({ root, output, electronDist, electronVersion, catalogPath }) {
  if (!catalogPath) throw new Error('基础包需要固定的组件发布目录。');
  return {
    appId: 'ai.future.workbench', productName: '小念的创作笔记', electronDist, electronVersion,
    asar: false, npmRebuild: false, directories: { output },
    electronLanguages: ['zh-CN', 'en-US'],
    extraMetadata: { main: 'desktop/workbench.cjs', version: WORKBENCH_VERSION, description: '小念的创作笔记' },
    files: [...WORKBENCH_FILES],
    extraResources: [
      { from: resolve(root, 'docs/character-life-sources.md'), to: 'character-life-sources.md' },
      { from: resolve(catalogPath), to: 'component-catalog.json' },
    ],
    win: { target: 'dir', icon: resolve(root,'public-workbench/app.ico'), signAndEditExecutable: true },
  };
}

export async function assertBasePackage({ directory, maxBytes = BASE_PACKAGE_MAX_BYTES }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('基础包体积预算无效。');
  let bytes = 0;
  const files = [];
  async function walk(path, relative = '') {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('基础包不允许链接：' + relative);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(resolve(path, name), relative ? relative + '/' + name : name);
      return;
    }
    if (!info.isFile()) throw new Error('基础包文件类型无效：' + relative);
    if (/(?:^|\/)(?:airi-minecraft|next-trainer)(?:\/|$)|\.afcomponent$/i.test(relative)) throw new Error('基础包混入可选组件：' + relative);
    if (/(?:^|\/)node(?:\.exe)?$/i.test(relative)) throw new Error('基础包混入独立 Node：' + relative);
    if (/\.(?:safetensors|gguf|ggml|ckpt|pt|pth|onnx)$/i.test(relative)) throw new Error('基础包混入模型权重：' + relative);
    bytes += info.size;
    if (bytes > maxBytes) throw new Error(`基础包超过 ${maxBytes} 字节预算：${bytes} 字节。`);
    files.push({ path: relative, bytes: info.size });
  }
  await walk(resolve(directory));
  return { bytes, maxBytes, files };
}
