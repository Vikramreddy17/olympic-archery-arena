@echo off
echo ==============================================================================
echo Starting LD19 LiDAR Tracking & Calibration Interface...
echo ==============================================================================
echo.

cd /d "%~dp0\.."

if exist .venv\Scripts\activate.bat (
    call .venv\Scripts\activate.bat
)

python lidar_ld19.py
pause
