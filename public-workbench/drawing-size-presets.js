import {escape as e} from './components.js';

const sizes=[['正方形',1024,1024],['竖图',832,1216],['横图',1216,832],['竖屏',768,1344],['横屏',1344,768],['小方图',512,512],['竖图',768,1024],['横图',1024,768]];
const allowed=(field,value)=>value>=(field.min??0)&&value<=(field.max??Infinity)&&(!field.step||field.step==='any'||Math.abs((value-(field.min??field.value??0))/field.step-Math.round((value-(field.min??field.value??0))/field.step))<1e-8);

export function mountSizePresets(root,fields){
  const controls=[];
  for(const width of fields.filter(field=>field.input==='width'&&field.type==='number')){
    const height=fields.find(field=>field.nodeId===width.nodeId&&field.input==='height'&&field.type==='number');
    if(!height||fields.some(field=>field.nodeId===width.nodeId&&field.type==='select'&&/preset|预设/i.test(field.input+' '+(field.presentation?.label||''))))continue;
    const widthInput=root.querySelector(`[data-parameter="${CSS.escape(width.key)}"]`),heightInput=root.querySelector(`[data-parameter="${CSS.escape(height.key)}"]`);
    if(!widthInput||!heightInput)continue;
    const choices=sizes.filter(([,w,h])=>allowed(width,w)&&allowed(height,h));
    const wrapper=document.createElement('div'),id='drawing-size-preset-'+width.nodeId;
    wrapper.className='field drawing-wide';
    wrapper.innerHTML=`<label for="${e(id)}">常用尺寸</label><select id="${e(id)}" data-size-preset="${e(width.nodeId)}" data-searchable="false"><option value="">自定义宽高</option>${choices.map(([label,w,h])=>`<option value="${w}x${h}">${label} · ${w} × ${h}</option>`).join('')}</select>`;
    widthInput.closest('.field').before(wrapper);
    const select=wrapper.querySelector('select');let custom=false;
    const sync=()=>{select.disabled=widthInput.disabled||heightInput.disabled;const value=widthInput.value+'x'+heightInput.value;select.value=!custom&&choices.some(([,w,h])=>value===w+'x'+h)?value:'';};
    select.oninput=select.onchange=()=>{custom=!select.value;if(select.value){const [w,h]=select.value.split('x');widthInput.value=w;heightInput.value=h;widthInput.setCustomValidity('');heightInput.setCustomValidity('');}else widthInput.focus();};
    controls.push(sync);sync();
  }
  return {sync:()=>controls.forEach(sync=>sync())};
}
