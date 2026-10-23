'use strict'

/*__CORE__*/

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')

const EXTENSION_ID = 'remielle.pet'
const VERSION = '1.0.0'
const PREFIX = 'remielle:'

let ctx = null
let state = null
let config = null
let disposed = false

let mainWin = null
let petWin = null
let settingsWin = null
const selfWindows = new Set()
let mainWindowCleanup = []
let detachWindowsListener = null

let petReady = false
let settingsReady = false
let petErrorLogged = false
let showingBubble = false
let bubbleBusy = false
let bubbleCloseAt = 0
let bubbleTimer = null
let lastPetState = ''
let lastSettingsState = ''
let assetVersion = Date.now()
let assetStatus = { ok: 0, missing: [], resPath: '', copied: [] }

let tickTimer = null
let syncTimer = null
let layoutTimer = null
let mouseTimer = null
let composerTimer = null
let composerQueryDebounce = null
let composerQueryInFlight = false
let composerRect = null
let lastIgnoreState = null
let lastBackgroundReset = 0
let petBackgroundGuard = false
let petRecreateAttempted = false

const runtime = {
  userData: '',
  root: '',
  appDir: '',
  assetsDir: '',
  configPath: '',
  logPath: '',
  preloadPath: '',
  petHtml: '',
  settingsHtml: '',
  installPath: '',
}

let sse = {
  req: null,
  res: null,
  connected: false,
  backoff: 2000,
  reconnectTimer: null,
  lastChunkAt: 0,
}

const pendingSessionFetches = new Map()
const sessionMetaCache = new Map()

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, message, extra) {
  if (level === 'debug' && !(config?.debug || process.env.REMIELLE_PET_DEBUG === '1')) return
  const line =
    `[${new Date().toISOString()}] [${level}] ${message}` +
    (extra === undefined ? '' : ' ' + safeJson(extra))
  try {
    if (runtime.logPath) {
      try {
        const stat = fs.statSync(runtime.logPath)
        if (stat.size > 768 * 1024) {
          fs.renameSync(runtime.logPath, runtime.logPath + '.1')
        }
      } catch {}
      fs.appendFileSync(runtime.logPath, line + '\n', 'utf8')
    }
  } catch {}
  if (level === 'error') console.error('[remielle]', message, extra ?? '')
  else console.log('[remielle]', message, extra ?? '')
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function safe(fn, fallback = undefined) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizeConfig(input) {
  const source = input && typeof input === 'object' ? input : {}
  const pick = (key) => (source[key] === undefined ? DEFAULT_CONFIG[key] : source[key])
  const cfg = {
    enabled: pick('enabled') !== false,
    scale: clamp(pick('scale'), 0.6, 1.8, DEFAULT_CONFIG.scale),
    opacity: clamp(pick('opacity'), 0.25, 1, DEFAULT_CONFIG.opacity),
    marginRight: Math.round(clamp(pick('marginRight'), 0, 240, DEFAULT_CONFIG.marginRight)),
    marginBottom: Math.round(clamp(pick('marginBottom'), 0, 240, DEFAULT_CONFIG.marginBottom)),
    showStatus: pick('showStatus') !== false,
    showBubble: pick('showBubble') !== false,
    showTotal: pick('showTotal') !== false,
    bubbleSeconds: clamp(pick('bubbleSeconds'), 2, 60, DEFAULT_CONFIG.bubbleSeconds),
    expectSeconds: clamp(pick('expectSeconds'), 0.5, 30, DEFAULT_CONFIG.expectSeconds),
    drawHoldMs: Math.round(clamp(pick('drawHoldMs'), 300, 20000, DEFAULT_CONFIG.drawHoldMs)),
    clickAction: ['smug', 'settings', 'none'].includes(pick('clickAction')) ? pick('clickAction') : 'smug',
    continuousCount: Math.round(clamp(pick('continuousCount'), 1, 20, DEFAULT_CONFIG.continuousCount)),
    continuousWindow: Math.round(clamp(pick('continuousWindow'), 1000, 60000, DEFAULT_CONFIG.continuousWindow)),
    fileTools: Array.isArray(pick('fileTools'))
      ? pick('fileTools')
          .map((tool) => String(tool).trim())
          .filter(Boolean)
          .slice(0, 48)
      : [...DEFAULT_FILE_TOOLS],
    resPath: typeof pick('resPath') === 'string' ? pick('resPath').slice(0, 2048) : '',
    subagentBubbles: pick('subagentBubbles') === true,
    debug: pick('debug') === true,
  }
  if (cfg.fileTools.length === 0) cfg.fileTools = [...DEFAULT_FILE_TOOLS]
  return cfg
}

function initRuntime() {
  runtime.userData = app.getPath('userData')
  runtime.root = path.join(runtime.userData, 'remielle-pet')
  runtime.appDir = path.join(runtime.root, 'app')
  runtime.assetsDir = path.join(runtime.root, 'assets')
  runtime.configPath = path.join(runtime.root, 'config.json')
  runtime.logPath = path.join(runtime.root, 'remielle.log')
  runtime.preloadPath = path.join(runtime.root, 'preload.js')
  runtime.petHtml = path.join(runtime.appDir, 'pet.html')
  runtime.settingsHtml = path.join(runtime.appDir, 'settings.html')
  runtime.installPath = path.join(runtime.root, 'install.json')
  for (const dir of [runtime.root, runtime.appDir, runtime.assetsDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {}
  }
}

function loadConfig() {
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(runtime.configPath, 'utf8'))
  } catch {}
  return sanitizeConfig({ ...DEFAULT_CONFIG, ...stored })
}

function saveConfig() {
  try {
    const tmp = runtime.configPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
    try {
      fs.renameSync(tmp, runtime.configPath)
    } catch {
      fs.copyFileSync(tmp, runtime.configPath)
      try {
        fs.unlinkSync(tmp)
      } catch {}
    }
  } catch (error) {
    log('error', 'failed to save config', { error: String(error) })
  }
}

