import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from './build.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = path.join(os.tmpdir(), 'opencode', 'remielle-main-test-' + process.pid)
const userData = path.join(temp, 'userData')

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else fs.copyFileSync(source, target)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Fake Electron
// ---------------------------------------------------------------------------

class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super()
    this.owner = owner
    this.sent = []
    this.url = 'file:///fake/index.html'
  }
  send(channel, payload) {
    this.sent.push({ channel, payload })
  }
  setWindowOpenHandler() {}
  executeJavaScript(script) {
    if (String(script).includes('textarea')) {
      return Promise.resolve({
        control: { left: 400, right: 880, top: 710, bottom: 770, width: 480, height: 60 },
        box: { left: 400, right: 880, top: 700, bottom: 780, width: 480, height: 80 },
        viewport: { width: 1280, height: 820 },
      })
    }
    return Promise.resolve({})
  }
  getZoomFactor() {
    return 1
  }
  getURL() {
    return this.url
  }
  isDestroyed() {
    return this.owner.isDestroyed()
  }
}

let windowSeq = 0
const windows = []

class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super()
    this.id = ++windowSeq
    this.options = options
    this.destroyed = false
    this.visible = false
    this.minimized = false
    this.bounds = { x: 40, y: 60, width: options.width || 300, height: options.height || 430 }
    this.contentBounds = { x: 0, y: 0, width: 1280, height: 820 }
    this.opacity = 1
    this.backgroundColors = []
    this.backgroundValue = '#00000000'
    this.webContents = new FakeWebContents(this)
    windows.push(this)
  }
  loadFile(file) {
    this.loadedFile = file
    this.webContents.url = 'file://' + file.replace(/\\/g, '/')
    setTimeout(() => {
      if (!this.destroyed) this.webContents.emit('did-finish-load')
    }, 15)
    return Promise.resolve()
  }
  loadURL(url) {
    this.webContents.url = url
    setTimeout(() => {
      if (!this.destroyed) this.webContents.emit('did-finish-load')
    }, 15)
    return Promise.resolve()
  }
  setMenuBarVisibility() {}
  setIgnoreMouseEvents(value) {
    this.ignoreMouse = value
  }
  setBackgroundColor(value) {
    this.backgroundValue = value
    this.backgroundColors.push(value)
  }
  setOpacity(value) {
    this.opacity = value
  }
  setBounds(bounds) {
    this.bounds = { ...bounds }
  }
  getBounds() {
    return { ...this.bounds }
  }
  getContentBounds() {
    return { ...this.contentBounds }
  }
  showInactive() {
    this.visible = true
  }
  show() {
    this.visible = true
  }
  hide() {
    this.visible = false
  }
  focus() {}
  isVisible() {
    return this.visible
  }
  isFocused() {
    return globalThis.__fakeFocusedWindow === this
  }
  isMinimized() {
    return this.minimized
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
  close() {
    this.destroy()
  }
  getTitle() {
    return this.options.title || 'OpenCode'
  }
  setAlwaysOnTop() {}
  static getAllWindows() {
    return windows.filter((win) => !win.destroyed)
  }
  static getFocusedWindow() {
    return windows.find((win) => !win.destroyed && win === globalThis.__fakeFocusedWindow) || null
  }
}

const ipcHandlers = new Map()
const ipcMain = {
  handle(channel, handler) {
    ipcHandlers.set(channel, handler)
  },
  removeHandler(channel) {
    ipcHandlers.delete(channel)
  },
  async invoke(channel, event, payload) {
    const handler = ipcHandlers.get(channel)
    if (!handler) throw new Error('no handler ' + channel)
    return handler(event, payload)
  },
}

const fakeApp = new EventEmitter()
fakeApp.getPath = (name) => (name === 'userData' ? userData : temp)
fakeApp.whenReady = () => Promise.resolve()
fakeApp.getVersion = () => '2.1.2'
fakeApp.isPackaged = true
fakeApp.removeListener = EventEmitter.prototype.removeListener

const electron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  ipcMain,
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayMatching: () => ({
      workAreaSize: { width: 1280, height: 900 },
      bounds: { x: 0, y: 0, width: 1280, height: 900 },
    }),
    getPrimaryDisplay: () => ({
      workAreaSize: { width: 1280, height: 900 },
      bounds: { x: 0, y: 0, width: 1280, height: 900 },
    }),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  shell: {
    openPath: async () => '',
  },
}

// ---------------------------------------------------------------------------
// Fake OpenCode server
// ---------------------------------------------------------------------------

