const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const cfg = require('./config')
const { getJSON, downloadWithRetry, pool, sha1File, isCancelled } = require('./download')

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
const RESOURCE_BASE = 'https://resources.download.minecraft.net/'
const MC_MAVEN = 'https://libraries.minecraft.net/'
const CENTRAL = 'https://repo1.maven.org/maven2/'

let manifestCache = null
let manifestTime = 0
const versionJsonCache = {}

function platform() {
  const name = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64'
  return { osName: name, osArch: arch }
}

function matchesRules(rules, p) {
  let allow = false
  for (const rule of rules) {
    let match = true
    if (rule.os) {
      if (rule.os.name && rule.os.name !== p.osName) match = false
      if (match && rule.os.arch && rule.os.arch !== p.osArch) match = false
      if (match && rule.os.version) match = false
    }
    if (rule.features) match = false
    if (match) allow = rule.action === 'allow'
  }
  return allow
}

function artifactPath(name) {
  const parts = name.split(':')
  const [group, artifact, version, ...rest] = parts
  const classifier = rest[0]
  const g = group.replace(/\./g, '/')
  let file = `${artifact}-${version}`
  if (classifier) file += `-${classifier}`
  file += '.jar'
  return `${g}/${artifact}/${version}/${file}`
}

function mavenUrl(lib) {
  const bases = []
  if (lib.url) bases.push(lib.url)
  bases.push(MC_MAVEN, CENTRAL)
  const p = lib.downloads && lib.downloads.artifact ? lib.downloads.artifact.path : artifactPath(lib.name)
  return bases.map((b) => b.replace(/\/$/, '') + '/' + p)
}

function artifactItem(a) {
  return { path: a.path, urls: [a.url], sha1: a.sha1 }
}

function libClassifier(name) {
  const parts = name.split(':')
  return parts.length >= 4 ? parts[3] : null
}

function legacyItem(lib) {
  return { path: artifactPath(lib.name), urls: mavenUrl(lib), sha1: null }
}

function nativeCandidates() {
  const p = platform()
  if (p.osName === 'windows') {
    if (p.osArch === 'x64') return ['windows', 'windows-64']
    if (p.osArch === 'arm64') return ['windows-arm64']
    return ['windows-x86']
  }
  if (p.osName === 'linux') return p.osArch === 'arm64' ? ['linux-arm64', 'linux'] : ['linux']
  if (p.osName === 'osx') return p.osArch === 'arm64' ? ['macos-arm64', 'macos'] : ['macos']
  return []
}

function pickClassifier(lib, nativeKey, p) {
  const classifiers = lib.downloads.classifiers
  if (p.osName === 'windows' && p.osArch === 'x64' && classifiers[nativeKey + '-64']) return classifiers[nativeKey + '-64']
  if (p.osName === 'windows' && p.osArch === 'x86' && classifiers[nativeKey + '-x86']) return classifiers[nativeKey + '-x86']
  if (p.osName === 'windows' && p.osArch === 'arm64' && classifiers[nativeKey + '-arm64']) return classifiers[nativeKey + '-arm64']
  return classifiers[nativeKey]
}

function parseLibraries(json) {
  const p = platform()
  const artifacts = []
  const natives = []
  const candidates = nativeCandidates()
  for (const lib of json.libraries || []) {
    if (lib.rules && !matchesRules(lib.rules, p)) continue
    const classifier = libClassifier(lib.name)
    const isNativeName = classifier && classifier.startsWith('natives-')
    if (lib.natives) {
      let nativeKey = lib.natives[p.osName]
      if (nativeKey) nativeKey = nativeKey.replace('${arch}', p.osArch === 'x64' ? '64' : '32')
      if (nativeKey && lib.downloads && lib.downloads.classifiers) {
        const cl = pickClassifier(lib, nativeKey, p)
        if (cl) natives.push(artifactItem(cl))
      }
      if (lib.downloads && lib.downloads.artifact) artifacts.push(artifactItem(lib.downloads.artifact))
    } else if (isNativeName) {
      const want = candidates.find((c) => classifier === 'natives-' + c)
      if (want && lib.downloads && lib.downloads.artifact) natives.push(artifactItem(lib.downloads.artifact))
    } else if (lib.downloads && lib.downloads.artifact) {
      artifacts.push(artifactItem(lib.downloads.artifact))
    } else if (lib.name) {
      artifacts.push(legacyItem(lib))
    }
  }
  return { artifacts, natives }
}

