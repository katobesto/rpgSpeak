/* bzComfy frontend */

const el = id => document.getElementById(id)

const state = {
  generating: false,
  eventSource: null,
  hasProgress: false,
  previewFrames: 0,     // binary preview frames received this generation
  stepsSincePreview: 0, // progress steps without a preview frame
  // Reference image
  workflows: [],
  currentWorkflow: null,
  uploadedImageName: null,
  uploadPending: false,
}

// ── Image zoom / pan ──────────────────────────────────
// Exposed so resetViewer() can reset the view.
let resetImageView = () => {}

function initImageInteraction() {
  const wrap = el('image-wrap')
  const img  = el('result-img')

  let zoom = 1, panX = 0, panY = 0
  let dragging = false, lastMouse = { x: 0, y: 0 }

  function apply() {
    img.style.transform = zoom === 1 && panX === 0 && panY === 0
      ? ''
      : `translate(${panX}px, ${panY}px) scale(${zoom})`
  }

  function updateCursor() {
    if (dragging)    { wrap.style.cursor = 'grabbing'; return }
    if (zoom > 1.01) { wrap.style.cursor = 'grab';     return }
    wrap.style.cursor = ''
  }

  // Zoom toward the cursor position.
  // Formula derivation: for centered img, containerCenter = transformOrigin.
  //   rendered point: screen = origin + P*zoom + pan
  //   keep P under cursor fixed → newPan = m*(1-ratio) + pan*ratio
  function zoomAt(clientX, clientY, factor) {
    const rect  = wrap.getBoundingClientRect()
    const mx    = clientX - (rect.left + rect.width  / 2)
    const my    = clientY - (rect.top  + rect.height / 2)
    const newZoom = Math.min(Math.max(zoom * factor, 0.2), 12)
    const ratio   = newZoom / zoom
    panX  = mx * (1 - ratio) + panX * ratio
    panY  = my * (1 - ratio) + panY * ratio
    zoom  = newZoom
    apply()
    updateCursor()
  }

  // Expose reset for use in resetViewer()
  resetImageView = () => {
    zoom = 1; panX = 0; panY = 0
    apply()
    wrap.style.cursor = ''
  }

  // ── Wheel: zoom at cursor ──────────────────────────
  // On macOS, trackpad pinch fires as wheel with ctrlKey=true and deltaY ≈ ±1–10.
  // Regular mouse wheel has deltaY ≈ ±100 per notch.
  // We use a steeper base for pinch so a short gesture gives meaningful zoom.
  //   Pinch  (ctrlKey): Math.pow(0.975, Δy) → ~7% per unit  → natural on trackpad
  //   Wheel  (normal) : Math.pow(0.999, Δy) → ~10% per notch → unchanged
  wrap.addEventListener('wheel', e => {
    if (img.classList.contains('hidden')) return
    e.preventDefault()
    const factor = e.ctrlKey
      ? Math.pow(0.975, e.deltaY)   // trackpad pinch — high sensitivity
      : Math.pow(0.999, e.deltaY)   // mouse wheel   — standard sensitivity
    zoomAt(e.clientX, e.clientY, factor)
  }, { passive: false })

  // ── Left-click drag: pan ───────────────────────────
  wrap.addEventListener('mousedown', e => {
    if (e.button !== 0 || img.classList.contains('hidden')) return
    dragging = true
    lastMouse = { x: e.clientX, y: e.clientY }
    wrap.style.cursor = 'grabbing'
    e.preventDefault()
  })

  window.addEventListener('mousemove', e => {
    if (!dragging) return
    panX += e.clientX - lastMouse.x
    panY += e.clientY - lastMouse.y
    lastMouse = { x: e.clientX, y: e.clientY }
    apply()
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    updateCursor()
  })

  // ── Double-click / double-tap: reset view ─────────
  wrap.addEventListener('dblclick', resetImageView)

  // ── Touch: pinch-zoom + single-finger pan ──────────
  let lastTouchDist = null
  let touchStartTime = 0
  let lastTapTime = 0

  function getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX
    const dy = touches[0].clientY - touches[1].clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  wrap.addEventListener('touchstart', e => {
    if (img.classList.contains('hidden')) return
    e.preventDefault()
    touchStartTime = Date.now()
    if (e.touches.length === 2) {
      lastTouchDist = getTouchDist(e.touches)
      dragging = false
    } else if (e.touches.length === 1) {
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      dragging = zoom > 1.01
    }
  }, { passive: false })

  wrap.addEventListener('touchmove', e => {
    if (img.classList.contains('hidden')) return
    e.preventDefault()
    if (e.touches.length === 2 && lastTouchDist !== null) {
      const newDist = getTouchDist(e.touches)
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2
      zoomAt(cx, cy, newDist / lastTouchDist)
      lastTouchDist = newDist
      dragging = false
    } else if (e.touches.length === 1 && dragging) {
      panX += e.touches[0].clientX - lastMouse.x
      panY += e.touches[0].clientY - lastMouse.y
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      apply()
    }
  }, { passive: false })

  wrap.addEventListener('touchend', e => {
    lastTouchDist = null
    if (e.touches.length === 0) dragging = false

    // Double-tap to reset zoom (two taps within 300ms with minimal movement)
    if (e.changedTouches.length === 1 && Date.now() - touchStartTime < 250) {
      const now = Date.now()
      if (now - lastTapTime < 350) {
        resetImageView()
        lastTapTime = 0
      } else {
        lastTapTime = now
      }
    }
  }, { passive: false })
}

