import {lstat,readFile,readdir} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {readableLocalPath} from './resource-local-path.mjs';

export const VOICE_MODEL_INSPECTION_VERSION=2;

export const VOICE_PROVIDERS=[
  {id:'moss',name:'MOSS',capabilities:['synthesis','clone','design'],models:[
    {id:'generator',name:'MOSS VoiceGenerator',capabilities:['design']},
    {id:'clone',name:'MOSS TTS Local Transformer',capabilities:['synthesis','clone']}]},
  {id:'qwen3-tts',name:'Qwen3-TTS',capabilities:['synthesis','clone','design'],models:[
    {id:'base',name:'Base',capabilities:['clone']},
    {id:'custom-voice',name:'CustomVoice',capabilities:['synthesis']},
    {id:'voice-design',name:'VoiceDesign',capabilities:['design']}]},
  {id:'http',name:'自定义 HTTP · OpenAI Speech',capabilities:['synthesis'],models:[]},
];

export const VOICE_PATH_FIELDS=['pythonPath','generatorPath','clonePath','codecPath','qwenPythonPath','qwenSourcePath','qwenBasePath','qwenCustomVoicePath','qwenDesignPath'];
export const VOICE_CONFIG_FIELDS=[...VOICE_PATH_FIELDS,'provider','httpUrl','httpModel','httpVoice','httpApiKey','searchRoots'];
export const voiceDefaults=()=>Object.fromEntries([...VOICE_PATH_FIELDS,...['httpUrl','httpModel','httpVoice','httpApiKey']].map(key=>[key,'']).concat([['provider','moss'],['searchRoots',[]]]));

async function info(path){try{return await lstat(await readableLocalPath(path));}catch{return null;}}
async function json(path){try{const actual=await readableLocalPath(path),file=await lstat(actual);return file.isFile()&&file.size<1024*1024?JSON.parse(await readFile(actual,'utf8')):null;}catch{return null;}}
async function entries(path){try{return await readdir(await readableLocalPath(path),{withFileTypes:true});}catch{return [];}}

function modelIdentity(config){
  if(!config||typeof config!=='object'||Array.isArray(config)||typeof config.model_type!=='string')return {status:'unrecognized',issue:'config.json 未声明可识别的声音模型架构。'};
  const type=config.model_type,provider=type==='qwen3_tts'?'qwen3-tts':['moss_tts_delay','moss-audio-tokenizer'].includes(type)?'moss':'unsupported';
  if(provider==='unsupported')return {provider,status:'unrecognized',issue:`模型类型 ${type} 不是已支持的声音模型。`};
  const architecture=type==='qwen3_tts'?'Qwen3TTSForConditionalGeneration':type==='moss-audio-tokenizer'?'MossAudioTokenizerModel':'MossTTSDelayModel';
  const declared=config.architectures,autoModel=config.auto_map?.AutoModel;
  if(declared!==undefined&&(!Array.isArray(declared)||!declared.includes(architecture))||declared===undefined&&!(typeof autoModel==='string'&&autoModel.endsWith('.'+architecture)))return {provider,status:'unrecognized',issue:`配置缺少 ${architecture} 架构依据。`};
  if(provider==='qwen3-tts'){
    const kind={base:'base',customvoice:'custom-voice',voicedesign:'voice-design'}[String(config.tts_model_type||'').toLowerCase().replace(/[_-]/g,'')];
    return kind?{provider,kind}:{provider,status:'unrecognized',issue:'config.json 未声明 Base、CustomVoice 或 VoiceDesign 用途。'};
  }
  if(type==='moss-audio-tokenizer')return {provider,kind:'codec'};
  const positive=value=>Number.isInteger(value)&&value>0;
  const generator=Number.isInteger(config.gen_token_id)&&config.gen_token_id>=0&&positive(config.audio_ch0_vocab_size)&&positive(config.n_vq);
  const localTransformer=positive(config.local_hidden_size)&&positive(config.local_num_layers)&&positive(config.n_vq);
  if(generator!==localTransformer)return {provider,kind:generator?'generator':'clone'};
  return {provider,status:'unrecognized',issue:'MOSS 配置未能明确区分 VoiceGenerator 与 Local-Transformer 用途。'};
}
export {modelIdentity as voiceModelIdentity};

/** Only metadata and directory entries: never hashes model weights or executes Python. */
export async function inspectVoiceModel(path,{provider='moss',kind}={}){
  if(!(await info(path))?.isDirectory())return {path,status:'missing',provider,kind,inspectionVersion:VOICE_MODEL_INSPECTION_VERSION,stale:false};
  const files=await entries(path),names=files.map(item=>item.name),config=await json(join(path,'config.json'));
  const identity=modelIdentity(config),base={path,provider,kind:kind||identity.kind,verification:'metadata',inspectionVersion:VOICE_MODEL_INSPECTION_VERSION,stale:false,detectedProvider:identity.provider,detectedKind:identity.kind};
  if(identity.provider&&identity.provider!==provider)return {...base,status:'incompatible',issue:`配置声明 ${identity.provider==='unsupported'?config.model_type:identity.provider}，不能绑定为 ${provider}。`};
  if(identity.status)return {...base,status:identity.status,issue:identity.issue};
  if(kind&&identity.kind!==kind)return {...base,status:'incompatible',issue:`配置声明 ${identity.kind}，不能绑定为 ${kind}。`};
  let weights=false;
  for(const file of files)if(/\.(safetensors|bin|pt|pth)$/i.test(file.name)){
    const weight=await info(join(path,file.name));if(weight?.isFile()&&weight.size>0){weights=true;break;}
  }
  const indexes=names.filter(name=>name.endsWith('.safetensors.index.json')||name.endsWith('.bin.index.json'));
  const missingShards=[];
  for(const name of indexes){
    const index=await json(join(path,name));
    if(!index?.weight_map||typeof index.weight_map!=='object'){missingShards.push(name);continue;}
    for(const shard of new Set(Object.values(index.weight_map))){
      const file=typeof shard==='string'&&basename(shard)===shard?await info(join(path,shard)):null;
      if(!file?.isFile()||!file.size)missingShards.push(String(shard));
    }
  }
  const ready=weights&&config&&typeof config==='object'&&!Array.isArray(config)&&!missingShards.length;
  return {...base,kind:identity.kind,status:ready?'available':'incomplete',
    ...(ready?{}:{issue:missingShards.length?'缺少模型分片：'+missingShards.slice(0,10).join('、'):'缺少 config.json 或本地模型权重。'}),files:names.filter(name=>name==='config.json'||/\.index\.json$/.test(name))};
}

