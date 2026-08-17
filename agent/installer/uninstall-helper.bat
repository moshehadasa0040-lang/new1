@echo off
REM Runs detached from the agent process, after it has already exited (or is
REM about to). Waits briefly to be safe, then uses NSSM to stop and remove
REM the Windows service so blocking stops. %~dp0 resolves to this script's
REM own folder, which is the install directory - so nssm.exe next to it is
REM always found regardless of where the app was installed.

timeout /t 3 /nobreak >nul

"%~dp0nssm.exe" stop ContentBlockerAgent
"%~dp0nssm.exe" remove ContentBlockerAgent confirm

exit
