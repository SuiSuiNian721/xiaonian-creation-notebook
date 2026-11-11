import { escape as e, help, downloadJson } from './components.js';

export async function mountDrawingMcp(root,ctx) {
  const {signal}=ctx;const find=selector => root.querySelector(selector);
  root.innerHTML='<p class="form-feedback" role="status">正在读取 MCP 接入…</p>';
  try {
    const [config,definitions]=await Promise.all([ctx.api('/api/ai/config'),ctx.api('/api/modules/drawing/mcp/tools')]);
    if (signal.aborted) return;
    let savedMcp=config.mcpEnabled;
    root.innerHTML=`<div class="panel-heading"><h2>绘图实例 MCP</h2>${help('此配置连接当前绘图实例。统一访问所有模块，请在全局设置导出工作台 MCP 配置。','绘图 MCP 说明')}</div>
      ${ctx.instanceId?'<div class="drawing-actions"><a class="button small" href="#/settings">管理工作台 MCP</a></div>':`<form id="drawing-mcp-form"><div class="drawing-mcp-toggle"><label class="check-label"><input type="checkbox" id="drawing-mcp-enabled" ${config.mcpEnabled?'checked':''}>启用工作台 MCP</label><button type="submit" class="button small" id="drawing-mcp-save">保存</button></div></form>`}
      <div class="drawing-actions"><button class="button small" type="button" id="mcp-export">导出客户端配置</button><button class="button small" type="button" id="mcp-copy">复制 HTTP 配置</button></div>
      <p id="mcp-feedback" class="form-feedback" role="status">${config.mcpEnabled?'MCP 已启用':'MCP 未启用'}</p>
      <details class="drawing-mcp-tools"><summary>可用工具 · ${definitions.tools.length}</summary><ul>${definitions.tools.map(tool => `<li><code>${e(tool.name)}</code><p>${e(tool.description)}</p></li>`).join('')}</ul></details>`;
    const feedback=(message,error=false) => { if (!signal.aborted) { const node=find('#mcp-feedback');node.textContent=message;node.className='form-feedback'+(error?' error':''); } };
    const run=(button,job) => ctx.action(button,async () => { try { await job(); } catch(error) { feedback(error.message,true); } });
    find('#drawing-mcp-form')?.addEventListener('submit',event => {
      event.preventDefault();const enabled=find('#drawing-mcp-enabled').checked;
      void run(find('#drawing-mcp-save'),async () => {
        const previous=savedMcp;const result=await ctx.api('/api/ai/config',{method:'PUT',body:{mcpEnabled:enabled}});
        const draft=ctx.drafts.read('ai:connection',null);
        if (draft && draft.mcpEnabled===previous) ctx.drafts.write('ai:connection',{...draft,mcpEnabled:result.mcpEnabled});
        savedMcp=result.mcpEnabled;feedback(savedMcp?'MCP 已启用':'MCP 已停用');
      });
    },{signal});
    find('#mcp-export').onclick=event => run(event.currentTarget,async () => {
      const result=await ctx.api('/api/ai/mcp');if (signal.aborted) return;
      downloadJson({mcpServers:{'ai-future-comfyui':result.stdio}},'小念的创作笔记-ComfyUI-MCP');feedback(result.enabled?'客户端配置已导出。':'配置已导出，请先启用 MCP 并保存。');
    });
    find('#mcp-copy').onclick=event => run(event.currentTarget,async () => {
      const result=await ctx.api('/api/ai/mcp');if (signal.aborted) return;
      await navigator.clipboard.writeText(JSON.stringify({mcpServers:{'ai-future-comfyui':result.http}},null,2));feedback('HTTP 配置已复制。');
    });
  } catch(error) { if (!signal.aborted) root.innerHTML=`<p class="form-feedback error" role="status">${e(error.message)}</p>`; }
}
