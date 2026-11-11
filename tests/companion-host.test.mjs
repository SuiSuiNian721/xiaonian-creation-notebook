import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';

function fixture(){
  const require=createRequire(new URL('../desktop/companion-host.cjs',import.meta.url));
  const native={hide(){this.nativeVisible=false;},show(){this.nativeVisible=true;},getContentBounds(){return {width:450,height:600};}};
  const electron={BaseWindow:{prototype:native}};
  const module={exports:{}};
  const script=new Script('(function(require,module,__dirname){'+readFileSync(new URL('../desktop/companion-host.cjs',import.meta.url),'utf8')+'\n})');
  script.runInThisContext()(name=>name==='electron'?electron:require(name),module,fileURLToPath(new URL('../desktop',import.meta.url)));
  const root={isDestroyed:()=>false,contentView:{addChildView(){}},getContentBounds:()=>({width:1420,height:960})};
  const host=new module.exports.CompanionHost({getWindow:()=>root,qa:true});host.area={visible:true,x:0,y:0,width:500,height:500};
  const window=kind=>({kind,embedded:true,view:{visible:true,setVisible(value){this.visible=value;},setBounds(){}},webContents:{isDestroyed:()=>false,setBackgroundThrottling(){},insertCSS:async()=>'',removeInsertedCSS:async()=>{}},contentView:{addChildView(){}},isDestroyed:()=>false});
  return {host,window};
}

test('原生页面按请求顺序切换，较慢旧请求不能覆盖最后选择',async()=>{
  const {host}=fixture();
  host.bridge={controls:{settings:async()=>{await new Promise(resolve=>setTimeout(resolve,20));host.activeWindow={kind:'settings'};},stage:async()=>{host.activeWindow={kind:'stage'};}}};
  await Promise.all([host.open('settings'),host.open('stage')]);
  assert.equal(host.activeWindow.kind,'stage');
});

test('桌面角色不因打开嵌入聊天而隐藏',()=>{
  const {host,window}=fixture(),stage=window('stage'),chat=window('chat');
  host.activeWindow=stage;host.detach(stage);host.activate(chat);
  assert.equal(stage.embedded,false);assert.equal(stage.view.visible,true);assert.equal(host.activeWindow.kind,'chat');
});

test('未启动陪伴就关闭宿主，不会移除其他模块的信号监听',async()=>{
  const {host}=fixture(),listener=()=>{};
  process.on('SIGINT',listener);
  try{await host.close();assert.ok(process.listeners('SIGINT').includes(listener));}finally{process.removeListener('SIGINT',listener);}
});

test('隐藏宿主收到原生 show 不会弹出桌面窗口或获得焦点',()=>{
  const {host,window}=fixture(),stage=window('stage');
  host.qa=false;host.started=true;host.area.visible=false;
  stage.focus=()=>assert.fail('后台实例不能获得焦点');
  host.activate(stage);
  assert.equal(stage.embedded,true);assert.equal(stage.view.visible,false);assert.notEqual(stage.nativeVisible,true);
});

test('关闭 A 不删除 B 在 A 启动后注册的 SIGINT 监听',async()=>{
  const {host}=fixture();host.originalSignals=new Set(process.listeners('SIGINT'));
  const b=()=>{};process.on('SIGINT',b);
  try{await host.close();assert.ok(process.listeners('SIGINT').includes(b));}finally{process.removeListener('SIGINT',b);}
});

test('运行中用户资料同步更新现存窗口及后续窗口的启动资料',async()=>{
  const {host,window}=fixture(),received=[];
  host.bootstrap={userProfile:{displayName:'旧名字'}};
  for(const kind of ['stage','chat']){
    const native=window(kind);
    native.webContents.executeJavaScript=async source=>new Script(source).runInNewContext({window:{dispatchEvent:event=>received.push({kind,...event.detail})},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}}});
    host.windows.set(kind,native);
  }
  const profile={displayName:'新名字',avatar:'',identity:'',preferences:''};
  await host.syncUserProfile(profile);
  assert.deepEqual(host.bootstrap.userProfile,profile);
  assert.equal(received.length,2);assert.ok(received.every(value=>value.userProfile.displayName==='新名字'));
});
