export function skinFixture(model='slim',eyeTemplate='eye_A'){
  const parts={head:[8,8,8],body:[8,4,12],rightArm:[model==='slim'?3:4,4,12],leftArm:[model==='slim'?3:4,4,12],rightLeg:[4,4,12],leftLeg:[4,4,12]};
  const surfaces=Object.entries(parts).flatMap(([part,[w,d,h]])=>Object.entries({top:[w,d],bottom:[w,d],right:[d,h],front:[w,h],left:[d,h],back:[w,h]}).map(([side,[width,height]])=>{
    const color=part==='head'?'H':part==='body'?'P':part.endsWith('Arm')?'W':'B';
    const base=Array(height).fill(color.repeat(width)),outer=Array(height).fill('-'.repeat(width));
    if(part==='head'&&side==='front'){base.splice(0,8,'HHHHHHHH','HHHHHHHH','HHSSSSHH','HSSSSSSH','SSSSSSSS','SSSSSSSS','SSSSSSSS','SSSSSSSS');outer[0]='HHHHHHHH';outer[1]='HHHHHHHH';}
    if(part==='body'&&side==='front'){base[0]='PPPWWPPP';base[1]='PPWWWWPP';base[2]='PPPPPPPP';base[7]='PPDDDDPP';base[8]='DDDDDDDD';}
    if(part.endsWith('Leg'))for(let y=8;y<height;y++)base[y]='D'.repeat(width);
    return {face:part+'.'+side,base,outer};
  }));
  const eyePalette={S:[255,239,229,255],T:[231,218,216,255],W:[255,255,255,255],I:[117,80,160,255],J:[185,151,224,255],L:[58,39,69,255],...(eyeTemplate==='eye_A'?{U:[86,55,95,255],V:[149,93,131,255]}:{})};
  return{palette:{S:[255,239,229,255],H:[88,61,83,255],P:[166,145,202,255],W:[247,242,249,255],B:[65,65,98,255],D:[91,74,118,255]},surfaces,eyePalette};
}
