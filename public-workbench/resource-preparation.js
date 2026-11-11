import {escape as e,help,icon} from './components.js';

const sources={
  python:'https://docs.python.org/3/using/windows.html',
  pillow:'https://pillow.readthedocs.io/en/stable/installation/basic-installation.html',
  comfy:'https://docs.comfy.org/installation/comfyui_portable_windows',
  trainer:'https://github.com/wochenlong/lora-scripts-next/blob/main/README-zh.md',
  airi:'https://github.com/moeru-ai/airi/releases/tag/v0.12.0-beta.5',
};
const definitions={
  comfyui:{title:'准备 ComfyUI',items:[
    {title:'ComfyUI 本体与 Python',detail:'按显卡选择官方 Windows 便携包并解压；包内含独立 Python。选择含 main.py 的 ComfyUI 子目录，保存后检查路径。',links:[{label:'官方便携包与安装指引',url:sources.comfy}],target:'comfyPath',targetLabel:'选择本地 ComfyUI'},
  ]},
  training:{title:'准备训练环境',items:[
    {title:'训练工具与 Python/CUDA 环境',detail:'按原训练器官方指引准备环境，在原训练器的训练引擎页安装或修复 Kohya。此处选择含 extensions/kohya/.venv 的训练工具根目录；工作台使用已安装的训练组件。',links:[{label:'训练组件安装指引',url:sources.trainer}],target:'trainerPath',targetLabel:'选择训练工具目录'},
    {title:'服务 Python 与标注依赖',detail:'服务 Python 需 FastAPI、uvicorn、psutil、toml；标签与裁切另需 Pillow、NumPy、OpenCV、ONNX Runtime、pandas、huggingface-hub。按原训练器指引修复到该 Python。自然语言标注使用 Kohya 的 Torch、Transformers、Pillow、safetensors。保存后检查路径，再启动内核。',links:[{label:'Python 官方安装指引',url:sources.python},{label:'训练器依赖与环境指引',url:sources.trainer}],target:'pythonPath',targetLabel:'选择服务 Python'},
  ]},
  'mc-skin':{title:'准备 Python 与 Pillow',items:[
    {title:'Python 3.10+ 与 Pillow',detail:'按官方指引安装独立 Python，选择该环境的 python.exe。需要 Pillow 时可复制命令到 PowerShell 7 手动运行，然后保存配置并检查路径。',links:[{label:'Python 官方安装指引',url:sources.python},{label:'Pillow 官方安装指引',url:sources.pillow}],target:'pythonPath',targetLabel:'选择 Python',command:'pillow',commandLabel:'复制 Pillow 安装命令'},
  ]},
  companion:{title:'准备陪伴运行端',items:[
    {title:'陪伴运行组件 0.12.0-beta.5',detail:'当前仅兼容此版本。获取 Windows 桌面包后安装或解压，选择包含 resources/app.asar 的安装根目录，再保存位置并重新打开陪伴。',links:[{label:'获取兼容版本 0.12.0-beta.5',url:sources.airi}],target:'airiPath',targetLabel:'选择运行端目录'},
    {title:'自己的角色模型',detail:'Live2D ZIP 或 VRM 需自行准备。内置规则初始化不包含角色模型；运行端打开后，在「设置 → 角色模型」导入。'},
  ]},
  'mc-play':{title:'修复陪玩运行组件',items:[
    {title:'独立陪玩组件包',detail:'在「工作台设置 → 组件与存储」卸载损坏的受管组件，再导入当前发行版的 MC 组件包。角色与聊天资料保留；已有外部环境需要在原位置修复。',target:'recheck',targetLabel:'重新检查组件'},
  ]},
  'training-processing':{title:'准备标注与裁切模型',items:[
    {title:'Florence-2 自然语言标注',detail:'使用原生 Florence-2-base 完整目录，包含权重、处理器和 tokenizer；在「描述模型目录」选择。也可允许本流程下载到工作台缓存。',links:[{label:'Florence-2 官方转换模型',url:'https://huggingface.co/florence-community/Florence-2-base'}],target:'captionModelPath',targetLabel:'选择描述模型目录'},
    {title:'DWPose 裁切检测',detail:'目录需同时包含 yolox_l.onnx 与 dw-ll_ucoco_384.onnx；在「裁切模型目录」选择。',links:[{label:'DWPose 作者模型仓库',url:'https://huggingface.co/yzd-v/DWPose'}],target:'detectorPath',targetLabel:'选择裁切模型目录'},
    {title:'WD14 标签模型',detail:'流程按所选 WD14 版本使用 model.onnx 与 selected_tags.csv。允许下载时保存到工作台标签模型缓存。',links:[{label:'WD14 作者模型仓库',url:'https://huggingface.co/SmilingWolf'}]},
  ]},
  'training-models':{title:'准备底模与组件',items:[
    {title:'匹配同一底模的权重',detail:'从对应发布方获取底模、文本编码器、VAE 与 tokenizer。下载后用上方文件选择按钮填写；已有训练参数可直接载入。标注／裁切下载开关不会下载这些训练权重。'},
  ],modelSources:[
    {label:'MOSS-Image · OpenMOSS',url:'https://github.com/OpenMOSS/MOSS-Image'},
    {label:'FLUX.1-dev · Black Forest Labs',url:'https://huggingface.co/black-forest-labs/FLUX.1-dev'},
    {label:'SDXL 1.0 · Stability AI',url:'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0'},
    {label:'其他训练类型 · 安装指引',url:sources.trainer},
  ]},
};

