# Run validation tests without installing devices or changing IP configuration.
$ErrorActionPreference = 'Stop'
$implementation = Join-Path $PSScriptRoot 'usb_ip_conflict_test.ps1'
if (-not (Test-Path -LiteralPath $implementation)) {
    throw 'Implementation missing: usb_ip_conflict_test.ps1'
}
. $implementation
$script:wdTests = 0

function Assert-WdEqual($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) {
        throw "$Message (actual=$Actual; expected=$Expected)"
    }
    $script:wdTests++
}

function Assert-WdThrows([scriptblock]$Body, [string]$Message) {
    $thrown = $false
    try { & $Body } catch { $thrown = $true }
    Assert-WdEqual $thrown $true $Message
}

function New-WdStateFixture {
    [pscustomobject]@{
        Owner = 'WirelessDebug.IpConflictTest.v1'
        OwnershipToken = '88888888-2222-3333-4444-555555555555'
        DeviceInstanceId = 'ROOT\NET\0007'
        InterfaceGuid = '{11111111-2222-3333-4444-555555555555}'
        Address = '192.168.4.2'
        PrefixLength = 24
        Status = 'Ready'
    }
}

$state = New-WdStateFixture
Assert-WdTestState $state
$script:wdTests++
$bad = New-WdStateFixture; $bad.Owner = 'OtherTool'
Assert-WdThrows { Assert-WdTestState $bad } 'Foreign ownership must be rejected'
$bad = New-WdStateFixture; $bad.DeviceInstanceId = 'USB\VID_303A\1234'
Assert-WdThrows { Assert-WdTestState $bad } 'A physical USB device must be rejected'
$bad = New-WdStateFixture; $bad.InterfaceGuid = 'invalid-guid'
Assert-WdThrows { Assert-WdTestState $bad } 'Malformed GUID must be rejected'
$bad = New-WdStateFixture; $bad.Address = '10.0.0.1'
Assert-WdThrows { Assert-WdTestState $bad } 'An unrelated IP must be rejected'
$bad = New-WdStateFixture; $bad.PrefixLength = 16
Assert-WdThrows { Assert-WdTestState $bad } 'Unexpected prefix must be rejected'

$adapter = [pscustomobject]@{
    PnPDeviceID = $state.DeviceInstanceId
    InterfaceGuid = $state.InterfaceGuid
    InterfaceDescription = 'Microsoft KM-TEST Loopback Adapter'
    Name = 'WD-IP-Conflict-Test'
    ifIndex = 77
    Status = 'Up'
}
Assert-WdEqual (Test-WdOwnedAdapter $state $adapter) $true 'Exact loopback identity'
$wrong = $adapter.PSObject.Copy(); $wrong.InterfaceGuid = [guid]::NewGuid()
Assert-WdEqual (Test-WdOwnedAdapter $state $wrong) $false 'PnP ID reuse must not authorize removal'
$wrong = $adapter.PSObject.Copy(); $wrong.InterfaceDescription = 'Intel Ethernet'
Assert-WdEqual (Test-WdOwnedAdapter $state $wrong) $false 'Non-loopback must not be owned'

$ncm = [pscustomobject]@{InterfaceDescription='UsbNcm Host Device #2'; Status='Up'}
Assert-WdEqual ([string](Get-WdPreparationBlocker @($ncm) @()) -match 'Unplug') $true 'NCM must be unplugged first'
$ncm.Status = 'Disconnected'
Assert-WdEqual ([string](Get-WdPreparationBlocker @($ncm) @()) -match 'Unplug') $true 'A present but disconnected NCM still blocks preparation'
$used = [pscustomobject]@{IPAddress='192.168.4.2'; AddressState='Preferred'}
Assert-WdEqual ([string](Get-WdPreparationBlocker @() @($used)) -match 'already') $true 'Do not overwrite an occupied address'
$used.AddressState = 'Tentative'
Assert-WdEqual ([string](Get-WdPreparationBlocker @() @($used)) -match 'already') $true 'Pending address also blocks preparation'
Assert-WdEqual (Get-WdPreparationBlocker @() @()) $null 'Empty test environment is allowed'
$orphan = [pscustomobject]@{InstanceId='ROOT\NET\0012'; HardwareIds=@('*MSLOOP')}
Assert-WdEqual ([string](Get-WdPreparationBlocker -Adapters @() -Addresses @() -Devices @($orphan)) -match 'loopback') $true 'Incomplete PnP loopback must block hardware-ID-wide driver installation'

