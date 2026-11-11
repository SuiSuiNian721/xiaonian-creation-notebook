export function isSeedField(field){
  return field.type==='number'&&(field.presentation?.seed??/^(?:seed|noise_seed)$/.test(field.input));
}

// UI workflows keep seed mode next to the seed widget. API graphs do not carry it.
export function inferSeedMode(workflow,field){
  const node=workflow.document?.nodes?.find(item=>String(item.id)===String(field.nodeId));
  if(!node||!Array.isArray(node.widgets_values))return 'fixed';
  const widgets=node.widgets_values;
  let index;
  if(node.type==='KSampler'||node.type==='RandomNoise')index=0;
  else if(node.type==='KSamplerAdvanced'&&field.input==='noise_seed')index=1;
  else if(node.type==='TextGenerateQwen35MTP'){
    const matches=widgets.map((value,position)=>Object.is(value,field.value)?position:-1).filter(position=>position>=0);
    if(matches.length===1)index=matches[0];
  }
  return index!==undefined&&widgets[index+1]==='randomize'?'random':'fixed';
}

export function randomSeed(field,source=globalThis.crypto){
  const min=Math.max(-Number.MAX_SAFE_INTEGER,Math.ceil(field.min??0));
  const max=Math.min(Number.MAX_SAFE_INTEGER,Math.floor(field.max??Number.MAX_SAFE_INTEGER));
  if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min>max)throw new RangeError('此节点的种子范围无效，请重新检查工作流。');
  const start=BigInt(min),range=BigInt(max)-start+1n;
  if(range===1n)return min;
  const capacity=1n<<64n,limit=capacity-capacity%range,words=new Uint32Array(2);
  let candidate;
  do{source.getRandomValues(words);candidate=(BigInt(words[0])<<32n)|BigInt(words[1]);}while(candidate>=limit);
  return Number(start+candidate%range);
}