async function getManifest(force = false) {
  if (!force && manifestCache && Date.now() - manifestTime < 5 * 60 * 1000) return manifestCache
  const file = path.join(cfg.paths().versions, '_manifest.json')
  let data
  try {
    data = await getJSON(MANIFEST_URL)
  } catch (e) {
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'))
    else throw e
  }
  manifestCache = data
  manifestTime = Date.now()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data))
  return data
}

function listVersions() {
  return getManifest().then((m) => m.versions || [])
}

function versionEntry(id) {
  return getManifest().then((m) => (m.versions || []).find((v) => v.id === id))
}

async function getVersionJson(id) {
  if (versionJsonCache[id]) return versionJsonCache[id]
  const dir = path.join(cfg.paths().versions, id)
  const file = path.join(dir, `${id}.json`)
  if (!fs.existsSync(file)) {
    const entry = await versionEntry(id)
    if (!entry) throw new Error(`النسخة غير موجودة: ${id}`)
    fs.mkdirSync(dir, { recursive: true })
    const json = await getJSON(entry.url)
    fs.writeFileSync(file, JSON.stringify(json))
    versionJsonCache[id] = json
    return json
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'))
  versionJsonCache[id] = json
  return json
}

function clientJarFile(id) {
  return path.join(cfg.paths().versions, id, `${id}.jar`)
}

async function ensureClientJar(json, onProgress) {
  const dest = clientJarFile(json.id)
  if (fs.existsSync(dest)) return dest
  const d = json.downloads && json.downloads.client
  if (!d || !d.url) throw new Error(`لا يوجد ملف كلاينت للنسخة ${json.id}`)
  await downloadWithRetry([d.url], dest, { onProgress, sha1: d.sha1 })
  return dest
}

async function ensureArtifacts(artifacts, onProgress) {
  const P = cfg.paths()
  const pending = []
  for (const a of artifacts) {
    const dest = path.join(P.libraries, a.path)
    if (fs.existsSync(dest)) continue
    pending.push({ a, dest })
  }
  let done = 0
  const total = pending.length
  await pool(pending, 8, async ({ a, dest }) => {
    await downloadWithRetry(a.urls, dest, { onProgress, sha1: a.sha1 })
    done++
    if (onProgress) onProgress(done, total)
  })
}

function flattenDir(root) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        fs.rmSync(full, { recursive: true, force: true })
      } else {
        const target = path.join(root, entry.name)
        try {
          fs.renameSync(full, target)
        } catch (e) {
          fs.copyFileSync(full, target)
          fs.unlinkSync(full)
        }
      }
    }
  }
  walk(root)
}

async function ensureNatives(natives, instanceId, onProgress, json) {
  const P = cfg.paths()
  const destDir = path.join(P.natives, instanceId)
  fs.mkdirSync(destDir, { recursive: true })
  if (!fs.existsSync(path.join(destDir, '.complete'))) {
    const zipDir = path.join(P.tmp, `natives-${instanceId}`)
    fs.mkdirSync(zipDir, { recursive: true })
    await pool(natives, 4, async (n) => {
      const zf = path.join(zipDir, path.basename(n.path))
      await downloadWithRetry(n.urls, zf, { onProgress })
      const zip = new AdmZip(zf)
      zip.extractAllTo(destDir, true)
    })
    flattenDir(destDir)
  }
  const jvm = json && json.arguments && json.arguments.jvm
  if (Array.isArray(jvm)) {
    const subs = new Set()
    for (const a of jvm) {
      if (typeof a === 'string') {
        const m = a.match(/\$\{natives_directory\}\/([A-Za-z0-9_-]+)/)
        if (m) subs.add(m[1])
      }
    }
    for (const sub of subs) {
      const subDir = path.join(destDir, sub)
      fs.mkdirSync(subDir, { recursive: true })
      for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
        if (entry.isFile() && !entry.name.startsWith('.') && entry.name !== sub) {
          const to = path.join(subDir, entry.name)
          if (!fs.existsSync(to)) fs.copyFileSync(path.join(destDir, entry.name), to)
        }
      }
    }
  }
  fs.writeFileSync(path.join(destDir, '.complete'), '')
  return destDir
}

async function ensureAssetIndex(json, onProgress) {
  const P = cfg.paths()
  const indexId = json.assetIndex && json.assetIndex.id
  if (!indexId) return null
  const indexFile = path.join(P.assets, 'indexes', `${indexId}.json`)
  if (!fs.existsSync(indexFile)) {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true })
    const data = await getJSON(json.assetIndex.url)
    fs.writeFileSync(indexFile, JSON.stringify(data))
  }
  return { id: indexId, file: indexFile }
}

