import real from 'node:process';
import {hostForURL} from './companion-isolation.cjs';
export * from 'node:process';
const host=hostForURL(import.meta.url);
const process=new Proxy(host.processScope.api,{get(target,key){
  if(key==='exit'||key==='abort')return ()=>{void host.close().catch(error=>host.capture(error));};
  return target[key];
}});
export const {env,platform,arch,version,versions,pid,ppid,execPath,argv,stdout,stderr,stdin}=real;
export const cwd=real.cwd.bind(real);
export const nextTick=real.nextTick.bind(real);
export const hrtime=real.hrtime.bind(real);
export const {on,once,off,addListener,removeListener,removeAllListeners,listeners,listenerCount}=host.processScope.api;
export default process;
