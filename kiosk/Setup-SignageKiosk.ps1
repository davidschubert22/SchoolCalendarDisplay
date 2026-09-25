<#
.SYNOPSIS
  Turns a Windows 11 Pro/Education PC into a DTES signage kiosk.

.DESCRIPTION
  Run once per PC from an elevated PowerShell prompt. Safe to re-run: every
  step overwrites its own previous settings.

    1. Time zone + internet time sync
    2. Power: never sleep, never blank the display, no hibernate
    3. Windows Update: install and restart overnight only
    4. Quiet Windows: no lock screen, tips, toasts, error pop-ups, consumer apps
    5. Microsoft Edge policies: no first-run, sign-in, sync, translate prompts;
       video autoplay allowed
    6. (optional) Join a Wi-Fi network automatically
    7. Assigned Access kiosk: an auto-logon local account that runs Edge
       full screen on the signage URL, relaunching it if it closes
    8. Daily reboot at a quiet hour
    9. (optional) Roku TV on/off schedule over the network (ECP)

  Log: C:\ProgramData\DTES-Signage\setup.log

.PARAMETER Url
  The board's address. -ScreenId is appended as ?screen=... so each screen
  shows up by name in the status page.

.PARAMETER ScreenId
  Short name for this screen, e.g. "Front-Office" or "Cafeteria".

.PARAMETER RokuIp
  The Roku TV's IP address (set a DHCP reservation for it). Leave empty to
  skip the TV schedule. On the TV: Settings > System > Advanced system
  settings > Control by mobile apps > Network access = Enabled/Permissive,
  and Settings > System > Power > Fast TV start = On (so it can be woken
  over the network).

.PARAMETER Remove
  Undo the kiosk (Assigned Access, scheduled tasks). Leaves the power,
  update and Edge settings in place.

.EXAMPLE
  .\Setup-SignageKiosk.ps1 -ScreenId Front-Office -RokuIp 10.20.30.40

.EXAMPLE
  .\Setup-SignageKiosk.ps1 -ScreenId Cafeteria -WifiSsid "DTES-Guest" -WifiPassword "..." -TvOnTime 06:45 -TvOffTime 17:00

.EXAMPLE
  .\Setup-SignageKiosk.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string]$Url = 'https://davidschubert22.github.io/SchoolCalendarDisplay/',
  [string]$ScreenId = $env:COMPUTERNAME,
  [string]$TimeZone = 'Eastern Standard Time',
  [string]$KioskDisplayName = 'DTES Signage',
  [string]$RebootTime = '03:30',
  [int]$ActiveHoursStart = 5,
  [int]$ActiveHoursEnd = 22,
  [string]$WifiSsid,
  [string]$WifiPassword,
  [string]$RokuIp,
  [string]$RokuInput = 'InputHDMI1',
  [string]$TvOnTime = '07:00',
  [string]$TvOffTime = '17:30',
  [ValidateSet('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')]
  [string[]]$TvDays = @('Monday','Tuesday','Wednesday','Thursday','Friday'),
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:ProgramData 'DTES-Signage'
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Start-Transcript -Path (Join-Path $Root 'setup.log') -Append | Out-Null

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

