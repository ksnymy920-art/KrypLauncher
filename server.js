const fs = require('fs')
const path = require('path')
const express = require('express')
const { randomUUID } = require('crypto')

const cfg = require('./lib/config')
const mojang = require('./lib/mojang')
const java = require('./lib/java')
const fabric = require('./lib/fabric')
const forge = require('./lib/forge')
const neoforge = require('./lib/neoforge')
const quilt = require('./lib/quilt')
const ms = require('./lib/microsoft')
const launchLib = require('./lib/launch')
const mods = require('./lib/mods')
const modpacks = require('./lib/modpacks')
const modfix = require('./lib/modfix')
const skins = require('./lib/skins')
const logs = require('./lib/logs')
const backups = require('./lib/backups')
const serverlist = require('./lib/serverlist')
const downloadLib = require('./lib/download')
const controls = require('./lib/controls')
function resolvePort() {
  const argIdx = process.argv.indexOf('--port')
  if (argIdx !== -1) {
    const n = Number(process.argv[argIdx + 1])
    if (n) return n
  }
  if (process.env.PORT) {
    const n = Number(process.env.PORT)
    if (n) return n
  }
  return 8000
}

const PORT = resolvePort()
const app = express()
app.use(express.json({ limit: '2mb' }))
try {
  app.use(express.static(path.join(__dirname, 'public')))
} catch (e) {}

const jobs = {}
const gameLogs = []
let logOffset = 0
const runningGames = new Map()
const gameMissing = new Map()
const stopRequested = new Set()
const serverTrackers = new Map()

function readLastServer(gameDir) {
  try {
    return fs.readFileSync(path.join(gameDir, 'lastserver.txt'), 'utf8').trim()
  } catch (e) {
    return ''
  }
}

function startServerTracker(key, gameDir, baseline) {
  stopServerTracker(key)
  const bp = serverlist.parseAddress(baseline || '')
  const rec = { key, gameDir, last: baseline || '', lastHost: bp ? bp.host : '', iv: null }
  serverTrackers.set(key, rec)
  rec.iv = setInterval(() => {
    try {
      const v = readLastServer(gameDir)
      if (!v || v === rec.last) return
      rec.last = v
      const p = serverlist.parseAddress(v)
      if (!p || p.host === rec.lastHost) return
      rec.lastHost = p.host
      const inst = cfg.getInstance(key)
      if (inst) {
        serverlist.addServerToDat(gameDir, { name: p.host, ip: v })
      }
      serverlist.trackPlay(v, { name: p.host })
      logLine(`[KrypLauncher] 📡 Server saved automatically to the server list: ${v}`)
    } catch (e) {}
  }, 4000)
}

function stopServerTracker(key) {
  const rec = serverTrackers.get(key)
  if (rec && rec.iv) clearInterval(rec.iv)
  serverTrackers.delete(key)
}

function launchHostWithPort(host, port) {
  if (port && port !== 25565) return `${host}:${port}`
  return host
}

function createJob(type, label) {
  downloadLib.resetCancel()
  const id = randomUUID()
  jobs[id] = { id, type, label, current: 0, total: 0, done: false, error: null, data: null, createdAt: Date.now() }
  const keys = Object.keys(jobs)
  if (keys.length > 40) delete jobs[keys[0]]
  return jobs[id]
}

function setJob(job, patch) {
  Object.assign(job, patch)
}

function runJob(job, fn) {
  setImmediate(async () => {
    try {
      job.data = await fn()
    } catch (err) {
      console.error('[job error]', err)
      job.error = err.message || String(err)
    } finally {
      job.done = true
    }
  })
  return job
}

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '')
}

function scanForMissingMods(key, line) {
  const r = modfix.extractMissing(line)
  if (!r.missing.length && !r.conflicts.length) return
  if (!gameMissing.has(key)) gameMissing.set(key, { missing: new Set(), conflicts: new Set(), autoStarted: false })
  const rec = gameMissing.get(key)
  let changed = false
  for (const id of r.missing) {
    if (!rec.missing.has(id)) {
      rec.missing.add(id)
      changed = true
    }
  }
  for (const id of r.conflicts) {
    if (!rec.conflicts.has(id)) {
      rec.conflicts.add(id)
      changed = true
    }
  }
  if (changed) {
    const miss = [...rec.missing].join(', ')
    const conf = [...rec.conflicts].join(', ')
    logLine(`[KrypLauncher] ⚠️ ${miss ? 'Missing mods required: ' + miss : ''}${conf ? (miss ? ' — ' : '') + 'Mod conflicts: ' + conf : ''}`)
  }
}

function scanForServerJoin(key, line) {
  const m = /Connecting to\s+([^\s,]+)(?:\s*,\s*(\d{1,5}))?/.exec(line)
  if (!m) return
  const host = m[1].trim()
  const port = m[2] ? parseInt(m[2], 10) : null
  if (!host || host === 'localhost' || host === '127.0.0.1') return
  const p = serverlist.parseAddress(port && port !== 25565 ? host + ':' + port : host)
  if (!p) return
  const rec = serverTrackers.get(key)
  if (rec && rec.lastHost === p.host) return
  if (rec) rec.lastHost = p.host
  const inst = cfg.getInstance(key)
  if (inst) {
    const gameDir = path.join(cfg.paths().game, key)
    serverlist.addServerToDat(gameDir, { name: p.host, ip: host + (p.port !== 25565 ? ':' + p.port : '') })
  }
  serverlist.trackPlay(host + (p.port !== 25565 ? ':' + p.port : ''), { name: p.host })
  logLine(`[KrypLauncher] 📡 Server saved automatically to the server list: ${host}${p.port !== 25565 ? ':' + p.port : ''}`)
}

function runMissingFix(key) {
  const rec = gameMissing.get(key)
  if (!rec || !rec.missing.size) return null
  const inst = cfg.getInstance(key)
  if (!inst) return null
  const job = createJob('modfix', 'تحميل المودات الناقصة')
  runJob(job, async () => {
    setJob(job, { total: rec.missing.size })
    const results = await modfix.resolveMissing({
      instanceId: key,
      version: inst.versionId,
      loader: inst.loader || '',
      ids: [...rec.missing],
      onVersion: (v) => setJob(job, { label: `تحميل ${v.filename || ''}` })
    })
    const ok = results.filter((x) => x.status === 'installed').length
    const fail = results.filter((x) => x.status === 'failed')
    logLine(ok ? `[KrypLauncher] ✅ Downloaded ${ok} missing mods automatically` : '[KrypLauncher] Missing mods not found')
    if (fail.length) logLine(`[KrypLauncher] Failed to download: ${fail.map((x) => x.id).join(', ')}`)
    return results
  })
  return job
}

function pushLog(key, chunk) {
  const text = chunk.toString()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const clean = stripAnsi(line)
    gameLogs.push({ n: logOffset++, t: new Date().toISOString(), line: clean })
    if (key) scanForMissingMods(key, clean)
    if (key) scanForServerJoin(key, clean)
  }
  if (gameLogs.length > 4000) gameLogs.splice(0, gameLogs.length - 4000)
}

function logLine(text) {
  gameLogs.push({ n: logOffset++, t: new Date().toISOString(), line: stripAnsi(text) })
  if (gameLogs.length > 4000) gameLogs.splice(0, gameLogs.length - 4000)
}

function instanceKey(versionId, loader) {
  return cfg.instanceKey(versionId, loader || null)
}

function runningGameConflict(key, versionId, loader) {
  if (runningGames.has(key)) return `النسخة ${key} شغالة بالفعل`
  for (const g of runningGames.values()) {
    if (g.versionId === versionId) return `إصدار ${versionId} شغال بالفعل — لا يمكن تشغيل نفس الإصدار مرتين`
  }
  if (loader) {
    for (const g of runningGames.values()) {
      if (g.loader === loader) return `اللودر ${loader} شغال بالفعل — لا يمكن تشغيل لودر مرتين`
    }
  }
  return null
}

