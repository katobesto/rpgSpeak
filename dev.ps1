# rpgSpeak dev launcher para Windows
# Uso: .\dev.ps1              (arrancar - accesible desde la red local)
#      .\dev.ps1 --local      (arrancar - solo localhost, sin acceso LAN)
#      .\dev.ps1 stop         (parar puertos)

param([string]$Command = "", [switch]$Local)

$SERVER_PORT = 3000
$CLIENT_PORT = 5173

# Acepta tanto -Local (switch PowerShell) como --local (convencion bash)
$LocalOnly = $Local.IsPresent
if ($Command -match '^--?local$') { $LocalOnly = $true; $Command = "" }

# Host de escucha y CORS segun modo
if ($LocalOnly) {
    $BindHost   = "127.0.0.1"
    $CorsOrigin = "http://localhost:$CLIENT_PORT"
} else {
    $BindHost   = "0.0.0.0"
    $CorsOrigin = "*"
}

function Stop-Ports {
    $ports = @($SERVER_PORT, $CLIENT_PORT)
    $killed = $false
    foreach ($port in $ports) {
        $pids = (netstat -ano | Select-String ":$port\s" | ForEach-Object {
            ($_ -split '\s+')[-1]
        } | Sort-Object -Unique | Where-Object { $_ -match '^\d+$' })
        foreach ($p in $pids) {
            try { Stop-Process -Id $p -Force -ErrorAction Stop; $killed = $true } catch {}
        }
    }
    if ($killed) { Write-Host "Puertos $($ports -join ', ') liberados." }
    else         { Write-Host "Puertos libres, nada que detener." }
}

if ($Command -eq "stop") { Stop-Ports; exit 0 }

# Matar restos de sesiones anteriores
Stop-Ports

$root = $PSScriptRoot
Set-Location $root

# ── Verificar binarios nativos (detecta binarios de Mac/Linux y los recompila) ─
if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "! node_modules no encontrado. Ejecuta .\install.ps1 primero." -ForegroundColor Red
    exit 1
}
$nativeBinary = Join-Path $root "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
$needsRebuild = $false
if (Test-Path $nativeBinary) {
    # Los ejecutables Windows (PE) empiezan con los bytes 0x4D 0x5A ("MZ")
    $bytes = [System.IO.File]::ReadAllBytes($nativeBinary)
    if (-not ($bytes[0] -eq 0x4D -and $bytes[1] -eq 0x5A)) {
        $needsRebuild = $true
        Write-Host "! Binario de otra plataforma detectado (Mac/Linux). Recompilando para Windows..." -ForegroundColor Yellow
    }
} else {
    $needsRebuild = $true
    Write-Host "! Binario nativo no encontrado. Compilando..." -ForegroundColor Yellow
}
if ($needsRebuild) {
    # npm rebuild fuerza recompilacion del modulo nativo para la plataforma actual.
    # Requiere Python 3 y Visual Studio Build Tools (C++).
    # Si falla, instala las herramientas desde:
    #   https://visualstudio.microsoft.com/visual-cpp-build-tools/
    npm rebuild better-sqlite3
    if ($LASTEXITCODE -ne 0) {
        Write-Host "x Recompilacion fallida." -ForegroundColor Red
        Write-Host "  Asegurate de tener Python 3 y Visual Studio C++ Build Tools instalados." -ForegroundColor Red
        Write-Host "  Descarga: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Red
        exit 1
    }
    Write-Host "v Binario Windows compilado correctamente." -ForegroundColor Green
    Write-Host ""
}

# ── Obtener IP local para modo red ────────────────────────────────────────────
$localIP = $null
if (-not $LocalOnly) {
    $localIP = try {
        (Get-NetIPAddress -AddressFamily IPv4 |
         Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
         Sort-Object InterfaceAlias |
         Select-Object -First 1).IPAddress
    } catch { $null }
    if (-not $localIP) { $localIP = "tu-IP-local" }
}

Write-Host ""
Write-Host "Arrancando rpgSpeak..." -ForegroundColor Cyan
if ($LocalOnly) {
    Write-Host "    Modo: solo localhost (--local)" -ForegroundColor Yellow
    Write-Host "    Server -> http://localhost:$SERVER_PORT"
    Write-Host "    Client -> http://localhost:$CLIENT_PORT"
} else {
    Write-Host "    Modo: red local (accesible desde LAN)" -ForegroundColor Green
    Write-Host "    Server -> http://localhost:$SERVER_PORT  /  http://${localIP}:$SERVER_PORT"
    Write-Host "    Client -> http://localhost:$CLIENT_PORT  /  http://${localIP}:$CLIENT_PORT"
}
Write-Host ""
Write-Host "    Cierra esta ventana o pulsa Ctrl+C para detener todo."
Write-Host ""

$jobs = @()

# ── Node server ───────────────────────────────────────────────────────────────
Write-Host "Arrancando servidor..."
$jobs += Start-Job -Name "server" -ScriptBlock {
    param($root, $bindHost, $corsOrigin)
    Set-Location $root
    $env:HOST        = $bindHost
    $env:CORS_ORIGIN = $corsOrigin
    npx tsx server/src/index.ts 2>&1
} -ArgumentList $root, $BindHost, $CorsOrigin

Start-Sleep -Seconds 2

# ── Vite client ───────────────────────────────────────────────────────────────
Write-Host "Arrancando cliente Vite..."
$jobs += Start-Job -Name "client" -ScriptBlock {
    param($root, $port, $localOnly)
    Set-Location "$root\client"
    if ($localOnly) {
        npx vite --port $port 2>&1
    } else {
        npx vite --port $port --host 2>&1
    }
} -ArgumentList $root, $CLIENT_PORT, $LocalOnly

Write-Host ""
Write-Host "Todos los servicios arrancados. Mostrando logs (Ctrl+C para parar)..."
Write-Host ""

try {
    while ($true) {
        $anyDead = $false
        foreach ($job in $jobs) {
            $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
            if ($output) { $output | ForEach-Object { Write-Host "[$($job.Name)] $_" } }
            if ($job.State -eq 'Failed' -or $job.State -eq 'Completed') {
                Write-Host "[$($job.Name)] proceso terminado - parando todo..."
                $anyDead = $true
            }
        }
        if ($anyDead) { break }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Write-Host "`nDeteniendo todos los servicios..."
    $jobs | ForEach-Object { Stop-Job -Job $_ -ErrorAction SilentlyContinue }
    $jobs | ForEach-Object { Remove-Job -Job $_ -ErrorAction SilentlyContinue -Force }
    Stop-Ports
    Write-Host "Todo detenido."
}
