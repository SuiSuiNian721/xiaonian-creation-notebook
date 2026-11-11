import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TrainingPresets, parseTrainingPreset, exportTrainingPreset } from '../framework/training-presets.mjs';

const config = { model_train_type: 'moss-image-lora', pretrained_model_name_or_path: 'E:\\模型\\moss.safetensors', network_dim: 32, convrot_int8: true, optimizer_args: ['weight_decay=0.01'], custom_advanced: { value: '保留' }, hf_token: 'private', moss_max_token_length: 4096 };

test('预设按实例持久保存、稳定编号重试和版本更新，不触发训练', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = new TrainingPresets(db, 'first'), other = new TrainingPresets(db, 'other');
    const request = { id: 'preset-stable', revision: 0, name: '小汐 · 默认方案', config };
    const saved = first.save(request).preset;
    assert.equal(saved.revision, 1); assert.equal(first.save(request).reused, true);
    assert.equal(first.save({ ...request, config: Object.fromEntries(Object.entries(config).reverse()) }).reused, true);
    assert.deepEqual(other.list().presets, []); assert.throws(() => other.get(saved.id), /找不到|当前实例/);
    const reopened = new TrainingPresets(db, 'first');
    assert.equal(reopened.get(saved.id).preset.config.network_dim, 32);
    const next = reopened.save({ ...request, revision: 1, config: { ...config, network_dim: 16 } }).preset;
    assert.equal(next.revision, 2);
    assert.throws(() => reopened.save({ ...request, revision: 1 }), /修改|版本|刷新/);
    assert.throws(() => first.remove(saved.id, { revision: 1 }), /修改|版本|刷新/);
    assert.equal(first.remove(saved.id, { revision: 2 }).deleted, true);
    assert.deepEqual(first.list().presets, []);
  } finally { db.close(); }
});

test('JSON／TOML 预设往返保留高级参数，移除密钥和保留 token 长度', () => {
  for (const format of ['json', 'toml']) {
    const file = exportTrainingPreset({ format, config, name: '小汐方案' });
    const parsed = parseTrainingPreset({ format, text: file.content });
    assert.equal(parsed.config.network_dim, 32);
    assert.deepEqual(parsed.config.optimizer_args, ['weight_decay=0.01']);
    assert.deepEqual(parsed.config.custom_advanced, { value: '保留' });
    assert.equal(parsed.config.moss_max_token_length, 4096); assert.equal(Object.hasOwn(parsed.config, 'hf_token'), false);
    assert.match(file.filename, format === 'toml' ? /\.toml$/ : /\.json$/);
  }
  const raw = parseTrainingPreset({ format: 'json', text: JSON.stringify(config) });
  assert.equal(raw.config.model_train_type, 'moss-image-lora');
  const advanced = { ...config, format: 'custom-format', config: { nested_option: true } };
  const advancedRoundTrip = parseTrainingPreset({ format: 'json', text: JSON.stringify(advanced) });
  assert.equal(advancedRoundTrip.config.format, 'custom-format');
  assert.deepEqual(advancedRoundTrip.config.config, { nested_option: true });
});

test('错误、过大、原型字段和非有限数字在写入预设前拒绝', () => {
  assert.throws(() => parseTrainingPreset({ format: 'toml', text: 'a=[1 #' }), /TOML|预设/);
  assert.throws(() => parseTrainingPreset({ format: 'json', text: JSON.stringify({ model_train_type: 'moss-image-lora', caption: 'a'.repeat(1024 * 1024) }) }), /过大|MiB|超过/);
  assert.throws(() => parseTrainingPreset({ format: 'json', text: '{"model_train_type":"moss-image-lora","__proto__":{"polluted":true}}' }), /原型|字段|安全/);
  assert.throws(() => parseTrainingPreset({ format: 'toml', text: 'model_train_type="moss-image-lora"\nlearning_rate=nan' }), /有限|数字|格式/);
  assert.throws(() => parseTrainingPreset({ format: 'json', text: '{"learning_rate":0.001}' }), /训练类型|model_train_type/);
  assert.equal({}.polluted, undefined);
});
test('TOML 不静默丢失 null 高级字段，提示改用可无损保存的 JSON', () => {
  for (const extra of [{custom_advanced:null},{custom_advanced:{value:null,keep:1}},{custom_advanced:[null]}]) {
    const config={model_train_type:'moss-image-lora',...extra};
    assert.throws(()=>exportTrainingPreset({format:'toml',config}),error=>error.status===422&&/JSON|null/.test(error.message));
    assert.deepEqual(parseTrainingPreset({format:'json',text:exportTrainingPreset({format:'json',config}).content}).config,config);
  }
});