export function preparationFor(kind){
  const definition=definitions[kind];
  if(!definition)throw new Error('没有此资源的准备指引。');
  return structuredClone(definition);
}

function sourceURL(value){
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&['docs.comfy.org','docs.python.org','pillow.readthedocs.io','github.com','huggingface.co'].includes(url.hostname)?url.href:'';}catch{return '';}
}

export function pythonInstallCommand(executable,packages){
  if(typeof executable!=='string'||!/[\\/]python(?:3)?\.exe$/i.test(executable)||!/^[A-Za-z]:[\\/]/.test(executable)||/[\u0000-\u001f\u007f"<>|]/.test(executable))throw new Error('请先选择普通本地磁盘上的 python.exe。');
  if(!Array.isArray(packages)||!packages.length||packages.some(value=>typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)))throw new Error('安装依赖名称无效。');
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  return `& ${literal(executable)} -m pip install ${packages.map(literal).join(' ')}`;
}

export function resourcePreparationHTML({title='准备资源',items=[],open=false,modelSources=[]}={}){
  return `<details class="resource-preparation" ${open?'open':''}><summary>${e(title)}</summary><div class="resource-preparation-content">${items.map((item,index)=>`<div class="resource-preparation-row"><div><strong>${e(item.title)}</strong>${item.detail?help(item.detail,item.title+'准备说明'):''}</div><div class="resource-preparation-actions">${(item.links||[]).map(link=>{const url=sourceURL(link.url);return url?`<a class="button small" href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(link.label)} ${icon('arrow')}</a>`:'';}).join('')}${item.target?`<button class="button small" type="button" data-preparation-target="${index}">${e(item.targetLabel||'使用本地文件')}</button>`:''}${item.command?`<button class="button small" type="button" data-preparation-command="${index}">${e(item.commandLabel||'复制命令')}</button>`:''}</div></div>`).join('')}${modelSources.length?`<div class="resource-preparation-source"><label class="field">模型发布方<select data-preparation-source><option value="">选择对应底模的来源</option>${modelSources.map((source,index)=>sourceURL(source.url)?`<option value="${index}">${e(source.label)}</option>`:'').join('')}</select></label><a class="button small" data-preparation-source-link target="_blank" rel="noopener noreferrer" aria-disabled="true">打开官方来源 ${icon('arrow')}</a></div>`:''}<p class="form-feedback" role="status" data-preparation-feedback></p></div></details>`;
}

export function mountResourcePreparation(root,ctx,options){
  if(!document.querySelector('#resource-preparation-style')){const style=document.createElement('link');style.id='resource-preparation-style';style.rel='stylesheet';style.href=new URL('./resource-preparation.css',import.meta.url).href;document.head.append(style);}
  root.innerHTML=resourcePreparationHTML(options);
  const details=root.querySelector('details'),feedback=root.querySelector('[data-preparation-feedback]');
  const live=()=>!ctx.signal.aborted&&root.isConnected;
  root.addEventListener('click',async event=>{
    const button=event.target.closest('[data-preparation-target],[data-preparation-command]');if(!button||button.disabled||!live())return;
    button.disabled=true;button.setAttribute('aria-busy','true');feedback.textContent='';feedback.className='form-feedback';
    try{
      if(button.hasAttribute('data-preparation-target'))await options.onTarget?.(options.items[Number(button.dataset.preparationTarget)].target);
      else {const command=await options.commandFor?.(options.items[Number(button.dataset.preparationCommand)].command);if(!live())return;if(!command)throw new Error('请先选择要准备的 Python 环境。');await (options.copy||((value)=>navigator.clipboard.writeText(value)))(command);if(live())feedback.textContent='命令已复制，请在 PowerShell 7 中核对后手动运行。';}
    }catch(error){if(live()){details.open=true;feedback.textContent=error.message;feedback.className='form-feedback error';}}
    finally{if(live()){button.disabled=false;button.removeAttribute('aria-busy');}}
  },{signal:ctx.signal});
  const selector=root.querySelector('[data-preparation-source]'),link=root.querySelector('[data-preparation-source-link]');
  selector?.addEventListener('change',()=>{const url=selector.value===''?'':sourceURL(options.modelSources[Number(selector.value)]?.url);if(url)link.href=url;else link.removeAttribute('href');link.setAttribute('aria-disabled',String(!url));},{signal:ctx.signal});
  return {expand:()=>{if(live())details.open=true;}};
}

export function choosePreparedField(root,target){
  const input=root.querySelector('#config-'+CSS.escape(target))||root.querySelector(`[data-pipeline-field="${CSS.escape(target)}"]`);
  if(!input)return;
  const details=input.closest('details');if(details)details.open=true;
  input.scrollIntoView({block:'nearest'});input.focus();
  input.closest('.path-picker')?.querySelector('[data-path-field]:not(:disabled)')?.click();
}