$incomplete = New-WdStateFixture
$incomplete.Status = 'Creating'; $incomplete.DeviceInstanceId = ''; $incomplete.InterfaceGuid = ''
Assert-WdTestState $incomplete
$script:wdTests++
$bad = New-WdStateFixture; $bad.OwnershipToken = ''
Assert-WdThrows { Assert-WdTestState $bad } 'Missing creation token must reject a recovery record'
$bad = New-WdStateFixture; $bad.InterfaceGuid = ''
Assert-WdThrows { Assert-WdTestState $bad } 'Ready state must retain the interface GUID'
$ownedDevice = [pscustomobject]@{
    InstanceId='ROOT\NET\0007'
    HardwareIds=@('*MSLOOP', 'WDIPTEST_88888888222233334444555555555555')
}
Assert-WdEqual (Test-WdOwnedDevice $incomplete $ownedDevice) $true 'Pre-registration journal recovers a uniquely marked incomplete device'
$foreignDevice = $ownedDevice.PSObject.Copy(); $foreignDevice.HardwareIds=@('*MSLOOP')
Assert-WdEqual (Test-WdOwnedDevice $incomplete $foreignDevice) $false 'Plain loopback cannot satisfy ownership'
$foreignDevice = $ownedDevice.PSObject.Copy(); $foreignDevice.InstanceId='ROOT\NET\0008'
Assert-WdEqual (Test-WdOwnedDevice $state $foreignDevice) $false 'Saved device ID must not be replaced even if a marker matches'

$ip = [pscustomobject]@{IPAddress='192.168.4.2'; PrefixLength=24; InterfaceIndex=77; AddressState='Preferred'}
Assert-WdEqual (Test-WdReadyAddress $adapter @($ip)) $true 'Preferred IP on test adapter is ready'
$ip.AddressState = 'Duplicate'
Assert-WdEqual (Test-WdReadyAddress $adapter @($ip)) $false 'Duplicate IP is not ready'
$ip.AddressState = 'Tentative'
Assert-WdEqual (Test-WdReadyAddress $adapter @($ip)) $false 'Tentative IP is not ready'
$ip.AddressState = 'Preferred'; $ip.InterfaceIndex = 88
Assert-WdEqual (Test-WdReadyAddress $adapter @($ip)) $false 'Another adapter must not satisfy readiness'
$ip.InterfaceIndex = 77; $adapter.Status = 'Disconnected'
Assert-WdEqual (Test-WdReadyAddress $adapter @($ip)) $false 'Disconnected adapter is not ready'

# Compiling signatures is non-mutating: Create/Remove are never invoked here.
Initialize-WdLoopbackApi
$expectedInfoSize = if ([IntPtr]::Size -eq 8) { 32 } else { 28 }
Assert-WdEqual ([Runtime.InteropServices.Marshal]::SizeOf([type][WirelessDebug.IpConflict.Native+DeviceInfo])) $expectedInfoSize 'SetupAPI structure matches process bitness'
Assert-WdEqual ([Runtime.InteropServices.Marshal]::SizeOf([type][WirelessDebug.IpConflict.Native+RemoveParams])) 16 'Remove structure has correct ABI size'
$expectedInstallSize = if ([IntPtr]::Size -eq 8) { 584 } else { 556 }
Assert-WdEqual ([Runtime.InteropServices.Marshal]::SizeOf([type][WirelessDebug.IpConflict.Native+InstallParams])) $expectedInstallSize 'Device install parameters match process bitness'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::NeedsReboot(0x80)) $true 'Removal restart flag must be reported'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::NeedsReboot(0x100)) $true 'Removal reboot flag must be reported'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::NeedsReboot(0)) $false 'No restart flags means no restart requested'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::IsTestDeviceId('ROOT\NET\0007')) $true 'Native removal guard accepts the exact root-network format'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::IsTestDeviceId('root\net\0007')) $true 'Native identity matching is case-insensitive'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::IsTestDeviceId('USB\VID_303A\1234')) $false 'Native removal guard rejects physical USB'
Assert-WdEqual ([WirelessDebug.IpConflict.Native]::IsTestDeviceId('ROOT\NET\*')) $false 'Native removal guard rejects wildcard targets'

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('wd-ip-regression-' + [guid]::NewGuid().ToString('N'))
$temporaryState = Join-Path $temporaryDirectory 'state.json'
try {
    Save-WdTestState $state $temporaryState
    $roundTrip = Read-WdTestState $temporaryState
    Assert-WdEqual $roundTrip.InterfaceGuid $state.InterfaceGuid 'State preserves immutable adapter identity'
    Assert-WdEqual $roundTrip.Status 'Ready' 'State round-trip preserves preparation phase'
    $roundTrip.Status = 'Restored'
    Save-WdTestState $roundTrip $temporaryState
    Assert-WdEqual (Read-WdTestState $temporaryState).Status 'Restored' 'Recovery record can be persisted'
} finally {
    if ([IO.File]::Exists($temporaryState)) { [IO.File]::Delete($temporaryState) }
    if ([IO.Directory]::Exists($temporaryDirectory)) { [IO.Directory]::Delete($temporaryDirectory) }
}