async function prepareInstance(instance, job) {
  const json = await mojang.getVersionJson(instance.versionId)
  const settings = cfg.load().settings
  const major = settings.java !== 'auto' ? Number(settings.java) : await mojang.javaMajorFor(json)
  instance.javaMajor = major
  setJob(job, { label: `التأكد من جافا ${major}` })
  const javaBin = await java.ensureJava(major, (p) => setJob(job, { label: p.label, current: p.current, total: p.total }))

  setJob(job, { label: 'ملفات النسخة' })
  const files = await mojang.ensureVersionFiles(instance.versionId, (p) => setJob(job, { label: p.label, current: p.current, total: p.total }))

  if (instance.loader && !instance.loaderVersion) {
    setJob(job, { label: 'تحديد إصدار اللودر' })
    await resolveLoaderVersion(instance)
  }

  let fabricProfile = null
  let fabricArtifacts = []
  let forgeJson = null
  let forgeArtifacts = []
  let neoforgeJson = null
  let neoforgeArtifacts = []
  let quiltProfile = null
  let quiltArtifacts = []
  if (instance.loader === 'fabric') {
    if (!instance.loaderVersion) throw new Error('اختر إصدار فابريك')
    setJob(job, { label: 'تحميل فابريك' })
    fabricProfile = await fabric.profile(instance.versionId, instance.loaderVersion)
    fabricArtifacts = await fabric.ensureFabricLibraries(fabricProfile, (done, total) => setJob(job, { label: `فابريك ${done}/${total}`, current: done, total }))
  } else if (instance.loader === 'forge') {
    if (!instance.loaderVersion) throw new Error('اختر إصدار فورج')
    setJob(job, { label: `تحميل فورج ${instance.loaderVersion}` })
    forgeJson = await forge.ensureInstalled(instance.versionId, instance.loaderVersion, javaBin, (label) => setJob(job, { label: String(label).slice(0, 60) }))
    forgeArtifacts = mojang.librariesToArtifacts(forgeJson.libraries)
    setJob(job, { label: `تحميل مكتبات فورج (${forgeArtifacts.length})` })
    await mojang.ensureArtifacts(forgeArtifacts, (done, total) => setJob(job, { label: `فورج ${done}/${total}`, current: done, total }))
  } else if (instance.loader === 'neoforge') {
    if (!instance.loaderVersion) throw new Error('اختر إصدار نيو فورج')
    setJob(job, { label: `تحميل نيو فورج ${instance.loaderVersion}` })
    neoforgeJson = await neoforge.ensureInstalled(instance.versionId, instance.loaderVersion, javaBin, (label) => setJob(job, { label: String(label).slice(0, 60) }))
    neoforgeArtifacts = mojang.librariesToArtifacts(neoforgeJson.libraries)
    setJob(job, { label: `تحميل مكتبات نيو فورج (${neoforgeArtifacts.length})` })
    await mojang.ensureArtifacts(neoforgeArtifacts, (done, total) => setJob(job, { label: `نيو فورج ${done}/${total}`, current: done, total }))
  } else if (instance.loader === 'quilt') {
    if (!instance.loaderVersion) throw new Error('اختر إصدار كوِلت')
    setJob(job, { label: 'تحميل كوِلت' })
    quiltProfile = await quilt.profile(instance.versionId, instance.loaderVersion)
    quiltArtifacts = await quilt.ensureQuiltLibraries(quiltProfile, (done, total) => setJob(job, { label: `كوِلت ${done}/${total}`, current: done, total }))
  }

  setJob(job, { label: 'تجهيز النيتفز' })
  const nativesDir = await mojang.ensureNatives(files.natives, instanceKey(instance.versionId, instance.loader), null, json)

  return { json, files, fabricProfile, fabricArtifacts, forgeJson, forgeArtifacts, neoforgeJson, neoforgeArtifacts, quiltProfile, quiltArtifacts, javaBin, nativesDir }
}

function classpathFor(prep, versionId) {
  const P = cfg.paths()
  const parts = []
  for (const a of prep.files.artifacts) parts.push(path.join(P.libraries, a.path))
  parts.push(mojang.clientJarFile(versionId))
  for (const a of prep.fabricArtifacts) parts.push(path.join(P.libraries, a.path))
  for (const a of prep.neoforgeArtifacts) parts.push(path.join(P.libraries, a.path))
  for (const a of prep.quiltArtifacts) parts.push(path.join(P.libraries, a.path))
  return launchLib.buildClasspath(parts)
}

app.get('/api/manifest', async (req, res) => {
  try {
    const versions = await mojang.listVersions()
    res.json({ versions, latest: (await mojang.getManifest()).latest })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/instances', (req, res) => {
  res.json(cfg.load().instances)
})

app.get('/api/versions/:id/info', async (req, res) => {
  try {
    const json = await mojang.getVersionJson(req.params.id)
    const major = await mojang.javaMajorFor(json)
    const key = instanceKey(req.params.id, null)
    res.json({
      id: json.id,
      type: json.type,
      javaMajor: major,
      clientInstalled: fs.existsSync(mojang.clientJarFile(req.params.id)),
      installed: !!cfg.getInstance(key)
    })
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

function validLoaderVersion(loader, version) {
  if (!loader) return true
  return version !== 'undefined' && version !== 'null'
}

async function resolveLoaderVersion(instance) {
  const mc = instance.versionId
  if (!mc) return
  if (instance.loader === 'fabric') {
    const list = await fabric.loaders(mc)
    const v = (list.find((x) => x.stable) || list[0] || {}).version
    if (v) instance.loaderVersion = v
  } else if (instance.loader === 'quilt') {
    const list = await quilt.loaders(mc)
    if (list[0]) instance.loaderVersion = list[0].version
  } else if (instance.loader === 'forge') {
    const v = await forge.versions(mc)
    instance.loaderVersion = v.recommended || v.latest || null
  } else if (instance.loader === 'neoforge') {
    const v = await neoforge.versions(mc)
    instance.loaderVersion = v.recommended || v.latest || null
  }
}

app.post('/api/install', (req, res) => {
  const { versionId, loader, loaderVersion } = req.body
  if (!versionId) return res.status(400).json({ error: 'versionId مطلوب' })
  if (!validLoaderVersion(loader, loaderVersion)) return res.status(400).json({ error: 'اختر إصدار اللودر' })
  const instance = { versionId, loader: loader || null, loaderVersion: loaderVersion || null }
  const key = instanceKey(versionId, instance.loader)
  const job = createJob('install', `تثبيت ${key}`)
  cfg.setInstance(key, { ...instance, status: 'installing', jobId: job.id })
  runJob(job, async () => {
    await prepareInstance(instance, job)
    cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'installed' })
    return { instanceId: key }
  })
  res.json({ jobId: job.id, instanceId: key })
})

app.post('/api/instances/reinstall', (req, res) => {
  const { key } = req.body
  if (!key) return res.status(400).json({ error: 'key مطلوب' })
  const inst = cfg.getInstance(key)
  if (!inst) return res.status(404).json({ error: 'النسخة غير موجودة' })
  const instance = { versionId: inst.versionId, loader: inst.loader || null, loaderVersion: inst.loaderVersion || null }
  const job = createJob('install', `إعادة تثبيت ${key}`)
  cfg.setInstance(key, { ...inst, status: 'installing', jobId: job.id })
  runJob(job, async () => {
    await prepareInstance(instance, job)
    cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'installed' })
    return { instanceId: key }
  })
  res.json({ jobId: job.id, instanceId: key })
})

app.post('/api/instances/delete', (req, res) => {
  const { key } = req.body
  if (!key) return res.status(400).json({ error: 'key مطلوب' })
  const inst = cfg.getInstance(key)
  if (!inst) return res.status(404).json({ error: 'النسخة غير موجودة' })
  if (runningGames.has(key)) return res.status(400).json({ error: 'أوقف اللعبة أولاً' })
  const c = cfg.load()
  delete c.instances[key]
  cfg.save()
  const errors = []
  const targets = [path.join(cfg.paths().game, key), path.join(cfg.paths().natives, key)]
  const loader = inst.loader
  const ver = inst.loaderVersion
  const mc = inst.versionId
  if (loader && ver && (loader === 'forge' || loader === 'neoforge')) {
    const versionsDir = cfg.paths().versions
    const candidates = [`${loader}-${ver}`, `${mc}-${loader}-${ver}`, `${mc}-${ver}`]
    for (const id of candidates) {
      const dir = path.join(versionsDir, id)
      if (fs.existsSync(dir)) targets.push(dir)
    }
  }
  for (const dir of targets) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      errors.push(dir)
    }
  }
  if (errors.length) {
    res.json({ ok: true, warning: 'لم تُحذف بعض الملفات لأنها قيد الاستخدام: ' + errors.map((d) => path.basename(d)).join(', ') })
  } else {
    res.json({ ok: true })
  }
})

