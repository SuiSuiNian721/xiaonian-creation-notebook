process.stdin.resume();
process.stdin.on('end',()=>{
  const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
  send({type:'thread.started',thread_id:'fixture-qq'});
  if(process.env.QQ_FIXTURE_TOOL)send({type:'item.started',item:{id:'tool',type:'command_execution',command:'forbidden'}});
  send({type:'item.completed',item:{id:'answer',type:'agent_message',text:'QQ_TEXT_OK'}});
  send({type:'turn.completed',usage:{input_tokens:10,output_tokens:3}});
});
