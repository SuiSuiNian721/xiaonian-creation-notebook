$ErrorActionPreference = 'Stop'
try {
    $configPath = Join-Path $PSScriptRoot 'desktop-entry.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($config.version -ne 1) { throw '桌面入口配置版本不支持，请重新安装入口。' }
    $launcher = Join-Path $config.sourceRoot 'tools\open-workbench-desktop.mjs'
    foreach ($required in @($config.nodeExecutable, $launcher)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "启动文件不存在：$required" }
    }
    & $config.nodeExecutable $launcher $configPath
    if ($LASTEXITCODE -ne 0) { throw '工作台启动失败，详情见资料目录中的 logs。' }
} catch {
    $message = $_.Exception.Message
    $message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'startup-error.log') -Encoding utf8
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($message, '无法打开小念的创作笔记') | Out-Null
    exit 1
}
