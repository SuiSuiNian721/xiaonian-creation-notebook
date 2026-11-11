import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const integration=resolve(dirname(fileURLToPath(import.meta.url)),'../../integrations/airi-minecraft');
process.chdir(process.argv[2]);
const require=createRequire(join(integration,'worker.mjs'));
const {register}=await import(pathToFileURL(require.resolve('tsx/esm/api')));register();
const {ReflexManager}=await import(pathToFileURL(join(integration,'upstream/src/cognitive/reflex/reflex-manager.ts')));
const {TaskExecutor}=await import(pathToFileURL(join(integration,'upstream/src/cognitive/action/task-executor.ts')));
const {Brain}=await import(pathToFileURL(join(integration,'upstream/src/cognitive/conscious/brain.ts')));
const logger={log(){},error(){},debug(){},warn(){},withFields(){return this;},withError(){return this;}};
const eventBus={subscribe(){return()=>{};}};
const taskExecutor=new TaskExecutor({logger});await taskExecutor.initialize();
const reflex=new ReflexManager({logger,taskExecutor,eventBus}),calls=[];
const bot={registry:require('minecraft-data')('1.21.1'),players:{Owner:{entity:{position:{x:1,y:64,z:1}}}},pathfinder:{setMovements(){},setGoal(){calls.push('setGoal');},stop(){calls.push('stop');}}};
const mineflayer={bot,reflexManager:reflex,interrupt(){bot.pathfinder.stop();}};
taskExecutor.setMineflayer(mineflayer);reflex.init(mineflayer);
const brain=new Brain({logger,taskExecutor,eventBus,reflexManager:reflex,minecraftContextService:{bindBot(){},unbindBot(){}}});brain.init(mineflayer);
try{
  await taskExecutor.executeActionWithResult({tool:'followPlayer',params:{player_name:'Owner',follow_dist:2}});
  assert.equal(reflex.getContextSnapshot().autonomy.followActive,true);calls.length=0;
  await brain.stopForWorkbench();
  assert.equal(brain.isPaused(),true);
  assert.equal(reflex.getContextSnapshot().autonomy.followActive,false);
  assert.equal(reflex.getContextSnapshot().autonomy.followPlayer,null);
  assert.equal(calls.includes('setGoal'),false);
  reflex.refreshFromBotState();brain.setPaused(false);reflex.refreshFromBotState();
  assert.equal(reflex.getContextSnapshot().autonomy.followActive,false,'恢复 AI 不能自行恢复已停止的跟随');
  assert.equal(calls.includes('setGoal'),false);
  console.log('MC_STOP_ENTRY_RESULT '+JSON.stringify({pausedStopsFollow:true,resumeDoesNotRestoreFollow:true,calls,scope:'real Brain.stopForWorkbench, TaskExecutor and ReflexManager; simulated bot, no network or AI'}));
}finally{brain.destroy();reflex.destroy();await taskExecutor.destroy();}
