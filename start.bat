@echo off
setlocal

cd /d "%~dp0"

echo WebChat AI Backend
echo.

if exist "node_modules" goto skip_install
echo Installing dependencies, first run only, this may take a minute...
call npm install
if errorlevel 1 goto npm_failed

:skip_install

if exist ".env" goto check_env

copy .env.example .env >nul
echo.
echo Created .env from .env.example - you must edit it before this works.
echo.
echo Step 1: Open the .env file in Notepad
echo Step 2: Set GROQ_API_KEY to your real key from console.groq.com
echo Step 3: Set ADMIN_SECRET to any random text you choose
echo Step 4: Save the file and close Notepad
echo Step 5: Run start.bat again
echo.
pause
exit /b 0

:check_env

findstr /C:"gsk_your_real_key_here" .env >nul
if errorlevel 1 goto start_server

echo.
echo WARNING: GROQ_API_KEY in .env still looks like the placeholder.
echo Chat replies will fail until you set a real key.
echo The server will still start anyway.
echo.

:start_server

echo Starting server...
echo.
node server.js

echo.
echo Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:npm_failed
echo.
echo npm install failed. Scroll up to see the error above.
echo Make sure Node.js is installed: type "node -v" to check.
echo.
pause
exit /b 1
