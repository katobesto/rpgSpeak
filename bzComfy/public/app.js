/* bzComfy frontend */

const el = id => document.getElementById(id)

// ── Sesión de usuario ─────────────────────────────────────────────────────────
// La sesión (token de login) y el apiToken (para la configuración) son
// dos cosas distintas. La sesión autentica al usuario humano. El apiToken
// autentica a rpgSpeak.
const SESSION_KEY = 'bzcomfy_session'  // token de sesión (login de usuario)
const TOKEN_KEY   = 'bzcomfy_token'    // apiToken (Bearer para rpgSpeak)

let currentUser = null  // { username, role } — se rellena en init()

function getSessionToken() { return localStorage.getItem(SESSION_KEY) || '' }
function setSessionToken(t) {
  if (t) localStorage.setItem(SESSION_KEY, t)
  else   localStorage.removeItem(SESSION_KEY)
}

function getToken() { return localStorage.getItem(TOKEN_KEY) || '' }
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else   localStorage.removeItem(TOKEN_KEY)
}

// apiFetch usa el session token (o el apiToken si no hay sesión) en cada llamada
function apiFetch(url, opts = {}) {
  const token = getSessionToken() || getToken()
  const headers = { ...(opts.headers || {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  return fetch(url, { ...opts, headers })
}

// ── Auth: verificar sesión al cargar ─────────────────────────────────────────
async function checkAuth() {
  const token = getSessionToken()
  if (!token) { window.location.href = '/login.html'; return false }
  try {
    const res = await fetch('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) { setSessionToken(''); window.location.href = '/login.html'; return false }
    currentUser = await res.json()
    // Mostrar botones admin-only solo a admins
    if (currentUser.role === 'admin') {
      const usersBtn = el('users-btn')
      if (usersBtn) usersBtn.style.display = 'flex'
      const settingsBtn = el('settings-btn')
      if (settingsBtn) settingsBtn.style.display = 'flex'
    }
    return true
  } catch {
    window.location.href = '/login.html'
    return false
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  const token = getSessionToken()
  if (token) {
    await fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
  }
  setSessionToken('')
  window.location.href = '/login.html'
}

// ── Gestión de usuarios ───────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
function escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}

function openUsersModal() {
  el('users-modal').style.display = 'flex'
  loadUsers()
}
function closeUsersModal() {
  el('users-modal').style.display = 'none'
}

async function loadUsers() {
  const res = await apiFetch('/api/users')
  if (!res.ok) return
  const users = await res.json()
  el('users-list').innerHTML = users.map(u => `
    <div id=”ur-${u.id}” style=”border-bottom:1px solid #2a2a30;padding:10px 0”>

      <!-- Vista normal -->
      <div id=”uv-${u.id}” style=”display:flex;align-items:center;gap:8px”>
        <div style=”flex:1;min-width:0;overflow:hidden”>
          <span style=”font-size:13px;font-weight:500”>${escHtml(u.username)}</span>
          <span style=”font-size:10px;margin-left:6px;padding:1px 6px;border-radius:4px;
            background:${u.role==='admin'?'rgba(124,111,255,.2)':'rgba(113,113,122,.2)'};
            color:${u.role==='admin'?'#a78bfa':'#a1a1aa'}”>${u.role}</span>
          ${u.mustChangePassword ? '<span style=”font-size:10px;color:#fbbf24;margin-left:4px”>⚠ cambio req.</span>' : ''}
        </div>
        <button class=”um-btn” onclick=”startEditUser('${u.id}')”>Editar</button>
        ${u.id !== '1' ? `<button class=”um-btn um-btn-danger” onclick=”startDeleteUser('${u.id}','${escAttr(u.username)}')”>Eliminar</button>` : ''}
      </div>

      <!-- Formulario de edición (oculto) -->
      <div id=”ue-${u.id}” class=”um-edit-form” style=”display:none”>
        <input id=”en-${u.id}” value=”${escAttr(u.username)}” placeholder=”Usuario”
          style=”background:#0d0d0f;border:1px solid #2a2a30;border-radius:8px;padding:6px 10px;font-size:12px;color:#e2e2e5;outline:none;width:100%;box-sizing:border-box” />
        <select id=”er-${u.id}”
          style=”background:#0d0d0f;border:1px solid #2a2a30;border-radius:8px;padding:6px 10px;font-size:12px;color:#e2e2e5;outline:none”>
          <option value=”user”${u.role==='user'?' selected':''}>user</option>
          <option value=”admin”${u.role==='admin'?' selected':''}>admin</option>
        </select>
        <input id=”ep-${u.id}” type=”password” placeholder=”Nueva contraseña (vacío = sin cambiar)”
          style=”background:#0d0d0f;border:1px solid #2a2a30;border-radius:8px;padding:6px 10px;font-size:12px;color:#e2e2e5;outline:none;width:100%;box-sizing:border-box” />
        <div id=”ee-${u.id}” style=”font-size:11px;color:#f87171;display:none”></div>
        <div style=”display:flex;gap:6px;justify-content:flex-end;margin-top:2px”>
          <button class=”um-btn” onclick=”cancelEditUser('${u.id}')”>Cancelar</button>
          <button class=”um-btn um-btn-primary” onclick=”saveEditUser('${u.id}')”>Guardar</button>
        </div>
      </div>

      <!-- Confirmación de borrado (oculto) -->
      <div id=”ud-${u.id}” class=”um-delete-confirm” style=”display:none”>
        <span style=”flex:1;font-size:12px;color:#e2e2e5”>¿Eliminar <strong>${escHtml(u.username)}</strong>?</span>
        <button class=”um-btn” onclick=”cancelDeleteUser('${u.id}')”>No</button>
        <button class=”um-btn um-btn-danger” onclick=”confirmDeleteUser('${u.id}')”>Sí, eliminar</button>
      </div>

    </div>
  `).join('')
}

function startEditUser(id) {
  el('uv-' + id).style.display = 'none'
  el('ue-' + id).style.display = 'flex'
  el('ep-' + id).value = ''
  el('ee-' + id).style.display = 'none'
}
function cancelEditUser(id) {
  el('ue-' + id).style.display = 'none'
  el('uv-' + id).style.display = 'flex'
}
async function saveEditUser(id) {
  const username = el('en-' + id).value.trim()
  const role     = el('er-' + id).value
  const password = el('ep-' + id).value
  const errEl    = el('ee-' + id)
  errEl.style.display = 'none'
  if (!username) { errEl.textContent = 'El nombre de usuario no puede estar vacío'; errEl.style.display = 'block'; return }
  const body = { username, role }
  if (password) { body.password = password; body.mustChangePassword = false }
  const res = await apiFetch(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(body) })
  if (res.ok) { loadUsers() }
  else { const d = await res.json().catch(() => ({})); errEl.textContent = d.error || 'Error al guardar'; errEl.style.display = 'block' }
}

function startDeleteUser(id, username) {
  el('uv-' + id).style.display = 'none'
  el('ud-' + id).style.display = 'flex'
}
function cancelDeleteUser(id) {
  el('ud-' + id).style.display = 'none'
  el('uv-' + id).style.display = 'flex'
}
async function confirmDeleteUser(id) {
  const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' })
  if (res.ok) { loadUsers() }
  else { const d = await res.json().catch(() => ({})); el('ud-' + id).querySelector('span').textContent = d.error || 'Error al eliminar' }
}

async function createUser() {
  const username = el('new-username').value.trim()
  const password = el('new-password').value
  const role     = el('new-role').value
  const errEl    = el('new-user-error')
  errEl.style.display = 'none'
  if (!username || !password) { errEl.textContent = 'Usuario y contraseña requeridos'; errEl.style.display='block'; return }
  const res = await apiFetch('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) })
  const data = await res.json()
  if (!res.ok) { errEl.textContent = data.error; errEl.style.display='block'; return }
  el('new-username').value = ''
  el('new-password').value = ''
  loadUsers()
}

const state = {
  generating: false,
  eventSource: null,
  hasProgress: false,
  previewFrames: 0,       // binary preview frames received this generation
  stepsSincePreview: 0,   // progress steps without a preview frame
  pendingFinalImage: null,   // image info to fetch+show when done fires
  pendingFinalLocked: false, // true once a final:true image has been identified
  lastActivityTime: 0,       // timestamp of last execution event (for timeout detection)
  executedNodes: [],         // list of executed node titles for debugging
  // Reference image
  workflows: [],
  currentWorkflow: null,
  appliedDefaultNegativePrompt: '',
  uploadedImageName: null,
  uploadPending: false,
  // Current displayed image (for download)
  currentImageSrc: null,
  currentImageFilename: null,
}

// â”€â”€ Image zoom / pan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Exposed so resetViewer() can reset the view.
let resetImageView = () => {}

function initImageInteraction() {
  const wrap = el('image-wrap')
  const img  = el('result-img')

  let zoom = 1, panX = 0, panY = 0
  let dragging = false, lastMouse = { x: 0, y: 0 }

  // Returns the scale that fits the image inside the container at native resolution.
  // The image has no CSS size constraints, so this replaces max-width/max-height.
  function computeFitZoom() {
    if (!img.naturalWidth || !img.naturalHeight) return 1
    return Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight)
  }

  function apply() {
    img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
  }

  function updateCursor() {
    if (dragging)                        { wrap.style.cursor = 'grabbing'; return }
    if (zoom > computeFitZoom() * 1.01)  { wrap.style.cursor = 'grab';     return }
    wrap.style.cursor = ''
  }

  // Zoom toward the cursor position.
  // Formula derivation: for centered img, containerCenter = transformOrigin.
  //   rendered point: screen = origin + P*zoom + pan
  //   keep P under cursor fixed → newPan = m*(1-ratio) + pan*ratio
  function zoomAt(clientX, clientY, factor) {
    const rect    = wrap.getBoundingClientRect()
    const mx      = clientX - (rect.left + rect.width  / 2)
    const my      = clientY - (rect.top  + rect.height / 2)
    const minZoom = computeFitZoom() * 0.8  // allow slight zoom-out below fit
    const newZoom = Math.min(Math.max(zoom * factor, minZoom), 12)
    const ratio   = newZoom / zoom
    panX  = mx * (1 - ratio) + panX * ratio
    panY  = my * (1 - ratio) + panY * ratio
    zoom  = newZoom
    apply()
    updateCursor()
  }

  // Expose reset for use in showImage() and resetViewer()
  resetImageView = () => {
    zoom = computeFitZoom(); panX = 0; panY = 0
    apply()
    wrap.style.cursor = ''
  }

  // â”€â”€ Wheel: zoom at cursor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // On macOS, trackpad pinch fires as wheel with ctrlKey=true and deltaY â‰ˆ Â±1â€“10.
  // Regular mouse wheel has deltaY â‰ˆ Â±100 per notch.
  // We use a steeper base for pinch so a short gesture gives meaningful zoom.
  //   Pinch  (ctrlKey): Math.pow(0.975, Î”y) â†' ~7% per unit  â†' natural on trackpad
  //   Wheel  (normal) : Math.pow(0.999, Î”y) â†' ~10% per notch â†' unchanged
  wrap.addEventListener('wheel', e => {
    if (img.classList.contains('hidden')) return
    e.preventDefault()
    const factor = e.ctrlKey
      ? Math.pow(0.975, e.deltaY)   // trackpad pinch â€” high sensitivity
      : Math.pow(0.999, e.deltaY)   // mouse wheel   â€” standard sensitivity
    zoomAt(e.clientX, e.clientY, factor)
  }, { passive: false })

  // â”€â”€ Left-click drag: pan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Double-click / double-tap: reset view â”€â”€â”€â”€â”€â”€â”€â”€â”€
  wrap.addEventListener('dblclick', resetImageView)

  // â”€â”€ Touch: pinch-zoom + single-finger pan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      dragging = zoom > computeFitZoom() * 1.01
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

// â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function init() {
  // Verificar sesión antes de cargar nada
  const ok = await checkAuth()
  if (!ok) return

  await loadConfig()
  await loadWorkflows()
  initImageInteraction()

  el('generate-btn').addEventListener('click', generate)
  el('stop-btn').addEventListener('click', stopGeneration)
  el('download-btn').addEventListener('click', downloadImage)
  el('fullscreen-btn').addEventListener('click', () => setFullscreen(true))
  el('fullscreen-close-btn').addEventListener('click', () => setFullscreen(false))
  el('fullscreen-download-btn').addEventListener('click', downloadImage)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') setFullscreen(false)
  })
  el('seed-random-btn').addEventListener('click', () => { el('seed-input').value = '' })
  el('prompt').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate()
  })

  // Auth buttons
  el('logout-btn').addEventListener('click', logout)
  const usersBtn = el('users-btn')
  if (usersBtn) usersBtn.addEventListener('click', openUsersModal)

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

  // LoRA strength slider — live label update
  el('lora-strength').addEventListener('input', () => {
    el('lora-strength-value').textContent = parseFloat(el('lora-strength').value).toFixed(2)
  })
  el('upscaler-grain').addEventListener('input', () => {
    el('upscaler-grain-value').textContent = parseFloat(el('upscaler-grain').value).toFixed(3)
  })
  el('upscaler-final-grain').addEventListener('input', () => {
    el('upscaler-final-grain-value').textContent = parseFloat(el('upscaler-final-grain').value).toFixed(3)
  })
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

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function loadConfig() {
  try {
    const res = await apiFetch('/api/config')
    const data = await res.json()
    el('comfy-url').value        = data.comfyUrl      || ''
    el('comfy-dir').value        = data.comfyDir      || ''
    el('comfy-start-cmd').value  = data.comfyStartCmd || ''
    el('api-token').value        = data.apiToken      || ''
    setToken(data.apiToken || '')    // inicializar localStorage con el token del servidor
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
    const res = await apiFetch('/api/config', {
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
    setToken(data.apiToken)
    flashSettingsStatus('Guardado')
  } catch {
    flashSettingsStatus('Error al guardar', true)
  }
}

async function autoDetect() {
  const btn = el('detect-btn')
  btn.disabled = true
  btn.textContent = '...'
  try {
    const res  = await apiFetch('/api/detect')
    const data = await res.json()
    if (!res.ok) {
      flashSettingsStatus(`Error: ${data.error}`, true)
      return
    }
    el('comfy-url').value       = data.comfyUrl
    el('comfy-dir').value       = data.comfyDir
    el('comfy-start-cmd').value = data.comfyStartCmd
    const msg = data.hint
      ? `Aviso: ${data.hint}`
      : 'Detectado - pulsa Guardar para confirmar'
    flashSettingsStatus(msg, !!data.hint)
  } catch (err) {
    flashSettingsStatus(`Error: ${err.message}`, true)
  } finally {
    btn.disabled = false
    btn.textContent = 'Auto-detectar'
  }
}

async function launchComfyUI() {
  const btn = el('launch-btn')
  btn.disabled = true
  flashSettingsStatus('Iniciando ComfyUI...')

  try {
    const res  = await apiFetch('/api/launch', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      flashSettingsStatus(`Error: ${data.error}`, true)
    } else {
      flashSettingsStatus('ComfyUI arrancando - espera unos segundos')
    }
  } catch (err) {
    flashSettingsStatus(`Error: ${err.message}`, true)
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

// â”€â”€ Workflows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function loadWorkflows() {
  try {
    const res = await apiFetch('/api/workflows')
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
    if (state.workflows.some(w => w.id === 'seedvr_upscaler')) {
      select.value = 'seedvr_upscaler'
    }

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

  const promptRequired = state.currentWorkflow?.promptRequired !== false
  el('prompt-field').classList.toggle('hidden', !promptRequired)
  el('negative-prompt-field').classList.toggle('hidden', !promptRequired)
  if (!promptRequired) {
    el('prompt').value = ''
    el('negative-prompt').value = ''
    state.appliedDefaultNegativePrompt = ''
  } else {
    const defaultNegative = state.currentWorkflow?.defaultNegativePrompt || ''
    const negativeInput = el('negative-prompt')
    if (defaultNegative && (!negativeInput.value.trim() || negativeInput.value === state.appliedDefaultNegativePrompt)) {
      negativeInput.value = defaultNegative
      state.appliedDefaultNegativePrompt = defaultNegative
    } else if (!defaultNegative && negativeInput.value === state.appliedDefaultNegativePrompt) {
      negativeInput.value = ''
      state.appliedDefaultNegativePrompt = ''
    }
  }
  updateActionCopy()

  const refField = el('ref-image-field')
  if (state.currentWorkflow?.hasImageInput) {
    el('ref-image-label').textContent =
      state.currentWorkflow.imageInputLabel || 'Imagen de referencia'
    refField.classList.remove('hidden')
  } else {
    refField.classList.add('hidden')
  }

  const modelField = el('model-field')
  if (state.currentWorkflow?.hasModelControl) {
    modelField.classList.remove('hidden')
    initModelControl(state.currentWorkflow.modelControl)
  } else {
    modelField.classList.add('hidden')
  }

  const loraField = el('lora-field')
  if (state.currentWorkflow?.hasLora) {
    loraField.classList.remove('hidden')
    loadLoras()
  } else {
    loraField.classList.add('hidden')
  }

  const powerLoraField = el('power-lora-field')
  if (state.currentWorkflow?.hasPowerLora && state.currentWorkflow?.powerLoras?.length) {
    powerLoraField.classList.remove('hidden')
    renderPowerLoras(state.currentWorkflow.powerLoras)
  } else {
    powerLoraField.classList.add('hidden')
  }

  const resolutionField = el('resolution-field')
  if (state.currentWorkflow?.hasResolutionControl) {
    resolutionField.classList.remove('hidden')
    initResolutionControls(
      state.currentWorkflow.defaultMegapixel,
      state.currentWorkflow.defaultAspectRatio,
    )
  } else {
    resolutionField.classList.add('hidden')
  }

  const upscalerField = el('upscaler-field')
  if (state.currentWorkflow?.hasUpscalerControls) {
    upscalerField.classList.remove('hidden')
    initUpscalerControls(state.currentWorkflow.upscalerControls)
  } else {
    upscalerField.classList.add('hidden')
  }

  const samplerStepsField = el('sampler-steps-field')
  if (state.currentWorkflow?.hasSamplerStepsControl) {
    samplerStepsField.classList.remove('hidden')
    initSamplerStepsControl(state.currentWorkflow.samplerStepsControl)
  } else {
    samplerStepsField.classList.add('hidden')
  }
}

function getActionLabel() {
  return state.currentWorkflow?.promptRequired === false ? 'Escalar' : 'Generar'
}

function updateActionCopy() {
  if (!state.generating) el('btn-label').textContent = getActionLabel()
}

function initModelControl(control = {}) {
  const select = el('model-select')
  const options = Array.isArray(control.options) ? control.options : []
  el('model-label').textContent = control.label || 'Modelo base'

  select.innerHTML = options.length
    ? options.map(name => {
        const selected = name === control.defaultModel ? ' selected' : ''
        return `<option value="${escAttr(name)}"${selected}>${escHtml(name)}</option>`
      }).join('')
    : '<option value="">Sin modelos compatibles</option>'

  if (control.defaultModel && options.includes(control.defaultModel)) {
    select.value = control.defaultModel
  }
}

function initUpscalerControls(controls = {}) {
  const resolution = Number(controls.defaultResolution) || 2560
  const maxResolution = Number(controls.maxResolution) || 4096
  const grain = Number(controls.defaultGrainIntensity ?? 0.01)
  const finalGrain = Number(controls.defaultFinalGrainIntensity ?? 0.015)

  const resolutionInput = el('upscaler-resolution')
  resolutionInput.max = maxResolution
  resolutionInput.value = resolution

  const grainInput = el('upscaler-grain')
  grainInput.value = grain
  el('upscaler-grain-value').textContent = grain.toFixed(3)

  const finalGrainInput = el('upscaler-final-grain')
  finalGrainInput.value = finalGrain
  el('upscaler-final-grain-value').textContent = finalGrain.toFixed(3)
}

function initSamplerStepsControl(control = {}) {
  const steps = Number(control.defaultSteps) || 8
  const min = Number(control.min) || 1
  const max = Number(control.max) || 50

  const input = el('sampler-steps')
  input.min = min
  input.max = max
  input.value = steps
  el('sampler-steps-value').textContent = steps

  // Update value display on change
  if (!input._stepsListener) {
    input._stepsListener = () => {
      el('sampler-steps-value').textContent = input.value
    }
    input.addEventListener('input', input._stepsListener)
  }
}

function renderPowerLoras(loras) {
  const list = el('power-lora-list')
  list.innerHTML = loras.map(lora => {
    const shortName = lora.name.replace(/\.safetensors$/i, '')
    return `
      <div class="power-lora-item" data-key="${lora.key}">
        <label class="power-lora-toggle">
          <input type="checkbox" class="power-lora-on"${lora.on ? ' checked' : ''} />
          <span class="power-lora-name" title="${lora.name}">${shortName}</span>
        </label>
        <div class="power-lora-strength-row">
          <input type="range" class="power-lora-strength" min="0" max="2" step="0.05"
            value="${lora.strength}" />
          <span class="power-lora-strength-num">${lora.strength.toFixed(2)}</span>
        </div>
      </div>
    `
  }).join('')

  list.querySelectorAll('.power-lora-item').forEach(item => {
    const slider = item.querySelector('.power-lora-strength')
    const num    = item.querySelector('.power-lora-strength-num')
    slider.addEventListener('input', () => {
      num.textContent = parseFloat(slider.value).toFixed(2)
    })
  })
}

// ── Resolution controls ────────────────────────────────────────────────────
// Options are fetched live from ComfyUI's object_info so they always match
// the exact combo values of the installed FluxResolutionNode version.

async function initResolutionControls(defaultMegapixel, defaultAspectRatio) {
  const mpSel = el('megapixel-select')
  const arSel = el('aspect-ratio-select')
  mpSel.innerHTML = '<option value="">Cargando…</option>'
  arSel.innerHTML = '<option value="">Cargando…</option>'

  try {
    const res = await apiFetch('/api/resolution-options')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { megapixels = [], aspectRatios = [] } = await res.json()

    mpSel.innerHTML = megapixels
      .map(v => `<option value="${v}"${v === defaultMegapixel ? ' selected' : ''}>${v} MP</option>`)
      .join('') || '<option value="">Sin opciones</option>'

    arSel.innerHTML = aspectRatios
      .map(v => `<option value="${v}"${v === defaultAspectRatio ? ' selected' : ''}>${v}</option>`)
      .join('') || '<option value="">Sin opciones</option>'
  } catch (err) {
    mpSel.innerHTML = '<option value="">Error</option>'
    arSel.innerHTML = `<option value="">Error: ${err.message}</option>`
  }
}

async function loadLoras() {
  const select = el('lora-select')
  select.innerHTML = '<option value="">Cargando…</option>'
  try {
    const res = await apiFetch('/api/loras')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const loras = await res.json()
    if (!Array.isArray(loras) || loras.length === 0) {
      select.innerHTML = '<option value="">No hay LoRAs disponibles</option>'
      return
    }
    select.innerHTML =
      '<option value="">Sin LoRA</option>' +
      loras.map(name => `<option value="${name}">${name}</option>`).join('')
  } catch (err) {
    select.innerHTML = `<option value="">Error: ${err.message}</option>`
  }
}

// â”€â”€ Reference image upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  setRefStatus('Subiendo...', '')
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
    const res = await apiFetch('/api/upload', { method: 'POST', body: formData })
    const data = await res.json()

    if (!res.ok || data.error) {
      setRefStatus(`Error: ${data.error || 'Error al subir'}`, 'err')
      state.uploadPending = false
      return
    }

    state.uploadedImageName = data.name
    setRefStatus('Lista', 'ok')
  } catch (err) {
    setRefStatus(`Error: ${err.message}`, 'err')
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

// â”€â”€ Generate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function generate() {
  if (state.generating) return

  const workflow = el('workflow-select').value
  const prompt = el('prompt').value.trim()
  const negativePrompt = el('negative-prompt').value.trim()
  const promptRequired = state.currentWorkflow?.promptRequired !== false

  if (!workflow) return showStatus('Selecciona un workflow primero.', 'error')
  if (promptRequired && !prompt) return showStatus('Escribe un prompt antes de generar.', 'error')

  // Check if reference image is required and ready
  if (state.currentWorkflow?.hasImageInput) {
    if (state.uploadPending) return showStatus('Espera a que termine la subida de la imagen.', 'error')
    if (!state.uploadedImageName) {
      return showStatus(promptRequired ? 'Este workflow necesita una imagen de referencia.' : 'Sube una imagen para escalarla.', 'error')
    }
  }

  state.previewFrames = 0
  state.stepsSincePreview = 0
  state.pendingFinalImage = null
  state.pendingFinalLocked = false
  state.executedNodes = []
  state.lastActivityTime = Date.now()
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
  setNode('Enviando a ComfyUI...')
  setStep(0, 0)

  try {
    const seedVal = el('seed-input').value.trim()
    const parsedSeed = seedVal !== '' ? parseInt(seedVal, 10) : null
    const body = { workflow }
    if (promptRequired || prompt) body.prompt = prompt
    if (promptRequired || negativePrompt) body.negativePrompt = negativePrompt
    if (parsedSeed !== null && !isNaN(parsedSeed)) body.seed = parsedSeed
    if (state.uploadedImageName) body.referenceImageName = state.uploadedImageName
    if (state.currentWorkflow?.hasModelControl) {
      const selectedModel = el('model-select').value
      if (selectedModel) body.baseModel = selectedModel
    }
    if (state.currentWorkflow?.hasLora) {
      const loraName = el('lora-select').value
      const loraStrength = parseFloat(el('lora-strength').value) || 1.0
      if (loraName) { body.loraName = loraName; body.loraStrength = loraStrength }
    }

    if (state.currentWorkflow?.hasPowerLora) {
      const items = el('power-lora-list').querySelectorAll('.power-lora-item')
      if (items.length > 0) {
        body.powerLoraUpdates = Array.from(items).map(item => ({
          key:      item.dataset.key,
          on:       item.querySelector('.power-lora-on').checked,
          strength: parseFloat(item.querySelector('.power-lora-strength').value),
        }))
      }
    }

    if (state.currentWorkflow?.hasResolutionControl) {
      const mp = el('megapixel-select').value
      const ar = el('aspect-ratio-select').value
      if (mp) body.megapixel  = mp
      if (ar) body.aspectRatio = ar
    }

    if (state.currentWorkflow?.hasUpscalerControls) {
      const upscalerResolution = parseInt(el('upscaler-resolution').value, 10)
      const grainIntensity = parseFloat(el('upscaler-grain').value)
      const finalGrainIntensity = parseFloat(el('upscaler-final-grain').value)
      if (!isNaN(upscalerResolution)) body.upscalerResolution = upscalerResolution
      if (!isNaN(grainIntensity)) body.grainIntensity = grainIntensity
      if (!isNaN(finalGrainIntensity)) body.finalGrainIntensity = finalGrainIntensity
    }

    if (state.currentWorkflow?.hasSamplerStepsControl) {
      const steps = parseInt(el('sampler-steps').value, 10)
      if (!isNaN(steps)) body.samplerSteps = steps
    }

    const res = await apiFetch('/api/generate', {
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

    if (data.seed != null) el('seed-input').value = data.seed
    connectSSE(data.promptId)
  } catch (err) {
    setGenerating(false)
    showProgressPanel(false)
    showStatus(`Error de red: ${err.message}`, 'error')
  }
}

// â”€â”€ SSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function connectSSE(promptId) {
  if (state.eventSource) state.eventSource.close()

  // EventSource no soporta headers personalizados — pasamos el token como query param
  const token = getSessionToken() || getToken()
  const sseUrl = token
    ? `/api/progress/${promptId}?token=${encodeURIComponent(token)}`
    : `/api/progress/${promptId}`
  const es = new EventSource(sseUrl)
  state.eventSource = es

  es.onmessage = e => {
    try { handleEvent(JSON.parse(e.data)) } catch {}
  }

  // Timeout detection — if no activity for 5 min during generation, warn the user
  const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000
  state.lastActivityTime = Date.now()
  const timeoutCheck = setInterval(() => {
    if (!state.generating) { clearInterval(timeoutCheck); return }
    const elapsed = Date.now() - state.lastActivityTime
    if (elapsed > EXECUTION_TIMEOUT_MS && state.executedNodes.length > 0) {
      console.warn(`[bzComfy] Execution stalled after ${Math.round(elapsed/1000)}s. Last executed nodes:`, state.executedNodes.slice(-5))
      showStatus('⏱ La ejecución se detuvo sin respuesta de ComfyUI. Revisa los logs del servidor para más detalles.', 'error')
    }
  }, 30000) // check every 30s

  es.onerror = () => {
    clearInterval(timeoutCheck)
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
      state.lastActivityTime = Date.now()
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
      state.lastActivityTime = Date.now()
      state.executedNodes.push(data.title || data.node)
      console.log(`[bzComfy] Executing: ${data.title || data.node} (${state.executedNodes.length} nodes so far)`)
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
      state.lastActivityTime = Date.now()
      console.log(`[bzComfy] Image received: ${data.final ? 'FINAL' : 'intermediate'} (${data.images.length} image(s))`)
      const img = data.images[0]
      // Track which image to show when done fires.
      // Once a final:true image is identified, ignore all later events.
      if (!state.pendingFinalLocked) {
        state.pendingFinalImage = img
        if (data.final) state.pendingFinalLocked = true
      }
      // Show intermediate images immediately for live feedback, but only
      // while we haven't yet identified the definitive final image.
      // This prevents the compare node (runs after final save) from showing.
      if (!state.pendingFinalLocked) {
        const url =
          `/api/image?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder || '')}` +
          `&type=${encodeURIComponent(img.type || 'output')}`
        apiFetch(url)
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob() })
          .then(blob => showImage(URL.createObjectURL(blob), false, img.filename))
          .catch(err => showStatus(`Error cargando imagen: ${err.message}`, 'error'))
      }
      break
    }

    case 'done':
      console.log(`[bzComfy] DONE. Executed ${state.executedNodes.length} nodes total.`)
      state.lastActivityTime = Date.now()
      // Fetch the definitive final image exactly once — no race conditions.
      if (state.pendingFinalImage) {
        const img = state.pendingFinalImage
        const url =
          `/api/image?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder || '')}` +
          `&type=${encodeURIComponent(img.type || 'output')}`
        apiFetch(url)
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob() })
          .then(blob => showImage(URL.createObjectURL(blob), false, img.filename))
          .catch(err => showStatus(`Error cargando imagen final: ${err.message}`, 'error'))
      }
      finishGeneration()
      break

    case 'error':
      console.error(`[bzComfy] ERROR: ${data.message || 'Unknown'}. Executed nodes so far:`, state.executedNodes.slice(-5))
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
    el('stream-float').classList.add('hidden')
  }, 1200)

  if (state.eventSource) { state.eventSource.close(); state.eventSource = null }
}

