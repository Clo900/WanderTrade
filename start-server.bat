@echo off
REM ============================================
REM Aierxiya Trade - Internal Test Launcher
REM Double-click this file to start the server
REM ============================================
cd /d "%~dp0"
echo.
echo Starting Aierxiya Trade server on port 8080...
echo Open http://localhost:8080/ in your browser
echo Press Ctrl+C to stop the server
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port 8080
pause
