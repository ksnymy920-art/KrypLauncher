const path = require('path')
const cfg = require('./config')
const { getJSON, downloadWithFallback, pool } = require('./download')

const QUILT_META = 'https://meta.quiltmc.org/v3/versions/loader/'

function toArtifacts(libraries) {
  const artifacts = []
  for (const lib of libraries || []) {
    if (lib.downloads && lib.downloads.artifact) {
      artifacts.push({ path: lib.downloads.artifact.path, urls: [lib.downloads.artifact.url], sha1: lib.downloads.artifact.sha1 })
    } else if (lib.name) {
      const parts = lib.name.split(':')
      const [group, artifact, version] = parts
      const p = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`
      const base = (lib.url || 'https://maven.quiltmc.org/repository/release/').replace(/\/$/, '')
      artifacts.push({ path: p, urls: [base + '/' + p], sha1: null })
    }
  }
  return artifacts
}

function verKey(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(beta|alpha|pr)\.?(\d+)?)?/i.exec(String(v || ''))
  if (!m) return [0, 0, 0, 0, 0]
  const pre = m[4] ? (m[4].toLowerCase() === 'beta' ? 1 : 2) * 10 + (m[5] ? parseInt(m[5], 10) : 0) : 1000
  return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3], 10) || 0, pre]
}

function cmpVer(a, b) {
  const ka = verKey(a)
  const kb = verKey(b)
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i]
  }
  return 0
}

async function loaders(mcVersion) {
  const list = await getJSON(QUILT_META + encodeURIComponent(mcVersion))
  return (list || [])
    .map((l) => {
      const v = (l.loader && l.loader.version) || l.version
      return {
        version: v,
        stable: !/(\.|-)(beta|alpha|pr|pre)/i.test(String(v))
      }
    })
    .sort((a, b) => {
      if (a.stable !== b.stable) return a.stable ? -1 : 1
      return cmpVer(b.version, a.version)
    })
}

async function profile(mcVersion, loaderVersion) {
  const url = `${QUILT_META}${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  return getJSON(url)
}

async function ensureQuiltLibraries(quiltProfile, onProgress) {
  const artifacts = toArtifacts(quiltProfile.libraries)
  const P = cfg.paths()
  const pending = []
  for (const a of artifacts) {
    const dest = path.join(P.libraries, a.path)
    if (!require('fs').existsSync(dest)) pending.push({ a, dest })
  }
  let done = 0
  const total = pending.length
  await pool(pending, 8, async ({ a, dest }) => {
    await downloadWithFallback(a.urls, dest, onProgress)
    done++
    if (onProgress) onProgress(done, total)
  })
  return artifacts
}

function mainClass(quiltProfile) {
  const mc = quiltProfile.mainClass
  if (typeof mc === 'string') return mc
  if (mc && mc.client) return mc.client
  return 'org.quiltmc.loader.impl.launch.knot.KnotClient'
}

module.exports = { loaders, profile, ensureQuiltLibraries, mainClass }
