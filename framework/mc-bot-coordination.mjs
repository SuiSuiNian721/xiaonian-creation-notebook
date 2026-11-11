import { isIP } from 'node:net';
import { WorkbenchError } from './contracts.mjs';

const conflict=()=>new WorkbenchError(409,'这个 Minecraft 世界中的 Bot 身份已被另一个实例使用，请更换玩家名或先断开该实例。');
const key=value=>String(value||'').trim().toLowerCase();
function serverKey(settings){
  let host=key(settings.serverHost||'127.0.0.1').replace(/\.$/,'');
  if(host.startsWith('[')&&host.endsWith(']'))host=host.slice(1,-1);
  const zone=host.indexOf('%'),scope=zone<0?'':host.slice(zone),address=zone<0?host:host.slice(0,zone);
  if(isIP(address)===6){
    host=new URL('http://['+address+']/').hostname.slice(1,-1);
    const mapped=/^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(host);
    if(mapped)host=mapped.slice(1).flatMap(part=>{const value=Number.parseInt(part,16);return [value>>>8,value&255];}).join('.');
    host+=scope;
  }
  return JSON.stringify([['localhost','127.0.0.1','::1'].includes(host)?'loopback':host,Number(settings.serverPort||25565)]);
}

/** Claims are synchronous and belong to one runtime session, including its shutdown interval. */
export class MinecraftBotCoordination {
  constructor(){this.claims=new Map();}
  assertAvailable(candidate,exclude){
    for(const claim of this.claims.values()){
      if(claim!==exclude && claim.server===candidate.server && [...candidate.keys].some(identity=>claim.keys.has(identity)))throw conflict();
    }
  }
  claim(id,settings,sessionId){
    if(this.claims.has(id))throw conflict();
    const offline=settings.authMode!=='microsoft';
    const claim={id,sessionId,server:serverKey(settings),keys:new Set([(offline?'name:':'login:')+key(settings.playerName)]),name:offline?settings.playerName:'',listeners:new Set()};
    this.assertAvailable(claim);this.claims.set(id,claim);this.notify(claim.server);
    const active=()=>this.claims.get(id)===claim && this.claims.get(id).sessionId===sessionId;
    return {
      updateIdentity:({playerName,uuid}={})=>{
        if(!active())throw new WorkbenchError(409,'Minecraft 身份确认已过期。');
        const name=typeof playerName==='string'&&/^[A-Za-z0-9_]{1,16}$/.test(playerName)?playerName:claim.name;
        const uuidKey=key(uuid).replaceAll('-','');
        const keys=new Set(claim.keys);if(name)keys.add('name:'+key(name));if(/^[a-f0-9]{32}$/.test(uuidKey))keys.add('uuid:'+uuidKey);
        // Exclude this exact lease while checking the additional aliases atomically.
        this.assertAvailable({...claim,keys},claim);
        claim.keys=keys;claim.name=name;this.notify(claim.server);
      },
      subscribe:listener=>{
        if(!active())throw new WorkbenchError(409,'Minecraft 同伴订阅已过期。');
        claim.listeners.add(listener);listener(this.peers(claim));
        return ()=>claim.listeners.delete(listener);
      },
      release:()=>{
        if(!active())return;
        this.claims.delete(id);claim.listeners.clear();this.notify(claim.server);
      },
    };
  }
  peers(claim){return [...this.claims.values()].filter(other=>other!==claim&&other.server===claim.server&&other.name).map(other=>other.name).sort();}
  notify(server){
    for(const claim of this.claims.values()){
      if(claim.server!==server)continue;
      const names=this.peers(claim),signature=JSON.stringify(names);if(signature===claim.peerSignature)continue;claim.peerSignature=signature;
      // One ending worker must not prevent peers from receiving the new roster.
      for(const listener of claim.listeners){try{listener([...names]);}catch{}}
    }
  }
}