app.post('/api/play', (req, res) => {
  const { versionId, loader, loaderVersion, accountId, memory, jvmArgs, width, height, server, serverPort } = req.body
  if (!versionId) return res.status(400).json({ error: 'versionId مطلوب' })
  if (!validLoaderVersion(loader, loaderVersion)) return res.status(400).json({ error: 'اختر إصدار اللودر' })
  const key = instanceKey(versionId, loader)
  const conflict = runningGameConflict(key, versionId, loader)
  if (conflict) return res.status(409).json({ error: conflict })
  const inst = cfg.getInstance(key)
  if (inst && (inst.status === 'preparing' || inst.status === 'installing')) return res.status(409).json({ error: `النسخة ${key} قيد التجهيز` })

  let account = cfg.getAccount(accountId)
  if (!account) {
    const offline = cfg.load().accounts.find((a) => a.type === 'offline')
    if (offline) account = offline
  }
  if (!account) return res.status(400).json({ error: 'أضف حساب أول (وضع الأوفلاين أو مايكروسوفت)' })

  const instance = { versionId, loader: loader || null, loaderVersion: loaderVersion || null }
  const job = createJob('play', `تشغيل ${key}`)
  cfg.setInstance(key, { ...instance, status: 'preparing', jobId: job.id })

  runJob(job, async () => {
    const prep = await prepareInstance(instance, job)
    cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'preparing' })
    const settings = cfg.load().settings
    const mem = memory || settings.memory || 2048
    const jvm = (typeof jvmArgs === 'string' ? jvmArgs : settings.jvmArgs) || ''
    const w = width || settings.width || 0
    const h = height || settings.height || 0

    const gameDir = path.join(cfg.paths().game, key)
    fs.mkdirSync(gameDir, { recursive: true })
    if (prep.forgeJson && prep.forgeJson.fmlLegacy) {
      try {
        const forgeJar = prep.forgeArtifacts.find((a) => a.path.includes('minecraftforge/forge'))
        await forge.ensureFmlLibs(gameDir, forgeJar ? path.join(cfg.paths().libraries, forgeJar.path) : null, (label) => logLine('>> ' + label))
      } catch (e) {
        logLine('>> FML libs error: ' + e.message)
        throw e
      }
    }
    const cc = cfg.load().controls || {}
    if (cc.auto && cc.active && (cc.target === '' || cc.target === key)) {
      const prof = (cc.profiles || []).find((p) => p.id === cc.active)
      if (prof) {
        try {
          if (controls.applyProfile(gameDir, cfg.paths().data, prof.id)) {
            logLine('>> Options applied: ' + prof.name)
          }
        } catch (e) {
          logLine('Error applying options.txt: ' + e.message)
        }
      }
    }
    const assetsDir = cfg.paths().assets
    const assetIndex = prep.files.index ? prep.files.index.id : null
    if (prep.forgeJson && prep.forgeJson.fmlLegacy) {
      try {
        const optFile = path.join(gameDir, 'options.txt')
        if (fs.existsSync(optFile)) {
          const lines = fs.readFileSync(optFile, 'utf8').split(/\r?\n/)
          let changed = false
          for (let i = 0; i < lines.length; i++) {
            const m = /^lang:(.*)$/.exec(lines[i])
            if (m) {
              const code = m[1].trim()
              const parts = code.split('_')
              const fixed = parts.length === 2 ? parts[0].toLowerCase() + '_' + parts[1].toUpperCase() : code
              if (fixed !== code) {
                lines[i] = 'lang:' + fixed
                changed = true
              }
            }
          }
          if (changed) fs.writeFileSync(optFile, lines.join('\n'))
        }
        const srvFile = path.join(gameDir, 'servers.dat')
        if (!fs.existsSync(srvFile)) {
          const name = Buffer.from('servers.dat', 'utf8')
          const body = Buffer.concat([
            Buffer.from([0x0a, (name.length >> 8) & 0xff, name.length & 0xff]),
            name,
            Buffer.from([0x00])
          ])
          fs.writeFileSync(srvFile, require('zlib').gzipSync(body))
        }
      } catch (e) {
        logLine('>> legacy prep error: ' + e.message)
      }
    }
    let gameAssets = assetsDir
    if (prep.files.index && prep.files.index.file && fs.existsSync(prep.files.index.file)) {
      try {
        const idx = JSON.parse(fs.readFileSync(prep.files.index.file, 'utf8'))
        if (idx.virtual || /^pre-1\.6$/.test(prep.files.index.id)) gameAssets = path.join(assetsDir, 'virtual', prep.files.index.id)
      } catch (e) {}
    }

    if (prep.forgeJson && prep.forgeJson.fmlLegacy && gameAssets && fs.existsSync(gameAssets)) {
      try {
        const marker = path.join(gameDir, '.omnilauncher-assets')
        const needCopy = !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== String(gameAssets)
        if (needCopy) {
          const dest = path.join(gameDir, 'resources')
          fs.mkdirSync(dest, { recursive: true })
          const skip = new Set(['.complete', 'pack.mcmeta', 'READ_ME_I_AM_VERY_IMPORTANT'])
          for (const entry of fs.readdirSync(gameAssets, { withFileTypes: true })) {
            if (skip.has(entry.name) || entry.name.startsWith('.')) continue
            fs.cpSync(path.join(gameAssets, entry.name), path.join(dest, entry.name), { recursive: true, force: true })
          }
          fs.writeFileSync(marker, String(gameAssets))
          logLine('>> نسخت أصول اللعبة إلى مجلد resources')
        }
      } catch (e) {
        logLine('>> resources copy error: ' + e.message)
      }
    }

    let launchServer = null
    let launchPort = null
    if (server) {
      const p = serverlist.parseAddress(server)
      const host = p ? p.host : server
      const port = serverPort || (p ? p.port : 25565)
      serverlist.addServerToDat(gameDir, { name: host, ip: server })
      serverlist.trackPlay(server, { name: host })
      launchServer = host
      launchPort = port
    }

    if (account.skin && account.skin.local) {
      const skinFile = skins.skinPngPath(account.id)
      if (fs.existsSync(skinFile)) {
        const mcVersion = prep.json.id || instance.versionId
        try {
          skins.installOfflineSkin(gameDir, fs.readFileSync(skinFile), mcVersion)
          skins.removeAutoCustomSkinLoader(gameDir)
          logLine('>> Local skin applied: ' + (account.skin.name || ''))
        } catch (e) {
          logLine('Error applying local skin: ' + e.message)
        }
      }
    }

    let args
    if (prep.forgeJson || prep.neoforgeJson) {
      const fmlCfgDir = path.join(gameDir, 'config')
      fs.mkdirSync(fmlCfgDir, { recursive: true })
      const fmlCfg = path.join(fmlCfgDir, 'fml.toml')
      const fmlContent = fs.existsSync(fmlCfg) ? fs.readFileSync(fmlCfg, 'utf8') : ''
      if (!/^\s*earlyWindowControl\s*=\s*false/m.test(fmlContent)) {
        const cleaned = fmlContent.replace(/^\s*earlyWindowControl\s*=.*$/m, '')
        fs.writeFileSync(fmlCfg, (cleaned.trim() ? cleaned.trim() + '\n' : '') + 'earlyWindowControl = false\n')
      }
      const loaderJson = prep.forgeJson || prep.neoforgeJson
      const loaderArtifacts = prep.forgeJson ? prep.forgeArtifacts : prep.neoforgeArtifacts
      const cpParts = []
      const seen = new Set()
      const pushCp = (p) => {
        const k = String(p).replace(/\\/g, '/').toLowerCase()
        if (seen.has(k)) return
        seen.add(k)
        cpParts.push(p)
      }
      for (const a of prep.files.artifacts) pushCp(path.join(cfg.paths().libraries, a.path))
      for (const a of loaderArtifacts) pushCp(path.join(cfg.paths().libraries, a.path))
      if (forge.needsClientJar(loaderJson)) {
        const cj = forge.findClientJar(versionId, instance.loaderVersion)
        if (!cj) throw new Error('ملفات فورج المولدة ناقصة (client jar غير موجود) — أعد تثبيت فورج')
        pushCp(cj)
      } else if (loaderJson.jar && loaderJson.jar !== versionId) {
        const jf = mojang.clientJarFile(loaderJson.jar)
        pushCp(fs.existsSync(jf) ? jf : mojang.clientJarFile(versionId))
      } else {
        pushCp(mojang.clientJarFile(versionId))
      }
      const cp = launchLib.buildClasspath(cpParts)
      const mainClass = loaderJson.mainClass || 'net.minecraft.launchwrapper.Launch'
      args = launchLib.buildForgeArgs({
        forgeJson: loaderJson,
        baseJson: prep.json,
        classpath: cp,
        mainClass,
        nativesDir: prep.nativesDir,
        gameDir,
        assetsDir,
        assetIndex,
        gameAssets,
        account,
        memory: mem,
        jvmArgs: jvm,
        width: w,
        height: h,
        server: launchServer,
        serverPort: launchPort
      })
    } else {
      const mainClass = prep.quiltProfile ? quilt.mainClass(prep.quiltProfile) : prep.fabricProfile ? fabric.mainClass(prep.fabricProfile) : 'net.minecraft.client.main.Main'
      args = launchLib.buildCommand({
        javaBin: prep.javaBin,
        memory: mem,
        jvmArgs: jvm,
        nativesDir: prep.nativesDir,
        classpath: classpathFor(prep, versionId),
        mainClass,
        versionJson: prep.json,
        gameDir,
        assetsDir,
        assetIndex,
        account,
        width: w,
        height: h,
        server: launchServer,
        serverPort: launchPort
      })
    }

    logLine(`>> Launching: ${prep.javaBin}`)
    logLine('>> args: ' + args.join(' | '))
    logLine(`>> instance: ${key}`)
    gameMissing.delete(key)

    const child = launchLib.launch({ javaBin: prep.javaBin, args, cwd: gameDir })
    child.stdout.on('data', (d) => pushLog(key, d))
    child.stderr.on('data', (d) => pushLog(key, d))
    child.on('error', (err) => logLine('Launch error: ' + err.message))
    child.on('exit', (code) => {
      const rec = gameMissing.get(key)
      stopServerTracker(key)
      runningGames.delete(key)
      const stopped = stopRequested.has(key)
      stopRequested.delete(key)
      logLine(stopped ? `Game stopped` : `Game exited with code ${code}`)
      const inst = cfg.getInstance(key)
      if (inst) cfg.setInstance(key, { ...inst, status: stopped ? 'stopped' : code === 0 ? 'stopped' : 'crashed' })
      if (!stopped && code !== 0 && rec && rec.missing.size && !rec.autoStarted) {
        rec.autoStarted = true
        runMissingFix(key)
      }
    })

    runningGames.set(key, { key, versionId: instance.versionId, loader: instance.loader, pid: child.pid, startedAt: new Date() })
    cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'running' })
    if (launchServer) {
      startServerTracker(key, gameDir, `${launchHostWithPort(launchServer, launchPort)}`)
    } else {
      startServerTracker(key, gameDir, readLastServer(gameDir))
    }
    return { pid: child.pid, instanceId: key }
  })

  res.json({ jobId: job.id, instanceId: key })
})