function publicConfig() {
  return {
    ...config,
    version: VERSION,
    assets: { ...ASSET_FILES },
    assetVersion,
    assetStatus,
    runtime: {
      root: runtime.root,
      appDir: runtime.appDir,
      assetsDir: runtime.assetsDir,
      logPath: runtime.logPath,
      configPath: runtime.configPath,
    },
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

function readInstallInfo() {
  try {
    return JSON.parse(fs.readFileSync(runtime.installPath, 'utf8'))
  } catch {
    return {}
  }
}

function resolveResPath() {
  const install = readInstallInfo()
  const candidates = []
  if (config.resPath) candidates.push(config.resPath)
  if (install.resPath) candidates.push(install.resPath)
  if (install.projectDir) candidates.push(path.join(install.projectDir, 'res'))
  if (process.env.REMIELLE_RES) candidates.push(process.env.REMIELLE_RES)
  candidates.push(path.join(runtime.root, 'res'))
  candidates.push(path.join(process.cwd(), 'res'))

  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue
    let resolved
    try {
      resolved = path.resolve(candidate)
    } catch {
      continue
    }
    const key = resolved.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!safe(() => fs.statSync(resolved).isDirectory(), false)) continue
    const names = safe(() => fs.readdirSync(resolved), [])
    const lower = new Set(names.map((name) => name.toLowerCase()))
    const hasAny = Object.values(ASSET_ALIASES).some((aliases) =>
      aliases.some((alias) => lower.has(alias.toLowerCase())),
    )
    if (hasAny) return resolved
  }
  return candidates.find((candidate) => candidate && safe(() => fs.statSync(candidate).isDirectory(), false)) || ''
}

function resolveAssetSource(resPath, aliases) {
  if (!resPath) return null
  const names = safe(() => fs.readdirSync(resPath), [])
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]))
  for (const alias of aliases) {
    const hit = byLower.get(alias.toLowerCase())
    if (hit) return path.join(resPath, hit)
  }
  return null
}

function syncAssets({ force = false } = {}) {
  const resPath = resolveResPath()
  const status = { ok: 0, missing: [], resPath, copied: [] }
  if (!fs.existsSync(runtime.assetsDir)) {
    safe(() => fs.mkdirSync(runtime.assetsDir, { recursive: true }))
  }

  for (const [key, file] of Object.entries(ASSET_FILES)) {
    const dest = path.join(runtime.assetsDir, file)
    const aliases = ASSET_ALIASES[key] || [file]
    const src = resolveAssetSource(resPath, aliases)
    const destExists = fs.existsSync(dest)

    if (src) {
      const samePath = path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()
      if (!samePath) {
        let shouldCopy = force || !destExists
        if (!shouldCopy) {
          try {
            const s = fs.statSync(src)
            const d = fs.statSync(dest)
            shouldCopy = s.size !== d.size || s.mtimeMs > d.mtimeMs + 1000
          } catch {
            shouldCopy = true
          }
        }
        if (shouldCopy) {
          try {
            fs.copyFileSync(src, dest)
            status.copied.push(file)
          } catch (error) {
            log('error', 'failed to copy asset', { src, dest, error: String(error) })
          }
        }
      }
      if (fs.existsSync(dest)) status.ok += 1
      else status.missing.push(key)
    } else if (destExists) {
      status.ok += 1
    } else {
      status.missing.push(key)
    }
  }

  if (status.copied.length > 0 || force) assetVersion = Date.now()
  assetStatus = status
  if (status.missing.length > 0) {
    log('warn', 'some animations are missing', { resPath, missing: status.missing })
  } else {
    log('info', 'assets ready', { resPath, copied: status.copied.length })
  }
  if (resPath && resPath !== config.resPath) {
    // Only auto-adopt a detected folder when the configured one is missing.
    // Never overwrite a folder the user explicitly picked.
    const currentExists = config.resPath && safe(() => fs.statSync(config.resPath).isDirectory(), false)
    if (!currentExists) {
      config.resPath = resPath
      saveConfig()
    }
  }
  return status
}

// ---------------------------------------------------------------------------
// PetState / SSE
// ---------------------------------------------------------------------------

function getEndpoint() {
  return safe(() => ctx?.serverEndpoints?.get?.('sidecar'), null) || null
}

function requestOptionsFor(url, headers) {
  const options = { headers }
  if (url.protocol === 'https:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    options.rejectUnauthorized = false
  }
  return options
}

function apiGet(pathname, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const endpoint = getEndpoint()
    if (!endpoint?.url) {
      reject(new Error('OpenCode server is not ready'))
      return
    }
    let url
    try {
      url = new URL(pathname, endpoint.url)
    } catch (error) {
      reject(error)
      return
    }
    const lib = url.protocol === 'https:' ? https : http
    const headers = { ...(endpoint.headers || {}), accept: 'application/json' }
    const req = lib.get(url, requestOptionsFor(url, headers), (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        try {
          const json = JSON.parse(body)
          resolve(json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json)
        } catch (error) {
          reject(error)
        }
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
  })
}

function fetchSession(sessionID) {
  if (!sessionID) return Promise.resolve(null)
  return apiGet(`/api/session/${encodeURIComponent(sessionID)}`).catch((error) => {
    log('warn', 'session fetch failed', { sessionID, error: String(error.message || error) })
    return null
  })
}

function rememberSession(sessionID, promise) {
  if (!sessionID) return
  pendingSessionFetches.set(sessionID, promise)
  promise.finally(() => {
    if (pendingSessionFetches.get(sessionID) === promise) pendingSessionFetches.delete(sessionID)
  })
}

