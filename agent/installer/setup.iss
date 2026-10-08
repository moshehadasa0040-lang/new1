; Content Blocker Agent - Inno Setup script
; Builds a single installer .exe that:
;   1) copies the packaged agent executable + NSSM + the uninstall helper
;   2) uses NSSM to register + start the agent as a real Windows service
;      (NSSM wraps any standalone .exe as a service - this avoids the
;      node-windows + pkg incompatibility that broke service registration
;      when the agent is a single bundled executable)
;   3) registers a proper uninstaller in "Add or remove programs"
;
; This file is compiled automatically by the GitHub Action
; (.github/workflows/build-installer.yml) using ISCC.exe. That workflow
; downloads nssm.exe into this folder before compiling, and expects the
; pkg-built agent exe at agent\dist\content-blocker-agent.exe

#define MyAppName "Content Blocker Agent"
; The build workflow passes /DMyAppVersion=<agent/package.json version>; this is only the fallback.
#ifndef MyAppVersion
  #define MyAppVersion "1.13.21"
#endif
#define MyAppPublisher "YourNameHere"
#define MyAppExeName "content-blocker-agent.exe"
#define MyServiceName "ContentBlockerAgent"

[Setup]
AppId={{B3B6B6A2-7E9E-4B7E-9A9C-CB0000000001}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\ContentBlockerAgent
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist-installer
OutputBaseFilename=ContentBlockerAgent-Setup
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
; Branding: installer icon, wizard side/corner images, and the icon shown in
; "Add or remove programs". (Images generated into agent\ui\assets.)
SetupIconFile=..\ui\assets\icon.ico
UninstallDisplayIcon={app}\assets\icon.ico
WizardImageFile=..\ui\assets\wizard-large.bmp
WizardSmallImageFile=..\ui\assets\wizard-small.bmp
ArchitecturesInstallIn64BitMode=x64

[UninstallDelete]
; Leftovers that Inno Setup doesn't know about (it only removes files it
; installed itself): the device-name file written at install time, and the
; agent's local state/log folder under ProgramData.
Type: files; Name: "{app}\device-name.txt"
Type: filesandordirs; Name: "{commonappdata}\ContentBlockerAgent"
Type: dirifempty; Name: "{app}"

[Tasks]
; Stops programs from RUNNING out of folders a standard user can write to (Downloads,
; Desktop, Temp, USB drives ...), so a freshly downloaded or portable video player
; cannot start. Administrators are exempt. Untick to skip. See optional\srp-policy.ps1.
Name: "srp"; Description: "Block running programs from Downloads, Desktop, Temp and USB drives (recommended)"

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\content-blocker-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "nssm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-helper.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "watchdog.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "optional\srp-policy.ps1"; DestDir: "{app}"; Flags: ignoreversion
; User-facing UI (see agent\ui): tray icon with About + status menu, the
; installer's live progress window, a launcher that starts PowerShell with no
; console window, and the logo/icons.
Source: "..\ui\tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ui\install-splash.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ui\ps-hidden.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ui\assets\*"; DestDir: "{app}\assets"; Excludes: "wizard-*.bmp"; Flags: ignoreversion

[InstallDelete]
; Leftovers of in-use files that were moved aside by FreeFileForReplace in an earlier update.
Type: files; Name: "{app}\*.old"

[Registry]
; Tray icon starts for every user at logon. It only displays state - the
; protection itself is the Windows service, so closing the icon unblocks nothing.
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ContentBlockerTray"; ValueData: """{sys}\wscript.exe"" ""{app}\ps-hidden.vbs"" tray.ps1"; Flags: uninsdeletevalue

