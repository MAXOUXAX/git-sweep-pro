@echo off
rem Launcher for the Git Sweep Pro CLI, put on the integrated terminal PATH by the
rem VS Code extension. GIT_SWEEP_PRO_NODE points at VS Code's own runtime, so
rem Node.js does not need to be installed; outside VS Code, "node" is used.
setlocal
set ELECTRON_RUN_AS_NODE=1
if defined GIT_SWEEP_PRO_NODE (
  "%GIT_SWEEP_PRO_NODE%" "%~dp0..\dist\cli\main.js" %*
) else (
  node "%~dp0..\dist\cli\main.js" %*
)
