import express from 'express'
import WebSocket from 'ws'
import multer from 'multer'
import { readdir, readFile, writeFile, access } from 'fs/promises'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = 2500
const WORKFLOWS_DIR = path.resolve(__dirname, '../data/comfy-workflows')
const CONFIG_FILE   = path.join(__dirname, 'config.json')

// Runtime config — loaded from disk, editable via PUT /api/config, saved on change
const config = {
  comfyUrl:      process.env.COMFY_URL || 'http://127.0.0.1:8188',
  comfyDir:      '',
  comfyStartCmd: 'python main.py --preview-method latent2rgb',
  apiToken:      process.env.BZCOMFY_TOKEN || '',
}

async function persistConfig() {
  try { await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)) } catch {}
}

// Load saved config (overrides defaults, but env var still takes precedence for comfyUrl)
try {
  const saved = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'))
  if (saved.comfyUrl)      config.comfyUrl      = saved.comfyUrl
  if (saved.comfyDir)      config.comfyDir      = saved.comfyDir
  if (saved.comfyStartCmd) config.comfyStartCmd = saved.comfyStartCmd
  if (saved.apiToken != null) config.apiToken   = saved.apiToken
} catch {}

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })
app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// promptId -> { events[], listeners Set, nodeMap {} }
const sessions = new Map()

// ── Helpers ──────────────────────────────────────────────────────────────────

