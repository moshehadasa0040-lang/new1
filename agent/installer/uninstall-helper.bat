@echo off
REM Runs detached from the agent process, after it has already exited (or is
REM about to). Waits briefly to be safe, then uses NSSM to stop and remove
REM the Windows service so blocking stops. %~dp0 resolves to this script's
REM own folder, which is the install directory - so nssm.exe next to it is
REM always found regardless of where the app was installed.
REM
REM NOTE: uses "ping" instead of "timeout" to wait - "timeout" needs a real
REM console to read from and fails immediately ("Input redirection is not
REM supported") when launched detached/without a console, which is exactly
REM how this script is spawned. That silent failure was why "uninstall"
REM previously did nothing: the script exited before ever reaching the
REM nssm stop/remove lines below.

ping 127.0.0.1 -n 4 >nul

"%~dp0nssm.exe" stop ContentBlockerAgent
"%~dp0nssm.exe" remove ContentBlockerAgent confirm

exit
