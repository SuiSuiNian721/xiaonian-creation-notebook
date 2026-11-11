import { escape as e, help } from './components.js';
import { inspectionMarkup, bindInspectionActions } from './drawing-preflight-view.js';

const API='/api/modules/drawing';

export function mountWorkflowAssistant(root,ctx,{workflows,onImported}) {
  const {signal}=ctx;
  const find=selector => root.querySelector(selector);
  const post=(path,body,timeoutMs=30000) => ctx.api(API+path,{method:'POST',body,timeoutMs});
  let candidate=ctx.ui.drawingCandidate || null,busy=false;
  const base=ctx.ui.drawingAssistantBaseWorkflow ?? '';
  const selectedBase=workflows.some(item=>item.id===base)?base:'';
  if (ctx.ui.drawingAssistantBaseWorkflow!==undefined && base!==selectedBase) ctx.ui.drawingAssistantBaseWorkflow=selectedBase;
  root.innerHTML=`<div class="panel-heading"><h2>AI 工作流助手</h2>${help('使用工作台共用 AI 连接。先生成候选并检查，采用后再到绘图页主动生成。','工作流助手说明')}</div>
    <div class="field"><label for="assistant-base-workflow">基础工作流（可选）</label><select id="assistant-base-workflow"><option value="">从零新建工作流</option>${workflows.map(item => `<option value="${e(item.id)}" ${item.id===selectedBase?'selected':''}>${e(item.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="assistant-base-model">底模</label><input id="assistant-base-model" type="text" maxlength="2000" placeholder="输入底模名称或文件名" value="${e(ctx.ui.drawingAssistantBaseModel||'')}"></div>
    <div class="field"><label for="assistant-loras">LoRA（可选）</label><input id="assistant-loras" type="text" maxlength="4000" placeholder="输入 LoRA 名称与权重，可填写多个" value="${e(ctx.ui.drawingAssistantLoras||'')}"></div>
    <div class="field"><div class="field-label"><label for="workflow-instruction">需要实现的功能</label>${help('例如文生图、多图参考、局部重绘或放大。新建工作流默认提供常用尺寸与自定义宽高；图生图可保留主图比例。','工作流需求说明')}</div><textarea id="workflow-instruction" rows="4" placeholder="例如：二次元多图参考，保留人物外貌，替换背景">${e(ctx.ui.drawingInstruction || '')}</textarea></div>
    <div class="drawing-actions"><a class="text-link" href="#/settings">共用 AI 连接</a><button class="button primary" type="button" id="write-workflow">编写工作流</button></div>
    <div id="workflow-answer" class="drawing-answer" role="status">${e(ctx.ui.drawingAnswer || '')}</div><div id="candidate-inspection" class="drawing-inspection" hidden></div><button class="button" type="button" id="import-candidate" ${candidate?'':'hidden'}>采用工作流</button>`;
  find('#workflow-instruction').oninput=event => { ctx.ui.drawingInstruction=event.target.value; };
  find('#assistant-base-model').oninput=event => { ctx.ui.drawingAssistantBaseModel=event.target.value; };
  find('#assistant-loras').oninput=event => { ctx.ui.drawingAssistantLoras=event.target.value; };
  find('#assistant-base-workflow').onchange=event => { ctx.ui.drawingAssistantBaseWorkflow=event.target.value; };
  const feedback=(text,error=false) => { if (!signal.aborted) { const node=find('#workflow-answer');node.textContent=text;node.className='drawing-answer'+(error?' form-feedback error':''); } };
  const run=(button,job) => {
    if (busy) return;
    return ctx.action(button,async () => {
      busy=true;const actions=[find('#write-workflow'),find('#import-candidate')];actions.forEach(node=>{node.disabled=true;});
      try { await job(); } catch(error) { feedback(error.message,true); }
      finally {busy=false;if(!signal.aborted)actions.forEach(node=>{node.disabled=false;});}
    });
  };
  find('#write-workflow').onclick=event => run(event.currentTarget,async () => {
    const instruction=find('#workflow-instruction').value;const workflowId=find('#assistant-base-workflow').value || null;
    candidate=null;ctx.ui.drawingCandidate=null;find('#import-candidate').hidden=true;find('#candidate-inspection').hidden=true;feedback('正在编写…');
    const baseModel=find('#assistant-base-model').value.trim(),loras=find('#assistant-loras').value.trim();
    const result=await post('/assistant',{instruction,workflowId,baseModel,loras,history:ctx.ui.drawingAIHistory || []},185000);
    if (signal.aborted) return;
    candidate=result.workflow;ctx.ui.drawingCandidate=candidate;ctx.ui.drawingAnswer=result.explanation;
    feedback(result.explanation);find('#import-candidate').hidden=!candidate;
    ctx.ui.drawingAIHistory=[...(ctx.ui.drawingAIHistory || []),{role:'user',content:JSON.stringify({instruction,baseModel,loras})},{role:'assistant',content:result.text}].slice(-12);
  });
  find('#import-candidate').onclick=event => run(event.currentTarget,async () => {
    const document=candidate;const checked=await post('/workflows/inspect',{document});if (signal.aborted) return;
    const inspection=find('#candidate-inspection');inspection.hidden=false;inspection.innerHTML=inspectionMarkup(checked);
    bindInspectionActions(inspection,ctx,checked);
    if (!checked.valid) { feedback('请处理预检中的缺项，再重新采用。',true);return; }
    const result=await post('/workflows/import',{name:'AI 工作流 '+new Date().toLocaleTimeString('zh-CN'),document});if (signal.aborted) return;
    ctx.ui.drawingWorkflow=result.id;ctx.ui.drawingCandidate=null;candidate=null;find('#import-candidate').hidden=true;
    ctx.ui.drawingAnswer='工作流已采用，可在绘图页编辑参数并生成。';feedback(ctx.ui.drawingAnswer);
    await onImported(result.id);
  });
}