app.post('/api/stop', (req, res) => {
  const { key } = req.body || {}
  const targets = key ? [runningGames.get(key)].filter(Boolean) : Array.from(runningGames.values())
  if (!targets.length) return res.json({ ok: true, already: true })
  for (const g of targets) {
    stopRequested.add(g.key)
    if (process.platform === 'win32') {
      require('child_process').exec(`taskkill /PID ${g.pid} /T /F`, () => {})
    } else {
      try {
        process.kill(-g.pid, 'SIGKILL')
      } catch (e) {
        try { process.kill(g.pid, 'SIGKILL') } catch (e2) {}
      }
    }
  }
  res.json({ ok: true })
})

app.get('/api/game', (req, res) => {
  res.json({ running: runningGames.size > 0, games: Array.from(runningGames.values()) })
})

app.get('/api/game/logs', (req, res) => {
  const offset = parseInt(req.query.offset || '0', 10)
  const items = gameLogs.filter((l) => l.n >= offset)
  res.json({ logs: items, running: runningGames.size > 0 })
})

app.get('/api/servers', (req, res) => {
  const { instance } = req.query
  const inst = cfg.getInstance(instance)
  if (!instance || !inst) return res.json({ servers: [], rev: serverlist.getRev() })
  const gameDir = path.join(cfg.paths().game, instance)
  res.json({ servers: serverlist.listServers(gameDir), rev: serverlist.getRev() })
})

app.post('/api/servers/add', (req, res) => {
  const { instance, name, ip, port } = req.body || {}
  const inst = cfg.getInstance(instance)
  if (!instance || !inst || !ip) return res.status(400).json({ error: 'bad request' })
  const gameDir = path.join(cfg.paths().game, instance)
  const p = serverlist.parseAddress(ip)
  serverlist.addServerToDat(gameDir, { name: name || (p ? p.host : ip), ip, port: port || (p ? p.port : 25565) })
  res.json({ ok: true })
})

app.post('/api/servers/track', (req, res) => {
  const { name, ip } = req.body || {}
  if (!ip) return res.status(400).json({ error: 'bad request' })
  serverlist.ensureServer(ip, { name })
  res.json({ ok: true })
})

app.post('/api/servers/remove', (req, res) => {
  const { instance, ip } = req.body || {}
  const inst = cfg.getInstance(instance)
  if (!instance || !inst || !ip) return res.status(400).json({ error: 'bad request' })
  const gameDir = path.join(cfg.paths().game, instance)
  serverlist.removeFromDat(gameDir, ip)
  serverlist.removeServer(ip)
  res.json({ ok: true })
})

app.post('/api/servers/version', (req, res) => {
  const { ip, versionId, loader, loaderVersion } = req.body || {}
  if (!ip) return res.status(400).json({ error: 'bad request' })
  serverlist.setServerVersion(ip, { versionId, loader, loaderVersion })
  res.json({ ok: true })
})

async function resolveIconBase64(host, port, instance) {
  const iconDir = path.join(cfg.paths().data, 'server-icons')
  fs.mkdirSync(iconDir, { recursive: true })
  const cache = path.join(iconDir, `${host}_${port || 25565}.png`)
  let iconBase64 = null
  if (instance) {
    try {
      const gameDir = path.join(cfg.paths().game, instance)
      const entry = serverlist.readServersDat(gameDir).find((e) => {
        const ep = serverlist.parseAddress(e.ip)
        return ep && ep.host === host
      })
      if (entry && entry.icon) iconBase64 = entry.icon
    } catch (e) {}
  }
  if (!iconBase64 && fs.existsSync(cache)) {
    try {
      iconBase64 = fs.readFileSync(cache).toString('base64')
    } catch (e) {}
  }
  if (!iconBase64) {
    try {
      await downloadLib.download(`https://api.mcsrvstat.us/icon/${host}:${port || 25565}`, cache, { timeout: 10000 })
      iconBase64 = fs.readFileSync(cache).toString('base64')
    } catch (e) {}
  }
  return iconBase64
}

app.get('/api/servers/icon', async (req, res) => {
  const { host, port, instance } = req.query
  if (!host) return res.status(400).end()
  const iconBase64 = await resolveIconBase64(host, port, instance)
  if (!iconBase64) return res.status(404).end()
  if (instance) {
    try {
      serverlist.setIcon(host + ':' + (port || 25565), iconBase64)
    } catch (e) {}
  }
  res.set('content-type', 'image/png')
  res.end(Buffer.from(iconBase64, 'base64'))
})

app.get('/api/icons', async (req, res) => {
  const { host, port } = req.query
  if (!host) return res.status(400).end()
  const iconBase64 = await resolveIconBase64(host, port)
  if (!iconBase64) return res.status(404).end()
  res.set('content-type', 'image/png')
  res.end(Buffer.from(iconBase64, 'base64'))
})

const POPULAR_SERVERS = [
  { name: 'PikaNetwork', address: 'play.pika-network.net' },
  { name: 'Hypixel', address: 'mc.hypixel.net' },
  { name: 'Wynncraft', address: 'play.wynncraft.com' },
  { name: 'CubeCraft Games', address: 'play.cubecraft.net' },
  { name: 'ManaCube', address: 'play.manacube.com' },
  { name: 'JartexNetwork', address: 'play.jartexnetwork.com' },
  { name: 'BlocksMC', address: 'play.blocksmc.com' },
  { name: 'Purple Prison', address: 'purpleprison.net' },
  { name: 'GrieferGames', address: 'mc.griefergames.net' },
  { name: 'The Archon', address: 'play.thearchon.net' },
  { name: 'MCC Island', address: 'mccisland.net' },
  { name: '2b2t', address: '2b2t.org' },
  { name: 'Leet', address: 'leet.cc' }
]

const BROWSE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      ctrl.abort()
      reject(new Error('timeout'))
    }, timeoutMs || 15000)
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'KrypLauncher/1.0' } })
      .then((r) => r.json())
      .then((j) => {
        clearTimeout(t)
        resolve(j)
      })
      .catch((e) => {
        clearTimeout(t)
        reject(e)
      })
  })
}

function fetchHtml(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      ctrl.abort()
      reject(new Error('timeout'))
    }, timeoutMs || 20000)
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': BROWSE_UA, 'Accept-Language': 'en-US,en;q=0.9' } })
      .then(async (r) => {
        if (!r.ok) throw new Error('http ' + r.status)
        return r.text()
      })
      .then((txt) => {
        clearTimeout(t)
        resolve(txt)
      })
      .catch((e) => {
        clearTimeout(t)
        reject(e)
      })
  })
}

