import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname,resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchDetachedPreview} from './launch-workbench-preview.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const configPath=process.argv[2];
if(!configPath||!isAbsolute(configPath))throw new Error('缺少桌面入口的绝对配置路径。');
const config=JSON.parse(await readFile(configPath,'utf8'));
if(config.version!==1||typeof config.sourceRoot!=='string'||resolve(config.sourceRoot).toLowerCase()!==root.toLowerCase())throw new Error('桌面入口和当前源码目录不一致，请重新安装入口。');
for(const field of ['profileDirectory','electronExecutable'])if(typeof config[field]!=='string'||!isAbsolute(config[field]))throw new Error('桌面入口的路径配置无效。');
const entry=join(root,'desktop/workbench.cjs');
for(const file of [entry,config.electronExecutable])if(!existsSync(file))throw new Error('启动文件不存在：'+file);
const result=await launchDetachedPreview({executable:config.electronExecutable,args:[entry],profileDirectory:config.profileDirectory,initialRoute:''});
const receipt={...result,sourceRoot:root,entry,profileDirectory:config.profileDirectory,at:new Date().toISOString()};
await writeFile(join(config.profileDirectory,'logs/desktop-entry-last-launch.json'),JSON.stringify(receipt,null,2)+'\n','utf8');
console.log(JSON.stringify(receipt));
