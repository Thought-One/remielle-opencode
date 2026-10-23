#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {
  EXTENSION_ID,
  backupDatabase,
  findUserData,
  isOpenCodeRunning,
  line,
  openDatabase,
  parseArgs,
} from './shared.mjs'

const args = parseArgs(process.argv.slice(2))
const userData = findUserData(args['user-data'])

line()
console.log('Remielle 桌宠 · 卸载器')
line()

if (!userData) {
  console.error('找不到 OpenCode Desktop 的用户数据目录。')
  process.exit(1)
}
console.log('OpenCode 数据目录:', userData.dir)

const runtimeRoot = path.join(userData.dir, 'remielle-pet')
const backupRoot = path.join(userData.dir, 'remielle-pet-backups')
const db = openDatabase(userData.dbPath)
try {
  const backupPath = await backupDatabase(db, backupRoot)
  console.log('数据库备份:', backupPath)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM extension_file WHERE extension_id = ?').run(EXTENSION_ID)
    db.prepare('DELETE FROM extension WHERE id = ?').run(EXTENSION_ID)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
} finally {
  db.close()
}

if (args.purge) {
  fs.rmSync(runtimeRoot, { recursive: true, force: true })
  console.log('已删除运行时文件与配置:', runtimeRoot)
} else {
  console.log('已移除扩展注册；运行时文件与配置保留在:', runtimeRoot)
  console.log('如需彻底删除，重新运行并加上 --purge。')
}

line()
console.log('卸载完成。请完全退出并重新启动 OpenCode Desktop。')
if (isOpenCodeRunning()) {
  console.log('提示: OpenCode Desktop 仍在运行，重启前桌宠可能继续显示。')
}