function normAddress(host, port) {
  const p = parseInt(port, 10)
  return p && p !== 25565 ? `${host}:${p}` : host
}

function parseMcservList(html) {
  const out = []
  const re = /<h2 class="server-name">([^<]+)<\/h2>[\s\S]*?<span class="text-default">([^<]+)<\/span>/g
  let m
  while ((m = re.exec(html))) {
    const name = (m[1] || '').trim()
    const addr = (m[2] || '').trim().toLowerCase()
    if (name && addr) out.push({ name, address: addr })
  }
  return out
}

function parseBuzzList(html) {
  const out = []
  const re = /<img[^>]*alt="([^"]+?) Minecraft Server"[^>]*>[\s\S]*?<data value="([^"]+)" class="ip-block"[^>]*>[\s\S]*?copyIP\('[^']*',\s*(\d+)/g
  let m
  while ((m = re.exec(html))) {
    const name = (m[1] || '').trim()
    const host = (m[2] || '').trim().toLowerCase()
    const port = parseInt(m[3], 10)
    if (name && host) out.push({ name, address: port && port !== 25565 ? `${host}:${port}` : host })
  }
  return out
}

function parseMclistList(html) {
  const out = []
  const re = /<h5 class="card-title"[^>]*>([^<]{2,80})<\/h5>[\s\S]{0,3000}?<input[^>]*value="([a-zA-Z0-9.\-:]{4,120})"/g
  let m
  while ((m = re.exec(html))) {
    const name = (m[1] || '').trim()
    const addr = (m[2] || '').trim().toLowerCase()
    if (name && addr) out.push({ name, address: addr })
  }
  return out
}

function parseMslistList(html) {
  const out = []
  const re = /<a href="\/server\/\d+">([^<]+)<\/a>[\s\S]{0,1500}?<div class="url">([^<]+)<\/div>/g
  let m
  while ((m = re.exec(html))) {
    const name = (m[1] || '').trim()
    const addr = (m[2] || '').trim().toLowerCase()
    if (name && addr) out.push({ name, address: addr })
  }
  return out
}

function parseMmpList(html) {
  const out = []
  const re = /<a href="\/server-s\d+" title="([^"]+)">[\s\S]{0,3000}?data-clipboard-text="([a-zA-Z0-9.\-:]+)"/g
  let m
  while ((m = re.exec(html))) {
    const name = (m[1] || '').trim()
    const addr = (m[2] || '').trim().toLowerCase()
    if (name && addr) out.push({ name, address: addr })
  }
  return out
}

function parseTopgList(html) {
  const out = []
  const re = /<h3 class="topg-server-name">([^<]+)<\/h3>[\s\S]{0,600}?<span class="copy-ip copy-span" data-text="([^"]+)"/g
  let m
  while ((m = re.exec(html))) {
    const name = (m[1] || '').trim()
    const addr = (m[2] || '').trim().toLowerCase()
    if (name && addr) out.push({ name, address: addr })
  }
  return out
}

const BROWSE_PAGE_SIZE = 20
const BROWSE_SOURCES = ['anyserver', 'mjsv', 'mcserv', 'buzz', 'mclist', 'mslist', 'mmp', 'topg']

const browseSleep = (ms) => new Promise((r) => setTimeout(r, ms))

let browseState = {
  pool: [],
  byHost: new Map(),
  cursor: {},
  done: {},
  allDone: false,
  busy: false,
  maxPool: 6000,
  at: 0
}

function addBrowseBatch(st, list) {
  for (const s of list) {
    if (!s || !s.address) continue
    const host = s.address.split(':')[0].toLowerCase()
    if (!st.byHost.has(host)) {
      st.byHost.set(host, { name: s.name || s.address, address: s.address })
      st.pool.push(st.byHost.get(host))
    }
  }
  if (st.pool.length >= st.maxPool) st.allDone = true
}

function allBrowseDone(st) {
  st.allDone = st.pool.length >= st.maxPool || BROWSE_SOURCES.every((k) => st.done[k])
}

function startBrowseBatch() {
  const st = browseState
  const tasks = []
  const push = (key, fn) => {
    if (!st.done[key]) tasks.push({ key, fn })
  }

  push('anyserver', async () => {
    const limit = 250
    const j = await fetchJson(`https://anyserver.pro/api/servers?game=mc_java&limit=${limit}&offset=${st.cursor.anyserver || 0}&sort=most_players`, 12000)
    const arr = Array.isArray(j.servers) ? j.servers : []
    st.cursor.anyserver = (st.cursor.anyserver || 0) + arr.length
    if (arr.length < limit) st.done.anyserver = true
    return arr.map((s) => ({ name: s.name || s.address, address: normAddress(s.address, s.port) }))
  })

  push('mjsv', async () => {
    st.cursor.mjsv = (st.cursor.mjsv || 0) + 1
    const j = await fetchJson(`https://minecraft-java-servers.com/api/v1/servers?per_page=100&min_players=1&page=${st.cursor.mjsv}`, 12000)
    const arr = Array.isArray(j.data) ? j.data : []
    if (arr.length < 100 || st.cursor.mjsv >= 10) st.done.mjsv = true
    return arr.map((s) => ({ name: s.name || s.host, address: normAddress(s.host, s.port) }))
  })

  push('mcserv', async () => {
    st.cursor.mcserv = (st.cursor.mcserv || 0) + 1
    const arr = parseMcservList(await fetchHtml(`https://mcserv.org/sa/?page=${st.cursor.mcserv}`, 12000))
    if (arr.length < 10 || st.cursor.mcserv >= 40) st.done.mcserv = true
    return arr
  })

  push('buzz', async () => {
    st.cursor.buzz = (st.cursor.buzz || 0) + 1
    const arr = parseBuzzList(await fetchHtml(`https://minecraft.buzz/java/${st.cursor.buzz}`, 12000))
    if (arr.length < 5 || st.cursor.buzz >= 30) st.done.buzz = true
    return arr
  })

  push('mclist', async () => {
    st.cursor.mclist = (st.cursor.mclist || 0) + 1
    const arr = parseMclistList(await fetchHtml(`https://mclist.io/?page=${st.cursor.mclist}`, 12000))
    if (arr.length < 5 || st.cursor.mclist >= 30) st.done.mclist = true
    return arr
  })

  push('mslist', async () => {
    st.cursor.mslist = (st.cursor.mslist || 0) + 1
    const arr = parseMslistList(await fetchHtml(`https://www.minecraftserverlist.net/index/${st.cursor.mslist}`, 12000))
    if (arr.length < 5 || st.cursor.mslist >= 50) st.done.mslist = true
    return arr
  })

  push('mmp', async () => {
    st.cursor.mmp = (st.cursor.mmp || 0) + 1
    const arr = parseMmpList(await fetchHtml(`https://minecraft-mp.com/servers/list/${st.cursor.mmp}/`, 12000))
    if (arr.length < 10 || st.cursor.mmp >= 40) st.done.mmp = true
    return arr
  })

  push('topg', async () => {
    st.cursor.topg = (st.cursor.topg || 0) + 1
    const arr = parseTopgList(await fetchHtml(`https://topg.org/minecraft-servers/?page=${st.cursor.topg}`, 12000))
    if (arr.length < 10 || st.cursor.topg >= 40) st.done.topg = true
    return arr
  })

  if (!tasks.length) return []
  return tasks.map((t) =>
    t.fn()
      .then((list) => addBrowseBatch(st, list))
      .catch(() => { st.done[t.key] = true })
      .then(() => allBrowseDone(st))
  )
}

async function ensureBrowsePool(need) {
  const st = browseState
  if (Date.now() - st.at > 15 * 60 * 1000) {
    st.pool = []
    st.byHost = new Map()
    st.cursor = {}
    st.done = {}
    st.allDone = false
    st.at = Date.now()
  }
  let guard = 0
  while (st.pool.length < need && !st.allDone && guard < 12) {
    guard++
    if (st.busy) {
      await browseSleep(100)
      continue
    }
    const tasks = startBrowseBatch()
    if (!tasks.length) break
    st.busy = true
    await new Promise((resolve) => {
      let settled = 0
      const timer = setInterval(() => {
        if (st.pool.length >= need) resolve()
      }, 50)
      for (const p of tasks) {
        p.finally(() => {
          settled++
          if (settled === tasks.length) {
            st.busy = false
            clearInterval(timer)
            resolve()
          }
        })
      }
    })
  }
}

