'use strict'

const ASSETS = {
  idle: { file: 'idle.gif', zh: '待机.gif' },
  penIdle: { file: 'pen-idle.gif', zh: '拿笔待机.gif' },
  think: { file: 'think.gif', zh: '思考.gif' },
  drawIntermittent: { file: 'draw-intermittent.gif', zh: '间歇绘制.gif' },
  drawContinuous: { file: 'draw-continuous.gif', zh: '连续绘制.gif' },
  expect: { file: 'expect.gif', zh: '期待.gif' },
  smug: { file: 'smug.gif', zh: '得意.gif' },
}

const DEFAULTS = {
  enabled: true,
  scale: 0.85,
  opacity: 1,
  marginRight: 16,
  marginBottom: 12,
  showStatus: true,
  showBubble: true,
  showTotal: true,
  bubbleSeconds: 7,
  expectSeconds: 4.5,
  drawHoldMs: 2000,
  clickAction: 'smug',
  continuousCount: 3,
  continuousWindow: 7000,
  fileTools: [
    'read',
    'write',
    'edit',
    'patch',
    'multiedit',
    'apply_patch',
    'create',
    'delete',
    'remove',
    'move',
    'rename',
    'glob',
    'grep',
    'list',
    'todowrite',
  ],
  resPath: '',
  subagentBubbles: false,
  debug: false,
}

const realApi = window.remielle || null
const demoMode = !realApi
const api = realApi || createDemoApi()

const $ = (id) => document.getElementById(id)

let config = { ...DEFAULTS }
let assetVersion = 1
let saveTimer = null
let noteTimer = null

init()

function init() {
  bindEvents()
  api.getConfig().then((cfg) => {
    if (!cfg) return
    populate(cfg)
  }).catch(() => {})
  api.onConfig((cfg) => {
    if (!cfg) return
    if (cfg.version) $('version').textContent = 'v' + cfg.version
    assetVersion = cfg.assetVersion || assetVersion
    if (cfg.assetStatus) refreshAssetStatus(cfg.assetStatus)
    refreshPreview()
  })
  api.onState((snapshot) => {
    if (!snapshot) return
    if (snapshot.assetVersion) assetVersion = snapshot.assetVersion
    updateLive(snapshot)
  })
  $('preview-select').addEventListener('change', refreshPreview)
  refreshPreview()
  setTimeout(refreshRuntime, 500)
}

function bindEvents() {
  const saveOnChange = (id) => {
    const el = $(id)
    if (!el) return
    el.addEventListener('input', () => {
      updateLabels()
      if (el.type === 'range') refreshPreview()
    })
    el.addEventListener('change', () => {
      updateLabels()
      scheduleSave()
    })
  }

  for (const id of [
    'enabled',
    'scale',
    'opacity',
    'marginRight',
    'marginBottom',
    'showStatus',
    'clickAction',
    'showBubble',
    'bubbleSeconds',
    'showTotal',
    'subagentBubbles',
    'expectSeconds',
    'drawHoldMs',
    'continuousCount',
    'continuousWindow',
    'fileTools',
    'resPath',
    'debug',
  ]) {
    saveOnChange(id)
  }

  $('browse-res').addEventListener('click', async () => {
    try {
      const result = await api.browseRes()
      if (!result) return
      if (result.path) $('resPath').value = result.path
      if (result.status) {
        refreshAssetStatus(result.status)
        assetVersion = Date.now()
        refreshPreview()
      }
      note('资源已更新', 'saved')
    } catch (error) {
      note('选择文件夹失败: ' + errorText(error), 'error')
    }
  })

  $('open-res').addEventListener('click', () => api.openRes().catch(() => {}))
  $('open-log').addEventListener('click', () => api.openLog().catch(() => {}))
  $('reload-assets').addEventListener('click', async () => {
    try {
      const status = await api.reloadAssets()
      if (status) {
        refreshAssetStatus(status)
        assetVersion = Date.now()
        refreshPreview()
        note('动画已重新加载', 'saved')
      }
    } catch (error) {
      note('重载失败: ' + errorText(error), 'error')
    }
  })
  $('test-bubble').addEventListener('click', () => api.testBubble().catch(() => {}))
  $('test-connection').addEventListener('click', async () => {
    try {
      const result = await api.testConnection()
      $('debug-output').textContent = JSON.stringify(result, null, 2)
      note(result.ok ? '服务器连接正常' : '服务器连接失败', result.ok ? 'saved' : 'error')
    } catch (error) {
      $('debug-output').textContent = errorText(error)
      note('测试失败', 'error')
    }
  })
  $('refresh-runtime').addEventListener('click', refreshRuntime)
  $('reset').addEventListener('click', async () => {
    if (!confirm('恢复所有设置为默认值？资源路径会保留自动检测结果。')) return
    try {
      const cfg = await api.resetConfig()
      if (cfg) populate(cfg)
      note('已恢复默认', 'saved')
    } catch (error) {
      note('恢复失败: ' + errorText(error), 'error')
    }
  })
  $('close').addEventListener('click', () => api.closeSettings().catch(() => {}))
}

