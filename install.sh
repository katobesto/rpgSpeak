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

# ─── Check Node.js version ────────────────────────────────────────────────────
echo -e "${CYAN}→ Verificando Node.js...${NC}"
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js no encontrado. Instala Node.js >= 20 desde https://nodejs.org${NC}"
  exit 1
fi

NODE_VERSION=$(node -e "process.exit(parseInt(process.versions.node.split('.')[0]) < 20 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "fail")
if [ "$NODE_VERSION" = "fail" ]; then
  echo -e "${RED}✗ Node.js >= 20 requerido. Encontrado: $(node -v)${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

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

# ─── Compilar módulos nativos para Mac ────────────────────────────────────────
# npm install no re-compila si el paquete ya existe en node_modules.
# npm rebuild fuerza la recompilacion del binario nativo (.node) para la
# plataforma actual, independientemente de lo que haya antes.
# Requiere: Python 3 (ya verificado arriba) + Xcode Command Line Tools.
# Si falta: xcode-select --install
echo -e "${CYAN}→ Compilando módulos nativos para Mac (better-sqlite3)...${NC}"
npm rebuild better-sqlite3
if [ $? -ne 0 ]; then
  echo -e "${RED}✗ La compilación de better-sqlite3 falló.${NC}"
  echo -e "${YELLOW}  Necesitas Xcode Command Line Tools: xcode-select --install${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Módulos nativos compilados para Mac${NC}"

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
    # Guarda explícita: solo actúa si la variable apunta a una ruta con
    # al menos dos componentes (evita rm -rf accidentales sobre / o "").
    if [ -d "$TTS_VENV" ] && [ ! -f "$TTS_VENV/bin/python" ]; then
      echo -e "${YELLOW}⚠ Detectado venv de otra plataforma (Windows). Recreando para Mac/Linux...${NC}"
      # Verificar que la ruta no está vacía y contiene al menos un '/'
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
echo -e "  ${BOLD}O usar Docker:${NC}"
echo -e "  ${CYAN}docker-compose up -d${NC}"
echo ""
echo -e "  La app estara disponible en: ${BOLD}http://localhost:5173${NC} (dev)"
echo ""