function comfyWsUrl(clientId) {
  return config.comfyUrl.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`
}

// Follow a node reference chain to find a CLIPTextEncode node.
// Stops at ConditioningZeroOut (empty unconditional negative — no real prompt).
function resolveToTextEncode(workflow, nodeId, visited = new Set()) {
  if (!nodeId || visited.has(nodeId) || !workflow[nodeId]) return null
  visited.add(nodeId)
  const node = workflow[nodeId]
  if (node.class_type === 'CLIPTextEncode') return nodeId
  if (node.class_type === 'ConditioningZeroOut') return null
  for (const key of ['conditioning', 'cond', 'positive']) {
    if (Array.isArray(node.inputs?.[key])) {
      const result = resolveToTextEncode(workflow, node.inputs[key][0], visited)
      if (result) return result
    }
  }
  return null
}

function detectPromptNodes(workflow, meta) {
  if (meta?.promptNodeId) {
    return { positiveNodeId: meta.promptNodeId, negativeNodeId: meta.negativeNodeId ?? null }
  }
  const SAMPLER_TYPES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom'])
  for (const node of Object.values(workflow)) {
    if (!SAMPLER_TYPES.has(node.class_type)) continue
    const positive = resolveToTextEncode(workflow, node.inputs?.positive?.[0])
    const negative = resolveToTextEncode(workflow, node.inputs?.negative?.[0])
    if (positive) return { positiveNodeId: positive, negativeNodeId: negative }
  }
  // Fallback: first CLIPTextEncode with a plain string text input
  for (const [id, node] of Object.entries(workflow)) {
    if (node.class_type === 'CLIPTextEncode' && typeof node.inputs?.text === 'string') {
      return { positiveNodeId: id, negativeNodeId: null }
    }
  }
  return { positiveNodeId: null, negativeNodeId: null }
}

function detectImageInputNode(workflow, meta) {
  if (meta?.imageNodeId) {
    const node = workflow[meta.imageNodeId]
    return { nodeId: meta.imageNodeId, label: node?._meta?.title || 'Reference Image' }
  }
  for (const [id, node] of Object.entries(workflow)) {
    if (node.class_type === 'LoadImage') {
      return { nodeId: id, label: node._meta?.title || 'Reference Image' }
    }
  }
  return null
}

function buildNodeMap(workflow) {
  return Object.fromEntries(
    Object.entries(workflow).map(([id, node]) => [
      id,
      node._meta?.title || node.class_type || id,
    ])
  )
}

async function loadMeta(name) {
  try {
    return JSON.parse(await readFile(path.join(WORKFLOWS_DIR, `${name}_meta.json`), 'utf-8'))
  } catch {
    return null
  }
}

function formatLabel(id) {
  const UPPER = new Set(['sdxl', 'sd', 'xl', 'vae', 'clip', 'id', 'ip'])
  return id
    .split('_')
    .map(w => UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Read / update runtime config
app.get('/api/config', (_req, res) => res.json({
  comfyUrl:      config.comfyUrl,
  comfyDir:      config.comfyDir,
  comfyStartCmd: config.comfyStartCmd,
  apiToken:      config.apiToken,
}))

app.put('/api/config', async (req, res) => {
  const { comfyUrl, comfyDir, comfyStartCmd, apiToken } = req.body
  if (typeof comfyUrl      === 'string' && comfyUrl.trim())      config.comfyUrl      = comfyUrl.trim().replace(/\/$/, '')
  if (typeof comfyDir      === 'string')                          config.comfyDir      = comfyDir.trim()
  if (typeof comfyStartCmd === 'string' && comfyStartCmd.trim()) config.comfyStartCmd = comfyStartCmd.trim()
  if (typeof apiToken      === 'string')                          config.apiToken      = apiToken.trim()
  await persistConfig()
  res.json({ comfyUrl: config.comfyUrl, comfyDir: config.comfyDir, comfyStartCmd: config.comfyStartCmd, apiToken: config.apiToken })
})

const PLATFORM = process.platform   // 'darwin' | 'win32' | 'linux'
const IS_WIN   = PLATFORM === 'win32'
const IS_MAC   = PLATFORM === 'darwin'

// Expand ${comfyDir} and ~ / %USERPROFILE% so the template is portable.
function expandCmd(cmd, dir) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return cmd
    .replace(/\$\{comfyDir\}/g, dir)
    .replace(/%comfyDir%/gi, dir)   // Windows-style variable
    .replace(/~/g, home)
    .replace(/%USERPROFILE%/gi, home)
    .replace(/%APPDATA%/gi, process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
}

// Auto-detect ComfyUI Desktop installation on this machine.
// Returns a portable command template — only ${comfyDir} changes between machines.
app.get('/api/detect', async (req, res) => {
  const home     = process.env.HOME || process.env.USERPROFILE || ''
  const appData  = process.env.APPDATA       || path.join(home, 'AppData', 'Roaming')
  const localApp = process.env.LOCALAPPDATA  || path.join(home, 'AppData', 'Local')

  // ── macOS ──────────────────────────────────────────────────────────────────
  if (IS_MAC) {
    const desktopCfg = path.join(home, 'Library/Application Support/ComfyUI/config.json')
    const mainPy     = '/Applications/ComfyUI.app/Contents/Resources/ComfyUI/main.py'

    try { await access(mainPy) } catch {
      return res.status(404).json({ error: 'ComfyUI Desktop no encontrado en /Applications.' })
    }

    let basePath = ''
    try { basePath = JSON.parse(await readFile(desktopCfg, 'utf-8')).basePath || '' } catch {}
    if (!basePath) return res.status(404).json({ error: 'No se pudo leer el basePath de ComfyUI Desktop.' })

    const cmd = [
      `pkill -f 'main.py.*--port 8000' 2>/dev/null; sleep 1`,
      `\${comfyDir}/.venv/bin/python ${mainPy}`,
      `--user-directory \${comfyDir}/user`,
      `--input-directory \${comfyDir}/input`,
      `--output-directory \${comfyDir}/output`,
      `--front-end-root /Applications/ComfyUI.app/Contents/Resources/ComfyUI/web_custom_versions/desktop_app`,
      `--base-directory \${comfyDir}`,
      `--database-url sqlite:////\${comfyDir}/user/comfyui.db`,
      `--extra-model-paths-config '~/Library/Application Support/ComfyUI/extra_models_config.yaml'`,
      `--log-stdout --listen 127.0.0.1 --port 8000 --enable-manager --preview-method latent2rgb`,
    ].join(' ')

    return res.json({ comfyDir: basePath, comfyStartCmd: cmd, comfyUrl: 'http://127.0.0.1:8000' })
  }

  // ── Windows ────────────────────────────────────────────────────────────────
  if (IS_WIN) {
    const desktopCfg = path.join(appData, 'ComfyUI', 'config.json')

    // ComfyUI Desktop on Windows installs to one of these locations
    const candidates = [
      path.join(localApp, 'Programs', 'ComfyUI', 'resources', 'ComfyUI', 'main.py'),
      path.join(localApp, 'Programs', 'comfy-ui', 'resources', 'ComfyUI', 'main.py'),
      path.join(localApp, 'ComfyUI', 'resources', 'ComfyUI', 'main.py'),
    ]
    let mainPy = ''
    for (const p of candidates) { try { await access(p); mainPy = p; break } catch {} }

    if (!mainPy) {
      // Desktop not found — return a simple Python template for manual installs
      return res.json({
        comfyDir: '',
        comfyStartCmd: 'python main.py --preview-method latent2rgb',
        comfyUrl: 'http://127.0.0.1:8188',
        hint: 'ComfyUI Desktop no detectado. Rellena el directorio y ajusta el comando para tu instalación.',
      })
    }

    let basePath = ''
    try { basePath = JSON.parse(await readFile(desktopCfg, 'utf-8')).basePath || '' } catch {}
    if (!basePath) return res.status(404).json({ error: 'No se pudo leer el basePath de ComfyUI Desktop.' })

    const extraCfg = path.join(appData, 'ComfyUI', 'extra_models_config.yaml')
    // On Windows: kill by port then launch. Using PowerShell for the kill.
    const kill = `powershell -Command "try{Stop-Process -Id (Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess -Force}catch{}" 2>nul`
    const cmd = [
      `${kill} & timeout /t 1 /nobreak >nul &`,
      `"\${comfyDir}\\.venv\\Scripts\\python.exe" "${mainPy}"`,
      `--user-directory "\${comfyDir}\\user"`,
      `--input-directory "\${comfyDir}\\input"`,
      `--output-directory "\${comfyDir}\\output"`,
      `--base-directory "\${comfyDir}"`,
      `--database-url "sqlite:///\${comfyDir}\\user\\comfyui.db"`,
      `--extra-model-paths-config "${extraCfg}"`,
      `--log-stdout --listen 127.0.0.1 --port 8000 --enable-manager --preview-method latent2rgb`,
    ].join(' ')

    return res.json({ comfyDir: basePath, comfyStartCmd: cmd, comfyUrl: 'http://127.0.0.1:8000' })
  }

  // ── Linux / otros ──────────────────────────────────────────────────────────
  // No Desktop app — user runs Python directly from the ComfyUI repo.
  res.json({
    comfyDir: '',
    comfyStartCmd: 'python main.py --preview-method latent2rgb',
    comfyUrl: 'http://127.0.0.1:8188',
    hint: 'En Linux no hay auto-detección. Pon la ruta del repositorio ComfyUI y ajusta el comando.',
  })
})

