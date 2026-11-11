import { join, toNamespacedPath } from 'node:path';

const processPath = path => process.platform === 'win32' && path.length >= 260 ? toNamespacedPath(path) : path;

export function minecraftRuntimeLaunch({ runtimeRoot, nodePath, cwd = runtimeRoot, args = [], environment = process.env }) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].map(key => [key, environment[key]]));
  // Windows CreateProcess needs an explicit namespace for deep executable paths.
  // tsx starts esbuild internally, so give it the component's own executable.
  if (process.platform === 'win32') env.ESBUILD_BINARY_PATH = toNamespacedPath(join(runtimeRoot, `node_modules/@esbuild/win32-${process.arch}/esbuild.exe`));
  return {
    command: processPath(nodePath),
    args: ['--no-node-snapshot', join(runtimeRoot, 'worker.mjs'), ...args],
    options: { cwd: processPath(cwd), env, windowsHide: true },
  };
}
