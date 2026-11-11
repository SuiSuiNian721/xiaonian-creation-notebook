import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {findCodexCli} from './codex-cli.mjs';

const execute=promisify(execFile);

/** Read-only CLI checks. Raw process output may contain credentials and is never returned. */
export async function inspectCodexCli({cli=findCodexCli(),run=execute}={}){
  const result={cli,installed:false,version:'',authenticated:false,status:'unverified',detail:''};
  const options={windowsHide:true,timeout:5000,maxBuffer:16384,encoding:'utf8'};
  try{
    const version=await run(cli,['--version'],options);
    result.installed=true;
    result.version=String(version.stdout||'').trim().match(/^codex(?:-cli)?\s+[\w.+-]+/i)?.[0]||'版本未识别';
  }catch(error){
    result.status=error.code==='ENOENT'?'not-installed':'unverified';
    result.detail=result.status==='not-installed'?'未找到 Codex CLI。安装后重新检查；已安装时确认桌面工作台能找到 codex.exe。':'Codex CLI 未能响应版本检查。请确认程序可以运行，再重新检查。';
    return result;
  }
  try{
    const login=await run(cli,['login','status'],options),output=String(login.stdout||login.stderr||'');
    if(/chatgpt/i.test(output)){
      result.status='ready';result.authenticated=true;result.detail='已找到 CLI 并确认 ChatGPT 登录；模型是否可用仍以测试连接为准。';
    }else{
      result.status='unsupported-auth';result.detail='工作台的 Codex 桥接需要 ChatGPT 登录。请在此 CLI 中运行 codex login，选择 ChatGPT 登录后重新检查。';
    }
  }catch(error){
    const output=String(error.stdout||error.stderr||'');
    result.status=/not logged in|not authenticated|sign in/i.test(output)?'not-logged-in':'unverified';
    result.detail=result.status==='not-logged-in'?'Codex CLI 尚未登录。请运行 codex login 完成 ChatGPT 登录，再重新检查。':'无法确认 Codex CLI 的登录状态。请在终端检查此 CLI；版本不兼容时从官方更新后重试。';
  }
  return result;
}
