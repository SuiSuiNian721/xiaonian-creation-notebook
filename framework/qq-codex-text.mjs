import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// 这条入口只供外部 QQ 文字使用；创作区的 app-server 能力保持独立。
const disabledFeatures=['shell_tool','shell_snapshot','unified_exec','code_mode','code_mode_host','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','computer_use','apps','plugins','hooks','view_image','image_generation','memories','multi_agent','multi_agent_v2','skill_search','skill_mcp_dependency_install','standalone_web_search','workspace_dependencies','auth_elicitation','tool_suggest'];
export async function runQQTextCodex({cli='codex',cwd,prompt,model='',reasoningEffort='',images=[],signal,timeoutMs=180000,spawnProcess=spawn,onSpawn,outputSchema}) {
  if(signal?.aborted)throw new Error('QQ 文本请求已取消。');
  let schemaPath;
  const args=['exec','--ephemeral','--json','--sandbox','read-only','--ignore-user-config','--ignore-rules','--skip-git-repo-check',
    '-c','approval_policy="never"','-c','mcp_servers={}','-c','web_search="disabled"','-c','agents.enabled=false','-c','project_doc_max_bytes=0','-c','suppress_unstable_features_warning=true','--enable','skip_host_skill_discovery'];
  for(const feature of disabledFeatures)args.push('--disable',feature);
  if(model)args.push('--model',model);
  if(reasoningEffort)args.push('-c','model_reasoning_effort='+JSON.stringify(reasoningEffort));
  if(!Array.isArray(images)||images.length>4||images.some(image=>typeof image?.path!=='string'||!['image/png','image/jpeg','image/webp'].includes(image.mime)))throw new Error('QQ 视觉输入格式无效。');
  for(const image of images)args.push('--image',image.path);
  if(outputSchema){schemaPath=join(cwd,'reply-schema-'+randomUUID()+'.json');await writeFile(schemaPath,JSON.stringify(outputSchema),{encoding:'utf8',mode:0o600,flag:'wx'});args.push('--output-schema',schemaPath);}
  args.push('-');
  try{return await new Promise((done,reject)=>{
    const child=spawnProcess(cli,args,{cwd,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let buffer='',bytes=0,text='',usage=null,failure,completed=false,killTimer;
    const decoder=new StringDecoder('utf8');
    const finish=(error)=>{if(completed)return;completed=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):done({text,usage});};
    const stop=error=>{if(failure||completed)return;failure=error;child.kill();killTimer=setTimeout(()=>finish(new Error('QQ 文本进程尚未确认退出，已停止接受本轮回复。')),5000);};
    const abort=()=>stop(new Error('QQ 文本请求已取消。'));
    const timer=setTimeout(()=>stop(new Error('QQ 文本生成超时。')),timeoutMs);
    function line(value){
      if(!value.trim()||failure)return;
      let event;try{event=JSON.parse(value);}catch{stop(new Error('QQ 文本接口返回了无效事件。'));return;}
      if(!event||typeof event!=='object'||Array.isArray(event)){stop(new Error('QQ 文本事件格式无效。'));return;}
      const item=event.item;
      if(item?.type==='error'&&/Code Mode is unavailable because code-mode host is disabled.*fail closed/i.test(item.message||''))return;
      if((item?.type&&!['agent_message','reasoning','context_compaction','error'].includes(item.type))||/tool|command|file_change|web_search|browser|mcp|image_view/i.test(event.type||'')){
        stop(new Error('QQ 纯文本策略拒绝了工具事件，本轮回复未发送。'));return;
      }
      if(event.type==='turn.failed'||event.type==='error'||item?.type==='error'){stop(new Error('QQ 文本生成失败，请检查模型连接。'));return;}
      if(event.type==='item.completed'&&item?.type==='agent_message'&&typeof item.text==='string')text=item.text;
      if(event.type==='turn.completed')usage=event.usage||null;
    }
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>4*1024*1024){stop(new Error('QQ 文本事件超过大小限制。'));return;}
      buffer+=decoder.write(chunk);let index;while((index=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,index);buffer=buffer.slice(index+1);line(value);}
    });
    child.stderr?.on('data',()=>{});
    child.stdin.on('error',()=>stop(new Error('QQ 文本输入连接已关闭。')));
    child.once('error',()=>finish(new Error('无法启动 QQ 文本模型，请检查 Codex CLI。')));
    child.once('close',code=>{
      if(buffer.trim())line(buffer);finish(failure||(code!==0||!text.trim()?new Error('QQ 文本模型没有返回完整回复。'):null));
    });
    signal?.addEventListener('abort',abort,{once:true});onSpawn?.(child);
    if(signal?.aborted)abort();else child.stdin.end(prompt);
  });}finally{if(schemaPath)await unlink(schemaPath).catch(()=>{});}
}
