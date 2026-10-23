import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const core = require('../src/core.js')
const {
  PetState,
  DEFAULT_CONFIG,
  createSSEParser,
  formatCost,
  formatNumber,
  formatDuration,
  tokensTotal,
  isFileTool,
} = core

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 1. Full successful run: idle -> think -> draw -> expect -> idle
// ---------------------------------------------------------------------------
{
  const state = new PetState({ ...DEFAULT_CONFIG, bubbleSeconds: 7, expectSeconds: 4.5 })
  const t0 = 1_000_000
  state.setConnected(true)
  assert.equal(state.snapshot(t0).animation, 'idle')

  state.handle({ type: 'session.execution.started', data: { sessionID: 'ses_a' } }, t0)
  assert.equal(state.snapshot(t0).animation, 'think')

  state.handle(
    { type: 'session.step.started', data: { sessionID: 'ses_a', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-flash' } } },
    t0 + 100,
  )
  state.handle({ type: 'session.reasoning.started', data: { sessionID: 'ses_a' } }, t0 + 200)
  assert.equal(state.snapshot(t0 + 200).animation, 'think')
  assert.equal(state.snapshot(t0 + 200).model, 'deepseek/deepseek-flash')

  state.handle({ type: 'session.tool.input.started', data: { sessionID: 'ses_a', id: 'call_1', name: 'write' } }, t0 + 300)
  state.handle({ type: 'session.tool.called', data: { sessionID: 'ses_a', id: 'call_1', input: {} } }, t0 + 320)
  assert.equal(state.snapshot(t0 + 350).animation, 'drawIntermittent')

  state.handle({ type: 'session.tool.success', data: { sessionID: 'ses_a', id: 'call_1' } }, t0 + 500)
  state.handle(
    {
      type: 'session.step.ended',
      data: {
        sessionID: 'ses_a',
        cost: 0.002,
        tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 500, write: 0 } },
      },
    },
    t0 + 600,
  )
  state.handle(
    {
      type: 'session.usage.updated',
      data: {
        sessionID: 'ses_a',
        cost: 0.01,
        tokens: { input: 1000, output: 200, reasoning: 100, cache: { read: 5000, write: 0 } },
      },
    },
    t0 + 620,
  )
  state.handle({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } }, t0 + 700)

  let snap = state.snapshot(t0 + 700)
  assert.equal(snap.animation, 'expect')
  assert.equal(snap.running, false)
  assert.equal(snap.statusText, '运行完成')

  const bubble = state.takeBubble()
  assert.ok(bubble, 'expected a bubble')
  assert.equal(bubble.outcome, 'succeeded')
  assert.equal(bubble.cost, 0.002)
  assert.equal(tokensTotal(bubble.tokens), 130)
  const view = state.bubbleView(bubble)
  assert.equal(view.title, '运行完成')
  assert.equal(view.tokensText, '130')
  assert.equal(view.costText, '$0.002000')
  assert.equal(view.cacheText, '500')

  snap = state.snapshot(t0 + 700 + 4600)
  assert.equal(snap.animation, 'idle')
}

// ---------------------------------------------------------------------------
// 2. Baseline delta: only the current run is counted
// ---------------------------------------------------------------------------
{
  const state = new PetState()
  const t = 2_000_000
  state.setUsage('ses_b', { cost: 0.05, tokens: { input: 500, output: 50, reasoning: 10, cache: { read: 900, write: 0 } } }, t)
  state.handle({ type: 'session.execution.started', data: { sessionID: 'ses_b' } }, t + 10)
  state.setUsage('ses_b', { cost: 0.06, tokens: { input: 700, output: 70, reasoning: 20, cache: { read: 1500, write: 0 } } }, t + 500)
  state.handle({ type: 'session.execution.succeeded', data: { sessionID: 'ses_b' } }, t + 600)
  const bubble = state.takeBubble()
  assert.ok(bubble)
  assert.equal(bubble.cost.toFixed(4), '0.0100')
  assert.equal(tokensTotal(bubble.tokens), 230)
  assert.equal(tokensTotal(bubble.totalTokens), 790)
}

// ---------------------------------------------------------------------------
// 3. Continuous drawing
// ---------------------------------------------------------------------------
{
  const state = new PetState({ continuousCount: 3, continuousWindow: 5000 })
  const t = 3_000_000
  state.handle({ type: 'session.execution.started', data: { sessionID: 'ses_c' } }, t)
  for (let i = 0; i < 3; i++) {
    state.handle({ type: 'session.tool.input.started', data: { sessionID: 'ses_c', id: `c${i}`, name: 'edit' } }, t + 100 + i * 100)
    state.handle({ type: 'session.tool.called', data: { sessionID: 'ses_c', id: `c${i}` } }, t + 120 + i * 100)
  }
  assert.equal(state.snapshot(t + 400).animation, 'drawContinuous')
  assert.equal(state.snapshot(t + 400).statusText, '连续绘制中')
  // After the draw hold expires but while still running, fall back to pen idle.
  assert.equal(state.snapshot(t + 5000).animation, 'penIdle')
}

