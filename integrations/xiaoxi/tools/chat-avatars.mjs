import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isCustomPersonaId, listPersonas, personaById } from './personas.mjs';
import { readUserProfile } from './user-profile.mjs';

export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
const AVATARS = Object.freeze({ user: '你', neutral: '助', xiaoxi: '汐', momo: '茉' });
const FORMATS = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' });

function avatarError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function checkedId(id, root, allowDeleted = false) {
  if (typeof id !== 'string' || (!Object.hasOwn(AVATARS, id) && !isCustomPersonaId(id))) throw avatarError('未知聊天头像');
  if (isCustomPersonaId(id)) {
    try { personaById(id, root); }
    catch (error) { if (allowDeleted && error.statusCode === 404) return null; throw error; }
  }
  return id;
}

// 每次读写都检查完整路径链，工作区、work 或头像文件不能通过链接指向别处。
function checkedPath(root, ...parts) {
  if (typeof root !== 'string' || !root.trim()) throw avatarError('聊天头像工作区路径无效');
  const absolute = path.resolve(root);
  const target = path.join(absolute, ...parts);
  const relative = path.relative(absolute, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw avatarError('聊天头像路径超出工作区');
  }
  const base = path.parse(target).root;
  let current = base;
  const segments = target.slice(base.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw avatarError('聊天头像路径不允许符号链接');
    if (i < segments.length - 1 && !stat.isDirectory()) throw avatarError('聊天头像路径包含非目录项目');
    if (i === segments.length - 1 && !stat.isDirectory() && !stat.isFile()) {
      throw avatarError('聊天头像路径必须是普通文件或目录');
    }
  }
  return target;
}

function avatarFiles(root, id) {
  checkedId(id, root);
  return Object.keys(FORMATS).map((extension) => ({
    file: checkedPath(root, 'work', 'chat-avatars', id + '.' + extension),
    extension,
  }));
}

function imageFormat(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16))) return 'webp';
  throw avatarError('头像仅支持 PNG、JPEG 或 WEBP 图片，不支持 SVG');
}

function readImage(file, expectedExtension) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw avatarError('聊天头像必须是普通图片文件');
  if (stat.size > MAX_AVATAR_BYTES) throw avatarError('头像图片不能超过 4 MiB');
  const data = fs.readFileSync(file);
  const extension = imageFormat(data);
  if (extension !== expectedExtension) throw avatarError('头像文件扩展名与实际图片类型不一致');
  return { data, mimeType: FORMATS[extension] };
}

export function readChatAvatar(root, id) {
  if (!checkedId(id, root, true)) return null;
  if (id === 'user') {
    const profile = readUserProfile(root);
    if (profile.managed) {
      if (!profile.avatar) return null;
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(profile.avatar);
      if (!match) throw avatarError('工作台用户头像格式无效');
      const data = Buffer.from(match[2], 'base64');
      if (data.length > MAX_AVATAR_BYTES || FORMATS[imageFormat(data)] !== match[1]) throw avatarError('工作台用户头像格式或大小无效');
      return { data, mimeType: match[1] };
    }
  }
  const files = avatarFiles(root, id);
  for (const { file, extension } of files) {
    const image = readImage(file, extension);
    if (image) return image;
  }
  if (id === 'momo') return readImage(checkedPath(root, 'assets', 'avatars', 'momo.png'), 'png');
  return null;
}

export function readChatAvatars(root) {
  const profile = readUserProfile(root);
  const labels = { ...AVATARS, ...Object.fromEntries(listPersonas(root, { includePrompts: false }).filter(persona => !persona.builtin)
    .map(persona => [persona.id, Array.from(persona.name)[0] || '助'])) };
  return Object.fromEntries(Object.entries(labels).map(([id, label]) => {
    const image = readChatAvatar(root, id);
    const version = image ? crypto.createHash('sha256').update(image.data).digest('hex').slice(0, 16) : '';
    return [id, { label: id === 'user' && profile.managed ? Array.from(profile.displayName)[0] || '你' : label,
      url: version ? '/api/chat-avatar/' + id + '?v=' + version : '', ...(id === 'user' && profile.managed ? { name: profile.displayName } : {}) }];
  }));
}

export function saveChatAvatar(root, id, body) {
  checkedId(id, root);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw avatarError('头像请求格式无效');
  const files = avatarFiles(root, id);
  // 修改前先核对所有固定目标，避免遇到异常路径时只完成了一半。
  for (const { file } of files) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw avatarError('聊天头像目标必须是普通文件');
  }
  if (Object.hasOwn(body, 'reset') && body.reset === true) {
    for (const { file } of files) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return readChatAvatars(root);
  }
  if (!Object.hasOwn(body, 'base64') || !Object.hasOwn(body, 'mimeType')
    || typeof body.base64 !== 'string' || typeof body.mimeType !== 'string') {
    throw avatarError('请选择本地头像图片');
  }
  if (body.base64.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) throw avatarError('头像图片不能超过 4 MiB', 413);
  if (!body.base64 || body.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64)) {
    throw avatarError('头像图片编码无效');
  }
  const data = Buffer.from(body.base64, 'base64');
  if (data.toString('base64') !== body.base64) throw avatarError('头像图片编码无效');
  if (data.length > MAX_AVATAR_BYTES) throw avatarError('头像图片不能超过 4 MiB', 413);
  const extension = imageFormat(data);
  if (body.mimeType !== FORMATS[extension]) throw avatarError('头像声明类型与实际图片类型不一致');
  const directory = checkedPath(root, 'work', 'chat-avatars');
  fs.mkdirSync(directory, { recursive: true });
  const target = checkedPath(root, 'work', 'chat-avatars', id + '.' + extension);
  const temp = checkedPath(root, 'work', 'chat-avatars', '.' + id + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' });
    fs.renameSync(temp, target);
    for (const { file } of files) {
      if (file === target) continue;
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return readChatAvatars(root);
}
