@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PYCMD="
py -3 --version >nul 2>nul && set "PYCMD=py -3"
if not defined PYCMD python --version >nul 2>nul && set "PYCMD=python"
if not defined PYCMD for /d %%D in ("%LocalAppData%\Programs\Python\Python3*" "C:\Python3*" "%ProgramFiles%\Python3*") do if exist "%%~D\python.exe" set PYCMD="%%~D\python.exe"
if not defined PYCMD goto :nopython
echo Python: %PYCMD%
%PYCMD% app.py
goto :done
:nopython
echo.
echo [!] Python not found. / Python을 찾지 못했습니다.
echo     1) Open Command Prompt and type:  py --version   and   python --version
echo     2) If both fail, run the Python installer again, choose Modify or Repair,
echo        and check "Add python.exe to PATH" / "py launcher".
:done
echo.
pause
