import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { runCodexAppServer } from '../integrations/xiaoxi/tools/codex-app-server.mjs';
import { runQQTextCodex } from './qq-codex-text.mjs';

const cancelled=()=>new Error('AI 请求已取消。');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// config/read 不创建线程，也不启动配置中的 MCP。仅保留服务名称，配置正文不进入日志。
function readMcpNames({cli,cwd,env,spawnProcess,signal,configTimeoutMs}){
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(cli,['app-server','--listen','stdio://'],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const decoder=new StringDecoder('utf8');let buffer='',bytes=0,names,expected=1,failure,settled=false,closeTimer;
    const timer=setTimeout(()=>stop(new Error('读取 Codex 配置超时，请稍后重试。')),configTimeoutMs);
    function finish(error){
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(closeTimer);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(names);
    }
    function stop(error){
      if(failure||settled)return;failure=error;
      child.kill();
      closeTimer=setTimeout(()=>finish(new Error('读取 Codex 配置失败，尚未确认预检进程已退出。')),3000);
    }
    const abort=()=>stop(cancelled());
    function send(message){child.stdin.write(JSON.stringify(message)+'\n');}
    function line(value){
      if(!value.trim()||failure)return;
      let message;try{message=JSON.parse(value);}catch{throw new Error('Codex 配置接口返回了无效 JSON。');}
      if(!object(message))throw new Error('Codex 配置接口返回格式无效。');
      if(message.id!==expected)return;
      if(message.error)throw new Error('无法读取 Codex 配置，请检查本机 CLI 与配置。');
      if(expected===1){
        expected=2;send({method:'initialized',params:{}});send({id:2,method:'config/read',params:{includeLayers:false}});return;
      }
      const config=message.result?.config,servers=config?.mcp_servers??{};
      if(!object(config)||!object(servers))throw new Error('Codex 配置中的 MCP 列表格式无效。');
      names=Object.keys(servers);
      if(names.length>256||names.some(name=>!name||name.length>512||/[\u0000-\u001f\u007f]/.test(name)))throw new Error('Codex 配置中的 MCP 名称无效或数量过多。');
      expected=0;child.stdin.end();
    }
    child.stdout.on('data',chunk=>{
      if(failure||settled)return;
      try{
        bytes+=chunk.length;if(bytes>2*1024*1024)throw new Error('Codex 配置回复超过 2 MiB。');
        buffer+=decoder.write(chunk);let index;
        while((index=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,index);buffer=buffer.slice(index+1);line(value);}
      }catch(error){stop(error);}
    });
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>stop(new Error('Codex 配置接口连接已关闭。')));
    child.on('error',error=>stop(new Error(error.code==='ENOENT'?'找不到 Codex CLI，无法读取配置。':'无法启动 Codex 配置预检。')));
    child.once('close',code=>finish(failure||(code!==0||names===undefined?new Error('Codex 配置预检未正常完成。'):null)));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    else send({id:1,method:'initialize',params:{clientInfo:{name:'ai_future_config_probe',version:'0.7.2'}}});
  });
}

// 只隔离工作台自身的文本/视觉推理进程；外部客户端连接的绘图 MCP 仍由工作台提供。
export async function runWorkbenchCodex({signal,policy,configTimeoutMs=10000,...options}){
  if(signal?.aborted)throw cancelled();
  if(policy==='chat-only'&&options.images?.length)throw new Error('QQ 纯文本策略只接受文字对话。');
  if(policy==='chat-only'||policy==='chat-only-vision')return runQQTextCodex({...options,signal});
  if(policy!==undefined)throw new Error('不支持的 AI 执行策略。');
  const started=performance.now(),spawnProcess=options.spawnProcess||spawn;
  const names=await readMcpNames({cli:options.cli||'codex',cwd:options.cwd,env:options.env||process.env,spawnProcess,signal,configTimeoutMs:Math.min(configTimeoutMs,options.timeoutMs??configTimeoutMs)});
  if(signal?.aborted)throw cancelled();
  // CLI 的 dotted 配置路径按点拆分，不识别路径引号；在 TOML 内联表中引用完整服务名。
  const overrides=names.length?['-c','mcp_servers={'+names.map(name=>`${JSON.stringify(name)}={enabled=false}`).join(',')+'}']:[];
  let child;const abort=()=>child?.kill();signal?.addEventListener('abort',abort,{once:true});
  try{
    return await runCodexAppServer({...options,
      ...(options.timeoutMs?{timeoutMs:Math.max(1,options.timeoutMs-(performance.now()-started))}:{}),
      spawnProcess:(cli,args,settings)=>spawnProcess(cli,[...overrides,...args],settings),
      onSpawn:(process,stop)=>{child=process;if(signal?.aborted)abort();options.onSpawn?.(process,stop);},
    });
  }finally{signal?.removeEventListener('abort',abort);}
}
