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

const DEFAULT_CONFIG = {
  enabled: true,
  scale: 0.85,
  opacity: 1,
  showStatus: true,
  showBubble: true,
  showTotal: true,
  bubbleSeconds: 7,
  clickAction: 'smug',
  assetVersion: 1,
}

const realApi = window.remielle || null
const demoMode = !realApi && new URLSearchParams(location.search).get('demo') !== '0'
const api = realApi || createDemoApi()

const stage = document.getElementById('stage')
const petWrap = document.getElementById('pet-wrap')
const layers = [document.getElementById('pet-a'), document.getElementById('pet-b')]
const placeholder = document.getElementById('placeholder')
const status = document.getElementById('status')
const statusDot = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const statusModel = document.getElementById('status-model')
const bubble = document.getElementById('bubble')
const bubbleTitle = document.getElementById('bubble-title')
const bubbleDuration = document.getElementById('bubble-duration')
const bubbleTokens = document.getElementById('bubble-tokens')
const bubbleCost = document.getElementById('bubble-cost')
const bubbleDetail = document.getElementById('bubble-detail')
const bubbleError = document.getElementById('bubble-error')
const bubbleTotal = document.getElementById('bubble-total')
const bubbleClose = document.getElementById('bubble-close')
const settingsBtn = document.getElementById('settings-btn')

let config = { ...DEFAULT_CONFIG }
let snapshot = {
  animation: 'idle',
  statusText: '待机中',
  model: '',
  connected: false,
  running: false,
  assetVersion: 1,
}
let currentAnimation = ''
let pendingAnimation = ''
let loadToken = 0
let layerIndex = 0
let placeholderVisible = false
let hideTimer = null
let gearTimer = null
let localSmugUntil = 0
let everConnected = false

init()

function init() {
  applyConfig(config)
  api.onConfig((next) => {
    if (!next) return
    const previousVersion = config.assetVersion
    config = { ...config, ...next }
    applyConfig(config)
    if (config.assetVersion !== previousVersion) {
      currentAnimation = ''
      pendingAnimation = ''
      setAnimation(snapshot.animation || 'idle', true)
    }
  })
  api.onState((next) => {
    if (!next) return
    snapshot = { ...snapshot, ...next }
    applyState(snapshot)
  })
  api.onBubble((view) => showBubble(view))
  api.onBubbleHide(() => hideBubble())
  api.getConfig().then((next) => {
    if (next) {
      config = { ...config, ...next }
      applyConfig(config)
    }
    setAnimation(snapshot.animation || 'idle', true)
  }).catch(() => {})

  setupInteraction()
  setAnimation('idle', true)
  requestAnimationFrame(() => {
    if (config.showStatus) status.hidden = false
  })
}

function applyConfig(next) {
  const scale = clamp(Number(next.scale) || DEFAULT_CONFIG.scale, 0.6, 1.8)
  document.documentElement.style.setProperty('--scale', String(scale))
  if (next.showStatus === false) status.hidden = true
  else {
    status.hidden = false
    updateStatus()
  }
}

function applyState(next) {
  let animation = next.animation || 'idle'
  if (localSmugUntil > Date.now() && animation !== 'think' && !String(animation).startsWith('draw')) {
    animation = 'smug'
  }
  setAnimation(animation)
  updateStatus()
}

function updateStatus() {
  if (config.showStatus === false) {
    status.hidden = true
    return
  }
  status.hidden = false
  if (snapshot.connected === true) everConnected = true
  const offline = snapshot.connected === false
  const running = snapshot.running === true
  const text = offline && !running ? (everConnected ? '未连接' : '连接中…') : snapshot.statusText || '待机中'
  const model = snapshot.model || ''
  if (statusText.textContent !== text) statusText.textContent = text
  if (statusModel.textContent !== model) statusModel.textContent = model
  const kind = animationKind(snapshot.animation)
  statusDot.className = 'status__dot'
  if (offline && everConnected) statusDot.classList.add('is-offline')
  else if (kind) statusDot.classList.add('is-' + kind)
}

function animationKind(name) {
  if (name === 'think') return 'think'
  if (name === 'drawIntermittent' || name === 'drawContinuous') return 'draw'
  if (name === 'expect') return 'expect'
  if (name === 'smug') return 'smug'
  return ''
}

