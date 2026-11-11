import {escape as e,help} from './components.js';

export function mountCodexDiagnostics(root,ctx){
  root.innerHTML=`<details class="setup-guide" data-codex-diagnostics><summary>本机 Codex 检查</summary><div class="heading-title">${help('Codex 桥接直接使用本机 Codex CLI 和它的 ChatGPT 登录。这里仅读取版本和登录状态，不发送模型请求。','Codex 本机依赖说明')}</div><div class="drawing-actions"><button type="button" class="button small" data-codex-check>检查 CLI 与登录</button><a class="button small" href="https://github.com/openai/codex#quickstart" target="_blank" rel="noreferrer">获取／更新 Codex CLI</a><button type="button" class="button small" data-codex-login hidden>复制登录命令</button></div><div data-codex-result role="status" aria-live="polite"></div></details>`;
  const result=root.querySelector('[data-codex-result]'),check=root.querySelector('[data-codex-check]'),login=root.querySelector('[data-codex-login]');let cli='';
  check.addEventListener('click',()=>void ctx.action(check,async()=>{
    result.textContent='正在检查本机 CLI 与登录状态…';
    try{
      const state=await ctx.api('/api/ai/codex/status',{timeoutMs:15000,signal:ctx.signal});if(ctx.signal.aborted)return;
      cli=state.cli;login.hidden=!state.installed;
      result.innerHTML=`<p class="form-feedback ${state.status==='ready'?'':'error'}">${e(state.detail)}</p><dl class="launcher-versions"><dt>CLI</dt><dd>${e(state.cli)}</dd><dt>版本</dt><dd>${e(state.version||'未读取')}</dd></dl>`;
    }catch(error){if(!ctx.signal.aborted)result.textContent=error.message;}
  }),{signal:ctx.signal});
  login.addEventListener('click',()=>void ctx.action(login,async()=>{
    try{await navigator.clipboard.writeText("& '"+String(cli).replace(/'/g,"''")+"' login");if(!ctx.signal.aborted)ctx.notify('已复制登录命令。请在 PowerShell 中运行，完成 ChatGPT 登录后重新检查。');}
    catch(error){if(!ctx.signal.aborted)ctx.notify('无法复制登录命令：'+error.message,true);}
  }),{signal:ctx.signal});
  return {update(provider){root.hidden=provider!=='codex';}};
}
