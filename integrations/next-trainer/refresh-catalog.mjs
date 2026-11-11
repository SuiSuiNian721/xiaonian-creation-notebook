// Run only after explicitly updating the checked-in Next Trainer source snapshot.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifestText=await readFile(join(root,'source-manifest.json'),'utf8'),manifest=JSON.parse(manifestText);
const newline=manifestText.includes('\r\n')?'\r\n':'\n';
const adaptedSources=['mikazuki/engines/workbench_paths.py','mikazuki/engines/anima_fast/environment.py','mikazuki/engines/musubi/environment.py','mikazuki/engines/ai_toolkit/environment.py'];
for(const path of ['frontend/src/training/modules.ts','frontend/src/api/engines.ts',...adaptedSources]){
  if(!manifest.files.some(file=>file.path===path))manifest.files.push({path});
}
for(const path of adaptedSources)if(!manifest.modifiedFiles.includes(path))manifest.modifiedFiles.push(path);
for(const file of manifest.files){const bytes=await readFile(join(root,'source',file.path));file.size=bytes.length;file.sha256=hash(bytes);}
manifest.kernelRevision=hash(JSON.stringify(manifest.files.map(file=>[file.path,file.size,file.sha256])));
await writeFile(join(root,'source-manifest.json'),(JSON.stringify(manifest,null,2)+'\n').replace(/\n/g,newline),'utf8');
const modules=await readFile(join(root,'source/frontend/src/training/modules.ts'),'utf8');
const catalogText=await readFile(join(root,'catalog.json'),'utf8'),catalog=JSON.parse(catalogText),catalogNewline=catalogText.includes('\r\n')?'\r\n':'\n';
const matrix=[...modules.matchAll(/\{ model: "([^"]+)", engine: "([^"]+)", target: "([^"]+)", schemaName: "([^"]+)"([^\n]*)/g)].map(([,family,engine,target,schema,rest])=>({family,engine,target,schema,trainType:rest.match(/model_train_type: "([^"]+)"/)?.[1]}));
catalog.matrix_revision=manifest.kernelRevision;
catalog.families=[...new Set(matrix.map(item=>item.family))];
const preferenceBlock=modules.match(/export const ENGINE_PREFERENCE[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1]||'';
catalog.engine_preference=Object.fromEntries([...preferenceBlock.matchAll(/(?:"([^"]+)"|(\w+)):\s*\[([^\]]+)\]/g)].map(([,quoted,key,engines])=>[quoted||key,[...engines.matchAll(/"([^"]+)"/g)].map(match=>match[1])]));
catalog.engines=['kohya','anima-fast','musubi','ai-toolkit','diffsynth','moss'].map(id=>({id,control_supported:true,source_bundled:id==='kohya'}));
for(const item of catalog.training_types){
  const match=matrix.find(module=>module.engine===item.engine&&(module.trainType?module.trainType===item.train_type:module.schema===item.schema_name));
  item.control_supported=Boolean(match)||['sd3-lora','anima-lora','flux-finetune'].includes(item.train_type);
  item.family=match?.family||item.variant;item.target=match?.target||(/finetune|dreambooth/.test(item.train_type)?'finetune':'lora');
  item.source_required=item.engine!=='kohya';item.supported=item.control_supported;
}
await writeFile(join(root,'catalog.json'),(JSON.stringify(catalog,null,2)+'\n').replace(/\n/g,catalogNewline),'utf8');
console.log(JSON.stringify({kernelRevision:manifest.kernelRevision,engines:catalog.engines.length,modules:matrix.length}));
