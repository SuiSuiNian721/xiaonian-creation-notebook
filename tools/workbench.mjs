import { existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const candidates=[process.env.AI_FUTURE_ELECTRON,resolve(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean);
const executable=candidates.find(existsSync);
if(!executable) throw new Error('未找到 Electron 开发运行时。请使用打包后的 Windows 工作台，或设置 AI_FUTURE_ELECTRON。');
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
if(process.argv.includes('--qa')) {
  env.AI_FUTURE_WORKBENCH_QA='1';
  env.AI_FUTURE_WORKBENCH_QA_DIR ||= resolve(root,'qa',`workbench-${Date.now()}`);
  console.log(`工作台隔离验证目录：${env.AI_FUTURE_WORKBENCH_QA_DIR}`);
} else { delete env.AI_FUTURE_WORKBENCH_QA; delete env.AI_FUTURE_WORKBENCH_QA_DIR; }
const child=spawn(executable,[resolve(root,'desktop/workbench.cjs')],{cwd:root,env,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
