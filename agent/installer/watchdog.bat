@echo off
REM Run every minute by the scheduled task "ContentBlockerWatchdog" (as SYSTEM).
REM Only ever touches ContentBlockerAgent itself - never any other service.
setlocal
set LOG=C:\Users\Public\Documents\ContentBlockerLogs\agent.log

sc query ContentBlockerAgent | find "RUNNING" >nul
if not errorlevel 1 goto :eof

REM Not running. It's either fully stopped (start it) or PAUSED - a Windows
REM service can be paused by *another* program on the machine (via the
REM service control manager) without that other program needing admin
REM rights beyond what it already has; nssm then suspends our process, so it
REM cannot notice or log this about itself. Only an outside watcher like this
REM one, which keeps running independently, can see and recover from it.
sc query ContentBlockerAgent | find "PAUSED" >nul
if not errorlevel 1 (
  >>"%LOG%" echo [watchdog] Service was PAUSED by something else on this machine - resuming it. ContentBlockerAgent never pauses or stops itself.
  tasklist /fi "imagename eq WiFree*" /fo csv /nh >>"%LOG%" 2>nul
  tasklist /fi "imagename eq NetFree*" /fo csv /nh >>"%LOG%" 2>nul
  sc continue ContentBlockerAgent >nul 2>&1
) else (
  >>"%LOG%" echo [watchdog] Service was not running - starting it.
  sc start ContentBlockerAgent >nul 2>&1
)
exit /b 0
