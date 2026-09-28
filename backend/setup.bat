@echo off
rem One-command backend setup for HK CoolPath AI (Windows).
rem Creates a FRESH venv (virtualenvs are NOT portable - never copy .venv
rem between machines), installs dependencies and regenerates mock data.

cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher not found. Install Python 3.9+ from python.org
  echo and enable "Add python.exe to PATH" during installation.
  exit /b 1
)

py --version

echo ==^> Creating fresh virtualenv at backend\.venv
if exist .venv rmdir /s /q .venv
py -m venv .venv

echo ==^> Installing dependencies
.venv\Scripts\python -m pip install --quiet --upgrade pip
.venv\Scripts\pip install --quiet -e ".[dev]"

echo ==^> Generating mock datasets
.venv\Scripts\python -m app.data.generate_static_data

echo ==^> Running test suite
.venv\Scripts\python -m pytest -q

echo.
echo All set. Start the API with:
echo   .venv\Scripts\uvicorn app.main:app --port 8000
echo Interactive docs: http://localhost:8000/docs
