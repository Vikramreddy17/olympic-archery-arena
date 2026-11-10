@echo off
echo ==============================================================================
echo Olympic Archery Arena - Environment Setup
echo ==============================================================================
echo.

cd /d "%~dp0\.."

if not exist .venv (
    echo [*] Creating Python virtual environment in .venv...
    python -m venv .venv
    if errorlevel 1 (
        echo [!] Error creating virtual environment. Please ensure Python 3.10+ is installed and on your PATH.
        pause
        exit /b 1
    )
) else (
    echo [*] Existing virtual environment found in .venv.
)

echo [*] Upgrading pip and installing dependencies...
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

echo.
echo [OK] Setup completed successfully!
echo To run the game:
echo   call scripts\run_arena.bat
echo.
pause
