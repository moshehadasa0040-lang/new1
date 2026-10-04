' Starts a PowerShell script with NO console window at all (powershell.exe
' -WindowStyle Hidden still flashes a console for a moment; wscript + window
' style 0 does not). Usage: wscript.exe ps-hidden.vbs <script.ps1>
' The script is looked up next to this .vbs file.
Option Explicit
Dim sh, dir, script, cmd
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 1
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
script = dir & WScript.Arguments(0)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & script & """"
sh.Run cmd, 0, False
