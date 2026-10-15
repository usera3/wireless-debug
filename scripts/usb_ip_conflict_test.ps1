<#
.SYNOPSIS
Temporarily occupy 192.168.4.2/24 on a new Microsoft KM-TEST loopback.
.DESCRIPTION
Status is read-only. Prepare/Restore require administrator privileges.
Only the created test adapter is changed; no gateway or DNS is configured.
This tests cross-interface IPv4 behavior, not an external ARP responder.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Status', 'Prepare', 'Restore')]
    [string]$Action = 'Status',
    [string]$StatePath = (Join-Path $env:LOCALAPPDATA 'WirelessDebug\IpConflictTest\state.json')
)

$script:WdOwner = 'WirelessDebug.IpConflictTest.v1'
$script:WdAddress = '192.168.4.2'
$script:WdAdapterName = 'WD-IP-Conflict-Test'

function Get-WdPreparationBlocker {
    param([object[]]$Adapters, [object[]]$Addresses, [object[]]$Devices = @())
    if (@($Devices | Where-Object { @($_.HardwareIds) -contains '*MSLOOP' }).Count) {
        return 'An existing PnP loopback (possibly incompletely installed) exists; it will not be changed.'
    }
    foreach ($adapter in $Adapters) {
        if ($adapter.InterfaceDescription -match 'UsbNcm|Wireless Debug.*Network' -and
            [string]$adapter.Status -notmatch 'Not.?Present') {
            return 'Unplug the ESP32 native USB cable before Prepare; UART can remain connected.'
        }
        if ($adapter.InterfaceDescription -match 'KM-TEST|Loopback Adapter') {
            return 'An existing loopback adapter is present; it will not be adopted or changed.'
        }
    }
    if (@($Addresses | Where-Object { $_.IPAddress -eq $script:WdAddress }).Count) {
        return '192.168.4.2 is already configured; no adapter will be changed.'
    }
    return $null
}

function Assert-WdTestState {
    param($State)
    if ($null -eq $State -or $State.Owner -ne $script:WdOwner -or
        $State.Address -ne $script:WdAddress -or [int]$State.PrefixLength -ne 24 -or
        $State.Status -notin @('Creating', 'Registered', 'Prepared', 'Ready', 'RestorePending', 'Restored')) {
        throw 'Invalid or foreign test state; refusing to modify devices.'
    }
    $parsedToken = [guid]::Empty
    if (-not [guid]::TryParse([string]$State.OwnershipToken, [ref]$parsedToken) -or
        $parsedToken -eq [guid]::Empty) { throw 'Invalid creation token; refusing to modify devices.' }
    if ([string]::IsNullOrEmpty([string]$State.DeviceInstanceId)) {
        if ($State.Status -notin @('Creating', 'Restored')) { throw 'Missing saved device identity.' }
    } elseif ([string]$State.DeviceInstanceId -notmatch '^ROOT\\NET\\[0-9]{4}$') {
        throw 'Invalid saved device identity.'
    }
    if ([string]::IsNullOrEmpty([string]$State.InterfaceGuid) -and
        $State.Status -notin @('Prepared', 'Ready')) { return }
    $parsedGuid = [guid]::Empty
    if (-not [guid]::TryParse([string]$State.InterfaceGuid, [ref]$parsedGuid) -or
        $parsedGuid -eq [guid]::Empty) {
        throw 'Invalid saved interface GUID; refusing to modify devices.'
    }
}

function Test-WdOwnedAdapter {
    param($State, $Adapter)
    if ($null -eq $Adapter -or [string]::IsNullOrEmpty([string]$State.InterfaceGuid)) { return $false }
    return ([string]$Adapter.PnPDeviceID -eq [string]$State.DeviceInstanceId -and
        [string]$Adapter.InterfaceDescription -match 'KM-TEST|Loopback Adapter' -and
        [guid]$Adapter.InterfaceGuid -eq [guid]$State.InterfaceGuid)
}

function Get-WdOwnershipMarker {
    param($State)
    return 'WDIPTEST_' + ([guid]$State.OwnershipToken).ToString('N')
}

