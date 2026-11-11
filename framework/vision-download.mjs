import { spawn } from 'node:child_process';
import { link,lstat, mkdir, open, rm,unlink } from 'node:fs/promises';
import { WorkbenchError } from './contracts.mjs';
import { checkedLocalPath, fileHash } from './drawing-files.mjs';

export async function ordinaryFile(path) {
  await checkedLocalPath(path);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkbenchError(409, '视觉扩展文件不是普通文件。');
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function verifiedFile(path, spec, signal) {
  signal?.throwIfAborted();
  const info = await ordinaryFile(path);
  return Boolean(info && info.size === spec.bytes && await fileHash(path, signal) === spec.sha256);
}

export async function publishVerifiedPartial(partial,target,signal){
  await checkedLocalPath(partial);await checkedLocalPath(target);signal?.throwIfAborted();
  try{await link(partial,target);}
  catch(error){
    if(error.code==='EEXIST')throw new WorkbenchError(409,'安装目标出现同名文件，原文件与下载分片均已保留。');
    if(['ENOTSUP','EOPNOTSUPP','EXDEV','EPERM','ENOSYS'].includes(error.code))throw new WorkbenchError(409,'目标目录无法创建硬链接，下载分片已保留。请检查磁盘类型或访问权限后重试。');
    throw error;
  }
  // 同目录链接保证“不存在才创建”，避免校验期间新出现的文件被 rename 替换。
  await unlink(partial).catch(()=>{});
}

// 固定 URL、长度和 SHA256 来自受版本控制的包清单；HTTP 入口不能指定它们。
export async function downloadVerified({file,target,fetchImpl,signal,idleTimeoutMs,onProgress,onStage}) {
  const partial = target + '.part';
  if (await verifiedFile(target,file,signal)) { onProgress(file.bytes); return; }
  if (await ordinaryFile(target)) throw new WorkbenchError(409, `已存在的 ${file.filename} 未通过校验，请先保留并移走该文件后重试。`);
  let offset = (await ordinaryFile(partial))?.size || 0;
  if (offset === file.bytes && await verifiedFile(partial,file,signal)) {
    signal.throwIfAborted(); await publishVerifiedPartial(partial,target,signal); onProgress(file.bytes); return;
  }
  if (offset >= file.bytes) { await rm(partial,{force:true}); offset=0; }
  onStage('downloading'); onProgress(offset);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal,controller.signal]);
  let timer, handle, reader;
  const touch = () => { clearTimeout(timer); timer=setTimeout(()=>controller.abort(new WorkbenchError(504,'下载长时间没有响应，可重试继续。')),idleTimeoutMs); };
  try {
    combined.throwIfAborted();touch();
    const response = await fetchImpl(file.url,{signal:combined,headers:{'accept-encoding':'identity',...(offset?{Range:`bytes=${offset}-`}:{})}});
    if (![200,206].includes(response.status)) throw new WorkbenchError(502,`下载服务器返回 HTTP ${response.status}，可稍后重试。`);
    if (/text\/html|application\/json/i.test(response.headers.get('content-type')||'')) throw new WorkbenchError(502,'下载地址返回了网页，模型未安装。');
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new WorkbenchError(502,'下载服务器返回压缩传输，无法可靠校验长度。');
    if (response.status === 206) {
      const match=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!match || Number(match[1])!==offset || Number(match[2])!==file.bytes-1 || Number(match[3])!==file.bytes) throw new WorkbenchError(502,'下载续传范围与固定版本不一致。');
    } else offset=0;
    const length=response.headers.get('content-length');
    if (length!==null && Number(length)!==file.bytes-offset) throw new WorkbenchError(502,'下载长度与固定版本不一致。');
    if (!response.body) throw new WorkbenchError(502,'下载响应没有文件内容。');
    await checkedLocalPath(partial);combined.throwIfAborted();handle=await open(partial,offset?'a':'w');
    reader=response.body.getReader();onProgress(offset);
    while (true) {
      combined.throwIfAborted();touch();const {done,value}=await reader.read();
      if (done) break;
      combined.throwIfAborted();
      if (offset+value.byteLength>file.bytes) throw new WorkbenchError(502,'下载内容超过固定文件长度。');
      await handle.writeFile(value);offset+=value.byteLength;onProgress(offset);
    }
    clearTimeout(timer);await handle.close();handle=null;signal.throwIfAborted();
    if (offset!==file.bytes) throw new WorkbenchError(502,'文件未下载完整，可重试继续。');
    onStage('verifying');
    if (!await verifiedFile(partial,file,signal)) { await rm(partial,{force:true});throw new WorkbenchError(502,`${file.filename} 的 SHA256 校验失败，可重试重新下载。`); }
    signal.throwIfAborted();await checkedLocalPath(target);
    if (await ordinaryFile(target)) throw new WorkbenchError(409,'安装目标出现同名文件，原文件保持不变。');
    await publishVerifiedPartial(partial,target,signal);
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);controller.abort();
    if (reader) await reader.cancel().catch(()=>{});
    if (handle) await handle.close().catch(()=>{});
  }
}

