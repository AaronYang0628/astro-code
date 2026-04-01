#!/usr/bin/env bash
set -euo pipefail

echo "Installing Node dependencies..."
npm install

echo "Installing Python dependencies..."
python3 -m pip install -r py/requirements.txt

echo "Bootstrap complete."
