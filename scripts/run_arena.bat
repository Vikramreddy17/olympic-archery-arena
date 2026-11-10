@echo off
echo ==============================================================================
echo Starting Olympic Archery Arena Web Server...
echo ==============================================================================
echo.

cd /d "%~dp0\.."

if exist .venv\Scripts\activate.bat (
    call .venv\Scripts\activate.bat
)

python app.py
pause
