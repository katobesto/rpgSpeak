# rpgSpeak - Instalador para Windows
# Uso: .\install.ps1

$root = $PSScriptRoot
# Ejecutar siempre desde el directorio del script para que todas las rutas
# relativas posteriores sean correctas, independientemente del CWD inicial.
Set-Location $root

function Write-Step($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "v  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "!  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "x  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  rpgSpeak - Local AI Character Roleplay Platform" -ForegroundColor Cyan
Write-Host ""

# ── Verificar Node.js >= 20 ──────────────────────────────────────────────────
Write-Step "Verificando Node.js..."
try {
    node -e "process.exit(parseInt(process.versions.node.split('.')[0]) < 20 ? 1 : 0)" 2>$null
    if ($LASTEXITCODE -ne 0) { throw }
    Write-OK "Node.js $(node -v)"
} catch {
    Write-Fail "Node.js no encontrado o version < 20."
    Write-Fail "Instala Node.js >= 20 desde https://nodejs.org"
    exit 1
}

# ── Verificar Python (opcional, necesario para TTS) ──────────────────────────
Write-Step "Verificando Python..."
$pythonCmd = $null
foreach ($cmd in @("python", "py", "python3")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$ver" -match "Python 3") {
            $pythonCmd = $cmd
            Write-OK "Python: $ver"
            break
        }
    } catch {}
}
if (-not $pythonCmd) {
    Write-Warn "Python 3 no encontrado. El servicio TTS no estara disponible."
    Write-Warn "Opcional: instala Python 3 desde https://www.python.org"
}

# ── Crear .env ───────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $root ".env"))) {
    Write-Step "Creando .env desde plantilla..."
    Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
    Write-OK ".env creado"
} else {
    Write-Warn ".env ya existe, omitiendo"
}

# ── Instalar dependencias npm ─────────────────────────────────────────────────
Write-Step "Instalando dependencias npm..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Fail "npm install fallo. Revisa los errores de arriba."
    exit 1
}
Write-OK "Dependencias instaladas"

# ── Compilar modulos nativos para Windows ─────────────────────────────────────
# npm install no re-compila si el paquete ya existe en node_modules.
# npm rebuild fuerza la recompilacion del binario nativo (.node) para la
# plataforma actual, independientemente de lo que haya antes.
# Requiere: Python 3 (ya verificado arriba) + Visual Studio C++ Build Tools.
# Si falla, descarga las herramientas desde:
#   https://visualstudio.microsoft.com/visual-cpp-build-tools/
Write-Step "Compilando modulos nativos para Windows (better-sqlite3)..."
npm rebuild better-sqlite3
if ($LASTEXITCODE -ne 0) {
    Write-Fail "La compilacion de better-sqlite3 fallo."
    Write-Warn "Necesitas Visual Studio C++ Build Tools."
    Write-Warn "Descarga: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Write-Warn "(selecciona 'Desarrollo de escritorio con C++')"
    exit 1
}
Write-OK "Modulos nativos compilados para Windows"

# ── Crear directorio de datos ─────────────────────────────────────────────────
$dataDir = Join-Path $root "data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}
Write-OK "Directorio data/ listo"

# ── Configurar TTS (entorno virtual Python) ───────────────────────────────────
$ttsScript = Join-Path $root "tts-service\tts_server.py"
$ttsVenv   = Join-Path $root "tts-service\venv"
if (Test-Path $ttsScript) {
    if ($pythonCmd) {
        Write-Step "Configurando servicio TTS..."

        # Si existe un venv de Mac (no tiene Scripts\python.exe), lo eliminamos
        # para crear uno Windows nativo.
        if ((Test-Path $ttsVenv) -and -not (Test-Path (Join-Path $ttsVenv "Scripts\python.exe"))) {
            Write-Warn "Detectado venv de otra plataforma (Mac/Linux). Recreando para Windows..."
            # Guarda: verificar que la ruta es absoluta y apunta dentro del proyecto
            # antes de borrar, para evitar eliminaciones accidentales.
            if ($ttsVenv.StartsWith($root) -and $ttsVenv.Length -gt $root.Length) {
                Remove-Item $ttsVenv -Recurse -Force
            }
        }

        if (-not (Test-Path $ttsVenv)) {
            Write-Host "   Creando entorno virtual Python..." -ForegroundColor Cyan
            & $pythonCmd -m venv $ttsVenv
            Write-Host "   Instalando dependencias TTS (puede tardar unos minutos)..." -ForegroundColor Cyan
            & "$ttsVenv\Scripts\pip" install -q -r (Join-Path $root "tts-service\requirements.txt")
            Write-OK "TTS configurado"
        } else {
            Write-Warn "Entorno TTS ya existe, omitiendo"
        }
    } else {
        Write-Warn "TTS omitido: Python no disponible"
    }
}

Write-Host ""
Write-OK "Instalacion completa!"
Write-Host ""
Write-Host "  Iniciar desarrollo:" -ForegroundColor White
Write-Host "    .\dev.ps1" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Compilar para produccion:" -ForegroundColor White
Write-Host "    npm run build" -ForegroundColor Cyan
Write-Host ""
Write-Host "  O usar Docker:" -ForegroundColor White
Write-Host "    docker-compose up -d" -ForegroundColor Cyan
Write-Host ""
Write-Host "  La app estara disponible en: http://localhost:5173 (dev)" -ForegroundColor White
Write-Host ""
