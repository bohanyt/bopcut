@echo off
bun --no-env-file "%~dp0start-local.mjs" %*
exit /b %errorlevel%
