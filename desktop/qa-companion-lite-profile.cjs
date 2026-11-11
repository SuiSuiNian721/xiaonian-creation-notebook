const {app,BrowserWindow,nativeImage}=require('electron');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {readFileSync,mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {join,resolve,sep,extname}=require('node:path');
const {tmpdir}=require('node:os');

const publicDir=resolve(__dirname,'../public-workbench'),output=resolve(__dirname,'../artifacts/companion-lite-profile');
app.setPath('userData',mkdtempSync(join(tmpdir(),'companion-lite-profile-')));mkdirSync(output,{recursive:true});
const report={checks:[],errors:[]};let server,window;
const js=code=>window.webContents.executeJavaScript(code,true);
const wait=async(label,expression)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await js(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('等待超时：'+label);};
const timeout=setTimeout(()=>{report.errors.push('精简陪伴头像验收超时');writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2),'utf8');app.exit(1);},30000);

app.whenReady().then(async()=>{
  server=createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/character-packages.css"></head><body><main id="fixture" style="padding:30px"></main></body></html>');return;}
    const file=resolve(publicDir,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(publicDir+sep)){res.writeHead(404).end();return;}
    try{res.setHeader('content-type',extname(file)==='.js'?'text/javascript':'text/css');res.end(readFileSync(file));}catch{res.writeHead(404).end();}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:new URL(details.url).hostname!=='127.0.0.1'}));
  await window.loadURL('http://127.0.0.1:'+server.address().port);
  const avatar=nativeImage.createFromBitmap(Buffer.from(Array.from({length:32*32},()=>[152,89,195,255]).flat()),{width:32,height:32}).toDataURL();
  await js(`(async()=>{
    const {mount}=await import('/modules/companion-lite.js');
    globalThis.fixtureController=new AbortController();globalThis.fixtureDraft={text:'未发送草稿'};
    const character={id:'lite-fixture',name:'小汐',avatar:${JSON.stringify(avatar)}};
    const ctx={signal:fixtureController.signal,state:{modules:[{id:'companion-lite',name:'虚拟陪伴·精简版',description:''}]},characters:{getSelected:()=>character},drafts:{read:()=>fixtureDraft,write:(_key,value)=>{fixtureDraft=value;},commit:()=>{}},api:async path=>path.endsWith('/resources')?{prerequisitesReady:true}:{character,userProfile:{displayName:'念念',avatar:${JSON.stringify(avatar)}},messages:[{role:'user',content:'你好，小汐。'},{role:'assistant',content:'你好，念念。'}]},immersion:{enter:()=>{}},action:()=>{},disableModule:()=>{},navigate:()=>{}};
    await mount(document.querySelector('#fixture'),ctx);
  })()`);
  await wait('双方图片',`document.querySelectorAll('.lite-avatar img').length===2&&[...document.querySelectorAll('.lite-avatar img')].every(image=>image.complete&&image.naturalWidth>0)`);
  assert.deepEqual(await js(`[...document.querySelectorAll('.lite-message strong')].map(node=>node.textContent)`),['念念','小汐']);report.checks.push('精简聊天显示双方姓名和可解码头像');
  await js(`window.dispatchEvent(new CustomEvent('workbench:user-profile-changed',{detail:{displayName:'新名字',avatar:''}}))`);
  assert.equal(await js(`document.querySelector('.from-user .lite-avatar').textContent`),'新名');
  assert.equal(await js(`document.querySelector('#lite-message').value`),'未发送草稿');report.checks.push('资料实时更新、清空头像回退文字，并保留草稿');
  await js(`window.dispatchEvent(new CustomEvent('workbench:character-avatar-changed',{detail:{character:{id:'another',name:'其他角色',avatar:''}}}))`);
  assert.equal(await js(`document.querySelector('.from-character strong').textContent`),'小汐');
  await js(`window.dispatchEvent(new CustomEvent('workbench:character-avatar-changed',{detail:{character:{id:'lite-fixture',name:'小汐',avatar:''}}}))`);
  assert.equal(await js(`document.querySelector('.from-character .lite-avatar').textContent`),'小汐');report.checks.push('角色头像事件按角色标识过滤，当前角色清除头像即时生效');
  await js(`window.dispatchEvent(new CustomEvent('workbench:user-profile-changed',{detail:{displayName:'',avatar:''}}))`);
  assert.equal(await js(`document.querySelector('.from-user strong').textContent`),'我');
  window.webContents.invalidate();await new Promise(r=>setTimeout(r,200));writeFileSync(join(output,'lite-profile.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  await js(`fixtureController.abort();window.dispatchEvent(new CustomEvent('workbench:user-profile-changed',{detail:{displayName:'不得刷新'}}))`);
  assert.equal(await js(`document.querySelector('.from-user strong').textContent`),'我');report.checks.push('空用户名回退；页面卸载后移除资料事件监听');report.ok=true;
}).catch(error=>{report.ok=false;report.errors.push(error.stack);}).finally(async()=>{clearTimeout(timeout);window?.destroy();await new Promise(r=>server?server.close(r):r());writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report));app.exit(report.ok?0:1);});
