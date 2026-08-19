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
#define MyAppVersion "1.0.0"
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
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\content-blocker-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "nssm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-helper.bat"; DestDir: "{app}"; Flags: ignoreversion

[Code]
var
  DeviceNamePage: TInputQueryWizardPage;

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
begin
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
    SaveStringsToUTF8File(ExpandConstant('{app}\device-name.txt'), Lines, False);
  end;
end;

[Run]
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
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppNoConsole 1"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Starting service..."

[UninstallRun]
; Order matters here: stop the service FIRST, so its periodic file-lock
; scan can't re-lock a file in the instant between --unlock-files removing
; the deny ACE and the service being removed. Then restore file access,
; then remove the service registration entirely.
Filename: "{app}\nssm.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Stopping service..."
Filename: "{app}\{#MyAppExeName}"; Parameters: "--unlock-files"; Flags: runhidden waituntilterminated; StatusMsg: "Restoring file access..."
Filename: "{app}\nssm.exe"; Parameters: "remove {#MyServiceName} confirm"; Flags: runhidden waituntilterminated; StatusMsg: "Removing service..."
