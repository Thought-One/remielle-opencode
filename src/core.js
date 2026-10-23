'use strict'

/**
 * Remielle pet core.
 *
 * Everything in this file is deliberately free of Electron/Node APIs so the
 * state machine can be unit tested with plain `node scripts/test-core.mjs`.
 * `scripts/build.mjs` inlines this file into the extension `main.js`.
 */

const ASSET_FILES = Object.freeze({
  idle: 'idle.gif',
  penIdle: 'pen-idle.gif',
  think: 'think.gif',
  drawIntermittent: 'draw-intermittent.gif',
  drawContinuous: 'draw-continuous.gif',
  expect: 'expect.gif',
  smug: 'smug.gif',
})

const ASSET_ALIASES = Object.freeze({
  idle: ['待机.gif', '待机.GIF', 'idle.gif', 'idle.GIF'],
  penIdle: ['拿笔待机.gif', '拿笔待机.GIF', 'pen-idle.gif', 'pen_idle.gif', 'penidle.gif', 'penIdle.gif'],
  think: ['思考.gif', '思考.GIF', 'think.gif', 'thinking.gif'],
  drawIntermittent: ['间歇绘制.gif', '间歇绘制.GIF', 'draw-intermittent.gif', 'draw_intermittent.gif', 'intermittent.gif'],
  drawContinuous: ['连续绘制.gif', '连续绘制.GIF', 'draw-continuous.gif', 'draw_continuous.gif', 'continuous.gif'],
  expect: ['期待.gif', '期待.GIF', 'expect.gif', 'wait.gif'],
  smug: ['得意.gif', '得意.GIF', 'smug.gif', 'proud.gif'],
})

const DEFAULT_FILE_TOOLS = Object.freeze([
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
])

const DEFAULT_CONFIG = Object.freeze({
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
  fileTools: DEFAULT_FILE_TOOLS,
  resPath: '',
  subagentBubbles: false,
  debug: false,
})

const ZERO_TOKENS = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function cloneTokens(tokens) {
  const t = tokens || {}
  const cache = t.cache || {}
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cache: { read: num(cache.read), write: num(cache.write) },
  }
}

function normalizeUsage(usage) {
  const u = usage || {}
  const tokens = u.tokens || {}
  return {
    cost: num(u.cost),
    tokens: cloneTokens(tokens),
  }
}

function addTokens(a, b) {
  const x = cloneTokens(a)
  const y = cloneTokens(b)
  return {
    input: x.input + y.input,
    output: x.output + y.output,
    reasoning: x.reasoning + y.reasoning,
    cache: { read: x.cache.read + y.cache.read, write: x.cache.write + y.cache.write },
  }
}

function subTokens(a, b) {
  const x = cloneTokens(a)
  const y = cloneTokens(b)
  return {
    input: Math.max(0, x.input - y.input),
    output: Math.max(0, x.output - y.output),
    reasoning: Math.max(0, x.reasoning - y.reasoning),
    cache: {
      read: Math.max(0, x.cache.read - y.cache.read),
      write: Math.max(0, x.cache.write - y.cache.write),
    },
  }
}

/** Tokens billed as new output context: input + output + reasoning. */
function tokensTotal(tokens) {
  const t = cloneTokens(tokens)
  return t.input + t.output + t.reasoning
}

function cacheTotal(tokens) {
  const t = cloneTokens(tokens)
  return t.cache.read + t.cache.write
}

function formatNumber(value) {
  const n = Math.round(num(value))
  return n.toLocaleString('en-US')
}

function formatCompact(value) {
  const n = num(value)
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

function formatCost(value) {
  const n = Math.max(0, Number(value) || 0)
  if (n === 0) return '$0'
  if (n >= 1) return '$' + n.toFixed(2)
  if (n >= 0.01) return '$' + n.toFixed(4)
  return '$' + n.toFixed(6)
}

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 1000) return (n / 1000).toFixed(1) + 's'
  if (n < 60_000) return (n / 1000).toFixed(1) + 's'
  const minutes = Math.floor(n / 60_000)
  const seconds = Math.round((n % 60_000) / 1000)
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatModel(model) {
  if (!model) return ''
  if (typeof model === 'string') return model
  const provider = model.providerID || model.provider || ''
  const id = model.id || model.modelID || model.name || ''
  if (provider && id) return `${provider}/${id}`
  return id || provider || ''
}

