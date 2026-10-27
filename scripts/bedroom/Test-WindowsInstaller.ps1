$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This installation test is only for an ephemeral GitHub Windows runner' }
$folder = Join-Path $env:ProgramData 'FreeSleepBedroom'
$fixture = Join-Path $PSScriptRoot 'homebridge-cache.mjs'
$fixtureHash = (Get-FileHash $fixture -Algorithm SHA256).Hash.ToLower()
function Invoke-RestMethod {
    param($Uri,$TimeoutSec)
    if ($Uri -ne 'http://127.0.0.1:40263/accessories') { throw 'Unexpected bridge request' }
    return @{accessories=@(
        @{aid=9;services=@(@{characteristics=@(@{type='21';value='H5106'},@{type='11';iid=10},@{type='10';iid=12},@{type='95';iid=14},@{type='C6';iid=15})})},
        @{aid=10;services=@(@{characteristics=@(@{type='21';value='H712C'},@{type='B0';iid=10},@{type='29';iid=13})})},
        @{aid=11;services=@(@{characteristics=@(@{type='21';value='H7161'},@{type='B0';iid=10})})}
    )}
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing,$Uri,$OutFile)
    Copy-Item $fixture $OutFile
}
try {
    $pin = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKz03wJatN9duVL1CYOYE9Lu8OY9TiFVCbTx6TdFKWdf'))
    & (Join-Path $PSScriptRoot 'Install-HomebridgeCache.ps1') -Revision ('a'*40) -PublisherSha256 $fixtureHash -PodAddress 127.0.0.1 -PodPort 9 -PinnedHostKeyBase64 $pin
    Stop-ScheduledTask -TaskName 'FreeSleep-BedroomCache'
    $config = Get-Content (Join-Path $folder 'config.json') -Raw | ConvertFrom-Json
    if ($config.sources.Count -ne 7 -or $config.podPort -ne 9) { throw 'Incorrect source or transport configuration' }
    $key = Join-Path $folder 'publisher_ed25519'
    $acl = Get-Acl $key
    if ($acl.Owner -notmatch 'SYSTEM') { throw 'The publishing task must own its key' }
    foreach ($entry in $acl.Access) {
        $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin @('S-1-5-18','S-1-5-32-544')) { throw "Unexpected private-key principal: $sid" }
    }
    $task = Get-ScheduledTask -TaskName 'FreeSleep-BedroomCache'
    if ($task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or $task.Triggers.Count -ne 2) { throw 'Incorrect persistent task' }
    Write-Output 'Windows PowerShell installation, mapping, key ownership, ACL and task checks passed.'
} finally {
    $task = Get-ScheduledTask -TaskName 'FreeSleep-BedroomCache' -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $task.TaskName; Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false }
    if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
}