const sessionInfo = {
  id: 'ses_test',
  projectID: 'proj_test',
  cost: 0.01,
  tokens: { input: 500, output: 50, reasoning: 10, cache: { read: 1000, write: 0 } },
  model: { providerID: 'deepseek', id: 'deepseek-flash' },
  title: 'Main test session',
  time: { created: Date.now(), updated: Date.now() },
  location: { directory: root },
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/event') {
    assert.equal(req.headers.authorization, 'Basic dGVzdDp0ZXN0')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event) => res.write('data: ' + JSON.stringify(event) + '\n\n')
    send({ id: 'e0', type: 'server.connected', data: {} })
    setTimeout(() => send({ id: 'e1', type: 'session.execution.started', data: { sessionID: 'ses_test' } }), 80)
    setTimeout(() => {
      send({
        id: 'e2',
        type: 'session.step.started',
        data: { sessionID: 'ses_test', agent: 'build', model: { providerID: 'deepseek', id: 'deepseek-flash' } },
      })
    }, 120)
    setTimeout(() => send({ id: 'e3', type: 'session.reasoning.started', data: { sessionID: 'ses_test' } }), 160)
    setTimeout(() => {
      send({ id: 'e4', type: 'session.tool.input.started', data: { sessionID: 'ses_test', id: 'call_1', name: 'write' } })
      send({ id: 'e5', type: 'session.tool.called', data: { sessionID: 'ses_test', id: 'call_1', input: {} } })
    }, 220)
    setTimeout(() => {
      sessionInfo.cost = 0.02
      sessionInfo.tokens = { input: 700, output: 70, reasoning: 20, cache: { read: 1500, write: 0 } }
      send({ id: 'e6', type: 'session.step.ended', data: { sessionID: 'ses_test', cost: 0.01, tokens: { input: 200, output: 20, reasoning: 10, cache: { read: 500, write: 0 } } } })
      send({ id: 'e7', type: 'session.usage.updated', data: { sessionID: 'ses_test', cost: 0.02, tokens: sessionInfo.tokens } })
    }, 280)
    setTimeout(() => send({ id: 'e8', type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } }), 330)
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 1000)
    req.on('close', () => clearInterval(heartbeat))
    return
  }
  if (req.url === '/api/session/active') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: {} }))
    return
  }
  if (req.url.startsWith('/api/session/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: sessionInfo }))
    return
  }
  res.writeHead(404)
  res.end('nope')
})

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

rm(temp)
fs.mkdirSync(userData, { recursive: true })

const built = build()
const runtime = path.join(userData, 'remielle-pet')
copyDir(path.join(built.staging, 'runtime', 'app'), path.join(runtime, 'app'))
fs.copyFileSync(path.join(built.staging, 'runtime', 'preload.js'), path.join(runtime, 'preload.js'))
fs.writeFileSync(
  path.join(runtime, 'install.json'),
  JSON.stringify({ projectDir: root, resPath: path.join(root, 'res'), version: '1.0.0' }, null, 2),
)

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const mainWindow = new FakeBrowserWindow({ width: 1280, height: 820, title: 'OpenCode' })
mainWindow.visible = true
globalThis.__fakeFocusedWindow = mainWindow

let cleanup = null
const openListeners = []
const ctx = {
  id: 'remielle.pet',
  serverEndpoints: {
    get: (name) =>
      name === 'sidecar'
        ? {
            id: 'sidecar',
            url: 'http://127.0.0.1:' + port,
            headers: { authorization: 'Basic ' + Buffer.from('test:test').toString('base64') },
            local: true,
          }
        : undefined,
  },
  windows: {
    list: () => [mainWindow],
    focused: () => mainWindow,
    get: (id) => (mainWindow.id === id ? mainWindow : undefined),
    on: (event, callback) => {
      if (event === 'open') {
        openListeners.push(callback)
        return () => {}
      }
      return () => {}
    },
  },
  scope: {
    contribute: (fn) => {
      cleanup = fn
    },
    signal: new AbortController().signal,
  },
  log: { write: () => {} },
}

const code = fs.readFileSync(path.join(built.staging, 'main.js'), 'utf8')
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(
  (id) => {
    if (id === 'electron') return electron
    return require(id)
  },
  mod,
  mod.exports,
)
assert.equal(typeof mod.exports.default, 'function')

await mod.exports.default(ctx)
await sleep(1600)

const petWindow = windows.find((win) => win !== mainWindow)
assert.ok(petWindow, 'pet window should be created')
assert.equal(petWindow.options.parent, undefined)
assert.equal(petWindow.options.transparent, true)
assert.equal(petWindow.options.alwaysOnTop, true)
assert.equal(petWindow.options.focusable, false)
assert.ok(petWindow.bounds.x > 800, 'pet should sit beside the composer: ' + petWindow.bounds.x)

