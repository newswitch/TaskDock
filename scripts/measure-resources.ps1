param(
    [ValidateRange(2, 60)][int]$Seconds = 15,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'

# Read only this app's process tree; never sum unrelated WebView2 instances.
$roots = @(Get-Process TaskDock -ErrorAction SilentlyContinue)
if ($roots.Count -ne 1) { throw 'Start exactly one TaskDock instance before measuring.' }
$processRows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$taskIds = [System.Collections.Generic.HashSet[int]]::new()
[void]$taskIds.Add($roots[0].Id)
do {
    $added = $false
    foreach ($row in $processRows) {
        if ($taskIds.Contains([int]$row.ParentProcessId) -and $taskIds.Add([int]$row.ProcessId)) { $added = $true }
    }
} while ($added)
$before = @{}
foreach ($taskId in $taskIds) {
    $process = Get-Process -Id $taskId -ErrorAction Stop
    $before[$taskId] = $process.TotalProcessorTime.TotalSeconds
}
$timer = [System.Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Seconds $Seconds
$after = @{}
foreach ($taskId in $taskIds) { $after[$taskId] = (Get-Process -Id $taskId -ErrorAction Stop).TotalProcessorTime.TotalSeconds }
$timer.Stop()
$elapsed = $timer.Elapsed.TotalSeconds
$finalRows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
foreach ($row in $finalRows) {
    if ($taskIds.Contains([int]$row.ParentProcessId) -and !$taskIds.Contains([int]$row.ProcessId)) {
        throw 'Process tree changed; wait for the app to settle and retry.'
    }
}
$perf = @{}
Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $taskIds.Contains([int]$_.IDProcess) } | ForEach-Object { $perf[[int]$_.IDProcess] = $_ }
$rows = @(foreach ($taskId in $taskIds) {
    $process = Get-Process -Id $taskId -ErrorAction Stop
    if (!$perf.ContainsKey($taskId)) { throw 'Process tree changed; wait for the app to settle and retry.' }
    [pscustomobject]@{
        Pid = $taskId
        Name = $process.ProcessName
        PrivateWorkingSetMiB = [math]::Round($perf[$taskId].WorkingSetPrivate / 1MB, 2)
        PrivateCommitMiB = [math]::Round($process.PrivateMemorySize64 / 1MB, 2)
        WorkingSetMiB = [math]::Round($process.WorkingSet64 / 1MB, 2)
        MachineCpuPercent = [math]::Round(100 * ($after[$taskId] - $before[$taskId]) / $elapsed / [Environment]::ProcessorCount, 4)
    }
})
$report = [pscustomobject]@{
    MeasuredAt = (Get-Date).ToString('o')
    Executable = $roots[0].Path
    SampleSeconds = [math]::Round($elapsed, 2)
    LogicalProcessors = [Environment]::ProcessorCount
    PrivateWorkingSetMiB = [math]::Round(($rows | Measure-Object PrivateWorkingSetMiB -Sum).Sum, 2)
    PrivateCommitMiB = [math]::Round(($rows | Measure-Object PrivateCommitMiB -Sum).Sum, 2)
    MachineCpuPercent = [math]::Round(($rows | Measure-Object MachineCpuPercent -Sum).Sum, 4)
    Processes = $rows
    Notes = 'Includes TaskDock and its descendants. Private working set excludes shared pages; summed working sets can count shared pages more than once. Private commit is not resident RAM. A short idle sample is not a peak or long-run guarantee.'
} | ConvertTo-Json -Depth 5
if ($OutputPath) { $report | Set-Content -LiteralPath $OutputPath -Encoding utf8 }
$report
