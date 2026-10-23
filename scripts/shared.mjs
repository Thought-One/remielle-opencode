import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const originalEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === 'string' ? warning : warning?.message || ''
  if (text.includes('SQLite is an experimental feature')) return
  return originalEmitWarning.call(process, warning, ...args)
}
const { DatabaseSync, backup } = require('node:sqlite')
const core = require('../src/core.js')
export const { ASSET_FILES, ASSET_ALIASES, DEFAULT_CONFIG } = core

export const EXTENSION_ID = 'remielle.pet'

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1)
    } else {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    }
  }
  return args
}

export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else fs.copyFileSync(source, target)
  }
}

export function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

function hasExtensionTable(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extension'")
      .get()
    return !!row
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

export function findUserData(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.REMIELLE_USER_DATA) candidates.push(process.env.REMIELLE_USER_DATA)
  if (process.env.OPENCODE_DESKTOP_USER_DATA) candidates.push(process.env.OPENCODE_DESKTOP_USER_DATA)

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    candidates.push(path.join(appData, 'ai.opencode.desktop'))
    candidates.push(path.join(appData, '@opencode-aidesktop'))
    candidates.push(path.join(appData, 'OpenCode'))
  } else if (process.platform === 'darwin') {
    const support = path.join(os.homedir(), 'Library', 'Application Support')
    candidates.push(path.join(support, 'ai.opencode.desktop'))
    candidates.push(path.join(support, '@opencode-aidesktop'))
    candidates.push(path.join(support, 'OpenCode'))
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    candidates.push(path.join(configHome, 'ai.opencode.desktop'))
    candidates.push(path.join(configHome, '@opencode-aidesktop'))
    candidates.push(path.join(configHome, 'OpenCode'))
  }

  for (const dir of candidates) {
    if (!dir) continue
    const dbPath = path.join(dir, 'drafts.sqlite')
    if (fs.existsSync(dbPath) && hasExtensionTable(dbPath)) {
      return { dir: path.resolve(dir), dbPath, source: 'candidate' }
    }
  }

  // Last resort: scan the platform application-data root for drafts.sqlite.
  const roots = []
  if (process.platform === 'win32') roots.push(process.env.APPDATA || '')
  else if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Application Support'))
  else roots.push(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!/opencode/i.test(entry.name)) continue
      const dir = path.join(root, entry.name)
      const dbPath = path.join(dir, 'drafts.sqlite')
      if (fs.existsSync(dbPath) && hasExtensionTable(dbPath)) {
        return { dir, dbPath, source: 'scan' }
      }
    }
  }

  return null
}

export function resolveResPath(explicit, projectDir) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.REMIELLE_RES) candidates.push(process.env.REMIELLE_RES)
  if (projectDir) candidates.push(path.join(projectDir, 'res'))
  candidates.push(path.join(process.cwd(), 'res'))

  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    if (!fs.existsSync(resolved)) continue
    if (!fs.statSync(resolved).isDirectory()) continue
    const names = fs.readdirSync(resolved)
    const lower = new Set(names.map((name) => name.toLowerCase()))
    const hasAny = Object.values(ASSET_ALIASES).some((aliases) =>
      aliases.some((alias) => lower.has(alias.toLowerCase())),
    )
    if (hasAny) return resolved
  }
  return null
}

export function syncAssets(resPath, assetsDir, { force = false } = {}) {
  fs.mkdirSync(assetsDir, { recursive: true })
  const status = { ok: 0, missing: [], resPath: resPath || '', copied: [] }
  const names = resPath ? fs.readdirSync(resPath) : []
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]))

  for (const [key, file] of Object.entries(ASSET_FILES)) {
    const aliases = ASSET_ALIASES[key] || [file]
    let sourceName = null
    for (const alias of aliases) {
      const hit = byLower.get(alias.toLowerCase())
      if (hit) {
        sourceName = hit
        break
      }
    }
    const dest = path.join(assetsDir, file)
    const destExists = fs.existsSync(dest)
    if (sourceName && resPath) {
      const source = path.join(resPath, sourceName)
      const same = path.resolve(source).toLowerCase() === path.resolve(dest).toLowerCase()
      let shouldCopy = force || !destExists
      if (!shouldCopy && !same) {
        try {
          const s = fs.statSync(source)
          const d = fs.statSync(dest)
          shouldCopy = s.size !== d.size || s.mtimeMs > d.mtimeMs + 1000
        } catch {
          shouldCopy = true
        }
      }
      if (shouldCopy && !same) {
        fs.copyFileSync(source, dest)
        status.copied.push(file)
      }
      if (fs.existsSync(dest)) status.ok++
      else status.missing.push(key)
    } else if (destExists) {
      status.ok++
    } else {
      status.missing.push(key)
    }
  }
  return status
}

export async function backupDatabase(db, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(backupDir, `drafts-${stamp}.sqlite`)
  await backup(db, target)
  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => /^drafts-.*\.sqlite$/.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const old of backups.slice(10)) {
    try {
      fs.unlinkSync(path.join(backupDir, old.name))
    } catch {}
  }
  return target
}

export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout=10000')
  db.exec('PRAGMA foreign_keys=ON')
  return db
}

export function readManifest(projectDir) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'))
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function isOpenCodeRunning() {
  if (process.platform !== 'win32') {
    try {
      const out = require('node:child_process').execSync('ps -A', { encoding: 'utf8' })
      return /OpenCode/i.test(out)
    } catch {
      return false
    }
  }
  try {
    const out = require('node:child_process').execSync(
      'tasklist /FI "IMAGENAME eq OpenCode.exe" /NH',
      { encoding: 'utf8', windowsHide: true },
    )
    return /OpenCode\.exe/i.test(out)
  } catch {
    return false
  }
}

export function line() {
  console.log('─'.repeat(64))
}
