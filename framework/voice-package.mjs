import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../resources/voice/moss-components.json',import.meta.url),'utf8'));

function freeze(value) {
  if(value && typeof value==='object') { Object.values(value).forEach(freeze);Object.freeze(value); }
  return value;
}

// URL 和版本由仓库清单决定，HTTP 请求只能选择组件 ID。
export const VOICE_PACKAGE = freeze({
  models:Object.fromEntries(Object.entries(manifest.models).map(([id,model])=>[id,{
    ...model,files:model.files.map(file=>({...file,url:`https://huggingface.co/${model.repository}/resolve/${model.revision}/${file.filename}`})),
    downloadBytes:model.files.reduce((sum,file)=>sum+file.bytes,0),
  }])),
  runtime:manifest.runtime,
});
