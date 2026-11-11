export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function endpoint(baseUrl, suffix) { return `${baseUrl.replace(/\/+$/, '')}/${suffix}`; }

async function providerFetch(url, options, signal) {
  try {
    return await fetch(url, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) });
  } catch {
    throw new AppError(502, '服务连接失败或请求超时，请检查接口地址与服务状态。');
  }
}

function headers(apiKey) { return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }; }

async function readBounded(response, limit) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw new AppError(502, '服务返回了空响应。');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new AppError(502, '服务响应超过允许大小。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function modelReply(config, messages, signal) {
  const response = await providerFetch(endpoint(config.baseUrl, 'chat/completions'), {
    method: 'POST', headers: headers(config.apiKey),
    body: JSON.stringify({ model: config.model, messages, stream: false }),
  }, signal);
  if (!response.ok) { await response.body?.cancel(); throw new AppError(502, `模型服务返回 HTTP ${response.status}，此次回复未生成。`); }
  let value;
  try { value = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof AppError) throw error; throw new AppError(502, '模型服务返回了无效 JSON。'); }
  const content = value?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new AppError(502, '模型服务没有返回可用的文字回复。');
  if (content.length > 32_000) throw new AppError(502, '模型回复过长，请调整上游服务的输出长度。');
  return content.trim();
}

export async function synthesize(config, text, signal) {
  const response = await providerFetch(endpoint(config.baseUrl, 'audio/speech'), {
    method: 'POST', headers: headers(config.apiKey),
    body: JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: 'wav' }),
  }, signal);
  if (!response.ok) { await response.body?.cancel(); throw new AppError(502, `语音服务返回 HTTP ${response.status}，此次音频未生成。`); }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const extensions = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a' };
  if (!extensions[mime]) { await response.body?.cancel(); throw new AppError(502, '语音服务未返回可识别的音频类型。'); }
  const bytes = await readBounded(response, 25 * 1024 * 1024);
  if (!bytes.length) throw new AppError(502, '语音服务返回了空音频。');
  return { bytes, mime, extension: extensions[mime] };
}