// Simulate OpenCode's theme pass, which sets the background on every window.
petWindow.setBackgroundColor('#202127')
assert.equal(petWindow.backgroundValue, '#00000000')
assert.ok(petWindow.loadedFile.endsWith('pet.html'))
assert.equal(petWindow.visible, true)
assert.ok(petWindow.bounds.width > 0 && petWindow.bounds.height > 0)
assert.ok(petWindow.bounds.x < mainWindow.contentBounds.width)

const messages = petWindow.webContents.sent
const states = messages.filter((message) => message.channel === 'remielle:state').map((message) => message.payload)
const animations = states.map((state) => state.animation)
assert.ok(animations.includes('think'), 'should show thinking: ' + animations.join(','))
assert.ok(
  animations.includes('drawIntermittent'),
  'should show intermittent drawing: ' + animations.join(','),
)

const bubbles = messages.filter((message) => message.channel === 'remielle:bubble').map((message) => message.payload)
assert.ok(bubbles.length >= 1, 'should show a bubble')
const bubble = bubbles[bubbles.length - 1]
assert.equal(bubble.outcome, 'succeeded')
assert.equal(bubble.cost, 0.01)
assert.equal(bubble.costText, '$0.0100')
assert.equal(bubble.tokensText, '230')
assert.equal(bubble.totalTokensText, '790')
assert.equal(bubble.totalCostText, '$0.0200')

const configMessages = messages.filter((message) => message.channel === 'remielle:config')
assert.ok(configMessages.length >= 1, 'pet should receive config')
const publicConfig = configMessages[configMessages.length - 1].payload
assert.equal(publicConfig.enabled, true)
assert.equal(publicConfig.assets?.think, 'think.gif')

for (const file of [
  'idle.gif',
  'pen-idle.gif',
  'think.gif',
  'draw-intermittent.gif',
  'draw-continuous.gif',
  'expect.gif',
  'smug.gif',
]) {
  assert.ok(fs.existsSync(path.join(runtime, 'assets', file)), 'asset should be synced: ' + file)
}

const configFile = JSON.parse(fs.readFileSync(path.join(runtime, 'config.json'), 'utf8'))
assert.ok(configFile.resPath.endsWith('res'))
assert.ok(fs.existsSync(path.join(runtime, 'remielle.log')))
assert.equal(petWindow.ignoreMouse, true)

const runtimeInfo = await ipcMain.invoke('remielle:get-runtime', { sender: petWindow.webContents })
assert.equal(runtimeInfo.connected, true)
assert.equal(runtimeInfo.extensionID, 'remielle.pet')
assert.ok(runtimeInfo.assets.ok >= 7)

const updated = await ipcMain.invoke('remielle:set-config', { sender: petWindow.webContents }, { scale: 1.2, showBubble: false })
assert.equal(updated.scale, 1.2)
assert.equal(updated.showBubble, false)
await sleep(400)
assert.ok(petWindow.bounds.width > 300, 'window should grow with scale')

// Test the preview bubble even though regular bubbles are now disabled.
const previewShown = await ipcMain.invoke('remielle:test-bubble', { sender: petWindow.webContents })
assert.equal(previewShown, true)
await sleep(50)
const afterPreview = petWindow.webContents.sent.filter((m) => m.channel === 'remielle:bubble')
assert.ok(afterPreview.length >= bubbles.length + 1)

// Settings window lifecycle and IPC.
const opened = await ipcMain.invoke('remielle:open-settings', { sender: petWindow.webContents })
assert.equal(opened, true)
await sleep(120)
const settingsWindow = windows.find((win) => win.loadedFile && win.loadedFile.endsWith('settings.html'))
assert.ok(settingsWindow, 'settings window should be created')
assert.equal(settingsWindow.options.parent, mainWindow)
assert.ok(settingsWindow.webContents.sent.some((m) => m.channel === 'remielle:config'))
await ipcMain.invoke('remielle:close-settings', { sender: settingsWindow.webContents })
await sleep(60)
assert.equal(settingsWindow.destroyed, true)

const connection = await ipcMain.invoke('remielle:test-connection', { sender: petWindow.webContents })
assert.equal(connection.ok, true)
assert.ok(connection.url.includes('127.0.0.1'))

const browse = await ipcMain.invoke('remielle:browse-res', { sender: petWindow.webContents })
assert.equal(browse, null)

if (cleanup) cleanup()
await sleep(250)
server.close()
console.log('main integration test passed')
console.log('  pet windows:', windows.length, 'messages:', messages.length, 'animations:', [...new Set(animations)].join(','))
rm(temp)
