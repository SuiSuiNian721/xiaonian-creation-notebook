import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {join} from 'node:path';

const require=createRequire(import.meta.url);let installWorkbenchDownloads;
try{({installWorkbenchDownloads}=require('../desktop/downloads.cjs'));}catch{}
const base='http://127.0.0.1:45678',instance='/instances/11111111-1111-4111-8111-111111111111';
function fixture(){
  assert.equal(typeof installWorkbenchDownloads,'function','桌面需提供统一原生导出配置');
  const session=new EventEmitter(),source={getURL:()=>base+'/',isDestroyed:()=>false};
  const dispose=installWorkbenchDownloads({session,getBaseURL:()=>base,getDownloadsPath:()=>join(process.cwd(),'downloads')});
  function item(url,name='作品.json'){
    const download=new EventEmitter();download.getURL=()=>url;download.getURLChain=()=>[url];download.getFilename=()=>name;
    download.setSaveDialogOptions=options=>{download.options=options;};download.setSavePath=()=>assert.fail('原生保存窗口不能被固定路径跳过');
    download.getSavePath=()=>download.savedPath;return download;
  }
  return {session,source,item,dispose};
}
test('工作台的 Blob、制卡、图片、日志和声音导出均由原生窗口选择路径',()=>{
  const f=fixture();
  for(const [url,name] of [
    [base+'/api/modules/drawing/images/result?download=1','角色.png'],
    [base+instance+'/api/modules/mc-skin/files/job/skin.png?download=1','skin.png'],
    [base+instance+'/api/characters/character/resources/resource/file?download=1','参考.wav'],
    [base+'/api/modules/character-lite/package','规则.json'],
    [base+instance+'/card-studio/api/artifact-file/测试?file=png&targetType=card','测试.png'],
    [base+instance+'/internal/voice-audio/'+'a'.repeat(64)+'/'+'b'.repeat(64),'试听.wav'],
    [base+instance+'/api/voice/voices/voice-11111111-1111-4111-8111-111111111111/audio','声线.wav'],
    ['blob:'+base+'/export-id','训练预设.toml'],
    ['blob:'+base+'/log-id','ComfyUI.log'],
  ]){
    const item=f.item(url,name);f.session.emit('will-download',{},item,f.source);
    assert.equal(item.options?.defaultPath,join(process.cwd(),'downloads',name),url);
    assert.match(item.options.title,/另存|导出/);assert.equal(item.options.buttonLabel,'保存');
    assert.equal(item.options.filters[0].extensions[0],name.split('.').at(-1));
  }
  f.source.getURL=()=>base+'/process-log.html';const log=f.item('blob:'+base+'/log','日志.log');f.session.emit('will-download',{},log,f.source);assert.ok(log.options);
  f.dispose();assert.equal(f.session.listenerCount('will-download'),0);
});
test('取消不会更改默认目录，成功保存后才记住该次选择，名称不可带出目录',()=>{
  const f=fixture(),first=f.item('blob:'+base+'/one','../目录\\作品.json');f.session.emit('will-download',{},first,f.source);
  assert.equal(first.options.defaultPath,join(process.cwd(),'downloads','.._目录_作品.json'));
  first.savedPath=join(process.cwd(),'cancelled','作品.json');first.emit('done',{},'cancelled');
  const next=f.item('blob:'+base+'/two');f.session.emit('will-download',{},next,f.source);assert.equal(next.options.defaultPath,join(process.cwd(),'downloads','作品.json'));
  next.savedPath=join(process.cwd(),'chosen','作品.json');next.emit('done',{},'completed');
  const last=f.item('blob:'+base+'/three','新作品.json');f.session.emit('will-download',{},last,f.source);assert.equal(last.options.defaultPath,join(process.cwd(),'chosen','新作品.json'));
});
test('绘图工作流的文本、视频、音频和数据结果沿用统一另存目录',()=>{
  const f=fixture(),selected=join(process.cwd(),'selected-results');
  for(const [index,name] of ['反推提示词.txt','短视频.mp4','音频.wav','结果.json','模型.glb'].entries()){
    const result=f.item(base+(index%2?instance:'')+'/api/modules/drawing/results/result-'+index+'?download=1',name);
    f.session.emit('will-download',{},result,f.source);
    assert.equal(result.options?.defaultPath,join(index?selected:join(process.cwd(),'downloads'),name),name);
    assert.equal(result.options.filters[0].extensions[0],name.split('.').at(-1));
    result.savedPath=join(selected,name);result.emit('done',{},'completed');
  }
  f.dispose();
});
test('外部页面、任意接口、安装包与跨源重定向不接管保存选项',()=>{
  const f=fixture();
  for(const url of ['https://example.test/a.png','file:///C:/private.json','blob:https://example.test/id',base+'/api/component-packages/training/install',base+'/api/voice/config',base+'/untrusted/file.zip',base+'/api/modules/drawing/results',base+'/api/modules/drawing/results/result/extra']){
    const item=f.item(url);f.session.emit('will-download',{},item,f.source);assert.equal(item.options,undefined,url);
  }
  for(const page of ['https://example.test/',base+'/untrusted.html','about:blank']){
    f.source.getURL=()=>page;const item=f.item('blob:'+base+'/id');f.session.emit('will-download',{},item,f.source);assert.equal(item.options,undefined,page);
  }
  f.source.getURL=()=>base+'/';const redirected=f.item(base+'/api/modules/drawing/images/result');redirected.getURLChain=()=>['https://example.test/origin',redirected.getURL()];f.session.emit('will-download',{},redirected,f.source);assert.equal(redirected.options,undefined);
});
