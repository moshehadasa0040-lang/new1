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
  #define MyAppVersion "1.13.6"
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

procedure CurStepChanged(CurStep: TSetupStep);
var
  DeviceName: String;
  Lines: TArrayOfString;
  ResultCode: Integer;
  OldNssm: String;
begin
  if CurStep = ssInstall then
  begin
    AppendLog('Installing version {#MyAppVersion} into ' + ExpandConstant('{app}'));
    // Upgrade-over-existing-install: the old service still has the agent
    // exe open, which makes copying the new files fail or get postponed
    // until reboot. Stop it BEFORE files are copied. (On a fresh install
    // nssm.exe doesn't exist yet, so this is skipped.)
    Exec(ExpandConstant('{sys}\schtasks.exe'), '/delete /tn ContentBlockerWatchdog /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    OldNssm := ExpandConstant('{app}\nssm.exe');
    if FileExists(OldNssm) then
      Exec(OldNssm, 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
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
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    AppendLog('Uninstall started: service will be stopped, files unlocked, service removed.');
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
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""Add-MpPreference -ExclusionPath '{app}'; Add-MpPreference -ExclusionPath '{commonappdata}\ContentBlockerAgent'; Add-MpPreference -ExclusionProcess '{app}\{#MyAppExeName}'"""; Flags: runhidden waituntilterminated

; Registers the packaged exe as a Windows service via NSSM. First removes
; any pre-existing service with the same name (ignoring errors if none
; exists) - installing on top of a leftover registration from a previous
; install/uninstall cycle silently fails, and Inno Setup doesn't surface
; that failure by default, leaving the service simply not running with no
; visible error. Then installs fresh and configures it.
Filename: "{app}\nssm.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Preparing service..."
Filename: "{app}\nssm.exe"; Parameters: "remove {#MyServiceName} confirm"; Flags: runhidden waituntilterminated; StatusMsg: "Preparing service..."
Filename: "{app}\nssm.exe"; Parameters: "install {#MyServiceName} ""{app}\{#MyAppExeName}"""; Flags: runhidden waituntilterminated; StatusMsg: "Installing service..."
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
Filename: "{app}\{#MyAppExeName}"; Parameters: "--lock-files"; Flags: runhidden waituntilterminated; StatusMsg: "Locking all video files - this can take a few minutes, please wait..."
Filename: "{app}\nssm.exe"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Starting service..."
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\srp-policy.ps1"" -Apply -BlockOtherDrives"; Flags: runhidden waituntilterminated; Tasks: srp; StatusMsg: "Applying program restrictions..."
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