function refreshSession(sessionID, { baseline = false } = {}) {
  const promise = fetchSession(sessionID)
    .then((info) => {
      if (!info || disposed) return null
      try {
        if (baseline && state) {
          const session = state.sessions.get(sessionID)
          if (session && session.running && !session.baseline) {
            state.setBaseline(sessionID, { cost: info.cost, tokens: info.tokens })
          }
        }
        if (state) state.setSessionMeta(sessionID, info)
        sessionMetaCache.set(sessionID, { info, at: Date.now() })
      } catch (error) {
        log('warn', 'session meta update failed', { sessionID, error: String(error) })
      }
      return info
    })
    .catch((error) => {
      log('warn', 'session refresh failed', { sessionID, error: String(error?.message || error) })
      return null
    })
  rememberSession(sessionID, promise)
  return promise
}

async function syncActiveSessions() {
  try {
    const data = await apiGet('/api/session/active')
    if (!data || disposed) return
    const ids = Object.keys(data)
    state.syncActive(ids)
    for (const id of ids) refreshSession(id)
    log('debug', 'active sessions synced', { count: ids.length })
  } catch (error) {
    log('warn', 'active session sync failed', { error: String(error.message || error) })
  }
}

function scheduleReconnect() {
  if (disposed || sse.reconnectTimer) return
  const delay = Math.min(15000, Math.max(1000, sse.backoff))
  sse.backoff = Math.min(15000, sse.backoff * 1.6)
  sse.reconnectTimer = setTimeout(() => {
    sse.reconnectTimer = null
    connectSSE()
  }, delay)
}

function disconnectSSE(reason) {
  if (sse.req) {
    try {
      sse.req.destroy()
    } catch {}
    sse.req = null
  }
  sse.res = null
  if (sse.connected) {
    sse.connected = false
    if (state) state.setConnected(false)
    log('warn', 'SSE disconnected', { reason })
  }
  if (!disposed) scheduleReconnect()
}

function connectSSE() {
  if (disposed) return
  const endpoint = getEndpoint()
  if (!endpoint?.url) {
    scheduleReconnect()
    return
  }
  let url
  try {
    url = new URL('/api/event', endpoint.url)
  } catch {
    scheduleReconnect()
    return
  }
  const lib = url.protocol === 'https:' ? https : http
  const headers = {
    ...(endpoint.headers || {}),
    accept: 'text/event-stream',
    'cache-control': 'no-cache',
  }
  log('info', 'connecting to OpenCode events', { url: url.origin })
  const req = lib.get(url, requestOptionsFor(url, headers), (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      log('warn', 'event stream rejected', { status: res.statusCode })
      disconnectSSE(`HTTP ${res.statusCode}`)
      return
    }
    sse.res = res
    sse.connected = true
    sse.backoff = 2000
    sse.lastChunkAt = Date.now()
    state.setConnected(true)
    log('info', 'event stream connected')

    const push = createSSEParser(onServerEvent)
    res.on('data', (chunk) => {
      sse.lastChunkAt = Date.now()
      try {
        push(chunk)
      } catch (error) {
        log('error', 'SSE parser failed', { error: String(error) })
      }
    })
    res.on('end', () => disconnectSSE('end'))
    res.on('close', () => disconnectSSE('close'))
    res.on('error', (error) => disconnectSSE(String(error.message || error)))
    syncActiveSessions()
  })
  req.setTimeout(0)
  req.on('error', (error) => disconnectSSE(String(error.message || error)))
  sse.req = req
}

function onServerEvent(event) {
  if (disposed || !event || !event.type) return
  const type = event.type
  const data = event.data || {}
  const sessionID = data.sessionID

  try {
    state.handle(event)
  } catch (error) {
    log('error', 'state handler failed', { type, error: String(error) })
  }

  if (sessionID) {
    if (type === 'session.execution.started') {
      refreshSession(sessionID, { baseline: true })
    } else if (
      type === 'session.execution.succeeded' ||
      type === 'session.execution.failed' ||
      type === 'session.execution.interrupted'
    ) {
      refreshSession(sessionID)
    } else if (type === 'session.step.started') {
      const cached = sessionMetaCache.get(sessionID)
      if (!cached || Date.now() - cached.at > 15000) refreshSession(sessionID)
    }
  }

  if (!['session.reasoning.delta', 'session.text.delta', 'session.message.content.updated'].includes(type)) {
    log('debug', 'event', { type, sessionID: sessionID || undefined })
  }

  sendState(false)
  pumpBubbles()
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function isSelfWindow(win) {
  return !win || selfWindows.has(win) || win === petWin || win === settingsWin
}

function isLikelyMainWindow(win) {
  if (!win || win.isDestroyed() || isSelfWindow(win)) return false
  const parent = safe(() => win.getParentWindow(), null)
  if (parent) return false
  const url = safe(() => win.webContents.getURL(), '') || ''
  if (url.startsWith('devtools://') || url.startsWith('chrome-devtools://')) return false
  const bounds = safe(() => win.getBounds(), null)
  if (!bounds) return false
  return bounds.width >= 480 && bounds.height >= 360
}

function findMainWindow() {
  const list = safe(() => ctx?.windows?.list?.(), []) || []
  const candidates = list.filter((win) => isLikelyMainWindow(win))
  const visible = candidates.find((win) => safe(() => win.isVisible(), false))
  return visible || candidates[0] || null
}

function clearMainWindowListeners() {
  for (const cleanup of mainWindowCleanup.splice(0)) {
    try {
      cleanup()
    } catch {}
  }
}

function attachMainWindow(win) {
  try {
    attachMainWindowUnsafe(win)
  } catch (error) {
    log('error', 'failed to attach main window', { error: String(error) })
  }
}

function attachMainWindowUnsafe(win) {
  if (!win || win.isDestroyed() || isSelfWindow(win)) return
  if (!isLikelyMainWindow(win)) return
  if (mainWin === win && petWin && !petWin.isDestroyed()) {
    layoutPet()
    return
  }
  clearMainWindowListeners()
  const changedWindow = mainWin !== win
  mainWin = win
  if (changedWindow) {
    composerRect = null
    destroyPetWindow()
  }

  const listen = (event, handler) => {
    win.on(event, handler)
    mainWindowCleanup.push(() => win.removeListener(event, handler))
  }
  const relayout = () => {
    layoutPet()
    scheduleComposerQuery()
  }
  for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen']) {
    listen(event, relayout)
  }
  listen('focus', () => {
    syncPetTop()
    layoutPet()
  })
  listen('blur', () => {
    syncPetTop()
  })
  listen('minimize', () => {
    if (petWin && !petWin.isDestroyed()) petWin.hide()
  })
  listen('closed', () => {
    clearMainWindowListeners()
    if (mainWin === win) mainWin = null
    destroyPetWindow()
    setTimeout(() => {
      const next = findMainWindow()
      if (next) attachMainWindow(next)
    }, 250)
  })

  createPetWindow()
  layoutPet()
  setTimeout(() => {
    if (!disposed) queryComposer()
  }, 450)
  log('info', 'main window attached', { title: safe(() => win.getTitle(), '') })
}

