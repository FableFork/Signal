@echo off
title SIGNAL - Dev Server

echo Starting SIGNAL backend on :8001 ...
start "SIGNAL Backend" cmd /k "cd /d %~dp0backend && python -m uvicorn main:app --host 0.0.0.0 --port 8001 --reload"

timeout /t 2 /nobreak >nul

echo Starting SIGNAL frontend on :5173 ...
start "SIGNAL Frontend" cmd /k "cd /d %~dp0frontend && npm run dev -- --port 5173"

echo.
echo  Backend:   http://localhost:8001
echo  Frontend:  http://localhost:5173
echo.
echo Both servers are running in separate windows.
echo Close those windows to stop them.
pause
