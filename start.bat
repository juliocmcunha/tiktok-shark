@echo off
chcp 65001 >nul
title TikTok -> Roblox Bridge
cd /d "%~dp0"

echo ============================================
echo   TikTok -^> Roblox Bridge
echo ============================================
echo.

if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
  echo.
)

echo Building TypeScript...
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. See the messages above.
  pause
  exit /b 1
)

echo.
echo Starting server. Close this window to stop.
echo (the "tiktok^>" command console works here normally)
echo.
node dist\server.js

echo.
echo The server stopped.
pause
