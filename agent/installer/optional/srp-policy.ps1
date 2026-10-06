<#
  srp-policy.ps1 - OPTIONAL hardening. NOT wired into the installer. Run as Administrator.

  What it does
    Adds Software Restriction Policy (SRP) rules that stop programs from RUNNING out of
    folders a standard user can write to (Downloads, Desktop, Videos, Temp, Public ...).
    This closes the "download a portable video player and run it" hole, which no file
    lock can close. Local administrators are exempt (PolicyScope = 1), so installers
    keep working when someone elevates. Works on Windows Pro (AppLocker would need
    Enterprise/Education).

  Usage
    .\srp-policy.ps1 -Apply                       # add the rules
    .\srp-policy.ps1 -Apply -ExtraPaths 'D:\','E:\'   # also block running from these drives (USB letters)
    .\srp-policy.ps1 -Remove                      # take every rule this script added out again
    .\srp-policy.ps1 -Status

  IMPORTANT - test on ONE machine first.
    Per-user programs that install into AppData (Chrome, Teams, Zoom, VS Code ...) are NOT
    touched on purpose. Programs that run installers/updaters from %TEMP% or Downloads as a
    normal user WILL stop working. Restart open applications (or sign out/in) after changing.
#>
param(
  [switch]$Apply,
  [switch]$Remove,
  [switch]$Status,
  [string[]]$ExtraPaths = @()
)

$ErrorActionPreference = 'Stop'
$base   = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Safer\CodeIdentifiers'
$paths0 = Join-Path $base '0\Paths'            # level 0 = Disallowed
$marker = 'ContentBlockerAgent'                # written into every rule we create

# Folders where a standard user can drop and run an exe. Environment variables are per-user.
$blockedPaths = @(
  '%USERPROFILE%\Downloads',
  '%USERPROFILE%\Desktop',
  '%USERPROFILE%\Videos',
  '%USERPROFILE%\Documents',
  '%USERPROFILE%\OneDrive',
  '%PUBLIC%',
  '%TEMP%'
) + $ExtraPaths

function Test-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) { throw 'Run this script as Administrator.' }

function Get-OurRules {
  if (-not (Test-Path $paths0)) { return @() }
  Get-ChildItem $paths0 | Where-Object {
    (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).Description -eq $marker
  }
}

if ($Status) {
  $rules = @(Get-OurRules)
  "Rules added by this script: $($rules.Count)"
  $rules | ForEach-Object { '  ' + (Get-ItemProperty $_.PSPath).ItemData }
  return
}

if ($Remove) {
  $rules = @(Get-OurRules)
  $rules | ForEach-Object { Remove-Item $_.PSPath -Force }
  "Removed $($rules.Count) rule(s)."
  # If WE created the policy root and nothing else lives in it, remove it completely
  # so the machine returns to its exact previous state.
  if (Test-Path $base) {
    $created = (Get-ItemProperty $base -ErrorAction SilentlyContinue).CBAgentCreatedBase
    $left = if (Test-Path $paths0) { @(Get-ChildItem $paths0).Count } else { 0 }
    if ($created -eq 1 -and $left -eq 0) {
      Remove-Item $base -Recurse -Force
      'Removed the (empty) policy root created by this script.'
    }
  }
  'Done. Sign out/in (or reboot) so running sessions pick it up.'
  return
}

if ($Apply) {
  $createdBase = $false
  if (-not (Test-Path $base)) {
    New-Item -Path $base -Force | Out-Null
    $createdBase = $true
    New-ItemProperty $base -Name CBAgentCreatedBase -Value 1 -PropertyType DWord -Force | Out-Null
    # Unrestricted by default; only the listed paths are disallowed.
    New-ItemProperty $base -Name DefaultLevel        -Value 262144 -PropertyType DWord -Force | Out-Null
    New-ItemProperty $base -Name PolicyScope         -Value 1      -PropertyType DWord -Force | Out-Null  # all users except local administrators
    New-ItemProperty $base -Name TransparentEnabled  -Value 1      -PropertyType DWord -Force | Out-Null  # executables only (not DLLs)
    New-ItemProperty $base -Name AuthenticodeEnabled -Value 0      -PropertyType DWord -Force | Out-Null
    New-ItemProperty $base -Name ExecutableTypes -PropertyType MultiString -Force `
      -Value @('EXE','MSI','BAT','CMD','COM','SCR','PIF') | Out-Null
  } else {
    'Existing Software Restriction Policy found - keeping its settings, only adding our path rules.'
  }
  New-Item -Path $paths0 -Force | Out-Null

  $existing = @{}
  Get-OurRules | ForEach-Object { $existing[(Get-ItemProperty $_.PSPath).ItemData.ToLower()] = $true }

  foreach ($p in $blockedPaths) {
    if ($existing.ContainsKey($p.ToLower())) { "already present: $p"; continue }
    $key = Join-Path $paths0 ('{' + [guid]::NewGuid().ToString() + '}')
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty $key -Name ItemData    -Value $p      -PropertyType String -Force | Out-Null
    New-ItemProperty $key -Name SaferFlags  -Value 0       -PropertyType DWord  -Force | Out-Null
    New-ItemProperty $key -Name Description -Value $marker -PropertyType String -Force | Out-Null
    "added rule: $p"
  }
  'Done. Sign out/in (or reboot). To undo: .\srp-policy.ps1 -Remove'
  return
}

'Nothing to do. Use -Apply, -Remove or -Status.'