function populate(cfg) {
  config = { ...DEFAULTS, ...cfg }
  assetVersion = cfg.assetVersion || 1
  if (cfg.version) $('version').textContent = 'v' + cfg.version

  $('enabled').checked = cfg.enabled !== false
  $('scale').value = String(cfg.scale ?? DEFAULTS.scale)
  $('opacity').value = String(cfg.opacity ?? DEFAULTS.opacity)
  $('marginRight').value = String(cfg.marginRight ?? DEFAULTS.marginRight)
  $('marginBottom').value = String(cfg.marginBottom ?? DEFAULTS.marginBottom)
  $('showStatus').checked = cfg.showStatus !== false
  $('clickAction').value = cfg.clickAction || 'smug'
  $('showBubble').checked = cfg.showBubble !== false
  $('bubbleSeconds').value = String(cfg.bubbleSeconds ?? DEFAULTS.bubbleSeconds)
  $('showTotal').checked = cfg.showTotal !== false
  $('subagentBubbles').checked = cfg.subagentBubbles === true
  $('expectSeconds').value = String(cfg.expectSeconds ?? DEFAULTS.expectSeconds)
  $('drawHoldMs').value = String(cfg.drawHoldMs ?? DEFAULTS.drawHoldMs)
  $('continuousCount').value = String(cfg.continuousCount ?? DEFAULTS.continuousCount)
  $('continuousWindow').value = String(cfg.continuousWindow ?? DEFAULTS.continuousWindow)
  $('fileTools').value = Array.isArray(cfg.fileTools) ? cfg.fileTools.join(', ') : DEFAULTS.fileTools.join(', ')
  $('resPath').value = cfg.resPath || ''
  $('debug').checked = cfg.debug === true

  updateLabels()
  if (cfg.assetStatus) refreshAssetStatus(cfg.assetStatus, cfg.runtime)
  refreshPreview()
}

function collect() {
  return {
    enabled: $('enabled').checked,
    scale: Number($('scale').value),
    opacity: Number($('opacity').value),
    marginRight: Number($('marginRight').value),
    marginBottom: Number($('marginBottom').value),
    showStatus: $('showStatus').checked,
    clickAction: $('clickAction').value,
    showBubble: $('showBubble').checked,
    bubbleSeconds: Number($('bubbleSeconds').value),
    showTotal: $('showTotal').checked,
    subagentBubbles: $('subagentBubbles').checked,
    expectSeconds: Number($('expectSeconds').value),
    drawHoldMs: Number($('drawHoldMs').value),
    continuousCount: Number($('continuousCount').value),
    continuousWindow: Number($('continuousWindow').value),
    fileTools: $('fileTools')
      .value.split(',')
      .map((tool) => tool.trim())
      .filter(Boolean),
    resPath: $('resPath').value.trim(),
    debug: $('debug').checked,
  }
}

function updateLabels() {
  const scale = Number($('scale').value) || DEFAULTS.scale
  const opacity = Number($('opacity').value) || DEFAULTS.opacity
  const bubbleSeconds = Number($('bubbleSeconds').value) || DEFAULTS.bubbleSeconds
  const expectSeconds = Number($('expectSeconds').value) || DEFAULTS.expectSeconds
  const drawHoldMs = Number($('drawHoldMs').value) || DEFAULTS.drawHoldMs
  $('scale-value').textContent = scale.toFixed(2) + '×'
  $('opacity-value').textContent = Math.round(opacity * 100) + '%'
  $('bubble-value').textContent = bubbleSeconds.toFixed(1) + 's'
  $('expect-value').textContent = expectSeconds.toFixed(1) + 's'
  $('draw-value').textContent = (drawHoldMs / 1000).toFixed(1) + 's'
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  note('正在保存…')
  saveTimer = setTimeout(() => {
    saveTimer = null
    const patch = collect()
    api
      .setConfig(patch)
      .then((cfg) => {
        if (cfg) {
          config = { ...config, ...cfg }
          if (cfg.assetVersion) assetVersion = cfg.assetVersion
          if (cfg.assetStatus) refreshAssetStatus(cfg.assetStatus, cfg.runtime)
        }
        note('已保存', 'saved')
        refreshPreview()
      })
      .catch((error) => note('保存失败: ' + errorText(error), 'error'))
  }, 320)
}

function refreshPreview() {
  if (!demoMode && !realApi) return
  const name = $('preview-select').value || 'idle'
  const entry = ASSETS[name] || ASSETS.idle
  const img = $('preview-img')
  const empty = $('preview-empty')
  const url = demoMode
    ? '../../res/' + encodeURI(entry.zh) + '?v=' + assetVersion
    : '../assets/' + entry.file + '?v=' + assetVersion
  empty.hidden = true
  img.hidden = false
  img.onerror = () => {
    img.hidden = true
    empty.hidden = false
  }
  img.onload = () => {
    img.hidden = false
    empty.hidden = true
  }
  img.alt = entry.zh
  img.src = url
}

