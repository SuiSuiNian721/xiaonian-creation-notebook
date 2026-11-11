import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCaptioner,captionerOptions} from '../public-workbench/training-captioners.js';

test('打标器自动匹配底模格式，手动选择优先并保留现有标签模型',()=>{
  for(const type of ['moss-image-lora','ai-toolkit-flux-lora','anima-lora-fast','qwen-image-21-lora','klein-4b-lora'])assert.equal(resolveCaptioner({modelTrainType:type}).id,'florence2',type);
  for(const type of ['sd-lora','sdxl-lora','ai-toolkit-sdxl-lora'])assert.equal(resolveCaptioner({modelTrainType:type}).format,'tags');
  assert.equal(resolveCaptioner({modelTrainType:'moss-image-lora',captioner:'wd-vit-v3'}).format,'tags');
  assert.equal(resolveCaptioner({modelTrainType:'sdxl-lora',captioner:'florence2'}).format,'natural');
  assert.equal(resolveCaptioner({modelTrainType:'sdxl-lora',taggerModel:'cl_tagger_1_01'}).id,'cl_tagger_1_01');
  assert.equal(captionerOptions.length,11);assert.throws(()=>resolveCaptioner({captioner:'invented'}),/打标器/);
});
