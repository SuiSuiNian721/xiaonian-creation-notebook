const params = new URLSearchParams(location.search);
const taskId = params.get('task'), instanceId = params.get('instance');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalidTarget = [...params.keys()].some(key => !['task','instance'].includes(key) || params.getAll(key).length !== 1 || !uuid.test(params.get(key)));
const prefix = instanceId ? '/instances/' + encodeURIComponent(instanceId) : '';
const endpoint = invalidTarget ? null : prefix + (taskId ? '/api/modules/drawing/manager/tasks/' + encodeURIComponent(taskId) + '/logs' : '/api/modules/drawing/runtime/logs');
const find = selector => document.querySelector(selector);
const output = find('#log-output');
const follow = find('#log-follow');
const status = find('#log-status');
const notice = find('#log-notice');
const feedback = find('#log-feedback');
const labels = {starting:'启动中',running:taskId?'执行中':'进程运行中',stopping:'停止中',exited:'已退出',failed:'失败',unknown:'状态待核实',stopped:'已停止',queued:'等待执行',completed:'已完成',interrupted:'已中断'};
let timer, controller, closed=false, text='', title='ComfyUI 日志';

function clean(value) {
  return value.replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r\n/g,'\n').split('\n').map(line=>{
    const parts=line.split('\r');
    return parts.at(-1) || parts.at(-2) || '';
  }).join('\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
}
function message(node, value, error=false) {
  node.textContent=value;node.hidden=!value;node.dataset.error=String(error);
}
function selectionInLog() {
  const selection=getSelection();
  return selection && !selection.isCollapsed && output.contains(selection.anchorNode);
}
function renderText() {
  if (selectionInLog()) {follow.checked=false;return;}
  const next=text || '等待进程输出…';
  if (output.textContent!==next) {
    const top=output.scrollTop;
    output.textContent=next;
    output.scrollTop=follow.checked?output.scrollHeight:top;
  }
}
async function refresh() {
  if(closed)return;
  if(!endpoint){status.textContent='读取失败';status.dataset.state='failed';message(notice,'日志链接中的实例或任务标识无效，请从原页面重新打开。',true);return;}
  controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(endpoint,{cache:'no-store',signal:controller.signal});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error || '无法读取日志。');
    if(closed)return;
    const record=result.task || result.launch;
    title=result.task?result.task.title+' · ComfyUI 日志':'ComfyUI 日志';
    find('#log-title').textContent=title;
    const state=record?.stoppedByWorkbench?'stopped':record?.status;
    status.textContent=labels[state] || '尚未启动';status.dataset.state=state || 'idle';
    document.title=(labels[state]?labels[state]+' · ':'')+title;
    const details=[record?.error,result.browser?.error,record?.exitCode!=null?'退出码 '+record.exitCode:'',result.truncated?'仅显示最近一段日志。':''].filter(Boolean);
    message(notice,details.join(' '),!!record?.error || !!result.browser?.error);
    text=clean(result.text || '');renderText();
  } catch(error) {
    if(closed)return;
    status.textContent='读取失败';status.dataset.state='failed';
    message(notice,error.name==='AbortError'?'读取日志超时，正在重试。':error.message+' 正在重试。',true);
  } finally {
    clearTimeout(timeout);
    if(!closed)timer=setTimeout(refresh,1000);
  }
}
output.addEventListener('scroll',()=>{follow.checked=output.scrollHeight-output.scrollTop-output.clientHeight<24;},{passive:true});
follow.addEventListener('change',()=>{if(follow.checked){renderText();output.scrollTop=output.scrollHeight;}});
find('#log-copy').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(text);message(feedback,'已复制日志。');}
  catch{message(feedback,'复制失败，请选中日志后按 Ctrl+C。',true);}
});
find('#log-save').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.log';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
});
addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);controller?.abort();},{once:true});
void refresh();