// Launch ComfyUI as a detached background process
app.post('/api/launch', async (req, res) => {
  if (!config.comfyDir)      return res.status(400).json({ error: 'Configura el directorio de ComfyUI primero.' })
  if (!config.comfyStartCmd) return res.status(400).json({ error: 'Configura el comando de inicio primero.' })

  try { await access(config.comfyDir) } catch {
    return res.status(400).json({ error: `Directorio no encontrado: ${config.comfyDir}` })
  }

  // Expand ${comfyDir} and ~ before spawning
  const cmd = expandCmd(config.comfyStartCmd, config.comfyDir)

  await new Promise((resolve, reject) => {
    const child = spawn(cmd, [], {
      cwd:      config.comfyDir,
      shell:    true,
      detached: true,
      stdio:    'ignore',
    })
    const onError = err => { clearTimeout(t); reject(err) }
    const t = setTimeout(() => { child.removeListener('error', onError); child.unref(); resolve() }, 400)
    child.once('error', onError)
  }).then(
    () => res.json({ message: 'ComfyUI iniciando…' }),
    err => res.status(500).json({ error: `No se pudo arrancar: ${err.message}` })
  )
})

// List available workflows, including whether they need a reference image
app.get('/api/workflows', async (_req, res) => {
  try {
    const files = await readdir(WORKFLOWS_DIR)
    const workflows = await Promise.all(
      files
        .filter(f => f.endsWith('_api.json'))
        .map(async f => {
          const id = f.replace('_api.json', '')
          const meta = await loadMeta(id)
          const label = meta?.label || formatLabel(id)
          const workflowData = JSON.parse(
            await readFile(path.join(WORKFLOWS_DIR, f), 'utf-8')
          )
          const imgNode = detectImageInputNode(workflowData, meta)
          return {
            id,
            label,
            hasImageInput: !!imgNode,
            imageInputLabel: imgNode?.label ?? null,
          }
        })
    )
    res.json(workflows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Proxy image upload to ComfyUI
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' })

  try {
    const formData = new FormData()
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype })
    formData.append('image', blob, req.file.originalname)
    formData.append('type', 'input')
    formData.append('overwrite', 'true')

    const r = await fetch(`${config.comfyUrl}/upload/image`, { method: 'POST', body: formData })
    if (!r.ok) {
      const text = await r.text()
      return res.status(r.status).json({ error: text })
    }
    res.json(await r.json())
  } catch (err) {
    const message = err.code === 'ECONNREFUSED'
      ? `Cannot connect to ComfyUI at ${config.comfyUrl}`
      : err.message
    res.status(500).json({ error: message })
  }
})

