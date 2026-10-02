@echo off
rem Short name of the Git Sweep Pro CLI: runs the git-sweep-pro launcher next to this file.
call "%~dp0git-sweep-pro.cmd" %*
exit /b %errorlevel%