// ── Init ─────────────────────────────────────────────

async function init() {
  await loadConfig()
  await loadWorkflows()
  initImageInteraction()

  el('generate-btn').addEventListener('click', generate)
  el('stop-btn').addEventListener('click', stopGeneration)
  el('prompt').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate()
  })

  // Settings panel
  el('settings-btn').addEventListener('click', toggleSettings)
  el('settings-save-btn').addEventListener('click', saveSettings)
  el('launch-btn').addEventListener('click', launchComfyUI)
  el('detect-btn').addEventListener('click', autoDetect)
  for (const id of ['comfy-url', 'comfy-dir']) {
    el(id).addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings() })
  }

  // Reference image
  el('workflow-select').addEventListener('change', onWorkflowChange)
  el('drop-zone').addEventListener('click', () => el('ref-image-input').click())
  el('ref-image-input').addEventListener('change', onFileSelected)
  el('ref-clear-btn').addEventListener('click', e => { e.stopPropagation(); clearRefImage() })
  el('drop-zone').addEventListener('dragover', e => { e.preventDefault(); el('drop-zone').classList.add('dragover') })
  el('drop-zone').addEventListener('dragleave', () => el('drop-zone').classList.remove('dragover'))
  el('drop-zone').addEventListener('drop', e => {
    e.preventDefault()
    el('drop-zone').classList.remove('dragover')
    const file = e.dataTransfer?.files?.[0]
    if (file && file.type.startsWith('image/')) handleRefFile(file)
  })
}

// ── Config ───────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch('/api/config')
    const data = await res.json()
    el('comfy-url').value        = data.comfyUrl      || ''
    el('comfy-dir').value        = data.comfyDir      || ''
    el('comfy-start-cmd').value  = data.comfyStartCmd || ''
    el('api-token').value        = data.apiToken      || ''
    el('footer-url').textContent = data.comfyUrl
  } catch {}
}

function toggleSettings() {
  const panel = el('settings-panel')
  const btn   = el('settings-btn')
  const hidden = panel.classList.toggle('hidden')
  btn.classList.toggle('active', !hidden)
}

async function saveSettings() {
  const comfyUrl      = el('comfy-url').value.trim()
  const comfyDir      = el('comfy-dir').value.trim()
  const comfyStartCmd = el('comfy-start-cmd').value.trim()
  const apiToken      = el('api-token').value.trim()
  if (!comfyUrl) return

  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comfyUrl, comfyDir, comfyStartCmd, apiToken }),
    })
    const data = await res.json()
    el('footer-url').textContent = data.comfyUrl
    el('comfy-url').value        = data.comfyUrl
    el('comfy-dir').value        = data.comfyDir
    el('comfy-start-cmd').value  = data.comfyStartCmd
    el('api-token').value        = data.apiToken
    flashSettingsStatus('✓ Guardado')
  } catch {
    flashSettingsStatus('✗ Error al guardar', true)
  }
}

async function autoDetect() {
  const btn = el('detect-btn')
  btn.disabled = true
  btn.textContent = '…'
  try {
    const res  = await fetch('/api/detect')
    const data = await res.json()
    if (!res.ok) {
      flashSettingsStatus(`✗ ${data.error}`, true)
      return
    }
    el('comfy-url').value       = data.comfyUrl
    el('comfy-dir').value       = data.comfyDir
    el('comfy-start-cmd').value = data.comfyStartCmd
    const msg = data.hint
      ? `⚠ ${data.hint}`
      : '✓ Detectado — pulsa Guardar para confirmar'
    flashSettingsStatus(msg, !!data.hint)
  } catch (err) {
    flashSettingsStatus(`✗ ${err.message}`, true)
  } finally {
    btn.disabled = false
    btn.textContent = 'Auto-detectar'
  }
}