function Set-Reg([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

# Runs a script block's text as SYSTEM via a one-shot scheduled task and waits
# for it. Needed for the Assigned Access WMI bridge, which rejects admins.
function Invoke-AsSystem([string]$ScriptText, [string]$Name) {
  $file = Join-Path $Root "$Name.ps1"
  $log = Join-Path $Root "$Name.log"
  $wrapped = @"
`$ErrorActionPreference = 'Stop'
Start-Transcript -Path '$log' -Force | Out-Null
try {
$ScriptText
} catch {
  Write-Output ("ERROR: " + (`$_ | Out-String))
  Stop-Transcript | Out-Null
  exit 1
}
Stop-Transcript | Out-Null
exit 0
"@
  Set-Content -Path $file -Value $wrapped -Encoding UTF8
  Remove-Item $log -ErrorAction SilentlyContinue
  $taskName = "DTES-Signage-$Name"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$file`""
  Register-ScheduledTask -TaskName $taskName -Action $action -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddMinutes(3)
  do { Start-Sleep -Seconds 2 } while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running' -and (Get-Date) -lt $deadline)
  $result = (Get-ScheduledTaskInfo -TaskName $taskName).LastTaskResult
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  if (Test-Path $log) { Get-Content $log | ForEach-Object { Write-Host "   $_" } }
  if ($result -ne 0) { throw "$Name failed as SYSTEM (result $result). See $log" }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated (Run as administrator) PowerShell window.'
}

$edition = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Host "Windows: $edition"
if ($edition -match 'Home') { throw 'Windows Home does not support Assigned Access kiosk mode.' }

# ── Remove ──────────────────────────────────────────────────────────────────
if ($Remove) {
  Step 'Removing kiosk configuration'
  Invoke-AsSystem -Name 'ClearAssignedAccess' -ScriptText @'
$obj = Get-CimInstance -Namespace 'root\cimv2\mdm\dmmap' -ClassName 'MDM_AssignedAccess'
$obj.Configuration = $null
Set-CimInstance -CimInstance $obj
'Assigned Access cleared.'
'@
  Get-ScheduledTask -TaskName 'DTES-Signage-*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Write-Host 'Done. Sign out or restart. The auto-logon kiosk account is removed by Windows with the configuration.'
  Stop-Transcript | Out-Null
  return
}

# ── 1. Time ─────────────────────────────────────────────────────────────────
Step "Time zone: $TimeZone, internet time sync"
Set-TimeZone -Id $TimeZone
Set-Service -Name W32Time -StartupType Automatic
Start-Service W32Time -ErrorAction SilentlyContinue
w32tm /config /manualpeerlist:"time.windows.com,0x9 time.nist.gov,0x9" /syncfromflags:manual /reliable:no /update | Out-Null
w32tm /resync /force 2>$null | Out-Null
# Don't let "set time zone automatically" (location based) override it.
Set-Reg 'HKLM:\SYSTEM\CurrentControlSet\Services\tzautoupdate' 'Start' 4

# ── 2. Power ────────────────────────────────────────────────────────────────
Step 'Power: never sleep or turn off the display'
powercfg /setactive SCHEME_BALANCED
foreach ($s in 'monitor-timeout-ac','monitor-timeout-dc','standby-timeout-ac','standby-timeout-dc','hibernate-timeout-ac','hibernate-timeout-dc','disk-timeout-ac') {
  powercfg /change $s 0
}
powercfg /hibernate off
# USB selective suspend off (keeps USB Wi-Fi/Ethernet adapters awake)
powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
powercfg /setactive SCHEME_CURRENT
# Let the network adapters stay powered
Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object {
  try { Disable-NetAdapterPowerManagement -Name $_.Name -NoRestart -ErrorAction Stop } catch { }
}

# ── 3. Windows Update ───────────────────────────────────────────────────────
Step "Windows Update: active hours ${ActiveHoursStart}:00-${ActiveHoursEnd}:00, installs at 3 AM"
$wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
Set-Reg $wu 'SetActiveHours' 1
Set-Reg $wu 'ActiveHoursStart' $ActiveHoursStart
Set-Reg $wu 'ActiveHoursEnd' $ActiveHoursEnd
Set-Reg "$wu\AU" 'NoAutoUpdate' 0
Set-Reg "$wu\AU" 'AUOptions' 4            # auto download, scheduled install
Set-Reg "$wu\AU" 'ScheduledInstallDay' 0  # every day
Set-Reg "$wu\AU" 'ScheduledInstallTime' 3
Set-Reg "$wu\AU" 'AlwaysAutoRebootAtScheduledTime' 1

# ── 4. Quiet Windows ────────────────────────────────────────────────────────
Step 'Quiet Windows: no lock screen, tips, toasts or error dialogs'
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' 'NoLockScreen' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableWindowsConsumerFeatures' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableSoftLanding' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent' 'DisableCloudOptimizedContent' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' 'DisablePrivacyExperience' 1
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' 'DontShowUI' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Error Reporting' 'DontShowUI' 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Reliability' 'ShutdownReasonOn' 0
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'DisableAcrylicBackgroundOnLogon' 1

# Per-user settings for accounts created from now on (the kiosk account):
# no screen saver, no notification toasts, no "finish setting up" nags.
Step 'Default user profile: no screen saver or notifications'
$hive = 'HKU\DTESDefault'
reg load $hive "$env:SystemDrive\Users\Default\NTUSER.DAT" | Out-Null
try {
  $du = 'Registry::HKEY_USERS\DTESDefault'
  Set-Reg "$du\Software\Policies\Microsoft\Windows\Control Panel\Desktop" 'ScreenSaveActive' '0' 'String'
  Set-Reg "$du\Software\Policies\Microsoft\Windows\CurrentVersion\PushNotifications" 'NoToastApplicationNotification' 1
  Set-Reg "$du\Software\Policies\Microsoft\Windows\Explorer" 'DisableNotificationCenter' 1
  Set-Reg "$du\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement" 'ScoobeSystemSettingEnabled' 0
  Set-Reg "$du\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'SubscribedContent-310093Enabled' 0
  Set-Reg "$du\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager" 'SoftLandingEnabled' 0
} finally {
  [gc]::Collect(); Start-Sleep -Milliseconds 500
  reg unload $hive | Out-Null
}

# ── 5. Edge policies ────────────────────────────────────────────────────────
Step 'Microsoft Edge policies'
$edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
$edgePolicies = [ordered]@{
  HideFirstRunExperience = 1
  AutoplayAllowed = 1
  BrowserSignin = 0
  SyncDisabled = 1
  TranslateEnabled = 0
  DefaultNotificationsSetting = 2
  DefaultGeolocationSetting = 2
  PasswordManagerEnabled = 0
  AutofillAddressEnabled = 0
  AutofillCreditCardEnabled = 0
  ShowRecommendationsEnabled = 0
  SpotlightExperiencesAndRecommendationsEnabled = 0
  PersonalizationReportingEnabled = 0
  EdgeShoppingAssistantEnabled = 0
  HubsSidebarEnabled = 0
  StartupBoostEnabled = 0
  BackgroundModeEnabled = 0
  PromptForDownloadLocation = 0
  RestoreOnStartup = 5          # never offer to "restore pages" after a crash or reboot
  HardwareAccelerationModeEnabled = 1
}
foreach ($k in $edgePolicies.Keys) { Set-Reg $edge $k $edgePolicies[$k] }

# ── 6. Wi-Fi ────────────────────────────────────────────────────────────────
if ($WifiSsid) {
  Step "Wi-Fi profile: $WifiSsid (connect automatically, all users)"
  $esc = { param($s) [Security.SecurityElement]::Escape($s) }
  $auth = if ($WifiPassword) { 'WPA2PSK' } else { 'open' }
  $enc = if ($WifiPassword) { 'AES' } else { 'none' }
  $keyXml = if ($WifiPassword) { "<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>$(& $esc $WifiPassword)</keyMaterial></sharedKey>" } else { '' }
  $profileXml = @"
<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>$(& $esc $WifiSsid)</name>
  <SSIDConfig><SSID><name>$(& $esc $WifiSsid)</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption><authentication>$auth</authentication><encryption>$enc</encryption><useOneX>false</useOneX></authEncryption>
    $keyXml
  </security></MSM>
</WLANProfile>
"@
  $wf = Join-Path $Root 'wifi.xml'
  Set-Content -Path $wf -Value $profileXml -Encoding UTF8
  netsh wlan add profile filename="$wf" user=all | Write-Host
  Remove-Item $wf -Force   # it contains the passphrase
  netsh wlan connect name="$WifiSsid" | Out-Null
}

# ── 7. Assigned Access (kiosk) ──────────────────────────────────────────────
$kioskUrl = $Url
if ($ScreenId) {
  $sep = if ($kioskUrl.Contains('?')) { '&' } else { '?' }
  $kioskUrl = "$kioskUrl$sep" + 'screen=' + [uri]::EscapeDataString($ScreenId)
}
Step "Kiosk: Edge full screen on $kioskUrl"

$edgeArgs = "--kiosk `"$kioskUrl`" --edge-kiosk-type=fullscreen --no-first-run --autoplay-policy=no-user-gesture-required"
$profileId = '{4B2F6C1E-3D7A-4E0B-9C51-8A2D0F6E7B13}'
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<AssignedAccessConfiguration
    xmlns="http://schemas.microsoft.com/AssignedAccess/2017/config"
    xmlns:rs5="http://schemas.microsoft.com/AssignedAccess/201810/config"
    xmlns:v4="http://schemas.microsoft.com/AssignedAccess/2021/config">
  <Profiles>
    <Profile Id="$profileId">
      <KioskModeApp v4:ClassicAppPath="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
                    v4:ClassicAppArguments="$([Security.SecurityElement]::Escape($edgeArgs))" />
    </Profile>
  </Profiles>
  <Configs>
    <Config>
      <AutoLogonAccount rs5:DisplayName="$([Security.SecurityElement]::Escape($KioskDisplayName))" />
      <DefaultProfile Id="$profileId" />
    </Config>
  </Configs>
