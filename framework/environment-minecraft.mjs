import { createSocket } from 'node:dgram';
import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

const unicastIPv4 = address => isIPv4(address) && Number(address.split('.')[0]) > 0 && Number(address.split('.')[0]) < 224;

export function parseMinecraftAnnouncement(bytes, source, interfaces = networkInterfaces()) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1400 || !unicastIPv4(source?.address)) return null;
  const message = bytes.toString('utf8');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(message)) return null;
  const match = /^\[MOTD\]([\s\S]{0,512})\[\/MOTD\]\[AD\](\d{1,5})\[\/AD\]\r?\n?$/.exec(message);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  const own = Object.values(interfaces).flat().some(entry => entry?.address === source.address);
  const host = own ? '127.0.0.1' : source.address;
  const port = String(Number(match[2]));
  return { id:createHash('sha256').update(`${host}:${port}`).digest('hex').slice(0,24), kind:'minecraft-lan',
    label:match[1].replace(/§[0-9a-z]/gi,'').replace(/[\r\n\t]/g,' ').trim().slice(0,128) || 'Minecraft 局域网世界',
    path:`${host}:${port}`, values:{serverHost:host,serverPort:port}, selectable:true };
}

// Only receive Java Edition LAN advertisements; never probe ports or join a world.
export function discoverMinecraftWorlds({ signal, durationMs = 3200, interfaces = networkInterfaces(), createSocketImpl = createSocket } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const candidates = new Map(); let socket, timer, finished = false;
    const finish = (error, warning) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const done = () => error ? reject(error) : resolve({candidates:[...candidates.values()],partial:false,warnings:warning ? [warning] : []});
      try { if (socket) socket.close(done); else done(); } catch { done(); }
    };
    const cancel = () => finish(signal.reason || new Error('MC 世界发现已取消。'));
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      socket = createSocketImpl({type:'udp4',reuseAddr:true});
      socket.on('error',() => finish(null,'无法监听 Minecraft 局域网公告，请开放世界后重新扫描，或填写地址与端口。'));
      socket.on('message',(bytes,source) => {
        if (finished || candidates.size >= 40) return;
        const candidate = parseMinecraftAnnouncement(bytes,source,interfaces);
        if (candidate) candidates.set(candidate.id,candidate);
      });
      timer = setTimeout(() => finish(),Math.max(1,Math.min(5000,durationMs)));
      socket.bind(4445,'0.0.0.0',() => {
        if (finished) return;
        let joined = 0;
        const addresses = [...new Set(Object.values(interfaces).flat().filter(entry => entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal).map(entry => entry.address))];
        for (const address of addresses.length ? addresses : [undefined]) {
          try { socket.addMembership('224.0.2.60',address); joined++; } catch { /* Another usable interface may still receive announcements. */ }
        }
        if (!joined) finish(null,'当前网卡不能接收 Minecraft 局域网公告，可填写地址与端口后连接。');
      });
    } catch { finish(null,'无法监听 Minecraft 局域网公告，可填写地址与端口后连接。'); }
  });
}