async function launchComfyUI() {
  const btn = el('launch-btn')
  btn.disabled = true
  flashSettingsStatus('Iniciando ComfyUI…')

  try {
    const res  = await fetch('/api/launch', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      flashSettingsStatus(`✗ ${data.error}`, true)
    } else {
      flashSettingsStatus('✓ ComfyUI arrancando — espera unos segundos')
    }
  } catch (err) {
    flashSettingsStatus(`✗ ${err.message}`, true)
  } finally {
    btn.disabled = false
  }
}

function flashSettingsStatus(msg, isError = false) {
  const s = el('settings-status')
  s.textContent = msg
  s.className = `settings-status show${isError ? ' err' : ''}`
  clearTimeout(s._t)
  s._t = setTimeout(() => s.classList.remove('show'), isError ? 4000 : 2500)
}

// ── Workflows ─────────────────────────────────────────

async function loadWorkflows() {
  try {
    const res = await fetch('/api/workflows')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    state.workflows = await res.json()

    const select = el('workflow-select')
    if (state.workflows.length === 0) {
      select.innerHTML = '<option value="">No se encontraron workflows</option>'
      return
    }
    select.innerHTML = state.workflows
      .map(w => `<option value="${w.id}">${w.label}</option>`)
      .join('')

    // Trigger change for initial selection
    onWorkflowChange()
  } catch (err) {
    el('workflow-select').innerHTML = '<option value="">Error cargando workflows</option>'
    showStatus(`Error cargando workflows: ${err.message}`, 'error')
  }
}

function onWorkflowChange() {
  const id = el('workflow-select').value
  state.currentWorkflow = state.workflows.find(w => w.id === id) ?? null
  clearRefImage()

  const refField = el('ref-image-field')
  if (state.currentWorkflow?.hasImageInput) {
    el('ref-image-label').textContent =
      state.currentWorkflow.imageInputLabel || 'Imagen de referencia'
    refField.classList.remove('hidden')
  } else {
    refField.classList.add('hidden')
  }
}

// ── Reference image upload ────────────────────────────

function onFileSelected(e) {
  const file = e.target.files?.[0]
  if (file) handleRefFile(file)
  // Reset input so the same file can be re-selected if needed
  e.target.value = ''
}

function handleRefFile(file) {
  // Show preview immediately
  const reader = new FileReader()
  reader.onload = ev => { el('ref-preview-img').src = ev.target.result }
  reader.readAsDataURL(file)

  el('ref-file-name').textContent = file.name
  setRefStatus('Subiendo…', '')
  el('drop-placeholder').classList.add('hidden')
  el('drop-preview').classList.remove('hidden')

  uploadRefImage(file)
}

async function uploadRefImage(file) {
  state.uploadPending = true
  state.uploadedImageName = null

  const formData = new FormData()
  formData.append('image', file, file.name)

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData })
    const data = await res.json()

    if (!res.ok || data.error) {
      setRefStatus(`✗ ${data.error || 'Error al subir'}`, 'err')
      state.uploadPending = false
      return
    }

    state.uploadedImageName = data.name
    setRefStatus('✓ Lista', 'ok')
  } catch (err) {
    setRefStatus(`✗ ${err.message}`, 'err')
  } finally {
    state.uploadPending = false
  }
}

function setRefStatus(text, cls) {
  const s = el('ref-upload-status')
  s.textContent = text
  s.className = `ref-upload-status ${cls}`
}

function clearRefImage() {
  state.uploadedImageName = null
  state.uploadPending = false
  el('ref-preview-img').src = ''
  el('ref-file-name').textContent = ''
  setRefStatus('', '')
  el('drop-preview').classList.add('hidden')
  el('drop-placeholder').classList.remove('hidden')
}

// ── Generate ─────────────────────────────────────────

