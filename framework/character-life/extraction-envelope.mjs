const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fieldTypes={memories:Array.isArray,summary:value=>typeof value==='string',expressions:Array.isArray,state:object,diary:value=>typeof value==='string',variableEvents:Array.isArray};

// 错误响应不是“没有事实”。候选的逐条校验由各接收器负责，避免一条坏候选拖掉整批。
export function validExtractionEnvelope(value,{full=false}={}){
  if(!object(value))return false;
  if(value.error&&(typeof value.error!=='string'||value.error.trim()))return false;
  const present=Object.keys(fieldTypes).filter(key=>Object.hasOwn(value,key));
  if(present.some(key=>!fieldTypes[key](value[key])))return false;
  return present.some(key=>full||key==='memories'||key==='summary');
}
