const path = require('path')
const cfg = require('./config')
const { getJSON, downloadWithRetry, pool } = require('./download')

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader/'
const FABRIC_GAME = 'https://meta.fabricmc.net/v2/versions/game'

let gameCache = null
let gameAt = 0

async function gameVersions() {
  const now = Date.now()
  if (gameCache && now - gameAt < 600000) return gameCache
  try {
    const list = await getJSON(FABRIC_GAME)
    gameCache = (list || []).map((v) => ({ version: v.version, stable: !!v.stable }))
    gameAt = now
  } catch (e) {
    gameCache = gameCache || []
  }
  return gameCache
}

function toArtifacts(libraries) {
  const artifacts = []
  for (const lib of libraries || []) {
    if (lib.downloads && lib.downloads.artifact) {
      artifacts.push({ path: lib.downloads.artifact.path, urls: [lib.downloads.artifact.url], sha1: lib.downloads.artifact.sha1 })
    } else if (lib.name) {
      const parts = lib.name.split(':')
      const [group, artifact, version] = parts
      const p = `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`
      const base = (lib.url || 'https://maven.fabricmc.net/').replace(/\/$/, '')
      artifacts.push({ path: p, urls: [base + '/' + p], sha1: null })
    }
  }
  return artifacts
}

async function loaders(mcVersion) {
  let list
  try {
    list = await getJSON(FABRIC_META + encodeURIComponent(mcVersion))
  } catch (e) {
    if (/HTTP [45]\d\d/.test(String((e && e.message) || e))) return []
    throw e
  }
  return (list || []).map((l) => ({
    version: (l.loader && l.loader.version) || l.version,
    stable: !!(l.loader && l.loader.stable) || !!l.stable
  }))
}

async function profile(mcVersion, loaderVersion) {
  const url = `${FABRIC_META}${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  return getJSON(url)
}

async function ensureFabricLibraries(fabricProfile, onProgress) {
  const artifacts = toArtifacts(fabricProfile.libraries)
  const P = cfg.paths()
  const pending = []
  for (const a of artifacts) {
    const dest = path.join(P.libraries, a.path)
    if (!require('fs').existsSync(dest)) pending.push({ a, dest })
  }
  let done = 0
  const total = pending.length
  await pool(pending, 8, async ({ a, dest }) => {
    await downloadWithRetry(a.urls, dest, { onProgress, tries: 5 })
    done++
    if (onProgress) onProgress(done, total)
  })
  return artifacts
}

function mainClass(fabricProfile) {
  const mc = fabricProfile.mainClass
  if (typeof mc === 'string') return mc
  if (mc && mc.client) return mc.client
  return 'net.fabricmc.loader.impl.launch.knot.KnotClient'
}

module.exports = { loaders, profile, ensureFabricLibraries, mainClass, gameVersions }