app.get('/api/servers/browse', async (req, res) => {
  const { q } = req.query
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1)
  const st = browseState
  try {
    await ensureBrowsePool(page * BROWSE_PAGE_SIZE)
  } catch (e) {}
  let list = st.pool
  if (q) {
    const s = String(q).toLowerCase()
    list = list.filter((x) => x.name.toLowerCase().includes(s) || x.address.toLowerCase().includes(s))
  }
  const totalPages = Math.max(1, Math.ceil(list.length / BROWSE_PAGE_SIZE))
  res.json({ servers: list.slice((page - 1) * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE), page, totalPages, hasNext: !st.allDone })
})

app.get('/api/game/missing', (req, res) => {
  const items = []
  for (const [key, rec] of gameMissing.entries()) {
    if (!rec.missing.size && !rec.conflicts.size) continue
    items.push({ key, missing: [...rec.missing], conflicts: [...rec.conflicts], autoStarted: rec.autoStarted })
  }
  res.json({ items })
})

app.post('/api/game/logs/clear', (req, res) => {
  gameLogs.length = 0
  res.json({ ok: true })
})

app.post('/api/logs/upload', async (req, res) => {
  try {
    const text = gameLogs.map((l) => l.line).join('\n')
    if (!text.trim()) return res.status(400).json({ error: 'لا يوجد لوجات لرفعها' })
    const url = await logs.upload(text)
    logLine(`>> Logs uploaded: ${url}`)
    res.json({ url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/logs', (req, res) => {
  const offset = parseInt(req.query.offset || '0', 10)
  res.json({ logs: gameLogs.filter((l) => l.n >= offset).map((l) => ({ n: l.n, t: l.t, line: l.line })) })
})

function shotsDir(instanceId) {
  return path.join(cfg.paths().game, safeInstanceKey(instanceId), 'screenshots')
}

function safeInstanceKey(key) {
  return String(key || '').replace(/[\\/:*?"<>|]/g, '_')
}

app.get('/api/screenshots', (req, res) => {
  const dir = shotsDir(req.query.instance || '')
  try {
    const items = fs.existsSync(dir)
      ? fs.readdirSync(dir)
          .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f))
            return { file: f, size: st.size, modified: st.mtime }
          })
          .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      : []
    res.json({ items })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/screenshots/file', (req, res) => {
  const dir = shotsDir(req.query.instance || '')
  const file = path.basename(String(req.query.name || ''))
  const full = path.join(dir, file)
  if (!file || !fs.existsSync(full)) return res.status(404).json({ error: 'not found' })
  res.sendFile(full)
})

app.get('/api/icon', (req, res) => {
  const instance = String(req.query.instance || '')
  const file = String(req.query.file || '')
  const safe = String(instance + '-' + file).replace(/[^a-zA-Z0-9._-]/g, '_')
  const full = path.join(cfg.paths().data, 'icons', safe + '.png')
  if (!instance || !file || !fs.existsSync(full)) return res.status(404).json({ error: 'not found' })
  res.sendFile(full)
})

app.post('/api/screenshots/delete', (req, res) => {
  const { instance, name } = req.body || {}
  if (!instance || !name) return res.status(400).json({ error: 'instance و name مطلوبان' })
  const full = path.join(shotsDir(instance), path.basename(String(name)))
  if (fs.existsSync(full)) fs.unlinkSync(full)
  res.json({ ok: true })
})

app.post('/api/screenshots/open', (req, res) => {
  const { instance } = req.body || {}
  if (!instance) return res.status(400).json({ error: 'instance مطلوب' })
  const dir = shotsDir(instance)
  fs.mkdirSync(dir, { recursive: true })
  require('child_process').exec(process.platform === 'win32' ? `explorer "${dir}"` : `open "${dir}"`)
  res.json({ dir })
})

app.get('/api/backups', (req, res) => {
  const instance = req.query.instance || ''
  if (!instance) return res.json({ items: [] })
  res.json({ items: backups.list(instance) })
})

app.post('/api/backups', (req, res) => {
  const { instance } = req.body || {}
  if (!instance) return res.status(400).json({ error: 'instance مطلوب' })
  if (runningGames.has(instance)) return res.status(400).json({ error: 'أوقف اللعبة قبل عمل نسخة احتياطية' })
  const job = createJob('backup', `نسخة احتياطية لـ ${instance}`)
  runJob(job, async () => {
    const r = backups.create(instance, path.join(cfg.paths().game, safeInstanceKey(instance)))
    logLine(`>> Created backup archive ${r.file} (${(r.size / 1048576).toFixed(1)} MB)`)
    return r
  })
  res.json({ jobId: job.id })
})

app.post('/api/backups/restore', (req, res) => {
  const { instance, file } = req.body || {}
  if (!instance || !file) return res.status(400).json({ error: 'instance و file مطلوبان' })
  if (runningGames.has(instance)) return res.status(400).json({ error: 'أوقف اللعبة قبل الاستعادة' })
  const job = createJob('backup-restore', `استعادة ${file}`)
  runJob(job, async () => {
    const r = backups.restore(instance, file, path.join(cfg.paths().game, safeInstanceKey(instance)))
    logLine(`>> Restored backup ${r.file}`)
    return r
  })
  res.json({ jobId: job.id })
})

app.post('/api/backups/delete', (req, res) => {
  const { instance, file } = req.body || {}
  if (!instance || !file) return res.status(400).json({ error: 'instance و file مطلوبان' })
  backups.remove(instance, file)
  res.json({ ok: true })
})

app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs))
})

app.post('/api/jobs/cancel', (req, res) => {
  downloadLib.cancelAll()
  res.json({ ok: true })
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id]
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(job)
})

app.get('/api/fabric/loaders/:mc', async (req, res) => {
  try {
    res.json(await fabric.loaders(req.params.mc))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/forge/versions/:mc', async (req, res) => {
  try {
    res.json(await forge.versions(req.params.mc))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/neoforge/versions/:mc', async (req, res) => {
  try {
    res.json(await neoforge.versions(req.params.mc))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/quilt/loaders/:mc', async (req, res) => {
  try {
    res.json(await quilt.loaders(req.params.mc))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/mods/search', async (req, res) => {
  try {
    const r = await mods.search({
      query: req.query.q || '',
      version: req.query.version || '',
      loader: req.query.loader || '',
      source: req.query.source || 'all',
      type: req.query.type || 'mod',
      instance: req.query.instance || '',
      limit: Math.min(50, Number(req.query.limit || 20)),
      page: Math.max(1, Number(req.query.page || 1))
    })
    res.json(r)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/mods/versions', async (req, res) => {
  try {
    if (!req.query.id) return res.status(400).json({ error: 'id مطلوب' })
    res.json(await mods.versions({
      source: req.query.source || 'modrinth',
      id: req.query.id,
      version: req.query.version || '',
      loader: req.query.loader || '',
      type: req.query.type || 'mod'
    }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/mods/install', (req, res) => {
  const { source, id, version, loader, instanceId, forceUrl, forceFile, forceVersionId, fileId, slug, title, icon, type } = req.body
  if (!id || !instanceId) return res.status(400).json({ error: 'id و instanceId مطلوبان' })
  const isPack = type === 'modpack'
  const job = createJob(isPack ? 'modpack' : 'mods', isPack ? 'تثبيت مودباك' : type && type !== 'mod' ? 'تثبيت محتوى' : 'تثبيت مود')
  runJob(job, async () => {
    if (isPack) {
      const r = await modpacks.installPack(
        {
          source: source || 'modrinth',
          id,
          versionId: forceVersionId || '',
          fileId: fileId || '',
          forceUrl: forceUrl || '',
          forceFile: forceFile || '',
          slug: slug || '',
          title: title || '',
          icon: icon || '',
          fallbackVersion: version || '',
          fallbackLoader: loader || ''
        },
        {
          ensureInstance: async (mcVersion, packLoader, packLoaderVersion) => {
            const key = cfg.instanceKey(mcVersion, packLoader || null)
            const existing = cfg.getInstance(key)
            if (existing && (existing.status === 'installed' || existing.status === 'stopped' || existing.status === 'crashed')) return key
            const instance = { versionId: mcVersion, loader: packLoader || null, loaderVersion: packLoaderVersion || null }
            cfg.setInstance(key, { ...instance, status: 'installing' })
            await prepareInstance(instance, job)
            cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'installed' })
            return key
          },
          onLabel: (label) => setJob(job, { label: String(label).slice(0, 70) }),
          onProgress: (cur, total) => setJob(job, { label: `المودباك ${cur}/${total}`, current: cur, total })
        }
      )
      logLine(`>> Modpack imported ${r.name || r.instanceId} (files ${r.files}, mods ${r.mods}${r.failed ? ', failed to download ' + r.failed : ''})`)
      return r
    }
    const r = await mods.install(
      {
        source: source || 'modrinth',
        id,
        version: version || '',
        loader: loader || '',
        instanceId,
        type: type || 'mod',
        forceUrl: forceUrl || '',
        forceFile: forceFile || '',
        forceVersionId: forceVersionId || '',
        fileId: fileId || '',
        slug: slug || '',
        title: title || '',
        icon: icon || ''
      },
      (v) => setJob(job, { label: `تحميل ${v.filename}` })
    )
    return r
  })
  res.json({ jobId: job.id })
})

app.post('/api/mods/install-local', (req, res) => {
  const { file, version, loader, content } = req.body || {}
  let filePath = file
  if (Array.isArray(content) && content.length) {
    filePath = path.join(cfg.paths().tmp, `pack-upload-${Date.now()}.zip`)
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, Buffer.from(content))
    } catch (e) {
      return res.status(400).json({ error: 'تعذر حفظ الملف المرفوع' })
    }
  }
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'file مطلوب' })
  if (!/\.(zip|mrpack)$/i.test(filePath)) return res.status(400).json({ error: 'اختر ملف modpack بامتداد zip أو mrpack' })
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'ملف المودباك غير موجود' })
  const job = createJob('modpack', 'استيراد مودباك محلي')
  runJob(job, async () => {
    const r = await modpacks.installPack(
      {
        source: 'local',
        id: path.basename(filePath),
        forceFile: filePath,
        title: path.basename(filePath).replace(/\.(zip|mrpack)$/i, ''),
        fallbackVersion: version || '',
        fallbackLoader: loader || ''
      },
      {
        ensureInstance: async (mcVersion, packLoader, packLoaderVersion) => {
          const key = cfg.instanceKey(mcVersion, packLoader || null)
          const existing = cfg.getInstance(key)
          if (existing && (existing.status === 'installed' || existing.status === 'stopped' || existing.status === 'crashed')) return key
          const instance = { versionId: mcVersion, loader: packLoader || null, loaderVersion: packLoaderVersion || null }
          cfg.setInstance(key, { ...instance, status: 'installing' })
          await prepareInstance(instance, job)
          cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'installed' })
          return key
        },
        onLabel: (label) => setJob(job, { label: String(label).slice(0, 70) }),
        onProgress: (cur, total) => setJob(job, { label: `المودباك ${cur}/${total}`, current: cur, total })
      }
    )
    logLine(`>> Local modpack imported ${r.name || r.instanceId} (files ${r.files}, mods ${r.mods}${r.failed ? ', failed to download ' + r.failed : ''})`)
    return r
  })
  res.json({ jobId: job.id })
})