export async function inspectVoiceEnvironment(path,provider,{sourcePath}={}){
  const result={path,provider,status:'missing',packages:{},issues:[],verification:'metadata',repairOptions:[]};
  if(!(await info(path))?.isFile())return result;
  const environment=dirname(dirname(path)),roots=[join(environment,'Lib','site-packages'),join(environment,'lib','python3.12','site-packages'),join(environment,'lib','python3.11','site-packages')];
  for(const root of roots)for(const item of await entries(root)){
    if(!item.isDirectory()||!item.name.endsWith('.dist-info'))continue;
    const metadata=join(root,item.name,'METADATA'),file=await info(metadata);if(!file?.isFile()||file.size>512*1024)continue;
    const content=await readFile(await readableLocalPath(metadata),'utf8'),name=content.match(/^Name:\s*(.+)$/mi)?.[1]?.trim().toLowerCase().replace(/_/g,'-'),version=content.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if(name&&version)result.packages[name]=version;
  }
  const requirements=provider==='qwen3-tts'?{'transformers':'4.57.3','qwen-tts':null,'torch':null,'soundfile':null,'scipy':null}: {'transformers':'>=5','torch':null,'torchaudio':null,'soundfile':null,'scipy':null};
  if(provider==='qwen3-tts'&&sourcePath&&(await info(join(sourcePath,'qwen_tts','__init__.py')))?.isFile())result.packages['qwen-tts']=result.packages['qwen-tts']||'local-source';
  for(const [name,required] of Object.entries(requirements)){
    const current=result.packages[name];
    if(!current)result.issues.push(`缺少 ${name} 的安装元数据`);
    else if(required==='>=5'?Number(current.split('.')[0])<5:required&&current!==required)result.issues.push(`${name} ${current} 与所需 ${required} 不兼容`);
  }
  result.status=result.issues.length?'incompatible':'available';
  if(result.issues.length)result.repairOptions=[
    {id:'repair-existing',label:'修复原环境',pythonPath:path,requiresConfirmation:true,packages:requirements},
    {id:'create-isolated',label:'新建隔离环境',provider,requiresConfirmation:true,packages:requirements},
  ];
  return result;
}

/** Bounded discovery: common roots plus user roots, at most 1200 directories and 4 levels. */
export async function discoverVoiceResources({roots=[],candidates={},signal}={}){
  const result={models:[],environments:[],installations:[],scannedRoots:[],warnings:[],inspectionVersion:VOICE_MODEL_INSPECTION_VERSION},seen=new Set(),visited=new Set(),queue=[];
  const add=path=>{if(path&&!seen.has(path.toLowerCase())){seen.add(path.toLowerCase());queue.push({path,depth:0});}};
  for(const path of roots)add(path);
  for(const [key,paths] of Object.entries(candidates))for(const path of paths||[])if(key!=='uvPath')add(path);
  for(let count=0;queue.length&&count<1200;count++){
    signal?.throwIfAborted();const {path,depth}=queue.shift();let actual;
    try{actual=await readableLocalPath(path);}catch{continue;}
    const identity=process.platform==='win32'?actual.toLowerCase():actual;if(visited.has(identity))continue;visited.add(identity);
    const stat=await lstat(actual);if(!stat)continue;
    if(depth===0)result.scannedRoots.push(path);
    if(stat.isFile()){
      if(/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(basename(path)))for(const provider of ['moss','qwen3-tts'])result.environments.push(await inspectVoiceEnvironment(path,provider));
      continue;
    }
    if(!stat.isDirectory())continue;
    const listing=await entries(path),names=listing.map(item=>item.name);
    if(names.includes('qwen_tts'))result.installations.push({provider:'qwen3-tts',path,status:'available'});
    if(names.includes('config.json')){
      const identity=modelIdentity(await json(join(path,'config.json')));
      if(['moss','qwen3-tts'].includes(identity.provider))result.models.push(await inspectVoiceModel(path,{provider:identity.provider}));
      continue;
    }
    if(depth>=4)continue;
    for(const item of listing.slice(0,200)){
      const next=join(path,item.name),target=item.isSymbolicLink()?await info(next):item;
      if((target?.isDirectory()&&!/^(?:node_modules|\.git|__pycache__|site-packages|downloads|logs)$/i.test(item.name))||(target?.isFile()&&/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(item.name))){
        if(!seen.has(next.toLowerCase())){seen.add(next.toLowerCase());queue.push({path:next,depth:depth+1});}
      }
    }
  }
  if(queue.length)result.warnings.push('已达到轻量扫描上限，请直接指定更具体的目录。');
  return result;
}
