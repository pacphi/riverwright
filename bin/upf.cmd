@echo off
setlocal
node --version >nul 2>nul
if errorlevel 1 goto nonode
node "%~dp0..\scripts\upf.mjs" %*
exit /b %ERRORLEVEL%
:nonode
>&2 echo upstream-pr-filer needs Node.js 24 or newer: https://nodejs.org
if /i "%~1"=="hook" exit /b 2
if /i "%~1"=="guard" exit /b 2
exit /b 1
