@echo off
pwsh -NoProfile -File "%~dp0Start-Demo.ps1"
if errorlevel 1 pause
