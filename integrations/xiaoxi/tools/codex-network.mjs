import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import path from 'node:path';

const executeFile = promisify(execFile);
const PROXY_KEY = /^(?:http|https|all)_proxy$/i;
const NO_PROXY_KEY = /^no_proxy$/i;
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];
const SYSTEM_PROXY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  "$settings = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'",
  '[ordered]@{ ProxyEnable = [int]$settings.ProxyEnable; ProxyServer = [string]$settings.ProxyServer; ProxyOverride = [string]$settings.ProxyOverride; AutoConfigURL = [string]$settings.AutoConfigURL; AutoDetect = [int]$settings.AutoDetect } | ConvertTo-Json -Compress',
].join('\n');

export function normalizeLocalProxyUrl(value) {
  const fail = () => { throw new Error('本地代理需填写 http:// 或 https:// 的 localhost、127.0.0.1 或 [::1] 地址及有效端口，不能带账号、路径或参数'); };
  if (typeof value !== 'string') return fail();
  const text = value.trim();
  if (!text) return '';
  const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/i.exec(text);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return fail();
  return match[1].toLowerCase() + '://' + match[2].toLowerCase() + ':' + Number(match[3]);
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![0, 1].includes(value.ProxyEnable)
    || ['ProxyServer', 'ProxyOverride', 'AutoConfigURL'].some(key => value[key] !== undefined
      && (typeof value[key] !== 'string' || value[key].length > 8192 || /[\u0000-\u001f]/.test(value[key])))
    || (value.AutoDetect !== undefined && ![0, 1].includes(value.AutoDetect))) {
    throw new Error('Windows 系统代理设置格式不正确，请检查代理客户端的系统代理设置');
  }
  return value;
}

// 固定字段只用于派生本轮环境，不记录注册表原文、进程环境或认证资料。
export async function readWindowsSystemProxy({ execute = executeFile, windowsRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  let result;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SYSTEM_PROXY_SCRIPT];
  const options = { windowsHide: true, timeout: 5000, maxBuffer: 32768, encoding: 'utf8' };
  try {
    try { result = await execute('pwsh.exe', args, options); }
    catch (error) {
      if (error.code !== 'ENOENT' || !path.win32.isAbsolute(windowsRoot)) throw error;
      // 仅做系统兼容的只读查询；无 PowerShell 7 时使用 Windows 内置版本，不写文本文件。
      result = await execute(path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, options);
    }
  } catch {
    throw new Error('无法读取 Windows 系统代理，请检查系统代理，或在接入设置填写本地代理地址');
  }
  let settings;
  try { settings = JSON.parse(result.stdout); }
  catch { throw new Error('Windows 系统代理读取结果格式不正确，请检查代理客户端后重试'); }
  return validateSettings(settings);
}

