#!/usr/bin/env bash
# ─── rpgSpeak dev launcher ────────────────────────────────────────────────────
# Arranca server + client como un solo bloque.
# Al salir (Ctrl+C, SIGTERM, o muerte de cualquier hijo) se para todo.
# Uso: ./dev.sh [stop]

SERVER_PORT=3000
CLIENT_PORT=5173

# ── PIDs de los hijos (se rellenan al arrancar cada servicio) ─────────────────
_PIDS=()
_CLEANED=0

# ── Función de limpieza — se ejecuta en CUALQUIER salida ─────────────────────
cleanup() {
  [ $_CLEANED -eq 1 ] && return
  _CLEANED=1

  echo ""
  echo "🛑  Deteniendo todos los servicios..."

  for pid in "${_PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done

  local deadline=$(( $(date +%s) + 3 ))
  for pid in "${_PIDS[@]}"; do
    local remaining=$(( deadline - $(date +%s) ))
    [ $remaining -gt 0 ] && wait "$pid" 2>/dev/null &
  done
  sleep 1

  local stale
  stale=$(lsof -ti :$SERVER_PORT -ti :$CLIENT_PORT 2>/dev/null | sort -u)
  if [ -n "$stale" ]; then
    echo "$stale" | xargs kill -9 2>/dev/null
  fi

  echo "✅  Todo detenido."
}

trap 'cleanup; exit 0' INT TERM
trap 'cleanup'          EXIT

# ── Subcomando "stop" ─────────────────────────────────────────────────────────
if [ "${1}" = "stop" ]; then
  stale=$(lsof -ti :$SERVER_PORT -ti :$CLIENT_PORT 2>/dev/null | sort -u)
  if [ -n "$stale" ]; then
    echo "⛔  Cerrando procesos en puertos $SERVER_PORT y $CLIENT_PORT..."
    echo "$stale" | xargs kill -9 2>/dev/null
    sleep 1
  else
    echo "✅  Puertos libres, nada que detener."
  fi
  exit 0
fi

# ── Matar restos de ejecuciones anteriores ────────────────────────────────────
stale=$(lsof -ti :$SERVER_PORT -ti :$CLIENT_PORT 2>/dev/null | sort -u)
if [ -n "$stale" ]; then
  echo "⛔  Liberando puertos de sesión anterior..."
  echo "$stale" | xargs kill -9 2>/dev/null
  sleep 1
fi

cd "$(dirname "$0")"

# ── Verificar binarios nativos ────────────────────────────────────────────────
NATIVE_BIN="node_modules/better-sqlite3/build/Release/better_sqlite3.node"
ARCH="$(uname -m)"

if [ ! -d "node_modules" ]; then
  echo "❌  node_modules no encontrado. Ejecuta ./install.sh primero."
  exit 1
fi

NEEDS_REBUILD=0
if [ -f "$NATIVE_BIN" ]; then
  BIN_INFO=$(file "$NATIVE_BIN" 2>/dev/null || echo "unknown")

  if ! echo "$BIN_INFO" | grep -q "Mach-O"; then
    echo "⚠️   Binario de otra plataforma detectado (Windows/Linux). Recompilando para Mac ${ARCH}..."
    NEEDS_REBUILD=1
  elif [ "$ARCH" = "arm64" ] && ! echo "$BIN_INFO" | grep -q "arm64"; then
    echo "⚠️   Binario x86_64 en Mac Apple Silicon (${ARCH}). Recompilando..."
    NEEDS_REBUILD=1
  elif [ "$ARCH" = "x86_64" ] && echo "$BIN_INFO" | grep -q "arm64" && ! echo "$BIN_INFO" | grep -q "x86_64"; then
    echo "⚠️   Binario arm64 en Mac Intel. Recompilando..."
    NEEDS_REBUILD=1
  elif ! node -e "require('better-sqlite3')" 2>/dev/null; then
    echo "⚠️   Módulo nativo incompatible con esta versión de Node $(node -v). Recompilando..."
    NEEDS_REBUILD=1
  fi
else
  echo "⚠️   Binario nativo no encontrado. Compilando para Mac ${ARCH}..."
  NEEDS_REBUILD=1
fi

if [ $NEEDS_REBUILD -eq 1 ]; then
  npm_config_build_from_source=true npm rebuild better-sqlite3
  if [ $? -ne 0 ] || [ ! -f "$NATIVE_BIN" ]; then
    (cd node_modules/better-sqlite3 && node "$(node -e 'process.stdout.write(require.resolve("node-gyp/bin/node-gyp"))')" rebuild --release 2>&1)
  fi
  if [ $? -ne 0 ] || [ ! -f "$NATIVE_BIN" ]; then
    echo "❌  Recompilación fallida o binario no encontrado en build/Release/."
    echo "    Asegúrate de tener Xcode CLI Tools: xcode-select --install"
    exit 1
  fi
  echo "✅  Binario Mac ${ARCH} compilado correctamente."
  echo ""
fi

echo ""
echo "🚀  Arrancando rpgSpeak..."
echo "    Server → http://localhost:$SERVER_PORT"
echo "    Client → http://localhost:$CLIENT_PORT"
echo ""
echo "    Ctrl+C para detener todo."
echo ""

# ── Node server ───────────────────────────────────────────────────────────────
npx tsx server/src/index.ts &
SERVER_PID=$!
_PIDS+=($SERVER_PID)
echo "    Server PID: $SERVER_PID"

sleep 2

# ── Vite client ───────────────────────────────────────────────────────────────
(cd client && npx vite --port $CLIENT_PORT) &
CLIENT_PID=$!
_PIDS+=($CLIENT_PID)
echo "    Client PID: $CLIENT_PID"
echo ""

# ── Esperar a que CUALQUIER hijo muera, luego parar todo ─────────────────────
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
