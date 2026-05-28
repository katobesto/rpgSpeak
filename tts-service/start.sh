#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
  echo "▶  Creating Python virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate

echo "▶  Installing dependencies..."
pip install -q -r requirements.txt

echo "▶  Starting rpgSpeak TTS Service (Piper)..."
python tts_server.py --data-dir "../data" "$@"
