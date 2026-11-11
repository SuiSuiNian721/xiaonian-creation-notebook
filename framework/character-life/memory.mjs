export function tokens(value){
  const text=String(value).toLocaleLowerCase('zh-CN');
  const terms=text.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu)??[];
  return new Set(terms.flatMap(term=>/\p{Script=Han}/u.test(term)?[...term,...Array.from({length:Math.max(0,term.length-1)},(_,i)=>term.slice(i,i+2))]:[term]));
}
export function cosine(a,b){
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||!a.length)return 0;
  let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa&&bb?dot/Math.sqrt(aa*bb):0;
}
export function recallMemories(memories,{query,scope,sharing,allowed,limit=8,halfLifeDays=90,now=Date.now(),vector}){
  const terms=tokens(query);
  const candidates=memories.filter(m=>m.status!=='archived'&&(!m.expiresAt||Date.parse(m.expiresAt)>now)&&(!m.layerVersion||m.category!=='plan'||m.planStatus==='pending')&&(allowed?allowed(m):sharing==='character'||m.scope==='shared'||m.scope===scope));
  const scored=candidates.map(m=>{
    const words=tokens([m.content,...(m.entities??[]),...(m.relations??[]).flatMap(r=>[r.from,r.to,r.label])].join(' '));
    const overlap=[...terms].filter(term=>words.has(term)).length;
    const lexical=terms.size?overlap/Math.sqrt(terms.size*Math.max(1,words.size)):0;
    const semantic=Math.max(0,cosine(vector,m.embedding));
    const age=Math.max(0,now-Date.parse(m.lastAccessAt??m.updatedAt))/86400000;
    const stable=m.layerVersion&&m.category==='trait'&&m.reality==='real'&&m.confidence==='explicit',pending=m.layerVersion&&m.category==='plan'&&m.planStatus==='pending';
    const decay=stable?1:2**(-age/halfLifeDays);
    return {...m,score:(lexical*2+semantic+(m.pinned?2:0)+(stable?0.35:pending?0.15:0))*(m.pinned?1:decay),retrieval:{lexical,semantic,decay,graph:[]}};
  });
  // 只在已获授权的候选中做一跳关系扩展，不能借相同实体穿透会话隔离。
  const entities=m=>new Set([...(m.entities??[]),...(m.relations??[]).flatMap(r=>[r.from,r.to])]);
  const index=new Map();
  for(const memory of scored)for(const entity of entities(memory)){const records=index.get(entity)??[];records.push(memory);index.set(entity,records);}
  const seeds=scored.filter(m=>m.retrieval.lexical>0.05||m.retrieval.semantic>0.6).sort((a,b)=>b.score-a.score).slice(0,5).map(m=>({id:m.id,score:m.score,entities:entities(m)}));
  for(const seed of seeds)for(const entity of seed.entities)for(const memory of index.get(entity)??[]){
    if(memory.id===seed.id||memory.retrieval.graph.includes(seed.id))continue;
    memory.retrieval.graph.push(seed.id);memory.score+=Math.min(0.4,seed.score*0.25)*memory.retrieval.decay;
  }
  let characters=0,traits=0,plans=0;
  const ranked=scored.filter(m=>m.score>0.02).sort((a,b)=>b.score-a.score||b.updatedAt.localeCompare(a.updatedAt));
  const reserved=ranked.filter(m=>m.layerVersion&&m.category==='trait'&&m.reality==='real'&&m.confidence==='explicit').slice(0,Math.min(4,limit)),reservedIds=new Set(reserved.map(m=>m.id));
  return [...reserved,...ranked.filter(m=>!reservedIds.has(m.id))].filter(m=>{
    const trait=m.layerVersion&&m.category==='trait',plan=m.layerVersion&&m.category==='plan',size=m.content.length+(m.sourceQuote?.length??0);
    if(characters+size>16000||trait&&traits>=8||plan&&plans>=3)return false;
    characters+=size;if(trait)traits++;if(plan)plans++;return true;
  }).slice(0,limit);
}
