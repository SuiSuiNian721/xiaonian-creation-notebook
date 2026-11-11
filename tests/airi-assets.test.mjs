import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdtemp, mkdir, symlink, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const module = await import('../src/airi-assets.mjs').catch(() => ({}));

test('AIRI 模块缺少安装时返回明确的不可用状态', async () => {
  assert.equal(typeof module.createAiriAssets, 'function', '应提供 createAiriAssets');
  const assets = module.createAiriAssets({ asarPath: 'Z:\\missing-airi\\app.asar' });
  assert.equal(assets.available, false);
  assert.match(assets.note, /AIRI/);
});

const installed = existsSync('E:\\AI-未来\\AIRI\\resources\\app.asar');

async function withServer(run) {
  const assets = module.createAiriAssets();
  const server = createServer(async (req, res) => {
    if (await assets.handle(req, res)) return;
    res.writeHead(404).end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`, assets); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function rawRequest(base, path) {
  return new Promise((resolve, reject) => {
    const req = request(base + '/', { path }, response => {
      const chunks = [];
      response.on('data', data => chunks.push(data));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('舞台使用 AIRI 原生 ThreeScene，资源只读提供', { skip: !installed }, async () => {
  assert.equal(typeof module.createAiriAssets, 'function');
  await withServer(async (base, assets) => {
    assert.equal(assets.available, true);
    assert.equal(assets.version, '0.12.0-beta.5');
    const response = await fetch(base + '/airi/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self' blob: data:/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self' data:/);
    assert.match(await response.text(), /AIRI.*ThreeScene/);
    const script = await fetch(base + '/airi/stage.mjs');
    assert.match(await script.text(), /src-Dvya5YcL\.js/);
    const core = await fetch(base + '/airi/assets/src-Dvya5YcL.js');
    assert.equal(core.status, 200);
    assert.match(await core.text(), /ThreeScene_default as t/);
  });
});

test('禁止 ASAR 路径穿越与访问非 renderer 文件', { skip: !installed }, async () => {
  assert.equal(typeof module.createAiriAssets, 'function');
  await withServer(async base => {
    for (const path of [
      '/airi/../package.json',
      '/airi/%2e%2e/package.json',
      '/airi/assets/..%2f..%2fpackage.json',
      '/airi/assets/%252e%252e/package.json',
      '/airi/assets/%5c..%5cpackage.json',
      '/airi/assets/%00x.js',
      '/airi/assets/%ZZ.js',
      '/airi/package.json',
      '/airi/out/main/index.js',
    ]) {
      const response = await rawRequest(base, path);
      assert.ok(response.status >= 400, `${path} 不应成功`);
      assert.doesNotMatch(response.text, /"dependencies"/);
    }
  });
});

test('变换环境仅作用于 HTTP 响应，VRM 支持字节范围', { skip: !installed }, async () => {
  assert.equal(typeof module.createAiriAssets, 'function');
  await withServer(async base => {
    const environment = await fetch(base + '/airi/assets/environment-DvA308NR.js');
    assert.match(await environment.text(), /function isStageTamagotchi\(\)\s*\{\s*return false;/);
    const avatar = await fetch(base + '/airi/assets/AvatarSample_A-BNRNjuVT.vrm', { headers: { Range: 'bytes=0-3' } });
    assert.equal(avatar.status, 206);
    assert.equal(await avatar.text(), 'glTF');
    const head = await fetch(base + '/airi/assets/AvatarSample_A-BNRNjuVT.vrm', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 1000);
  });
});

test('不存在的嵌套资源返回 404，导出目标不能离开 Demo', { skip: !installed }, async () => {
  const assets = module.createAiriAssets();
  const response = { writeHead(status) { this.status = status; return this; }, end() {} };
  await assets.handle({ url: '/airi/assets/missing/nested.js', method: 'GET', headers: {} }, response);
  assert.equal(response.status, 404);
  await assert.rejects(assets.materialize('E:\\AI-未来\\outside-airi-assets'), /Demo/);
});

test('导出资源拒绝目标子目录中的外部链接', { skip: !installed }, async () => {
  const project = join(dirname(fileURLToPath(import.meta.url)), '..');
  const target = await mkdtemp(join(project, 'tests', 'airi-link-test-'));
  const outside = await mkdtemp(join(tmpdir(), 'airi-export-test-'));
  const link = join(target, 'assets');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const assets = module.createAiriAssets();
    await assert.rejects(assets.materialize(target), /链接|目录/);
  } finally {
    await unlink(link).catch(() => {});
    await rm(target, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