// Start a generation
app.post('/api/generate', async (req, res) => {
  const { workflow: workflowName, prompt, negativePrompt = '', referenceImageName } = req.body
  if (!workflowName || !prompt?.trim()) {
    return res.status(400).json({ error: 'workflow and prompt are required' })
  }

  try {
    const workflowPath = path.join(WORKFLOWS_DIR, `${workflowName}_api.json`)
    const workflow = JSON.parse(await readFile(workflowPath, 'utf-8'))
    const meta = await loadMeta(workflowName)

    const { positiveNodeId, negativeNodeId } = detectPromptNodes(workflow, meta)
    const nodeMap = buildNodeMap(workflow)

    if (positiveNodeId) workflow[positiveNodeId].inputs.text = prompt
    if (negativeNodeId && negativePrompt.trim()) workflow[negativeNodeId].inputs.text = negativePrompt

    // Inject reference image filename into the LoadImage node
    if (referenceImageName) {
      const imgNode = detectImageInputNode(workflow, meta)
      if (imgNode) workflow[imgNode.nodeId].inputs.image = referenceImageName
    }

    // Randomize seed on every run
    for (const node of Object.values(workflow)) {
      if (['KSampler', 'KSamplerAdvanced'].includes(node.class_type) && node.inputs?.seed != null) {
        node.inputs.seed = Math.floor(Math.random() * 2 ** 32)
      }
    }

    const clientId = crypto.randomUUID()

    // Connect WS before submitting so we don't miss early events
    const ws = new WebSocket(comfyWsUrl(clientId))
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ComfyUI connection timeout — is it running at ${config.comfyUrl}?`)), 6000)
      ws.once('open', () => { clearTimeout(t); resolve() })
      ws.once('error', e => { clearTimeout(t); reject(e) })
    })

    const submitRes = await fetch(`${config.comfyUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    })

    if (!submitRes.ok) {
      ws.close()
      const text = await submitRes.text()
      let detail = text
      try {
        const body = JSON.parse(text)
        // "Node 'X' not found" — custom node missing
        if (typeof body?.error === 'string' && body.error.includes('not found')) {
          const match = body.error.match(/Node '([^']+)' not found/)
          const nodeName = match ? match[1] : 'desconocido'
          detail = `Nodo "${nodeName}" no encontrado en ComfyUI. El custom node que lo provee no está instalado. Instálalo desde ComfyUI Manager y reinicia ComfyUI.`
        } else {
          detail = body?.error?.message || body?.error || text
        }
      } catch {}
      return res.status(500).json({ error: `ComfyUI: ${detail}` })
    }

    const { prompt_id } = await submitRes.json()

    const session = { events: [], listeners: new Set(), nodeMap }
    sessions.set(prompt_id, session)

    const push = (type, data) => {
      const event = { type, data }
      session.events.push(event)
      for (const fn of session.listeners) fn(event)
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Latent preview: 8-byte header (type u32 BE + format u32 BE) then image bytes
        if (data.length < 9) return
        if (data.readUInt32BE(0) === 1) {
          const mime = data.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg'
          push('preview', { image: `data:${mime};base64,${data.slice(8).toString('base64')}` })
        }
        return
      }

      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.data?.prompt_id && msg.data.prompt_id !== prompt_id) return

      switch (msg.type) {
        case 'progress':
          push('progress', { step: msg.data.value, total: msg.data.max })
          break
        case 'executing':
          if (msg.data.node === null) {
            push('done', {})
            ws.close()
          } else {
            push('executing', { node: msg.data.node, title: session.nodeMap[msg.data.node] || msg.data.node })
          }
          break
        case 'executed':
          if (msg.data.output?.images?.length > 0) push('images', { images: msg.data.output.images })
          break
        case 'execution_error':
          push('error', { message: msg.data.exception_message || 'Execution error' })
          ws.close()
          break
      }
    })

    ws.on('error', err => push('error', { message: err.message }))

    res.json({ promptId: prompt_id })
  } catch (err) {
    const message = err.code === 'ECONNREFUSED'
      ? `Cannot connect to ComfyUI at ${config.comfyUrl}`
      : err.message
    res.status(500).json({ error: message })
  }
})

