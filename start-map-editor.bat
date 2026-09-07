@echo off
cd /d "%~dp0"
start "" "http://127.0.0.1:8790/"
node scripts\map\editor-server.mjs
