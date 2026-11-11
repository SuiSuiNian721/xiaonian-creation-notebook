import { createServer } from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkbenchStore } from './store.mjs';
import { ModuleInstances } from './module-instances.mjs';
import {CharacterResources,MAX_CHARACTER_RESOURCE_BYTES} from './character-resources.mjs';
import { PathPicker } from './path-picker.mjs';
import {displaySections} from '../public-workbench/training-form-fields.js';
import { Installations } from './installations.mjs';
import { CardStudio } from './card-studio.mjs';
import { ComfyDrawing } from './drawing.mjs';
import { serveDrawingResult } from './drawing-results.mjs';
import { validateRuntimeSettings } from './drawing-runtime.mjs';
import { DrawingManager } from './drawing-manager.mjs';
import {DrawingCompletion} from './drawing-completion.mjs';
import {handleDrawingCompletionHttp} from './drawing-completion-http.mjs';
import { DrawingStartup } from './drawing-startup.mjs';
import { SharedAI } from './shared-ai.mjs';
import { SharedVoice } from './voice.mjs';
import {VoiceStudio} from './voice-studio.mjs';
import {VoiceResources} from './voice-resources.mjs';
import {Companion} from './companion.mjs';
import {airiStream} from './companion-ai.mjs';
import { MinecraftCompanion } from './mc-play.mjs';
import {createWorkbenchRpc} from './workbench-mcp.mjs';
import {trainingHttp} from './training-http.mjs';
import { MinecraftSkin } from './mc-skin.mjs';
import { skinSkillRoot } from './mc-skin-runtime.mjs';
import { QQController } from './qq.mjs';
import { QQRuntime, QQ_PACKAGE } from './qq-runtime.mjs';
import { EnvironmentDiscovery } from './environment.mjs';
import { OptionalComponents } from './optional-components.mjs';
import { ResourceStorage } from './resource-storage.mjs';
import { CharacterLife } from './character-life/service.mjs';
import { CharacterPackages, characterPackageAdapter, exportCharacterPackage, validateCharacterPackage } from './character-packages.mjs';
import { LiteCompanion } from './companion-lite.mjs';
import {readUserProfile,saveUserProfile,userProfileText} from './user-profile.mjs';
import { createDrawingTool } from './character-life/drawing-tool.mjs';
import { parseCharacterFile } from './character-runtime/index.mjs';
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_BODY_BYTES, WorkbenchError, object, fields, identifier, knownModule, configValues, newCharacter, importedCharacter, publicEvent } from './contracts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function json(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function body(req, limit = MAX_BODY_BYTES, requireObject = true) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    req.resume();
    throw new WorkbenchError(415, '请使用 application/json 请求。');
  }
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw new WorkbenchError(413, `请求正文超过 ${limit / 1024 / 1024} MiB。`);
  }
  // 不使用 async iterator 提前退出，以免分块超限时自动销毁连接，丢失 JSON 错误响应。
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let finished = false;
    let chunks = [];
    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        finished = true; chunks = [];
        reject(new WorkbenchError(413, `请求正文超过 ${limit / 1024 / 1024} MiB。`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const parsed=JSON.parse(decoded);
        resolveBody(requireObject?object(parsed):parsed);
      } catch (error) { reject(error instanceof WorkbenchError ? error : new WorkbenchError(400, '请求正文不是有效的 UTF-8 JSON。')); }
    });
    req.on('error', () => { if (!finished) { finished = true; reject(new WorkbenchError(400, '读取请求失败。')); } });
    req.on('aborted', () => { if (!finished) { finished = true; reject(new WorkbenchError(400, '请求已中断。')); } });
  });
}

function within(directory, candidate) {
  const path = relative(directory, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function staticFile(req, res, pathname, staticDir) {
  const candidate = resolve(staticDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  let actual;
  try {
    const directory = await realpath(staticDir);
    actual = await realpath(candidate);
    if (!within(directory, actual) || !(await stat(actual)).isFile()) throw new Error('outside');
  } catch { throw new WorkbenchError(404, '找不到这个页面。'); }
  const mime = mimeTypes[extname(actual).toLowerCase()];
  if (!mime) throw new WorkbenchError(404, '不支持访问这个文件。');
  let bytes;
  try { bytes = await readFile(actual); } catch { throw new WorkbenchError(404, '找不到这个文件。'); }
  res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length, 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

function localPathForCheck(value) {
  // 先按文字拒绝共享和设备路径，不能先 stat / realpath 再判断。
  if (/^[\\/]{2}/.test(value)) return null;
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value) || value.slice(2).includes(':')) return null;
  } else if (!isAbsolute(value)) return null;
  return resolve(value);
}

async function entryWithoutLinks(path) {
  const root = parse(path).root;
  let current = root;
  let entry = await lstat(current);
  if (entry.isSymbolicLink()) return null;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    entry = await lstat(current);
    if (entry.isSymbolicLink()) return null;
  }
  // 末级也使用 lstat 的结果，避免检查完成后再用 stat 跟随链接。
  return entry;
}

async function checkPaths(store, definition) {
  const snapshot = store.module(definition.id);
  const entries = await Promise.all(definition.settings.map(async setting => {
    const value = snapshot.config[setting.key];
    let status;
    let message;
    if (!value) { status = 'empty'; message = setting.label+'尚未填写。'; }
    else if (setting.type === 'url') { status = 'unchecked'; message = setting.label+'格式有效；尚未验证连接。'; }
    else if (setting.type === 'text') { status = 'unchecked'; message = '已保存文字，无需路径检查。'; }
    else if (!localPathForCheck(value)) { status = 'unchecked'; message = setting.label+'未检查：仅支持普通本地磁盘的绝对路径；网络共享、设备路径和相对路径暂不检查。'; }
    else {
      try {
        const entry = await entryWithoutLinks(localPathForCheck(value));
        if (entry === null) { status = 'unchecked'; message = setting.label+'：链接路径暂不检查，请选择实际本地位置。'; }
        else {
          const matches = setting.pathKind === 'file' ? entry.isFile() : setting.pathKind === 'directory' ? entry.isDirectory() : entry.isFile() || entry.isDirectory();
          status = matches ? 'valid' : 'wrong-type';
          message = matches ? setting.label+'存在且类型正确。' : setting.label+(setting.pathKind === 'file' ? '需要选择文件。' : '需要选择目录。');
        }
      } catch (error) {
        status = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unchecked';
        message = status === 'missing' ? '找不到'+setting.label+'，请选择现有位置。' : '无法读取'+setting.label+'，请检查访问权限。';
      }
    }
    return [setting.key, { status, message, checkedAt: new Date().toISOString() }];
  }));
  return { checks: store.applyChecks(definition.id, snapshot.configRevision, Object.fromEntries(entries)) };
}

