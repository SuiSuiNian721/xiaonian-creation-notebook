@echo off
pwsh -NoProfile -File "%~dp0Start-Aurora.ps1"
if errorlevel 1 pause