const EXTRACT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$visionArchive = $null
try {
  $visionArchive = [System.IO.Compression.ZipFile]::OpenRead($env:VISION_ARCHIVE_PATH)
  $visionRoot = [System.IO.Path]::GetFullPath($env:VISION_EXTRACT_PATH).TrimEnd([char]92, [char]47) + [System.IO.Path]::DirectorySeparatorChar
  $visionSeen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  [long]$visionTotal = 0
  foreach ($visionEntry in $visionArchive.Entries) {
    $visionName = $visionEntry.FullName.Replace([char]92, [char]47)
    $visionMode = ([long]$visionEntry.ExternalAttributes -shr 16) -band 61440
    if ($visionMode -eq 40960 -or (($visionEntry.ExternalAttributes -band 1024) -ne 0)) { throw '压缩包不能含符号链接或重解析点。' }
    if ($visionName.StartsWith('/') -or $visionName.Contains(':') -or $visionName.Contains([char]0)) { throw '压缩包含绝对路径。' }
    $visionParts = $visionName.TrimEnd('/').Split('/')
    foreach ($visionPart in $visionParts) {
      if (!$visionPart -or $visionPart -eq '.' -or $visionPart -eq '..' -or $visionPart -match '[. ]$|[<>:"|?*\x00-\x1f]' -or $visionPart -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw '压缩包含不安全路径。' }
    }
    $visionTarget = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($visionRoot, $visionName))
    if (!$visionTarget.StartsWith($visionRoot, [System.StringComparison]::OrdinalIgnoreCase) -or !$visionSeen.Add($visionTarget)) { throw '压缩包路径越界或重复。' }
    $visionTotal += $visionEntry.Length
    if ($visionTotal -gt [long]$env:VISION_EXTRACT_BYTES) { throw '压缩包解压大小超过清单。' }
  }
  if ($visionTotal -ne [long]$env:VISION_EXTRACT_BYTES) { throw '压缩包解压大小与清单不一致。' }
  foreach ($visionEntry in $visionArchive.Entries) {
    $visionTarget = [System.IO.Path]::Combine($visionRoot, $visionEntry.FullName.Replace([char]92, [char]47))
    if ($visionEntry.FullName.EndsWith('/') -or $visionEntry.FullName.EndsWith([char]92)) { [System.IO.Directory]::CreateDirectory($visionTarget) | Out-Null; continue }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($visionTarget)) | Out-Null
    $visionInput = $visionEntry.Open()
    $visionOutput = [System.IO.File]::Open($visionTarget, [System.IO.FileMode]::CreateNew)
    try { $visionInput.CopyTo($visionOutput) } finally { $visionOutput.Dispose(); $visionInput.Dispose() }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally { if ($visionArchive) { $visionArchive.Dispose() } }
`;

export async function extractVisionArchive({archive,destination,unpackedBytes,signal}) {
  await checkedLocalPath(archive);await checkedLocalPath(destination);signal.throwIfAborted();
  await mkdir(destination,{recursive:false});signal.throwIfAborted();
  await new Promise((resolve,reject)=>{
    const child=spawn('pwsh',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(EXTRACT_SCRIPT,'utf16le').toString('base64')],{
      windowsHide:true,shell:false,stdio:['ignore','ignore','pipe'],
      env:{...process.env,VISION_ARCHIVE_PATH:archive,VISION_EXTRACT_PATH:destination,VISION_EXTRACT_BYTES:String(unpackedBytes)},
    });
    let errorText='';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{errorText=(errorText+chunk.toString()).slice(-4096);});
    const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    child.once('error',error=>{signal.removeEventListener('abort',abort);reject(error);});
    child.once('exit',code=>{
      signal.removeEventListener('abort',abort);
      if(signal.aborted)reject(signal.reason);
      else if(code===0)resolve();
      else reject(new WorkbenchError(500,`运行器解压失败：${errorText.replace(/\x1b\[[0-9;]*m/g,'').trim().slice(-1200) || 'PowerShell 7 未能完成解压。'}`));
    });
  });
}
