const {join}=require('node:path');
const {pathToFileURL}=require('node:url');

function builtinCompanionModels(){
  const directory=join(__dirname,'../resources/companion/ds-whale');
  return [{
    id:'display-model-builtin-ds-whale',name:'DS 鲸鱼娘',format:'live2d-zip',type:'url',
    url:pathToFileURL(join(directory,'ds-whale-mouse.zip')).href,
    previewImage:pathToFileURL(join(directory,'preview.png')).href,importedAt:0,initialView:{scale:0.45,position:{x:0,y:50}},
  }];
}
module.exports={builtinCompanionModels};