function isFileTool(name, config) {
  if (!name) return false
  const normalized = String(name).trim().toLowerCase()
  const tools = Array.isArray(config?.fileTools) ? config.fileTools : DEFAULT_FILE_TOOLS
  return tools.some((tool) => String(tool).trim().toLowerCase() === normalized)
}

function cleanTitle(text, max = 90) {
  if (!text) return ''
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function makeSession(id) {
  return {
    id,
    running: false,
    startedAt: 0,
    lastAt: 0,
    lastType: '',
    model: null,
    agent: null,
    title: '',
    thinking: false,
    thinkingAt: 0,
    tool: null,
    toolAt: 0,
    lastFileAt: 0,
    fileOps: [],
    drawMode: 'intermittent',
    drawUntil: 0,
    tools: new Map(),
    usage: null,
    baseline: null,
    runTokens: ZERO_TOKENS(),
    runCost: 0,
    lastError: '',
    outcome: '',
  }
}

class PetState {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.sessions = new Map()
    this.bubbles = []
    this.expectUntil = 0
    this.smugUntil = 0
    this.connected = false
    this.lastEventAt = 0
    this.lastError = ''
    this.seq = 0
  }

  setConfig(config) {
    this.config = { ...this.config, ...(config || {}) }
    if (!Array.isArray(this.config.fileTools) || this.config.fileTools.length === 0) {
      this.config.fileTools = [...DEFAULT_FILE_TOOLS]
    }
    return this.config
  }

  setConnected(connected) {
    this.connected = !!connected
  }

  ensure(id) {
    if (!id) return null
    let session = this.sessions.get(id)
    if (!session) {
      session = makeSession(id)
      this.sessions.set(id, session)
    }
    if (this.sessions.size > 64) {
      const idle = [...this.sessions.values()]
        .filter((s) => !s.running)
        .sort((a, b) => a.lastAt - b.lastAt)
      while (this.sessions.size > 48 && idle.length) {
        this.sessions.delete(idle.shift().id)
      }
    }
    return session
  }

  touch(session, type, now) {
    session.lastAt = now
    session.lastType = type
    this.lastEventAt = now
  }

  setUsage(id, usage, now = Date.now()) {
    const session = this.ensure(id)
    if (!session) return
    const next = normalizeUsage(usage)
    if (session.running && !session.baseline && session.usage) {
      session.baseline = normalizeUsage(session.usage)
    }
    session.usage = next
    this.touch(session, 'usage', now)
  }

  setBaseline(id, usage) {
    const session = this.ensure(id)
    if (!session) return
    session.baseline = normalizeUsage(usage)
  }

  setSessionMeta(id, info) {
    const session = this.ensure(id)
    if (!session || !info) return
    if (info.model) session.model = info.model
    if (info.title) session.title = cleanTitle(info.title)
    if (info.agent) session.agent = info.agent
    if (info.tokens || info.cost !== undefined) {
      session.usage = normalizeUsage({ cost: info.cost, tokens: info.tokens })
    }
    if (info.time?.created) session.startedAt = session.startedAt || info.time.created
  }

  markRunning(id, now = Date.now()) {
    const session = this.ensure(id)
    if (!session) return null
    if (!session.running) {
      session.running = true
      session.startedAt = now
      session.baseline = session.usage ? normalizeUsage(session.usage) : null
      session.runTokens = ZERO_TOKENS()
      session.runCost = 0
      session.outcome = ''
      session.thinking = true
      session.thinkingAt = now
      session.tool = null
      session.fileOps = []
      session.drawUntil = 0
    }
    session.lastAt = now
    this.expectUntil = 0
    return session
  }

  markIdle(id, outcome = 'idle', now = Date.now(), error = '') {
    const session = this.ensure(id)
    if (!session || !session.running) return null
    return this.finishRun(session, outcome, now, error)
  }

  syncActive(ids, now = Date.now()) {
    const running = new Set(ids || [])
    for (const session of this.sessions.values()) {
      if (!session.running || running.has(session.id)) continue
      // Give a just-started execution a moment to appear in the active set.
      if (now - session.lastAt > 5000) {
        session.running = false
        session.thinking = false
        session.tool = null
        session.drawUntil = 0
      }
    }
    for (const id of running) {
      const session = this.ensure(id)
      if (!session.running) {
        this.markRunning(id, now)
        this.touch(session, 'sync', now)
      }
    }
  }

  addFileOperation(session, now) {
    const windowMs = Math.max(1000, num(this.config.continuousWindow) || 7000)
    const count = Math.max(1, Math.round(num(this.config.continuousCount) || 3))
    const hold = Math.max(300, num(this.config.drawHoldMs) || 2000)
    session.fileOps = session.fileOps.filter((t) => now - t <= windowMs)
    session.fileOps.push(now)
    session.lastFileAt = now
    session.drawMode = session.fileOps.length >= count ? 'continuous' : 'intermittent'
    session.drawUntil = now + hold
  }

  // ---- Events -----------------------------------------------------------

  handle(event, now = Date.now()) {
    if (!event || !event.type) return { changed: false, bubbles: [] }
    this.lastEventAt = now
    const data = event.data || {}
    const id = data.sessionID
    let changed = false

    switch (event.type) {
      case 'session.execution.started': {
        if (!id) break
        const session = this.markRunning(id, now)
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.execution.succeeded': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.outcome = 'succeeded'
        session.thinking = false
        session.tool = null
        this.touch(session, event.type, now)
        if (session.running) {
          this.finishRun(session, 'succeeded', now)
          changed = true
        }
        break
      }
      case 'session.execution.failed': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.outcome = 'failed'
        session.lastError = String(data.error?.message || data.error || '运行失败')
        this.touch(session, event.type, now)
        if (session.running) {
          this.finishRun(session, 'failed', now, session.lastError)
          changed = true
        }
        break
      }
      case 'session.execution.interrupted': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.outcome = 'interrupted'
        this.touch(session, event.type, now)
        if (session.running) {
          this.finishRun(session, 'interrupted', now)
          changed = true
        }
        break
      }
      case 'session.step.started': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        if (!session.running) this.markRunning(id, now)
        if (data.model) session.model = data.model
        if (data.agent) session.agent = data.agent
        session.thinking = true
        session.thinkingAt = now
        session.tool = null
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.reasoning.started': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.thinking = true
        session.thinkingAt = now
        session.tool = null
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.reasoning.delta': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.thinking = true
        session.thinkingAt = now
        this.touch(session, event.type, now)
        break
      }
      case 'session.reasoning.ended': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.thinking = false
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.text.started':
      case 'session.text.delta': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.thinking = false
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.tool.input.started': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        if (data.id) session.tools.set(data.id, data.name || '')
        if (session.tools.size > 80) {
          const first = session.tools.keys().next().value
          session.tools.delete(first)
        }
        session.tool = { id: data.id || '', name: data.name || '', at: now }
        session.thinking = false
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.tool.called': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        const name = session.tools.get(data.id) || data.name || ''
        session.tool = { id: data.id || '', name: data.name || name, at: now }
        session.thinking = false
        if (isFileTool(name, this.config)) this.addFileOperation(session, now)
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        const name = session.tools.get(data.id) || session.tool?.name || ''
        if (isFileTool(name, this.config)) {
          session.drawUntil = Math.max(session.drawUntil, now + 700)
        }
        session.tool = null
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.step.ended': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.thinking = false
        session.tool = null
        if (data.cost !== undefined) session.runCost += num(data.cost)
        if (data.tokens) session.runTokens = addTokens(session.runTokens, data.tokens)
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.usage.updated':
      case 'session.usage.recorded': {
        if (!id) break
        this.setUsage(id, { cost: data.cost, tokens: data.tokens }, now)
        changed = true
        break
      }
      case 'session.model.selected':
      case 'session.agent.selected': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        if (event.type === 'session.model.selected' && data.model) session.model = data.model
        if (event.type === 'session.agent.selected' && data.agent) session.agent = data.agent
        this.touch(session, event.type, now)
        changed = true
        break
      }
      case 'session.status': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        const status = data.status?.type || data.status
        if (status === 'busy' || status === 'retry') {
          if (!session.running) this.markRunning(id, now)
          this.touch(session, event.type, now)
          changed = true
        }
        break
      }
      case 'session.idle': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.thinking = false
        session.tool = null
        this.touch(session, event.type, now)
        if (session.running) {
          this.finishRun(session, session.outcome || 'succeeded', now, session.lastError)
          changed = true
        }
        break
      }
      case 'session.error': {
        if (!id) break
        const session = this.ensure(id)
        if (!session) break
        session.lastError = String(data.error?.message || data.message || data.error || '模型调用失败')
        this.lastError = session.lastError
        this.touch(session, event.type, now)
        changed = true
        break
      }
      default:
        break
    }

    return { changed, bubbles: this.bubbles.slice() }
  }

  finishRun(session, outcome, now, error = '') {
    session.running = false
    session.thinking = false
    session.tool = null
    session.drawUntil = 0
    session.lastAt = now
    session.outcome = outcome

    const baseline = session.baseline
    const usage = session.usage
    let cost
    let tokens

    if (baseline && usage) {
      cost = Math.max(0, usage.cost - baseline.cost)
      tokens = subTokens(usage.tokens, baseline.tokens)
      if (cost === 0 && session.runCost > 0) cost = session.runCost
      if (tokensTotal(tokens) === 0 && tokensTotal(session.runTokens) > 0) tokens = session.runTokens
    } else {
      cost = session.runCost
      tokens = session.runTokens
    }

    const totalCost = usage ? usage.cost : cost
    const totalTokens = usage ? usage.tokens : tokens
    const durationMs = Math.max(0, now - (session.startedAt || now))

    const bubble = {
      id: `bub_${++this.seq}_${now.toString(36)}`,
      sessionID: session.id,
      outcome,
      error: error ? cleanTitle(error, 220) : '',
      durationMs,
      cost: num(cost),
      tokens: cloneTokens(tokens),
      totalCost: num(totalCost),
      totalTokens: cloneTokens(totalTokens),
      model: formatModel(session.model),
      title: session.title || '',
      at: now,
    }

    this.bubbles.push(bubble)
    if (this.bubbles.length > 8) this.bubbles.shift()
    this.expectUntil = now + Math.max(500, (num(this.config.expectSeconds) || 4.5) * 1000)
    session.baseline = usage ? normalizeUsage(usage) : session.baseline
    session.runTokens = ZERO_TOKENS()
    session.runCost = 0
    return bubble
  }

  takeBubble() {
    return this.bubbles.shift() || null
  }

  clearBubbles() {
    this.bubbles = []
  }

  triggerSmug(now = Date.now()) {
    if (this.hasActive(now)) return false
    this.smugUntil = now + 2500
    return true
  }

  hasActive(now = Date.now()) {
    for (const session of this.sessions.values()) {
      if (session.running) return true
    }
    return false
  }

  prune(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (!session.running && now - session.lastAt > 6 * 60 * 60 * 1000) {
        this.sessions.delete(id)
      }
    }
  }

  snapshot(now = Date.now()) {
    this.prune(now)
    const active = [...this.sessions.values()]
      .filter((s) => s.running)
      .sort((a, b) => b.lastAt - a.lastAt)

    let animation = 'idle'
    let statusText = '待机中'
    let driving = null

    if (active.length > 0) {
      const drawing = active
        .filter((s) => s.drawUntil > now)
        .sort((a, b) => b.drawUntil - a.drawUntil)[0]
      const thinking = active
        .filter((s) => s.thinking)
        .sort((a, b) => b.thinkingAt - a.thinkingAt)[0]
      driving = drawing || thinking || active[0]

      if (drawing) {
        animation = drawing.drawMode === 'continuous' ? 'drawContinuous' : 'drawIntermittent'
        statusText = drawing.drawMode === 'continuous' ? '连续绘制中' : '绘制中'
      } else if (thinking) {
        animation = 'think'
        statusText = '思考中'
      } else {
        animation = 'penIdle'
        statusText = '拿笔待机'
      }
    } else if (this.expectUntil > now) {
      animation = 'expect'
      statusText = '运行完成'
      driving = [...this.sessions.values()].sort((a, b) => b.lastAt - a.lastAt)[0] || null
    } else if (this.smugUntil > now) {
      animation = 'smug'
      statusText = '得意'
    }

    return {
      animation,
      statusText,
      model: driving ? formatModel(driving.model) : '',
      agent: driving?.agent || '',
      title: driving?.title || '',
      running: active.length > 0,
      activeCount: active.length,
      sessionID: driving?.id || '',
      connected: this.connected,
      expect: this.expectUntil > now,
      smug: this.smugUntil > now,
      tokens: driving?.usage?.tokens ? cloneTokens(driving.usage.tokens) : ZERO_TOKENS(),
      cost: num(driving?.usage?.cost),
      lastAt: this.lastEventAt,
      lastError: this.lastError,
    }
  }

  bubbleView(bubble, config = this.config) {
    if (!bubble) return null
    const titleByOutcome = {
      succeeded: '运行完成',
      failed: '运行失败',
      interrupted: '运行已中断',
      idle: '运行完成',
    }
    const showTotal = config.showTotal !== false
    return {
      id: bubble.id,
      sessionID: bubble.sessionID,
      outcome: bubble.outcome,
      title: titleByOutcome[bubble.outcome] || '运行完成',
      subtitle: bubble.title || '',
      error: bubble.error || '',
      duration: formatDuration(bubble.durationMs),
      durationMs: bubble.durationMs,
      tokens: tokensTotal(bubble.tokens),
      tokensText: formatNumber(tokensTotal(bubble.tokens)),
      tokensCompact: formatCompact(tokensTotal(bubble.tokens)),
      breakdown: {
        input: formatNumber(bubble.tokens.input),
        output: formatNumber(bubble.tokens.output),
        reasoning: formatNumber(bubble.tokens.reasoning),
        cacheRead: formatNumber(bubble.tokens.cache.read),
        cacheWrite: formatNumber(bubble.tokens.cache.write),
      },
      cache: cacheTotal(bubble.tokens),
      cacheText: formatNumber(cacheTotal(bubble.tokens)),
      cost: bubble.cost,
      costText: formatCost(bubble.cost),
      totalTokens: tokensTotal(bubble.totalTokens),
      totalTokensText: formatNumber(tokensTotal(bubble.totalTokens)),
      totalCost: bubble.totalCost,
      totalCostText: formatCost(bubble.totalCost),
      showTotal,
      model: bubble.model || '',
    }
  }
}

// ---- SSE ---------------------------------------------------------------

function createSSEParser(onEvent) {
  let buffer = ''
  return function push(chunk) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    buffer = buffer.replace(/\r\n/g, '\n')
    let index
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      parseBlock(block, onEvent)
    }
  }
}

function parseBlock(block, onEvent) {
  if (!block || !block.trim()) return
  const data = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') continue
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    data.push(value)
  }
  if (data.length === 0) return
  const text = data.join('\n')
  if (!text || text === '[DONE]') return
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // Ignore malformed frames, the stream can recover.
    return
  }
  onEvent(parsed)
}

module.exports = {
  ASSET_FILES,
  ASSET_ALIASES,
  DEFAULT_FILE_TOOLS,
  DEFAULT_CONFIG,
  ZERO_TOKENS,
  PetState,
  normalizeUsage,
  cloneTokens,
  addTokens,
  subTokens,
  tokensTotal,
  cacheTotal,
  formatNumber,
  formatCompact,
  formatCost,
  formatDuration,
  formatModel,
  isFileTool,
  makeSession,
  createSSEParser,
}