function createPetWindow() {
  if (!mainWin || mainWin.isDestroyed() || disposed) return
  if (petWin && !petWin.isDestroyed()) return
  if (!fs.existsSync(runtime.petHtml)) {
    if (!petErrorLogged) log('error', 'pet.html is missing; run scripts/install.mjs again', { path: runtime.petHtml })
    petErrorLogged = true
    return
  }
  if (!fs.existsSync(runtime.preloadPath)) {
    if (!petErrorLogged) log('error', 'preload.js is missing; run scripts/install.mjs again', { path: runtime.preloadPath })
    petErrorLogged = true
    return
  }
  petErrorLogged = false

  const initialSize = petWindowSize()
  let width = initialSize.width
  let height = initialSize.height
  try {
    petWin = new BrowserWindow({
      width,
      height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      show: false,
      title: 'Remielle',
      webPreferences: {
        preload: runtime.preloadPath,
        partition: 'remielle-pet',
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: config.debug || process.env.REMIELLE_PET_DEV === '1',
      },
    })
  } catch (error) {
    log('error', 'failed to create pet window', { error: String(error) })
    petWin = null
    return
  }
  selfWindows.add(petWin)
  petReady = false
  lastIgnoreState = null
  lastBackgroundReset = 0
  // OpenCode themes iterate every BrowserWindow and call setBackgroundColor.
  // Keep this window transparent even when the theme asks for an opaque color.
  try {
    const setBackgroundColor = petWin.setBackgroundColor.bind(petWin)
    petWin.setBackgroundColor = () => setBackgroundColor('#00000000')
    petBackgroundGuard = true
  } catch {
    petBackgroundGuard = false
  }
  log('info', 'pet background guard', { installed: petBackgroundGuard })
  if (!petBackgroundGuard && !petRecreateAttempted) {
    // Fallback for Electron builds where the instance method cannot be wrapped:
    // recreate the pet once after OpenCode has applied its startup theme.
    petRecreateAttempted = true
    setTimeout(() => {
      if (disposed) return
      destroyPetWindow()
      createPetWindow()
      layoutPet()
    }, 2600)
  }
  safe(() => petWin.setMenuBarVisibility(false))
  safe(() => petWin.setIgnoreMouseEvents(true, { forward: true }))
  enforcePetBackground(true)

  petWin.loadFile(runtime.petHtml).catch((error) => {
    log('error', 'failed to load pet window', { error: String(error) })
  })

  petWin.webContents.on('did-finish-load', () => {
    try {
      petReady = true
      lastPetState = ''
      enforcePetBackground(true)
      sendConfigTo(petWin)
      sendState(true)
      layoutPet()
      pumpBubbles()
      if (config.enabled && mainWin && !mainWin.isMinimized()) {
        safe(() => petWin.showInactive())
        safe(() => petWin.setOpacity(config.opacity))
      }
      log('info', 'pet window loaded')
      if (petWin?.webContents?.executeJavaScript) {
        petWin.webContents
          .executeJavaScript(
            `(() => {
              const color = (id) => {
                const el = id === 'html' ? document.documentElement : id === 'body' ? document.body : document.getElementById(id)
                return el ? getComputedStyle(el).backgroundColor : 'missing'
              }
              return {
                html: color('html'),
                body: color('body'),
                stage: color('stage'),
                pet: color('pet-wrap'),
                sheets: [...document.styleSheets].map((sheet) => sheet.href || 'inline'),
              }
            })()`,
          )
          .then((info) => log('info', 'pet page background', info))
          .catch(() => {})
      }
    } catch (error) {
      log('error', 'pet did-finish-load failed', { error: String(error) })
    }
  })

  petWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  petWin.webContents.on('render-process-gone', (event, details) => {
    log('error', 'pet renderer gone', details)
    petReady = false
  })

  for (const delay of [250, 750, 1500, 3000, 6000]) {
    setTimeout(() => enforcePetBackground(true), delay)
  }

  petWin.on('closed', () => {
    selfWindows.delete(petWin)
    petWin = null
    petReady = false
    showingBubble = false
    if (bubbleTimer) clearTimeout(bubbleTimer)
    bubbleTimer = null
  })
}

function destroyPetWindow() {
  if (petWin && !petWin.isDestroyed()) {
    const win = petWin
    petWin = null
    petReady = false
    selfWindows.delete(win)
    try {
      win.destroy()
    } catch {}
  }
  petWin = null
  petReady = false
  showingBubble = false
  lastIgnoreState = null
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
}

function enforcePetBackground(force = false) {
  if (disposed || !petWin || petWin.isDestroyed()) return
  const now = Date.now()
  if (!force && now - lastBackgroundReset < 1500) return
  lastBackgroundReset = now
  // OpenCode applies its theme background to every BrowserWindow. Restore the
  // pet window's transparent background so the desktop shows through.
  safe(() => petWin.setBackgroundColor('#00000000'))
}

function petScale() {
  return clamp(config.scale, 0.6, 1.8, DEFAULT_CONFIG.scale)
}

