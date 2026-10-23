import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')
const dist = path.join(root, 'dist')

const CORE_EXPORTS = [
  'ASSET_FILES',
  'ASSET_ALIASES',
  'DEFAULT_CONFIG',
  'DEFAULT_FILE_TOOLS',
  'PetState',
  'createSSEParser',
  'formatModel',
]

function read(file) {
  return fs.readFileSync(file, 'utf8')
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

export function build() {
  const core = read(path.join(src, 'core.js'))
  const mainSource = read(path.join(src, 'main.js'))
  const renderer = read(path.join(src, 'renderer.js'))
  const preload = read(path.join(src, 'preload.js'))
  const manifestSource = read(path.join(root, 'manifest.json'))

  if (!mainSource.includes('/*__CORE__*/')) {
    throw new Error('src/main.js is missing the /*__CORE__*/ injection marker')
  }

  const injection = [
    'const {',
    '  ' + CORE_EXPORTS.join(',\n  ') + ',',
    '} = (function () {',
    '  const module = { exports: {} }',
    '  const exports = module.exports',
    core,
    '  return module.exports',
    '})()',
  ].join('\n')

  const main = mainSource.replace('/*__CORE__*/', () => injection)

  // Fail early on syntax errors before the extension is written into the app DB.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', main)

  fs.rmSync(dist, { recursive: true, force: true })
  const staging = path.join(dist, 'remielle-pet')
  fs.mkdirSync(staging, { recursive: true })

  fs.writeFileSync(path.join(staging, 'main.js'), main, 'utf8')
  fs.writeFileSync(path.join(staging, 'renderer.js'), renderer, 'utf8')
  fs.writeFileSync(path.join(staging, 'manifest.json'), manifestSource, 'utf8')

  const runtime = path.join(staging, 'runtime')
  fs.mkdirSync(runtime, { recursive: true })
  fs.writeFileSync(path.join(runtime, 'preload.js'), preload, 'utf8')
  copyDir(path.join(src, 'app'), path.join(runtime, 'app'))

  const manifest = JSON.parse(manifestSource)
  const size = (file) => (fs.statSync(file).size / 1024).toFixed(1) + ' KB'
  console.log(`built ${manifest.id} v${manifest.version}`)
  console.log(`  ${path.relative(root, path.join(staging, 'main.js'))} (${size(path.join(staging, 'main.js'))})`)
  console.log(`  ${path.relative(root, path.join(staging, 'renderer.js'))} (${size(path.join(staging, 'renderer.js'))})`)
  console.log(`  runtime app: ${path.relative(root, path.join(runtime, 'app'))}`)
  return { staging, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build()
}
