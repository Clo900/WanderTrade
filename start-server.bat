@echo off
REM ============================================
REM Aierxiya Trade - Internal Test Launcher
REM Double-click this file to start the server
REM Requires: Node.js 18+ (https://nodejs.org)
REM ============================================
cd /d "%~dp0"
echo.
echo Starting Aierxiya Trade server (Node) on port 8080...
echo Open http://localhost:8080/ in your browser
echo Press Ctrl+C to stop the server
echo.
node "%~dp0server\index.mjs" -Port 8080
pause
