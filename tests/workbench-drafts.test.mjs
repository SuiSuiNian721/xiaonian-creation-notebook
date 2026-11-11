import test from 'node:test';
import assert from 'node:assert/strict';
import { Drafts } from '../public-workbench/drafts.js';

test('模块和角色表单草稿独立，切换页面后仍可读取', () => {
  const drafts = new Drafts();
  drafts.write('module:drawing', { serviceUrl: 'http://localhost:8188' });
  drafts.write('module:voice', { serviceUrl: 'http://localhost:9880' });
  assert.equal(drafts.read('module:drawing', {}).serviceUrl, 'http://localhost:8188');
  assert.equal(drafts.read('module:voice', {}).serviceUrl, 'http://localhost:9880');
  const value = drafts.read('module:drawing', {});
  value.serviceUrl = 'accidental mutation';
  assert.equal(drafts.read('module:drawing', {}).serviceUrl, 'http://localhost:8188');
});

test('旧保存请求完成时不会清除较新的输入', () => {
  const drafts = new Drafts();
  const saved = { serviceUrl: 'http://localhost:8188' };
  drafts.write('module:drawing', saved);
  drafts.write('module:drawing', { serviceUrl: 'http://localhost:8189' });
  drafts.commit('module:drawing', saved);
  assert.equal(drafts.read('module:drawing', saved).serviceUrl, 'http://localhost:8189');
  drafts.commit('module:drawing', { serviceUrl: 'http://localhost:8189' });
  assert.deepEqual(drafts.read('module:drawing', { serviceUrl: 'restored' }), { serviceUrl: 'restored' });
});

test('服务器规范化仅同步未继续编辑的字段，保留其他字段的新草稿', () => {
  const drafts = new Drafts();
  const submitted = { path: '  E:\\AI-未来  ', url: 'http://localhost:8188' };
  const saved = { path: 'E:\\AI-未来', url: submitted.url };
  drafts.write('module:drawing', { ...submitted, url: 'http://localhost:8190' });
  drafts.reconcile('module:drawing', submitted, saved);
  assert.deepEqual(drafts.read('module:drawing', saved), { ...saved, url: 'http://localhost:8190' });
});

test('规范化后没有新修改时清除草稿，后续读取最新已保存配置', () => {
  const drafts = new Drafts();
  const submitted = { path: '  E:\\AI-未来  ' };
  drafts.write('module:drawing', submitted);
  drafts.reconcile('module:drawing', submitted, { path: 'E:\\AI-未来' });
  assert.deepEqual(drafts.read('module:drawing', { path: 'updated' }), { path: 'updated' });
});
