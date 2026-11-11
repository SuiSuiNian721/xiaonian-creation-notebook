import {naturalCaptionTypes} from './training-types.js';
import {taggerModels,taggerModelOptions} from './training-tagger-options.js';

export const captionerOptions=[{value:'florence2',label:'Florence-2 · 自然语言'},...taggerModelOptions];
export function resolveCaptioner({captioner='auto',modelTrainType,taggerModel='wd14-convnextv2-v2',captionFormat='auto'}={}){
  if(!['auto','florence2',...taggerModels].includes(captioner))throw new Error('打标器无效。');
  const format=captioner==='florence2'?'natural':captioner!=='auto'?'tags':captionFormat==='auto'?(naturalCaptionTypes.has(modelTrainType)?'natural':'tags'):captionFormat;
  if(!['tags','natural'].includes(format))throw new Error('打标格式无效。');
  const id=captioner!=='auto'?captioner:format==='natural'?'florence2':taggerModels.includes(taggerModel)?taggerModel:'wd14-convnextv2-v2';
  return {id,label:captionerOptions.find(option=>option.value===id).label,format,automatic:captioner==='auto'};
}
