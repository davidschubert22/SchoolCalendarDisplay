# Kiosk PC setup

`Setup-SignageKiosk.ps1` configures a Windows 11 Pro/Education PC as a
signage kiosk in one pass. It's safe to re-run.

## Steps per PC

1. Finish Windows setup with a **local admin account** (not the kiosk; the
   script creates that). Install updates and let Edge update itself once.
2. BIOS/UEFI: **power on after AC loss** (so power outages recover on their own).
3. Copy the `kiosk` folder to the PC, open **PowerShell as administrator**, and run:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\Setup-SignageKiosk.ps1 -ScreenId Front-Office -WifiSsid "Guest-SSID" -WifiPassword "..." -RokuIp 10.x.x.x
   ```
   All parameters are optional; `Get-Help .\Setup-SignageKiosk.ps1 -Full` lists them.
4. Restart. The PC signs in to the **DTES Signage** account and opens the board full screen.

To reach the admin desktop, press **Ctrl+Alt+Del**, choose **Sign out**, then
pick your admin account. To undo the kiosk: `.\Setup-SignageKiosk.ps1 -Remove`.

## What it sets

| Area | Setting |
| --- | --- |
| Time | Time zone (default Eastern); syncs with time.windows.com / time.nist.gov; location-based time-zone changes off |
| Power | Display, sleep, disk never turn off; hibernate off; USB and network adapter power saving off |
| Windows Update | Active hours 5 AM–10 PM; installs and restarts at 3 AM |
| Quiet | No lock screen, tips, "finish setup" nags, notification toasts, error-report pop-ups; screen saver off for the kiosk account |
| Edge | No first run, sign-in, sync, translate, shopping or sidebar; autoplay allowed; never "restore pages" |
| Wi-Fi | Optional: saves the SSID for all users with auto-connect |
| Kiosk | Assigned Access auto-logon account running Edge `--kiosk <url>?screen=<ScreenId> --edge-kiosk-type=fullscreen`. Windows relaunches Edge if it closes |
| Reboot | Daily at 3:30 AM |
| TV | Optional: Roku on/off schedule (below) |

The log is at `C:\ProgramData\DTES-Signage\setup.log`.

## Roku TVs

Roku TVs have no scheduled power-on. The Sleep Timer only turns the TV off
once. Instead, the PC turns the TV on and off over the network with Roku's
External Control Protocol, using `POST http://<tv>:8060/keypress/PowerOn`.

Requirements:
- The TV and the PC on the **same network**, with guest-network client
  isolation not blocking device-to-device traffic. Test this first (below).
- On the TV: **Settings → System → Advanced system settings → Control by
  mobile apps → Network access → Enabled** (or Permissive). The default,
  Limited, blocks this.
- On the TV: **Settings → System → Power → Fast TV start → On**, so its network
  stays awake in standby.
- A DHCP reservation for the TV's IP.
- On the TV, set **Power → Power on** to the PC's HDMI input. The script also
  sends `InputHDMI1` after power-on; change it with `-RokuInput InputHDMI2` etc.

Test from the PC before relying on the schedule:
```powershell
Invoke-WebRequest -UseBasicParsing -Method Post http://10.x.x.x:8060/keypress/PowerOff
Invoke-WebRequest -UseBasicParsing -Method Post http://10.x.x.x:8060/keypress/PowerOn
```
If these time out, client isolation is probably blocking them. The fallback is
leaving the TVs on, or a smart plug with a schedule; the Roku comes back on its
last input when power returns, if **Power on** is set that way.

Schedule defaults: on at 7:00 AM, off at 5:30 PM, Monday–Friday
(`-TvOnTime`, `-TvOffTime`, `-TvDays`). Results are logged to
`C:\ProgramData\DTES-Signage\roku.log`.

## Checking on screens remotely

If the `signage-api` Worker is deployed (see `../worker/README.md`), each
screen checks in every 15 minutes under its `-ScreenId`. The status page lists
every screen and flags any that stopped reporting.
