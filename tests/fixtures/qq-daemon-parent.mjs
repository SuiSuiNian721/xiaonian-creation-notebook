import {QQProcessHost} from '../../framework/qq-process.mjs';
import {writeFile} from 'node:fs/promises';
const [slot,child,marker,receipt]=process.argv.slice(2);
const host=new QQProcessHost({slot});
const status=await host.start({command:process.execPath,args:[child],options:{cwd:slot,env:{...process.env,QQ_TEST_MARKER:marker}},webPort:31001,onebotPort:31002});
await writeFile(receipt,JSON.stringify(status),'utf8');
await host.close();