function petVisualSize() {
  const scale = petScale()
  return {
    scale,
    width: Math.round(302 * scale),
    height: Math.round(298 * scale),
  }
}

function bubbleSpaceOpen() {
  return showingBubble || Date.now() < bubbleCloseAt
}

function petWindowSize() {
  const pet = petVisualSize()
  const bubbleOpen = bubbleSpaceOpen()
  return {
    width: Math.round(Math.max(pet.width + 16, bubbleOpen ? 320 : 200)),
    height: Math.round(pet.height + (bubbleOpen ? 210 : 40)),
  }
}

const COMPOSER_SCRIPT = `(() => {
  try {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      if (r.width < 120 || r.height < 16) return false
      if (r.bottom < innerHeight * 0.35) return false
      if (r.left < 0 || r.right > innerWidth + 1) return false
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
    }
    const controls = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible)
    if (!controls.length) return null
    controls.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)
    const control = controls[0]
    const cr = control.getBoundingClientRect()
    let box = control.closest('form')
    const fits = (r) => r && r.width >= cr.width - 2 && r.width < innerWidth * 0.92 && r.height < 420
    if (!box || !fits(box.getBoundingClientRect())) {
      let node = control.parentElement
      for (let i = 0; i < 4 && node && node !== document.body; i++) {
        const r = node.getBoundingClientRect()
        if (r.width >= cr.width + 16 && r.width < innerWidth * 0.92 && r.height < 420) {
          box = node
          break
        }
        node = node.parentElement
      }
    }
    const br = (box || control).getBoundingClientRect()
    return {
      control: { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom, width: cr.width, height: cr.height },
      box: { left: br.left, top: br.top, right: br.right, bottom: br.bottom, width: br.width, height: br.height },
      viewport: { width: innerWidth, height: innerHeight },
    }
  } catch {
    return null
  }
})()`

function queryComposer() {
  if (disposed || !mainWin || mainWin.isDestroyed() || composerQueryInFlight) return
  const contents = mainWin.webContents
  if (!contents || (contents.isDestroyed && contents.isDestroyed())) return
  composerQueryInFlight = true
  let promise
  try {
    promise = contents.executeJavaScript(COMPOSER_SCRIPT)
  } catch {
    composerQueryInFlight = false
    return
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), 1500))
  Promise.race([Promise.resolve(promise), timeout])
    .then((value) => {
      composerQueryInFlight = false
      if (disposed) return
      if (value === undefined) {
        layoutPet()
        return
      }
      const next = normalizeComposer(value)
      if (JSON.stringify(next) !== JSON.stringify(composerRect)) {
        composerRect = next
        log('info', 'composer rect updated', {
          right: next?.box?.right,
          bottom: next?.box?.bottom,
          width: next?.box?.width,
        })
      } else {
        composerRect = next
      }
      layoutPet()
    })
    .catch(() => {
      composerQueryInFlight = false
    })
}

function scheduleComposerQuery(delay = 260) {
  if (disposed) return
  if (composerQueryDebounce) clearTimeout(composerQueryDebounce)
  composerQueryDebounce = setTimeout(() => {
    composerQueryDebounce = null
    queryComposer()
  }, delay)
}

function normalizeComposer(value) {
  if (!value || typeof value !== 'object') return null
  const box = value.box || value.control
  if (!box) return null
  const fields = ['left', 'top', 'right', 'bottom', 'width', 'height']
  if (!fields.every((field) => Number.isFinite(box[field]))) return null
  return value
}

function petAnchor(content, pet) {
  const marginRight = Math.max(2, Math.min(240, Number(config.marginRight) || 16))
  const marginBottom = Math.max(0, Math.min(60, Number(config.marginBottom) || 8))
  const fallback = () => ({
    left: content.x + content.width - pet.width - marginRight,
    bottom: content.y + content.height - marginBottom,
  })
  const info = composerRect
  if (!info) return fallback()
  const box = info.box || info.control
  if (!box) return fallback()

  const zoom = clamp(safe(() => mainWin.webContents.getZoomFactor(), 1) || 1, 0.25, 4)
  const left = content.x + box.left * zoom
  const right = content.x + box.right * zoom
  const top = content.y + box.top * zoom
  const bottom = content.y + box.bottom * zoom
  const minX = content.x + 4
  const maxX = content.x + content.width - 4
  const maxBottom = content.y + content.height - 4

  const fitsRight = right + marginRight + pet.width + 7 <= maxX
  const fitsLeft = left - marginRight - pet.width - 7 >= minX
  let petLeft
  let petBottom

  if (fitsRight) {
    petLeft = right + marginRight
    petBottom = Math.min(maxBottom, bottom + marginBottom)
  } else if (fitsLeft) {
    petLeft = left - marginRight - pet.width
    petBottom = Math.min(maxBottom, bottom + marginBottom)
  } else {
    // Last resort: sit above the composer, aligned to its right edge.
    petLeft = Math.max(minX, Math.min(right - pet.width, maxX - pet.width))
    petBottom = Math.min(maxBottom, Math.max(content.y + pet.height + 6, top - 10))
  }

  petLeft = Math.max(minX, Math.min(petLeft, maxX - pet.width))
  petBottom = Math.max(content.y + pet.height + 6, Math.min(petBottom, maxBottom))
  return { left: petLeft, bottom: petBottom }
}

function layoutPet() {
  if (disposed) return
  if (!mainWin || mainWin.isDestroyed()) {
    const next = findMainWindow()
    if (next) attachMainWindow(next)
    return
  }
  if (!petWin || petWin.isDestroyed()) {
    if (config.enabled) createPetWindow()
    return
  }
  if (!config.enabled) {
    if (petWin.isVisible()) petWin.hide()
    return
  }
  if (mainWin.isMinimized() || !mainWin.isVisible()) {
    if (petWin.isVisible()) petWin.hide()
    return
  }

  const pet = petVisualSize()
  const size = petWindowSize()
  let bounds
  try {
    const content = mainWin.getContentBounds()
    const anchor = petAnchor(content, pet)
    bounds = {
      x: Math.round(anchor.left + pet.width + 7 - size.width),
      y: Math.round(anchor.bottom - size.height),
      width: size.width,
      height: size.height,
    }
  } catch {
    return
  }

  const current = petWin.getBounds()
  if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) {
    try {
      petWin.setBounds(bounds)
    } catch {}
  }
  safe(() => petWin.setOpacity(config.opacity))
  enforcePetBackground(false)
  if (!petWin.isVisible()) {
    safe(() => petWin.showInactive())
    safe(() => petWin.setOpacity(config.opacity))
  }
  syncPetTop()
}

