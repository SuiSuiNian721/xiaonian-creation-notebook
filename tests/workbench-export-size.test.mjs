import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeBundle } from '../public-workbench/components.js';

test('可导入的大型角色资料下载后仍小于文件与请求限制', () => {
  const bundle = {format:'ai-future-character',schemaVersion:1,character:{id:'roundtrip',name:'roundtrip',description:'',revision:1,raw:{name:'roundtrip',padding:'x'.repeat(1850000),entries:Array(20000).fill('x')},assets:[]}};
  const file = serializeBundle(bundle);
  assert.ok(Buffer.byteLength(file) < 2*1024*1024, '导出文件不应因排版膨胀超过导入上限');
  assert.ok(Buffer.byteLength(JSON.stringify({document:JSON.parse(file)})) < 2*1024*1024);
  assert.deepEqual(JSON.parse(file),bundle);
});
