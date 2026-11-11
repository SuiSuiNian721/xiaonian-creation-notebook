const HOSTS=Symbol.for('ai-future.companion.hosts');
const QUERY='workbench-host';
const ipcRouters=new WeakMap();
const shortcutRouters=new WeakMap();
const bind=(target,key)=>typeof target[key]==='function'?target[key].bind(target):target[key];

function registerHost(host){(globalThis[HOSTS]??=new Map()).set(host.hostId,host);}
function releaseHost(host){globalThis[HOSTS]?.delete(host.hostId);}
function hostForURL(url){
  const host=globalThis[HOSTS]?.get(new URL(url).searchParams.get(QUERY));
  if(!host)throw new Error('陪伴宿主不存在或已关闭。');
  return host;
}
function scopedURL(url,hostId){const value=new URL(url);value.searchParams.set(QUERY,hostId);return value.href;}

// Every ESM dependency receives the same host key: injeca and logg both keep module state.
// CommonJS utility/native packages retain Node's loader; they do not own a runtime container.
function createModuleHooks({hostId,archiveURL,mainURL,shimURL,processURL,loadMain}){
  const entry=scopedURL(mainURL,hostId);
  const owns=url=>!!url&&url.startsWith(archiveURL)&&new URL(url).searchParams.get(QUERY)===hostId;
  return {mainURL:entry,hooks:{
    resolve(specifier,context,next){
      if(!owns(context.parentURL))return next(specifier,context);
      if(specifier==='electron')return {url:scopedURL(shimURL,hostId),shortCircuit:true};
      if(specifier==='node:process'||specifier==='process')return {url:scopedURL(processURL,hostId),shortCircuit:true};
      const result=next(specifier,context);
      if(result.url.startsWith(archiveURL)&&result.format==='module')return {...result,url:scopedURL(result.url,hostId)};
      return result;
    },
    load(url,context,next){
      if(url===entry&&loadMain)return {format:'module',source:loadMain(),shortCircuit:true};
      return next(url,context);
    },
  }};
}

function createEventScope(target,accept=()=>true){
  const registrations=[];
  let disposed=false,api;
  const remove=entry=>{target.removeListener(entry.name,entry.wrapped);const index=registrations.indexOf(entry);if(index>=0)registrations.splice(index,1);};
  const methods={
    removeListener(name,listener){const entry=registrations.findLast(item=>item.name===name&&item.listener===listener);if(entry)remove(entry);return api;},
    removeAllListeners(name){for(const entry of [...registrations])if(name===undefined||entry.name===name)remove(entry);return api;},
    listeners(name){return registrations.filter(item=>item.name===name).map(item=>item.listener);},
    listenerCount(name){return registrations.filter(item=>item.name===name).length;},
  };
  methods.off=methods.removeListener;
  for(const method of ['on','addListener','once','prependListener','prependOnceListener'])methods[method]=(name,listener)=>{
    if(disposed)return api;
    const entry={name,listener,wrapped:(...args)=>{
      if(disposed||!accept(...args))return;
      if(method==='once'||method==='prependOnceListener')remove(entry);
      return listener.apply(api,args);
    }};
    registrations.push(entry);target[method.startsWith('prepend')?'prependListener':'on'](name,entry.wrapped);return api;
  };
  api=new Proxy(target,{get:(value,key)=>Object.hasOwn(methods,key)?methods[key]:bind(value,key)});
  return {api,dispose(){disposed=true;methods.removeAllListeners();}};
}

function createIpcScope(target,owns){
  const events=createEventScope(target,event=>owns(event?.sender));
  const router=ipcRouters.get(target)??new Map();ipcRouters.set(target,router);
  const handlers=new Map();let disposed=false;
  const removeHandler=name=>{
    const registration=handlers.get(name);if(!registration)return;
    const channel=router.get(name);channel?.delete(registration);handlers.delete(name);
    if(channel?.size===0){target.removeHandler(name);router.delete(name);}
  };
  const handle=(name,callback,once=false)=>{
    if(disposed)throw new Error('陪伴 IPC 已关闭。');
    if(handlers.has(name))throw new Error('陪伴 IPC 频道已注册：'+name);
    let channel=router.get(name);
    if(!channel){
      channel=new Set();
      target.handle(name,(event,...args)=>{
        const entry=[...channel].find(item=>item.owns(event?.sender));
        if(!entry)throw new Error('陪伴 IPC 来源不属于活动实例。');
        if(entry.once)entry.remove();
        return entry.callback(event,...args);
      });
      router.set(name,channel);
    }
    const registration={owns,callback,once,remove:()=>removeHandler(name)};
    channel.add(registration);handlers.set(name,registration);
  };
  const methods={handle:(name,callback)=>handle(name,callback),handleOnce:(name,callback)=>handle(name,callback,true),removeHandler};
  return {api:new Proxy(events.api,{get:(value,key)=>Object.hasOwn(methods,key)?methods[key]:value[key]}),dispose(){disposed=true;events.dispose();for(const name of [...handlers.keys()])removeHandler(name);}};
}

function createShortcutScope(target,isEligible){
  const router=shortcutRouters.get(target)??new Map();shortcutRouters.set(target,router);
  const registrations=new Map();let disposed=false;
  const unregister=key=>{
    const entry=registrations.get(key);if(!entry)return;
    const channel=router.get(key);channel?.delete(entry);registrations.delete(key);
    if(channel?.size===0){target.unregister(key);router.delete(key);}
  };
  const api={
    register(key,callback){
      if(disposed||registrations.has(key))return false;
      let channel=router.get(key);
      if(!channel){channel=new Set();if(!target.register(key,()=>{const entry=[...channel].find(item=>item.isEligible());entry?.callback();}))return false;router.set(key,channel);}
      const entry={isEligible,callback};channel.add(entry);registrations.set(key,entry);return true;
    },
    registerAll(keys,callback){for(const key of keys)api.register(key,callback);},
    unregister,
    unregisterAll(){for(const key of [...registrations.keys()])unregister(key);},
    isRegistered:key=>registrations.has(key),
  };
  return {api,dispose(){disposed=true;api.unregisterAll();}};
}

module.exports={registerHost,releaseHost,hostForURL,scopedURL,createModuleHooks,createEventScope,createIpcScope,createShortcutScope};
