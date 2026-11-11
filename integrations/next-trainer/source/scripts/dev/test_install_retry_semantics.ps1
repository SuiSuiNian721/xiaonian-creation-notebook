# Regression test for issue #319: install-cn.ps1 reported success over an empty venv.
#
# Invoke-PipInstallWithRetries wrote its retry notice with Write-Output, which
# lands in the function's output stream. PowerShell then returns the whole
# stream, so `return $false` became @(message, $false) -- a non-empty array,
# which is truthy. The caller's `if (-not (Invoke-PipInstallWithRetries ...))`
# therefore never fired: pip failed 15 times in a row and the script still
# printed "安装完成" and exited 0.
#
# This test lifts the real functions out of install-cn.ps1 and calls them with a
# stub `python` on PATH, so it fails if the Write-Output bug ever comes back.
param(
    [string]$InstallScript = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "install-cn.ps1")
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$failures = @()
function Assert-True($Condition, [string]$Label) {
    # Untyped on purpose: the bug under test makes the value an Object[], and a
    # [bool] parameter would throw there instead of reporting a clean failure.
    try { $Condition = [bool]$Condition } catch { $Condition = $false }
    if ($Condition) {
        Write-Host "[OK]   $Label"
    } else {
        Write-Host "[FAIL] $Label" -ForegroundColor Red
        $script:failures += $Label
    }
}

function Get-FunctionText {
    param([string]$Source, [string]$Name)
    $start = $Source.IndexOf("function $Name")
    if ($start -lt 0) { throw "function $Name not found in $InstallScript" }
    $open = $Source.IndexOf('{', $start)
    $depth = 0
    for ($i = $open; $i -lt $Source.Length; $i++) {
        if ($Source[$i] -eq '{') { $depth++ }
        elseif ($Source[$i] -eq '}') {
            $depth--
            if ($depth -eq 0) { return $Source.Substring($start, $i - $start + 1) }
        }
    }
    throw "unbalanced braces around function $Name"
}

if (-not (Test-Path $InstallScript)) { throw "install script not found: $InstallScript" }
$source = Get-Content $InstallScript -Raw

Write-Host ""
Write-Host "install-cn.ps1 retry semantics (issue #319)" -ForegroundColor Cyan
Write-Host "Script: $InstallScript"
Write-Host ""

# Pull in the real implementations rather than a paraphrase of them.
. ([scriptblock]::Create((Get-FunctionText $source "Get-PipSourceArgs")))
. ([scriptblock]::Create((Get-FunctionText $source "Invoke-PipInstallWithRetries")))
. ([scriptblock]::Create((Get-FunctionText $source "Get-PipResumeRetriesArgs")))

$stubDir = Join-Path ([System.IO.Path]::GetTempPath()) ("install-retry-test-" + [guid]::NewGuid().ToString("n").Substring(0, 8))
New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
$originalPath = $env:PATH
$source_ = @{ Name = "Stub Source"; Mode = "index-url"; Url = "https://example.invalid/simple" }

try {
    $env:PATH = "$stubDir;$originalPath"

    # pip 23.0.1 rejecting --resume-retries exits 2 during argument parsing.
    # `python -m pip --version` puts --version in %3.
    Set-Content -Path (Join-Path $stubDir "python.bat") -Value @"
@echo off
if "%3"=="--version" (
  echo pip 23.0.1 from C:\stub\pip ^(python 3.10^)
  exit /b 0
)
echo Usage:
echo   no such option: --resume-retries
exit /b 2
"@ -Encoding ascii

    $script:PipResumeRetriesArgs = $null
    $failing = Invoke-PipInstallWithRetries -Label "Torch" -PackageArgs @("torch==2.7.0+cu128") -Source $source_ -RetriesPerSource 3

    Assert-True (@($failing).Count -eq 1) "failed install returns a single value, not an output-stream array"
    Assert-True ($failing -is [bool]) "failed install returns a bool"
    Assert-True ($failing -eq $false) "failed install returns `$false"
    # The exact expression install-cn.ps1 uses at its call sites.
    Assert-True (-not $failing) "caller's `if (-not (...))` detects the failure"

    # And the option is dropped entirely on a pip that cannot take it.
    $script:PipResumeRetriesArgs = $null
    $resumeArgs = @(Get-PipResumeRetriesArgs)
    Assert-True ($resumeArgs.Count -eq 0) "--resume-retries omitted on pip 23.0.1"

    Set-Content -Path (Join-Path $stubDir "python.bat") -Value @"
@echo off
if "%3"=="--version" (
  echo pip 25.2 from C:\stub\pip ^(python 3.10^)
  exit /b 0
)
exit /b 0
"@ -Encoding ascii

    $script:PipResumeRetriesArgs = $null
    $resumeArgs = @(Get-PipResumeRetriesArgs)
    Assert-True (($resumeArgs -join ' ') -eq "--resume-retries 5") "--resume-retries kept on pip 25.2"

    $script:PipResumeRetriesArgs = $null
    $succeeding = Invoke-PipInstallWithRetries -Label "Torch" -PackageArgs @("torch==2.7.0+cu128") -Source $source_ -RetriesPerSource 3
    Assert-True ($succeeding -is [bool] -and $succeeding -eq $true) "successful install returns `$true"

    # Static guard: no Write-Output may be reintroduced into the retry loop, and
    # pip's stdout must stay piped away from it. Comments are stripped so the
    # explanatory note above the loop does not trip the check.
    $retryCode = ((Get-FunctionText $source "Invoke-PipInstallWithRetries") -split "`n" |
        Where-Object { $_.Trim() -notlike '#*' }) -join "`n"
    Assert-True ($retryCode -notmatch 'Write-Output') "Invoke-PipInstallWithRetries does not write to the output stream"
    Assert-True ($retryCode -match 'pip install[^\r\n]*\|\s*Out-Host') "pip stdout is piped to the host, not into the return value"
    Assert-True ($source -match 'pip>=23\.1') "venv pip is upgraded with an explicit lower bound"
    Assert-True ($source -match 'import torch') "install ends with an import-torch verification"
}
finally {
    $env:PATH = $originalPath
    if (Test-Path $stubDir) { Remove-Item $stubDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host ("FAILED: {0} assertion(s)" -f $failures.Count) -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "install-cn.ps1 reports pip failures correctly." -ForegroundColor Green
exit 0
