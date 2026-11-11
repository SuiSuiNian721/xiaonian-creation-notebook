import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aurora = process.argv.includes('--aurora');
const output = aurora ? 'dist-aurora' : 'dist';
const productName = aurora ? 'AI未来 Aurora' : 'AI未来 Demo';
const toolkit = process.env.AI_FUTURE_BUILD_TOOLS || 'F:\\小汐的研究日志';
const requireTools = createRequire(resolve(toolkit, 'package.json'));
const { build, Platform, Arch } = requireTools('electron-builder');
const electronDist = resolve(toolkit, 'node_modules/electron/dist');
if (!existsSync(resolve(electronDist, 'electron.exe'))) throw new Error('Electron 构建运行时不存在。');
const electronPackage = requireTools('electron/package.json');
const { createAiriAssets } = await import(pathToFileURL(resolve(root, 'src/airi-assets.mjs')).href);
const airi = await createAiriAssets();
if (typeof airi.materialize === 'function') await airi.materialize(resolve(root, 'resources/airi'));
const artifacts = await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget('dir', Arch.x64),
  config: {
    appId: aurora ? 'ai.future.demo.aurora' : 'ai.future.demo', productName,
    electronDist, electronVersion: electronPackage.version,
    asar: false, npmRebuild: false,
    directories: { output },
    extraMetadata: { main: aurora ? 'desktop/main-aurora.cjs' : 'desktop/main.cjs' },
    files: ['desktop/**', 'src/**', aurora ? 'public-aurora/**' : 'public/**', 'tools/qa-*.mjs', 'resources/airi/**', 'package.json', 'THIRD_PARTY_NOTICES.md', 'README.md'],
    win: { target: 'dir', signAndEditExecutable: false },
  },
});
mkdirSync(resolve(root, output), { recursive: true });
writeFileSync(resolve(root, output, 'build-record.json'), JSON.stringify({ at: new Date().toISOString(), variant: aurora ? 'aurora' : 'classic', productName, electron: electronPackage.version, airi: { available: airi.available, version: airi.version, note: airi.note }, artifacts }, null, 2), 'utf8');
console.log(`Windows ${productName} 已构建至 ${output}/win-unpacked。`);
