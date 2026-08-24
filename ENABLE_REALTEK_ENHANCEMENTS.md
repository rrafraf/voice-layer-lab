# Enable Realtek microphone audio enhancements

Open **PowerShell as Administrator**, paste the complete block below, and press Enter.

```powershell
$ErrorActionPreference = 'Stop'

$path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\{76999d1d-919a-4309-a02c-20737b84c0fa}\FxProperties'
$name = '{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5'
$backup = 'D:\Documents\GitHub\_local\voice-layer-lab\logs\realtek-mic-fx-backup-before-admin.reg'

# Back up the complete Realtek microphone effects configuration.
reg.exe export 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\{76999d1d-919a-4309-a02c-20737b84c0fa}\FxProperties' $backup /y
if ($LASTEXITCODE -ne 0) {
    throw "Registry backup failed with exit code $LASTEXITCODE"
}

# Current value: 1 means system effects are disabled.
$before = Get-ItemPropertyValue -LiteralPath $path -Name $name
Write-Host "Before: $before"

# Enable Windows/Realtek system effects.
Set-ItemProperty -LiteralPath $path -Name $name -Type DWord -Value 0

# Verify: this must print 0.
$after = Get-ItemPropertyValue -LiteralPath $path -Name $name
Write-Host "After:  $after"

if ($after -ne 0) {
    throw "The setting did not change; expected 0 but found $after"
}

Write-Host 'Success. Fully quit and reopen Codex, then test Dictation.' -ForegroundColor Green
```

Expected ending:

```text
After:  0
Success. Fully quit and reopen Codex, then test Dictation.
```

## Roll back

Run this in **PowerShell as Administrator** if you need to restore the previous configuration:

```powershell
reg.exe import 'D:\Documents\GitHub\_local\voice-layer-lab\logs\realtek-mic-fx-backup-before-admin.reg'
```
