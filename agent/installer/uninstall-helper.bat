@echo off
REM Runs detached from the agent process (normally via a one-shot scheduled
REM task running as SYSTEM, see agent/src/uninstall.js), after the agent has
REM already exited (or is about to). Waits briefly to be safe, then uses NSSM
REM to stop and remove the Windows service so blocking stops. %~dp0 resolves
REM to this script's own folder, which is the install directory - so
REM nssm.exe next to it is always found regardless of where the app was
REM installed.
REM
REM NOTE: uses "ping" instead of "timeout" to wait - "timeout" needs a real
REM console to read from and fails immediately when launched without one.

ping 127.0.0.1 -n 4 >nul

REM Make sure NSSM can never restart the service while we tear it down.
"%~dp0nssm.exe" set ContentBlockerAgent AppExit Default Exit >nul 2>&1
"%~dp0nssm.exe" stop ContentBlockerAgent >nul 2>&1
"%~dp0nssm.exe" remove ContentBlockerAgent confirm >nul 2>&1

REM Remove the one-shot task that launched this script (no-op if it was
REM started the fallback way).
schtasks /delete /tn ContentBlockerAgentUninstall /f >nul 2>&1

exit
