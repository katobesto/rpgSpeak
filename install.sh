#!/usr/bin/env bash
# Uso: ./install.sh
# Para volver a preparar el proyecto tras cambiar de plataforma (Mac <-> Windows),
# simplemente re-ejecuta el instalador de la plataforma destino.
set -euo pipefail

# Siempre ejecutar desde el directorio donde está este script,
# independientemente de desde dónde se llame.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}"
echo "  ██████╗ ██████╗  ██████╗ ███████╗██████╗ ███████╗ █████╗ ██╗  ██╗"
echo "  ██╔══██╗██╔══██╗██╔════╝ ██╔════╝██╔══██╗██╔════╝██╔══██╗██║ ██╔╝"
echo "  ██████╔╝██████╔╝██║  ███╗███████╗██████╔╝█████╗  ███████║█████╔╝ "
echo "  ██╔══██╗██╔═══╝ ██║   ██║╚════██║██╔═══╝ ██╔══╝  ██╔══██║██╔═██╗ "
echo "  ██║  ██║██║     ╚██████╔╝███████║██║     ███████╗██║  ██║██║  ██╗"
echo "  ╚═╝  ╚═╝╚═╝      ╚═════╝ ╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝"
echo -e "${NC}"
echo -e "${BOLD}  Local AI Character Roleplay Platform${NC}"
echo ""

# ─── Detectar arquitectura ────────────────────────────────────────────────────
ARCH="$(uname -m)"   # arm64 en M1/M2/M3/M4/M5, x86_64 en Intel
echo -e "${CYAN}→ Plataforma: macOS $(uname -r) — ${ARCH}${NC}"

# ─── Verificar Xcode Command Line Tools (necesario para compilar módulos nativos) ─
echo -e "${CYAN}→ Verificando Xcode Command Line Tools...${NC}"
if ! xcode-select -p &>/dev/null; then
  echo -e "${YELLOW}⚠ Xcode CLI Tools no encontradas. Instalando...${NC}"
  echo -e "${YELLOW}  (aparecerá un diálogo del sistema — acepta la instalación)${NC}"
  xcode-select --install 2>/dev/null || true
  echo -e "${RED}✗ Vuelve a ejecutar ./install.sh después de que termine la instalación de Xcode CLI Tools.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Xcode CLI Tools: $(xcode-select -p)${NC}"

# ─── Check Node.js version ────────────────────────────────────────────────────
echo -e "${CYAN}→ Verificando Node.js...${NC}"
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js no encontrado. Instala Node.js >= 20 desde https://nodejs.org${NC}"
  exit 1
fi

if ! node -e "process.exit(parseInt(process.versions.node.split('.')[0]) < 20 ? 1 : 0)" 2>/dev/null; then
  echo -e "${RED}✗ Node.js >= 20 requerido. Encontrado: $(node -v)${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v) — ABI $(node -e 'console.log(process.versions.modules)')${NC}"

# ─── Verificar Python (opcional, necesario para TTS) ──────────────────────────
echo -e "${CYAN}→ Verificando Python...${NC}"
PYTHON_CMD=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null && "$cmd" --version 2>&1 | grep -q "Python 3"; then
    PYTHON_CMD="$cmd"
    echo -e "${GREEN}✓ Python: $($cmd --version 2>&1)${NC}"
    break
  fi
done
if [ -z "$PYTHON_CMD" ]; then
  echo -e "${YELLOW}⚠ Python 3 no encontrado. El servicio TTS no estara disponible.${NC}"
fi

# ─── Setup .env ───────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo -e "${CYAN}→ Creando .env desde plantilla...${NC}"
  cp .env.example .env
  echo -e "${GREEN}✓ .env creado${NC}"
else
  echo -e "${YELLOW}⚠ .env ya existe, omitiendo${NC}"
fi

# ─── Install dependencies ─────────────────────────────────────────────────────
echo -e "${CYAN}→ Instalando dependencias npm...${NC}"
npm install
echo -e "${GREEN}✓ Dependencias instaladas${NC}"

# ─── Compilar módulos nativos para Mac ───────────────────────────────────────
# En Apple Silicon (M1-M5) los binarios pre-compilados de better-sqlite3 pueden
# no coincidir con el ABI de Node.js instalado, causando errores ESMloader en
# tiempo de ejecución. Se fuerza la compilación desde fuente para garantizar
# compatibilidad exacta con la plataforma y versión de Node actual.
echo -e "${CYAN}→ Compilando módulos nativos para Mac ${ARCH} (better-sqlite3)...${NC}"

# Función auxiliar: busca el .node en cualquier subdirectorio del paquete
# (puede estar en build/Release/ o en prebuilds/darwin-arm64/, según la versión)
find_node_binary() {
  find node_modules/better-sqlite3 -name "*.node" 2>/dev/null | head -1
}