function syncPetTop() {
  if (!petWin || petWin.isDestroyed()) return
  const active = !!mainWin && !mainWin.isDestroyed() && safe(() => mainWin.isFocused(), false) === true
  if (safe(() => petWin.isAlwaysOnTop(), false) !== active) {
    safe(() => petWin.setAlwaysOnTop(active, 'floating'))
  }
  if (active && config.enabled && !mainWin.isMinimized() && !petWin.isVisible()) {
    safe(() => petWin.showInactive())
  }
}

function updateMousePassthrough() {
  if (!petWin || petWin.isDestroyed() || !petWin.isVisible() || !config.enabled) return
  const cursor = safe(() => screen.getCursorScreenPoint(), null)
  if (!cursor) return
  const bounds = petWin.getBounds()
  const petVisual = petVisualSize()
  const petWidth = petVisual.width
  const petHeight = petVisual.height
  const margin = 8
  const pet = {
    left: bounds.x + bounds.width - 7 - petWidth - margin,
    right: bounds.x + bounds.width - 7 + margin,
    top: bounds.y + bounds.height - petHeight - margin,
    bottom: bounds.y + bounds.height + margin,
  }
  const insidePet =
    cursor.x >= pet.left && cursor.x <= pet.right && cursor.y >= pet.top && cursor.y <= pet.bottom
  let insideBubble = false
  if (bubbleSpaceOpen()) {
    const bubbleHeight = 176
    const bubbleBottom = petHeight - 10
    const bubbleTop = bubbleBottom + bubbleHeight
    const bubbleLeft = bounds.width - 10 - 302
    const rect = {
      left: bounds.x + Math.max(0, bubbleLeft - 4),
      right: bounds.x + bounds.width - 6,
      top: bounds.y + bounds.height - bubbleTop - 4,
      bottom: bounds.y + bounds.height - bubbleBottom + 4,
    }
    insideBubble =
      cursor.x >= rect.left && cursor.x <= rect.right && cursor.y >= rect.top && cursor.y <= rect.bottom
  }
  const interactive = insidePet || insideBubble
  const ignore = !interactive
  if (ignore !== lastIgnoreState) {
    lastIgnoreState = ignore
    safe(() => petWin.setIgnoreMouseEvents(ignore, { forward: true }))
  }
}

function openSettingsWindow() {  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  if (!fs.existsSync(runtime.settingsHtml)) {
    log('error', 'settings.html is missing; run scripts/install.mjs again', { path: runtime.settingsHtml })
    return
  }
  const parent = mainWin && !mainWin.isDestroyed() ? mainWin : undefined
  const workArea = safe(() => screen.getDisplayMatching(parent ? parent.getBounds() : screen.getPrimaryDisplay().bounds).workAreaSize, null)
  const width = Math.min(640, Math.max(520, (workArea?.width || 1280) - 80))
  const height = Math.min(780, Math.max(560, (workArea?.height || 900) - 80))
  settingsWin = new BrowserWindow({
    width,
    height,
    minWidth: 520,
    minHeight: 560,
    parent,
    modal: false,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#18181b',
    title: 'Remielle 桌宠设置',
    webPreferences: {
      preload: runtime.preloadPath,
      partition: 'remielle-pet',
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: true,
    },
  })
  selfWindows.add(settingsWin)
  settingsReady = false
  lastSettingsState = ''
  safe(() => settingsWin.setMenuBarVisibility(false))
  settingsWin.loadFile(runtime.settingsHtml).catch((error) => {
    log('error', 'failed to load settings window', { error: String(error) })
  })
  settingsWin.once('ready-to-show', () => {
    safe(() => settingsWin.show())
    safe(() => settingsWin.focus())
  })
  settingsWin.webContents.on('did-finish-load', () => {
    try {
      settingsReady = true
      lastSettingsState = ''
      sendConfigTo(settingsWin)
      sendState(true)
    } catch (error) {
      log('error', 'settings did-finish-load failed', { error: String(error) })
    }
  })
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  settingsWin.on('closed', () => {
    selfWindows.delete(settingsWin)
    settingsWin = null
    settingsReady = false
    lastSettingsState = ''
  })
  log('info', 'settings window opened')
}

function closeSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close()
}

// ---------------------------------------------------------------------------
// IPC / updates
// ---------------------------------------------------------------------------

function isOurSender(event) {
  const sender = event?.sender
  if (!sender) return false
  for (const win of [petWin, settingsWin]) {
    if (win && !win.isDestroyed() && win.webContents === sender) return true
  }
  return false
}

