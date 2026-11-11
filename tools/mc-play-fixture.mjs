import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

export async function minecraftFixture(integrationRoot) {
  const requireRuntime=createRequire(resolve(integrationRoot,'package.json'));
  const protocol=requireRuntime('minecraft-protocol');
  const data=requireRuntime('minecraft-data')('1.20.1');
  const chats=[];const calls=[];const errors=[];const disconnects=[];
  let ending=false;
  const game=protocol.createServer({'online-mode':false,host:'127.0.0.1',port:0,version:'1.20.1',keepAlive:true});
  game.on('error',error=>errors.push(error.message));
  game.on('playerJoin',client=>{
    client.on('error',error=>{if(ending)disconnects.push(error.message);else errors.push(error.message);});
    client.on('chat_message',packet=>chats.push(packet.message));
    client.write('login',{...data.loginPacket,entityId:1,gameMode:1,worldType:'minecraft:overworld',worldName:'minecraft:overworld',isFlat:true});
    client.write('position',{x:0,y:65,z:0,yaw:0,pitch:0,flags:0,teleportId:1});
    client.write('update_health',{health:20,food:20,foodSaturation:5});
  });
  await new Promise(resolveReady=>game.once('listening',resolveReady));
  const model=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    calls.push(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'await chat({ message: "隔离协议测试：已收到指令。" });'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  await new Promise(resolveReady=>model.listen(0,'127.0.0.1',resolveReady));
  return {gamePort:game.socketServer.address().port,modelUrl:`http://127.0.0.1:${model.address().port}/v1`,chats,calls,errors,disconnects,
    ending(){ending=true;},async close(){ending=true;await new Promise(resolveClose=>model.close(resolveClose));game.close();}};
}