# Real Restore orchestration with an in-memory device inventory. The narrow
# native-removal boundary is stubbed; all journal validation/writes are real.
function Assert-WdAdministrator { }
function Get-WdLoopbackDevices { $script:wdFakeDevices }
function Get-WdExactAdapter { return $null }
function Get-PnpDevice { param($InstanceId); return $script:wdFakeDevices | Where-Object { $_.InstanceId -eq $InstanceId } }
function Invoke-WdLoopbackRemoval {
    param($InstanceId)
    $script:wdRemovalCalls++
    if ($script:wdRemovalOutcome -eq 'Failure') { throw 'Simulated removal failure' }
    if ($script:wdRemovalOutcome -eq 'Reboot') { return $true }
    $script:wdFakeDevices = @()
    return $false
}
$recoveryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('wd-recovery-regression-' + [guid]::NewGuid().ToString('N'))
$recoveryPath = Join-Path $recoveryDirectory 'state.json'
$script:wdRemovalCalls = 0
try {
    $script:wdFakeDevices = @($ownedDevice)
    $script:wdRemovalOutcome = 'Success'
    Save-WdTestState $incomplete $recoveryPath
    Restore-WdIpConflictTest $recoveryPath | Out-Null
    Assert-WdEqual (Read-WdTestState $recoveryPath).Status 'Restored' 'Interrupted creation recovers without an interface GUID or saved PnP ID'
    Assert-WdEqual $script:wdRemovalCalls 1 'Recovery removes only one uniquely owned device'
    Restore-WdIpConflictTest $recoveryPath | Out-Null
    Assert-WdEqual $script:wdRemovalCalls 1 'Repeated restoration is non-mutating'

    $script:wdFakeDevices = @($ownedDevice); $script:wdRemovalOutcome = 'Reboot'
    Save-WdTestState $incomplete $recoveryPath
    Restore-WdIpConflictTest $recoveryPath -WarningAction SilentlyContinue | Out-Null
    Assert-WdEqual (Read-WdTestState $recoveryPath).Status 'RestorePending' 'Restart-required removal retains the recovery record'

    $script:wdRemovalOutcome = 'Failure'
    Assert-WdThrows { Restore-WdIpConflictTest $recoveryPath } 'Removal failure must be reported'
    Assert-WdEqual (Read-WdTestState $recoveryPath).Status 'RestorePending' 'Removal failure must keep retryable state'

    $reusedId = $ownedDevice.PSObject.Copy(); $reusedId.HardwareIds = @('*MSLOOP')
    $script:wdFakeDevices = @($reusedId)
    Save-WdTestState $state $recoveryPath
    $callsBefore = $script:wdRemovalCalls
    Assert-WdThrows { Restore-WdIpConflictTest $recoveryPath } 'Identity replacement must prevent restoration'
    Assert-WdEqual $script:wdRemovalCalls $callsBefore 'Foreign PnP device must never reach native removal'
} finally {
    if ([IO.File]::Exists($recoveryPath)) { [IO.File]::Delete($recoveryPath) }
    if ([IO.Directory]::Exists($recoveryDirectory)) { [IO.Directory]::Delete($recoveryDirectory) }
}
Write-Output "$script:wdTests regression checks passed; no network/device changes performed."
