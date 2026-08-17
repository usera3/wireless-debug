@echo off
setlocal

set "PORT=%~1"
if not defined PORT set "PORT=COM4"
set "IDF_PYTHON=%USERPROFILE%\.espressif\python_env\idf6.0_py3.11_env\Scripts\python.exe"

echo Target: ESP32-S3, 8 MB flash
echo Port:   %PORT%
echo Image:  %~dp0full_flash_0x0.bin
echo.

if exist "%IDF_PYTHON%" (
  "%IDF_PYTHON%" -m esptool --chip esp32s3 -p "%PORT%" -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x0 "%~dp0full_flash_0x0.bin"
) else (
  python -m esptool --chip esp32s3 -p "%PORT%" -b 460800 --before default-reset --after hard-reset write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB 0x0 "%~dp0full_flash_0x0.bin"
)

if errorlevel 1 (
  echo.
  echo Flash failed. Check the COM port, download mode, Python, and esptool installation.
  pause
  exit /b 1
)

echo.
echo Flash complete. Remove the download-mode jumper if fitted, then reset the board.
pause