app.get('/api/mods/installed', (req, res) => {
  const instanceId = req.query.instance || ''
  if (!instanceId) return res.json([])
  res.json(mods.listInstalled(instanceId, req.query.type || 'mod'))
})

app.post('/api/mods/remove', (req, res) => {
  const { instanceId, file, type } = req.body
  if (!instanceId || !file) return res.status(400).json({ error: 'instanceId و file مطلوبان' })
  try {
    mods.remove(instanceId, type || 'mod', file)
  } catch (e) {
    console.error('[remove error]', e)
    const msg = String(e.message || e)
    const hint = /EPERM|EACCES|EBUSY/.test(msg) ? ' — الملف محمي أو مستخدم من برنامج آخر (مثل OneDrive أو Minecraft). أغلق ما يستخدمه وحاول مجدداً.' : ''
    return res.status(400).json({ error: 'تعذر حذف ' + file + hint })
  }
  res.json({ ok: true })
})

app.post('/api/mods/pack-remove', (req, res) => {
  const { instanceId, packId } = req.body || {}
  if (!instanceId) return res.status(400).json({ error: 'instanceId مطلوب' })
  const inst = cfg.getInstance(instanceId)
  if (!inst) return res.status(400).json({ error: 'النسخة غير موجودة' })
  const packs = Array.isArray(inst.packs) ? inst.packs : (inst.pack ? [inst.pack] : [])
  if (!packs.length) return res.status(400).json({ error: 'لا يوجد مودباك مثبت في هذه النسخة' })
  const idx = packId ? packs.findIndex((p) => p && String(p.id) === String(packId)) : -1
  const pack = idx >= 0 ? packs[idx] : (packs.length === 1 ? packs[0] : null)
  if (!pack) return res.status(400).json({ error: 'المودباك غير موجود' })
  const files = Array.isArray(pack.files) ? pack.files : []
  const gameDir = path.join(cfg.paths().game, safeInstanceKey(instanceId))
  let removed = 0
  for (const rel of files) {
    const relPath = String(rel || '').replace(/\\/g, '/')
    if (!relPath || relPath.startsWith('.') || relPath.includes('..')) continue
    const target = path.normalize(path.join(gameDir, relPath))
    if (target === gameDir || !target.startsWith(gameDir + path.sep)) continue
    try {
      if (fs.existsSync(target)) {
        mods.rmForce(target)
        removed++
      }
    } catch (e) {}
  }
  const next = packs.filter((_, i) => i !== idx)
  cfg.setInstance(instanceId, { ...inst, packs: next, pack: undefined })
  res.json({ ok: true, removed })
})

app.post('/api/mods/open', (req, res) => {
  const instanceId = req.body.instanceId || ''
  if (!instanceId) return res.status(400).json({ error: 'instanceId مطلوب' })
  res.json({ dir: mods.openFolder(instanceId, req.body.type || 'mod') })
})

app.post('/api/mods/fix-missing', (req, res) => {
  const { instanceId } = req.body || {}
  if (!instanceId) return res.status(400).json({ error: 'instanceId مطلوب' })
  const rec = gameMissing.get(instanceId)
  if (!rec || !rec.missing.size) return res.status(400).json({ error: 'لا يوجد مودات ناقصة مسجلة' })
  rec.autoStarted = true
  const job = runMissingFix(instanceId)
  if (!job) return res.status(400).json({ error: 'النسخة غير موجودة' })
  res.json({ jobId: job.id })
})

app.get('/api/skins', async (req, res) => {
  try {
    const r = await skins.list({ query: req.query.q || '', page: req.query.page || 1 })
    res.json(r)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/skins/favorites', (req, res) => {
  res.json({ favorites: skins.loadFavorites() })
})

app.post('/api/skins/favorites/toggle', (req, res) => {
  const skin = req.body.skin
  if (!skin || !skin.id) return res.status(400).json({ error: 'skin مطلوب' })
  res.json({ favorites: skins.toggleFavorite(skin) })
})

app.post('/api/skins/apply', async (req, res) => {
  try {
    const { accountId, skinUrl, variant, name, preview } = req.body
    if (!accountId) return res.status(400).json({ error: 'accountId مطلوب' })
    if (!skinUrl) return res.status(400).json({ error: 'رابط السكن مطلوب' })
    const account = cfg.getAccount(accountId)
    if (!account) return res.status(404).json({ error: 'الحساب غير موجود' })
    const png = await skins.fetchBuffer(skinUrl)
    fs.mkdirSync(path.dirname(skins.skinPngPath(accountId)), { recursive: true })
    fs.writeFileSync(skins.skinPngPath(accountId), png)
    let local = true
    let uploaded = false
    if (account.type === 'microsoft' && account.accessToken) {
      try {
        await skins.uploadToMojang(account, variant === 'slim' ? 'slim' : 'classic', png)
        uploaded = true
        local = false
      } catch (e) {
        console.warn('[skin upload failed]', e.message)
        local = true
      }
    }
    const c = cfg.load()
    const acc = c.accounts.find((a) => a.id === accountId)
    if (acc) {
      acc.skin = {
        name: name || '',
        variant: variant === 'slim' ? 'slim' : 'classic',
        preview: preview || '',
        local,
        uploaded,
        url: skinUrl
      }
      cfg.save()
    }
    res.json({ ok: true, uploaded, local, name: name || '' })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/skins/remove', (req, res) => {
  const { accountId } = req.body
  if (!accountId) return res.status(400).json({ error: 'accountId مطلوب' })
  const c = cfg.load()
  const acc = c.accounts.find((a) => a.id === accountId)
  if (!acc) return res.status(404).json({ error: 'الحساب غير موجود' })
  delete acc.skin
  cfg.save()
  try { fs.unlinkSync(skins.skinPngPath(accountId)) } catch (e) {}
  res.json({ ok: true })
})

app.post('/api/skins/elyby-test', async (req, res) => {
  try {
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ error: 'البريد وكلمة المرور مطلوبان' })
    const auth = await skins.elybyAuthenticate(email, password)
    const profile = auth.selectedProfile || {}
    if (!profile.id) return res.status(400).json({ error: 'حساب Ely.by بلا ملف Minecraft' })
    res.json({ ok: true, uuid: profile.id, name: profile.name })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/skins/ely-upload', async (req, res) => {
  try {
    const { accountId } = req.body || {}
    if (!accountId) return res.status(400).json({ error: 'accountId مطلوب' })
    const account = cfg.getAccount(accountId)
    if (!account) return res.status(404).json({ error: 'الحساب غير موجود' })
    const pngFile = skins.skinPngPath(accountId)
    if (!fs.existsSync(pngFile)) return res.status(400).json({ error: 'لا يوجد سكن محفوظ لهذا الحساب — اختر سكن أولاً' })
    const s = cfg.load().settings || {}
    const email = s.elybyEmail
    const password = s.elybyPassword
    if (!email || !password) return res.status(400).json({ error: 'أدخل بيانات Ely.by في الإعدادات أولاً (بريد + كلمة مرور)' })
    const png = fs.readFileSync(pngFile)
    const result = await skins.elybyUpload({ email, password, pngBuffer: png })
    const c = cfg.load()
    const acc = c.accounts.find((a) => a.id === accountId)
    if (acc && acc.skin) {
      acc.skin.elyUploaded = true
      cfg.save()
    }
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/java', async (req, res) => {
  const [installedList, availableInfo] = await Promise.all([java.installed(), java.available()])
  res.json({ installed: installedList, available: availableInfo, recommended: [8, 16, 17, 21] })
})

app.post('/api/java/install', (req, res) => {
  const major = Number(req.body.major)
  if (!major) return res.status(400).json({ error: 'major مطلوب' })
  const job = createJob('java', `تثبيت جافا ${major}`)
  runJob(job, async () => {
    const bin = await java.install(major, (p) => setJob(job, { label: p.label, current: p.current, total: p.total }))
    return { major, bin }
  })
  res.json({ jobId: job.id })
})

app.get('/api/accounts', (req, res) => {
  const accounts = cfg.load().accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    premium: !!a.premium,
    clientId: a.clientId,
    hasProfile: a.type === 'microsoft' ? a.hasProfile !== false : true,
    xuid: a.xuid || '',
    skin: a.skin || null
  }))
  res.json({ accounts, offlineMode: cfg.load().settings.offlineMode !== false })
})

