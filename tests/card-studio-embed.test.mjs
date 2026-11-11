import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { embedStudioHtml } from '../framework/card-studio-embed.mjs';

test('embedded studio scopes APIs and removes the private child token without altering content', () => {
  const html = '<html><head><style>@font-face{src:url(\'/api/ui-font/regular\')}</style></head><body><script>var API_TOKEN = "private-child-token";var content="原始中文正文";</script></body></html>';
  const embedded = embedStudioHtml(html);
  assert.ok(!embedded.includes('private-child-token'));
  assert.ok(embedded.includes('/card-studio/api/ui-font/regular'));
  assert.ok(embedded.includes('原始中文正文'));
  assert.ok(embedded.includes('__workbenchOpenCard'));
  for (const match of embedded.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('Windows CRLF 模块生成的内嵌脚本按浏览器换行规范化，CSP 哈希不随检出方式变化', () => {
  const html='<html>\r\n<head></head>\r\n<body><script>var content="中文正文";\r\n</script></body></html>';
  const embedded=embedStudioHtml(html);
  assert.equal(embedded.includes('\r'),false);
  assert.ok(embedded.includes('中文正文'));
  for(const match of embedded.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});

test('实例返回的成品下载路径保留当前实例并进入角色卡子服务', async () => {
  const prefix = '/instances/12345678-1234-1234-1234-123456789012/card-studio';
  const calls = [];
  const window = { fetch: async url => { calls.push(url); return {}; }, EventSource: class {} };
  const html = embedStudioHtml('<html><head></head><body></body></html>', prefix);
  new vm.Script(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]).runInNewContext({ window });
  await window.fetch('/api/artifact-file/card?targetType=card&file=png');
  await window.fetch(prefix.replace('/card-studio', '') + '/api/artifact-file/card?targetType=card&file=json');
  await window.fetch(prefix + '/api/cards');
  assert.deepEqual(calls, [prefix + '/api/artifact-file/card?targetType=card&file=png', prefix + '/api/artifact-file/card?targetType=card&file=json', prefix + '/api/cards']);
});
