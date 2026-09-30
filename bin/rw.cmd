@echo off
rem Riverwright short alias for Windows: runs riverwright.cmd with the same arguments.
call "%~dp0riverwright.cmd" %*
exit /b %ERRORLEVEL%