// ---------------------------------------------------------------------------
// 4. Failure, interruption, idle event de-duplication, smug
// ---------------------------------------------------------------------------
{
  const state = new PetState()
  const t = 4_000_000
  state.handle({ type: 'session.execution.started', data: { sessionID: 'ses_d' } }, t)
  state.handle({ type: 'session.execution.failed', data: { sessionID: 'ses_d', error: { message: 'boom' } } }, t + 100)
  const bubble = state.takeBubble()
  assert.equal(bubble.outcome, 'failed')
  assert.equal(state.bubbleView(bubble).title, '运行失败')
  assert.equal(state.bubbleView(bubble).error, 'boom')
  // A late session.idle must not create a second bubble.
  state.handle({ type: 'session.idle', data: { sessionID: 'ses_d' } }, t + 200)
  assert.equal(state.takeBubble(), null)

  assert.equal(state.triggerSmug(t + 6000), true)
  assert.equal(state.snapshot(t + 6000).animation, 'smug')
  assert.equal(state.snapshot(t + 9000).animation, 'idle')
}

// ---------------------------------------------------------------------------
// 5. Session status busy starts a run; idle is left to the execution events.
// ---------------------------------------------------------------------------
{
  const state = new PetState()
  const t = 5_000_000
  state.handle({ type: 'session.status', data: { sessionID: 'ses_f', status: { type: 'busy' } } }, t)
  assert.equal(state.snapshot(t).running, true)
  assert.equal(state.snapshot(t).animation, 'think')
  state.handle({ type: 'session.status', data: { sessionID: 'ses_f', status: { type: 'idle' } } }, t + 100)
  assert.equal(state.snapshot(t + 100).running, true)
  state.handle({ type: 'session.execution.succeeded', data: { sessionID: 'ses_f' } }, t + 200)
  assert.equal(state.snapshot(t + 200).animation, 'expect')
}

// ---------------------------------------------------------------------------
// 6. SSE frame parsing (including CRLF and split chunks)
// ---------------------------------------------------------------------------
{
  const seen = []
  const push = createSSEParser((event) => seen.push(event))
  const payload = JSON.stringify({ id: 'evt_1', type: 'session.step.started', data: { sessionID: 'ses_e' } })
  push(': heartbeat\r\n\r\ndata: ' + payload + '\r\n\r\n')
  push('data: {"type":"session.step.en')
  push('ded","data":{"sessionID":"ses_e"}}\n\n')
  assert.equal(seen.length, 2)
  assert.equal(seen[0].type, 'session.step.started')
  assert.equal(seen[1].type, 'session.step.ended')
}

// ---------------------------------------------------------------------------
// 7. Formatting / tool matching
// ---------------------------------------------------------------------------
{
  assert.equal(formatNumber(1234567), '1,234,567')
  assert.equal(formatCost(0), '$0')
  assert.equal(formatCost(0.000813534), '$0.000814')
  assert.equal(formatCost(0.051764244), '$0.0518')
  assert.equal(formatCost(2.5), '$2.50')
  assert.equal(formatDuration(830), '0.8s')
  assert.equal(formatDuration(12400), '12.4s')
  assert.equal(formatDuration(83000), '1m 23s')
  assert.equal(isFileTool('write', DEFAULT_CONFIG), true)
  assert.equal(isFileTool('bash', DEFAULT_CONFIG), false)
  assert.equal(isFileTool('BASH', { fileTools: ['bash'] }), true)
}

// ---------------------------------------------------------------------------
// 8. Replay the captured real event stream, if present.
// ---------------------------------------------------------------------------
{
  const capture = join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode', 'sse-capture.txt')
  try {
    const text = readFileSync(capture, 'utf8')
    const state = new PetState()
    const push = createSSEParser((event) => state.handle(event, 10_000_000))
    push(text)
    const snap = state.snapshot(10_000_000)
    assert.ok(snap, 'snapshot from capture')
    console.log('capture replay ok:', snap.animation, snap.model || '(no model)', 'sessions=' + state.sessions.size)
  } catch {
    // The capture is only a local debugging aid.
  }
}

console.log('core tests passed')
