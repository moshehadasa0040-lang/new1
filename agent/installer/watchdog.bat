@echo off
REM Run every minute by the scheduled task "ContentBlockerWatchdog" (as SYSTEM).
REM If the protection service is not running (stopped by hand, crashed), start it again.
sc query ContentBlockerAgent | find "RUNNING" >nul
if errorlevel 1 sc start ContentBlockerAgent >nul 2>&1
exit /b 0
