import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function readPngCard(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], '下载内容必须是 PNG');
  let offset = 8, width = 0, height = 0, ended = false;
  const cards = new Map();
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length, 'PNG 数据块完整');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + length), `PNG ${type} 校验`);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      const key = data.toString('latin1', 0, separator);
      if (separator > 0 && ['chara', 'ccv3'].includes(key)) cards.set(key, JSON.parse(Buffer.from(data.subarray(separator + 1).toString('latin1'), 'base64').toString('utf8')));
    }
    offset += length + 12;
    if (type === 'IEND') { ended = true; break; }
  }
  assert.ok(ended && width > 0 && height > 0, 'PNG 应有尺寸和完整结束块');
  assert.equal(offset, bytes.length, 'PNG 结束后没有多余数据');
  const card = cards.get('ccv3') || cards.get('chara');
  assert.ok(card, 'PNG 必须包含角色卡元数据');
  return { card, width, height };
}

// Called only by the isolated Electron workbench QA. No live profile or model is used.
export async function runCardStudioQa({ window, runtime, qaDir, js, click, fill, waitFor, shot, view, checks }) {
  const name = '整合验证 中文人设';
  const importedName = '整合验证 PNG导入';
  const description = '星禾是住在沿海小城的成年修复师。她习惯先认真听完来访者的故事，再修补旧物。\n她的笔记里保留着海风、旧书与每个人亲自确认的称呼。';
  const firstMessage = '“你来啦。”星禾放下手里的旧书，为 {{user}} 拉开窗边的椅子。\n“今天想从哪一页开始？”';
  const chatDraft = '尚未发送的聊天草稿：下次再讨论她如何面对一次失败。';
  const editorDraft = description + '\n这是尚未保存到正文的新想法，仅保留在编辑草稿中。';
  const localChecks = [];
  const downloads = [];
  const requests = [];
  const responses = [];
  const snapshots = [];
  const failureInjections = [];
  let interceptionEnabled = false;
  let interceptedDocuments = 0;
  let interceptionError;
  const originalTheme = await js('document.documentElement.dataset.theme');
  const originalSize = window.getContentSize();
  const originalMinimum = window.getMinimumSize();
  let stage = '打开作品列表';
  const frame = code => js(`(async()=>{const editor=document.querySelector('#card-studio-frame')?.contentWindow;if(!editor)throw new Error('角色卡 iframe 不存在');const doc=editor.document;${code}})()`);
  const frameClick = selector => frame(`const target=doc.querySelector(${JSON.stringify(selector)});if(!target)throw new Error('找不到控件：'+${JSON.stringify(selector)});target.click();`);
  const frameFill = (selector, value) => frame(`const target=doc.querySelector(${JSON.stringify(selector)});if(!target)throw new Error('找不到输入框：'+${JSON.stringify(selector)});target.value=${JSON.stringify(value)};target.dispatchEvent(new editor.Event('input',{bubbles:true}));target.dispatchEvent(new editor.Event('change',{bubbles:true}));`);
  const buttonText = (selector, text) => frame(`const target=Array.from(doc.querySelectorAll(${JSON.stringify(selector)})).find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!target)throw new Error('找不到按钮：'+${JSON.stringify(text)});target.click();`);
  const record = message => { localChecks.push(message); checks.push(message); };
  const request = async path => {
    const response = await fetch(runtime.url + '/card-studio/api/' + path);
    assert.equal(response.status, 200, `只读验证 ${path}`);
    return response.json();
  };
  const cardTree = cardName => request('card/' + encodeURIComponent(cardName));
  const ready = async cardName => {
    await waitFor('角色卡 iframe 已创建', () => js(`!!document.querySelector('#card-studio-frame')`), 30000);
    await waitFor('角色卡编辑器打开 ' + cardName, () => frame(`return !!editor.__workbenchReady?.()&&editor.state.name===${JSON.stringify(cardName)}&&!!editor.state.tree&&!!doc.querySelector('#chat-input');`), 30000);
  };
  const network = (_event, method, parameters) => {
    if (method === 'Network.requestWillBeSent') {
      const url = new URL(parameters.request.url);
      if (url.pathname.startsWith('/card-studio/')) requests.push({ id:parameters.requestId, url:parameters.request.url, method:parameters.request.method });
    }
    if (method === 'Network.responseReceived' && new URL(parameters.response.url).pathname.startsWith('/card-studio/')) responses.push({ url:parameters.response.url, status:parameters.response.status, type:parameters.response.mimeType });
    if (method === 'Network.eventSourceMessageReceived' && parameters.eventName === 'snapshot') snapshots.push(parameters.data);
  };
  const onDownload = (_event, item) => {
    const fileName = item.getFilename();
    if (!fileName.startsWith(name + '.')) return;
    item.once('done', (_doneEvent, result) => downloads.push({ fileName, path:item.getSavePath(), result }));
  };
  const interceptDocument = (_event, method, parameters) => {
    if (method !== 'Fetch.requestPaused') return;
    const command = interceptedDocuments++ === 0
      ? window.webContents.debugger.sendCommand('Fetch.fulfillRequest', {
        requestId:parameters.requestId, responseCode:503, responsePhrase:'Service Unavailable',
        responseHeaders:[{name:'Content-Type', value:'text/html; charset=utf-8'}],
        body:Buffer.from('<!doctype html><html lang="zh-CN"><body>隔离验证：首次编辑器页面载入失败。</body></html>').toString('base64'),
      })
      : window.webContents.debugger.sendCommand('Fetch.continueRequest', { requestId:parameters.requestId });
    command.catch(error => { interceptionError = error; });
  };
  window.webContents.debugger.on('message', network);
  window.webContents.session.on('will-download', onDownload);

  async function editField(label, key) {
    if (await frame(`return editor.state.mode!=='edit';`)) await frameClick('#btn-mode');
    await waitFor('编辑模式', () => frame(`return editor.state.mode==='edit'&&!!doc.querySelector('#btn-edit-picker');`));
    await frameClick('#btn-edit-picker');
    await buttonText('#picker-pop button', label);
    await waitFor('打开字段 ' + key, () => frame(`return editor.state.view?.key===${JSON.stringify(key)}&&!!doc.querySelector('#pane textarea');`));
  }
  async function saveField(label, key, value) {
    await editField(label, key);
    await frameFill('#pane textarea', value);
    await buttonText('#pane button', '保存');
    await waitFor('正文保存 ' + key, async () => (await cardTree(name)).texts[key] === value);
    await waitFor('保存后编辑器恢复', () => frame(`return editor.state.tree?.texts?.[${JSON.stringify(key)}]===${JSON.stringify(value)}&&!!doc.querySelector('#pane textarea');`));
  }
  async function theme(value) {
    if (await js('document.documentElement.dataset.theme') !== value) await click('#theme-toggle');
    await waitFor('工作室主题 ' + value, () => frame(`return document.documentElement.dataset.theme===${JSON.stringify(value)}&&doc.documentElement.classList.contains('dark')===${value === 'dark'};`));
    await waitFor('主题已保存', async () => {
      const response = await fetch(runtime.url + '/api/state');
      return (await response.json()).preferences.theme === value;
    });
  }
  async function openFromLibrary(cardName) {
    const selector = '[data-edit-card=' + JSON.stringify(cardName) + ']';
    await waitFor('作品列表包含 ' + cardName, () => js(`!!document.querySelector(${JSON.stringify(selector)})`));
    await click(selector);
    await ready(cardName);
  }
  async function noOverflow() {
    const bounds = await frame(`const input=doc.querySelector('#pane textarea');const box=input?.getBoundingClientRect();return {host:document.documentElement.scrollWidth<=innerWidth,frame:doc.documentElement.scrollWidth<=editor.innerWidth,input:!box||(box.left>=-1&&box.right<=editor.innerWidth+1),width:editor.innerWidth};`);
    assert.ok(bounds.host && bounds.frame && bounds.input, '角色卡页面横向溢出或编辑框被裁切：' + JSON.stringify(bounds));
  }
  const report = extra => writeFileSync(join(qaDir, 'card-studio-result.json'), JSON.stringify({
    ...extra, checks:localChecks, downloads:downloads.map(item => ({ fileName:item.fileName, savedAs:basename(item.path), result:item.result })),
    requests, responses, sseSnapshotCount:snapshots.length, failureInjections,
    realCardCreateEditBuildDownload:localChecks.some(item => item.startsWith('真实检查与生成通过')), realModelMessagesSent:false, appProcessRestartTested:false,
    evidence:'用户界面执行新建、正文编辑保存、检查、生成、下载、文件输入导入和导航；HTTP GET 仅用于独立回读。字体加载使用浏览器 FontFaceSet，重载使用公开草稿钩子后重新载入窗口。',
  }, null, 2) + '\n', 'utf8');

  try {
    await view('module/cards');
    await waitFor('作品列表可操作', () => js(`!!document.querySelector('#create-card')&&!!document.querySelector('#card-list')&&!document.querySelector('#card-list').textContent.includes('正在读取')`), 30000);
    assert.equal((await request('cards')).length, 0, '卡片验证必须使用空的隔离工作区');
    stage = '新建角色卡';
    await click('#create-card');
    await fill('#new-card-name', name);
    await js(`document.querySelector('.card-create-dialog form').requestSubmit();void 0`);
    await waitFor('新建后 iframe', () => js(`!!document.querySelector('#card-studio-frame')`), 30000);
    await ready(name);
    stage = '模块 AI 接入浮层';
    await frameClick('#btn-chat-settings');
    await waitFor('角色卡打开本模块 AI 浮层', () => js(`location.hash==='#/module/cards'&&!!document.querySelector('#cards-ai-form')`));
    assert.equal(await js(`document.querySelectorAll('#cards-ai-form').length`), 1);
    window.setMinimumSize(360,500);window.setContentSize(390,844);await pause(200);
    assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);
    await shot('module-ai-settings-mobile');
    await click('[data-module-ai-popover="cards"] [data-ai-close]');
    window.setContentSize(...originalSize);window.setMinimumSize(...originalMinimum);
    await view('module/cards');await ready(name);
    record('角色卡编辑器接入按钮打开右上同一模块浮层，390px 无横向溢出；原编辑器和草稿保持');
    stage = '正文编辑与保存';
    await saveField('描述', 'description', description);
    await saveField('开场白', 'first_mes', firstMessage);
    record('角色卡模块通过真实界面创建中文作品并分别编辑保存描述与开场白，HTTP 回读一致');

    stage = '检查和生成成品';
    await frameClick('#btn-workspace');
    await frameClick('#btn-check');
    await waitFor('角色卡检查通过', () => frame(`return doc.querySelector('#log').textContent.includes('CHECK OK');`));
    await frameClick('#btn-build');
    await waitFor('生成后成品窗口', () => frame(`return !!doc.querySelector('#artifact-dialog')&&!!Array.from(doc.querySelectorAll('#artifact-dialog button')).find(button=>button.textContent==='下载 JSON');`), 30000);
    await buttonText('#artifact-dialog button', '下载 JSON');
    await waitFor('JSON 实际下载完成', () => downloads.some(item => item.fileName.endsWith('.json')));
    await buttonText('#artifact-dialog button', '下载 PNG');
    await waitFor('PNG 实际下载完成', () => downloads.some(item => item.fileName.endsWith('.png')));
    assert.ok(downloads.every(item => item.result === 'completed'));
    const jsonDownload = downloads.find(item => item.fileName.endsWith('.json'));
    const pngDownload = downloads.find(item => item.fileName.endsWith('.png'));
    const built = JSON.parse(readFileSync(jsonDownload.path, 'utf8'));
    const pngBytes = readFileSync(pngDownload.path);
    const png = readPngCard(pngBytes);
    assert.equal(built.data.name, name);
    assert.equal(built.data.description, description);
    assert.equal(built.data.first_mes, firstMessage);
    assert.deepEqual(png.card, built, 'PNG 内嵌卡片与 JSON 下载内容应一致');
    await buttonText('#artifact-dialog button', '关闭');
    record('真实检查与生成通过；下载按钮得到 JSON 和 PNG，PNG 各数据块 CRC、尺寸和内嵌角色卡与 JSON 一致');

    stage = '头像、字体与流式路径';
    if (await frame(`return editor.state.mode!=='make';`)) await frameClick('#btn-mode');
    stage = '多个人设管理';
    assert.equal((await request('persona')).activeId, 'neutral');
    assert.equal(await frame(`return doc.title;`), '角色卡创作');
    assert.ok((await frame(`return doc.querySelector('#chat-input').placeholder;`)).startsWith('这次想写什么'));
    // Hold a committed selection response to exercise the former overlapping-mutation window.
    await frame(`editor.__qaSwitchFetch=editor.fetch;editor.fetch=async function(input,options){const response=await editor.__qaSwitchFetch(input,options);if(typeof input==='string'&&input.endsWith('/api/persona')&&options?.method==='POST'){await new Promise(resolve=>{editor.__qaReleaseSwitch=resolve;});}return response;};`);
    await frameFill('#persona-select', 'xiaoxi');
    await waitFor('顶部人设选择已提交但响应暂缓', () => frame(`return typeof editor.__qaReleaseSwitch==='function';`));
    assert.equal((await request('persona')).activeId, 'xiaoxi');
    assert.equal(await frame(`return doc.querySelector('#btn-personas').disabled;`), true);
    assert.equal(await frame(`editor.personaManager.open();return !!doc.querySelector('#persona-manager');`), false);
    await frame(`editor.fetch=editor.__qaSwitchFetch;editor.__qaReleaseSwitch();`);
    await waitFor('释放切换响应后界面与磁盘一致', () => frame(`return editor.state.personaId==='xiaoxi'&&!editor.state.personaSwitching&&!doc.querySelector('#btn-personas').disabled;`));
    await frameFill('#persona-select', 'neutral');
    await waitFor('恢复中性助手', () => frame(`return editor.state.personaId==='neutral'&&!editor.state.personaSwitching;`));
    record('暂缓已提交的顶部人设切换响应时，管理入口和直接打开均被阻止；释放后界面与持久选择一致');
    await frameClick('#btn-personas');
    assert.equal(await frame(`return doc.querySelector('#persona-name').readOnly;`), true);
    await frameClick('#persona-new');
    await frameFill('#persona-name', '叙事顾问');
    await frameFill('#persona-prompt', '语言简洁，重视人物行动。');
    // Fail one actual save request and verify the entered text stays available.
    await frame(`editor.__qaPersonaFetch=editor.fetch;editor.fetch=async function(input,options){if(typeof input==='string'&&input.endsWith('/api/personas')&&options?.method==='POST'){editor.fetch=editor.__qaPersonaFetch;return new editor.Response(JSON.stringify({error:'隔离验证：暂时无法保存'}),{status:503,headers:{'Content-Type':'application/json'}});}return editor.__qaPersonaFetch(input,options);};`);
    await frame(`doc.querySelector('#persona-form').requestSubmit();`);
    await waitFor('人设保存失败保留输入', () => frame(`return doc.querySelector('#persona-feedback').textContent.includes('暂时无法保存')&&!doc.querySelector('#persona-save').disabled;`));
    assert.equal(await frame(`return doc.querySelector('#persona-prompt').value;`), '语言简洁，重视人物行动。');
    assert.equal(await frame(`try{await editor.__flushDrafts();return false;}catch(error){return error.message.includes('人设修改尚未保存');}`), true);
    await frame(`doc.querySelector('#persona-form').requestSubmit();`);
    await waitFor('第一个人设保存', () => frame(`return editor.state.personaOptions.some(item=>item.name==='叙事顾问')&&!doc.querySelector('#persona-save').disabled;`));
    const personaOne = (await request('persona')).personas.find(item => item.name === '叙事顾问').id;
    await frameClick('#persona-use');
    await waitFor('使用第一个自定义人设', () => frame(`return editor.state.personaId===${JSON.stringify(personaOne)}&&!doc.querySelector('#persona-close').disabled;`));
    await frameClick('#persona-new');
    await frameFill('#persona-name', '世界编辑');
    await frameFill('#persona-prompt', '先核对世界规则，再讨论情节。');
    await frame(`doc.querySelector('#persona-form').requestSubmit();`);
    await waitFor('第二个人设保存', () => frame(`return editor.state.personaOptions.some(item=>item.name==='世界编辑')&&!doc.querySelector('#persona-save').disabled;`));
    const personaTwo = (await request('persona')).personas.find(item => item.name === '世界编辑').id;
    await frameFill('#persona-list', personaOne);
    await frameFill('#persona-name', '叙事顾问新版');
    await frame(`doc.querySelector('#persona-form').requestSubmit();`);
    await waitFor('自定义人设编辑保存', () => frame(`return editor.state.personaName==='叙事顾问新版'&&!doc.querySelector('#persona-save').disabled;`));
    await theme('light'); await shot('personas-light');
    await theme('dark'); await shot('personas-dark');
    window.setMinimumSize(360, 500); window.setContentSize(390, 844); await pause(250);
    assert.equal(await frame(`const panel=doc.querySelector('#persona-manager');return panel.scrollWidth<=panel.clientWidth&&doc.documentElement.scrollWidth<=editor.innerWidth;`), true);
    await shot('personas-mobile-390');
    window.setContentSize(...originalSize); window.setMinimumSize(...originalMinimum); await pause(200); await theme(originalTheme);
    await frameClick('#persona-close');
    await frameFill('#persona-select', personaTwo);
    await waitFor('切换第二个人设', () => frame(`return editor.state.personaId===${JSON.stringify(personaTwo)}&&!editor.state.personaSwitching;`));
    await js(`window.__qaPersonaDocument=document.querySelector('#card-studio-frame').contentDocument;void 0`);
    await frame(`await editor.__flushDrafts();editor.location.reload();`);
    await waitFor('人设重载生成新文档', () => frame(`return doc!==window.__qaPersonaDocument&&!!editor.__workbenchReady?.();`));
    await ready(name);
    await waitFor('重载恢复人设', () => frame(`return editor.state.personaId===${JSON.stringify(personaTwo)}&&editor.state.personaOptions.some(item=>item.name==='叙事顾问新版');`));
    await frameClick('#btn-personas');
    await frameClick('#persona-delete');
    assert.equal(await frame(`return doc.querySelector('#persona-delete-confirm').hidden;`), false);
    await frameClick('#persona-delete-final');
    await waitFor('删除当前人设回到中性', () => frame(`return editor.state.personaId==='neutral'&&!editor.state.personaOptions.some(item=>item.id===${JSON.stringify(personaTwo)})&&!doc.querySelector('#persona-close').disabled;`));
    await frameClick('#persona-close');
    const remainingPersonas = await request('persona');
    assert.equal(remainingPersonas.personas.find(item => item.id === personaOne).name, '叙事顾问新版');
    assert.ok(remainingPersonas.personas.some(item => item.id === 'xiaoxi'));
    assert.ok(remainingPersonas.personas.some(item => item.id === 'momo'));
    record('默认中性；真实界面新增两个人设、编辑、切换、重载恢复与删除当前项回退；保存失败保留输入并阻止未保存离开；内置小汐和茉茉保留，明暗主题与390px管理窗口通过');
    stage = '头像、字体与流式路径';
    await frameFill('#persona-select', 'momo');
    await waitFor('茉茉人设已切换', () => frame(`return editor.state.personaId==='momo'&&!editor.state.personaSwitching;`));
    if (!await frame(`return editor.state.workspaceOpen;`)) await frameClick('#btn-workspace');
    await frameClick('#btn-workspace-avatar');
    await waitFor('茉茉默认头像实际载入', () => frame(`const row=Array.from(doc.querySelectorAll('.avatar-dialog-row')).find(node=>node.querySelector('.avatar-name')?.textContent==='茉茉');const img=row?.querySelector('img');return !!img&&img.complete&&img.naturalWidth>0&&new URL(img.src).pathname==='/card-studio/api/chat-avatar/momo';`));
    await buttonText('#chat-avatar-dialog button', '完成');
    const fontFaces = await frame(`return (await doc.fonts.load('400 14px "Xiaoxi Noto Sans"')).length;`);
    assert.ok(fontFaces > 0, '内置字体应能从前缀 URL 实际加载');
    await waitFor('SSE 初始化快照', () => snapshots.length > 0);
    assert.ok(responses.some(item => new URL(item.url).pathname === '/card-studio/api/ui-font/regular' && item.status === 200));
    assert.ok(responses.some(item => new URL(item.url).pathname === '/card-studio/api/chat-avatar/momo' && item.status === 200));
    record('选择茉茉后头像真实解码；内置字体 URL 加载成功，原聊天控制器收到同源 SSE 初始化快照，未发送模型消息');

    stage = '草稿跨模块保留';
    await frameFill('#chat-input', chatDraft);
    await editField('描述', 'description');
    await frameFill('#pane textarea', editorDraft);
    await js(`window.__qaCardDocument=document.querySelector('#card-studio-frame').contentDocument;void 0`);
    await view('module/drawing');
    await view('module/cards');
    assert.equal(await js(`window.__qaCardDocument===document.querySelector('#card-studio-frame').contentDocument`), true, '切换模块不能重建 iframe 文档');
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), editorDraft);
    await frameClick('#btn-mode');
    await waitFor('聊天草稿恢复', () => frame(`return doc.querySelector('#chat-input')?.value===${JSON.stringify(chatDraft)};`));
    await editField('描述', 'description');
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), editorDraft);
    assert.equal((await cardTree(name)).texts.description, description, '草稿不能自动写入正式正文');
    record('携带聊天和正文草稿切换绘图模块再返回，iframe 文档身份保持，草稿保留且正文没有被自动覆盖');

    stage = '主题与窄屏布局';
    await theme('light'); await noOverflow(); await shot('card-studio-light');
    await theme('dark'); await noOverflow(); await shot('card-studio-dark');
    window.setMinimumSize(360, 500); window.setContentSize(390, 844); await pause(250);
    await noOverflow(); await shot('card-studio-mobile-390');
    window.setContentSize(...originalSize); window.setMinimumSize(...originalMinimum); await pause(200);
    await theme(originalTheme);
    record('角色卡编辑器跟随宿主浅深色主题，桌面与 390px 窗口无横向溢出，已保存截图');

    stage = '从宿主列表导入 PNG';
    await click('#back-to-cards');
    await waitFor('返回宿主作品列表', () => js(`!document.querySelector('#card-library').hidden&&document.querySelector('#card-editor').hidden`));
    assert.equal(await js(`window.__qaCardDocument===document.querySelector('#card-studio-frame').contentDocument`), true);
    await shot('card-studio-library');
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(pngBytes.toString('base64'))}),char=>char.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(importedName + '.png')},{type:'image/png'}));const input=document.querySelector('#card-import-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await ready(importedName);
    const imported = await cardTree(importedName);
    // Upstream import writes canonical Markdown with a final newline.
    assert.equal(imported.texts.description.trimEnd(), description.trimEnd());
    assert.equal(imported.texts.first_mes.trimEnd(), firstMessage.trimEnd());
    await click('#back-to-cards');
    await openFromLibrary(name);
    await editField('描述', 'description');
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), editorDraft);
    record('返回宿主列表后通过实际文件输入导入下载 PNG，描述和开场白保持，重新打开原作品仍保留编辑草稿');

    stage = '重载后恢复草稿';
    await js(`window.__workbenchFlushDrafts();`);
    await window.loadURL(runtime.url);
    await waitFor('工作台重载完成', () => js(`document.querySelector('#app-shell')?.getAttribute('aria-busy')==='false'`));
    await view('module/cards');
    await openFromLibrary(name);
    await waitFor('重载恢复聊天草稿', () => frame(`return doc.querySelector('#chat-input')?.value===${JSON.stringify(chatDraft)};`));
    await editField('描述', 'description');
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), editorDraft);
    assert.equal((await cardTree(name)).texts.description, description);
    await shot('card-studio-reloaded-drafts');
    record('窗口重新载入后打开原作品，未发送聊天与未保存正文草稿均从磁盘恢复；此项未重启宿主进程');

    stage = '草稿保存失败时阻止导航并重试';
    const failedSaveDraft = editorDraft + '\n用于验证保存失败时保留当前页面。';
    await js(`window.__qaCardDocument=document.querySelector('#card-studio-frame').contentDocument;void 0`);
    await frame(`editor.__qaSavedFetch=editor.fetch;editor.__qaRejectedDrafts=0;editor.fetch=(input,options)=>{const path=typeof input==='string'?new URL(input,editor.location.href).pathname:'';if(path.endsWith('/api/ui-drafts')&&options?.method==='POST'){editor.__qaRejectedDrafts++;return Promise.resolve(new editor.Response(JSON.stringify({error:'隔离验证：草稿保存暂时不可用'}),{status:503,headers:{'content-type':'application/json'}}));}return editor.__qaSavedFetch(input,options);};`);
    failureInjections.push({ kind:'draft-save', mechanism:'仅在 iframe fetch 中返回 503，未发出故障写请求' });
    await frameFill('#pane textarea', failedSaveDraft);
    await js(`location.hash='/module/drawing';void 0`);
    await waitFor('保存失败仍留在角色卡页面', () => js(`location.hash==='#/module/cards'&&!document.querySelector('#cards-content').hidden&&document.querySelector('#toast-text').textContent.includes('隔离验证：草稿保存暂时不可用')`));
    assert.equal(await js(`window.__qaCardDocument===document.querySelector('#card-studio-frame').contentDocument`), true);
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), failedSaveDraft);
    assert.equal(await frame(`return !document.body.inert&&!doc.body.inert&&editor.__qaRejectedDrafts>0;`), true);
    await frame(`editor.fetch=editor.__qaSavedFetch;delete editor.__qaSavedFetch;`);
    await frameClick('#draft-status');
    await waitFor('重试草稿保存成功', () => frame(`return !editor.draftPersistence.error&&!editor.draftPersistence.pending.size&&!editor.draftPersistence.flight;`));
    await view('module/drawing'); await view('module/cards');
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), failedSaveDraft);
    record('注入草稿保存失败后导航被阻止且页面、输入保持；点击草稿状态重试成功后可以正常切换模块');

    stage = '移除入口等待草稿且冻结输入，重新启用恢复';
    const removalDraft = failedSaveDraft + '\n用于验证移除入口等待保存完成。';
    await frame(`editor.__qaSavedFetch=editor.fetch;editor.fetch=(input,options)=>{const path=typeof input==='string'?new URL(input,editor.location.href).pathname:'';if(path.endsWith('/api/ui-drafts')&&options?.method==='POST')return new Promise((resolve,reject)=>{editor.__qaReleaseDraft=()=>editor.__qaSavedFetch(input,options).then(resolve,reject);});return editor.__qaSavedFetch(input,options);};`);
    failureInjections.push({ kind:'draft-delay', mechanism:'暂停 iframe 草稿 POST，检查输入冻结后放行真实保存' });
    await frameFill('#pane textarea', removalDraft);
    await frame(`doc.querySelector('#pane textarea').focus();`);
    await click('#cards-content #remove-module');
    await waitFor('移除期间两个页面均冻结输入', () => frame(`return document.body.inert&&doc.body.inert&&typeof editor.__qaReleaseDraft==='function';`));
    const pendingState = await (await fetch(runtime.url + '/api/state')).json();
    assert.equal(pendingState.modules.find(module => module.id === 'cards').enabled, true, '草稿保存完成前不能移除入口');
    await window.webContents.debugger.sendCommand('Input.insertText', { text:'不应进入冻结输入框' });
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), removalDraft, '移除等待期间不接受键盘输入');
    await frame(`const release=editor.__qaReleaseDraft;editor.fetch=editor.__qaSavedFetch;release();delete editor.__qaReleaseDraft;`);
    await waitFor('移除完成后主页恢复输入', () => js(`location.hash==='#/home'&&!document.body.inert&&!document.querySelector('[data-module-nav="cards"]')`));
    await view('catalog');
    await click('[data-add="cards"]');
    await waitFor('角色卡入口重新启用', () => js(`!!document.querySelector('[data-module-nav="cards"]')`));
    await view('module/cards'); await ready(name);
    assert.equal(await frame(`return !document.body.inert&&!doc.body.inert&&!editor.__discardDraftsOnExit;`), true, '重新启用后必须解除退出冻结');
    assert.equal(await js(`window.__qaCardDocument===document.querySelector('#card-studio-frame').contentDocument`), true);
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), removalDraft);
    assert.equal((await cardTree(name)).texts.description, description);
    record('移除入口等待真实草稿保存时宿主和编辑器均冻结，输入未变化；重新启用解除冻结并保留同一文档与草稿');

    stage = '首次 iframe 载入失败后重新打开';
    await js(`window.__workbenchFlushDrafts();`);
    await window.loadURL(runtime.url);
    await waitFor('故障验证重载完成', () => js(`document.querySelector('#app-shell')?.getAttribute('aria-busy')==='false'`));
    await view('module/cards');
    const openSelector = '[data-edit-card=' + JSON.stringify(name) + ']';
    await waitFor('故障验证作品列表', () => js(`!!document.querySelector(${JSON.stringify(openSelector)})`));
    window.webContents.debugger.on('message', interceptDocument);
    await window.webContents.debugger.sendCommand('Fetch.enable', { patterns:[{urlPattern:runtime.url + '/card-studio/', resourceType:'Document', requestStage:'Request'}] });
    interceptionEnabled = true;
    failureInjections.push({ kind:'initial-document', mechanism:'CDP Fetch 为首次 iframe 文档返回 HTTP 503，保留宿主 webRequest 监听' });
    await click(openSelector);
    await waitFor('首次载入失败提示且无效 iframe 已清除', async () => {
      if (interceptionError) throw interceptionError;
      return interceptedDocuments === 1 && await js(`!document.querySelector('#card-studio-frame')&&document.querySelector('#card-feedback').textContent.includes('创作页未能载入')&&!document.querySelector('#card-library').hidden`);
    }, 22000);
    await window.webContents.debugger.sendCommand('Fetch.disable'); interceptionEnabled = false;
    window.webContents.debugger.off('message', interceptDocument);
    await openFromLibrary(name);
    await editField('描述', 'description');
    assert.equal(await frame(`return doc.querySelector('#pane textarea').value;`), removalDraft);
    await shot('card-studio-recovered-load');
    record('首次 iframe 文档注入 HTTP 503 后显示可重试错误并移除无效页面，再次打开真实编辑器恢复且草稿仍在');
    assert.equal(requests.some(item => item.method === 'POST' && /^\/card-studio\/api\/chat(?:\/|$)/.test(new URL(item.url).pathname)), false, '验收禁止发送真实聊天消息');
    const httpFailures = responses.filter(item => item.status >= 400);
    assert.ok(httpFailures.length <= 1 && httpFailures.every(item => item.status === 503 && new URL(item.url).pathname === '/card-studio/'), '仅允许主动注入的一次 iframe 503：' + JSON.stringify(httpFailures));
    report({ ok:true, stage:'完成', png:{width:png.width, height:png.height}, cardCount:(await request('cards')).length });
  } catch (error) {
    report({ ok:false, stage, error:error.stack || error.message });
    await shot('card-studio-failure').catch(() => {});
    throw new Error(`角色卡界面验收失败（${stage}）：${error.message}`, { cause:error });
  } finally {
    if (interceptionEnabled) await window.webContents.debugger.sendCommand('Fetch.disable').catch(() => {});
    window.webContents.debugger.off('message', interceptDocument);
    await js(`(()=>{const editor=document.querySelector('#card-studio-frame')?.contentWindow;if(!editor)return;if(editor.__qaSavedFetch)editor.fetch=editor.__qaSavedFetch;editor.__qaReleaseDraft?.();})()`).catch(() => {});
    window.webContents.debugger.off('message', network);
    window.webContents.session.off('will-download', onDownload);
    window.setContentSize(...originalSize); window.setMinimumSize(...originalMinimum);
  }
}