</AssignedAccessConfiguration>
"@
$xmlPath = Join-Path $Root 'AssignedAccess.xml'
Set-Content -Path $xmlPath -Value $xml -Encoding UTF8

Invoke-AsSystem -Name 'ApplyAssignedAccess' -ScriptText @"
`$xml = Get-Content -Raw -Path '$xmlPath'
`$obj = Get-CimInstance -Namespace 'root\cimv2\mdm\dmmap' -ClassName 'MDM_AssignedAccess'
`$obj.Configuration = [System.Net.WebUtility]::HtmlEncode(`$xml)
Set-CimInstance -CimInstance `$obj
'Assigned Access configuration applied.'
"@

# ── 8. Daily reboot ─────────────────────────────────────────────────────────
Step "Daily reboot at $RebootTime"
$rebootAction = New-ScheduledTaskAction -Execute 'shutdown.exe' -Argument '/r /f /t 60 /c "DTES signage nightly restart"'
$rebootTrigger = New-ScheduledTaskTrigger -Daily -At $RebootTime
Register-ScheduledTask -TaskName 'DTES-Signage-NightlyReboot' -Action $rebootAction -Trigger $rebootTrigger `
  -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

# ── 9. Roku TV schedule ─────────────────────────────────────────────────────
Get-ScheduledTask -TaskName 'DTES-Signage-TV*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
if ($RokuIp) {
  Step "Roku TV at ${RokuIp}: on $TvOnTime, off $TvOffTime ($($TvDays -join ', '))"
  $rokuScript = Join-Path $Root 'roku.ps1'
  Set-Content -Path $rokuScript -Encoding UTF8 -Value @'
param([Parameter(Mandatory)][string]$Ip, [Parameter(Mandatory)][ValidateSet('on','off')][string]$State, [string]$InputKey = 'InputHDMI1')
# Roku External Control Protocol: http://<tv>:8060/keypress/<key>
$log = Join-Path $env:ProgramData 'DTES-Signage\roku.log'
function Send($key) {
  for ($i = 1; $i -le 5; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://${Ip}:8060/keypress/$key" -TimeoutSec 5 | Out-Null
      Add-Content $log "$(Get-Date -Format s) $key ok"
      return $true
    } catch {
      Add-Content $log "$(Get-Date -Format s) $key attempt $i failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 10
    }
  }
  return $false
}
if ($State -eq 'on') {
  if (Send 'PowerOn') { Start-Sleep -Seconds 8; Send $InputKey | Out-Null }
} else {
  Send 'PowerOff' | Out-Null
}
'@
  foreach ($pair in @(@('on', $TvOnTime), @('off', $TvOffTime))) {
    $state, $time = $pair
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$rokuScript`" -Ip $RokuIp -State $state -InputKey $RokuInput"
    $t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $TvDays -At $time
    $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName "DTES-Signage-TV-$state" -Action $a -Trigger $t -Settings $s `
      -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  }
  Write-Host "   Test it now:  powershell -File `"$rokuScript`" -Ip $RokuIp -State on"
}

Step 'Done'
Write-Host "Restart the PC. It will sign in to '$KioskDisplayName' automatically and open the board."
Write-Host "To get back to an admin desktop: press Ctrl+Alt+Del, sign out, then choose your admin account."
Write-Host "Log: $(Join-Path $Root 'setup.log')"
Stop-Transcript | Out-Null