function Test-WdOwnedDevice {
    param($State, $Device)
    if ($null -eq $Device -or [string]$Device.InstanceId -notmatch '^ROOT\\NET\\[0-9]{4}$') { return $false }
    if (-not [string]::IsNullOrEmpty([string]$State.DeviceInstanceId) -and
        [string]$State.DeviceInstanceId -ne [string]$Device.InstanceId) { return $false }
    return (@($Device.HardwareIds) -contains '*MSLOOP' -and
        @($Device.HardwareIds) -contains (Get-WdOwnershipMarker $State))
}

function Get-WdLoopbackDevices {
    # Includes non-present and incomplete PnP devices, not just NetAdapter objects.
    foreach ($device in @(Get-PnpDevice -Class Net -ErrorAction Stop)) {
        $ids = (Get-PnpDeviceProperty -InstanceId $device.InstanceId `
            -KeyName 'DEVPKEY_Device_HardwareIds' -ErrorAction Stop).Data
        if (@($ids) -contains '*MSLOOP') {
            [pscustomobject]@{ InstanceId=$device.InstanceId; HardwareIds=@($ids) }
        }
    }
}

function Test-WdReadyAddress {
    param($Adapter, [object[]]$Addresses)
    if ($null -eq $Adapter -or [string]$Adapter.Status -ne 'Up') { return $false }
    return @($Addresses | Where-Object {
        $_.IPAddress -eq $script:WdAddress -and [int]$_.PrefixLength -eq 24 -and
        [int]$_.InterfaceIndex -eq [int]$Adapter.ifIndex -and
        [string]$_.AddressState -eq 'Preferred'
    }).Count -gt 0
}

function Initialize-WdLoopbackApi {
    if ('WirelessDebug.IpConflict.Native' -as [type]) { return }
    # Register a uniquely marked root device and install only that exact node.
    # Inbox netloop.inf only; DI_NOWRITE_IDS preserves the recovery marker.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace WirelessDebug.IpConflict {
    public static class Native {
        [StructLayout(LayoutKind.Sequential)]
        public struct DeviceInfo {
            public uint Size;
            public Guid ClassGuid;
            public uint DevInst;
            public IntPtr Reserved;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct ClassHeader { public uint Size; public uint Function; }
        [StructLayout(LayoutKind.Sequential)]
        public struct RemoveParams {
            public ClassHeader Header;
            public uint Scope;
            public uint HardwareProfile;
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        public struct InstallParams {
            public uint Size;
            public uint Flags;
            public uint FlagsEx;
            public IntPtr Parent;
            public IntPtr MessageHandler;
            public IntPtr MessageContext;
            public IntPtr FileQueue;
            public UIntPtr ClassInstallReserved;
            public uint Reserved;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)]
            public string DriverPath;
        }
        [DllImport("setupapi.dll", SetLastError=true)]
        static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid guid, IntPtr parent);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name,
            ref Guid guid, string description, IntPtr parent, uint flags, ref DeviceInfo info);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set,
            ref DeviceInfo info, uint property, byte[] value, uint length);
        [DllImport("setupapi.dll", SetLastError=true)]
        static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref DeviceInfo info);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiGetDeviceInstanceIdW(IntPtr set, ref DeviceInfo info,
            StringBuilder buffer, uint capacity, out uint required);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiOpenDeviceInfoW(IntPtr set, string instance,
            IntPtr parent, uint flags, ref DeviceInfo info);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiSetClassInstallParamsW(IntPtr set, ref DeviceInfo info,
            ref RemoveParams parameters, uint size);
        [DllImport("setupapi.dll", SetLastError=true)]
        static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiGetDeviceInstallParamsW(IntPtr set,
            ref DeviceInfo info, ref InstallParams parameters);
        [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool SetupDiSetDeviceInstallParamsW(IntPtr set,
            ref DeviceInfo info, ref InstallParams parameters);
        [DllImport("setupapi.dll", SetLastError=true)]
        static extern bool SetupDiBuildDriverInfoList(IntPtr set, ref DeviceInfo info, uint driverType);
        [DllImport("setupapi.dll", SetLastError=true)]
        static extern bool SetupDiDestroyDriverInfoList(IntPtr set, ref DeviceInfo info, uint driverType);

        static Guid NetworkClass = new Guid("4d36e972-e325-11ce-bfc1-08002be10318");
        static Win32Exception Error(string operation) {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        static DeviceInfo NewInfo() {
            var info = new DeviceInfo();
            info.Size = (uint)Marshal.SizeOf(typeof(DeviceInfo));
            return info;
        }
        static IntPtr NewSet() {
            var set = SetupDiCreateDeviceInfoList(ref NetworkClass, IntPtr.Zero);
            if (set == new IntPtr(-1)) throw Error("Create network device information list");
            return set;
        }
        static bool RemoveFromSet(IntPtr set, ref DeviceInfo info) {
            var parameters = new RemoveParams();
            parameters.Header.Size = (uint)Marshal.SizeOf(typeof(ClassHeader));
            parameters.Header.Function = 5; // DIF_REMOVE
            parameters.Scope = 1; // DI_REMOVEDEVICE_GLOBAL, this exact device only
            if (!SetupDiSetClassInstallParamsW(set, ref info, ref parameters,
                (uint)Marshal.SizeOf(typeof(RemoveParams)))) throw Error("Set removal parameters");
            if (!SetupDiCallClassInstaller(5, set, ref info)) throw Error("Remove test device");
            var install = ReadInstallParams(set, ref info);
            return NeedsReboot(install.Flags);
        }

        static InstallParams ReadInstallParams(IntPtr set, ref DeviceInfo info) {
            var install = new InstallParams();
            install.Size = (uint)Marshal.SizeOf(typeof(InstallParams));
            if (!SetupDiGetDeviceInstallParamsW(set, ref info, ref install))
                throw Error("Read device installation/restart parameters; keep the recovery record");
            return install;
        }

        static void CheckRestart(IntPtr set, ref DeviceInfo info) {
            if (NeedsReboot(ReadInstallParams(set, ref info).Flags))
                throw new InvalidOperationException("Windows requested restart; test cancelled, no automatic reboot.");
        }

        public static bool NeedsReboot(uint flags) { return (flags & 0x180) != 0; }

        public static string CreateRegistered(string marker) {
            if (!System.Text.RegularExpressions.Regex.IsMatch(marker, @"^WDIPTEST_[a-fA-F0-9]{32}$"))
                throw new ArgumentException("Invalid ownership marker.");
            var set = NewSet();
            var info = NewInfo();
            try {
                if (!SetupDiCreateDeviceInfoW(set, "Net", ref NetworkClass,
                    null, IntPtr.Zero, 1, ref info)) throw Error("Create loopback device");
                // Both IDs are persisted on the device before registration.
                // The unique secondary ID binds an incomplete device to its journal.
                byte[] ids = Encoding.Unicode.GetBytes("*MSLOOP\0" + marker + "\0\0");
                if (!SetupDiSetDeviceRegistryPropertyW(set, ref info, 1, ids,
                    (uint)ids.Length)) throw Error("Set loopback hardware ID");
                if (!SetupDiCallClassInstaller(0x19, set, ref info)) throw Error("Register loopback device");
                CheckRestart(set, ref info);
                uint required;
                var buffer = new StringBuilder(512);
                if (!SetupDiGetDeviceInstanceIdW(set, ref info, buffer, 512,
                    out required)) throw Error("Read loopback identity");
                string instance = buffer.ToString();
                if (!IsTestDeviceId(instance)) throw new InvalidOperationException("Unexpected new device identity: " + instance);
                return instance;
            } finally { SetupDiDestroyDeviceInfoList(set); }
        }

        public static void Install(string instance, string inf) {
            if (!IsTestDeviceId(instance)) throw new ArgumentException("Invalid exact installation target.");
            var set = NewSet();
            var info = NewInfo();
            bool driverListBuilt = false;
            try {
                if (!SetupDiOpenDeviceInfoW(set, instance, IntPtr.Zero, 0,
                    ref info)) throw Error("Open exact new device for installation");
                var install = ReadInstallParams(set, ref info);
                // DI_ENUMSINGLEINF | DI_NOWRITE_IDS | DI_QUIETINSTALL.
                // Never rewrite the unique secondary root-device hardware ID.
                install.Flags |= 0x00010000U | 0x80000000U | 0x00800000U;
                install.DriverPath = inf;
                if (!SetupDiSetDeviceInstallParamsW(set, ref info, ref install))
                    throw Error("Restrict driver installation to inbox INF and preserve IDs");
                if (!SetupDiBuildDriverInfoList(set, ref info, 2))
                    throw Error("Build exact device compatible-driver list");
                driverListBuilt = true;
                if (!SetupDiCallClassInstaller(0x17, set, ref info))
                    throw Error("Select best compatible inbox loopback driver");
                CheckRestart(set, ref info);
                if (!SetupDiCallClassInstaller(2, set, ref info))
                    throw Error("Install exact new loopback device");
                CheckRestart(set, ref info);
            } finally {
                if (driverListBuilt) SetupDiDestroyDriverInfoList(set, ref info, 2);
                SetupDiDestroyDeviceInfoList(set);
            }
        }

        public static bool IsTestDeviceId(string instance) {
            return instance != null && System.Text.RegularExpressions.Regex.IsMatch(instance,
                @"^ROOT\\NET\\[0-9]{4}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        }

        public static bool Remove(string instance) {
            if (!IsTestDeviceId(instance))
                throw new ArgumentException("Refusing non-root network device removal.");
            var set = NewSet();
            var info = NewInfo();
            try {
                if (!SetupDiOpenDeviceInfoW(set, instance, IntPtr.Zero, 0,
                    ref info)) throw Error("Open exact test device");
                return RemoveFromSet(set, ref info);
            } finally { SetupDiDestroyDeviceInfoList(set); }
        }
    }
}
'@
}

function Assert-WdAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Prepare/Restore require Windows PowerShell run as administrator. Status/WhatIf do not.'
    }
}

function Save-WdTestState {
    param($State, [string]$Path)
    Assert-WdTestState $State
    $directory = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    [void][IO.Directory]::CreateDirectory($directory)
    if ([IO.File]::Exists($Path)) { Read-WdTestState $Path | Out-Null }
    $temporary = Join-Path $directory ([guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 4),
            (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($Path)) {
            # PowerShell 5.1 otherwise coerces $null to an invalid empty path.
            [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value)
        }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Read-WdTestState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $state = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-WdTestState $state
    return $state
}

function Get-WdExactAdapter {
    param([string]$DeviceInstanceId)
    $found = @(Get-NetAdapter -IncludeHidden | Where-Object {
        [string]$_.PnPDeviceID -eq $DeviceInstanceId
    })
    if ($found.Count -gt 1) { throw 'Ambiguous PnP identity; refusing to choose an adapter.' }
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}

function Show-WdNetworkStatus {
    param([string]$Path)
    Write-Output 'Adapters (NCM must be Up before DHCP results can be interpreted):'
    Get-NetAdapter | Format-Table Name, InterfaceDescription, Status, ifIndex -AutoSize
    Write-Output 'IPv4 addresses (Preferred / Tentative / Duplicate / Invalid):'
    Get-NetIPAddress -AddressFamily IPv4 |
        Format-Table InterfaceAlias, InterfaceIndex, IPAddress, PrefixLength, AddressState, PrefixOrigin -AutoSize
    Write-Output 'IPv4 DHCP settings:'
    Get-NetIPInterface -AddressFamily IPv4 |
        Format-Table InterfaceAlias, InterfaceIndex, ConnectionState, Dhcp, InterfaceMetric -AutoSize
    Write-Output 'Routes to 192.168.4.0/24:'
    Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '192.168.4.0/24' -ErrorAction SilentlyContinue |
        Format-Table InterfaceAlias, InterfaceIndex, DestinationPrefix, NextHop, RouteMetric -AutoSize
    Write-Output 'Recent Windows address-conflict events (4199):'
    Get-WinEvent -FilterHashtable @{ LogName='System'; Id=4199; StartTime=(Get-Date).AddHours(-1) } -MaxEvents 5 -ErrorAction SilentlyContinue |
        Format-List TimeCreated, Id, Message
    $state = Read-WdTestState $Path
    if ($null -ne $state) {
        Write-Output 'Owned test adapter record:'
        $state | Format-List
    }
}

function Start-WdIpConflictTest {
    param([string]$Path)
    Assert-WdAdministrator
    $state = Read-WdTestState $Path
    if ($null -ne $state -and $state.Status -ne 'Restored') {
        $adapter = Get-WdExactAdapter $state.DeviceInstanceId
        if ((Test-WdOwnedAdapter $state $adapter) -and
            (Test-WdReadyAddress $adapter @(Get-NetIPAddress -AddressFamily IPv4))) {
            Write-Output 'READY: the existing owned test adapter already holds 192.168.4.2/24.'
            return
        }
        throw 'An unfinished test record exists. Run Restore before starting another test.'
    }

    $blocker = Get-WdPreparationBlocker @(Get-NetAdapter -IncludeHidden) `
        @(Get-NetIPAddress -AddressFamily IPv4) @(Get-WdLoopbackDevices)
    if ($blocker) { throw $blocker }
    if (@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -eq $script:WdAdapterName }).Count) {
        throw 'The test adapter name is already used; no adapter will be renamed.'
    }
    $inf = Join-Path $env:windir 'Inf\netloop.inf'
    if (-not (Test-Path -LiteralPath $inf)) { throw 'Windows inbox netloop.inf is missing.' }
    Initialize-WdLoopbackApi
    $state = [pscustomobject]@{
        Owner = $script:WdOwner
        OwnershipToken = [guid]::NewGuid().ToString()
        DeviceInstanceId = ''
        InterfaceGuid = ''
        Address = $script:WdAddress
        PrefixLength = 24
        CreatedAt = (Get-Date).ToString('o')
        Status = 'Creating'
    }
    # Journal precedes the persistent device. The unique hardware-ID marker
    # can recover even a process interruption before its PnP ID/GUID is saved.
    Save-WdTestState $state $Path
    try {
        $createdId = [WirelessDebug.IpConflict.Native]::CreateRegistered((Get-WdOwnershipMarker $state))
        $state.DeviceInstanceId = $createdId
        $state.Status = 'Registered'
        Save-WdTestState $state $Path
        $loopbacks = @(Get-WdLoopbackDevices)
        if ($loopbacks.Count -ne 1 -or -not (Test-WdOwnedDevice $state $loopbacks[0])) {
            throw 'Driver installation refused: not all matching PnP devices belong to this test.'
        }
        [WirelessDebug.IpConflict.Native]::Install($createdId, $inf)
        if (@(Get-WdLoopbackDevices | Where-Object { Test-WdOwnedDevice $state $_ }).Count -ne 1) {
            throw 'Installed device ownership marker could not be verified; preparation cancelled.'
        }
        $adapter = $null
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $adapter = Get-WdExactAdapter $createdId
            if ($null -ne $adapter) { break }
            Start-Sleep -Seconds 1
        }
        if ($null -eq $adapter) { throw 'The new loopback did not appear in NetAdapter within 20 seconds.' }
        $state.InterfaceGuid = [string]$adapter.InterfaceGuid
        $state.Status = 'Prepared'
        # Persist the exact device identity BEFORE any IP or rename operation.
        Save-WdTestState $state $Path
        $adapter | Rename-NetAdapter -NewName $script:WdAdapterName -Confirm:$false -ErrorAction Stop
        $adapter = Get-WdExactAdapter $createdId
        New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $script:WdAddress -PrefixLength 24 `
            -AddressFamily IPv4 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $adapter = Get-WdExactAdapter $createdId
            $ready = Test-WdReadyAddress $adapter @(Get-NetIPAddress -AddressFamily IPv4)
            if ($ready) { break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Test IP did not reach Preferred state; preparation is NOT ready.' }
        $state.Status = 'Ready'
        Save-WdTestState $state $Path
        Write-Output 'READY: WD-IP-Conflict-Test holds 192.168.4.2/24 (Preferred), without gateway or DNS.'
        Write-Output 'Now insert ESP32 native USB, then run this script with -Action Status.'
        Write-Output "Restore command: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Restore"
    } catch {
        $original = $_
        try {
            Restore-WdIpConflictTest $Path
        } catch {
            Write-Warning "Cleanup incomplete. Keep the state file and run Restore. $_"
        }
        throw $original
    }
}

function Restore-WdIpConflictTest {
    param([string]$Path)
    Assert-WdAdministrator
    $state = Read-WdTestState $Path
    if ($null -eq $state) { throw 'No owned state record exists; refusing to remove any adapter.' }
    if ($state.Status -eq 'Restored') { Write-Output 'Already restored; no device changes.'; return }
    $matches = @(Get-WdLoopbackDevices | Where-Object { Test-WdOwnedDevice $state $_ })
    if ($matches.Count -gt 1) { throw 'Ambiguous ownership marker; refusing removal.' }
    if ($matches.Count -eq 0) {
        if ($state.DeviceInstanceId) {
            $device = Get-PnpDevice -InstanceId $state.DeviceInstanceId -ErrorAction SilentlyContinue
            if ($null -ne $device) { throw 'Recorded PnP device exists but ownership no longer matches; refusing removal.' }
        }
        $state.Status = 'Restored'
        Save-WdTestState $state $Path
        Write-Output 'The recorded test device is already absent; no other adapter was changed.'
        return
    }
    $state.DeviceInstanceId = [string]$matches[0].InstanceId
    $adapter = Get-WdExactAdapter $state.DeviceInstanceId
    if ($state.InterfaceGuid -and $null -ne $adapter -and
        -not (Test-WdOwnedAdapter $state $adapter)) { throw 'Adapter identity changed; refusing removal.' }
    $state.Status = 'RestorePending'
    Save-WdTestState $state $Path
    $rebootRequired = Invoke-WdLoopbackRemoval $state.DeviceInstanceId
    if ($rebootRequired) {
        Write-Warning 'Windows requires a restart to complete device removal. State kept as RestorePending; reboot when convenient, then run Restore again.'
        return
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        if ($null -eq (Get-WdExactAdapter $state.DeviceInstanceId) -and
            $null -eq (Get-PnpDevice -InstanceId $state.DeviceInstanceId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    if ($null -ne (Get-WdExactAdapter $state.DeviceInstanceId) -or
        $null -ne (Get-PnpDevice -InstanceId $state.DeviceInstanceId -ErrorAction SilentlyContinue)) {
        throw 'Removal has not completed; state retained for recovery.'
    }
    $state.Status = 'Restored'
    Save-WdTestState $state $Path
    Write-Output 'RESTORED: removed only the owned test adapter and its temporary IP/routes. State record retained.'
}

function Invoke-WdLoopbackRemoval {
    param([string]$DeviceInstanceId)
    Initialize-WdLoopbackApi
    return [WirelessDebug.IpConflict.Native]::Remove($DeviceInstanceId)
}

# Dot-sourcing exposes validation functions to non-mutating regression tests.
if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    if ($Action -eq 'Status') {
        Show-WdNetworkStatus $StatePath
    } elseif ($PSCmdlet.ShouldProcess('New owned KM-TEST loopback only', "$Action the 192.168.4.2 collision test")) {
        $mutex = New-Object Threading.Mutex($false, 'Local\WirelessDebug.IpConflictTest')
        $locked = $false
        try {
            $locked = $mutex.WaitOne(0)
            if (-not $locked) { throw 'Another test preparation/restoration is running.' }
            if ($Action -eq 'Prepare') { Start-WdIpConflictTest $StatePath }
            else { Restore-WdIpConflictTest $StatePath }
        } finally {
            if ($locked) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }
}