async function ensureAssets(index, onProgress) {
  if (!index) return
  const P = cfg.paths()
  const data = JSON.parse(fs.readFileSync(index.file, 'utf8'))
  const objects = Object.values(data.objects || {})
  const pending = []
  for (const o of objects) {
    const dest = path.join(P.assets, 'objects', o.hash.slice(0, 2), o.hash)
    if (fs.existsSync(dest)) continue
    pending.push({ hash: o.hash, dest })
  }
  let done = 0
  const total = pending.length
  await pool(pending, 16, async ({ hash, dest }) => {
    const url = RESOURCE_BASE + hash.slice(0, 2) + '/' + hash
    try {
      await downloadWithRetry([url], dest, { sha1: hash })
    } catch (e) {
      if (e && e.message === 'cancelled') throw e
      console.error('[asset skip]', url, e.message)
    }
    done++
    if (onProgress && total) onProgress(done, total)
  })
  if (data.virtual || /^pre-1\.6$/.test(index.id)) {
    const vroot = path.join(P.assets, 'virtual', index.id)
    const marker = path.join(vroot, '.complete')
    if (!fs.existsSync(marker)) {
      const entries = Object.entries(data.objects || {})
      await pool(entries, 12, async ([key, o]) => {
        const src = path.join(P.assets, 'objects', o.hash.slice(0, 2), o.hash)
        if (!fs.existsSync(src)) return
        const dest = path.join(vroot, key)
        if (fs.existsSync(dest)) return
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        try {
          fs.copyFileSync(src, dest)
        } catch (e) {
          console.error('[virtual skip]', key, e.message)
        }
      })
      fs.writeFileSync(marker, '')
    }
  }
}

async function ensureVersionFiles(versionId, onProgress) {
  const json = await getVersionJson(versionId)
  onProgress && onProgress({ label: `تحميل ملفات النسخة ${versionId}` })
  await ensureClientJar(json, (r, t) => onProgress && onProgress({ label: `تحميل كلاينت ${versionId}`, current: r, total: t }))
  const index = await ensureAssetIndex(json)
  onProgress && onProgress({ label: 'تحميل الأصول (Assets)' })
  await ensureAssets(index, (done, total) => onProgress && onProgress({ label: `أصول اللعبة ${done}/${total || '?'}`, current: done, total }))
  const { artifacts, natives } = parseLibraries(json)
  onProgress && onProgress({ label: `تحميل المكتبات (${artifacts.length})` })
  await ensureArtifacts(artifacts, (done, total) => onProgress && onProgress({ label: `مكتبات ${done}/${total}`, current: done, total }))
  return { json, artifacts, natives, index }
}

function guessJavaMajor(versionId) {
  const base = versionId.split('-')[0]
  const parts = base.split('.').map(Number)
  const major = parts[0] || 1
  const minor = parts[1] || 0
  if (major === 1 && minor < 17) return 8
  if (major === 1 && minor === 17) return 16
  return 17
}

async function javaMajorFor(json) {
  if (json.javaVersion && json.javaVersion.majorVersion) return json.javaVersion.majorVersion
  return guessJavaMajor(json.id)
}

function librariesToArtifacts(libraries) {
  const artifacts = []
  for (const lib of libraries || []) {
    if (!lib || !lib.name) continue
    if (lib.clientreq === false) continue
    if (lib.natives && (!lib.downloads || !lib.downloads.artifact)) continue
    if (lib.downloads && lib.downloads.artifact) {
      artifacts.push({ path: lib.downloads.artifact.path, urls: [lib.downloads.artifact.url], sha1: lib.downloads.artifact.sha1 })
    } else if (lib.name) {
      const p = artifactPath(lib.name)
      const base = (lib.url || MC_MAVEN).replace(/\/$/, '')
      artifacts.push({ path: p, urls: [base + '/' + p, CENTRAL.replace(/\/$/, '') + '/' + p], sha1: null })
    }
  }
  return artifacts
}

module.exports = {
  getManifest,
  listVersions,
  getVersionJson,
  parseLibraries,
  librariesToArtifacts,
  ensureVersionFiles,
  ensureArtifacts,
  ensureNatives,
  clientJarFile,
  javaMajorFor,
  guessJavaMajor,
  platform
}