function proxyUri(value) {
  if (!value || /[\s\u0000-\u001f?#]/.test(value)) throw new Error('已启用的 Windows 系统代理地址无效，请检查静态代理地址和端口');
  const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value;
  let uri;
  try { uri = new URL(address); }
  catch { throw new Error('已启用的 Windows 系统代理地址无效，请检查静态代理地址和端口'); }
  if (!['http:', 'https:'].includes(uri.protocol)) throw new Error('当前只支持自动转换 HTTP 或 HTTPS 系统代理；其他类型请显式设置 Codex 代理环境');
  if (!uri.hostname || uri.username || uri.password || uri.pathname !== '/' || uri.search || uri.hash
    || (uri.port && Number(uri.port) < 1)) {
    throw new Error('已启用的 Windows 系统代理地址格式不受支持，请使用不带账号、路径或参数的静态代理地址');
  }
  return uri.protocol + '//' + uri.hostname + ':' + (uri.port || (uri.protocol === 'https:' ? '443' : '80'));
}

function proxyMap(server) {
  const text = server.trim();
  if (!text) throw new Error('Windows 系统代理已启用，但静态代理地址为空，请检查代理客户端设置');
  if (!text.includes('=')) {
    const uri = proxyUri(text);
    return { HTTP_PROXY: uri, HTTPS_PROXY: uri, ALL_PROXY: uri };
  }
  const entries = new Map();
  for (const part of text.split(';').map(value => value.trim()).filter(Boolean)) {
    const match = /^(http|https|ftp|socks|socks5)\s*=\s*(.+)$/i.exec(part);
    if (!match || entries.has(match[1].toLowerCase())) throw new Error('Windows 分协议代理设置无效，请检查重复或无法识别的协议配置');
    entries.set(match[1].toLowerCase(), match[2]);
  }
  if (entries.has('socks') || entries.has('socks5')) throw new Error('当前不能自动转换 Windows SOCKS 系统代理，请显式设置 Codex 代理环境');
  const proxies = {};
  for (const protocol of ['http', 'https']) {
    if (entries.has(protocol)) proxies[protocol.toUpperCase() + '_PROXY'] = proxyUri(entries.get(protocol));
  }
  if (!Object.keys(proxies).length) throw new Error('Windows 系统代理未提供可用于 Codex 的 HTTP 或 HTTPS 代理');
  return proxies;
}

function proxyBypass(override = '') {
  return override.split(';').map(value => value.trim()).flatMap(value => {
    // <local> 和任意通配符没有通用 NO_PROXY 等价项；只转换准确的主机/域后缀。
    // 本机回环始终由 LOOPBACK 补齐，不能用 * 代替 <local> 令所有外网绕过代理。
    if (!value || value.toLowerCase() === '<local>') return [];
    if (value === '*') return ['*'];
    if (/^\*\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(value)) return [value.slice(1)];
    const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    if (isIP(address) || /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(value)) return [address];
    return [];
  });
}

function withBypass(env, extra = []) {
  const existing = Object.entries(env).filter(([key]) => NO_PROXY_KEY.test(key));
  const values = existing.flatMap(([, value]) => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : []);
  for (const [key] of existing) delete env[key];
  const bypass = [...new Set([...values, ...extra, ...LOOPBACK])].join(',');
  env.NO_PROXY = bypass; env.no_proxy = bypass;
  return env;
}

export async function resolveCodexNetworkEnv({ platform = process.platform, baseEnv = process.env, readSystemProxy = readWindowsSystemProxy, explicitProxyUrl = '' } = {}) {
  const env = { ...baseEnv };
  const explicit = normalizeLocalProxyUrl(explicitProxyUrl);
  if (explicit) {
    for (const key of Object.keys(env)) if (PROXY_KEY.test(key)) delete env[key];
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) { env[key] = explicit; env[key.toLowerCase()] = explicit; }
    return withBypass(env);
  }
  if (Object.entries(env).some(([key, value]) => PROXY_KEY.test(key) && typeof value === 'string' && value.trim())) return withBypass(env);
  if (platform !== 'win32') return withBypass(env);
  let settings;
  try { settings = validateSettings(await readSystemProxy()); }
  catch { throw new Error('无法读取有效的 Windows 系统代理，请检查代理客户端设置，或在接入设置填写本地代理地址'); }
  const server = settings.ProxyServer || '';
  if ((!settings.ProxyEnable || !server.trim()) && (settings.AutoConfigURL?.trim() || settings.AutoDetect)) {
    throw new Error('当前 Windows 使用 PAC 或自动代理发现，无法自动转换为 Codex 静态代理；请在代理客户端启用静态系统代理或显式设置代理环境');
  }
  if (!settings.ProxyEnable) return withBypass(env);
  const proxies = proxyMap(server);
  // 清除仅含空白的大小写变体，避免 Windows 创建进程时选到空值。
  for (const key of Object.keys(env)) if (PROXY_KEY.test(key)) delete env[key];
  for (const [key, value] of Object.entries(proxies)) { env[key] = value; env[key.toLowerCase()] = value; }
  return withBypass(env, proxyBypass(settings.ProxyOverride));
}