function refreshAssetStatus(status, runtime) {
  if (!status) {
    $('asset-summary').textContent = '尚未检测资源'
    $('asset-badge').textContent = '未知'
    $('asset-badge').className = 'badge badge--muted'
    $('asset-missing').hidden = true
    return
  }
  const missing = Array.isArray(status.missing) ? status.missing : []
  const ok = Number(status.ok) || 0
  const total = Object.keys(ASSETS).length
  const summary = `${ok}/${total} 个动画可用${status.resPath ? ' · 源：' + status.resPath : ''}`
  $('asset-summary').textContent = summary
  $('asset-summary').classList.toggle('is-warn', missing.length > 0)
  $('asset-badge').textContent = missing.length === 0 ? '已就绪' : `${missing.length} 个缺失`
  $('asset-badge').className = 'badge' + (missing.length === 0 ? '' : ' is-warn')
  if (missing.length > 0) {
    $('asset-missing').hidden = false
    $('asset-missing').textContent =
      '缺少：' + missing.map((key) => ASSETS[key]?.zh || key).join('、') + '。请把对应 GIF 放进资源文件夹后点「重载动画」。'
  } else {
    $('asset-missing').hidden = true
    $('asset-missing').textContent = ''
  }
  const dir = runtime?.assetsDir || status.assetsDir || ''
  $('asset-dir').textContent = dir ? '运行时目录：' + dir : ''
}

function updateLive(snapshot) {
  const connected = snapshot.connected === true
  const running = snapshot.running === true
  const count = Number(snapshot.activeCount) || 0
  const conn = $('conn')
  conn.className = 'conn ' + (connected ? 'is-online' : 'is-offline')
  $('conn-text').textContent = connected
    ? running
      ? `已连接 · ${count} 个会话运行中`
      : '已连接 · 待机'
    : '未连接'
  $('live-state').textContent = !connected && !running ? '未连接' : snapshot.statusText || '待机中'
  $('live-model').textContent = snapshot.model || '—'
  $('live-sessions').textContent = `${count} 个会话运行中`
}

async function refreshRuntime() {
  try {
    const runtime = await api.getRuntime()
    $('debug-output').textContent = JSON.stringify(runtime, null, 2)
    if (runtime?.assets) refreshAssetStatus(runtime.assets, runtime.runtime || runtime)
    if (runtime?.config?.version) $('version').textContent = 'v' + runtime.config.version
  } catch (error) {
    $('debug-output').textContent = errorText(error)
  }
}

function note(text, kind) {
  if (noteTimer) clearTimeout(noteTimer)
  const el = $('save-note')
  el.textContent = text
  el.className = 'save-note' + (kind ? ' is-' + kind : '')
  if (kind === 'saved' || kind === 'error') {
    noteTimer = setTimeout(() => {
      el.textContent = '所有修改自动保存'
      el.className = 'save-note'
    }, 2200)
  }
}

function errorText(error) {
  if (!error) return '未知错误'
  return String(error.message || error)
}

// ---------------------------------------------------------------------------
// Browser preview
// ---------------------------------------------------------------------------

function createDemoApi() {
  const listeners = { config: [], state: [] }
  const demoConfig = {
    ...DEFAULTS,
    resPath: '../../res',
    version: '1.0.0',
    assetVersion: 1,
    assetStatus: { ok: 7, missing: [], resPath: '../../res', copied: [] },
    runtime: { assetsDir: '浏览器预览模式' },
  }
  const emit = (name, payload) => listeners[name].forEach((cb) => cb(payload))
  const emitState = () => {
    emit('state', {
      connected: true,
      running: false,
      activeCount: 0,
      statusText: '待机中',
      model: 'deepseek/deepseek-flash',
      assetVersion: demoConfig.assetVersion,
    })
  }
  setTimeout(emitState, 300)
  return {
    getConfig: async () => demoConfig,
    setConfig: async (patch) => {
      Object.assign(demoConfig, patch || {})
      emit('config', demoConfig)
      return demoConfig
    },
    resetConfig: async () => demoConfig,
    openSettings: async () => {},
    closeSettings: async () => {},
    setIgnoreMouse: async () => {},
    petClick: async () => {},
    dismissBubble: async () => {},
    browseRes: async () => null,
    reloadAssets: async () => demoConfig.assetStatus,
    openRes: async () => {},
    openLog: async () => alert('浏览器预览模式没有日志文件。'),
    testConnection: async () => ({ ok: true, connected: true, url: 'demo', active: [] }),
    testBubble: async () => alert('浏览器预览模式：气泡只会在 OpenCode 中显示。'),
    getRuntime: async () => ({
      demo: true,
      version: '1.0.0',
      connected: true,
      assets: demoConfig.assetStatus,
      runtime: demoConfig.runtime,
    }),
    onConfig: (cb) => listeners.config.push(cb),
    onState: (cb) => listeners.state.push(cb),
  }
}
