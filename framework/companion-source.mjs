import fs from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';

const require=createRequire(import.meta.url);
let disk=fs;
try {disk=require('original-fs');} catch {}
export const AIRI_VERSION='0.12.0-beta.5';

// Read the archive as a file even inside Electron; never extract or alter the installation.
export function readAiriArchiveFile(archive,path,limit=8*1024*1024) {
  if(path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\0]/.test(path))throw new Error('陪伴组件资源路径无效。');
  const fd=disk.openSync(archive,'r');
  try {
    const size=disk.fstatSync(fd).size,prefix=Buffer.alloc(16);
    if(disk.readSync(fd,prefix,0,16,0)!==16)throw new Error('陪伴组件资源头不完整。');
    const length=prefix.readUInt32LE(12),offset=8+prefix.readUInt32LE(4);
    if(length<2||length>32*1024*1024||offset<length+16||offset>size)throw new Error('陪伴组件资源头无效。');
    const bytes=Buffer.alloc(length);disk.readSync(fd,bytes,0,length,16);
    let entry=JSON.parse(bytes.toString('utf8'));
    for(const part of path.split('/'))entry=entry?.files?.[part];
    if(!entry||entry.files||entry.link||entry.unpacked||!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>limit)throw new Error('陪伴组件资源缺失或超出范围：'+path);
    const start=offset+Number(entry.offset);
    if(!Number.isSafeInteger(start)||start<offset||start+entry.size>size)throw new Error('陪伴组件资源位置无效。');
    const result=Buffer.alloc(entry.size);
    if(disk.readSync(fd,result,0,result.length,start)!==result.length)throw new Error('陪伴组件资源读取不完整。');
    return result;
  } finally {disk.closeSync(fd);}
}

export function inspectAiriInstall(installPath=process.env.AI_FUTURE_AIRI_PATH||'E:\\AI-未来\\AIRI') {
  let directory='',recognized=false;
  try {
    directory=resolve(installPath);
    const archive=join(directory,'resources','app.asar');
    const metadata=JSON.parse(readAiriArchiveFile(archive,'package.json',128*1024));
    recognized=metadata.name==='ai.moeru.airi';
    if(!recognized)throw new Error('此目录的应用归档不是 AIRI 陪伴运行组件。');
    if(metadata.version!==AIRI_VERSION)throw new Error(`当前兼容组件版本 ${AIRI_VERSION}，检测到 ${metadata.version||'未知版本'}。`);
    readAiriArchiveFile(archive,'out/renderer/index.html',128*1024);
    const source=readAiriArchiveFile(archive,'out/main/index.js').toString('utf8');
    adaptAiriMain(source,{resourcesPath:join(directory,'resources'),serverChannelPort:43101});
    return {available:true,recognized,version:metadata.version,installPath:directory,archive,mainPath:join(archive,'out/main/index.js'),resourcesPath:join(directory,'resources')};
  } catch(error) {return {available:false,recognized,version:null,installPath:directory,reason:'陪伴运行组件不可用：'+(error.code==='ENOENT'?'未找到运行组件，请检查安装位置。':error.message)};}
}

function replaceOnce(source,needle,replacement) {
  const first=source.indexOf(needle);
  if(first<0||source.indexOf(needle,first+needle.length)>=0)throw new Error('陪伴组件主进程结构发生变化，不能使用当前兼容适配。');
  return source.slice(0,first)+replacement+source.slice(first+needle.length);
}

export function adaptAiriMain(source,{resourcesPath,serverChannelPort}) {
  if(!Number.isInteger(serverChannelPort)||serverChannelPort<1||serverChannelPort>65535)throw new Error('陪伴组件通道端口无效。');
  let result=replaceOnce(source,'return env.SERVER_CHANNEL_PORT ? Number.parseInt(env.SERVER_CHANNEL_PORT) : 6121;',`return ${serverChannelPort};`);
  result=replaceOnce(result,'import messages from "@proj-airi/i18n/locales";',`import upstreamMessages from "@proj-airi/i18n/locales";
import {companionBranding} from ${JSON.stringify(new URL('../desktop/companion-branding.cjs',import.meta.url).href)};
const messages = companionBranding(upstreamMessages, 'messages');`);
  result=replaceOnce(result,'setupAutoUpdater({\n\t\t\tenabled: true,','setupAutoUpdater({\n\t\t\tenabled: false,');
  result=replaceOnce(result,'const hostService = await setupExtensionHostServiceInternal(options);','const hostService = await setupExtensionHostServiceInternal(options);\n  workbenchBridge.extensionHost = hostService;');
  result=replaceOnce(result,'const mainWindow = injeca.provide("windows:main", {\n\t\tdependsOn: {','const mainWindow = injeca.provide("windows:main", {\n\t\tdependsOn: {\n\t\t\tpluginHost,');
  result=replaceOnce(result,'async function setupMainWindowElectronInvokes(params) {',`async function setupMainWindowElectronInvokes(params) {
  workbenchBridge.controls = {
    stage: async () => params.window.show(),
    chat: async () => (await params.chatWindow()).show(),
    settings: async route => params.settingsWindow.openWindow(route),
    editor: async () => params.editorWindow.openWindow(),
  };`);
  result=result.replace(/\bprocess(?:\$1)?\.resourcesPath\b/g,JSON.stringify(resourcesPath));
  return result+`
// Workbench lifecycle hook. The installed archive stays unchanged.
export const workbenchBridge = {
  controls: null,
  async shutdown() {
    if (appExiting) return;
    appExiting = true;
    await emitAppBeforeQuit();
    await workbenchBridge.extensionHost?.dispose();
    await injeca.stop();
    skipFileLogging = true;
    await fileLogger.close();
  },
};
`;
}