export async function createWorkbench({ dataDir = join(root, 'data-workbench'), port = 0, host = '127.0.0.1', staticDir = join(root, 'public-workbench'), resourceCatalog, installationAdapters, chooseDirectory, choosePath, openArtifactDirectory, drawingOptions = {}, drawingManagerOptions = {}, aiOptions = {}, skinOptions = {}, minecraftOptions = {}, startupOptions = {}, companionOptions = {}, qqOptions = {}, environmentOptions = {}, lifeOptions = {}, trainingOptions = {}, voiceOptions = {}, voiceStudioOptions = {}, visionOptions = {}, componentOptions = {}, openComfyUI, openMinecraftAuth, openProcessLog, instances = true, instanceOptionsFactory, publicBaseUrl, sharedResourceStore, sharedResourceDirectory, sharedResourceLocks, sharedCharacterResources, instanceCoordination, onUserProfileChanged } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new WorkbenchError(400, '工作台仅允许绑定本机回环地址。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new WorkbenchError(400, '本地服务端口无效。');
  const store = new WorkbenchStore(resolve(dataDir));
  const profileStore=sharedResourceStore??store;
  const components=componentOptions.controller??new OptionalComponents({dataDir:sharedResourceDirectory??resolve(dataDir),store:profileStore,...componentOptions});
  let resourceStorage;
  let ownedCharacterResources;
  const resources=()=>ownedCharacterResources??=new CharacterResources({store,dataDir:resolve(dataDir)});
  const characterResources=sharedCharacterResources??{list:(...args)=>resources().list(...args),add:(...args)=>resources().add(...args),file:(...args)=>resources().file(...args),addReference:(...args)=>resources().addReference(...args),migrateLegacy:()=>resources().migrateLegacy()};
  const userProfile=()=>readUserProfile(profileStore);
  const profileChanged=onUserProfileChanged??(async()=>{
    const companions=[companion,...[...(instanceManager?.runtimes.values()||[])].map(runtime=>runtime.context?.companion).filter(Boolean)];
    await Promise.allSettled(companions.map(item=>item.syncUserProfile?.()));
  });
  const sharedAI = new SharedAI({store,dataDir:resolve(dataDir),...aiOptions,globalStore:sharedResourceStore??store});await sharedAI.initialize();
  const voice=voiceOptions.controller??new SharedVoice({store,globalStore:profileStore,dataDir:resolve(dataDir),sharedDirectory:sharedResourceDirectory??resolve(dataDir),baseUrl:()=>appUrl,...voiceOptions});
  const ownsVoiceStudio=!voiceStudioOptions.shared;
  const voiceResources=voiceStudioOptions.controller?.resources??voiceStudioOptions.resources??new VoiceResources({store:profileStore,dataDir:sharedResourceDirectory??resolve(dataDir),...voiceStudioOptions.resourceOptions});
  const voiceStudio=voiceStudioOptions.controller??new VoiceStudio({dataDir:sharedResourceDirectory??resolve(dataDir),resources:voiceResources,coordination:voice.coordination,baseUrl:()=>appUrl,readAudio:(id,signature)=>voice.audio(id,signature),...voiceStudioOptions});
  await voiceStudio.initialized;voice.studio=voiceStudio;
  const voiceOwner=createHash('sha256').update(process.platform==='win32'?resolve(dataDir).toLowerCase():resolve(dataDir)).digest('hex');
  let visionExtension;
  const ownsVisionExtension=!visionOptions.shared;
  const life = new CharacterLife({store,dataDir:resolve(dataDir),sharedAI,sharedVoice:args=>voice.synthesize(args),...lifeOptions});
  const characterFrames = new Map();
  const companion = new Companion({store,dataDir:resolve(dataDir),sharedAI,life,userProfile,...companionOptions});
  let qqRuntime,qq;
  const ensureQQ=()=>{
    qqRuntime ||= qqOptions.runtime || new QQRuntime({dataDir:resolve(dataDir),storageDataDir:sharedResourceDirectory??resolve(dataDir),onEvent:event=>store.event({moduleId:'qq',...event}),...qqOptions.runtimeOptions,coordination:instanceCoordination});
    const sharedQQ=sharedResourceStore?.getSetting('module.resources.qq')?.installed?.['qq-napcat'];
    if(sharedQQ?.directory)qqRuntime.adoptSharedInstallation?.(join(sharedQQ.directory,'NapCat-'+QQ_PACKAGE.version));
    qq ||= new QQController({store,dataDir:resolve(dataDir),sharedAI,life,runtime:qqRuntime,onebotOptions:qqOptions.onebotOptions});
    return qq;
  };
  const installations = new Installations({ store, dataDir: resolve(dataDir), sharedStore:sharedResourceStore, sharedDirectory:sharedResourceDirectory, sharedLocks:sharedResourceLocks, resourceCatalog, installationAdapters:{
    'local-character-policy':characterPackageAdapter,
    'qq-napcat':{install:context=>ensureQQ().runtime.install(context),verify:()=>ensureQQ().runtime.verify()},...installationAdapters,
  }, chooseDirectory });
  const characterPackages=new CharacterPackages({store,installations,libraryEnabled:()=>profileStore.getSetting('character.library.initialized')===true});life.packages=characterPackages;companion.packages=characterPackages;
  const liteCompanion=new LiteCompanion({store,sharedAI,life,packages:characterPackages,userProfile,baseUrl:()=>appUrl});
  const environment = new EnvironmentDiscovery({store:profileStore,chooseDirectory,fingerprint:id=>JSON.stringify(store.module(id==='comfyui'?'drawing':id).config),explicitPaths:id=>id==='companion'?[store.module('companion').config.airiPath].filter(Boolean):[],hints:() => [
    ...['drawing','training','mc-skin','companion'].flatMap(id => Object.entries(store.module(id).config).filter(([key]) => /Path$/.test(key)).map(([,path]) => path)),
    qqRuntime?.state().installation.installDirectory,installations.directory('qq'),join(resolve(dataDir),'resources'),
  ].filter(Boolean),...environmentOptions});
  const cardStudio = new CardStudio({ dataDir:resolve(dataDir), publicPrefix:publicBaseUrl?new URL(publicBaseUrl).pathname+'/card-studio':'/card-studio', onOpenArtifacts:openArtifactDirectory, userProfile, sharedConfig:()=>sharedAI.managesModule('cards')?sharedAI.studioConfig(appUrl):null });
  const drawing = new ComfyDrawing({ store, dataDir:resolve(dataDir), ...drawingOptions, coordination:instanceCoordination });
  const signCharacterImage=id=>createHmac('sha256',sharedAI.token).update('character-image:'+id).digest('hex');
  const drawingTool=createDrawingTool({drawing,store,baseUrl:()=>appUrl});
  life.builtinTools.drawing=async(...args)=>{
    const result=await drawingTool(...args);
    const mediaUrl=url=>{const id=/\/api\/modules\/drawing\/images\/([A-Za-z0-9-]+)$/.exec(url)?.[1];return id?`${appUrl}/internal/character-media/${id}/${signCharacterImage(id)}`:url;};
    return {...result,url:mediaUrl(result.url),images:result.images.map(image=>({...image,url:mediaUrl(image.url)}))};
  };
  const drawingManager = new DrawingManager({ drawing, store, dataDir:resolve(dataDir), fetchImpl:drawingOptions.fetchImpl, ...drawingManagerOptions, coordination:instanceCoordination });
  const drawingCompletion=new DrawingCompletion({drawing,manager:drawingManager,store,dataDir:resolve(dataDir),fetchImpl:drawingOptions.fetchImpl});
  const drawingStartup = new DrawingStartup({drawing,openBrowser:openComfyUI,...startupOptions});
  const minecraft = new MinecraftCompanion({ store, dataDir:resolve(dataDir), sharedAI, componentProvider:components, ...minecraftOptions, coordination:instanceCoordination });
  const mcSkin = new MinecraftSkin({store,dataDir:resolve(dataDir),sharedAI,...skinOptions});
  let training,trainingPending;
  const ensureTraining=()=>trainingPending||=(async()=>{
    if(trainingOptions.service)return training=trainingOptions.service;
    const {LoraTraining}=await import('./training.mjs');
    const runtime=trainingOptions.getRuntime?await trainingOptions.getRuntime():trainingOptions.runtime;
    return training=new LoraTraining({store,dataDir:resolve(dataDir),componentProvider:components,...trainingOptions,runtime,sharedAI,chooseDirectory});
  })().catch(error=>{trainingPending=null;throw error;});
  const pending = new Set();
  let expectedHost;
  let appUrl;
  let closed;
  const pathPicker=new PathPicker({store,choosePath,chooseDirectory,trainingForm:async type=>{const service=await ensureTraining(),item=await service.type({model_train_type:type});return item.schema_name?(await service.schema(type)).form:{sections:displaySections(null,{model_train_type:type})};}});
  const instanceManager=instances?new ModuleInstances({dataDir:resolve(dataDir),store,baseUrl:()=>appUrl,optionsFactory:instanceOptionsFactory,
    beforeVariantChange:({runtime})=>{
      const context=runtime?.context;
      if(context&&(context.sharedAI.pending.size||context.life.pending.size||context.companion.pending||context.companion.requests.size||context.liteCompanion.active.size||context.installations.active.size))throw new WorkbenchError(409,'当前实例仍有生成、记忆处理或安装任务，请等待完成后再切换模式。');
    },
    beforeRemove:async({record,runtime})=>{
      if(record.moduleId!=='training')return;
      if(runtime)return (await runtime.context.ensureTraining()).prepareRemoval();
      // A stopped instance can still own work in the detached shared kernel.
      // Inspect its ledger without starting its UI or launching Python.
      const context=instanceManager.readContext(record.id);let service;
      try{
        const {LoraTraining}=await import('./training.mjs');
        service=new LoraTraining({store:context.store,dataDir:instanceManager.directory(record.id),runtime:(await ensureTraining()).runtime});
        const release=await service.prepareRemoval();
        return async()=>{release();await service.close();context.release();};
      }catch(error){try{await service?.close();}finally{context.release();}throw error;}
    },
    createRuntime:({dataDir:instanceDirectory,options,publicBaseUrl,coordination})=>createWorkbench({dataDir:instanceDirectory,staticDir,host,resourceCatalog,installationAdapters,chooseDirectory,choosePath,openArtifactDirectory,
      aiOptions,lifeOptions,voiceOptions,environmentOptions,drawingOptions:{installationDirectory:drawingOptions.installationDirectory,downloadsDirectory:drawingOptions.downloadsDirectory},openComfyUI,openMinecraftAuth,openProcessLog,componentOptions:{controller:components},trainingOptions:{getRuntime:async()=>(await ensureTraining()).runtime},
      ...options,voiceStudioOptions:{controller:voiceStudio,shared:true},visionOptions:{controller:visionExtension,shared:true},dataDir:instanceDirectory,port:0,host,instances:false,publicBaseUrl,instanceCoordination:coordination,sharedResourceStore:store,sharedResourceDirectory:resolve(dataDir),sharedResourceLocks:instanceManager.resourceLocks,sharedCharacterResources:characterResources,onUserProfileChanged:profileChanged})}):null;
  if(instanceManager){instanceManager.libraryLife=life;installations.sharedLocks=instanceManager.resourceLocks;}
  const stopLegacyScheduler=()=>{clearInterval(life.timer);life.timer=null;life.scheduler?.abort();};
  const legacyMigrated=()=>!!instanceManager?.db.prepare("SELECT value FROM metadata WHERE key='legacy-v1'").get();
  let legacyMutations=0;
  function prepareInstances(allowedLegacyMutations=0){
    if(!instanceManager)throw new WorkbenchError(409,'请通过工作台根入口准备模块实例。');
    if(!legacyMigrated()){
      if(legacyMutations>allowedLegacyMutations)throw new WorkbenchError(409,'旧页面仍有保存请求，请等待保存完成后重试迁移。');
      if(qq?.state().pending||qq?.state().transport.status==='verified'||qqRuntime?.child||qqRuntime?.starting||companion.status==='running'||companion.pending||cardStudio.upstreamUrl||minecraft.child||drawing.runtime.child||drawing.runtime.launchPromise||drawingManager.active||drawingManager.applying.size||drawing.jobs().some(job=>['submitting','queued','running','unknown'].includes(job.status))||mcSkin.active.size||life.pending.size||sharedAI.pending.size||installations.active.size)throw new WorkbenchError(409,'旧模块仍在运行，请先完成任务并停止连接后迁移。');
    }
    const result=instanceManager.migrate();
    const library=instanceManager.collectCharacterLibrary();
    stopLegacyScheduler();
    return {...result,library};
  }
  async function setModuleEnabled(id,enabled){
    knownModule(id);
    if(!enabled){
      if(id==='companion')companion.hide();
      if(id==='companion-lite')liteCompanion.cancel();
      if(id==='mc-play')await minecraft.disconnect();
      if(id==='qq'){ensureQQ();await qq.disconnect({stopRuntime:true});instanceCoordination?.releaseQQ();}
    }
    const changed=store.module(id).enabled!==enabled;
    store.setEnabled(id,enabled);
    if(changed&&['character-lite','character-full','companion-lite','companion'].includes(id))characterPackages.invalidate();
    if(enabled)await characterPackages.prepare(id);
  }
  const mcpContext={store,life,voice,voiceStudio,voiceResources,voiceOwner,get visionExtension(){return visionExtension;},companion,liteCompanion,sharedAI,characterResources,ensureQQ,getQQRuntime:()=>qqRuntime,ensureTraining,installations,drawing,drawingManager,drawingCompletion,drawingStartup,instanceManager,instanceCoordination,components,get resourceStorage(){return resourceStorage;},mcSkin,minecraft,cardStudio,baseUrl:()=>appUrl,isClosing:()=>!!closed,enableModule:id=>setModuleEnabled(id,true),prepareInstances:()=>prepareInstances(1)};
  const workbenchRpc=createWorkbenchRpc({store,instanceManager,context:mcpContext});

  async function showProcessLog(result, source = {}) {
    if (openProcessLog) {
      try {
        const identity=store.getSetting('instance.identity');
        await openProcessLog({...source,...(identity?{instanceId:identity.id}:{})});
      }
      catch { result.logWindowError = '操作已提交，但日志窗口未能打开，请通过“独立日志”重试。'; }
    }
    return result;
  }

  async function handle(req, res) {
    let requestPath;try{requestPath=decodeURIComponent(req.url.split('?')[0]);}catch{requestPath=req.url;}
    const legacyMutation=!!instanceManager&&(!['GET','HEAD','OPTIONS'].includes(req.method)||requestPath.startsWith('/card-studio'))&&!requestPath.startsWith('/instances/')&&!requestPath.startsWith('/api/instances');
    if(legacyMutation)legacyMutations++;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const nativeCompanion=/^(?:\/instances\/[a-f0-9-]+)?\/internal\/companion\/ai\/v1\/(?:models|chat\/completions)$/.test(req.url.split('?')[0])&&(!req.headers.origin||req.headers.origin==='null');
      const characterMedia=/^(?:\/instances\/[a-f0-9-]+)?\/internal\/character-media\/[A-Za-z0-9-]+\/[a-f0-9]{64}$/.test(req.url);
      const voiceMedia=/^(?:\/instances\/[a-f0-9-]+)?\/internal\/voice-audio\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(req.url);
      if (req.headers.host !== expectedHost || (!nativeCompanion&&!characterMedia&&!voiceMedia&&((req.headers.origin && req.headers.origin !== `http://${expectedHost}`) || req.headers['sec-fetch-site'] === 'cross-site'))) throw new WorkbenchError(403, '只允许工作台的本机同源访问。');
      let url;
      let pathname;
      try {
        if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('invalid target');
        url = new URL(req.url, appUrl);
        pathname = decodeURIComponent(req.url.split('?')[0]);
      } catch { throw new WorkbenchError(400, '请求路径无效。'); }
      if (pathname.includes('\\') || /[\u0000-\u001f\u007f:]/.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.')) throw new WorkbenchError(400, '请求路径无效。');
      const instanceIdentity=store.getSetting('instance.identity');
      if(instanceIdentity){const requested=/^\/api\/(?:modules|ai\/modules)\/([^/]+)/.exec(pathname)?.[1];if(requested&&requested!==instanceIdentity.moduleId&&!(instanceIdentity.moduleId==='comfyui'&&requested==='drawing'))throw new WorkbenchError(409,'这个接口不属于当前模块实例。');}
      if(instanceManager){
        if(pathname==='/api/instances/migrate-legacy'){
          if(req.method!=='POST')throw new WorkbenchError(405,'旧资料迁移需要 POST 请求。');fields(await body(req),[]);
          return json(res,200,prepareInstances());
        }
        const scoped=pathname.match(/^\/instances\/([a-f0-9-]+)(\/.*)$/);
        if(scoped)return await instanceManager.proxy(scoped[1],req.url.slice(('/instances/'+scoped[1]).length),req,res);
        if(pathname==='/api/instances'){
          if(req.method==='GET')return json(res,200,{instances:instanceManager.list()});
          if(req.method==='POST')return json(res,201,{instance:await instanceManager.create(await body(req))});
          throw new WorkbenchError(405,'实例列表需要 GET 或 POST 请求。');
        }
        if(pathname==='/api/characters/collect-legacy'){
          if(req.method!=='POST')throw new WorkbenchError(405,'收录旧角色资料需要 POST 请求。');fields(await body(req),[]);
          return json(res,200,instanceManager.collectCharacterLibrary());
        }
        const instanceRoute=pathname.match(/^\/api\/instances\/([a-f0-9-]+)(?:\/(start|stop|persona|export-persona|variant|related))?$/);
        if(instanceRoute){const [,id,action]=instanceRoute;
          if(!action&&req.method==='PATCH')return json(res,200,{instance:instanceManager.update(id,await body(req))});
          if(!action&&req.method==='DELETE')return json(res,200,await instanceManager.remove(id));
          if(!action&&req.method==='GET')return json(res,200,{instance:instanceManager.record(id)});
          if(req.method!=='POST')throw new WorkbenchError(405,'此实例操作需要 POST 请求。');
          const value=await body(req,action==='persona'?12*1024*1024:MAX_BODY_BYTES);
          if(action==='persona')return json(res,200,await instanceManager.persona(id,value));
          if(action==='export-persona')return json(res,200,instanceManager.exportPersona(id,value));
          if(action==='variant')return json(res,200,{instance:await instanceManager.variant(id,value)});
          if(action==='related')return json(res,200,await instanceManager.related(id,value));
          fields(value,[]);
          if(action==='start'||action==='stop')return json(res,200,{instance:await instanceManager[action](id)});
          throw new WorkbenchError(404,'找不到这个实例操作。');
        }
        const catalogOperation=/^\/api\/modules\/[^/]+\/(?:enable|disable|package|resources(?:\/[^/]+)?)$/.test(pathname);
        if(legacyMigrated()&&pathname.startsWith('/card-studio'))throw new WorkbenchError(409,'旧写卡器已迁移，请从对应实例重新打开。');
        if(legacyMigrated()&&req.method!=='GET'&&(!catalogOperation&&pathname.startsWith('/api/modules/')||pathname.startsWith('/api/training/')||pathname==='/api/characters/select'||pathname==='/api/ai/chat'||pathname.startsWith('/internal/')))throw new WorkbenchError(409,'旧模块已迁移，请在对应实例中操作。');
      }
      if(pathname==='/api/component-packages'&&req.method==='GET')return json(res,200,{...await components.state(),canChooseFile:typeof choosePath==='function'});
      if(pathname==='/api/component-packages/storage'&&req.method==='GET')return json(res,200,await components.storage());
      if(pathname==='/api/storage'&&req.method==='GET')return json(res,200,await resourceStorage.state());
      if(pathname.startsWith('/api/component-packages/')||pathname.startsWith('/api/storage/')){
        if(req.method!=='POST')throw new WorkbenchError(405,'此资源操作需要 POST 请求。');
        if(instanceIdentity)throw new WorkbenchError(403,'请通过工作台共享资源入口管理组件。');
        const value=await body(req);
        const prefix=pathname.startsWith('/api/storage/')?'/api/storage/':'/api/component-packages/';
        const action=pathname.slice(prefix.length),controller=prefix==='/api/storage/'?resourceStorage:components;
        if(action==='plan'){fields(value,['id','action']);return json(res,200,await controller.plan(value));}
        if(action==='execute'){fields(value,['planId','confirmed']);return json(res,200,await controller.execute(value));}
        if(prefix==='/api/component-packages/'){
          if(action==='source'){fields(value,['url']);return json(res,200,await components.setSource(value));}
          const component=action.match(/^(mc-play|training)\/(install|import|cancel)$/);
          if(component){fields(value,[]);const [,id,operation]=component;
            if(operation==='cancel')return json(res,200,await components.cancel(id));
            if(operation==='import'){
              if(typeof choosePath!=='function')throw new WorkbenchError(409,'请在桌面工作台选择本地组件包。');
              const file=await choosePath({kind:'file',title:'选择'+(id==='training'?'训练':'MC 陪玩')+'组件包',filters:[{name:'工作台组件包',extensions:['afcomponent']}]});
              if(!file)return json(res,200,{cancelled:true});
              return json(res,202,await components.install(id,{file:typeof file==='string'?file:file.path}));
            }
            return json(res,202,await components.install(id));
          }
        }
        throw new WorkbenchError(404,'找不到这个资源操作。');
      }
      if(voiceMedia){
        if(req.method!=='GET')throw new WorkbenchError(405,'声音文件需要 GET 请求。');
        const [,id,signature]=pathname.match(/^\/internal\/voice-audio\/([a-f0-9]{64})\/([a-f0-9]{64})$/);
        const audio=await voice.audio(id,signature);
        res.setHeader('cross-origin-resource-policy','cross-origin');res.setHeader('access-control-allow-origin','*');
        res.writeHead(200,{'content-type':audio.mime,'content-length':audio.bytes.length,'cache-control':'private, max-age=3600'});return res.end(audio.bytes);
      }
      const studioRoute=pathname.match(/^\/api\/voice-studio\/(state|config|detect|install|cancel-install|jobs|cancel|save|discard)$/);
      if(studioRoute){
        const action=studioRoute[1];
        if(['config','install'].includes(action)&&(voiceStudio.state().busy||voice.coordination?.active||voice.coordination?.queued))throw new WorkbenchError(409,'请等待声音任务完成，再更改或安装声音组件。');
        if(action==='state'&&req.method==='GET')return json(res,200,voiceStudio.state({owner:voiceOwner}));
        if(action==='config'&&req.method==='PUT'){const value=await body(req);fields(value,['values']);await voiceResources.configure(value.values);return json(res,200,voiceStudio.state({owner:voiceOwner}));}
        if(req.method!=='POST')throw new WorkbenchError(405,'此声音操作需要 POST 请求。');
        const value=await body(req);
        if(action==='jobs')return json(res,202,voiceStudio.create(value,{owner:voiceOwner}));
        if(action==='save')return json(res,200,await voiceStudio.save(value,{owner:voiceOwner}));
        if(action==='discard')return json(res,200,await voiceStudio.discard(value,{owner:voiceOwner}));
        if(action==='install'){fields(value,['component','provider','environmentMode','planId','action','modelKind','size']);await voiceResources.install(value);return json(res,202,voiceStudio.state({owner:voiceOwner}));}
        fields(value,action==='detect'?['refresh']:[]);
        if(action==='detect')await voiceResources.detect(value);
        else if(action==='cancel-install')await voiceResources.cancel();
        else if(action==='cancel')await voiceStudio.cancel({owner:voiceOwner});
        else throw new WorkbenchError(405,'此声音操作不支持 POST 请求。');
        return json(res,200,voiceStudio.state({owner:voiceOwner}));
      }
      const voiceExport=pathname.match(/^\/api\/voice\/voices\/([^/]+)\/audio$/);
      if(voiceExport){
        if(req.method!=='GET')throw new WorkbenchError(405,'导出音色需要 GET 请求。');
        if(url.search)throw new WorkbenchError(400,'导出音色不接受路径或其他参数。');
        const audio=await voiceStudio.exportVoice(voiceExport[1]);
        res.writeHead(200,{'content-type':audio.mime,'content-length':audio.bytes.length,'cache-control':'no-store','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(audio.filename).replace(/['()*]/g,value=>'%'+value.charCodeAt(0).toString(16).toUpperCase())}`});return res.end(audio.bytes);
      }
      const voiceRoute=pathname.match(/^\/api\/voice\/(state|voices|config|start|stop|speech|logs)$/);
      if(voiceRoute){
        const action=voiceRoute[1];
        if(action==='logs'){
          if(req.method!=='GET')throw new WorkbenchError(405,'读取声音日志需要 GET 请求。');
          return json(res,200,await voice.logs());
        }
        if(action==='state'&&req.method==='GET')return json(res,200,voice.status?await voice.status():voice.state());
        if(action==='voices'&&req.method==='GET')return json(res,200,await voice.voices());
        if(action==='config'){
          if(req.method==='PUT'){profileStore.saveConfig('voice',configValues(knownModule('voice'),await body(req)));}
          else if(req.method!=='GET')throw new WorkbenchError(405,'声音配置需要 GET 或 PUT 请求。');
          return json(res,200,{config:profileStore.module('voice').config});
        }
        if(req.method!=='POST')throw new WorkbenchError(405,'此声音操作需要 POST 请求。');
        const value=await body(req);
        if(action==='start'||action==='stop'){fields(value,[]);return json(res,200,await voice[action]());}
        fields(value,['text','voiceId','characterId']);
        const characterId=value.characterId?identifier(value.characterId,'角色标识'):null;
        if(characterId)store.requireCharacter(characterId);
        const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',abort);
        try{return json(res,200,await voice.synthesize({text:value.text,voiceId:value.voiceId,characterId,moduleId:'voice',signal:controller.signal}));}
        finally{req.off('aborted',abort);res.off('close',abort);}
      }
      if(characterMedia){
        if(req.method!=='GET')throw new WorkbenchError(405,'角色图片需要 GET 请求。');
        const [,id,signature]=pathname.match(/^\/internal\/character-media\/([A-Za-z0-9-]+)\/([a-f0-9]{64})$/);
        if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(signCharacterImage(id),'hex')))throw new WorkbenchError(403,'角色图片地址无效。');
        const result=await drawing.image(id);
        res.setHeader('cross-origin-resource-policy','cross-origin');res.setHeader('access-control-allow-origin','*');
        res.writeHead(200,{'content-type':result.mime,'content-length':result.bytes.length,'cache-control':'private, max-age=31536000, immutable'});return res.end(result.bytes);
      }
      const frameRoute=pathname.match(/^\/internal\/character-frames\/([a-f0-9]{48})$/);
      if(frameRoute){
        if(req.method!=='GET')throw new WorkbenchError(405,'状态栏文档需要 GET 请求。');
        const frame=characterFrames.get(frameRoute[1]);
        if(!frame||Date.now()>frame.expiresAt){characterFrames.delete(frameRoute[1]);throw new WorkbenchError(404,'状态栏预览已经过期，请重新打开。');}
        if(!life.full(frame.characterId,frame.configRevision)||!life.config(frame.characterId).runtime.scriptsEnabled)throw new WorkbenchError(409,'状态栏的角色模式、设置或安装能力已改变，请重新打开。');
        res.removeHeader('x-frame-options');
        res.setHeader('content-security-policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(frame.html);
      }
      if(/^\/internal\/companion\/ai\/v1\/(?:models|chat\/completions)$/.test(pathname)){
        if(nativeCompanion){res.setHeader('access-control-allow-origin','null');res.setHeader('cross-origin-resource-policy','cross-origin');res.setHeader('vary','Origin');}
        if(req.method==='OPTIONS'){
          if(!nativeCompanion)throw new WorkbenchError(403,'此接口只供受管陪伴运行端 使用。');
          res.writeHead(204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'authorization, content-type','access-control-max-age':'600'});return res.end();
        }
        const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
        companion.authorize(token);
        if(pathname.endsWith('/models')){
          if(req.method!=='GET')throw new WorkbenchError(405,'此接口需要 GET 请求。');
          return json(res,200,{object:'list',data:[{id:'workbench-shared',object:'model',owned_by:'workbench'}]});
        }
        if(req.method!=='POST')throw new WorkbenchError(405,'此接口需要 POST 请求。');
        const controller=new AbortController(),cancel=()=>{if(!res.writableFinished)controller.abort();};res.once('close',cancel);
        try{return await companion.request(token,async signal=>{
          const value=await body(req),result=await companion.complete(value,signal);
          if(res.destroyed)return;
          if(result.response){
            const response=result.response;
            res.writeHead(200,{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store'});
            if(response.body)await pipeline(Readable.fromWeb(response.body),res,{signal});else res.end();
          } else if(value.stream){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.end(airiStream(result.value));}
          else json(res,200,result.value);
          if(result.afterDelivery){
            // 等响应完整交给本机客户端后记录经历；失败不会改写已返回的对话结果。
            if(!res.writableFinished&&!res.destroyed)await new Promise(resolveFinish=>{res.once('finish',resolveFinish);res.once('close',resolveFinish);});
            if(res.writableFinished&&!controller.signal.aborted){const observation=Promise.resolve().then(()=>result.afterDelivery()).catch(()=>{});pending.add(observation);observation.finally(()=>pending.delete(observation));}
          }
        },controller.signal);}finally{res.removeListener('close',cancel);}
      }
      const liteRoute=pathname.match(/^\/api\/modules\/companion-lite\/(state|chat|images\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([0-7]))$/);
      if(liteRoute){
        if(!store.module('companion-lite').enabled)throw new WorkbenchError(409,'请先添加虚拟陪伴·精简版。');
        if(liteRoute[2]){
          if(req.method!=='GET')throw new WorkbenchError(405,'聊天图片需要 GET 请求。');
          const controller=new AbortController(),cancel=()=>{if(!res.writableFinished)controller.abort();};res.once('close',cancel);
          try{const image=await liteCompanion.image(liteRoute[2],liteRoute[3],Number(liteRoute[4]),controller.signal);res.writeHead(200,{'content-type':image.mime,'content-length':image.bytes.length,'cache-control':'private, no-store'});return res.end(image.bytes);}
          finally{res.removeListener('close',cancel);}
        }
        if(liteRoute[1]==='state'){if(req.method!=='GET')throw new WorkbenchError(405,'此接口需要 GET 请求。');return json(res,200,liteCompanion.state(url.searchParams.get('conversationId')??'default'));}
        if(req.method!=='POST')throw new WorkbenchError(405,'此接口需要 POST 请求。');
        const controller=new AbortController(),cancel=()=>{if(!res.writableFinished)controller.abort();};res.once('close',cancel);
        const task=liteCompanion.chat(await body(req),controller.signal);pending.add(task);
        try{return json(res,200,await task);}finally{pending.delete(task);res.removeListener('close',cancel);}
      }
      const companionRoute=pathname.match(/^\/api\/modules\/companion\/(state|start|viewport|window)$/);
      if(companionRoute){
        if(!store.module('companion').enabled)throw new WorkbenchError(409,'请先添加虚拟陪伴模块。');
        const action=companionRoute[1];
        if(action==='state'){if(req.method!=='GET')throw new WorkbenchError(405,'此接口需要 GET 请求。');return json(res,200,companion.state());}
        if(req.method!=='POST')throw new WorkbenchError(405,'此接口需要 POST 请求。');
        const value=await body(req);
        if(action==='viewport')return json(res,200,companion.viewport(value));
        if(action==='window')return json(res,200,await companion.open(value));
        fields(value,[]);return json(res,200,await companion.start(appUrl));
      }
      if(pathname==='/mcp'){
        if(!sharedAI.config().mcpEnabled||req.headers.authorization!=='Bearer '+sharedAI.mcpToken)throw new WorkbenchError(403,'MCP 尚未启用或令牌无效。');
        if(req.method!=='POST')throw new WorkbenchError(405,'此 MCP 不提供 SSE 订阅，请使用 POST。');
        if(req.headers['mcp-protocol-version']&&!['2025-06-18','2025-03-26'].includes(req.headers['mcp-protocol-version']))throw new WorkbenchError(400,'不支持此 MCP 协议版本。');
        let message;
        try{message=await body(req,MAX_BODY_BYTES,false);}
        catch(error){if(error instanceof WorkbenchError&&error.status===400)return json(res,200,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'请求正文不是有效的 UTF-8 JSON。'}});throw error;}
        const result=await workbenchRpc(message);
        if(result===null){res.writeHead(202);return res.end();}return json(res,200,result);
      }
      if(pathname.startsWith('/api/training/')){
        if(instanceManager)throw new WorkbenchError(409,'请先在工作台打开 LoRA 训练实例，并使用该实例的页面或 MCP 配置。');
        if(instanceIdentity&&instanceIdentity.moduleId!=='training')throw new WorkbenchError(409,'这个接口不属于当前模块实例。');
        if(!store.module('training').enabled)throw new WorkbenchError(409,'请先添加 LoRA 训练模块。');
        return await trainingHttp({req,res,pathname,url,readBody:body,json,service:await ensureTraining()});
      }
      if(pathname==='/api/ai/mcp'&&req.method==='GET')return json(res,200,{enabled:sharedAI.config().mcpEnabled,http:{url:appUrl+'/mcp',headers:{Authorization:'Bearer '+sharedAI.mcpToken}},stdio:{command:process.execPath,args:[join(root,'tools/workbench-mcp.mjs'),join(resolve(dataDir),'mcp-connection.json')],env:{ELECTRON_RUN_AS_NODE:'1'}}});
      if (pathname==='/internal/mc-play/ai/v1/chat/completions') {
        if(req.method!=='POST')throw new WorkbenchError(405,'需要 POST 请求。');
        const controller=new AbortController();const cancel=()=>controller.abort();
        res.once('close',cancel);if(res.destroyed)controller.abort();
        try {
          const value=await body(req);
          const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'';
          const result=await minecraft.complete(token,value.messages,{signal:controller.signal});
          if(!res.destroyed)return json(res,200,{choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:'stop'}],usage:result.usage});
          return;
        } finally {res.removeListener('close',cancel);}
      }
      if (pathname==='/internal/ai/v1/chat/completions') {
        if(req.headers.authorization!=='Bearer '+sharedAI.token)throw new WorkbenchError(403,'共用 AI 连接令牌无效。');
        if(req.method!=='POST')throw new WorkbenchError(405,'需要 POST 请求。');
        const value=await body(req);
        if(value.workbenchTimeoutMs!==undefined&&(!value.tools?.length||!Number.isInteger(value.workbenchTimeoutMs)||value.workbenchTimeoutMs<1||value.workbenchTimeoutMs>8*60*1000))throw new WorkbenchError(400,'制卡剩余时限需要是 1–480000 毫秒。');
          if(value.workbenchIdleTimeoutMs!==undefined&&(!value.stream||value.workbenchTimeoutMs!==undefined||!Number.isInteger(value.workbenchIdleTimeoutMs)||value.workbenchIdleTimeoutMs<1||value.workbenchIdleTimeoutMs>30*60*1000))throw new WorkbenchError(400,'制卡无活动时限需要是 1–1800000 毫秒，且仅用于流式请求。');
        const controller=new AbortController();const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
        if(value.stream){
          res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store'});
          const send=value=>{if(!res.destroyed&&!res.writableEnded)res.write('data: '+JSON.stringify(value)+'\n\n');};
            let previous='',lastState='';
            const progress=value=>{
              const workbench={phase:value.phase,activityRevision:value.activityRevision||0};
              if(typeof value.partialText==='string'&&value.partialText!==previous){
                workbench.previewReset=!value.partialText.startsWith(previous);
                workbench.previewDelta=workbench.previewReset?value.partialText:value.partialText.slice(previous.length);
                previous=value.partialText;
              }
              const state=JSON.stringify(workbench);
              if(state!==lastState){lastState=state;send({choices:[],workbench});}
            };
          const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': waiting\n\n');},10000);
          try{
            progress({phase:'starting'});
              const result=await sharedAI.complete(value.messages,{moduleId:'cards',tools:value.tools||[],signal:controller.signal,onProgress:progress,...(value.workbenchTimeoutMs?{timeoutMs:value.workbenchTimeoutMs}:{idleTimeoutMs:value.workbenchIdleTimeoutMs??5*60*1000})});
            send({choices:[{index:0,delta:{role:'assistant',content:result.text||null,...(result.toolCalls?.length?{tool_calls:result.toolCalls.map((call,index)=>({index,...call}))}:{})},finish_reason:result.toolCalls?.length?'tool_calls':'stop'}],usage:result.usage});
            if(!res.destroyed&&!res.writableEnded)res.end('data: [DONE]\n\n');
          }catch(error){send({error:{message:String(error.message||'AI 请求失败。').slice(0,500)}});if(!res.destroyed&&!res.writableEnded)res.end('data: [DONE]\n\n');}
          finally{clearInterval(heartbeat);res.removeListener('close',cancel);}
          return;
        }
        let result;try{result=await sharedAI.complete(value.messages,{moduleId:'cards',tools:value.tools||[],signal:controller.signal,...(value.workbenchTimeoutMs?{timeoutMs:value.workbenchTimeoutMs}:{})});}finally{res.removeListener('close',cancel);}
        return json(res,200,{choices:[{index:0,message:{role:'assistant',content:result.text||null,...(result.toolCalls?.length?{tool_calls:result.toolCalls}:{})},finish_reason:result.toolCalls?.length?'tool_calls':'stop'}],usage:result.usage});
      }
      if(pathname==='/api/ai/codex/status'){
        if(req.method!=='GET')throw new WorkbenchError(405,'检查 Codex 需要 GET 请求。');
        return json(res,200,await sharedAI.codexDiagnostics());
      }
      if(pathname==='/api/ai/codex/models'){
        if(req.method!=='GET')throw new WorkbenchError(405,'需要 GET 请求。');
        return json(res,200,{models:await sharedAI.modelCatalog()});
      }
      if(pathname==='/api/ai/config'){
        if(req.method==='GET')return json(res,200,sharedAI.publicConfig());
        if(req.method!=='PUT')throw new WorkbenchError(405,'需要 PUT 请求。');
        const result=sharedAI.save(await body(req));await cardStudio.syncSharedAI();return json(res,200,result);
      }
      const moduleAI=pathname.match(/^\/api\/ai\/modules\/([^/]+)\/(config|test)$/);
      if(moduleAI){
        const id=knownModule(moduleAI[1]).id;
        if(moduleAI[2]==='config'){
          if(req.method==='GET')return json(res,200,sharedAI.moduleConfig(id));
          if(req.method!=='PUT')throw new WorkbenchError(405,'需要 GET 或 PUT 请求。');
          const result=sharedAI.saveModule(id,await body(req));if(id==='cards')await cardStudio.syncSharedAI();return json(res,200,result);
        }
        if(req.method!=='POST')throw new WorkbenchError(405,'需要 POST 请求。');
        fields(await body(req),[]);const result=await sharedAI.complete([{role:'user',content:'仅回复 OK。'}],{moduleId:id,...(id==='qq'?{policy:'chat-only'}:{})});return json(res,200,{ok:true,text:result.text});
      }
      if(pathname==='/api/ai/test'&&req.method==='POST'){fields(await body(req),[]);const result=await sharedAI.complete([{role:'user',content:'仅回复 OK。'}]);return json(res,200,{ok:true,text:result.text});}
      if(pathname==='/api/ai/chat'&&req.method==='POST'){
        const value=await body(req);fields(value,['moduleId','messages']);const id=knownModule(value.moduleId).id;
        if(!store.module(id).enabled)throw new WorkbenchError(409,'请先添加此模块。');
        if(['character-lite','character-full','companion-lite','companion'].includes(id))characterPackages.require(id);
        const profileText=['cards','character-lite','character-full','companion-lite','companion'].includes(id)?userProfileText(userProfile()):'';
        const messages=profileText&&Array.isArray(value.messages)?[{role:'system',content:profileText},...value.messages]:value.messages;
        return json(res,200,await sharedAI.complete(messages,{moduleId:id,...(['qq','companion-lite'].includes(id)?{policy:'chat-only'}:{})}));
      }
      if(pathname==='/api/paths/choose'){
        if(req.method!=='POST')throw new WorkbenchError(405,'路径选择需要 POST 请求。');
        return json(res,200,await pathPicker.choose(await body(req)));
      }
      if(pathname==='/api/environment/state'){
        if(req.method!=='GET')throw new WorkbenchError(405,'检索记录需要 GET 请求。');
        const value={moduleId:url.searchParams.get('moduleId')};environment.validate(value);
        if(!store.module(value.moduleId).enabled)throw new WorkbenchError(409,'请先添加这个模块。');
        return json(res,200,environment.state(value));
      }
      if (pathname === '/api/environment/scan' || pathname === '/api/environment/choose-directory') {
        if (req.method !== 'POST') throw new WorkbenchError(405,'本机环境查找需要 POST 请求。');
        const value = await body(req);environment.validate(value,pathname.endsWith('choose-directory'));
        const id = knownModule(value.moduleId).id;
        if (!store.module(id).enabled) throw new WorkbenchError(409,'请先添加这个模块。');
        const result = pathname.endsWith('choose-directory') ? await environment.chooseDirectory(value) : await environment.scan(value);
        if (!store.module(id).enabled) throw new WorkbenchError(409,'模块已停用，扫描结果未应用。');
        return json(res,200,result);
      }
      if(pathname.startsWith('/api/modules/qq/')&&!/^\/api\/modules\/qq\/(resources(?:\/|$)|enable$|disable$|open$|config$|check-paths$)/.test(pathname)){
        if(!store.module('qq').enabled)throw new WorkbenchError(409,'请先添加 QQ 对话模块。');
        ensureQQ();
        await qqRuntime.ready;
        const action=pathname.slice('/api/modules/qq/'.length),route=action.match(/^conversations\/([^/]+)\/(messages|memories|new-story)$/);
        const methods={state:'GET',conversations:'GET',runtime:'PUT',binding:'PUT',rules:'PUT',connect:'POST',disconnect:'POST',stop:'POST','replies/start':'POST','replies/pause':'POST','login/start':'POST','login/poll':'POST','login/refresh':'POST','login/cancel':'POST',memories:'POST','memories/delete':'POST'};
        const method=route?(route[2]==='new-story'?'POST':'GET'):methods[action];
        if(!method)throw new WorkbenchError(404,'找不到这个 QQ 管理接口。');
        if(req.method!==method)throw new WorkbenchError(405,'此 QQ 接口不支持这个请求方法。');
        const value=method==='GET'?{}:await body(req);
        let result;
        if(route){
          const id=identifier(route[1],'会话标识');fields(value,[]);
          result=route[2]==='messages'?qq.messages(id):route[2]==='memories'?qq.memories(id):qq.newStory(id);
        }else switch(action){
          case 'state':await qqRuntime.sync?.();result=qq.state();break;
          case 'conversations':result=qq.conversations();break;
          case 'binding':result=await qq.bind(value);break;
          case 'rules':result=qq.saveRules(value);break;
          case 'runtime':result=await qqRuntime.configure(value,{beforeChange:async()=>{qq.pause();await qq.disconnect({stopRuntime:true});instanceCoordination?.releaseQQ();}});break;
          case 'connect':fields(value,[]);instanceCoordination?.claimQQ(qqRuntime.config||qqRuntime.state().external);try{result=await qq.connect();}catch(error){instanceCoordination?.releaseQQ();throw error;}break;
          case 'disconnect':fields(value,[]);result=await qq.disconnect();if(!qqRuntime.state().running)instanceCoordination?.releaseQQ();break;
          case 'stop':fields(value,[]);result=await qq.disconnect({stopRuntime:true});instanceCoordination?.releaseQQ();break;
          case 'replies/start':fields(value,[]);result=await qq.start();break;
          case 'replies/pause':fields(value,[]);result=qq.pause();break;
          case 'login/start':fields(value,[]);qq.pause();instanceCoordination?.claimQQ(qqRuntime.config||{});try{result=await qqRuntime.startLogin();}catch(error){instanceCoordination?.releaseQQ();throw error;}break;
          case 'login/poll':fields(value,['sessionId']);result=await qqRuntime.pollLogin(value);try{instanceCoordination?.claimQQ({...qqRuntime.config,accountId:qqRuntime.state().login?.accountId||qqRuntime.config?.accountId});}catch(error){await qqRuntime.stop();instanceCoordination?.releaseQQ();throw error;}break;
          case 'login/refresh':fields(value,['sessionId']);result=await qqRuntime.refreshLogin(value);break;
          case 'login/cancel':fields(value,['sessionId']);qq.pause();result=await qqRuntime.cancelLogin(value);instanceCoordination?.releaseQQ();break;
          case 'memories':result=qq.saveMemory(value);break;
          case 'memories/delete':result=qq.deleteMemory(value);break;
        }
        return json(res,200,await result);
      }
      if(sharedAI.managesModule('cards')&&pathname==='/card-studio/api/bridge/llm-config')throw new WorkbenchError(409,'请在角色卡接入配置或全局设置中修改 AI 连接。');
      if (pathname === '/api/modules/cards/studio' || pathname.startsWith('/card-studio/')) {
        if (!store.module('cards').enabled) throw new WorkbenchError(409, '请先添加角色卡模块。');
        if (pathname === '/api/modules/cards/studio') {
          if (req.method !== 'POST') throw new WorkbenchError(405, '此接口需要 POST 请求。');
          fields(await body(req), []);
          try { return json(res, 200, await cardStudio.start()); }
          catch (error) { throw new WorkbenchError(error.statusCode || error.status || 503, error.message); }
        }
        return await cardStudio.proxy(req,res);
      }
      if(pathname.startsWith('/api/modules/mc-skin/')&&!/^\/api\/modules\/mc-skin\/(resources(?:\/|$)|enable$|disable$|open$|config$|check-paths$)/.test(pathname)){
        if(!store.module('mc-skin').enabled)throw new WorkbenchError(409,'请先添加 MC 皮肤模块。');
        const action=pathname.slice('/api/modules/mc-skin/'.length);
        if(action==='state'&&req.method==='GET')return json(res,200,await mcSkin.state());
        const uploaded=action.match(/^uploads\/([A-Za-z0-9-]+)$/);
        const file=action.match(/^files\/([A-Za-z0-9-]+)\/([A-Za-z0-9.-]+)$/);
        if(req.method==='GET'&&(uploaded||file)){
          const result=uploaded?await mcSkin.uploadedImage(uploaded[1]):await mcSkin.file(file[1],file[2]);
          res.writeHead(200,{'content-type':result.mime,'content-length':result.bytes.length,'cache-control':'private, max-age=31536000, immutable',...(url.searchParams.get('download')==='1'?{'content-disposition':`attachment; filename="${result.filename}"`}:{})});return res.end(result.bytes);
        }
        if(action==='vendor/skinview3d.js'&&req.method==='GET'){
          const bytes=await readFile(join(skinSkillRoot,'assets/vendor/skinview3d.bundle.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=86400'});return res.end(bytes);
        }
        const job=action.match(/^jobs\/([A-Za-z0-9-]+)(?:\/(cancel|approve))?$/);
        if(job&&!job[2]&&req.method==='GET')return json(res,200,mcSkin.job(job[1]));
        if(req.method!=='POST')throw new WorkbenchError(405,'此皮肤接口需要 POST 请求。');
        const value=await body(req,action==='uploads'?12*1024*1024:MAX_BODY_BYTES);
        if(action==='uploads')return json(res,200,await mcSkin.upload(value));
        if(action==='import-configured')return json(res,200,await mcSkin.importConfigured(value));
        if(action==='jobs')return json(res,200,await mcSkin.submit(value));
        fields(value,[]);
        if(action==='runtime/check')return json(res,200,await mcSkin.check());
        if(job?.[2])return json(res,200,mcSkin[job[2]](job[1]));
        throw new WorkbenchError(404,'找不到这个皮肤接口。');
      }
      if (pathname.startsWith('/api/modules/drawing/') && !/^\/api\/modules\/drawing\/(resources(?:\/|$)|enable$|disable$|open$|config$|check-paths$)/.test(pathname)) {
        const action = pathname.slice('/api/modules/drawing/'.length);
        const environmentAction = ['state','connect','discover','launch','open-ui','mcp/tools'].includes(action) || /^(?:runtime|manager)(?:\/|$)/.test(action);
        if (!store.module('drawing').enabled && !(environmentAction && store.module('comfyui').enabled)) throw new WorkbenchError(409, '请先添加角色绘图模块；运行与维护也可通过 ComfyUI 启动器使用。');
        if(await handleDrawingCompletionHttp({req,res,pathname,readBody:body,json,completion:drawingCompletion}))return;
        const image = action.match(/^images\/([A-Za-z0-9-]+)$/);
        const output = action.match(/^results\/([A-Za-z0-9-]+)$/);
        if (['GET', 'HEAD'].includes(req.method) && output) return await serveDrawingResult(req, res, await drawing.result(output[1]), url.searchParams.get('download') === '1');
        const preview = action.match(/^jobs\/([A-Za-z0-9-]+)\/preview$/);
        if (req.method === 'GET' && preview) {
          const result = drawing.preview(preview[1]);
          res.writeHead(200, { 'content-type': result.mime, 'content-length': result.bytes.length, 'cache-control': 'no-store' });
          return res.end(result.bytes);
        }
        if (req.method === 'GET' && action === 'preview-options') return json(res, 200, await drawing.previewOptions());
        if (req.method === 'GET' && image) {
          const result = await drawing.image(image[1]);
          res.writeHead(200, { 'content-type':result.mime, 'content-length':result.bytes.length, 'cache-control':'private, max-age=31536000, immutable', ...(url.searchParams.get('download') === '1' ? {'content-disposition':`attachment; filename="${result.filename}"`} : {}) });
          return res.end(result.bytes);
        }
        if (req.method === 'GET' && action === 'state') return json(res, 200, {...drawing.state(),startup:drawingStartup.state()});
        if (req.method === 'GET' && action === 'mcp/tools') {
          const listed=await workbenchRpc({jsonrpc:'2.0',id:1,method:'tools/list'});
          return json(res,200,{tools:listed.result.tools.filter(tool=>tool.name.startsWith('comfy_'))});
        }
        if (req.method === 'GET' && action === 'manager/state') return json(res, 200, drawingManager.state());
        const managerLog = action.match(/^manager\/tasks\/([A-Za-z0-9-]+)\/logs$/);
        if (req.method === 'GET' && managerLog) return json(res, 200, drawingManager.logs(managerLog[1]));
        const managerSnapshot = action.match(/^manager\/snapshots\/([A-Za-z0-9-]+)$/);
        if (req.method === 'GET' && managerSnapshot) return json(res, 200, await drawingManager.snapshotById(managerSnapshot[1]));
        if (req.method === 'GET' && action === 'runtime') return json(res, 200, await drawing.runtime.state());
        if (req.method === 'GET' && action === 'runtime/logs') return json(res, 200, {...await drawing.runtime.logs(),connection:drawing.connection?{...drawing.connection,connected:drawing.currentConnection()}:{connected:false},browser:drawingStartup?.state() || null});
        if (req.method === 'GET' && action === 'workflows') return json(res, 200, {workflows:drawing.workflows()});
        const workflow = action.match(/^workflows\/([A-Za-z0-9-]+)(?:\/(export))?$/);
        if (req.method === 'GET' && workflow) { const item=drawing.workflow(workflow[1]); return json(res, 200, workflow[2] ? item.prompt : item); }
        if (req.method !== 'POST') throw new WorkbenchError(405, '此绘图接口需要 POST 请求。');
        const value = await body(req, action === 'uploads' ? 25 * 1024 * 1024 : MAX_BODY_BYTES);
        let result;
        if (action === 'preferences') result = await drawing.savePreferences(value);
        else if (action === 'open-service') {
          fields(value,['openBrowser']);
          const preference=Object.hasOwn(value,'openBrowser')?await drawing.savePreferences(value):drawing.preferences();
          try { result=await drawing.connect(); }
          catch(error){if(error.status!==503||error.upstreamReachable||error.timedOut)throw error;drawingManager.assertIdle();result=await drawing.launch();}
          const url=drawing.config().serviceUrl;
          if(result.starting)drawingStartup.start({owned:true,openBrowser:preference.openBrowser});
          else {
            // Cancel a pending auto-open before honoring an explicit open request.
            drawingStartup.cancel();
            if(preference.openBrowser&&openComfyUI)await openComfyUI(url);
          }
          result={...result,url,openBrowser:preference.openBrowser,browserManaged:typeof openComfyUI==='function',opened:!result.starting&&preference.openBrowser&&typeof openComfyUI==='function'};
        }
        else if (action === 'manager/inventory') { fields(value,[]); result = await drawingManager.inventory(); }
        else if (action === 'manager/plan') result = await drawingManager.plan(value);
        else if (action === 'manager/apply') { result = await drawingManager.apply(value); await showProcessLog(result, {taskId:result.id}); }
        else if (action === 'manager/snapshots') result = await drawingManager.snapshot(value);
        else if (action === 'manager/downloads') result = await drawingManager.downloads.start(value);
        else if (/^manager\/downloads\/[A-Za-z0-9-]+\/(pause|resume)$/.test(action)) { const [,,id,operation]=action.split('/'); if(operation==='pause'){fields(value,[]);result=await drawingManager.downloads.pause(id);}else result=await drawingManager.downloads.resume(id,value); }
        else if (action === 'workflows/import') result = await drawing.importWorkflow(value);
        else if (action === 'workflows/inspect') result = await drawing.inspectWorkflow(value);
        else if (action === 'workflows/inspect-file') { fields(value,['key']); result = await drawing.inspectFile(value.key); }
        else if (action === 'runtime/settings') { drawing.runtime.saveSettings(value); result = await drawing.runtime.state(); }
        else if (action === 'runtime/diagnose') { fields(value,[]); result = await drawing.runtime.diagnose(); }
        else if (action === 'runtime/stop') { fields(value,[]); drawingStartup?.cancel(); result = await (instanceCoordination?instanceCoordination.run('stop',()=>drawing.runtime.stop()):drawing.runtime.stop()); drawing.connection=null; drawing.schema={}; }
        else if (action === 'runtime/stop-preview') { fields(value,[]); result = await drawing.prepareStop(); }
        else if (action === 'runtime/stop-confirm') { fields(value,['token']); drawingStartup?.cancel(); result = await (instanceCoordination?instanceCoordination.run('stop',()=>drawing.confirmStop(value)):drawing.confirmStop(value)); }
        else if (action === 'workflows/open') { fields(value,['key']); result=await drawing.importFile(value.key); }
        else if (action === 'uploads') result = await drawing.upload(value);
        else if (action === 'input-preview') result = await drawing.inputPreview(value);
        else if (action === 'jobs') result = await drawing.submit(value);
        else if (/^jobs\/[A-Za-z0-9-]+\/(hide|restore)$/.test(action)) { fields(value,[]); const [,id,operation]=action.split('/'); result=drawing.setJobHidden(id,operation==='hide'); }
        else if (/^jobs\/[A-Za-z0-9-]+\/(refresh|cancel)$/.test(action)) { fields(value,[]); const [,id,operation]=action.split('/'); result=await drawing[operation==='refresh'?'syncJob':'cancel'](id); }
        else if(action==='assistant'){
          fields(value,['instruction','workflowId','baseModel','loras','history']);drawing.connected();
          const instruction=typeof value.instruction==='string'&&value.instruction.length<=12000?value.instruction.trim():'';if(!instruction)throw new WorkbenchError(400,'请填写工作流需求。');
          for(const [key,limit] of [['baseModel',2000],['loras',4000]])if(value[key]!==undefined&&(typeof value[key]!=='string'||value[key].length>limit))throw new WorkbenchError(400,'底模或 LoRA 输入过长或格式无效。');
          const workflow=value.workflowId?drawing.workflow(value.workflowId):null;
          const core=['CheckpointLoaderSimple','UNETLoader','CLIPLoader','DualCLIPLoader','VAELoader','LoraLoader','LoraLoaderModelOnly','CLIPTextEncode','KSampler','EmptyLatentImage','EmptySD3LatentImage','EmptyImage','VAEEncode','VAEDecode','LoadImage','ImageScale','SaveImage','PreviewImage'];
          const requested=(instruction+' '+(value.baseModel||'')).toLowerCase(),families=['qwen','wan','flux','sd3','sdxl'].filter(name=>requested.includes(name));
          const relevant=Object.keys(drawing.schema).filter(name=>families.some(family=>name.toLowerCase().includes(family)));
          const existing=workflow?Object.values(workflow.prompt).map(node=>node.class_type):[];
          const suggestions=[...new Set([...core,...relevant,...Object.keys(drawing.schema).filter(name=>/KSampler|TextEncode|LoadImage|Loader|Empty.*Latent|SaveImage|PreviewImage/.test(name))])].filter(name=>drawing.schema[name]).slice(0,80);
          const types=[...new Set([...existing,...suggestions])];
          const definitions=Object.fromEntries(types.map(name=>[name,drawing.schema[name]]));
          result=await sharedAI.complete([{role:'system',content:'你是 ComfyUI 工作流助手。依据提供的实际节点定义生成或修改工作流。返回一个 JSON 对象：{"explanation":"简体中文说明","workflow":{API格式节点图}}。currentWorkflow 为空时从零创建，无需用户提供基础工作流。按用户给出的底模、可选 LoRA 和功能要求组装；缺少必要模型信息或服务未列出相应模型时请明确询问，并返回 workflow:null。只使用已有节点和实际模型选项，不猜测模型文件；原工作流的身份、画面要求与连接应按用户指令保留。新建工作流应在尺寸控制节点提供可编辑的数值 width、height，默认 1024×1024 或模型支持的合适尺寸；工作台会为这两个参数提供常用尺寸预设和自定义宽高，不要虚构预设节点。图生图保留跟随主图比例的能力。生成工作流不代表执行。'},...(Array.isArray(value.history)?value.history.slice(-12).filter(m=>['user','assistant'].includes(m?.role)&&typeof m.content==='string').map(m=>({role:m.role,content:m.content.slice(0,16000)})):[]),{role:'user',content:JSON.stringify({instruction,baseModel:value.baseModel?.trim()||null,loras:value.loras?.trim()||null,currentWorkflow:workflow?.prompt||null,nodes:definitions})}],{moduleId:'drawing'});
          let candidate;try{candidate=JSON.parse(result.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));}catch{}
          result={...result,explanation:candidate?.explanation||result.text,workflow:candidate?.workflow||null};
        }
        else if(action==='discover'){fields(value,['comfyPath']);result=await drawing.discover(value.comfyPath);}
        else { fields(value,[]); if (action==='connect') result=await drawing.connect(); else if (action==='launch') {drawingManager.assertIdle();result=await drawing.launch();await showProcessLog(result);drawingStartup?.start({owned:result.starting===true});} else if (action==='workflows/scan') result=await drawing.scan(); else if(action==='open-ui'){const url=drawing.connected();if(openComfyUI)await openComfyUI(url);result={url,opened:!!openComfyUI};}else throw new WorkbenchError(404,'找不到这个绘图接口。'); }
        return json(res,200,result);
      }
      const minecraftRoute=pathname.match(/^\/api\/modules\/mc-play\/(state|connection|connect|disconnect|command|open-auth|skin(?:\/(?:image|apply|reset))?)$/);
      if(minecraftRoute) {
        if(!store.module('mc-play').enabled)throw new WorkbenchError(409,'请先添加 MC 陪玩模块。');
        const action=minecraftRoute[1];
        if(action==='state' && req.method==='GET')return json(res,200,minecraft.state());
        if(action==='skin' && req.method==='GET')return json(res,200,{skin:minecraft.skin.state()});
        if(action==='skin' && req.method==='PUT'){minecraft.skin.save(await body(req,768*1024));return json(res,200,minecraft.state());}
        if(action==='skin' && req.method==='PATCH'){minecraft.skin.configure(await body(req));return json(res,200,minecraft.state());}
        if(action==='skin/image' && req.method==='GET'){
          const image=minecraft.skin.resource.image(url.searchParams.get('revision'));
          res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','content-length':image.bytes.length,'x-content-type-options':'nosniff'});return res.end(image.bytes);
        }
        if(action==='connection' && req.method==='PUT')return json(res,200,minecraft.configure(await body(req)));
        if(req.method!=='POST')throw new WorkbenchError(405,'这个 MC 陪玩接口需要 POST 请求。');
        const value=await body(req);
        if(action==='command')return json(res,200,await minecraft.command(value));
        fields(value,[]);
        if(action==='skin/apply'){minecraft.skin.startApply();return json(res,202,minecraft.state());}
        if(action==='skin/reset'){minecraft.skin.startReset();return json(res,202,minecraft.state());}
        if(action==='connect')return json(res,200,await minecraft.connect(appUrl));
        if(action==='disconnect')return json(res,200,await minecraft.disconnect());
        if(action==='open-auth') {
          if(!minecraft.state().connection.authentication)throw new WorkbenchError(409,'当前没有等待中的微软登录。');
          if(!openMinecraftAuth)throw new WorkbenchError(503,'请在浏览器打开 https://www.microsoft.com/link 并输入当前登录码。');
          await openMinecraftAuth();return json(res,200,{opened:true});
        }
        throw new WorkbenchError(404,'找不到这个 MC 陪玩操作。');
      }
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
      const visionExtensionRoute=pathname.match(/^\/api\/vision-extension(?:\/(choose-directory|install|cancel|start|stop|connection|configure|discover))?$/);
      if(visionExtensionRoute){
        const action=visionExtensionRoute[1];
        if(!action){
          if(req.method!=='GET')throw new WorkbenchError(405,'视觉扩展包状态需要 GET 请求。');
          return json(res,200,visionExtension.state());
        }
        if(req.method!=='POST')throw new WorkbenchError(405,'视觉扩展包操作需要 POST 请求。');
        const value=await body(req);fields(value,action==='start'?['device']:action==='install'?['components','startAfter']:action==='configure'?['modelPath','projectorPath','runtimePath','searchRoots']:action==='discover'?['refresh']:[]);
        if(action==='start'&&value.device!==undefined&&!['auto','cpu'].includes(value.device))throw new WorkbenchError(400,'请选择自动加速或 CPU。');
        const method=action==='choose-directory'?'chooseDirectory':action;
        return json(res,200,await visionExtension[method](value));
      }
      const lifeRoute=pathname.match(/^\/api\/characters\/([^/]+)\/life(?:\/(settings|profile|state|memories|memories\/delete|memory\/overview|memory\/summary|memory\/organize|expressions|expressions\/delete|tools|tools\/delete|preview|simulate|recall|diary|actions|frame|scripts\/preview|vision\/status|vision\/test|memes\/catalog))?$/);
      if(lifeRoute){
        const id=identifier(lifeRoute[1],'角色标识'),action=lifeRoute[2];store.requireCharacter(id);
        const moduleId=url.searchParams.get('moduleId')??'companion',conversationId=url.searchParams.get('conversationId')??undefined;
        if(!['qq','companion','companion-lite','character-lite','character-full'].includes(moduleId))throw new WorkbenchError(400,'人设运行范围需要选择已知角色或陪伴模块。');
        if(!action){if(req.method!=='GET')throw new WorkbenchError(405,'角色系统资料需要 GET 请求。');return json(res,200,life.view(id,{moduleId,conversationId}));}
        if(action==='memory/overview'){
          if(req.method!=='GET')throw new WorkbenchError(405,'记忆概览需要 GET 请求。');
          return json(res,200,life.memoryOverview(id,{moduleId,conversationId,subjectKey:url.searchParams.get('subjectKey')??undefined}));
        }
        if(action==='vision/status'||action==='memes/catalog'){
          if(req.method!=='GET')throw new WorkbenchError(405,'媒体状态需要 GET 请求。');
          return json(res,200,action==='vision/status'?await life.visionStatus(id):life.memeCatalog(id));
        }
        if(req.method!=='POST')throw new WorkbenchError(405,'角色系统操作需要 POST 请求。');
        const value=await body(req);
        if(value.moduleId!==undefined&&!['qq','companion','companion-lite','character-lite','character-full'].includes(value.moduleId))throw new WorkbenchError(400,'人设运行范围无效。');
        let result;
        if(action==='vision/test')result=await life.visionTest(id,value);
        else if(action==='memory/summary')result=life.saveMemorySummary(id,{moduleId,...value});
        else if(action==='memory/organize'){fields(value,['moduleId','conversationId','retry']);if(value.retry!==undefined&&typeof value.retry!=='boolean')throw new WorkbenchError(400,'重试选项必须是布尔值。');result=life.organizeMemoryHistory(id,{moduleId,...value,retry:value.retry??true});}
        else if(action==='settings')result=life.configure(id,value);
        else if(action==='profile'){result=life.saveProfile(id,value);await companion.syncCharacter();}
        else if(action==='state')result={state:life.saveState(id,value)};
        else if(action==='memories')result={memory:life.saveMemory(id,value)};
        else if(action==='memories/delete'){fields(value,['id']);result=life.deleteMemory(id,value.id);}
        else if(action==='expressions')result={expression:life.saveExpression(id,value)};
        else if(action==='expressions/delete'){fields(value,['id']);result=life.deleteExpression(id,value.id);}
        else if(action==='tools')result={tool:life.saveTool(id,value)};
        else if(action==='tools/delete'){fields(value,['id']);result=life.deleteTool(id,value.id);}
        else if(action==='diary')result={entry:life.saveDiary(id,value)};
        else if(action==='recall'){fields(value,['moduleId','conversationId','text']);result=await life.recall(id,{moduleId,...value});}
        else if(action==='preview')result=await life.preview(id,{moduleId,...value});
        else if(action==='simulate')result=await life.simulate(id,{moduleId,...value});
        else if(action==='actions'){fields(value,['id','operation']);result={action:await life.handleAction(id,value)};}
        else if(action==='scripts/preview'){
          if(!life.full(id,undefined,{moduleId}))throw new WorkbenchError(409,'当前范围不具备完整脚本能力。');
          result=await life.scriptPreview(id,value);
        }
        else if(action==='frame'){
          fields(value,['html']);if(typeof value.html!=='string'||value.html.length>500000)throw new WorkbenchError(400,'状态栏 HTML 无效或过大。');
          if(!life.full(id,undefined,{moduleId}))throw new WorkbenchError(409,'状态栏需要安装角色完整版并切换到完整模式。');
          if(!life.config(id).runtime.scriptsEnabled)throw new WorkbenchError(409,'请先启用此角色的脚本。');
          for(const [key,frame] of characterFrames)if(Date.now()>frame.expiresAt)characterFrames.delete(key);
          if(characterFrames.size>=30)characterFrames.delete(characterFrames.keys().next().value);
          const token=randomBytes(24).toString('hex');characterFrames.set(token,{characterId:id,configRevision:life.configRevision(id),html:value.html,expiresAt:Date.now()+600000});result={url:'/internal/character-frames/'+token};
        }
        return json(res,200,result);
      }
      if(pathname==='/api/user-profile'){
        if(req.method==='GET')return json(res,200,{profile:userProfile()});
        if(req.method!=='POST')throw new WorkbenchError(405,'用户资料需要 GET 或 POST 请求。');
        const profile=saveUserProfile(profileStore,await body(req,6*1024*1024));
        await profileChanged();
        return json(res,200,{profile});
      }
      if(pathname==='/api/characters/deleted'){
        if(req.method!=='GET')throw new WorkbenchError(405,'已删除角色需要 GET 请求。');
        return json(res,200,{characters:store.deletedCharacters()});
      }
      const characterDeletion=pathname.match(/^\/api\/characters\/([^/]+)(?:\/(restore))?$/);
      if(characterDeletion&&(req.method==='DELETE'||characterDeletion[2]==='restore')){
        if(store.getSetting('instance.identity'))throw new WorkbenchError(409,'请在角色资料中删除或恢复角色；模块中的人设副本分别保留。');
        const id=identifier(characterDeletion[1],'角色标识');
        if(characterDeletion[2]==='restore'){
          if(req.method!=='POST')throw new WorkbenchError(405,'恢复角色需要 POST 请求。');fields(await body(req),[]);
          return json(res,200,{character:store.restoreCharacter(id)});
        }
        life.memoryOrganizer.cancel({id});const result=store.archiveCharacter(id);await companion.syncCharacter();return json(res,200,result);
      }
      const characterReferenceRoute=pathname.match(/^\/api\/characters\/([^/]+)\/resource-references$/);
      if(characterReferenceRoute){
        if(req.method!=='POST')throw new WorkbenchError(405,'关联角色资源需要 POST 请求。');
        const value=await body(req);
        if(value.kind==='audio'&&!voiceStudio.state().voices?.some(item=>item.id===value.voiceId))throw new WorkbenchError(400,'请选择已保存的角色语音。');
        return json(res,201,{resource:await characterResources.addReference(identifier(characterReferenceRoute[1],'角色标识'),value)});
      }
      const characterMigrationRoute=pathname.match(/^\/api\/characters\/([^/]+)\/resources-migrate$/);
      if(characterMigrationRoute){
        if(req.method!=='POST')throw new WorkbenchError(405,'整理旧版资源需要 POST 请求。');
        fields(await body(req),[]);profileStore.requireCharacter(identifier(characterMigrationRoute[1],'角色标识'));
        await characterResources.migrateLegacy();return json(res,200,{ok:true});
      }
      const characterResourceRoute=pathname.match(/^\/api\/characters\/([^/]+)\/resources(?:\/([^/]+)\/file)?$/);
      if(characterResourceRoute){
        const characterId=identifier(characterResourceRoute[1],'角色标识'),resourceId=characterResourceRoute[2];
        if(resourceId){
          if(req.method!=='GET')throw new WorkbenchError(405,'读取素材需要 GET 请求。');
          const resource=await characterResources.file(characterId,resourceId);
          if(url.searchParams.get('download')==='1'||resource.mime==='application/octet-stream')res.setHeader('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`);
          if(resource.path){
            const {createReadStream}=await import('node:fs');
            const stream=createReadStream(resource.path);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());
            res.writeHead(200,{'content-type':resource.mime,'content-length':resource.bytesLength,'cache-control':'no-store'});return stream.pipe(res);
          }
          res.writeHead(200,{'content-type':resource.mime,'content-length':resource.bytes.length,'cache-control':'no-store'});return res.end(resource.bytes);
        }
        if(req.method==='GET')return json(res,200,{resources:characterResources.list(characterId)});
        if(req.method!=='POST')throw new WorkbenchError(405,'角色素材需要 GET 或 POST 请求。');
        const value=await body(req,Math.ceil(MAX_CHARACTER_RESOURCE_BYTES/3)*4+128*1024),identity=store.getSetting('instance.identity');
        if(identity){value.sourceModuleId=identity.moduleId;value.sourceInstanceId=identity.id;}
        else if(value.sourceInstanceId&&instanceManager){const source=instanceManager.record(value.sourceInstanceId);if(value.sourceModuleId&&value.sourceModuleId!==source.moduleId)throw new WorkbenchError(400,'素材来源与模块实例不一致。');value.sourceModuleId=source.moduleId;}
        return json(res,201,{resource:await characterResources.add(characterId,value)});
      }
      const avatarRoute=pathname.match(/^\/api\/characters\/([^/]+)\/avatar$/);
      if(avatarRoute){
        if(req.method!=='POST')throw new WorkbenchError(405,'设置头像需要 POST 请求。');
        const value=await body(req,6*1024*1024);fields(value,['avatar']);
        const character=store.setCharacterAvatar(identifier(avatarRoute[1],'角色标识'),value.avatar);
        if(store.getSetting('selectedCharacterId')===character.id)await companion.syncCharacter();
        return json(res,200,{character});
      }
      if(pathname==='/api/characters/import-file'){
        if(req.method!=='POST')throw new WorkbenchError(405,'导入角色卡需要 POST 请求。');
        const value=await body(req,12*1024*1024);fields(value,['name','base64']);const document=await parseCharacterFile(value);return json(res,200,{character:store.saveCharacter(importedCharacter({document}),true)});
      }
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, { ...store.state(), ...(legacyMigrated()?{selectedCharacterId:null}:{}), tasks: [...installations.tasks(), ...drawing.jobs().filter(job=>['submitting','queued','running','unknown'].includes(job.status)).map(job=>({...job,moduleId:'drawing',kind:'generation'})),...mcSkin.jobs().filter(job=>['queued','designing','rendering'].includes(job.status)).map(job=>({...job,moduleId:'mc-skin',kind:'skin-generation'}))] });
      const moduleGuideRoute = pathname.match(/^\/api\/module-guides\/([^/]+)$/);
      if (moduleGuideRoute) {
        const { id } = knownModule(moduleGuideRoute[1]);
        if (req.method !== 'POST') throw new WorkbenchError(405, '此接口需要 POST 请求。');
        fields(await body(req), []);
        return json(res, 200, store.markModuleGuideSeen(id));
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        const moduleId = url.searchParams.get('moduleId') ?? undefined;
        if (moduleId !== undefined) knownModule(moduleId);
        return json(res, 200, { events: store.events(moduleId) });
      }
      const exportRoute = pathname.match(/^\/api\/characters\/([^/]+)\/export$/);
      if (req.method === 'GET' && exportRoute) return json(res, 200, store.exportCharacter(identifier(exportRoute[1], '角色标识')));
      const packageRoute=pathname.match(/^\/api\/modules\/([^/]+)\/package$/);
      if(packageRoute){
        const {id}=knownModule(packageRoute[1]);
        if(req.method==='POST'){
          const value=await body(req);fields(value,['package','planId']);validateCharacterPackage(id,value.package);
          const result=installations.install(id,{planId:value.planId,optionalIds:[]});characterPackages.invalidate();return json(res,200,result);
        }
        if(req.method!=='GET')throw new WorkbenchError(405,'安装包导出需要 GET 请求，导入安装需要 POST 请求。');
        res.setHeader('content-disposition',`attachment; filename="${id}-1.0.0.workbench-package.json"`);
        return json(res,200,exportCharacterPackage(id));
      }
      const resourceRoute = pathname.match(/^\/api\/modules\/([^/]+)\/resources(?:\/(selection|plan|install|cancel|choose-directory))?$/);
      if (resourceRoute) {
        const { id } = knownModule(resourceRoute[1]);
        const action = resourceRoute[2];
        const method = !action ? 'GET' : action === 'selection' ? 'PUT' : 'POST';
        if (req.method !== method) throw new WorkbenchError(405, '此接口不支持这个请求方法。');
        if (!action) return json(res, 200, installations.state(id));
        const value = await body(req);
        const result = action === 'selection' ? installations.select(id, value) : await installations[action === 'choose-directory' ? 'chooseDirectory' : action](id, value);
        if(['character-lite','character-full','companion-lite','companion'].includes(id)&&['install','choose-directory'].includes(action))characterPackages.invalidate();
        return json(res, 200, result);
      }
      const moduleRoute = pathname.match(/^\/api\/modules\/([^/]+)\/(enable|disable|open|config|check-paths)$/);
      if (moduleRoute) {
        const definition = knownModule(moduleRoute[1]);
        const action = moduleRoute[2];
        if (req.method !== (action === 'config' ? 'PUT' : 'POST')) throw new WorkbenchError(405, '此接口不支持这个请求方法。');
        const value = await body(req);
        if (action === 'config') {
          if (['drawing','comfyui'].includes(definition.id)) {
            fields(value, ['values','runtimeSettings']);
            const values = configValues(definition, {values:value.values});
            if (Object.hasOwn(value, 'runtimeSettings')) {
              fields(value.runtimeSettings, ['pythonPath'], '启动设置');
              const runtimeSettings = validateRuntimeSettings(value.runtimeSettings, drawing.runtime.settings(), store.getSetting('drawing.capabilities'));
              drawing.runtime.ensureOpen();
              store.saveDrawingConfiguration(values, runtimeSettings);
              drawing.runtime.settingsRevision++;
              const { config, checks } = store.module(definition.id);
              return json(res, 200, {ok:true, config, checks, runtimeSettings});
            }
          }
          store.saveConfig(definition.id, configValues(definition, value));
          const { config, checks } = store.module(definition.id);
          return json(res, 200, { ok: true, config, checks });
        }
        else {
          fields(value, []);
          if (action === 'enable' || action === 'disable') {
            await setModuleEnabled(definition.id,action==='enable');
          }
          else if (action === 'open') store.openModule(definition.id);
          else return json(res, 200, await checkPaths(store, definition));
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        const value = await body(req);
        switch (pathname) {
          case '/api/preferences':
            fields(value, ['theme']);
            if (!['light', 'dark'].includes(value.theme)) throw new WorkbenchError(400, '主题必须是 light 或 dark。');
            store.setSetting('preferences', { theme: value.theme });
            break;
          case '/api/characters': {
            const character=store.saveCharacter(newCharacter(value));
            if(store.state().selectedCharacterId===character.id)await companion.syncCharacter();
            return json(res,200,{character});
          }
          case '/api/characters/import': return json(res, 200, { character: store.saveCharacter(importedCharacter(value), true) });
          case '/api/characters/select':
            fields(value, ['id']);
            store.selectCharacter(value.id === null ? null : identifier(value.id, '角色标识'));
            await companion.syncCharacter();
            break;
          case '/api/events': {
            const event = publicEvent(value);
            if (event.characterId !== null) store.requireCharacter(event.characterId);
            if (event.kind === 'module.loaded' && !store.module(event.moduleId).enabled) throw new WorkbenchError(409, '已停用的模块不能报告加载成功。');
            store.event(event);
            break;
          }
          default: throw new WorkbenchError(404, '找不到这个接口。');
        }
        return json(res, 200, { ok: true });
      }
      if (pathname.startsWith('/api/')) throw new WorkbenchError(404, '找不到这个接口。');
      if (!['GET', 'HEAD'].includes(req.method)) throw new WorkbenchError(405, '此路径不支持这个请求方法。');
      await staticFile(req, res, pathname, resolve(staticDir));
    } catch (error) {
      req.resume();
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      json(res, error instanceof WorkbenchError ? error.status : 500, { error: error instanceof WorkbenchError ? error.message : '本地服务处理失败，请稍后重试。' });
    }finally{if(legacyMutation)legacyMutations--;}
  }

  const server = createServer((req, res) => {
    const task = handle(req, res);
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    instanceManager?.acquireLock();
    await characterPackages.prepareEnabled();
    visionExtension=visionOptions.controller??new (await import('./vision-extension.mjs')).VisionExtension({...visionOptions,store:profileStore,dataDir:sharedResourceDirectory??resolve(dataDir),chooseDirectory});
    await visionExtension.initialized;
    resourceStorage=new ResourceStorage({dataDir:sharedResourceDirectory??resolve(dataDir),store:profileStore,voiceResources,voiceStudio,visionExtension,qqRuntime:()=>[qqRuntime,...[...(instanceManager?.runtimes.values()||[])].map(runtime=>runtime.context?.getQQRuntime?.())].filter(Boolean)});
    await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,host,resolveListen);});
  } catch(error) {
    await instanceManager?.close();
    try{if(ownsVisionExtension)await visionExtension?.close();}
    finally{if(ownsVoiceStudio){await voiceStudio.close();await voiceResources.close();}await voice.close();await life.close();await drawing.close();await mcSkin.close();sharedAI.close();store.close();}
    throw error;
  }
  expectedHost = `${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  appUrl = publicBaseUrl || `http://${expectedHost}`;
  life.start(async value=>{
    if(!store.module(value.moduleId)?.enabled)return {delivered:false,status:'skipped',reason:'模块已移除。'};
    if(value.moduleId==='qq')return qq?qq.deliver(value):{delivered:false,status:'skipped',reason:'QQ 尚未连接。'};
    if(value.moduleId==='companion')return companion.deliver(value);
    return {delivered:false,status:'skipped',reason:'当前平台没有发送适配器。'};
  },value=>{
    if(!store.module(value.moduleId)?.enabled)return false;
    if(value.moduleId==='qq'){const state=qq?.state();return !!state&&!state.paused&&state.transport.status==='verified'&&state.binding?.characterId===value.characterId;}
    if(value.moduleId==='companion')return companion.status==='running'&&companion.character()?.id===value.characterId;
    return false;
  },value=>{
    if(value.moduleId==='qq'){const binding=qq?.binding;return binding?.characterId===value.characterId?{id:binding.characterId,revision:binding.revision,name:binding.name,description:binding.description,raw:binding.raw}:null;}
    return companion.character()?.id===value.characterId?companion.character():null;
  });
  if(legacyMigrated())stopLegacyScheduler();
  await writeFile(join(resolve(dataDir),'mcp-connection.json'),JSON.stringify({url:appUrl+'/mcp',token:sharedAI.mcpToken}),{encoding:'utf8',mode:0o600});
  return {
    url: `http://${expectedHost}`,
    context:mcpContext,
    async close({stopQQ=false}={}) {
      // 显式停止失败时保留管理接口，允许重试；成功后再进入不可逆的整体关闭。
      if(stopQQ&&!closed&&store.module('qq').enabled){ensureQQ();await qq.disconnect({stopRuntime:true});}
      if(ownsVisionExtension&&!closed)await visionExtension.close();
      if (!closed) closed = (async () => {
        await resourceStorage?.close();
        await instanceManager?.close();
        await environment.close();
        pathPicker.close();
        drawingStartup?.close();
        const stopped = new Promise(resolveClose => server.close(resolveClose));
        server.closeAllConnections();
        const cancelled = installations.close();
        const studioStopped = cardStudio.close();
        await drawingCompletion.close();
        await drawingManager.close();
        await drawing.close();
        await minecraft.close();
        await mcSkin.close();
        if(trainingPending)await trainingPending.catch(()=>{});
        if(training)await training.close();
        if(qq)await qq.close();else if(qqRuntime)await qqRuntime.close();
        await companion.close();
        liteCompanion.close();
        sharedAI.close();
        if(ownsVoiceStudio){await voiceStudio.close();await voiceResources.close();}
        await voice.close();
        await life.close();characterFrames.clear();
        await Promise.allSettled([...pending]);
        await stopped;
        await cancelled;
        await studioStopped;
        if(!componentOptions.controller)await components.close();
        store.close();
      })();
      return closed;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createWorkbench({ dataDir: process.env.AI_FUTURE_WORKBENCH_DATA_DIR || join(root, 'data-workbench'), port: Number(process.env.PORT || 17881) });
  console.log(`小念的创作笔记：${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