# Función auxiliar: prueba que el módulo carga realmente en Node
sqlite3_loads() {
  node -e "require('better-sqlite3')" 2>/dev/null
}

# 1. Compilación estándar (descarga pre-built si está disponible, sino compila)
npm rebuild better-sqlite3
REBUILD_EXIT=$?

# 2. Si falla o el módulo no carga, forzar compilación desde fuente
if [ $REBUILD_EXIT -ne 0 ] || ! sqlite3_loads; then
  echo -e "${YELLOW}⚠ Compilación estándar no funcionó. Recompilando desde fuente (puede tardar ~1 min)...${NC}"
  npm rebuild better-sqlite3 --build-from-source
  if ! sqlite3_loads; then
    echo -e "${RED}✗ No se pudo compilar better-sqlite3.${NC}"
    echo -e "${RED}  Asegúrate de tener Xcode CLI Tools actualizados: xcode-select --install${NC}"
    echo -e "${RED}  Si el problema persiste, prueba: sudo xcode-select --reset${NC}"
    exit 1
  fi
fi

# 3. Localizar el binario (puede estar en build/Release/ o prebuilds/darwin-*/
NATIVE_BIN="$(find_node_binary)"
if [ -n "$NATIVE_BIN" ]; then
  BIN_INFO=$(file "$NATIVE_BIN")
  echo -e "${GREEN}✓ Módulo nativo: $(basename "$NATIVE_BIN") — ${BIN_INFO##*: }${NC}"

  # Si estamos en Apple Silicon y el binario no es arm64, recompilar desde fuente
  if [ "$ARCH" = "arm64" ] && ! echo "$BIN_INFO" | grep -q "arm64"; then
    echo -e "${YELLOW}⚠ Binario no es arm64. Forzando recompilación para Apple Silicon...${NC}"
    npm rebuild better-sqlite3 --build-from-source
    if ! sqlite3_loads; then
      echo -e "${RED}✗ No se pudo generar un binario arm64.${NC}"
      exit 1
    fi
    NATIVE_BIN="$(find_node_binary)"
    echo -e "${GREEN}✓ Recompilado: $(file "$NATIVE_BIN" | sed 's/.*: //')${NC}"
  fi
else
  # El módulo carga pero no encontramos el .node — raro pero no es error fatal
  echo -e "${YELLOW}⚠ No se encontró el archivo .node, pero el módulo carga correctamente.${NC}"
fi

echo -e "${GREEN}✓ Módulos nativos listos para Mac ${ARCH}${NC}"

# ─── Create data directory ────────────────────────────────────────────────────
mkdir -p data
echo -e "${GREEN}✓ Directorio data/ listo${NC}"

# ─── Setup TTS venv (opcional) ────────────────────────────────────────────────
TTS_VENV="tts-service/venv"
if [ -f "tts-service/tts_server.py" ]; then
  if [ -n "$PYTHON_CMD" ]; then
    echo -e "${CYAN}→ Configurando servicio TTS...${NC}"

    # Si existe un venv de Windows (no tiene bin/python), lo eliminamos
    # para crear uno Mac/Linux nativo.
    if [ -d "$TTS_VENV" ] && [ ! -f "$TTS_VENV/bin/python" ]; then
      echo -e "${YELLOW}⚠ Detectado venv de otra plataforma (Windows). Recreando para Mac/Linux...${NC}"
      if [[ -n "$TTS_VENV" && "$TTS_VENV" == */* ]]; then
        rm -rf -- "$TTS_VENV"
      fi
    fi

    if [ ! -d "$TTS_VENV" ]; then
      echo "  Creando entorno virtual Python..."
      "$PYTHON_CMD" -m venv "$TTS_VENV"
      echo "  Instalando dependencias TTS (puede tardar unos minutos)..."
      "$TTS_VENV/bin/pip" install -q -r tts-service/requirements.txt
      echo -e "${GREEN}✓ TTS configurado${NC}"
    else
      echo -e "${YELLOW}⚠ Entorno TTS ya existe, omitiendo${NC}"
    fi
  else
    echo -e "${YELLOW}⚠ TTS omitido: Python no disponible${NC}"
  fi
fi

echo ""
echo -e "${BOLD}${GREEN}✓ Instalacion completa!${NC}"
echo ""
echo -e "  ${BOLD}Iniciar desarrollo:${NC}"
echo -e "  ${CYAN}./dev.sh${NC}"
echo ""
echo -e "  ${BOLD}Compilar para produccion:${NC}"
echo -e "  ${CYAN}npm run build && npm start${NC}"
echo ""
echo -e "  La app estara disponible en: ${BOLD}http://localhost:5173${NC} (dev)"
echo ""
