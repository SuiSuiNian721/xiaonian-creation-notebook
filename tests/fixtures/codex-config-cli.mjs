import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const mode=process.env.CODEX_FIXTURE_MODE||'normal';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const lines=createInterface({input:process.stdin});
const log=message=>appendFileSync(process.env.CODEX_FIXTURE_LOG,JSON.stringify(message)+'\n','utf8');
log({pid:process.pid,args:process.argv.slice(2)});
lines.on('line',line=>{
  const message=JSON.parse(line);log(message);
  if(message.method==='initialize')send({id:message.id,result:{}});
  if(message.method==='config/read'){
    if(mode==='timeout')return;
    if(mode==='malformed')return process.stdout.write('not JSON\n');
    if(mode==='oversized')return process.stdout.write('x'.repeat(2*1024*1024+1));
    if(mode==='rpc-error')return send({id:message.id,error:{message:'fixture-secret-token'}});
    if(mode==='invalid-config')return send({id:message.id,result:{config:{mcp_servers:[]}}});
    send({id:message.id,result:{config:{mcp_servers:JSON.parse(process.env.CODEX_FIXTURE_SERVERS||'{}')}}});
  }
  if(message.method==='account/read')send({id:message.id,result:{account:{type:'chatgpt'}}});
  if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'test-thread',ephemeral:true,path:null}}});
  if(message.method==='experimentalFeature/list')send({id:message.id,result:{data:[{name:'multi_agent',enabled:false},{name:'multi_agent_v2',enabled:false}]}});
  if(message.method==='turn/start'){
    send({id:message.id,result:{turn:{id:'test-turn'}}});
    if(mode==='turn-stall')return;
    if(mode==='slow-active'||mode==='empty-active'){
      let index=0;
      const timer=setInterval(()=>{
        index++;
        send({method:'item/reasoning/summaryTextDelta',params:{threadId:'test-thread',turnId:'test-turn',itemId:'reason',delta:mode==='slow-active'?'思考'+index:''}});
        send({method:'item/agentMessage/delta',params:{threadId:'test-thread',turnId:'test-turn',itemId:'answer',delta:''}});
        if(mode==='slow-active'&&index===7){clearInterval(timer);send({method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'OK'}]}}});}
      },50);
      return;
    }
    send({method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'OK'}]}}});
  }
});
lines.on('close',()=>process.exit(0));
