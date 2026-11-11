import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire,registerHooks} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
let isolation={};
try{isolation=require('../desktop/companion-isolation.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}

test('相同原生 IPC 频道按 sender 分派，关闭 A 不移除 B 或工作台监听',async()=>{
  assert.equal(typeof isolation.createIpcScope,'function','需要原生 IPC 隔离作用域');
  const ipc=new EventEmitter(),handlers=new Map();
  ipc.handle=(name,callback)=>{assert.equal(handlers.has(name),false);handlers.set(name,callback);};
  ipc.removeHandler=name=>handlers.delete(name);
  const a={},b={},other={},seen=[];
  ipc.on('message',()=>seen.push('root'));
  const sa=isolation.createIpcScope(ipc,sender=>sender===a),sb=isolation.createIpcScope(ipc,sender=>sender===b);
  sa.api.on('message',()=>seen.push('a'));sb.api.on('message',()=>seen.push('b'));
  let once=0;sa.api.once('once',()=>once++);
  ipc.emit('once',{sender:b});ipc.emit('once',{sender:a});ipc.emit('once',{sender:a});assert.equal(once,1);
  sa.api.handle('invoke',()=> 'a');sb.api.handle('invoke',()=> 'b');
  assert.equal(await handlers.get('invoke')({sender:a}),'a');assert.equal(await handlers.get('invoke')({sender:b}),'b');
  assert.throws(()=>handlers.get('invoke')({sender:other}),/来源/);
  ipc.emit('message',{sender:a});ipc.emit('message',{sender:b});assert.deepEqual(seen,['root','a','root','b']);
  sa.dispose();seen.length=0;ipc.emit('message',{sender:a});ipc.emit('message',{sender:b});
  assert.deepEqual(seen,['root','root','b']);assert.equal(await handlers.get('invoke')({sender:b}),'b');
  sb.dispose();assert.equal(handlers.size,0);assert.equal(ipc.listenerCount('message'),1);
});

test('进程与系统事件只清理当前宿主的监听',()=>{
  assert.equal(typeof isolation.createEventScope,'function','需要可清理的事件作用域');
  const target=new EventEmitter(),foreign=()=>{};target.on('SIGINT',foreign);
  const a=isolation.createEventScope(target),b=isolation.createEventScope(target);let hit=0;
  a.api.on('SIGINT',()=>{throw new Error('A 已关闭');});b.api.on('SIGINT',()=>hit++);
  a.dispose();target.emit('SIGINT');assert.equal(hit,1);assert.ok(target.listeners('SIGINT').includes(foreign));
  b.dispose();assert.deepEqual(target.listeners('SIGINT'),[foreign]);
});

test('共享快捷键只路由可见宿主，关闭 A 后 B 仍可接收',()=>{
  assert.equal(typeof isolation.createShortcutScope,'function','需要快捷键路由');
  const registrations=new Map(),native={register(key,fn){if(registrations.has(key))return false;registrations.set(key,fn);return true;},unregister:key=>registrations.delete(key)};
  let visible='a';const seen=[];
  const a=isolation.createShortcutScope(native,()=>visible==='a'),b=isolation.createShortcutScope(native,()=>visible==='b');
  assert.equal(a.api.register('Ctrl+K',()=>seen.push('a')),true);assert.equal(b.api.register('Ctrl+K',()=>seen.push('b')),true);
  registrations.get('Ctrl+K')();visible='b';registrations.get('Ctrl+K')();a.dispose();registrations.get('Ctrl+K')();
  visible=null;registrations.get('Ctrl+K')();assert.deepEqual(seen,['a','b','b']);b.dispose();assert.equal(registrations.size,0);
});

test('同一安装的 ESM 依赖图独立，停止后同 ID 重开得到新模块状态',async()=>{
  assert.equal(typeof isolation.createModuleHooks,'function','需要逐宿主隔离模块图');
  const directory=await mkdtemp(join(tmpdir(),'companion-import-test-'));
  const archiveURL=pathToFileURL(directory).href+'/',mainURL=archiveURL+'main.mjs',hooks=[];
  try{
    await writeFile(join(directory,'main.mjs'),'export {state} from "./state.mjs";');
    await writeFile(join(directory,'state.mjs'),'export const state={count:0};');
    const load=id=>{const scope=isolation.createModuleHooks({hostId:id,archiveURL,mainURL,shimURL:archiveURL+'electron.mjs',processURL:archiveURL+'process.mjs'});const hook=registerHooks(scope.hooks);hooks.push(hook);return import(scope.mainURL);};
    const [a,b]=await Promise.all([load('a-first'),load('b-first')]);a.state.count=7;
    assert.equal(b.state.count,0);hooks[0].deregister();
    const reopened=await load('a-second');assert.equal(reopened.state.count,0);assert.notEqual(reopened.state,a.state);assert.equal(b.state.count,0);
  }finally{for(const hook of hooks)hook.deregister();await rm(directory,{recursive:true,force:true});}
});
