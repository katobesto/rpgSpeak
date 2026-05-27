#!/usr/bin/env bash
# ─── rpgSpeak dev launcher ────────────────────────────────────────────────────
# Arranca server + client + TTS como un solo bloque.
# Al salir (Ctrl+C, SIGTERM, o muerte de cualquier hijo) se para todo.
# Uso: ./dev.sh [stop]

SERVER_PORT=3000
CLIENT_PORT=5173
TTS_PORT=8020

# ── PIDs de los hijos (se rellenan al arrancar cada servicio) ─────────────────
_PIDS=()
_CLEANED=0

# ── Función de limpieza — se ejecuta en CUALQUIER salida ─────────────────────
cleanup() {
  [ $_CLEANED -eq 1 ] && return
  _CLEANED=1

  echo ""
  echo "🛑  Deteniendo todos los servicios..."

  # 1. Enviar SIGTERM a los hijos registrados
  for pid in "${_PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done

  # 2. Dar 3 s para que terminen limpiamente
  local deadline=$(( $(date +%s) + 3 ))
  for pid in "${_PIDS[@]}"; do
    local remaining=$(( deadline - $(date +%s) ))
    [ $remaining -gt 0 ] && wait "$pid" 2>/dev/null &
  done
  sleep 1

  # 3. Matar a la fuerza lo que quede en esos puertos (safety net)
  local stale
  stale=$(lsof -ti :$SERVER_PORT -ti :$CLIENT_PORT -ti :$TTS_PORT 2>/dev/null | sort -u)
  if [ -n "$stale" ]; then
    echo "$stale" | xargs kill -9 2>/dev/null
  fi

  echo "✅  Todo detenido."
}

# Registrar cleanup para cualquier forma de salida
trap 'cleanup; exit 0' INT TERM
trap 'cleanup'          EXIT

# ── Subcomando "stop" — solo mata puertos y sale ──────────────────────────────
if [ "${1}" = "stop" ]; then
  stale=$(lsof -ti :$SERVER_PORT -ti :$CLIENT_PORT -ti :$TTS_PORT 2>/dev/null | sort -u)
  if [ -n "$stale" ]; then
    echo "⛔  Cerrando procesos en puertos $SERVER_PORT, $CLIENT_PORT y $TTS_PORT..."
    echo "$stale" | xargs kill -9 2>/dev/null
    sleep 1
  else
    echo "✅  Puertos libres, nada que detener."
  fi
  exit 0
fi

# ── Matar restos de ejecuciones anteriores ────────────────────────────────────
stale=$(lsof -ti :$SERVER_PORT -ti :$CLIENT_PORT -ti :$TTS_PORT 2>/dev/null | sort -u)
if [ -n "$stale" ]; then
  echo "⛔  Liberando puertos de sesión anterior..."
  echo "$stale" | xargs kill -9 2>/dev/null
  sleep 1
fi

cd "$(dirname "$0")"

# ── Verificar binarios nativos (detecta binarios de Windows/Linux y los recompila) ─
NATIVE_BIN="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -d "node_modules" ]; then
  echo "❌  node_modules no encontrado. Ejecuta ./install.sh primero."
  exit 1
fi
NEEDS_REBUILD=0
if [ -f "$NATIVE_BIN" ]; then
  BIN_INFO=$(file "$NATIVE_BIN" 2>/dev/null || echo "unknown")
  if ! echo "$BIN_INFO" | grep -q "Mach-O"; then
    echo "⚠️   Binario de otra plataforma detectado (Windows/Linux). Recompilando para Mac..."
    NEEDS_REBUILD=1
  fi
else
  echo "⚠️   Binario nativo no encontrado. Compilando..."
  NEEDS_REBUILD=1
fi
if [ $NEEDS_REBUILD -eq 1 ]; then
  # npm rebuild fuerza recompilacion del modulo nativo para la plataforma actual.
  # Requiere Python 3 y Xcode Command Line Tools (xcode-select --install).
  npm rebuild better-sqlite3
  if [ $? -ne 0 ]; then
    echo "❌  Recompilacion fallida."
    echo "    Asegurate de tener Xcode CLI Tools: xcode-select --install"
    exit 1
  fi
  echo "✅  Binario Mac compilado correctamente."
  echo ""
fi

echo ""
echo "🚀  Arrancando rpgSpeak..."
echo "    Server → http://localhost:$SERVER_PORT"
echo "    Client → http://localhost:$CLIENT_PORT"
echo "    TTS    → http://localhost:$TTS_PORT"
echo ""
echo "    Ctrl+C para detener todo."
echo ""

# ── TTS service ───────────────────────────────────────────────────────────────
if [ -f "tts-service/tts_server.py" ]; then
  TTS_VENV="tts-service/venv"

  if [ ! -d "$TTS_VENV" ]; then
    echo "📦  Instalando dependencias TTS (primera vez, puede tardar)..."
    python3 -m venv "$TTS_VENV"
    "$TTS_VENV/bin/pip" install -q -r tts-service/requirements.txt
  fi

  echo "🔊  Arrancando servicio TTS..."
  "$TTS_VENV/bin/python" tts-service/tts_server.py \
    --port $TTS_PORT \
    --data-dir data \
    >> tts-service/tts.log 2>&1 &
  TTS_PID=$!
  _PIDS+=($TTS_PID)
  echo "    TTS PID: $TTS_PID"
else
  TTS_PID=""
  echo "ℹ️   tts-service/ no encontrado — TTS desactivado."
fi

# ── Node server ───────────────────────────────────────────────────────────────
npx tsx server/src/index.ts &
SERVER_PID=$!
_PIDS+=($SERVER_PID)
echo "    Server PID: $SERVER_PID"

# Pequeña pausa para que el server inicialice la BD antes de que el cliente empiece
sleep 2

# ── Vite client ───────────────────────────────────────────────────────────────
(cd client && npx vite --port $CLIENT_PORT) &
CLIENT_PID=$!
_PIDS+=($CLIENT_PID)
echo "    Client PID: $CLIENT_PID"
echo ""

# ── Esperar a que CUALQUIER hijo muera, luego parar todo ─────────────────────
# "wait -n" sale en cuanto el primer hijo termina (bash 4.3+)
wait_any() {
  while true; do
    for pid in "${_PIDS[@]}"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        echo ""
        echo "⚠️   Proceso $pid ha terminado — deteniendo el resto..."
        return
      fi
    done
    sleep 2
  done
}

wait_any
# El EXIT trap llamará a cleanup automáticamente al salir
