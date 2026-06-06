#!/bin/sh
# Start the Python TTS service in the background, then Node in foreground.
python3 /app/tts-service/tts_server.py --port 8020 &
exec node /app/server/dist/index.js
