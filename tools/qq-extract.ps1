param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$target = [System.IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw 'QQ 暂存目录不存在' }
$prefix = $target.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$zip = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($Archive))
try {
  if ($zip.Entries.Count -gt 20000) { throw 'QQ 安装包文件数超出限制' }
  [long]$total = 0
  foreach ($entry in $zip.Entries) {
    $total += $entry.Length
    if ($total -gt 2GB) { throw 'QQ 安装包解压大小超出限制' }
    if ($entry.FullName.Contains(':') -or $entry.FullName.StartsWith('/') -or $entry.FullName.StartsWith('\')) { throw 'QQ 安装包包含绝对路径' }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'QQ 安装包包含符号链接' }
    $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($target, $entry.FullName))
    if (-not $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'QQ 安装包路径越界' }
    if ($entry.FullName.EndsWith('/')) {
      [System.IO.Directory]::CreateDirectory($path) | Out-Null
    } else {
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($path)) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $false)
    }
  }
} finally {
  $zip.Dispose()
}