app.post('/api/accounts/offline', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'اكتب اسم اللاعب' })
  const account = {
    id: randomUUID(),
    name,
    uuid: launchLib.offlineUuid(name),
    type: 'offline',
    premium: false,
    accessToken: '0'
  }
  cfg.load().accounts.push(account)
  cfg.save()
  res.json({ account })
})

app.post('/api/accounts/ms/start', async (req, res) => {
  const settings = cfg.load().settings
  const clientId = (req.body && req.body.clientId) || settings.clientId || ''
  try {
    const dc = await ms.start(clientId)
    const job = createJob('ms-login', 'تسجيل دخول مايكروسوفت')
    runJob(job, async () => {
      const account = await ms.complete(clientId, dc, (label) => setJob(job, { label }))
      const c = cfg.load()
      c.accounts = c.accounts.filter((a) => a.type !== 'microsoft')
      c.accounts.push(account)
      cfg.save()
      return { id: account.id, name: account.name, type: 'microsoft', premium: true }
    })
    res.json({ jobId: job.id, userCode: dc.user_code, verificationUri: dc.verification_uri, message: dc.message })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/accounts/:id', (req, res) => {
  const c = cfg.load()
  c.accounts = c.accounts.filter((a) => a.id !== req.params.id)
  cfg.save()
  res.json({ ok: true })
})

app.patch('/api/accounts/:id', (req, res) => {
  const c = cfg.load()
  const acc = c.accounts.find((a) => a.id === req.params.id)
  if (!acc) return res.status(404).json({ error: 'not found' })
  if (req.body.name) {
    acc.name = String(req.body.name).trim()
    if (acc.type === 'offline') acc.uuid = launchLib.offlineUuid(acc.name)
  }
  cfg.save()
  res.json({ account: acc })
})

app.get('/api/config', (req, res) => {
  res.json(cfg.load().settings)
})

app.post('/api/config', (req, res) => {
  const c = cfg.load()
  const allowed = ['memory', 'java', 'jvmArgs', 'width', 'height', 'clientId', 'offlineMode', 'curseforgeKey', 'elybyEmail', 'elybyPassword', 'lang']
  for (const k of allowed) {
    if (req.body[k] !== undefined) c.settings[k] = req.body[k]
  }
  cfg.save()
  res.json(cfg.load().settings)
})

function controlsStatus() {
  const c = cfg.load().controls || {}
  return {
    auto: !!c.auto,
    target: c.target || '',
    active: c.active || '',
    profiles: (c.profiles || []).map((p) => ({ id: p.id, name: p.name, source: p.source })),
    running: Array.from(runningGames.keys())
  }
}

function setControls(controls) {
  const c = cfg.load()
  c.controls = Object.assign({ auto: false, target: '', active: '', profiles: [] }, controls)
  cfg.save()
}

function getProfile(id) {
  const c = cfg.load().controls || {}
  return (c.profiles || []).find((p) => p.id === id) || null
}

app.get('/api/options', (req, res) => {
  res.json(controlsStatus())
})

app.post('/api/options/save', (req, res) => {
  let key = (req.body && req.body.key) || ''
  if (!key) return res.status(400).json({ error: 'حدد النسخة أولًا' })
  if (!cfg.getInstance(key)) return res.status(404).json({ error: 'النسخة غير موجودة' })
  const gameDir = path.join(cfg.paths().game, key)
  if (!fs.existsSync(path.join(gameDir, 'options.txt'))) {
    return res.status(404).json({ error: `لا يوجد options.txt في النسخة ${key} — شغّلها مرة أولى ليُنشأ` })
  }
  const c = cfg.load().controls || {}
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  if (!controls.saveProfile(gameDir, cfg.paths().data, id)) {
    return res.status(500).json({ error: 'فشل حفظ نسخة الإعدادات' })
  }
  const profiles = c.profiles || []
  const profile = { id, name: 'إعدادات ' + (profiles.length + 1), source: key }
  setControls({ ...c, profiles: [...profiles, profile], active: id })
  res.json(controlsStatus())
})

app.post('/api/options/delete', (req, res) => {
  const id = (req.body && req.body.id) || ''
  if (!id) return res.status(400).json({ error: 'id مطلوب' })
  const c = cfg.load().controls || {}
  controls.deleteProfile(cfg.paths().data, id)
  const profiles = (c.profiles || []).filter((p) => p.id !== id)
  let active = c.active
  if (active === id) active = profiles.length ? profiles[profiles.length - 1].id : ''
  setControls({ ...c, profiles, active })
  res.json(controlsStatus())
})

app.post('/api/options/apply', (req, res) => {
  const id = (req.body && req.body.id) || ''
  if (!id) return res.status(400).json({ error: 'id مطلوب' })
  const profile = getProfile(id)
  if (!profile) return res.status(404).json({ error: 'الملف غير موجود' })
  let target = (req.body && req.body.target) || ''
  const targets = []
  if (target === '') {
    const running = Array.from(runningGames.keys())
    target = running.length ? running[0] : 'all'
  }
  if (target === 'all') {
    for (const key of Object.keys(cfg.load().instances || {})) {
      const gameDir = path.join(cfg.paths().game, key)
      if (fs.existsSync(path.join(gameDir))) {
        controls.applyProfile(gameDir, cfg.paths().data, id)
        targets.push(key)
      }
    }
  } else {
    if (!cfg.getInstance(target)) return res.status(404).json({ error: 'النسخة غير موجودة' })
    controls.applyProfile(path.join(cfg.paths().game, target), cfg.paths().data, id)
    targets.push(target)
  }
  res.json({ profile: profile.name, targets })
})

app.post('/api/options/config', (req, res) => {
  const c = cfg.load().controls || {}
  const next = { ...c }
  if (req.body && req.body.auto !== undefined) next.auto = !!req.body.auto
  if (req.body && req.body.target !== undefined) next.target = req.body.target || ''
  if (req.body && req.body.active !== undefined) {
    if (req.body.active && !getProfile(req.body.active)) return res.status(404).json({ error: 'الملف غير موجود' })
    next.active = req.body.active || ''
  }
  setControls(next)
  res.json(controlsStatus())
})

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'internal error' })
})

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`
  console.log(`KrypLauncher running at ${url}`)
  if (process.pkg && process.argv.indexOf('--no-open') === -1) {
    const opener = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open ' + url : 'xdg-open ' + url
    setTimeout(() => {
      require('child_process').exec(opener)
    }, 1200)
  }
})