// â”€â”€ UI helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function stopGeneration() {
  const btn = el('stop-btn')
  btn.textContent = 'Parando...'
  btn.disabled = true
  try {
    await apiFetch('/api/stop', { method: 'POST' })
  } finally {
    btn.textContent = 'Parar'
    btn.disabled = false
  }
}

function setGenerating(value) {
  state.generating = value
  state.hasProgress = false
  const btn = el('generate-btn')
  const label = getActionLabel()
  btn.disabled = value
  el('btn-label').textContent = value ? (label === 'Escalar' ? 'Escalando...' : 'Generando...') : label
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
  el('stream-float').classList.add('hidden')
  el('stream-float-img').src = ''
  state.currentImageSrc = null
  state.currentImageFilename = null
  resetImageView()
}

function setFullscreen(on) {
  el('image-wrap').classList.toggle('fullscreen', on)
  el('fullscreen-bar').classList.toggle('hidden', !on)
  resetImageView()
}

function downloadImage() {
  if (!state.currentImageSrc || !state.currentImageFilename) return
  const a = document.createElement('a')
  a.href = state.currentImageSrc
  a.download = state.currentImageFilename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function showImage(src, isPreview, filename) {
  if (isPreview) {
    // Latent preview → ventana flotante, no toca el visor principal
    el('stream-float-img').src = src
    el('stream-float').classList.remove('hidden')
    return
  }

  // Imagen real → visor principal
  const img = el('result-img')
  const info = el('image-info')
  img.onload = () => {
    img.classList.remove('hidden')
    img.classList.add('fade-in')
    el('placeholder').classList.add('hidden')
    resetImageView()
    if (filename) {
      el('image-filename').textContent = filename
      el('image-dimensions').textContent = `${img.naturalWidth} × ${img.naturalHeight} px`
      info.classList.remove('hidden')
      state.currentImageSrc = src
      state.currentImageFilename = filename
    }
  }
  img.src = src
  el('preview-badge').classList.add('hidden')
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
  el('node-name').textContent = title || '-'
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
