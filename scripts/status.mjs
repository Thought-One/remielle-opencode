#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {
  ASSET_FILES,
  EXTENSION_ID,
  findUserData,
  line,
  openDatabase,
  parseArgs,
} from './shared.mjs'

const args = parseArgs(process.argv.slice(2))
const userData = findUserData(args['user-data'])
line()
console.log('Remielle 桌宠 · 状态检查')
line()
if (!userData) {
  console.error('找不到 OpenCode Desktop 数据目录。')
  process.exit(1)
}
console.log('数据目录:', userData.dir)

const db = openDatabase(userData.dbPath)
try {
  const row = db.prepare('SELECT id, enabled, manifest, revision FROM extension WHERE id = ?').get(EXTENSION_ID)
  if (!row) {
    console.log('扩展记录: 未安装')
  } else {
    console.log('扩展记录: 已安装')
    console.log('  enabled :', row.enabled)
    console.log('  revision:', row.revision)
    try {
      const manifest = JSON.parse(row.manifest)
      console.log('  manifest:', JSON.stringify(manifest))
    } catch {
      console.log('  manifest: 解析失败')
    }
  }
  const files = db
    .prepare('SELECT path, length(data) AS bytes FROM extension_file WHERE extension_id = ? ORDER BY path')
    .all(EXTENSION_ID)
  console.log('扩展文件:')
  for (const file of files) console.log(`  ${file.path}: ${file.bytes} bytes`)
} finally {
  db.close()
}

const root = path.join(userData.dir, 'remielle-pet')
console.log('运行时目录:', root)
for (const file of ['preload.js', 'config.json', 'install.json', 'remielle.log']) {
  const full = path.join(root, file)
  console.log(`  ${file}: ${fs.existsSync(full) ? fs.statSync(full).size + ' bytes' : '缺失'}`)
}
const assets = path.join(root, 'assets')
const present = fs.existsSync(assets) ? fs.readdirSync(assets) : []
console.log('动画资源:', `${present.filter((file) => file.endsWith('.gif')).length}/${Object.keys(ASSET_FILES).length}`)
for (const file of Object.values(ASSET_FILES)) {
  if (!present.includes(file)) console.log('  缺失:', file)
}

const runtimeLog = path.join(root, 'remielle.log')
if (fs.existsSync(runtimeLog)) {
  console.log('\nremielle.log (tail):')
  const lines = fs.readFileSync(runtimeLog, 'utf8').trim().split(/\r?\n/)
  console.log(lines.slice(-25).join('\n'))
}

const logs = path.join(userData.dir, 'logs')
if (fs.existsSync(logs)) {
  const latest = fs
    .readdirSync(logs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(logs, entry.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]
  if (latest) {
    const mainLog = path.join(logs, latest.name, 'main.log')
    if (fs.existsSync(mainLog)) {
      const matches = fs
        .readFileSync(mainLog, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /remielle|extension failed|invalidModule|invalidManifest/i.test(line))
      if (matches.length) {
        console.log(`\nOpenCode main.log (${latest.name}) 相关行:`)
        console.log(matches.slice(-40).join('\n'))
      }
    }
  }
}

line()