function registerIpc() {
  const handlers = {
    [PREFIX + 'get-config']: () => publicConfig(),
    [PREFIX + 'set-config']: (event, patch) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const previousResPath = config.resPath
      config = sanitizeConfig({ ...config, ...(patch || {}) })
      saveConfig()
      if (config.resPath !== previousResPath) syncAssets({ force: true })
      applyConfig()
      return publicConfig()
    },
    [PREFIX + 'reset-config']: (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const detected = resolveResPath()
      config = sanitizeConfig({ ...DEFAULT_CONFIG, resPath: detected || config.resPath })
      saveConfig()
      syncAssets({ force: true })
      applyConfig()
      return publicConfig()
    },
    [PREFIX + 'open-settings']: (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      openSettingsWindow()
      return true
    },
    [PREFIX + 'close-settings']: (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      closeSettingsWindow()
      return true
    },
    [PREFIX + 'set-ignore']: (event, value) => {
      if (!isOurSender(event) || !petWin || petWin.isDestroyed()) return false
      const ignore = value !== false
      safe(() => petWin.setIgnoreMouseEvents(ignore, { forward: true }))
      return ignore
    },
    [PREFIX + 'browse-res']: async (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const owner = settingsWin || petWin
      const options = {
        title: '选择 Remielle 资源文件夹',
        properties: ['openDirectory'],
        defaultPath: config.resPath || runtime.root,
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      config.resPath = result.filePaths[0]
      saveConfig()
      syncAssets({ force: true })
      applyConfig()
      return { path: config.resPath, status: assetStatus }
    },
    [PREFIX + 'reload-assets']: (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const status = syncAssets({ force: true })
      applyConfig()
      return status
    },
    [PREFIX + 'open-res']: async (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const target = resolveResPath() || runtime.assetsDir
      const error = await shell.openPath(target)
      return { path: target, error: error || '' }
    },
    [PREFIX + 'open-log']: async (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const error = await shell.openPath(runtime.logPath)
      return { path: runtime.logPath, error: error || '' }
    },
    [PREFIX + 'test-connection']: async (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      const endpoint = getEndpoint()
      try {
        const active = await apiGet('/api/session/active', 4000)
        return {
          ok: true,
          url: endpoint?.url || '',
          connected: sse.connected,
          active: Object.keys(active || {}),
        }
      } catch (error) {
        return {
          ok: false,
          url: endpoint?.url || '',
          connected: sse.connected,
          error: String(error.message || error),
        }
      }
    },
    [PREFIX + 'get-runtime']: (event) => {
      if (!isOurSender(event)) throw new Error('invalid sender')
      return {
        version: VERSION,
        extensionID: EXTENSION_ID,
        connected: sse.connected,
        endpoint: getEndpoint()?.url || '',
        assets: assetStatus,
        config: publicConfig(),
        runtime,
        sessions: state
          ? [...state.sessions.values()].map((session) => ({
              id: session.id,
              running: session.running,
              model: session.model,
              title: session.title,
              lastType: session.lastType,
              lastAt: session.lastAt,
            }))
          : [],
      }
    },
    [PREFIX + 'dismiss-bubble']: (event) => {
      if (!isOurSender(event)) return false
      hideBubble()
      return true
    },
    [PREFIX + 'test-bubble']: (event) => {
      if (!isOurSender(event)) return false
      if (!petReady || !petWin || petWin.isDestroyed() || !state) return false
      if (bubbleTimer) clearTimeout(bubbleTimer)
      bubbleBusy = true
      showingBubble = true
      bubbleCloseAt = 0
      layoutPet()
      const demo = {
        id: 'preview',
        sessionID: 'preview',
        outcome: 'succeeded',
        error: '',
        durationMs: 12400,
        cost: 0.0518,
        tokens: { input: 10000, output: 2000, reasoning: 345, cache: { read: 1234567, write: 0 } },
        totalCost: 1.284,
        totalTokens: { input: 1010000, output: 210000, reasoning: 35000, cache: { read: 12345670, write: 0 } },
        model: 'deepseek/deepseek-flash',
        title: '气泡预览',
        at: Date.now(),
      }
      const view = state.bubbleView(demo)
      try {
        petWin.webContents.send(PREFIX + 'bubble', view)
      } catch {}
      bubbleTimer = setTimeout(hideBubble, Math.max(4000, config.bubbleSeconds * 1000))
      return true
    },
    [PREFIX + 'pet-click']: (event, action) => {
      if (!isOurSender(event)) return false
      if (action === 'settings') openSettingsWindow()
      else if (action === 'smug') state.triggerSmug()
      return true
    },
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
    ipcMain.handle(channel, handler)
  }
}

function unregisterIpc() {
  for (const channel of [
    'get-config',
    'set-config',
    'reset-config',
    'open-settings',
    'close-settings',
    'set-ignore',
    'browse-res',
    'reload-assets',
    'open-res',
    'open-log',
    'test-connection',
    'get-runtime',
    'dismiss-bubble',
    'test-bubble',
    'pet-click',
  ]) {
    try {
      ipcMain.removeHandler(PREFIX + channel)
    } catch {}
  }
}

function sendToWindows(channel, payload) {
  for (const win of [petWin, settingsWin]) {
    if (!win || win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {}
  }
}

function sendConfigTo(win) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(PREFIX + 'config', publicConfig())
  } catch {}
}

function broadcastConfig() {
  sendConfigTo(petWin)
  sendConfigTo(settingsWin)
}

function applyConfig() {
  if (!state) return
  state.setConfig(config)
  if (!config.enabled) hideBubble()
  if (!config.showBubble) {
    state.clearBubbles()
    if (showingBubble) hideBubble()
  }
  broadcastConfig()
  layoutPet()
}

