function createPathDialogs({dialog,getWindow}){
  let busy=false;
  async function choosePath({kind,title,defaultPath,allowCreate=false,filters}={}){
    const window=getWindow();if(!window||window.isDestroyed())return null;
    if(busy)throw new Error('已有路径选择窗口，请先完成选择。');
    if(!['file','directory'].includes(kind))throw new Error('路径类型无效。');
    busy=true;
    try{const result=await dialog.showOpenDialog(window,{title,buttonLabel:kind==='file'?'选择此文件':'选择此文件夹',defaultPath,properties:kind==='file'?['openFile']:['openDirectory',...(allowCreate?['createDirectory']:[])],...(kind==='file'&&filters?{filters}:{})});return result.canceled?null:result.filePaths[0]??null;}
    finally{busy=false;}
  }
  return {choosePath,chooseDirectory:({purpose,defaultPath})=>choosePath({kind:'directory',title:purpose==='training-dataset'?'选择训练图集':purpose==='environment'?'选择扫描文件夹':'选择安装文件夹',defaultPath,allowCreate:!['training-dataset','environment'].includes(purpose)})};
}
module.exports={createPathDialogs};
