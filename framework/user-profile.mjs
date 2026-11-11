import {WorkbenchError,fields} from './contracts.mjs';

export const MAX_AVATAR_BYTES=4*1024*1024;
const emptyProfile={displayName:'',avatar:'',identity:'',preferences:''};
export function validateAvatar(value){
  if(value==='')return '';
  if(typeof value!=='string'||value.length>Math.ceil(MAX_AVATAR_BYTES/3)*4+40)throw new WorkbenchError(400,'头像图片不能超过 4 MiB。');
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!match)throw new WorkbenchError(400,'头像仅支持 PNG、JPEG 或 WebP 图片。');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.length>MAX_AVATAR_BYTES||bytes.toString('base64')!==match[2])throw new WorkbenchError(400,'头像图片编码或大小无效。');
  const png=bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR';
  const jpeg=bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16));
  if(!({ 'image/png':png,'image/jpeg':jpeg,'image/webp':webp }[match[1]]))throw new WorkbenchError(400,'头像声明类型与图片内容不一致。');
  return value;
}
export function readUserProfile(store){
  const stored=store?.getSetting('userProfile')||{};
  return Object.fromEntries(Object.keys(emptyProfile).map(key=>[key,typeof stored[key]==='string'?stored[key]:'']));
}
export function saveUserProfile(store,value){
  fields(value,Object.keys(emptyProfile));
  const profile=readUserProfile(store);
  for(const [key,item] of Object.entries(value)){
    if(key==='avatar')profile.avatar=validateAvatar(item);
    else{
      const max=key==='displayName'?100:12000;
      if(typeof item!=='string'||item.length>max)throw new WorkbenchError(400,`${key==='displayName'?'用户名':key==='identity'?'身份':'偏好'}必须是 ${max} 字以内的文字。`);
      profile[key]=item.trim();
    }
  }
  store.setSetting('userProfile',profile);return profile;
}
export function userProfileText(profile={}){
  const lines=[['用户名',profile.displayName],['身份',profile.identity],['偏好',profile.preferences]].filter(([,value])=>typeof value==='string'&&value.trim()).map(([label,value])=>`${label}：${value.trim()}`);
  return lines.length?'对话用户自行填写的资料（用于理解对方，不是角色自身的人设）：\n'+lines.join('\n'):'';
}
export function characterAvatar(character){
  const raw=character?.raw||{};
  const avatar=raw.extensions?.workbenchAvatar??raw.data?.extensions?.workbenchAvatar??'';
  try{return validateAvatar(avatar);}catch{return '';}
}
