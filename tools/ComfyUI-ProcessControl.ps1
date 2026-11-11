#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Deny([int]$Status, [string]$Message) {
    $failure = [System.InvalidOperationException]::new($Message)
    $failure.Data['HttpStatus'] = $Status
    throw $failure
}

try {
    if (-not $IsWindows) { Deny 503 '只有 Windows 可以执行本机 ComfyUI 进程核验。' }
    $raw = [Console]::In.ReadToEnd()
    if ($raw.Length -gt 65536) { Deny 400 '进程核验请求过大。' }
    $request = ConvertFrom-Json -InputObject $raw -AsHashtable
    # ConvertFrom-Json may materialize ISO timestamps as DateTime. Preserve all
    # seven fractional digits when restoring the identity's canonical UTC text.
    if ($request.ContainsKey('startedAt') -and $request.startedAt -is [DateTime]) { $request.startedAt = $request.startedAt.ToUniversalTime().ToString('O') }
    if ($request.action -notin @('inspect', 'stop') -or ($request.port -isnot [long] -and $request.port -isnot [int]) -or $request.port -lt 1 -or $request.port -gt 65535) { Deny 400 '进程核验操作或端口无效。' }
    if ($request.executable -isnot [string] -or $request.executable -notmatch '^[A-Za-z]:[\\/]' -or $request.executable.Substring(2).Contains(':') -or $request.executable -match '[\x00-\x1f\x7f]') { Deny 400 'Python 必须是普通本地磁盘的绝对路径。' }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ComfyProcessNative {
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("iphlpapi.dll", SetLastError = true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    public static string[] Arguments(string command) {
        int count; IntPtr memory = CommandLineToArgvW(command, out count);
        if (memory == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }
    public static int[] ListenerPids(int port) {
        var result = new HashSet<int>();
        foreach (int family in new[] { 2, 23 }) {
            int size = 0; uint error = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
            if (error != 0 && error != 122) throw new Win32Exception((int)error);
            IntPtr table = Marshal.AllocHGlobal(size);
            try {
                error = GetExtendedTcpTable(table, ref size, false, family, 3, 0);
                if (error != 0) throw new Win32Exception((int)error);
                int rows = Marshal.ReadInt32(table), rowSize = family == 2 ? 24 : 56;
                if (rows < 0 || rows > (size - 4) / rowSize) throw new InvalidOperationException("TCP table size is invalid");
                for (int i = 0; i < rows; i++) {
                    IntPtr row = IntPtr.Add(table, 4 + i * rowSize);
                    int rawPort = Marshal.ReadInt32(row, family == 2 ? 8 : 20);
                    int actualPort = ((rawPort & 255) << 8) | ((rawPort >> 8) & 255);
                    if (actualPort == port) result.Add(Marshal.ReadInt32(row, family == 2 ? 20 : 52));
                }
            } finally { Marshal.FreeHGlobal(table); }
        }
        var values = new int[result.Count]; result.CopyTo(values); return values;
    }
    public static string ImagePath(IntPtr handle) {
        int size = 32768; var image = new StringBuilder(size);
        if (!QueryFullProcessImageNameW(handle, 0, image, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return image.ToString();
    }
    public static DateTime Created(IntPtr handle) {
        long created, exited, kernel, user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return DateTime.FromFileTimeUtc(created);
    }
    public static void StopAndWait(IntPtr handle) {
        if (WaitForSingleObject(handle, 0) == 0) return;
        if (!TerminateProcess(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint result = WaitForSingleObject(handle, 10000);
        if (result == 258) throw new TimeoutException("等待进程退出超时，尚未确认停止。");
        if (result != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@

    function Same-Path([string]$Left, [string]$Right) {
        return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
    }
    function Listener-Pid([int]$Port) {
        # Query only the kernel's current listener table. CIM TCP snapshots can lag
        # after an immediate restart and must not override the native owner PID.
        $native = @([ComfyProcessNative]::ListenerPids($Port))
        if ($native.Count -ne 1 -or $native[0] -le 0) { Deny 409 '没有唯一的本机端口监听进程，不能停止 ComfyUI。' }
        return [int]$native[0]
    }
    function Snapshot([System.Diagnostics.Process]$Process, [IntPtr]$Handle) {
        if ($Process.HasExited) { Deny 409 '端口进程已经退出，请重新连接后核对。' }
        $created = [ComfyProcessNative]::Created($Handle)
        $image = [ComfyProcessNative]::ImagePath($Handle)
        if (-not (Same-Path $image $request.executable)) { Deny 409 '本机端口由不同的 Python 或程序占用，不能停止。' }
        $information = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $Process.Id)
        if (-not $information -or -not $information.CommandLine -or -not $information.ExecutablePath -or -not $information.CreationDate) { Deny 503 '无法读取当前端口进程的完整身份，不能停止。' }
        if (-not (Same-Path $information.ExecutablePath $image) -or [Math]::Abs($information.CreationDate.ToUniversalTime().ToFileTimeUtc() - $created.ToFileTimeUtc()) -ge 10) { Deny 409 '进程创建时间或解释器已变化，请重新核对。' }
        $arguments = @([ComfyProcessNative]::Arguments($information.CommandLine))
        $index = 1
        while ($index -lt $arguments.Count -and $arguments[$index] -in @('-s', '-S', '-E', '-I', '-B', '-u', '-O', '-OO', '-q', '-v', '-vv', '-x', '-d')) { $index++ }
        if ($index -ge $arguments.Count -or [IO.Path]::GetFileName($arguments[$index]) -ine 'main.py') { Deny 409 '当前端口进程的入口不是可核验的 main.py，不能停止。' }
        # A relative entry is accepted only as an argument of this verified service.
        # It does not establish or report the process working directory.
        $declaredPorts = @()
        for ($position = $index + 1; $position -lt $arguments.Count; $position++) {
            if ($arguments[$position] -eq '--port') {
                if ($position + 1 -ge $arguments.Count) { Deny 409 'ComfyUI 主命令缺少端口值。' }
                $declaredPorts += $arguments[$position + 1]; $position++
            } elseif ($arguments[$position].StartsWith('--port=')) { $declaredPorts += $arguments[$position].Substring(7) }
        }
        if ($declaredPorts.Count -ne 1 -or $declaredPorts[0] -notmatch '^\d{1,5}$' -or [int]$declaredPorts[0] -ne $request.port) { Deny 409 'ComfyUI 主命令端口与当前连接不一致，不能停止。' }
        $bytes = [Text.Encoding]::UTF8.GetBytes($information.CommandLine)
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        return @{ pid = $Process.Id; startedAt = $created.ToString('O'); executable = $image; args = @($arguments | Select-Object -Skip 1); commandHash = $hash }
    }

    if ($request.action -eq 'stop' -and (-not $request.ContainsKey('pid') -or -not $request.ContainsKey('startedAt') -or -not $request.ContainsKey('commandHash') -or ($request.pid -isnot [long] -and $request.pid -isnot [int]) -or $request.pid -lt 1 -or $request.pid -gt 2147483647 -or $request.startedAt -isnot [string] -or $request.startedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$' -or $request.commandHash -isnot [string] -or $request.commandHash -notmatch '^[a-f0-9]{64}$')) { Deny 400 '停止操作缺少完整进程身份。' }
    $listenerPid = Listener-Pid ([int]$request.port)
    if ($request.action -eq 'stop' -and $listenerPid -ne $request.pid) { Deny 409 '当前端口监听进程已经变化，请刷新后重新确认。' }
    $process = [Diagnostics.Process]::GetProcessById($listenerPid)
    try {
        # Acquire and retain this kernel handle before checking identity. Never kill
        # by a historical PID, parent process, process name, or process tree.
        $handle = $process.Handle
        $snapshot = Snapshot $process $handle
        if ($request.action -eq 'inspect') { $result = $snapshot }
        else {
            if ($snapshot.startedAt -cne $request.startedAt -or $snapshot.commandHash -cne $request.commandHash) { Deny 409 'ComfyUI 进程身份与确认快照不一致，不能停止。' }
            if ((Listener-Pid ([int]$request.port)) -ne $listenerPid) { Deny 409 '端口监听进程已经变化，不能执行停止。' }
            [ComfyProcessNative]::StopAndWait($handle)
            $result = @{ stopped = $true; pid = $listenerPid }
        }
    } finally { $process.Dispose() }
    [Console]::Out.WriteLine((@{ ok = $true; result = $result } | ConvertTo-Json -Depth 8 -Compress))
} catch {
    $status = if ($_.Exception.Data.Contains('HttpStatus')) { [int]$_.Exception.Data['HttpStatus'] } else { 503 }
    [Console]::Out.WriteLine((@{ ok = $false; error = @{ status = $status; message = $_.Exception.Message } } | ConvertTo-Json -Depth 4 -Compress))
    exit 1
}