async function generate() {
  if (state.generating) return

  const workflow = el('workflow-select').value
  const prompt = el('prompt').value.trim()
  const negativePrompt = el('negative-prompt').value.trim()

  if (!workflow) return showStatus('Selecciona un workflow primero.', 'error')
  if (!prompt)   return showStatus('Escribe un prompt antes de generar.', 'error')

  // Check if reference image is required and ready
  if (state.currentWorkflow?.hasImageInput) {
    if (state.uploadPending) return showStatus('Espera a que termine la subida de la imagen.', 'error')
    if (!state.uploadedImageName) return showStatus('Este workflow necesita una imagen de referencia.', 'error')
  }

  state.previewFrames = 0
  state.stepsSincePreview = 0
  setGenerating(true)
  clearStatus()
  resetViewer()

  // On mobile, scroll the viewer into view so the user can see progress
  if (window.innerWidth <= 640) {
    document.querySelector('.viewer').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  showNoPreviewHint(false)
  showProgressPanel(true)
  setProgressIndeterminate(true)
  setNode('Enviando a ComfyUI…')
  setStep(0, 0)

  try {
    const body = { workflow, prompt, negativePrompt }
    if (state.uploadedImageName) body.referenceImageName = state.uploadedImageName

    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()

    if (!res.ok) {
      setGenerating(false)
      showProgressPanel(false)
      return showStatus(data.error || 'Error desconocido', 'error')
    }

    connectSSE(data.promptId)
  } catch (err) {
    setGenerating(false)
    showProgressPanel(false)
    showStatus(`Error de red: ${err.message}`, 'error')
  }
}

// ── SSE ──────────────────────────────────────────────

function connectSSE(promptId) {
  if (state.eventSource) state.eventSource.close()

  const es = new EventSource(`/api/progress/${promptId}`)
  state.eventSource = es

  es.onmessage = e => {
    try { handleEvent(JSON.parse(e.data)) } catch {}
  }
  es.onerror = () => {
    if (state.generating) {
      setGenerating(false)
      showProgressPanel(false)
      showStatus('Conexión SSE perdida.', 'error')
    }
    es.close()
  }
}

function handleEvent({ type, data }) {
  switch (type) {
    case 'progress':
      state.hasProgress = true
      setProgressIndeterminate(false)
      setStep(data.step, data.total)
      // After 5 steps with no preview frame, surface the hint once
      if (state.previewFrames === 0) {
        state.stepsSincePreview++
        if (state.stepsSincePreview === 5) showNoPreviewHint(true)
      }
      break

    case 'executing':
      setNode(data.title || data.node)
      if (!state.hasProgress) setProgressIndeterminate(true)
      break

    case 'preview':
      state.previewFrames++
      state.stepsSincePreview = 0
      showNoPreviewHint(false)
      showImage(data.image, true)
      break

    case 'images': {
      const img = data.images[0]
      const url =
        `/api/image?filename=${encodeURIComponent(img.filename)}` +
        `&subfolder=${encodeURIComponent(img.subfolder || '')}` +
        `&type=${encodeURIComponent(img.type || 'output')}`
      showImage(url, false)
      break
    }

    case 'done':
      finishGeneration()
      break

    case 'error':
      setGenerating(false)
      showProgressPanel(false)
      showStatus(data.message || 'Error desconocido en ComfyUI', 'error')
      if (state.eventSource) { state.eventSource.close(); state.eventSource = null }
      break
  }
}

function finishGeneration() {
  setGenerating(false)
  setNode('Completado')
  setProgressIndeterminate(false)
  el('progress-fill').style.width = '100%'

  setTimeout(() => {
    showProgressPanel(false)
    el('preview-badge').classList.add('hidden')
  }, 1200)

  if (state.eventSource) { state.eventSource.close(); state.eventSource = null }
}

// ── UI helpers ───────────────────────────────────────

async function stopGeneration() {
  const btn = el('stop-btn')
  btn.textContent = '⏳ Parando…'
  btn.disabled = true
  try {
    await fetch('/api/stop', { method: 'POST' })
  } finally {
    btn.textContent = '⏹ Parar'
    btn.disabled = false
  }
}

function setGenerating(value) {
  state.generating = value
  state.hasProgress = false
  const btn = el('generate-btn')
  btn.disabled = value
  el('btn-label').textContent = value ? 'Generando…' : 'Generar'
  el('btn-spinner').classList.toggle('hidden', !value)
  el('stop-btn').classList.toggle('hidden', !value)
}

function showStatus(msg, type = 'info') {
  const s = el('status')
  s.textContent = msg
  s.className = `status ${type}`
  s.classList.remove('hidden')
}

function clearStatus() {
  const s = el('status')
  s.textContent = ''
  s.className = 'status hidden'
}

function resetViewer() {
  const img = el('result-img')
  img.className = 'hidden'
  img.src = ''
  el('placeholder').classList.remove('hidden')
  el('preview-badge').classList.add('hidden')
  resetImageView()
}

function showImage(src, isPreview) {
  const img = el('result-img')
  img.onload = () => {
    img.classList.remove('hidden')
    img.classList.add('fade-in')
    el('placeholder').classList.add('hidden')
  }
  img.src = src
  el('preview-badge').classList.toggle('hidden', !isPreview)
}

function showProgressPanel(visible) {
  el('progress-panel').classList.toggle('hidden', !visible)
}

function showNoPreviewHint(visible) {
  el('no-preview-hint').classList.toggle('hidden', !visible)
}

function setProgressIndeterminate(on) {
  el('progress-fill').classList.toggle('indeterminate', on)
}

function setNode(title) {
  el('node-name').textContent = title || '—'
}

function setStep(step, total) {
  if (total > 0) {
    el('progress-fill').style.width = `${(step / total) * 100}%`
    el('step-label').textContent = `${step} / ${total}`
  } else {
    el('step-label').textContent = ''
  }
}

document.addEventListener('DOMContentLoaded', init)
