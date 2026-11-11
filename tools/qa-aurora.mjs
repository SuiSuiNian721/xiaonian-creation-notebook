import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Hidden-window QA uses isolated local fixtures. It never connects QQ or plays audio.
export async function runQa({ window, runtime, qaDir }) {
  mkdirSync(qaDir, { recursive: true });
  const errors = [];
  const checks = [];
  const calls = [];
  window.webContents.on('console-message', event => {
    if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message);
  });
  const wav = Buffer.alloc(44 + 1600);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(1600, 40);
  const fixture = createServer(async (req, res) => {
    try {
      let body = ''; for await (const piece of req) body += piece;
      const input = JSON.parse(body || '{}');
      calls.push({ path: req.url, input });
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); return;
      }
      assert.ok(input.messages?.some(message => message.role === 'user'));
      if (input.messages.at(-1).content === 'QA模拟失败') {
        res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"fixture unavailable"}'); return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '念念，我记得我们想让角色的形象、声音与经历保持一致。这条回复来自本地接口联调服务。' } }], usage: { prompt_tokens: 20, completion_tokens: 24, total_tokens: 44 } }));
    } catch (error) { errors.push(error.message); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
  const js = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(`Electron 页面操作失败：${code.slice(0, 160)}\n${error.message}`, { cause: error }); }
  };
  const read = id => js(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (id, value) => js(`(() => {const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const submit = id => js(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);
  async function waitFor(label, predicate, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await pause(100); }
    throw new Error(`QA 等待超时：${label}`);
  }
  async function state() {
    const response = await fetch(runtime.url + '/api/state'); assert.equal(response.status, 200); return response.json();
  }
  const shot = async name => {
    await js(`document.getElementById('notice').hidden=true`);
    window.webContents.invalidate();
    await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
    await pause(name === 'welcome' ? 800 : 200);
    writeFileSync(join(qaDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  async function view(name) { await click(`[data-view="${name}"]`); }
  async function chat(text) { await view('chat'); await fill('message-input', text); await submit('chat-form'); }
  async function formDone(id) { await waitFor(id, () => js(`!document.getElementById(${JSON.stringify(id)}).querySelector('[type=submit]').disabled`)); }
  try {
    await waitFor('角色和后台已读取', async () => (await read('character-display-name')) === '林小璃' && await js(`document.getElementById('app-shell').getAttribute('aria-busy')==='false'`));
    assert.equal(await js(`document.documentElement.dataset.theme`), 'light');
    await shot('welcome');
    await click('#theme-toggle');
    assert.equal(await js(`document.documentElement.dataset.theme`), 'dark');
    await waitFor('主题保存到profile', async () => (await state()).preferences?.theme === 'dark');
    assert.equal((await state()).status.qq, 'disconnected');
    await click('#new-conversation');
    await waitFor('新建会话', async () => (await state()).conversations.length > 0);
    await waitFor('选定会话', () => js(`Boolean(document.getElementById('conversation-select').value)`));
    const conversationId = await js(`document.getElementById('conversation-select').value`);
    await chat('小璃，你还记得我们想做什么吗？');
    await waitFor('离线回复显示', async () => (await read('chat-messages')).includes('【离线演示】'));
    assert.equal(await js(`document.querySelector('.message-assistant [data-action="speech"]').disabled`), true);
    await fill('conversation-search', '不存在的会话 QA 搜索');
    assert.equal(await js(`document.querySelectorAll('#conversation-list .conversation-item').length`), 0);
    await fill('conversation-search', '');
    assert.ok(await js(`document.querySelectorAll('#conversation-list .conversation-item').length>0`));
    checks.push('通过真实输入框发送并显示明确离线回复');

    // Cold start with existing data must keep memories private to the active conversation.
    await window.loadURL(runtime.url);
    await waitFor('重载会话', async () => (await read('chat-messages')).includes('【离线演示】'));
    assert.equal(await js(`document.documentElement.dataset.theme`), 'dark');
    await click('#theme-toggle');
    checks.push('明暗主题真实切换，重载后保留选择');
    await view('memories');
    assert.equal(await js(`document.getElementById('memory-scope').value`), conversationId);
    await fill('memory-content', '念念希望角色的形象、声音与经历保持一致。');
    await submit('memory-form'); await formDone('memory-form');
    await waitFor('记忆保存', async () => (await state()).memories.some(m => m.content.includes('形象、声音') && m.conversationId === conversationId));
    checks.push('重载后直接添加记忆仍归属当前会话');
    await view('chat'); await click('.message-user [data-action="memory"]');
    assert.equal(await js(`document.getElementById('memory-scope').disabled`), true);
    assert.equal(await js(`document.getElementById('memory-scope').value`), conversationId);
    await fill('memory-content', '这条可删除的测试记忆只属于当前会话。');
    await submit('memory-form'); await formDone('memory-form');
    await waitFor('第二条记忆保存', async () => (await state()).memories.length === 2);
    await click('#memory-list .memory-item button'); await click('#memory-list .memory-item .delete-button');
    await waitFor('确认删除记忆', async () => (await state()).memories.length === 1);
    checks.push('从消息保存固定来源，确认删除真实持久化');
    await fill('memory-content', '第一条保存时仍然允许继续编辑。');
    await js(`window.__qaOriginalFetch=window.fetch;window.fetch=(url,options)=>url==='/api/memories'&&options?.method==='POST'?new Promise((resolve,reject)=>{window.__qaReleaseMemory=()=>window.__qaOriginalFetch(url,options).then(resolve,reject)}):window.__qaOriginalFetch(url,options);void 0`);
    await submit('memory-form');
    await waitFor('暂停的记忆请求', () => js(`typeof window.__qaReleaseMemory==='function'`));
    await fill('memory-content', '这条新的草稿不能被上一条保存结果清空。');
    await js(`window.__qaReleaseMemory();window.fetch=window.__qaOriginalFetch;void 0`);
    await formDone('memory-form');
    assert.equal(await js(`document.getElementById('memory-content').value`), '这条新的草稿不能被上一条保存结果清空。');
    await fill('memory-content', '');
    checks.push('慢请求期间新写的记忆草稿不会被保存回包清空');

    await view('connections'); await click('[data-config="llm"]');
    await fill('llm-base', baseUrl); await fill('llm-model', 'qa-fixture'); await fill('llm-key', 'isolated-qa-key');
    await submit('llm-form'); await formDone('llm-form');
    assert.equal((await state()).status.model, 'configured');
    assert.equal(await js(`document.getElementById('llm-key').value`), '');
    await chat('请带着刚才保存的记忆回应我。');
    await waitFor('模型回复显示', async () => (await read('chat-messages')).includes('本地接口联调服务'));
    assert.ok(calls.some(call => call.input.messages?.[0].content.includes('形象、声音')));
    await waitFor('可再次发送', () => js(`!document.getElementById('message-input').disabled`));
    await chat('QA模拟失败');
    await waitFor('失败保留输入', () => js(`!document.getElementById('composer-error').hidden && !document.getElementById('message-input').disabled`));
    assert.equal(await js(`document.getElementById('message-input').value`), 'QA模拟失败');
    await chat('服务恢复后继续交流。');
    await waitFor('恢复回复完成', () => js(`!document.getElementById('message-input').disabled && document.getElementById('message-input').value===''`));
    checks.push('配置密钥不回显，模型使用记忆，服务失败保留输入并可恢复');

    await view('connections'); await click('[data-config="tts"]');
    await fill('tts-base', baseUrl); await fill('tts-model', 'qa-speech'); await fill('tts-voice', 'qa-silent');
    await submit('tts-form'); await formDone('tts-form'); await view('chat');
    assert.equal(await js(`document.querySelector('.message-assistant [data-action="speech"]').disabled`), false);
    await click('.message-assistant [data-action="speech"]');
    await waitFor('语音播放器出现', () => js(`Boolean(document.querySelector('.message-audio'))`));
    assert.deepEqual(await js(`(()=>{const a=document.querySelector('.message-audio');return {paused:a.paused,autoplay:a.autoplay}})()`), { paused: true, autoplay: false });
    assert.equal(calls.filter(call => call.path === '/v1/audio/speech').length, 1);
    checks.push('保存 TTS 后旧消息按钮立即可用，fixture 音频持久化且不自动播放');
    await click('#new-conversation');
    await waitFor('新的演示会话', async () => (await js(`document.getElementById('conversation-select').value`)) !== conversationId);
    const presentationId = await js(`document.getElementById('conversation-select').value`);
    await chat('小璃，今天我们终于把想法变成了一点现实。');
    await waitFor('新会话回复', () => js(`document.querySelectorAll('.message-assistant').length===1 && !document.getElementById('message-input').disabled`));
    await shot('desktop');
    await click('#theme-toggle'); await shot('desktop-dark'); await click('#theme-toggle');

    await view('character');
    const originalDescription = (await state()).character.description;
    await fill('character-description', originalDescription + '【独立 QA 编辑验证】');
    await submit('character-form'); await formDone('character-form');
    assert.ok((await state()).character.description.includes('QA 编辑验证'));
    await fill('character-description', originalDescription); await submit('character-form'); await formDone('character-form');
    checks.push('独立角色设定页保存真实后端，不改变聊天历史');

    await view('connections'); await click('[data-config="qq"]');
    await fill('qq-private-allow', '90001'); await fill('qq-group-allow', '90002');
    await submit('qq-form'); await formDone('qq-form');
    await click('[data-config="sandbox"]');
    await fill('sandbox-channel', 'qq-group'); await fill('sandbox-peer', '90002'); await fill('sandbox-user', '90001'); await fill('sandbox-text', '普通群聊消息');
    await js(`document.getElementById('sandbox-mentioned').checked=false`); await submit('sandbox-form');
    await waitFor('无@消息忽略', async () => (await read('sandbox-message')).includes('未被处理'));
    await formDone('sandbox-form');
    await js(`document.getElementById('sandbox-mentioned').checked=true`); await submit('sandbox-form');
    await waitFor('群聊沙盒接受', () => js(`!document.getElementById('sandbox-open').hidden`));
    await formDone('sandbox-form'); await click('#sandbox-open');
    assert.ok((await read('chat-messages')).includes('[群成员 90001]'));
    await view('connections'); await click('[data-config="sandbox"]'); await fill('sandbox-channel', 'qq-private'); await fill('sandbox-peer', '90001'); await fill('sandbox-text', '你好，小璃。');
    await submit('sandbox-form'); await formDone('sandbox-form');
    await waitFor('私聊沙盒接受', async () => (await state()).conversations.some(c => c.channel === 'qq-private' && c.sandbox));
    assert.equal((await state()).status.qq, 'disconnected');
    checks.push('通过 UI 保存 QQ 名单，验证群聊@规则和私聊沙盒，全程未连接 QQ');

    await view('events'); assert.ok((await read('event-list')).includes('沙盒'));
    await fill('conversation-select', presentationId);
    window.setMinimumSize(320, 400); window.setContentSize(390, 844); await pause(250);
    const mobile = await js(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`);
    assert.ok(mobile.scroll <= mobile.width, JSON.stringify(mobile)); await shot('mobile');
    await click('#theme-toggle'); await shot('mobile-dark'); await click('#theme-toggle');
    await click('#toggle-inspector');
    assert.equal(await js(`document.getElementById('character-panel').hidden`), false);
    await click('#close-inspector');
    assert.equal(await js(`document.getElementById('character-panel').hidden`), true);
    await view('connections'); await click('[data-config="tts"]');
    const mobileSettings = await js(`({width:innerWidth,scroll:document.documentElement.scrollWidth})`);
    assert.ok(mobileSettings.scroll <= mobileSettings.width, JSON.stringify(mobileSettings)); await shot('mobile-connections');
    checks.push('390px 聊天和连接页无页面横向溢出，明暗主题及角色浮层可用，运行记录包含真实事件');

    window.setContentSize(1360, 850); await pause(200); await view('stage');
    const current = await state(); assert.equal(current.status.airi.available, true);
    await waitFor('AIRI 舞台真实就绪', async () => (await read('stage-state-text')).includes('已就绪'), 55000);
    await waitFor('AIRI WebGL Canvas', () => js(`(()=>{const c=document.querySelector('#stage-surface iframe')?.contentDocument?.querySelector('canvas');return Boolean(c&&c.width>0&&c.height>0)})()`));
    await pause(3500);
    const stage = await js(`(()=>{const f=document.querySelector('#stage-surface iframe');return {status:document.getElementById('stage-state-text').textContent,canvas:!!f.contentDocument.querySelector('canvas'),resources:f.contentWindow.performance.getEntriesByType('resource').filter(x=>/vrm|idle/i.test(x.name)).map(x=>({name:x.name.split('/').pop(),bytes:x.transferSize}))}})()`);
    await shot('airi'); checks.push('工作台内 AIRI iframe 渲染真实 Canvas、VRM 示例与动画资源');
    assert.equal(errors.length, 0, errors.join('\n'));
    writeFileSync(join(qaDir, 'http-ui-report.json'), JSON.stringify({ checks, fixtureCalls: calls.map(call => call.path), mobile, mobileSettings, stage, errors, airi: current.status.airi, scope: '真实本地 HTTP 与隐藏 Electron 控件操作；模型和语音使用隔离 fixture；QQ 仅沙盒；未连接真实 QQ 或播放音频。' }, null, 2), 'utf8');
  } finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
}
