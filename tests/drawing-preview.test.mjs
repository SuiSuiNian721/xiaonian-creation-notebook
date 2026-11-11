import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawingPreviews } from '../framework/drawing-preview.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=', 'base64');
function frame(type = 1, promptId = 'a') {
  const metadata = Buffer.from(JSON.stringify({ prompt_id: promptId, image_type: 'image/png' }));
  const header = Buffer.alloc(8); header.writeUInt32BE(type); header.writeUInt32BE(type === 1 ? 2 : metadata.length, 4);
  return Buffer.concat([header, ...(type === 4 ? [metadata] : []), png]);
}
function fixture(options = {}) {
  const jobs = [{ id: 'job-a', promptId: 'a', serviceUrl: 'local', status: 'running' }, { id: 'job-b', promptId: 'b', serviceUrl: 'local', status: 'queued' }];
  const previews = new DrawingPreviews({ lookup: (source, id) => jobs.find(job => job.serviceUrl === source && job.promptId === id), ...options });
  const session = previews.open('local');
  return { jobs, previews, session };
}
test('旧帧必须有本连接的执行归属，外部任务不会串入当前任务', async () => {
  const { jobs, previews, session } = fixture();
  await previews.receive(session, frame()); assert.equal(previews.get(jobs[0]), null);
  previews.note(session, { type: 'executing', data: { prompt_id: 'a', node: '12' } });
  await previews.receive(session, frame()); assert.deepEqual(previews.get(jobs[0]).bytes, png); const version = previews.get(jobs[0]).version;
  previews.note(session, { type: 'executing', data: { prompt_id: 'foreign', node: '20' } });
  await previews.receive(session, frame()); assert.equal(previews.get(jobs[1]), null);
  assert.equal(previews.get(jobs[0]).version, version);
});
test('新帧按 metadata 归属，完成和跨服务帧均不再显示', async () => {
  const { jobs, previews, session } = fixture();
  await previews.receive(session, frame(4, 'b')); assert.equal(previews.get(jobs[1]).version, 1);
  const other = previews.open('remote'); await previews.receive(other, frame(4, 'a')); assert.equal(previews.get(jobs[0]), null);
  previews.note(session, { type: 'execution_success', data: { prompt_id: 'b' } });
  await previews.receive(session, frame(4, 'b')); assert.equal(previews.get(jobs[1]), null);
  jobs[0].status = 'completed'; await previews.receive(session, frame(4, 'a')); assert.equal(previews.get(jobs[0]), null);
});
test('异步 Blob 不覆盖更新的帧，断线后的未完成读取作废', async () => {
  const { jobs, previews, session } = fixture(); let release;
  class DelayedBlob extends Blob { arrayBuffer() { return new Promise(resolve => { release = () => super.arrayBuffer().then(resolve); }); } }
  const pending = previews.receive(session, new DelayedBlob([frame(4)]));
  await previews.receive(session, frame(4)); release(); await pending;
  assert.equal(previews.get(jobs[0]).version, 2);
  const next = previews.receive(session, new DelayedBlob([frame(4)])); previews.disconnect(session); release(); await next;
  assert.equal(previews.get(jobs[0]), null);
  const replacement = previews.open('local'); await previews.receive(session, frame(4)); assert.equal(previews.get(jobs[0]), null);
  await previews.receive(replacement, frame(4)); assert.deepEqual(previews.get(jobs[0]).bytes, png);
  assert.ok(previews.get(jobs[0]).version > 2, '重连后的 URL 版本不能复用上一连接的版本');
  assert.doesNotThrow(() => previews.note(replacement, null));
});
test('畸形帧、超限、伪图片和不匹配 MIME 被忽略', async () => {
  const { jobs, previews, session } = fixture({ maxFrameBytes: 256 });
  const badLength = frame(4); badLength.writeUInt32BE(9000, 4);
  const badMime = Buffer.from(frame(1)); badMime.writeUInt32BE(1, 4);
  for (const data of [Buffer.alloc(2), Buffer.alloc(257), frame(8), badLength, badMime, new Blob([Buffer.alloc(257)])]) await previews.receive(session, data);
  assert.equal(previews.get(jobs[0]), null);
});
test('缓存按总量和过期时间有界，任务结束删除预览', async () => {
  let now = 10; const { jobs, previews, session } = fixture({ now: () => now, ttlMs: 100, maxTotalBytes: png.length });
  await previews.receive(session, frame(4, 'a')); await previews.receive(session, frame(4, 'b'));
  assert.equal(previews.get(jobs[0]), null); assert.ok(previews.get(jobs[1]));
  now = 111; assert.equal(previews.get(jobs[1]), null);
  await previews.receive(session, frame(4)); jobs[0].status = 'failed'; assert.equal(previews.get(jobs[0]), null);
  previews.close(); assert.equal(previews.sessions.size, 0);
});
