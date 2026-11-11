import assert from 'node:assert/strict';

// 只在各测试自己的临时 profile 安装真实本机策略包，不修改预览资料。
export async function installCharacterPackages(url,id='character-full'){
  const request=async(path,value)=>{
    const response=await fetch(url+path,{method:value===undefined?'GET':'POST',headers:value===undefined?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
  await request(`/api/modules/${id}/enable`,{});
  const base=`/api/modules/${id}/resources`,plan=await request(base+'/plan',{optionalIds:[]});
  if(!plan.canInstall){assert.ok(plan.resources.every(r=>r.status==='installed'));return request(base);}
  await request(base+'/install',{planId:plan.planId,optionalIds:[]});
  for(let i=0;i<200;i++){
    const state=await request(base);
    if(state.task?.status==='completed'){assert.equal(state.prerequisitesReady,true);return state;}
    assert.notEqual(state.task?.status,'failed',JSON.stringify(state));await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('本机角色包安装任务未结束');
}
