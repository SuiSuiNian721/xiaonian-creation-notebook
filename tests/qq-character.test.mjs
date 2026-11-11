import test from 'node:test';
import assert from 'node:assert/strict';

const characterModule = await import('../framework/qq-character.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

function parse(raw = {}, extra = {}) {
  assert.equal(typeof characterModule.parseQQCharacter, 'function', '应实现 QQ 角色快照解析');
  return characterModule.parseQQCharacter({ id: 'card-a', revision: 3, name: '小璃', description: '宿主简介', raw, ...extra });
}

test('QQ 角色保留宿主标识与版本，V2/V3 基础字段和宏独立于全局选择', () => {
  const card = parse({ spec: 'chara_card_v3', data: {
    name: '小璃', description: '{{char}}记得{{user}}', personality: '细腻', scenario: '夜晚',
    first_mes: '你好，{{user}}', mes_example: '{{char}}：晚安', system_prompt: '保持角色', post_history_instructions: '自然回应',
  } });
  assert.equal(card.characterId, 'card-a');
  assert.equal(card.revision, 3);
  assert.match(card.hash, /^[a-f0-9]{64}$/);
  const rendered = characterModule.renderQQCharacter(card, { userName: '念念', latestInput: '你好' });
  assert.match(rendered.profile, /小璃记得念念/);
  assert.match(rendered.profile, /细腻/);
  assert.match(rendered.profile, /自然回应/);
  assert.equal(rendered.opening, '你好，念念');
});

test('世界书遵守禁用、常驻、主次关键词、稳定顺序与渲染后预算', () => {
  const card = parse({ character_book: { entries: [
    { id: 'z', constant: true, insertion_order: 1, content: '常驻' },
    { id: 'a', constant: true, insertion_order: 1, content: '同序' },
    { keys: ['海边'], secondary_keys: ['晚上'], insertion_order: 2, content: '{{user}}的海边' },
    { constant: true, enabled: false, content: '禁用秘密' },
    { keys: ['海边'], secondary_keys: ['晴天'], content: '不匹配' },
  ] } });
  const rendered = characterModule.renderQQCharacter(card, { userName: '念念', latestInput: '晚上去海边', worldbookBudgetChars: 300 });
  assert.ok(rendered.lore.indexOf('常驻') < rendered.lore.indexOf('同序'));
  assert.match(rendered.lore, /念念的海边/);
  assert.doesNotMatch(rendered.lore, /禁用秘密|不匹配/);
  const limited = characterModule.renderQQCharacter(card, { userName: '很长的名字'.repeat(10), latestInput: '晚上去海边', worldbookBudgetChars: 12 });
  assert.ok(limited.lore.length <= 12);
  assert.doesNotMatch(characterModule.renderQQCharacter(card, { latestInput: '海边' }).lore, /的海边/);
});

test('MVU、EJS、脚本和未支持宏会显示受限能力，不执行原卡内容', () => {
  globalThis.qqScriptMustNotRun = 0;
  const card = parse({ extensions: { mvu: {}, tavern_helper: { script: 'globalThis.qqScriptMustNotRun++' } },
    description: '<% globalThis.qqScriptMustNotRun++ %> {{getvar::foo}}',
    character_book: { entries: [{ constant: true, content: '[mvu_update] <script>alert(1)</script>' }] },
  });
  assert.equal(card.compatibility, 'limited');
  assert.ok(card.unsupportedFeatures.some(value => /MVU/.test(value)));
  assert.ok(card.unsupportedFeatures.some(value => /EJS/.test(value)));
  assert.ok(card.unsupportedFeatures.some(value => /宏/.test(value)));
  assert.equal(globalThis.qqScriptMustNotRun, 0);
  delete globalThis.qqScriptMustNotRun;
});