; Safe Mode: without these keys Windows does not start the service in Safe Mode
; (so nothing new would be locked there). Minimal = Safe Mode, Network = Safe Mode
; with Networking. The default value must be the word "Service". Removed on uninstall.
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\{#MyServiceName}"; ValueType: string; ValueData: "Service"; Flags: uninsdeletekey
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\SafeBoot\Network\{#MyServiceName}"; ValueType: string; ValueData: "Service"; Flags: uninsdeletekey

[Code]
var
  DeviceNamePage: TInputQueryWizardPage;

procedure AppendLog(Msg: String);
var
  LogDir: String;
begin
  // Same folder/file the agent logs to, so install + runtime history read
  // as one timeline. Best-effort: logging must never break the install.
  LogDir := 'C:\Users\Public\Documents\ContentBlockerLogs';
  try
    ForceDirectories(LogDir);
    SaveStringToFile(LogDir + '\agent.log',
      '[' + GetDateTimeString('yyyy/mm/dd hh:nn:ss', '-', ':') + '] installer: ' + Msg + #13#10, True);
  except
  end;
end;

function GetComputerNameString(): String;
begin
  // COMPUTERNAME is a standard Windows environment variable - GetEnv is a
  // built-in Inno Setup Pascal Script function, unlike the raw Win32
  // GetComputerName API (which isn't available without an external DLL
  // import this script deliberately avoids for simplicity).
  Result := GetEnv('COMPUTERNAME');
  if Result = '' then
    Result := 'מחשב חדש';
end;

function InitializeSetup: Boolean;
begin
  // First line of a run: the time between the update being handed over and this line is
  // Windows starting Setup, the time after it is Setup itself.
  AppendLog('Setup process started (version {#MyAppVersion}).');
  Result := True;
end;

procedure InitializeWizard;
begin
  // Custom page asking for a friendly name for this machine (e.g. "Living
  // Room PC", "Kids' Room"). Shown to the dashboard instead of the raw
  // Windows computer name, so it's actually possible to tell which
  // physical machine each entry in the device list refers to.
  DeviceNamePage := CreateInputQueryPage(wpSelectDir,
    'זיהוי המחשב', 'איך שם המחשב הזה יופיע בדשבורד?',
    'תן שם שיעזור לך לזהות את המחשב הזה ברשימת המחשבים בדשבורד (למשל: "מחשב סלון", "חדר ילדים"). ניתן לשנות זאת מאוחר יותר גם דרך הדשבורד עצמו.');
  DeviceNamePage.Add('שם המחשב:', False);
  DeviceNamePage.Values[0] := GetComputerNameString();
end;

// The tray icon (tray.ps1), the install progress window (install-splash.ps1) and the
// wscript launchers that start them run in the user's session and keep files of
// the install folder open (logo-128.png ...). Copying over them fails with
// "DeleteFile failed; code 32" - in a silent auto-update that aborts the whole
// update and the computer stays on its old version. Close them first; the tray
// is started again by the last [Run] entry (or at the next logon after a silent update).
procedure StopTrayProcesses;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq ''powershell.exe'' -or $_.Name -eq ''wscript.exe'') -and $_.ProcessId -ne $PID -and $_.CommandLine -match ''tray\.ps1|install-splash\.ps1|ps-hidden\.vbs'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  AppendLog('Closed the tray icon / progress window processes (exit ' + IntToStr(ResultCode) + ').');
end;

// The scheduled task is deleted at the start of setup, but a watchdog.bat run that is
// ALREADY going keeps looping for up to a minute and starts the service again every
// ~15s ("sc start"). Setup stops the service to replace the agent exe, the watchdog
// brings it back, and Windows refuses to delete a running exe:
// "DeleteFile failed; code 5. Access is denied." So kill those loops first.
procedure StopWatchdogLoops;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/delete /tn ContentBlockerWatchdog /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq ''cmd.exe'' -and $_.CommandLine -match ''watchdog\.bat'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function AgentExeRunning: Boolean;
var
  ResultCode: Integer;
begin
  // find.exe exits 0 when it finds the name, 1 when it does not.
  Result := Exec(ExpandConstant('{sys}\cmd.exe'),
    '/c tasklist /fi "imagename eq {#MyAppExeName}" | find /i "{#MyAppExeName}" >nul',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

// Appends the output of a console command to agent.log (diagnostics for failed updates).
procedure LogCmd(Cmd: String);
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\cmd.exe'),
    '/c ' + Cmd + ' >> "C:\Users\Public\Documents\ContentBlockerLogs\agent.log" 2>&1',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Makes one old file of the install folder replaceable, whatever is wrong with it:
//  - an odd/explicit ACL (owner, deny entry) -> take ownership and reset to the inherited
//    defaults; that is what "DeleteFile failed; code 5. Access is denied." means for a
//    file that nothing is running from;
//  - a program that is still running from it -> it cannot be deleted but it CAN be
//    renamed, so move it out of the way (the new file is then written under the old name;
//    the *.old leftovers are removed by [InstallDelete] / the next install).
procedure FreeFileForReplace(FileName: String; Running: Boolean);
var
  ResultCode: Integer;
begin
  if not FileExists(FileName) then Exit;
  LogCmd('icacls "' + FileName + '"');
  Exec(ExpandConstant('{sys}\takeown.exe'), '/f "' + FileName + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\icacls.exe'), '"' + FileName + '" /reset /c', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Running then
  begin
    DeleteFile(FileName + '.old');
    if RenameFile(FileName, FileName + '.old') then
      AppendLog('Moved the in-use file aside: ' + FileName + ' -> .old')
    else
      AppendLog('WARNING: could not move the in-use file aside: ' + FileName);
  end;
end;

// ---- Tray icon survives updates -------------------------------------------------
// Since 1.13.9 the tray loads its images from memory and no longer holds files of the
// install folder, so it can keep running while files are replaced; after the update it
// notices the new version and restarts itself (see Restart-Tray in tray.ps1). Only an
// OLD tray (that opened its "About" window) still locks assets\logo-128.png: that is
// detected by trying to rename the file, and only then are the tray processes closed.
// Milliseconds since Windows started (imported directly: not a built-in script function).
function WinTickCount: Cardinal;
external 'GetTickCount@kernel32.dll stdcall';

var
  InstallStartTick: Cardinal;
  TraysKilled: Boolean;

function InstallSeconds: Integer;
begin
  Result := Integer((WinTickCount - InstallStartTick) div 1000);
end;

function TrayHoldsFiles: Boolean;
var
  Logo: String;
begin
  Result := False;
  Logo := ExpandConstant('{app}\assets\logo-128.png');
  if not FileExists(Logo) then Exit;
  if RenameFile(Logo, Logo + '.chk') then
    RenameFile(Logo + '.chk', Logo)
  else
    Result := True;
end;

// Best effort: start the tray again in the session(s) of the logged-on user(s) after a
// SILENT update had to close an old tray. The installer runs as SYSTEM in session 0 and
// cannot start anything on the user's desktop itself, so a one-time scheduled task that
// runs as the "Users" group, interactively, is used. If Windows refuses, the icon comes
// back at the next logon like before (the result is written to agent.log).
procedure RelaunchTray;
var
  ResultCode: Integer;
  Cmd: String;
begin
  Cmd := '"\"' + ExpandConstant('{sys}\wscript.exe') + '\" \"' + ExpandConstant('{app}\ps-hidden.vbs') + '\" tray.ps1"';
  Exec(ExpandConstant('{sys}\schtasks.exe'),
    '/create /tn ContentBlockerTrayRelaunch /sc once /st 00:00 /ru "BUILTIN\Users" /it /rl limited /f /tr ' + Cmd,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  AppendLog('Tray relaunch task created (exit ' + IntToStr(ResultCode) + ').');
  if ResultCode = 0 then
  begin
    Exec(ExpandConstant('{sys}\schtasks.exe'), '/run /tn ContentBlockerTrayRelaunch', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    AppendLog('Tray relaunch started (exit ' + IntToStr(ResultCode) + ').');
    Sleep(3000);
  end;
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/delete /tn ContentBlockerTrayRelaunch /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// ---- Zero-gap upgrade ----------------------------------------------------------
// The video locks are NTFS permissions: they stay on the files while the service is
// not running. What a stopped service loses is only the player blocking and the locking
// of NEW files. So an automatic (silent) update of an existing install does not stop
// anything while the files are replaced: the old agent keeps running from its old files
// (a running exe cannot be deleted but CAN be renamed - they are moved aside as *.old),
// the new files are written under the normal names, and the service is restarted once at
// the end: a few seconds instead of minutes (and no "file in use" errors, because nothing
// has to be stopped before copying). An interactive install keeps the classic flow.
var
  SilentUpgrade: Boolean;

function ServiceExists: Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    and (ResultCode = 0);
end;

function IsSilentUpgrade: Boolean;
begin
  Result := SilentUpgrade;
end;

function IsNotSilentUpgrade: Boolean;
begin
  Result := not SilentUpgrade;
end;

// Step markers: each logs a time-stamped line right before its [Run] step, so a slow step is
// visible in the log (the time to the next line is how long the step took).
function DefenderFg: Boolean; begin AppendLog('Step: Defender exclusions'); Result := not SilentUpgrade; end;
function DefenderBg: Boolean; begin AppendLog('Step: Defender exclusions (background, upgrade)'); Result := SilentUpgrade; end;
function StepStart: Boolean; begin AppendLog('Step: start service'); Result := not SilentUpgrade; end;
function StepRestart: Boolean; begin AppendLog('Step: restart service'); Result := SilentUpgrade; end;
function SrpFg: Boolean; begin AppendLog('Step: program restrictions (SRP)'); Result := not SilentUpgrade; end;
function SrpBg: Boolean; begin AppendLog('Step: program restrictions (SRP, background, upgrade)'); Result := SilentUpgrade; end;

// Stops the watchdog, then the service, and WAITS until the agent exe is really gone.
procedure StopAgentForInstall;
var
  ResultCode, I: Integer;
  Nssm: String;
begin
  StopWatchdogLoops;
  Nssm := ExpandConstant('{app}\nssm.exe');
  if FileExists(Nssm) then
    Exec(Nssm, 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  for I := 1 to 20 do
  begin
    if not AgentExeRunning then Break;
    // Service is stopped by now (nssm waited), so killing the process cannot make nssm respawn it.
    if I >= 6 then
      Exec(ExpandConstant('{sys}\taskkill.exe'), '/f /t /im {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(500);
  end;
  AppendLog('--- state just before the files are replaced ---');
  LogCmd('sc query {#MyServiceName} | findstr /i STATE');
  LogCmd('tasklist /fi "imagename eq {#MyAppExeName}" /fo list | findstr /i "PID"');
  if AgentExeRunning then
    AppendLog('WARNING: the agent process is still running after trying to stop it.')
  else
    AppendLog('Service and watchdog stopped; the agent exe is not running.');
  FreeFileForReplace(ExpandConstant('{app}\{#MyAppExeName}'), AgentExeRunning);
  FreeFileForReplace(ExpandConstant('{app}\nssm.exe'), False);
end;

procedure PrepareUpgrade;
var
  Exe, Nssm: String;
begin
  Exe := ExpandConstant('{app}\{#MyAppExeName}');
  Nssm := ExpandConstant('{app}\nssm.exe');
  SilentUpgrade := WizardSilent and ServiceExists and FileExists(Exe) and FileExists(Nssm);
  if SilentUpgrade then
  begin
    FreeFileForReplace(Exe, True);
    FreeFileForReplace(Nssm, True);
    if FileExists(Exe) or FileExists(Nssm) then
    begin
      AppendLog('In-place upgrade not possible (could not move the running files aside) - falling back to stop-and-replace.');
      SilentUpgrade := False;
    end
    else
      AppendLog('Upgrading in place: the service keeps protecting while the files are replaced.');
  end;
  if not SilentUpgrade then
    StopAgentForInstall;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  DeviceName: String;
  Lines: TArrayOfString;
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    AppendLog('Installing version {#MyAppVersion} into ' + ExpandConstant('{app}'));
    // Upgrade-over-existing-install: the old service still has the agent
    // exe open, which makes copying the new files fail or get postponed
    // until reboot. Stop it BEFORE files are copied. (On a fresh install
    // nssm.exe doesn't exist yet, so this is skipped.)
    InstallStartTick := WinTickCount;
    TraysKilled := False;
    if TrayHoldsFiles then
    begin
      StopTrayProcesses;
      TraysKilled := True;
    end
    else
      AppendLog('The tray icon holds no install files - leaving it running (it restarts itself on the new version).');
    PrepareUpgrade;
  end;
  if CurStep = ssPostInstall then
  begin
    // Written to a plain text file the agent reads at first registration
    // (see agent/src/identity.js). Uses SaveStringsToUTF8File - the real
    // Inno Setup function for writing proper UTF-8 text. An earlier
    // version of this script mistakenly passed a 3rd boolean argument to
    // SaveStringToFile expecting it to mean "write as Unicode" - that
    // parameter doesn't exist on that function at all (it only takes
    // FileName, S, Append), so the boolean was silently treated as the
    // Append flag instead, and the string got written as raw ANSI bytes
    // in the system codepage - producing garbled text for any name with
    // Hebrew characters.
    DeviceName := Trim(DeviceNamePage.Values[0]);
    if DeviceName = '' then
      DeviceName := GetComputerNameString();
    SetArrayLength(Lines, 1);
    Lines[0] := DeviceName;
    if not FileExists(ExpandConstant('{app}\device-name.txt')) then
      SaveStringsToUTF8File(ExpandConstant('{app}\device-name.txt'), Lines, False);
    // Watchdog: every minute, start the service again if it is not running.
    if not Exec(ExpandConstant('{sys}\schtasks.exe'),
      '/create /tn ContentBlockerWatchdog /sc minute /mo 1 /ru SYSTEM /rl HIGHEST /f /tr "\"' + ExpandConstant('{app}\watchdog.bat') + '\""',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      AppendLog('WARNING: could not create the watchdog task (exit ' + IntToStr(ResultCode) + ').')
    else
      AppendLog('Watchdog task created.');
    AppendLog('Files copied, registering and starting the service next.');
  end;
  if CurStep = ssDone then
  begin
    // Verify the service really is up - Inno doesn't surface [Run] failures.
    Exec(ExpandConstant('{sys}\cmd.exe'),
      '/c sc query {#MyServiceName} | findstr /i "STATE" >> "C:\Users\Public\Documents\ContentBlockerLogs\agent.log"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    AppendLog('Install finished. (The line above, if present, is the Windows service state.)');
    // How long the install took; the agent reports it to the dashboard's updates report.
    ForceDirectories(ExpandConstant('{commonappdata}\ContentBlockerAgent\update'));
    SaveStringToFile(ExpandConstant('{commonappdata}\ContentBlockerAgent\update\last-install.txt'),
      'version={#MyAppVersion}' + #13#10 + 'seconds=' + IntToStr(InstallSeconds) + #13#10, False);
    AppendLog('Install took ' + IntToStr(InstallSeconds) + ' seconds.');
    if TraysKilled and WizardSilent then RelaunchTray;
  end;
end;

// Runs before the [UninstallRun] steps: no watchdog loop may restart the service while
// files are being unlocked and removed.
function InitializeUninstall: Boolean;
begin
  StopWatchdogLoops;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    AppendLog('Uninstall started: service will be stopped, files unlocked, service removed.');
    StopTrayProcesses;
  end;
  if CurUninstallStep = usPostUninstall then
    AppendLog('Uninstall finished. Logs folder intentionally kept.');
end;

[Run]
; Ask Defender to exclude this app's folder and this exe BEFORE any of the
; "suspicious-looking" setup actions below run (service registration, Safe
; Mode keys, SRP). Behavior-based detections like Behavior:Win32/Execution.A!ml
; are triggered by watching what a process does, so excluding it earlier in
; the sequence - rather than only after install, as before - gives Defender
; a chance to not flag this run at all instead of only protecting future
; runs. This does not fix detections of the Setup .exe itself while it's
; still sitting in Downloads before being run (only code signing fixes that,
; see PROJECT_STATUS.md), and it is best-effort: ignored if Tamper Protection
; or a managed policy blocks it.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""Add-MpPreference -ExclusionPath '{app}'; Add-MpPreference -ExclusionPath '{commonappdata}\ContentBlockerAgent'; Add-MpPreference -ExclusionProcess '{app}\{#MyAppExeName}'"""; Flags: runhidden waituntilterminated; Check: DefenderFg
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""Add-MpPreference -ExclusionPath '{app}'; Add-MpPreference -ExclusionPath '{commonappdata}\ContentBlockerAgent'; Add-MpPreference -ExclusionProcess '{app}\{#MyAppExeName}'"""; Flags: runhidden nowait; Check: DefenderBg

; Registers the packaged exe as a Windows service via NSSM. First removes
; any pre-existing service with the same name (ignoring errors if none
; exists) - installing on top of a leftover registration from a previous
; install/uninstall cycle silently fails, and Inno Setup doesn't surface
; that failure by default, leaving the service simply not running with no
; visible error. Then installs fresh and configures it.
Filename: "{app}\nssm.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Preparing service..."; Check: IsNotSilentUpgrade
Filename: "{app}\nssm.exe"; Parameters: "remove {#MyServiceName} confirm"; Flags: runhidden waituntilterminated; StatusMsg: "Preparing service..."; Check: IsNotSilentUpgrade
Filename: "{app}\nssm.exe"; Parameters: "install {#MyServiceName} ""{app}\{#MyAppExeName}"""; Flags: runhidden waituntilterminated; StatusMsg: "Installing service..."; Check: IsNotSilentUpgrade
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppDirectory ""{app}"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppExit Default Restart"; Flags: runhidden waituntilterminated
; Override for exit code 0 specifically: the dashboard's remote "uninstall"
; command makes the running agent process call process.exit(0) on itself
; (see agent/src/index.js, case 'uninstall') BEFORE uninstall-helper.bat
; gets a chance to run "nssm stop". Without this override, NSSM sees that
; self-exit as an unexpected crash (it never issued the stop itself) and
; applies the Default=Restart policy above - respawning the agent within
; milliseconds, long before the helper's ~3s wait is up. That respawned
; instance re-registers with the server using the same hardware-derived
; ID (see identity.js) and can re-lock files, making the dashboard
; "uninstall" look like it silently failed or half-reverted itself. This
; line tells NSSM that exit code 0 specifically means "the app finished on
; purpose, don't restart it" - while every OTHER exit code (crashes,
; uncaught exceptions -> process.exit(1) in index.js) still falls through
; to "Default Restart" above, so real crash-recovery is unaffected.
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppExit 0 Exit"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppNoConsole 1"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppStdout ""C:\Users\Public\Documents\ContentBlockerLogs\service-stdout.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppStderr ""C:\Users\Public\Documents\ContentBlockerLogs\service-stderr.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppRotateFiles 1"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppRotateBytes 1048576"; Flags: runhidden waituntilterminated
; Installation is not finished until every video file has been locked AND
; verified: the agent exe runs in --lock-files mode and Setup waits for it
; (progress/result is in the log: C:\Users\Public\Documents\ContentBlockerLogs\agent.log).
; Live progress window (logo, % bar, counters, stage list, rotating tips) so the
; long locking step isn't a blank wait. It reads install-progress.txt written by
; the agent and closes itself when the agent finishes.
Filename: "{sys}\wscript.exe"; Parameters: """{app}\ps-hidden.vbs"" install-splash.ps1"; Flags: nowait runhidden skipifsilent
Filename: "{app}\{#MyAppExeName}"; Parameters: "--lock-files"; Flags: runhidden waituntilterminated; StatusMsg: "Locking all video files - this can take a few minutes, please wait..."; Check: IsNotSilentUpgrade
Filename: "{app}\nssm.exe"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Starting service..."; Check: StepStart
; Automatic update of an existing install: the service was never stopped, restart it once so it runs the new files.
; (Video locks stay on the files; the agent re-checks all of them right after it starts.)
Filename: "{app}\nssm.exe"; Parameters: "restart {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Restarting service..."; Check: StepRestart
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\srp-policy.ps1"" -Apply -BlockOtherDrives"; Flags: runhidden waituntilterminated; Tasks: srp; Check: SrpFg; StatusMsg: "Applying program restrictions..."
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\srp-policy.ps1"" -Apply -BlockOtherDrives"; Flags: runhidden nowait; Tasks: srp; Check: SrpBg; StatusMsg: "Applying program restrictions..."
; Start the tray icon now (runasoriginaluser = the logged-in user's session, not elevated).
Filename: "{sys}\wscript.exe"; Parameters: """{app}\ps-hidden.vbs"" tray.ps1"; Flags: nowait runhidden runasoriginaluser skipifsilent

[UninstallRun]
; Order matters here: stop the service FIRST, so its periodic file-lock
; scan can't re-lock a file in the instant between --unlock-files removing
; the deny ACE and the service being removed. Then restore file access,
; then remove the service registration entirely.
Filename: "{sys}\schtasks.exe"; Parameters: "/delete /tn ContentBlockerWatchdog /f"; Flags: runhidden waituntilterminated; StatusMsg: "Removing watchdog..."
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\srp-policy.ps1"" -Remove"; Flags: runhidden waituntilterminated; StatusMsg: "Removing program restrictions..."
Filename: "{app}\nssm.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Stopping service..."
Filename: "{app}\{#MyAppExeName}"; Parameters: "--unlock-files"; Flags: runhidden waituntilterminated; StatusMsg: "Restoring file access..."
Filename: "{app}\nssm.exe"; Parameters: "remove {#MyServiceName} confirm"; Flags: runhidden waituntilterminated; StatusMsg: "Removing service..."