function assetUrl(name, version) {
  const entry = ASSETS[name] || ASSETS.idle
  if (demoMode) return '../../res/' + encodeURI(entry.zh) + '?v=' + (version || 1)
  const suffix = version ? '?v=' + version : ''
  return '../assets/' + entry.file + suffix
}

function setAnimation(name, force = false) {
  const animation = ASSETS[name] ? name : 'idle'
  if (!force && animation === currentAnimation) return
  if (!force && animation === pendingAnimation) return
  pendingAnimation = animation
  const token = ++loadToken
  const layer = layers[layerIndex]
  const other = layers[1 - layerIndex]
  layer.onload = null
  layer.onerror = null
  layer.onload = () => {
    if (token !== loadToken) return
    layer.classList.add('is-active')
    other.classList.remove('is-active')
    layerIndex = 1 - layerIndex
    currentAnimation = animation
    pendingAnimation = ''
    placeholderVisible = false
    placeholder.hidden = true
    layer.onload = null
    layer.onerror = null
  }
  layer.onerror = () => {
    if (token !== loadToken) return
    pendingAnimation = ''
    currentAnimation = animation
    if (animation !== 'idle') {
      setAnimation('idle', true)
      return
    }
    showPlaceholder()
  }
  layer.src = assetUrl(animation, config.assetVersion)
}

function showPlaceholder() {
  if (placeholderVisible) return
  placeholderVisible = true
  placeholder.hidden = false
  layers.forEach((layer) => layer.classList.remove('is-active'))
}

function showBubble(view) {
  if (!view) return
  if (config.showBubble === false) return
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  bubble.hidden = false
  bubble.classList.toggle('is-failed', view.outcome === 'failed')
  bubble.classList.toggle('is-interrupted', view.outcome === 'interrupted')
  bubbleTitle.textContent = view.title || '运行完成'
  bubbleDuration.textContent = view.duration || ''
  bubbleTokens.textContent = view.tokensText || '0'
  bubbleCost.textContent = view.costText || '$0'

  const detailLines = []
  const breakdown = view.breakdown || {}
  const tokenParts = []
  if (breakdown.input && breakdown.input !== '0') tokenParts.push('输入 ' + breakdown.input)
  if (breakdown.output && breakdown.output !== '0') tokenParts.push('输出 ' + breakdown.output)
  if (breakdown.reasoning && breakdown.reasoning !== '0') tokenParts.push('推理 ' + breakdown.reasoning)
  if (tokenParts.length) detailLines.push(tokenParts.join(' · '))
  if (Number(view.cache) > 0) {
    detailLines.push('缓存 ' + view.cacheText + '（读 ' + breakdown.cacheRead + ' · 写 ' + breakdown.cacheWrite + '）')
  }
  bubbleDetail.textContent = detailLines.join('\n')

  if (view.outcome === 'failed' && view.error) {
    bubbleError.hidden = false
    bubbleError.textContent = view.error
  } else {
    bubbleError.hidden = true
    bubbleError.textContent = ''
  }

  bubbleTotal.textContent =
    view.showTotal && view.totalTokensText
      ? '累计 ' + view.totalTokensText + ' tokens · ' + view.totalCostText
      : ''

  stage.classList.add('is-bubbled')
  requestAnimationFrame(() => bubble.classList.add('is-visible'))
}

function hideBubble() {
  stage.classList.remove('is-bubbled')
  if (!bubble.classList.contains('is-visible')) {
    bubble.hidden = true
    return
  }
  bubble.classList.remove('is-visible')
  hideTimer = setTimeout(() => {
    bubble.hidden = true
    hideTimer = null
  }, 160)
}

function dismissBubble() {
  hideBubble()
  try {
    Promise.resolve(api.dismissBubble()).catch(() => {})
  } catch {}
}

