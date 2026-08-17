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

[Run]
; Registers the packaged exe as a Windows service via NSSM, points it at
; the install folder (so it can find its local data files), sets it to
; start automatically on boot, and starts it immediately.
Filename: "{app}\nssm.exe"; Parameters: "install {#MyServiceName} ""{app}\{#MyAppExeName}"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppDirectory ""{app}"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#MyServiceName} AppExit Default Restart"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated

[UninstallRun]
; Cleanly stops and removes the service before the uninstaller deletes files.
Filename: "{app}\nssm.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "remove {#MyServiceName} confirm"; Flags: runhidden waituntilterminated
