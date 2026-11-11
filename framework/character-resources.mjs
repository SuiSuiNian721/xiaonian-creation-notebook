import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { open, unlink,stat } from 'node:fs/promises';
import { extname,isAbsolute,join, relative, resolve } from 'node:path';
import { WorkbenchError, characterBundle, fields, identifier, importedCharacter, knownModule, object, text } from './contracts.mjs';
import {parseCharacterFile} from './character-runtime/card.mjs';
import {readableLocalPath} from './resource-local-path.mjs';

export const MAX_CHARACTER_RESOURCE_BYTES = 32 * 1024 * 1024;
const kinds = ['card','image', 'audio', 'skin', 'workflow', 'model', 'file'];
const safeMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'application/json', 'application/octet-stream']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => relative(left, right) === '';
const unsafeStorage = () => new WorkbenchError(409, '角色资源目录或文件发生变化，请检查本机资料目录后重试。');

function assertDirectory(directory) {
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, realpathSync(directory))) throw unsafeStorage();
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw unsafeStorage();
  }
}

function internalPath(directory, id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw unsafeStorage();
  const path = resolve(directory, `${id}.bin`);
  if (relative(directory, path) !== `${id}.bin`) throw unsafeStorage();
  return path;
}

function assertFile(directory, path, expected) {
  assertDirectory(directory);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CHARACTER_RESOURCE_BYTES || !samePath(path, realpathSync(path))) throw unsafeStorage();
  if (expected && (info.dev !== expected.dev || info.ino !== expected.ino)) throw unsafeStorage();
  return info;
}

function imageMime(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 54 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

function resourceMime(kind, bytes) {
  if(kind==='card'){
    if(bytes.length>16*1024*1024)throw new WorkbenchError(413,'角色卡文件不能超过 16 MiB。');
    try{
      const raw=parseCharacterFile({base64:bytes.toString('base64')});
      const card=raw?.data??raw;
      const fieldsPresent=['description','personality','scenario','first_mes','mes_example'].some(key=>typeof card?.[key]==='string');
      const declared=['chara_card_v2','chara_card_v3'].includes(raw?.spec)&&raw?.data===card;
      if(!card||typeof card.name!=='string'||!card.name.trim()||Array.isArray(raw.nodes)||Array.isArray(raw.entries)||!declared&&!fieldsPresent)throw new Error('missing character');
      return bytes.subarray(0,8).equals(pngSignature)?'image/png':'application/json';
    }catch{throw new WorkbenchError(400,'请选择包含角色信息的 SillyTavern PNG 或 JSON 角色卡。');}
  }
  if (kind === 'image' || kind === 'skin') {
    const mime = imageMime(bytes);
    if (!mime) throw new WorkbenchError(400, '图片内容无效，仅支持 PNG、JPEG、WebP、GIF 或 BMP。');
    if (kind === 'skin' && (mime !== 'image/png' || bytes.readUInt32BE(16) !== 64 || ![64, 32].includes(bytes.readUInt32BE(20)))) throw new WorkbenchError(400, '角色皮肤必须是 64×64 或 64×32 的 PNG 图片。');
    return mime;
  }
  if (kind === 'workflow') {
    try { object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), '工作流'); }
    catch { throw new WorkbenchError(400, '工作流必须是有效的 UTF-8 JSON 对象。'); }
    return 'application/json';
  }
  if (kind === 'audio') {
    if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
    if (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 8 && (bytes[1] & 6) !== 0 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 12) !== 12) return 'audio/mpeg';
    if (bytes.length >= 27 && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
    if (bytes.length >= 8 && bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  }
  // 用户提供的扩展名和 MIME 不能把 HTML、SVG 或未知二进制变成活动预览。
  return 'application/octet-stream';
}

function upload(input) {
  fields(input, ['name', 'kind', 'mime', 'base64', 'sourceModuleId', 'sourceInstanceId'], '角色资源');
  const name = text(input.name, '资源名称', 240);
  if (/[/\\:\u0000-\u001f\u007f]/.test(name) || ['.', '..'].includes(name)) throw new WorkbenchError(400, '资源名称不能包含路径或控制字符。');
  if (!kinds.includes(input.kind)) throw new WorkbenchError(400, '不支持这个角色资源类型。');
  if (input.mime !== undefined) text(input.mime, '资源 MIME', 120, { empty: true });
  const sourceModuleId = input.sourceModuleId == null ? null : knownModule(input.sourceModuleId).id;
  const sourceInstanceId = input.sourceInstanceId == null ? null : identifier(input.sourceInstanceId, '来源实例标识');
  if (typeof input.base64 !== 'string' || !input.base64) throw new WorkbenchError(400, '资源必须包含有效的 Base64 文件内容。');
  if (input.base64.length > Math.ceil(MAX_CHARACTER_RESOURCE_BYTES / 3) * 4) throw new WorkbenchError(413, '角色资源不能超过 32 MiB。');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new WorkbenchError(400, '资源 Base64 编码无效。');
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.length > MAX_CHARACTER_RESOURCE_BYTES) throw new WorkbenchError(413, '角色资源不能超过 32 MiB。');
  if (!bytes.length || bytes.toString('base64') !== input.base64) throw new WorkbenchError(400, '资源 Base64 编码无效。');
  return { name, kind: input.kind, mime: resourceMime(input.kind, bytes), bytes, sourceModuleId, sourceInstanceId };
}

