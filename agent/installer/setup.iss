; Content Blocker Agent - Inno Setup script
; Builds a single installer .exe that:
;   1) copies the packaged agent executable
;   2) registers + starts it as a Windows service
;   3) registers a proper uninstaller in "Add or remove programs"
;
; This file is compiled automatically by the GitHub Action
; (.github/workflows/build-installer.yml) using ISCC.exe.
; The action expects the pkg-built exe at agent\dist\content-blocker-agent.exe

#define MyAppName "Content Blocker Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "YourNameHere"
#define MyAppExeName "content-blocker-agent.exe"

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

[Run]
; Installs and starts the Windows service silently after files are copied.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--install-service"; Flags: runhidden waituntilterminated

[UninstallRun]
; Cleanly stops and removes the service before the uninstaller deletes files.
Filename: "{app}\{#MyAppExeName}"; Parameters: "--uninstall-service"; Flags: runhidden waituntilterminated
