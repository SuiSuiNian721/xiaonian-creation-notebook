import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {discoverLocalEnvironments} from '../framework/environment-local.mjs';
import {createWorkbench} from '../framework/server.mjs';
import {EnvironmentDiscovery} from '../framework/environment.mjs';

async function fixture(t,cleanup=async()=>{}){
  const directory=await mkdtemp(join(tmpdir(),'environment-companion-'));
  t.after(async()=>{await cleanup();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return directory;
}
async function archive(directory,version='0.12.0-beta.5',name='ai.moeru.airi'){
  const source='import messages from "@proj-airi/i18n/locales";\nreturn env.SERVER_CHANNEL_PORT ? Number.parseInt(env.SERVER_CHANNEL_PORT) : 6121;\nasync function setupMainWindowElectronInvokes(params) {\n}\nsetupAutoUpdater({\n\t\t\tenabled: true,\n});\nconst hostService = await setupExtensionHostServiceInternal(options);\nconst mainWindow = injeca.provide("windows:main", {\n\t\tdependsOn: {\n';
  const entries={'package.json':JSON.stringify({name,version}),'out/renderer/index.html':'<html></html>','out/main/index.js':source};
  const header={files:{}},content=[];let offset=0;
  for(const [path,text] of Object.entries(entries)){
    const bytes=Buffer.from(text),parts=path.split('/');let node=header;
    for(const part of parts.slice(0,-1))node=(node.files[part]??={files:{}});
    node.files[parts.at(-1)]={size:bytes.length,offset:String(offset)};content.push(bytes);offset+=bytes.length;
  }
  const json=Buffer.from(JSON.stringify(header)),padded=Math.ceil(json.length/4)*4,prefix=Buffer.alloc(16);prefix.writeUInt32LE(4,0);prefix.writeUInt32LE(padded+8,4);prefix.writeUInt32LE(padded+4,8);prefix.writeUInt32LE(json.length,12);
  await mkdir(join(directory,'resources'),{recursive:true});const path=join(directory,'resources','app.asar');
  await writeFile(path,Buffer.concat([prefix,json,Buffer.alloc(padded-json.length),...content]));return path;
}

test('Electron 将 ASAR 映射为目录时，发现结果仍与实际启动检查一致',async t=>{
  const electron=[process.env.AI_FUTURE_ELECTRON,fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url)),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
  if(!electron){t.skip('当前环境未提供 Electron');return;}
  const root=await fixture(t),valid=join(root,'AIRI'),wrong=join(root,'old-AIRI'),broken=join(root,'broken-AIRI'),missing=join(root,'missing-AIRI');
  await archive(valid);await archive(wrong,'old-version');const brokenArchive=await archive(broken);await writeFile(brokenArchive,'broken archive');await mkdir(join(missing,'resources'),{recursive:true});
  const entry=join(root,'probe.cjs'),output=join(root,'result.json');
  await writeFile(entry,`const {app}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(join(root,'profile'))});
    (async()=>{const {inspectAiriInstall}=await import(${JSON.stringify(new URL('../framework/companion-source.mjs',import.meta.url).href)});const {discoverLocalEnvironments}=await import(${JSON.stringify(new URL('../framework/environment-local.mjs',import.meta.url).href)});
      const virtual=await require('node:fs/promises').lstat(${JSON.stringify(join(valid,'resources','app.asar'))});
      fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({virtualDirectory:virtual.isDirectory(),launch:inspectAiriInstall(${JSON.stringify(valid)}),scan:await discoverLocalEnvironments({moduleId:'companion',roots:${JSON.stringify([valid,wrong,broken,missing])},maxDepth:0})}));app.exit(0);
    })().catch(error=>{console.error(error);app.exit(1);});`,'utf8');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(electron,[entry],{env,windowsHide:true,timeout:20000});
  const result=JSON.parse(await readFile(output,'utf8'));
  assert.equal(result.virtualDirectory,true,'必须实际经过 Electron 的 ASAR 虚拟目录语义');assert.equal(result.launch.available,true);
  assert.deepEqual(result.scan.candidates.filter(item=>item.selectable).map(item=>item.values),[{airiPath:result.launch.installPath}]);
  assert.equal(result.scan.candidates.find(item=>item.path===wrong)?.selectable,false);
  assert.equal(result.scan.candidates.find(item=>item.path===broken)?.selectable,false);
  assert.ok(result.scan.issues.some(item=>item.path===missing&&item.status==='incomplete'));
});

test('普通 Electron 软件归档不被列成不兼容陪伴组件',async t=>{
  const root=await fixture(t),unrelated=join(root,'unrelated-electron');await archive(unrelated,'1.0.0','another.application');
  const result=await discoverLocalEnvironments({moduleId:'companion',roots:[root]});
  assert.deepEqual(result.candidates,[]);assert.deepEqual(result.issues,[]);
});

test('只有 AIRI 名称的前端素材目录不被误认成残缺安装',async t=>{
  const root=await fixture(t),assets=join(root,'resources','airi');await mkdir(join(assets,'assets'),{recursive:true});
  await writeFile(join(assets,'manifest.json'),JSON.stringify({version:'0.12.0-beta.5',component:'@proj-airi/stage-ui-three'}),'utf8');
  const result=await discoverLocalEnvironments({moduleId:'companion',roots:[root]});
  assert.deepEqual(result.candidates,[]);assert.deepEqual(result.issues,[]);
});

test('普通目录的权限错误只产生扫描提示，具有 AIRI 标识的路径保留权限诊断',async t=>{
  const root=await fixture(t),unrelated=join(root,'Adobe'),airi=join(root,'AIRI');await mkdir(unrelated);await mkdir(airi);
  const original=fs.lstat;
  try{
    fs.lstat=async path=>{if([join(unrelated,'resources'),join(airi,'resources')].includes(path))throw Object.assign(new Error('denied'),{code:'EACCES'});return original(path);};syncBuiltinESMExports();
    const result=await discoverLocalEnvironments({moduleId:'companion',roots:[root]});
    assert.deepEqual(result.candidates,[]);assert.equal(result.partial,true);
    assert.deepEqual(result.issues.map(item=>item.path),[airi]);assert.equal(result.issues[0].status,'unreadable');assert.equal('explicit' in result.issues[0],false);
  }finally{fs.lstat=original;syncBuiltinESMExports();}
});

test('用户明确指定普通错误目录时仍说明缺少陪伴运行归档',async t=>{
  const root=await fixture(t),selected=join(root,'selected-folder');await mkdir(selected);
  const discovery=new EnvironmentDiscovery({roots:[],env:{}});t.after(()=>discovery.close());
  const result=await discovery.scan({moduleId:'companion',directory:selected});
  assert.deepEqual(result.candidates,[]);assert.equal(result.issues[0]?.path,selected);
  assert.match(result.issues[0]?.detail||'',/resources\/app\.asar/);
  assert.equal('explicit' in result.issues[0],false);
});

test('选择安装目录的父目录扫描时，不把父目录误报成缺失陪伴组件',async t=>{
  const root=await fixture(t),valid=join(root,'AIRI');await archive(valid);
  const discovery=new EnvironmentDiscovery({roots:[],env:{}});t.after(()=>discovery.close());
  const result=await discovery.scan({moduleId:'companion',directory:root});
  assert.deepEqual(result.candidates.filter(item=>item.selectable).map(item=>item.path),[valid]);assert.deepEqual(result.issues,[]);
});

test('陪伴环境变量的错误安装路径独立诊断，普通提示路径不被提升为安装绑定',async t=>{
  const root=await fixture(t),valid=join(root,'AIRI'),selected=join(root,'configured-folder'),unrelated=join(root,'drawing-files');
  await archive(valid);await mkdir(selected);await mkdir(unrelated);
  const discovery=new EnvironmentDiscovery({roots:[valid],hints:()=>[unrelated],env:{AI_FUTURE_AIRI_PATH:selected}});t.after(()=>discovery.close());
  const result=await discovery.scan({moduleId:'companion'});
  assert.ok(result.candidates.some(item=>item.path===valid&&item.selectable));
  assert.match(result.issues.find(item=>item.path===selected)?.detail||'',/resources\/app\.asar/);
  assert.equal(result.issues.find(item=>item.path===selected)?.explicit,true);
  assert.ok(!result.issues.some(item=>item.path===unrelated));
});

test('已保存的陪伴错误目录直接返回诊断，缺失路径和其他应用归档也不能被默认可用安装掩盖',async t=>{
  let app;const root=await fixture(t,()=>app?.close()),valid=join(root,'AIRI'),empty=join(root,'configured-folder'),missing=join(root,'missing-folder'),wrong=join(root,'other-application'),unrelated=join(root,'drawing-files');
  await archive(valid);await mkdir(empty);await mkdir(unrelated);await archive(wrong,'1.0.0','another.application');
  app=await createWorkbench({dataDir:join(root,'profile'),instances:false,environmentOptions:{roots:[valid],env:{}}});
  const api=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  await api('/api/modules/companion/enable',{});await api('/api/modules/drawing/enable',{});
  await api('/api/modules/drawing/config',{values:{comfyPath:unrelated}},'PUT');
  for(const configured of [empty,missing,wrong]){
    await api('/api/modules/companion/config',{values:{airiPath:configured}},'PUT');
    const result=await api('/api/environment/scan',{moduleId:'companion',refresh:true});
    assert.ok(result.candidates.some(item=>item.path===valid&&item.selectable));
    assert.ok(!result.issues.some(item=>item.path===unrelated));
    if(configured===wrong){assert.equal(result.candidates.find(item=>item.path===wrong)?.selectable,false);assert.match(result.candidates.find(item=>item.path===wrong)?.reason||'',/不是 AIRI/);}
    else {assert.match(result.issues.find(item=>item.path===configured)?.detail||'',/resources\/app\.asar|安装目录/);assert.equal(result.issues.find(item=>item.path===configured)?.explicit,true);}
    assert.equal((await api('/api/state')).modules.find(item=>item.id==='companion').config.airiPath,configured);
  }
});

test('升级陪伴磁盘检测规则后忽略旧误报缓存，只重新检测一次并保留原路径配置',async t=>{
  const root=await fixture(t),valid=join(root,'AIRI');await archive(valid);
  const old={attempted:true,status:'completed',result:{candidates:[],issues:[{path:valid,status:'incomplete',detail:'缺少 resources/app.asar'}]}};
  const settings=new Map([['resource.discovery.environment.companion',structuredClone(old)],['environment.searchRoots.companion',[valid]]]);
  const store={getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,structuredClone(value))};let scans=0;
  const options={store,roots:[],env:{},scanLocal:async input=>{scans++;return discoverLocalEnvironments({...input,hints:[],maxDepth:0});}};
  const first=new EnvironmentDiscovery(options);t.after(()=>first.close());
  assert.equal(first.state({moduleId:'companion'}).attempted,false);assert.equal(first.state({moduleId:'companion'}).result,null);
  const result=await first.scan({moduleId:'companion'});assert.equal(result.candidates[0]?.selectable,true);assert.deepEqual(result.issues,[]);
  const reopened=new EnvironmentDiscovery(options);t.after(()=>reopened.close());
  assert.equal(reopened.state({moduleId:'companion'}).attempted,true);await reopened.scan({moduleId:'companion'});assert.equal(scans,1);
  assert.deepEqual(settings.get('environment.searchRoots.companion'),[valid]);assert.deepEqual(settings.get('resource.discovery.environment.companion'),old);
});

