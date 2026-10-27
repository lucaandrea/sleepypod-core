param([Parameter(Mandatory=$true)][ValidateSet('Publish','Observe')][string]$Mode)
$ErrorActionPreference='Stop'
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use Administrator PowerShell' }
$folder=Join-Path $env:ProgramData 'FreeSleepBedroom'
$readerRoot=Join-Path $folder 'govee-readings'
$cachePath=Join-Path $folder 'config.json'
$readerPath=Join-Path $readerRoot 'config.json'
$statePath=Join-Path $readerRoot 'handoff.json'
$utf8=New-Object Text.UTF8Encoding($false)
$tasks=@('FreeSleep-BedroomCache','FreeSleep-GoveeReadings')
foreach ($taskName in $tasks) { Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null }
function Write-Atomic {
    param([string]$Path,[string]$Contents)
    [IO.File]::WriteAllText("$Path.pending",$Contents,$utf8)
    if (Test-Path $Path) { [IO.File]::Replace("$Path.pending",$Path,"$Path.previous") }
    else { [IO.File]::Move("$Path.pending",$Path) }
}
# Preserve both configurations before transferring the four monitor sources to the new reader.
if (!(Test-Path $statePath)) {
    if ($Mode -ne 'Publish') { throw 'No publishing handoff exists to restore' }
    $cacheBefore=[IO.File]::ReadAllText($cachePath)
    $readerBefore=[IO.File]::ReadAllText($readerPath)
    $cache=$cacheBefore | ConvertFrom-Json
    $reader=$readerBefore | ConvertFrom-Json
    $sensorIds=@('govee-h5106-temperature','govee-h5106-humidity','govee-h5106-pm25','govee-h5106-airQuality')
    $monitorSources=@($cache.sources | Where-Object {$_.sourceId -in $sensorIds})
    if ($reader.mode -ne 'observe' -or $monitorSources.Count -ne 4 -or
        @($monitorSources.sourceId | Select-Object -Unique).Count -ne 4 -or $cache.sources.Count -le 4) {
        throw 'Unexpected source ownership; preserve and inspect the existing configuration'
    }
    $cache.sources=@($cache.sources | Where-Object {$_.sourceId -notin $sensorIds})
    $reader.mode='publish'
    $state=[ordered]@{cacheBefore=$cacheBefore;readerBefore=$readerBefore;
        cacheAfter=($cache | ConvertTo-Json -Depth 10);readerAfter=($reader | ConvertTo-Json -Depth 10)}
    Write-Atomic $statePath ($state | ConvertTo-Json -Depth 4)
}
$state=Get-Content $statePath -Raw | ConvertFrom-Json
if ([IO.File]::ReadAllText($cachePath) -cnotin @($state.cacheBefore,$state.cacheAfter) -or
    [IO.File]::ReadAllText($readerPath) -cnotin @($state.readerBefore,$state.readerAfter)) {
    throw 'Configuration changed outside this handoff; preserve it for review'
}
if ($Mode -eq 'Publish') {
    $status=Get-Content (Join-Path $readerRoot 'status.json') -Raw | ConvertFrom-Json
    $age=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$status.receipt.observedAt
    if (!$status.receipt.reading -or $age -lt 0 -or $age -gt 90000 -or $status.error) {
        throw 'A recent qualified observation is required before publication'
    }
}
$completed=$false
$stopped=$false
try {
    # Disable retry triggers while neither publisher owns the monitor, including during recovery.
    foreach ($taskName in $tasks) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Stop-ScheduledTask -TaskName $taskName
    }
    $deadline=(Get-Date).AddSeconds(20)
    do {
        $running=@($tasks | ForEach-Object {Get-ScheduledTask -TaskName $_} | Where-Object {$_.State -eq 'Running'})
        if (!$running.Count) { break }
        if ((Get-Date) -gt $deadline) { throw 'Publisher did not stop; source ownership was not changed' }
        Start-Sleep -Milliseconds 200
    } while ($true)
    $stopped=$true
    if ($Mode -eq 'Publish') {
        Write-Atomic $cachePath $state.cacheAfter
        Write-Atomic $readerPath $state.readerAfter
    } else {
        Write-Atomic $readerPath $state.readerBefore
        Write-Atomic $cachePath $state.cacheBefore
    }
    $completed=$true
} finally {
    if (!$completed -and $stopped) {
        # On a partial write, restore the original cache-only pipeline before restarting either task.
        Write-Atomic $readerPath $state.readerBefore
        Write-Atomic $cachePath $state.cacheBefore
    }
    foreach ($taskName in $tasks) {
        Enable-ScheduledTask -TaskName $taskName | Out-Null
        Start-ScheduledTask -TaskName $taskName
    }
}
Write-Output "Reader mode: $Mode. Verify Pod receipts and expiry before considering the handoff accepted."
