const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const tar = require('tar')
const AdmZip = require('adm-zip')
const cfg = require('./config')
const { getJSON, download, downloadWithFallback } = require('./download')

const ADOPTIUM_INFO = 'https://api.adoptium.net/v3/info/available_releases'

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function adoptiumArch() {
  const a = process.arch
  if (a === 'x64') return 'x64'
  if (a === 'arm64') return 'aarch64'
  if (a === 'ia32') return 'x86'
  if (a === 'arm') return 'arm'
  return 'x64'
}

function javaDir(major) {
  return path.join(cfg.paths().java, String(major))
}

function installed() {
  const dir = cfg.paths().java
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .sort((a, b) => a - b)
}

async function available() {
  try {
    const info = await getJSON(ADOPTIUM_INFO)
    const set = new Set([...info.available_lts_releases, ...info.available_releases])
    return {
      lts: info.available_lts_releases || [],
      all: Array.from(set).sort((a, b) => a - b)
    }
  } catch (e) {
    return { lts: [8, 11, 16, 17, 21, 25], all: [8, 11, 16, 17, 21, 25] }
  }
}

function findJavaBin(major) {
  const root = javaDir(major)
  if (!fs.existsSync(root)) return null
  const binName = process.platform === 'win32' ? 'java.exe' : 'java'
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = walk(full)
        if (found) return found
      } else if (entry.name === binName && path.basename(path.dirname(full)) === 'bin') {
        return full
      }
    }
    return null
  }
  return walk(root)
}

async function install(major, onProgress) {
  const target = javaDir(major)
  if (findJavaBin(major)) return findJavaBin(major)

  const os = adoptiumOs()
  const arch = adoptiumArch()
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${os}&arch=${arch}&image_type=jdk&project=jdk`
  const assets = await getJSON(api)
  const asset = assets.find((a) => a.binary && a.binary.package && a.binary.package.link)
  if (!asset) throw new Error(`ما فيه نسخة جافا ${major} متوفرة لهذا النظام`)

  const link = asset.binary.package.link
  const ext = link.endsWith('.tar.gz') ? '.tar.gz' : path.extname(link)
  const tmpFile = path.join(cfg.paths().tmp, `java-${major}${ext}`)
  const tmpDir = path.join(cfg.paths().tmp, `java-${major}-x`)
  fs.mkdirSync(tmpDir, { recursive: true })

  await download(link, tmpFile, {
    onProgress: (received, total) => onProgress && onProgress({ current: received, total, label: `تحميل جافا ${major}` })
  })

  if (ext === '.zip') {
    const zip = new AdmZip(tmpFile)
    zip.extractAllTo(tmpDir, true)
  } else if (ext === '.tar.gz') {
    const { pipeline } = require('stream')
    const { promisify } = require('util')
    await promisify(pipeline)(fs.createReadStream(tmpFile), zlib.createGunzip(), tar.x({ cwd: tmpDir }))
  } else {
    throw new Error(`صيغة جافا غير معروفة: ${ext}`)
  }

  const children = fs.readdirSync(tmpDir)
  const root = path.join(tmpDir, children[0])
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(root)) {
    fs.renameSync(path.join(root, entry), path.join(target, entry))
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  try { fs.unlinkSync(tmpFile) } catch (e) {}

  const bin = findJavaBin(major)
  if (!bin) throw new Error(`جافا ${major} تثبتت بس ما انلقى java`)
  return bin
}

async function ensureJava(major, onProgress) {
  const bin = findJavaBin(major)
  if (bin) return bin
  return install(major, onProgress)
}

module.exports = { installed, available, install, ensureJava, findJavaBin, javaDir }
