#!/usr/bin/env bash
# One-command backend setup for HK CoolPath AI.
#
# Creates a FRESH venv (virtualenvs are NOT portable — never copy .venv
# between machines or via AirDrop/zip), installs dependencies and
# regenerates the deterministic mock datasets.
#
# Usage:  ./setup.sh        (macOS / Linux)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found."
  echo "  macOS:  run  xcode-select --install  (or install from python.org)"
  echo "  Windows: use setup.bat instead"
  exit 1
fi

PYV=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
echo "==> python3 found (version $PYV)"

echo "==> Creating fresh virtualenv at backend/.venv"
rm -rf .venv
python3 -m venv .venv

echo "==> Installing dependencies"
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -e ".[dev]"

echo "==> Generating mock datasets (deterministic)"
./.venv/bin/python -m app.data.generate_static_data

echo "==> Running test suite"
./.venv/bin/python -m pytest -q

echo ""
echo "All set. Start the API with:"
echo "  ./.venv/bin/uvicorn app.main:app --port 8000"
echo "Interactive docs: http://localhost:8000/docs"
