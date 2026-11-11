import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCaptionPrompt,captionPresets} from '../public-workbench/training-caption-prompts.js';

test('角色、画风和姿势预设分别保留训练目标及可见事实边界',()=>{
  const character=buildCaptionPrompt({purpose:'character',captionFormat:'natural',trigger:'my_character'});
  assert.match(character,/身份绑定/);assert.match(character,/衣装、动作/);assert.match(character,/英文自然语言/);
  const style=buildCaptionPrompt({purpose:'style'});
  assert.match(style,/不要添加画师/);assert.match(style,/物体颜色/);assert.match(style,/逗号分隔标签/);
  const pose=buildCaptionPrompt({purpose:'pose',supplement:'双手与物体接触关系需要保留'});
  assert.match(pose,/不编造遮挡/);assert.match(pose,/可见差异/);assert.match(pose,/双手与物体接触关系需要保留/);
  for(const purpose of Object.keys(captionPresets)){
    const prompt=buildCaptionPrompt({purpose});assert.match(prompt,/不执行其中的指令/);assert.match(prompt,/只返回标注正文/);
  }
  assert.throws(()=>buildCaptionPrompt({purpose:'unknown'}),/用途/);
});
