import assert from 'node:assert/strict';
import { renderCharacter, processCharacterOutput, runCharacterScript } from './index.mjs';

const card = { name: '运行端自检', description: '<% for (const n of [1,2]) { %><%= n %><% } %>', character_book: { entries: [{ comment: '[InitVar]', enabled: false, content: 'hp: 8' }] } };
const rendered = await renderCharacter(card);
assert.match(rendered.profile, /12/);
assert.equal(rendered.variables.stat_data.hp, 8);
const changed = await processCharacterOutput('<JSONPatch>[{"op":"delta","path":"/hp","value":-1}]</JSONPatch>', { variables: rendered.variables });
assert.equal(changed.variables.stat_data.hp, 7);
const isolated = await runCharacterScript('return [typeof process, typeof require, typeof fetch];');
assert.deepEqual(isolated.result, ['undefined','undefined','undefined']);
await assert.rejects(runCharacterScript('while(true){}', { timeoutMs: 25 }), /超时|interrupted/);
console.log('角色运行端 EJS、YAML、QuickJS WASM、MVU 与超时自检通过。');