function setupInteraction() {
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    const element = document.elementFromPoint(event.clientX, event.clientY)
    if (!element?.closest('#pet-wrap')) return
    showGear()
  })

  petWrap.addEventListener('click', (event) => {
    if (event.button !== 0) return
    hideGear()
    const action = config.clickAction || 'smug'
    if (action === 'settings') {
      fire(api.openSettings())
      return
    }
    if (action === 'smug' && !snapshot.running) {
      localSmugUntil = Date.now() + 2400
      setAnimation('smug', true)
      fire(api.petClick('smug'))
      setTimeout(() => {
        localSmugUntil = 0
        if (snapshot.animation) setAnimation(snapshot.animation)
      }, 2450)
    }
  })

  bubble.addEventListener('click', (event) => {
    if (event.target === bubbleClose) return
    dismissBubble()
  })

  bubbleClose.addEventListener('click', (event) => {
    event.stopPropagation()
    dismissBubble()
  })

  settingsBtn?.addEventListener('click', (event) => {
    event.stopPropagation()
    hideGear()
    fire(api.openSettings())
  })

  placeholder.addEventListener('click', () => {
    fire(api.openSettings())
  })
}

function showGear(ms = 8000) {
  petWrap.classList.add('show-settings')
  if (gearTimer) clearTimeout(gearTimer)
  gearTimer = setTimeout(() => {
    gearTimer = null
    petWrap.classList.remove('show-settings')
  }, ms)
}

function hideGear() {
  if (gearTimer) clearTimeout(gearTimer)
  gearTimer = null
  petWrap.classList.remove('show-settings')
}

function fire(promise) {
  try {
    Promise.resolve(promise).catch(() => {})
  } catch {}
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Browser preview (no preload). Open pet.html?demo=1 to watch the animation.
// ---------------------------------------------------------------------------

function createDemoApi() {
  const listeners = { config: [], state: [], bubble: [], hide: [] }
  const demoConfig = { ...DEFAULT_CONFIG, assetVersion: 1 }
  let demoState = {
    animation: 'idle',
    statusText: '待机中',
    model: 'deepseek/deepseek-flash',
    connected: true,
    running: false,
  }
  const emit = (name, value) => listeners[name].forEach((cb) => cb(value))
  const setState = (patch) => {
    demoState = { ...demoState, ...patch }
    emit('state', demoState)
  }
  const showDemoBubble = () => {
    emit('bubble', {
      id: 'demo',
      outcome: 'succeeded',
      title: '运行完成',
      duration: '12.4s',
      tokens: 12345,
      tokensText: '12,345',
      breakdown: {
        input: '10,000',
        output: '2,000',
        reasoning: '345',
        cacheRead: '1,234,567',
        cacheWrite: '0',
      },
      cache: 1234567,
      cacheText: '1,234,567',
      cost: 0.0518,
      costText: '$0.0518',
      totalTokensText: '1,246,912',
      totalCostText: '$1.2840',
      showTotal: true,
      error: '',
    })
  }

  if (demoMode) {
    const run = () => {
      setState({ running: true, connected: true, animation: 'think', statusText: '思考中' })
      setTimeout(() => setState({ animation: 'penIdle', statusText: '拿笔待机' }), 2200)
      setTimeout(() => setState({ animation: 'drawIntermittent', statusText: '绘制中' }), 3300)
      setTimeout(() => setState({ animation: 'drawContinuous', statusText: '连续绘制中' }), 5100)
      setTimeout(() => {
        setState({ running: false, animation: 'expect', statusText: '运行完成' })
        showDemoBubble()
      }, 7600)
      setTimeout(() => setState({ animation: 'idle', statusText: '待机中' }), 12200)
    }
    setTimeout(run, 900)
    setInterval(run, 16000)
  }

  return {
    platform: 'demo',
    getConfig: async () => demoConfig,
    setConfig: async (patch) => {
      Object.assign(demoConfig, patch || {})
      emit('config', demoConfig)
      return demoConfig
    },
    resetConfig: async () => demoConfig,
    openSettings: async () => {
      alert('这是浏览器预览模式。设置窗口在 OpenCode 桌面端中打开。')
    },
    closeSettings: async () => {},
    setIgnoreMouse: async () => {},
    petClick: async () => {},
    dismissBubble: async () => emit('hide'),
    browseRes: async () => null,
    reloadAssets: async () => ({ ok: 7, missing: [] }),
    openRes: async () => {},
    openLog: async () => {},
    testConnection: async () => ({ ok: true, active: [] }),
    testBubble: async () => {
      showDemoBubble()
      return true
    },
    getRuntime: async () => ({ demo: true }),
    onConfig: (cb) => listeners.config.push(cb),
    onState: (cb) => listeners.state.push(cb),
    onBubble: (cb) => listeners.bubble.push(cb),
    onBubbleHide: (cb) => listeners.hide.push(cb),
  }
}