test('陪伴组件发现复用兼容安装检查，路径原样保留且扫描不改变原安装',async t=>{
  const root=await fixture(t),valid=join(root,'AIRI'),wrong=join(root,'old-AIRI');
  const path=await archive(valid);await archive(wrong,'old-version');const before=await readFile(path);
  const result=await discoverLocalEnvironments({moduleId:'companion',roots:[root]});
  assert.deepEqual(result.candidates.filter(item=>item.selectable).map(item=>item.values),[{airiPath:valid}]);
  assert.equal(result.candidates.find(item=>item.path===wrong)?.selectable,false);
  assert.match(result.candidates.find(item=>item.path===wrong)?.reason||'',/兼容|版本/);
  assert.deepEqual(await readFile(path),before);
  assert.ok(result.candidates.every(item=>!item.label.includes('AIRI')));
});

test('陪伴归档联接只报告尚未核实，不能采用或宣称版本不兼容',async t=>{
  const root=await fixture(t),outside=await archive(join(root,'outside')),install=join(root,'AIRI');
  await mkdir(install,{recursive:true});await symlink(join(root,'outside','resources'),join(install,'resources'),'junction');
  const result=await discoverLocalEnvironments({moduleId:'companion',roots:[install]});
  assert.deepEqual(result.candidates,[]);assert.equal(result.issues[0]?.status,'unreadable');
  assert.match(result.issues[0]?.detail||'',/尚未核实/);
});

test('陪伴发现使用配置路径并跨重启复用首次尝试，只允许手动刷新更新',async t=>{
  let scans=0,app,captured;const root=await fixture(t,()=>app?.close()),dataDir=join(root,'profile'),configured=join(root,'AIRI');
  const options={dataDir,instances:false,environmentOptions:{roots:[],scanLocal:async values=>{scans++;captured=values;return{candidates:[],warnings:[],partial:false};}}};
  const api=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  app=await createWorkbench(options);
  await api('/api/modules/companion/enable',{});await api('/api/modules/companion/config',{values:{airiPath:configured}},'PUT');
  assert.equal((await api('/api/environment/state?moduleId=companion')).attempted,false);assert.equal(scans,0);
  await api('/api/environment/scan',{moduleId:'companion'});assert.equal(scans,1);assert.ok(captured.hints.includes(configured));
  await app.close();app=await createWorkbench(options);
  assert.equal((await api('/api/environment/state?moduleId=companion')).attempted,true);
  await api('/api/environment/scan',{moduleId:'companion'});assert.equal(scans,1);
  await api('/api/environment/scan',{moduleId:'companion',refresh:true});assert.equal(scans,2);
});