function publicRecord(row) {
  return {
    id: row.id, characterId: row.character_id, name: row.name, kind: row.kind,
    mime: safeMimes.has(row.mime) ? row.mime : 'application/octet-stream', bytes: row.bytes, createdAt: row.created_at,
    ...(row.source_module_id ? { sourceModuleId: row.source_module_id } : {}),
    ...(row.source_instance_id ? { sourceInstanceId: row.source_instance_id } : {}),
    url: `/api/characters/${encodeURIComponent(row.character_id)}/resources/${encodeURIComponent(row.id)}/file`,
  };
}

export class CharacterResources {
  constructor({ store, dataDir }) {
    this.store = store;
    this.directory = join(realpathSync(dataDir), 'character-resources');
    try { mkdirSync(this.directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertDirectory(this.directory);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS character_resources (
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= ${MAX_CHARACTER_RESOURCE_BYTES}),
        created_at TEXT NOT NULL, source_module_id TEXT REFERENCES modules(id), source_instance_id TEXT,
        sha256 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS character_resources_character ON character_resources(character_id);
      CREATE TABLE IF NOT EXISTS shared_model_locations (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, bytes INTEGER NOT NULL, identity TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS character_resource_references (
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), name TEXT NOT NULL,
        kind TEXT NOT NULL, location_id TEXT REFERENCES shared_model_locations(id), metadata TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }

  list(characterId) {
    this.store.requireCharacter(characterId);
    return [...this.store.db.prepare('SELECT * FROM character_resources WHERE character_id = ? ORDER BY rowid').all(characterId).map(publicRecord),
      ...this.store.db.prepare('SELECT r.*,l.path,l.bytes FROM character_resource_references r LEFT JOIN shared_model_locations l ON l.id=r.location_id WHERE character_id=? ORDER BY r.rowid').all(characterId).map(row=>this.referenceRecord(row))];
  }
  referenceRecord(row){return {id:row.id,characterId:row.character_id,name:row.name,kind:row.kind,mime:'application/octet-stream',bytes:row.bytes??0,createdAt:row.created_at,
    reference:{...JSON.parse(row.metadata),...(row.location_id?{locationId:row.location_id,path:row.path}:{})},
    ...(row.location_id?{url:`/api/characters/${encodeURIComponent(row.character_id)}/resources/${encodeURIComponent(row.id)}/file`}:{})};}
  async addReference(characterId,input){
    this.store.requireCharacter(characterId);fields(input,['name','kind','path','baseFamily','voiceId','sourceModuleId','sourceInstanceId']);
    const name=text(input.name,'资源名称',240);if(!['lora','audio'].includes(input.kind))throw new WorkbenchError(400,'仅支持关联角色 LoRA 或已保存的角色语音。');
    let location=null,metadata;
    if(input.kind==='lora'){
      const requested=text(input.path,'LoRA 文件路径',4096);
      if(!isAbsolute(requested)||/^[\\/]{2}/.test(requested)||!['.safetensors','.pt','.ckpt','.bin'].includes(extname(requested).toLowerCase()))throw new WorkbenchError(400,'请选择本地 LoRA 权重文件的绝对路径。');
      let path,info;try{path=await readableLocalPath(requested);info=await stat(path);}catch{throw new WorkbenchError(400,'找不到本地 LoRA 文件，请检查路径。');}
      if(!info.isFile()||info.size===0)throw new WorkbenchError(400,'LoRA 路径须为非空权重文件。');
      if(/^[\\/]{2}/.test(path))throw new WorkbenchError(400,'请选择本地磁盘的 LoRA 文件。');
      const identity=JSON.stringify({dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs});
      location={id:digest(Buffer.from((process.platform==='win32'?path.toLowerCase():path)+'\0'+identity)),path,bytes:info.size,identity};
      metadata={baseFamily:input.baseFamily===undefined||input.baseFamily===''?'unknown':text(input.baseFamily,'底模家族',120),verification:'unverified'};
    }else{
      metadata={voiceId:identifier(input.voiceId,'声音标识')};
    }
    const id=randomUUID(),createdAt=new Date().toISOString(),asset={id,characterId,name,kind:input.kind,moduleId:input.sourceModuleId==null?null:knownModule(input.sourceModuleId).id,ref:'character-resources/'+id};
    const character=this.store.requireCharacter(characterId);
    importedCharacter({document:characterBundle({...character,revision:character.revision+1,assets:[...character.assets,asset]})});
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      if(location)db.prepare('INSERT OR IGNORE INTO shared_model_locations VALUES(?,?,?,?)').run(location.id,location.path,location.bytes,location.identity);
      db.prepare('INSERT INTO character_resource_references VALUES(?,?,?,?,?,?,?)').run(id,characterId,name,input.kind,location?.id??null,JSON.stringify(metadata),createdAt);
      db.prepare('INSERT INTO assets(id,kind,name,module_id,character_id,ref) VALUES(?,?,?,?,?,?)').run(id,asset.kind,name,asset.moduleId,characterId,asset.ref);
      db.prepare('UPDATE characters SET revision=revision+1,updated_at=? WHERE id=?').run(createdAt,characterId);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return this.list(characterId).find(item=>item.id===id);
  }

  async add(characterId, input) {
    this.store.requireCharacter(characterId);
    const value = upload(input), id = randomUUID(), createdAt = new Date().toISOString();
    const asset = { id, characterId, name: value.name, kind: value.kind, moduleId: value.sourceModuleId, ref: `character-resources/${id}` };
    const validateIndex = () => {
      const character = this.store.requireCharacter(characterId);
      // 采用现有导入合同，素材数量、原卡大小和整个 2 MiB 信封预算保持一致。
      importedCharacter({ document: characterBundle({ ...character, revision: character.revision + 1, assets: [...character.assets, asset] }) });
    };
    validateIndex(); assertDirectory(this.directory);
    const path = internalPath(this.directory, id);
    let createdInfo;
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW), 0o600);
      try {
        createdInfo = await handle.stat();
        assertFile(this.directory, path, createdInfo);
        await handle.writeFile(value.bytes); await handle.sync();
        const info = assertFile(this.directory, path, createdInfo);
        if (info.size !== value.bytes.length) throw unsafeStorage();
      } finally { await handle.close(); }
      const db = this.store.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        validateIndex(); assertFile(this.directory, path, createdInfo);
        db.prepare('INSERT INTO character_resources(id, character_id, name, kind, mime, bytes, created_at, source_module_id, source_instance_id, sha256) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, characterId, value.name, value.kind, value.mime, value.bytes.length, createdAt, value.sourceModuleId, value.sourceInstanceId, digest(value.bytes));
        db.prepare('INSERT INTO assets(id, kind, name, module_id, character_id, ref) VALUES(?, ?, ?, ?, ?, ?)')
          .run(id, value.kind, value.name, value.sourceModuleId, characterId, asset.ref);
        db.prepare('UPDATE characters SET revision = revision + 1, updated_at = ? WHERE id = ?').run(createdAt, characterId);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      if (createdInfo) {
        // 只清理本次创建、仍在资料目录内且身份未改变的文件，不递归删除目录。
        try { assertFile(this.directory, path, createdInfo); await unlink(path); } catch {}
      }
      throw error;
    }
    return publicRecord(this.store.db.prepare('SELECT * FROM character_resources WHERE id = ?').get(id));
  }

  async migrateLegacy(){
    for(const row of this.store.db.prepare("SELECT * FROM character_resources WHERE kind IN ('file','workflow','model')").all()){
      if(!/\.(json|png)$/i.test(row.name))continue;
      const marker='character.resources.classified.'+row.id;if(this.store.getSetting(marker))continue;
      let file;try{file=await this.file(row.character_id,row.id);}catch{continue;}
      try{resourceMime('card',file.bytes);}catch{this.store.setSetting(marker,true);continue;}
      const db=this.store.db;db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare("UPDATE character_resources SET kind='card' WHERE id=?").run(row.id);
        db.prepare("UPDATE assets SET kind='card' WHERE id=?").run(row.id);
        db.prepare('UPDATE characters SET revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(),row.character_id);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
  }

  async file(characterId, resourceId) {
    this.store.requireCharacter(characterId); identifier(resourceId, '资源标识');
    const row = this.store.db.prepare('SELECT * FROM character_resources WHERE id = ? AND character_id = ?').get(resourceId, characterId);
    if (!row) {
      const reference=this.store.db.prepare('SELECT r.*,l.path,l.bytes,l.identity FROM character_resource_references r JOIN shared_model_locations l ON l.id=r.location_id WHERE r.id=? AND r.character_id=?').get(resourceId,characterId);
      if(!reference)throw new WorkbenchError(404,'找不到这个角色资源。');
      try{const info=await stat(reference.path);if(JSON.stringify({dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs})!==reference.identity)throw new Error('changed');}
      catch{throw new WorkbenchError(409,'关联的 LoRA 文件不存在或发生变化，请重新确认。');}
      return {path:reference.path,bytesLength:reference.bytes,mime:'application/octet-stream',name:reference.name+extname(reference.path)};
    }
    const path = internalPath(this.directory, row.id);
    try {
      const before = assertFile(this.directory, path);
      if (before.size !== row.bytes) throw unsafeStorage();
      const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      let bytes;
      try {
        const info = await handle.stat();
        assertFile(this.directory, path, info);
        if (info.dev !== before.dev || info.ino !== before.ino || info.size !== row.bytes) throw unsafeStorage();
        bytes = await handle.readFile();
        assertFile(this.directory, path, info);
      } finally { await handle.close(); }
      if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw unsafeStorage();
      return { bytes, mime: publicRecord(row).mime, name: row.name };
    } catch (error) {
      if (error.code === 'ENOENT') throw new WorkbenchError(404, '角色资源文件不存在，请重新上传。');
      if (error.code === 'ELOOP') throw unsafeStorage();
      throw error;
    }
  }
}
