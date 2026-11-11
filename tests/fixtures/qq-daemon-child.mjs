import {writeFile} from 'node:fs/promises';
await writeFile(process.env.QQ_TEST_MARKER,String(process.pid),'utf8');
setInterval(()=>{},1000);
