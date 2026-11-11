export const moduleFamilyId=(modules,id)=>modules.find(module=>module.id===id)?.familyId||id;

export function moduleVariants(modules,id){
  const familyId=moduleFamilyId(modules,id);
  return modules.filter(module=>module.familyId===familyId&&module.variant).sort((a,b)=>Number(a.variant==='full')-Number(b.variant==='full'));
}

export function workspaceModules(modules){
  const families=new Map();
  for(const module of modules){
    if(module.librarySection)continue;
    const familyId=module.familyId||module.id;
    if(families.has(familyId))continue;
    const members=modules.filter(item=>(item.familyId||item.id)===familyId);
    const definition=members.find(item=>item.id===familyId)||module;
    const recent=members.map(item=>item.lastOpenedAt).filter(Boolean).sort().at(-1)||null;
    families.set(familyId,{...definition,enabled:members.some(item=>item.enabled),lastOpenedAt:recent});
  }
  return [...families.values()];
}

export const defaultInstanceModule=(modules,id)=>moduleVariants(modules,id).find(module=>module.variant==='lite')?.id||id;
