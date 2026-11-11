import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { createWorkbench } from '../framework/server.mjs';

const directory=resolve(process.argv[2] || 'qa/mc-play-protocol');
const requireRuntime=createRequire(resolve('integrations/airi-minecraft/package.json'));
const protocol=requireRuntime('minecraft-protocol');
const minecraftData=requireRuntime('minecraft-data');
const worldData=minecraftData('1.20.1');
const chat=[];const ai=[];const errors=[];
const game=protocol.createServer({'online-mode':false,host:'127.0.0.1',port:0,version:'1.20.1',keepAlive:true});
game.on('error',error=>errors.push(error.message));
game.on('playerJoin',client=>{
  client.on('error',error=>errors.push(error.message));
  client.on('chat_message',packet=>chat.push(packet.message));
  client.write('login',{...worldData.loginPacket,entityId:1,gameMode:1,worldType:'minecraft:overworld',worldName:'minecraft:overworld',isFlat:true});
  client.write('position',{x:0,y:65,z:0,yaw:0,pitch:0,flags:0,teleportId:1});
  client.write('update_health',{health:20,food:20,foodSaturation:5});
});
await new Promise(resolveReady=>game.once('listening',resolveReady));
const model=createHttpServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  ai.push(JSON.parse(body));
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'await chat({ message: "隔离协议测试：已收到指令。" });'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
});
await new Promise(resolveReady=>model.listen(0,'127.0.0.1',resolveReady));
await mkdir(directory,{recursive:true});
const workbench=await createWorkbench({dataDir:join(directory,'data')});
async function api(path,method='GET',body){const response=await fetch(workbench.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(`${response.status}: ${JSON.stringify(value)}`);return value;}
async function wait(label,predicate,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await new Promise(resolveWait=>setTimeout(resolveWait,150));}throw new Error('等待超时：'+label);}
let outcome;
try {
  await api('/api/modules/mc-play/enable','POST',{});
  await api('/api/ai/config','PUT',{provider:'openai',enabled:true,baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'protocol-fixture'});
  await api('/api/modules/mc-play/connection','PUT',{serverHost:'127.0.0.1',serverPort:String(game.socketServer.address().port),playerName:'ProtocolBot',ownerName:'TestPlayer',authMode:'offline',gameVersion:'1.20.1'});
  await api('/api/modules/mc-play/connect','POST',{});
  await wait('真正 Mineflayer 协议连接与 AIRI 认知启动',async()=>{const state=await api('/api/modules/mc-play/state');if(state.connection.status==='error')throw new Error(state.connection.error);return state.connection.status==='connected';});
  const connected=await api('/api/modules/mc-play/state');
  assert.equal(connected.connection.gameVersion,'1.20.1');
  assert.equal(connected.connection.playerName,'ProtocolBot');
  await api('/api/modules/mc-play/command','POST',{kind:'instruction',text:'请在游戏聊天中确认已收到这条测试指令。'});
  await wait('AI 规划执行 chat 工具并发送游戏协议包',()=>chat.some(value=>value.includes('已收到指令')));
  await api('/api/modules/mc-play/command','POST',{kind:'pause'});
  await wait('暂停得到运行端实际确认',async()=>(await api('/api/modules/mc-play/state')).connection.paused);
  await api('/api/modules/mc-play/disconnect','POST',{});
  assert.equal((await api('/api/modules/mc-play/state')).connection.status,'disconnected');
  outcome={ok:true,source:'AIRI 0.15.1',gameProtocol:'1.20.1',checks:['真实 Mineflayer 登录并接收位置与生命数据','AIRI 感知与认知栈启动','通过共用模型接口接收受控规划回复','隔离执行器运行 AIRI chat 工具并产生 Minecraft 聊天数据包','暂停确认','断开关闭运行端'],modelCalls:ai.length,chat,errors,realUserWorld:false,modelIsFixture:true};
  console.log(JSON.stringify(outcome,null,2));
}catch(error){outcome={ok:false,error:error.stack,state:await api('/api/modules/mc-play/state').catch(()=>null),chat,modelCalls:ai.length,errors};console.error(JSON.stringify(outcome,null,2));process.exitCode=1;}
finally{await writeFile(join(directory,'result.json'),JSON.stringify(outcome,null,2),'utf8');await workbench.close();await new Promise(resolveClose=>model.close(resolveClose));game.close();}
