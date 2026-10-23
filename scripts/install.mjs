#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from './build.mjs'
import {
  ASSET_FILES,
  DEFAULT_CONFIG,
  EXTENSION_ID,
  backupDatabase,
  copyDir,
  copyFile,
  findUserData,
  isOpenCodeRunning,
  line,
  openDatabase,
  parseArgs,
  readJson,
  readManifest,
  resolveResPath,
  syncAssets,
  writeJson,
} from './shared.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))

line()
console.log('Remielle 桌宠 · OpenCode Desktop 扩展安装器')
line()

if (!args['no-build']) {
  build()
} else {
  console.log('跳过构建，使用现有 dist/remielle-pet')
}

const userData = findUserData(args['user-data'])
if (!userData) {
  console.error('找不到 OpenCode Desktop 的用户数据目录（drafts.sqlite）。')
  console.error('请先启动一次 OpenCode Desktop，或使用 --user-data <目录> 指定。')
  process.exit(1)
}
console.log('OpenCode 数据目录:', userData.dir)

const manifest = readManifest(root)
if (manifest.id !== EXTENSION_ID) {
  console.error('manifest.json 中的 id 不符合预期:', manifest.id)
  process.exit(1)
}

const staging = path.join(root, 'dist', 'remielle-pet')
const runtimeRoot = path.join(userData.dir, 'remielle-pet')
const runtimeApp = path.join(runtimeRoot, 'app')
const assetsDir = path.join(runtimeRoot, 'assets')
const configPath = path.join(runtimeRoot, 'config.json')
const installPath = path.join(runtimeRoot, 'install.json')
const preloadSrc = path.join(staging, 'runtime', 'preload.js')
const appSrc = path.join(staging, 'runtime', 'app')

for (const file of [path.join(staging, 'main.js'), path.join(staging, 'renderer.js'), path.join(staging, 'manifest.json')]) {
  if (!fs.existsSync(file)) {
    console.error('缺少构建产物:', file)
    console.error('请先运行 node scripts/build.mjs')
    process.exit(1)
  }
}

// --- runtime files ---------------------------------------------------------
fs.rmSync(runtimeApp, { recursive: true, force: true })
copyDir(appSrc, runtimeApp)
copyFile(preloadSrc, path.join(runtimeRoot, 'preload.js'))

const detectedRes = resolveResPath(args.res, root)
const fallbackRes = args.res
  ? path.resolve(args.res)
  : path.join(root, 'res')
const resPath = detectedRes || (fs.existsSync(fallbackRes) ? fallbackRes : null)
if (!resPath) {
  console.warn('警告: 未找到资源文件夹，动画将缺失。请把 GIF 放进 res/ 或使用 --res 指定。')
} else if (!detectedRes) {
  console.warn('警告: 资源文件夹中没有识别到动画文件名:', resPath)
}
const assetStatus = syncAssets(resPath || '', assetsDir, { force: true })
if (assetStatus.missing.length > 0) {
  console.warn('缺少动画:', assetStatus.missing.join(', '))
}

// --- config ----------------------------------------------------------------
const existingConfig = readJson(configPath, null)
const baseConfig = existingConfig && typeof existingConfig === 'object' ? existingConfig : {}
const nextConfig = {
  ...DEFAULT_CONFIG,
  ...baseConfig,
  resPath: resPath || baseConfig.resPath || '',
}
if (args['reset-config']) {
  Object.assign(nextConfig, DEFAULT_CONFIG, { resPath: resPath || '' })
}
writeJson(configPath, nextConfig)

writeJson(installPath, {
  extensionID: EXTENSION_ID,
  version: manifest.version,
  projectDir: root,
  resPath: resPath || '',
  installedAt: new Date().toISOString(),
  assets: ASSET_FILES,
})

// --- extension database ----------------------------------------------------
const db = openDatabase(userData.dbPath)
let backupPath = ''
let failed = false
try {
  backupPath = await backupDatabase(db, path.join(userData.dir, 'remielle-pet-backups'))
  console.log('数据库备份:', backupPath)

  const mainSource = fs.readFileSync(path.join(staging, 'main.js'), 'utf8')
  const rendererSource = fs.readFileSync(path.join(staging, 'renderer.js'), 'utf8')
  const manifestSource = fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8')
  const revision = String(Date.now())

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM extension_file WHERE extension_id = ?').run(EXTENSION_ID)
    const insertFile = db.prepare(
      'INSERT INTO extension_file (extension_id, path, data) VALUES (?, ?, ?)',
    )
    insertFile.run(EXTENSION_ID, 'main.js', Buffer.from(mainSource, 'utf8'))
    insertFile.run(EXTENSION_ID, 'renderer.js', Buffer.from(rendererSource, 'utf8'))
    insertFile.run(EXTENSION_ID, 'manifest.json', Buffer.from(manifestSource, 'utf8'))
    db.prepare(
      `INSERT INTO extension (id, enabled, manifest, revision)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = 1,
         manifest = excluded.manifest,
         revision = excluded.revision`,
    ).run(EXTENSION_ID, manifestSource.trim(), revision)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
} catch (error) {
  console.error('写入扩展数据库失败:', error?.message || error)
  console.error('如果 OpenCode Desktop 正在运行，请完全退出后重试。')
  failed = true
} finally {
  db.close()
}

if (failed) process.exit(1)

line()
console.log('安装完成 ✓')
console.log('  扩展 ID :', EXTENSION_ID)
console.log('  版本    :', manifest.version)
console.log('  运行时  :', runtimeRoot)
console.log('  动画    :', `${assetStatus.ok}/${Object.keys(ASSET_FILES).length} 个可用`)
if (assetStatus.missing.length > 0) {
  console.log('  缺少    :', assetStatus.missing.join(', '))
}
console.log('  日志    :', path.join(runtimeRoot, 'remielle.log'))
line()

if (isOpenCodeRunning()) {
  console.log('OpenCode Desktop 正在运行。请「完全退出」后重新启动（托盘/任务栏退出），')
  console.log('扩展会在下一次启动时加载。仅关闭窗口通常不会重新加载扩展。')
} else {
  console.log('请启动 OpenCode Desktop。桌宠会出现在窗口右下角。')
}
console.log('右键桌宠 → 显示齿轮按钮 → 点击齿轮打开设置。')
console.log('卸载: node scripts/uninstall.mjs')