// Interrupt the current ComfyUI generation
app.post('/api/stop', async (_req, res) => {
  try {
    await fetch(`${config.comfyUrl}/interrupt`, { method: 'POST' })
    res.json({ message: 'Generación interrumpida' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Server-Sent Events — real-time progress stream
app.get('/api/progress/:promptId', (req, res) => {
  const session = sessions.get(req.params.promptId)
  if (!session) return res.status(404).json({ error: 'Session not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`)

  // Replay queued events (handles race between POST response and SSE connect)
  for (const event of session.events) send(event)
  session.listeners.add(send)
  req.on('close', () => session.listeners.delete(send))
})

// Proxy output image from ComfyUI (avoids browser CORS)
app.get('/api/image', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query
  if (!filename) return res.status(400).json({ error: 'filename required' })

  try {
    const url = new URL(`${config.comfyUrl}/view`)
    url.searchParams.set('filename', filename)
    url.searchParams.set('subfolder', subfolder)
    url.searchParams.set('type', type)

    const r = await fetch(url)
    if (!r.ok) return res.status(r.status).end()

    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png')
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`\n  bzComfy UI  → http://localhost:${PORT}`)
  console.log(`  Workflows   : ${WORKFLOWS_DIR}`)
  console.log(`  ComfyUI     : ${config.comfyUrl}`)
})

// ══════════════════════════════════════════════════════════════════════════════
// API PROXY — puerto 3500
// Expone la API nativa de ComfyUI con autenticación Bearer token.
// rpgSpeak apunta su comfyUiUrl a este servidor en lugar de a ComfyUI directamente.
// ══════════════════════════════════════════════════════════════════════════════

import { createServer } from 'node:http'

const PROXY_PORT = 3500
const proxyApp   = express()
proxyApp.use(express.json({ limit: '50mb' }))
proxyApp.use(upload.single('image'))

// ── CORS: solo *.javierbenzo.com puede llamar desde el navegador ─────────────
proxyApp.use((req, res, next) => {
  const origin = req.headers.origin || ''
  if (origin && (origin.endsWith('.javierbenzo.com') || origin === 'https://javierbenzo.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ── Auth: Bearer token (si está configurado) ─────────────────────────────────
proxyApp.use((req, res, next) => {
  const token = config.apiToken
  if (!token) return next()                          // sin token → modo desarrollo (abierto)
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ') && auth.slice(7) === token) return next()
  return res.status(401).json({ error: 'Unauthorized — Bearer token requerido' })
})

// ── Helper: proxy HTTP genérico ───────────────────────────────────────────────
async function proxyToComfy(req, res, path, opts = {}) {
  try {
    const url = new URL(`${config.comfyUrl}${path}`)
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v)

    const fetchOpts = { method: opts.method || req.method, headers: {} }
    if (opts.body !== undefined) {
      fetchOpts.body    = opts.body
      fetchOpts.headers = opts.headers || {}
    } else if (req.body && Object.keys(req.body).length > 0) {
      fetchOpts.body    = JSON.stringify(req.body)
      fetchOpts.headers = { 'Content-Type': 'application/json' }
    }

    const r = await fetch(url, fetchOpts)
    const ct = r.headers.get('content-type') || ''

    if (ct.includes('application/json')) {
      res.status(r.status).json(await r.json())
    } else {
      res.setHeader('Content-Type', ct)
      res.status(r.status).send(Buffer.from(await r.arrayBuffer()))
    }
  } catch (err) {
    const msg = err.code === 'ECONNREFUSED'
      ? `ComfyUI no disponible en ${config.comfyUrl} — ¿está encendida la máquina?`
      : err.message
    res.status(502).json({ error: msg })
  }
}

// ── POST /prompt — encolar workflow ──────────────────────────────────────────
proxyApp.post('/prompt', (req, res) => proxyToComfy(req, res, '/prompt'))

// ── GET /history/:promptId — estado de la generación ─────────────────────────
proxyApp.get('/history/:promptId', (req, res) =>
  proxyToComfy(req, res, `/history/${req.params.promptId}`))

// ── GET /view — descargar imagen generada ────────────────────────────────────
proxyApp.get('/view', (req, res) => proxyToComfy(req, res, '/view'))

// ── POST /upload/image — subir imagen de referencia ──────────────────────────
proxyApp.post('/upload/image', async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image provided' })
  try {
    const formData = new FormData()
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype })
    formData.append('image', blob, req.file.originalname)
    formData.append('type', 'input')
    formData.append('overwrite', 'true')
    const r = await fetch(`${config.comfyUrl}/upload/image`, { method: 'POST', body: formData })
    res.status(r.status).json(await r.json())
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// ── GET /system_stats — estado del sistema (usado por rpgSpeak para validar) ─
proxyApp.get('/system_stats', (req, res) => proxyToComfy(req, res, '/system_stats'))

// ── GET /object_info — lista de nodos disponibles ────────────────────────────
proxyApp.get('/object_info', (req, res) => proxyToComfy(req, res, '/object_info'))

// ── POST /interrupt — parar generación ───────────────────────────────────────
proxyApp.post('/interrupt', (req, res) => proxyToComfy(req, res, '/interrupt'))

// ── GET /health — health check para rpgSpeak ─────────────────────────────────
proxyApp.get('/health', (_req, res) => res.json({ status: 'ok', proxy: 'bzComfy', comfyUrl: config.comfyUrl }))

// ── Servidor HTTP + WebSocket proxy ──────────────────────────────────────────
const proxyServer = createServer(proxyApp)

// WebSocket proxy: /ws?clientId=... → ComfyUI WS
// rpgSpeak abre un WS para recibir progreso en tiempo real — lo pasamos tal cual.
proxyServer.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }

  // Validar token desde query param (los WS no envían headers Authorization)
  const url   = new URL(req.url, `http://localhost:${PROXY_PORT}`)
  const token = config.apiToken
  if (token && url.searchParams.get('token') !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
    return
  }

  // Conectar al WS de ComfyUI local
  const comfyWsUrl = config.comfyUrl.replace(/^http/, 'ws') + req.url
  const comfyWs    = new WebSocket(comfyWsUrl)

  comfyWs.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })

  comfyWs.on('open', () => {
    // Hacer el handshake WS con el cliente y luego puentear ambos lados
    const wss = new WebSocket.Server({ noServer: true })
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      clientWs.on('message', (data, isBinary) => {
        if (comfyWs.readyState === WebSocket.OPEN) comfyWs.send(data, { binary: isBinary })
      })
      comfyWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary })
      })
      clientWs.on('close', (code, reason) => comfyWs.close(code, reason))
      comfyWs.on('close', (code, reason) => clientWs.close(code, reason))
      clientWs.on('error', () => comfyWs.close())
      comfyWs.on('error', () => clientWs.close())
    })
  })
})

proxyServer.listen(PROXY_PORT, () => {
  const tokenStatus = config.apiToken ? '🔒 con token' : '⚠️  sin token (abierto)'
  console.log(`  API proxy   → http://localhost:${PROXY_PORT}  ${tokenStatus}`)
  console.log(`  (ComfyUI-compatible, para rpgSpeak)\n`)
})
