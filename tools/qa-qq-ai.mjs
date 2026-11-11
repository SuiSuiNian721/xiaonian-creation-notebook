import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runWorkbenchCodex } from '../framework/codex-bridge.mjs';
import { findCodexCli } from '../framework/codex-cli.mjs';

const directory=resolve(process.env.AI_FUTURE_QQ_QA_DIR||'qa/qq-ai-'+Date.now());
await mkdir(directory,{recursive:true});
const report={at:new Date().toISOString(),policy:'chat-only',ok:false};
try{
  const result=await runWorkbenchCodex({cli:findCodexCli(),cwd:directory,prompt:'只输出 QQ_TEXT_OK，不调用任何工具。',policy:'chat-only',model:process.env.AI_FUTURE_QQ_MODEL||'',reasoningEffort:'low',timeoutMs:60000});
  report.ok=result.text.trim()==='QQ_TEXT_OK';report.usage=result.usage;
  if(!report.ok)report.error='实际文本回复与约定不符。';
}catch(error){report.error=error.message;}
await writeFile(join(directory,'ai-result.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({...report,directory},null,2));
if(!report.ok)process.exitCode=1;