function sendState(force = false) {
  if (!state) return
  const snapshot = state.snapshot(Date.now())
  snapshot.assetVersion = assetVersion
  snapshot.assetStatus = assetStatus
  snapshot.connected = sse.connected
  const serialized = JSON.stringify(snapshot)
  if (petWin && !petWin.isDestroyed() && (force || serialized !== lastPetState)) {
    lastPetState = serialized
    try {
      petWin.webContents.send(PREFIX + 'state', snapshot)
    } catch {}
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    const settingsSerialized = JSON.stringify({ ...snapshot, lastError: undefined })
    if (force || settingsSerialized !== lastSettingsState) {
      lastSettingsState = settingsSerialized
      try {
        settingsWin.webContents.send(PREFIX + 'state', snapshot)
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

function hideBubble() {
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
  const wasShowing = showingBubble
  showingBubble = false
  bubbleBusy = false
  if (wasShowing) bubbleCloseAt = Date.now() + 200
  if (petWin && !petWin.isDestroyed()) {
    try {
      petWin.webContents.send(PREFIX + 'bubble-hide')
    } catch {}
  }
  if (wasShowing) {
    setTimeout(() => {
      if (!bubbleSpaceOpen()) layoutPet()
    }, 210)
  }
  setTimeout(() => pumpBubbles(), 60)
}

function pumpBubbles() {
  if (disposed || !state) return
  if (showingBubble || bubbleBusy) return
  if (!config.showBubble || !config.enabled) return
  if (!petReady || !petWin || petWin.isDestroyed()) return
  const bubble = state.takeBubble()
  if (!bubble) return
  bubbleBusy = true

  const pending = pendingSessionFetches.get(bubble.sessionID)
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 1200))
  Promise.race([pending || Promise.resolve(null), timeout])
    .then((info) => {
      if (disposed || !bubbleBusy) return
      if (info) {
        if (info.parentID && !config.subagentBubbles) {
          log('debug', 'suppressing subagent bubble', { sessionID: bubble.sessionID })
          bubbleBusy = false
          pumpBubbles()
          return
        }
        if (info.model) bubble.model = formatModel(info.model)
        if (info.title) bubble.title = String(info.title).replace(/\s+/g, ' ').trim().slice(0, 90)
        if (info.cost !== undefined) bubble.totalCost = Number(info.cost) || 0
        if (info.tokens) bubble.totalTokens = info.tokens
      }
      const view = state.bubbleView(bubble)
      if (!view) {
        bubbleBusy = false
        return
      }
      showingBubble = true
      bubbleCloseAt = 0
      layoutPet()
      if (petWin && !petWin.isDestroyed()) {
        try {
          petWin.webContents.send(PREFIX + 'bubble', view)
        } catch {}
      }
      if (bubbleTimer) clearTimeout(bubbleTimer)
      bubbleTimer = setTimeout(hideBubble, Math.max(2000, config.bubbleSeconds * 1000))
      log('info', 'bubble shown', {
        sessionID: bubble.sessionID,
        cost: view.costText,
        tokens: view.tokensText,
        outcome: view.outcome,
      })
    })
    .catch((error) => {
      log('warn', 'bubble enrichment failed', { error: String(error) })
      bubbleBusy = false
    })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function startLoops() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(() => {
    if (disposed) return
    try {
      sendState(false)
      pumpBubbles()
      layoutPet()
    } catch (error) {
      log('error', 'tick failed', { error: String(error) })
    }
  }, 250)

  if (syncTimer) clearInterval(syncTimer)
  syncTimer = setInterval(() => {
    if (disposed || !sse.connected) return
    syncActiveSessions()
  }, 20000)

  if (mouseTimer) clearInterval(mouseTimer)
  mouseTimer = setInterval(() => {
    if (disposed) return
    try {
      updateMousePassthrough()
    } catch (error) {
      log('error', 'mouse passthrough update failed', { error: String(error) })
    }
  }, 60)

  if (composerTimer) clearInterval(composerTimer)
  composerTimer = setInterval(() => {
    if (!disposed) queryComposer()
  }, 1500)
}

function cleanup() {
  if (disposed) return
  disposed = true
  log('info', 'extension cleaning up')
  if (tickTimer) clearInterval(tickTimer)
  if (syncTimer) clearInterval(syncTimer)
  if (layoutTimer) clearInterval(layoutTimer)
  if (mouseTimer) clearInterval(mouseTimer)
  if (composerTimer) clearInterval(composerTimer)
  if (composerQueryDebounce) clearTimeout(composerQueryDebounce)
  if (sse.reconnectTimer) clearTimeout(sse.reconnectTimer)
  if (bubbleTimer) clearTimeout(bubbleTimer)
  tickTimer = syncTimer = layoutTimer = mouseTimer = composerTimer = null
  composerQueryDebounce = null
  sse.reconnectTimer = null
  bubbleTimer = null
  lastIgnoreState = null
  try {
    if (sse.req) sse.req.destroy()
  } catch {}
  sse.req = null
  if (detachWindowsListener) {
    try {
      detachWindowsListener()
    } catch {}
    detachWindowsListener = null
  }
  try {
    app.removeListener('browser-window-focus', onWindowFocus)
  } catch {}
  clearMainWindowListeners()
  closeSettingsWindow()
  destroyPetWindow()
  unregisterIpc()
}

function onWindowFocus(event, win) {
  if (disposed || !win || win.isDestroyed() || isSelfWindow(win)) return
  if (!isLikelyMainWindow(win)) return
  attachMainWindow(win)
}

async function setup(pluginContext) {
  ctx = pluginContext
  initRuntime()
  config = loadConfig()

  log('info', 'starting Remielle', {
    version: VERSION,
    userData: runtime.userData,
    config: runtime.configPath,
  })

  await app.whenReady()
  if (disposed) return

  syncAssets({ force: false })
  state = new PetState(config)
  state.setConnected(false)

  registerIpc()
  startLoops()

  const first = findMainWindow()
  if (first) attachMainWindow(first)
  else log('warn', 'no OpenCode window found at startup; waiting')

  detachWindowsListener = safe(
    () => ctx.windows.on('open', (win) => {
      if (!disposed && win && !win.isDestroyed() && !isSelfWindow(win)) attachMainWindow(win)
    }),
    null,
  )
  app.on('browser-window-focus', onWindowFocus)

  connectSSE()
  setTimeout(() => {
    if (!disposed) syncActiveSessions()
  }, 1200)

  const cleanupScope = () => cleanup()
  if (ctx.scope?.addFinalizer) {
    try {
      ctx.scope.addFinalizer(cleanupScope)
    } catch {}
  } else if (ctx.scope?.contribute) {
    try {
      ctx.scope.contribute(cleanupScope)
    } catch {}
  }
  if (ctx.scope?.signal) {
    try {
      ctx.scope.signal.addEventListener('abort', cleanupScope, { once: true })
    } catch {}
  }
}

module.exports = {
  default: setup,
}
