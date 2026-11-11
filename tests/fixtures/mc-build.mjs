import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const integration=resolve(dirname(fileURLToPath(import.meta.url)),'../../integrations/airi-minecraft');
process.chdir(process.argv[2]);
const require=createRequire(join(integration,'worker.mjs'));
const {register}=await import(pathToFileURL(require.resolve('tsx/esm/api')));register();
const {Vec3}=require('vec3');
const {actionsList}=await import(pathToFileURL(join(integration,'upstream/src/cognitive/action/llm-actions.ts')));
const action=actionsList.find(a=>a.name==='placeBlockAt');
assert.ok(action,'缺少 placeBlockAt 坐标建造工具');
assert.equal(action.followControl,'detach');
assert.equal(action.schema.safeParse({type:'oak_planks',x:3.5,y:65,z:3}).success,false);
assert.equal(action.schema.safeParse({type:'oak_planks',x:3,y:Infinity,z:3}).success,false);
function fixture({target='air',item='oak_planks',change=true,obstruct=false,lateObstruct=false,sneaking=false,placementError=false,missingSupport=false}={}){
  let placed=0,reads=0,sneak=sneaking;
  const destination=new Vec3(3,65,3),support={name:'stone',position:new Vec3(3,64,3)};
  const bot={registry:require('minecraft-data')('1.20.1'),game:{gameMode:'survival'},entity:{position:new Vec3(0,65,0)},
    inventory:{items:()=>[{name:item,count:4}]},
    blockAt(pos){assert.ok(pos instanceof Vec3);if(pos.equals(destination)){reads++;return {name:obstruct&&reads>1?'stone':lateObstruct&&reads>2?'short_grass':target,position:destination};}return pos.equals(support.position)&&!(missingSupport&&reads>2)?support:{name:'air',position:pos};},
    getControlState:()=>sneak,setControlState(key,value){assert.equal(key,'sneak');sneak=value;},
    async equip(actual){assert.equal(actual.name,'oak_planks');},async lookAt(){},
    async placeBlock(reference,face){assert.equal(sneak,true,'精确建造应潜行放置，避免打开支撑方块的界面');if(placementError)throw new Error('server rejected placement');assert.equal(reference,support);assert.ok(reference.position instanceof Vec3);assert.ok(face instanceof Vec3);assert.deepEqual(reference.position.plus(face),destination);placed++;if(change)target='oak_planks';},
    async dig(){throw new Error('不得自动破坏方块');},
  };
  return {bot,perform:action.perform({bot}),placed:()=>placed};
}
let f=fixture();assert.match(await f.perform('oak_planks',3,65,3),/3, 65, 3/);assert.equal(f.placed(),1);assert.equal(f.bot.getControlState('sneak'),false);
f=fixture({target:'stone'});await assert.rejects(f.perform('oak_planks',3,65,3),/occupied|in the way/i);assert.equal(f.placed(),0);
f=fixture({obstruct:true});await assert.rejects(f.perform('oak_planks',3,65,3),/occupied|in the way/i);assert.equal(f.placed(),0);
f=fixture({lateObstruct:true});await assert.rejects(f.perform('oak_planks',3,65,3),/occupied|in the way/i);assert.equal(f.placed(),0);assert.equal(f.bot.getControlState('sneak'),false);
f=fixture({sneaking:true});await f.perform('oak_planks',3,65,3);assert.equal(f.bot.getControlState('sneak'),true);
f=fixture({placementError:true});await assert.rejects(f.perform('oak_planks',3,65,3),/server rejected/);assert.equal(f.bot.getControlState('sneak'),false);
f=fixture({missingSupport:true});await assert.rejects(f.perform('oak_planks',3,65,3),/support disappeared/i);assert.equal(f.placed(),0);
f=fixture({target:'oak_planks',item:'air'});assert.match(await f.perform('oak_planks',3,65,3),/already/i);assert.equal(f.placed(),0);
f=fixture({item:'dark_oak_planks'});await assert.rejects(f.perform('oak_planks',3,65,3),/Don't have/i);assert.equal(f.placed(),0);
f=fixture({change:false});await assert.rejects(f.perform('oak_planks',3,65,3),/verify|expected|confirm/i);
f=fixture();await assert.rejects(f.perform('not_a_block',3,65,3),/block type/i);assert.equal(f.placed(),0);
console.log('MC_BUILD_RESULT: native objects, exact item, occupancy, idempotency, coordinates and postcondition passed');
