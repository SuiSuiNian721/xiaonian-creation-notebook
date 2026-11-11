import {WorkbenchError,fields,identifier,object} from './contracts.mjs';

export async function trainingHttp({req,res,pathname,url,readBody,json,service}) {
  const action=pathname.slice('/api/training/'.length);
  if(req.method==='GET') {
    if(action==='captioners')return json(res,200,await service.captioners.state());
    if(action==='presets')return json(res,200,service.listPresets());
    if(action==='workflows')return json(res,200,service.pipeline.list());
    const sample=action.match(/^workflows\/([^/]+)\/samples\/(\d{1,2})$/);
    if(sample){const result=await service.pipeline.sample(identifier(sample[1],'流程编号'),sample[2]);res.writeHead(200,{'content-type':result.mime,'content-length':result.bytes.length,'cache-control':'no-store'});return res.end(result.bytes);}
    const workflow=action.match(/^workflows\/([^/]+)$/);
    if(workflow)return json(res,200,service.pipeline.get(identifier(workflow[1],'流程编号')));
    if(action==='state')return json(res,200,await service.state());
    if(action==='catalog')return json(res,200,await service.catalog());
    if(action==='saved-configs')return json(res,200,await service.savedConfigs());
    if(action==='schema')return json(res,200,await service.schema(identifier(url.searchParams.get('type'),'训练类型')));
    if(action==='tasks')return json(res,200,await service.tasks());
    const submission=action.match(/^submissions\/([^/]+)$/);
    if(submission)return json(res,200,await service.submission(identifier(submission[1],'提交编号')));
    const task=action.match(/^tasks\/([^/]+)$/);
    if(task)return json(res,200,await service.task(identifier(task[1],'任务编号')));
    const preview=action.match(/^tasks\/([^/]+)\/previews\/([^/]+)$/);
    if(preview){
      const result=await service.preview(identifier(preview[1],'任务编号'),preview[2]);
      res.writeHead(200,{'content-type':result.mime,'content-length':result.bytes.length,'cache-control':'no-store'});
      return res.end(result.bytes);
    }
  }
  if(req.method==='POST') {
    const value=await readBody(req);
    if(action==='captioners/prepare')return json(res,200,await service.captioners.prepare(value));
    if(action==='captioners/cancel')return json(res,200,await service.captioners.cancel(value));
    if(action==='discovery')return json(res,200,await service.discoverResources(value));
    if(action==='models/inspect')return json(res,200,await service.inspectModel(value));
    if(action==='runtime/prepare')return json(res,200,await service.prepareService(value));
    const engine=action.match(/^engines\/([a-z-]+)\/(install|repair|use)$/);
    if(engine)return json(res,200,await service.engineAction(engine[1],engine[2],value));
    if(action==='presets')return json(res,200,service.savePreset(value));
    if(action==='presets/import')return json(res,200,service.importPreset(value));
    if(action==='presets/export')return json(res,200,service.exportPreset(value));
    const presetDelete=action.match(/^presets\/([^/]+)\/delete$/);
    if(presetDelete)return json(res,200,service.deletePreset(identifier(presetDelete[1],'预设编号'),value));
    if(action==='quick-start'){fields(value,['requestId','input','config']);return json(res,200,await service.quickStart(value));}
    if(action==='workflows'){fields(value,['requestId','input','config']);identifier(value.requestId,'流程编号');object(value.input,'流程输入');return json(res,200,await service.pipeline.create(value));}
    if(action==='workflows/choose-dataset'){fields(value,[]);return json(res,200,await service.chooseDataset());}
    const workflow=action.match(/^workflows\/([^/]+)\/(pause|resume|cancel)$/);
    if(workflow){fields(value,[]);return json(res,200,await service.pipeline[workflow[2]](identifier(workflow[1],'流程编号')));}
    if(action==='start'||action==='stop'){fields(value,[]);return json(res,200,await service[action]());}
    if(action==='validate'||action==='preflight'){fields(value,['config']);return json(res,200,await service[action](object(value.config,'训练配置')));}
    if(action==='tasks'){fields(value,['requestId','config']);identifier(value.requestId,'提交编号');object(value.config,'训练配置');return json(res,200,await service.submit(value));}
    const stop=action.match(/^tasks\/([^/]+)\/stop$/);
    if(stop){fields(value,[]);return json(res,200,await service.stopTask(identifier(stop[1],'任务编号')));}
  }
  if(/^(?:state|catalog|saved-configs|schema|tasks|start|stop|validate|preflight|workflows|presets|quick-start|discovery|captioners)$/.test(action)||/^(?:tasks|submissions|workflows|presets|models|engines|captioners)\//.test(action))throw new WorkbenchError(405,'此训练接口不支持这个请求方法。');
  throw new WorkbenchError(404,'找不到这个训练接口。');
}
