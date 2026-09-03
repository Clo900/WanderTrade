@echo off
REM ============================================
REM Aierxiya Trade - Internal Test Launcher
REM Double-click this file to start the server
REM Requires: Node.js 18+ (https://nodejs.org)
REM
REM Default: bind 127.0.0.1 (IPv4 loopback).
REM   -> works for local play AND Oray PeanutShell tunnel
REM      (PeanutShell mapping: host 127.0.0.1, port 8080, HTTP)
REM LAN direct play (other PCs on same LAN): use instead:
REM   node "%~dp0server\index.mjs" -Lan -Port 8080
REM ============================================
cd /d "%~dp0"
echo.
echo Starting Aierxiya Trade server (Node) on port 8080...
echo Open http://127.0.0.1:8080/ in your browser
echo Press Ctrl+C to stop the server
echo.
node "%~dp0server\index.mjs" -Port 8080 -Bind 127.0.0.1
pause
