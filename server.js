const fs = require('fs')
const path = require('path')
const express = require('express')
const { randomUUID } = require('crypto')

const cfg = require('./lib/config')
const mojang = require('./lib/mojang')
const java = require('./lib/java')
const fabric = require('./lib/fabric')
const forge = require('./lib/forge')
const ms = require('./lib/microsoft')
const launchLib = require('./lib/launch')
const mods = require('./lib/mods')
const modfix = require('./lib/modfix')
const skins = require('./lib/skins')

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

function createJob(type, label) {
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
    logLine(`[OmniLauncher] ⚠️ ${miss ? 'مطلوب مود ناقص: ' + miss : ''}${conf ? (miss ? ' — ' : '') + 'تعارض مودات: ' + conf : ''}`)
  }
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
    logLine(ok ? `[OmniLauncher] ✅ تم تحميل ${ok} مود ناقص تلقائياً` : '[OmniLauncher] لم يتم العثور على المودات الناقصة')
    if (fail.length) logLine(`[OmniLauncher] فشل تحميل: ${fail.map((x) => x.id).join(', ')}`)
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

  let fabricProfile = null
  let fabricArtifacts = []
  let forgeJson = null
  let forgeArtifacts = []
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
  }

  setJob(job, { label: 'تجهيز النيتفز' })
  const nativesDir = await mojang.ensureNatives(files.natives, instanceKey(instance.versionId, instance.loader), null, json)

  return { json, files, fabricProfile, fabricArtifacts, forgeJson, forgeArtifacts, javaBin, nativesDir }
}

function classpathFor(prep, versionId) {
  const P = cfg.paths()
  const parts = []
  for (const a of prep.files.artifacts) parts.push(path.join(P.libraries, a.path))
  parts.push(mojang.clientJarFile(versionId))
  for (const a of prep.fabricArtifacts) parts.push(path.join(P.libraries, a.path))
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
  return !!version && version !== 'undefined' && version !== 'null'
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
  for (const dir of [path.join(cfg.paths().game, key), path.join(cfg.paths().natives, key)]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
  res.json({ ok: true })
})

app.post('/api/play', (req, res) => {
  const { versionId, loader, loaderVersion, accountId, memory, jvmArgs, width, height } = req.body
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
    const settings = cfg.load().settings
    const mem = memory || settings.memory || 2048
    const jvm = (typeof jvmArgs === 'string' ? jvmArgs : settings.jvmArgs) || ''
    const w = width || settings.width || 0
    const h = height || settings.height || 0

    const gameDir = path.join(cfg.paths().game, key)
    fs.mkdirSync(gameDir, { recursive: true })
    const assetsDir = cfg.paths().assets
    const assetIndex = prep.files.index ? prep.files.index.id : null

    if (account.skin && account.skin.local) {
      const skinFile = skins.skinPngPath(account.id)
      if (fs.existsSync(skinFile)) {
        const mcVersion = prep.json.id || instance.versionId
        try {
          if (instance.loader) {
            const modFile = await skins.ensureCustomSkinLoader(gameDir, mcVersion)
            logLine('>> CustomSkinLoader: ' + path.basename(modFile))
            skins.installOfflineSkinLocal(gameDir, fs.readFileSync(skinFile), account.name)
            skins.removeOfflineSkinPack(gameDir)
            logLine('>> تم تطبيق السكن المحلي: ' + (account.skin.name || ''))
          } else {
            skins.installOfflineSkin(gameDir, fs.readFileSync(skinFile), mcVersion)
            logLine('>> تم تطبيق السكن المحلي: ' + (account.skin.name || ''))
          }
        } catch (e) {
          logLine('خطأ تطبيق السكن المحلي: ' + e.message)
        }
      }
    }

    let args
    if (prep.forgeJson) {
      const cp = launchLib.buildClasspath([
        ...prep.files.artifacts.map((a) => path.join(cfg.paths().libraries, a.path)),
        mojang.clientJarFile(versionId),
        ...prep.forgeArtifacts.map((a) => path.join(cfg.paths().libraries, a.path))
      ])
      const mainClass = prep.forgeJson.mainClass || 'net.minecraft.launchwrapper.Launch'
      args = launchLib.buildForgeArgs({
        forgeJson: prep.forgeJson,
        baseJson: prep.json,
        classpath: cp,
        mainClass,
        nativesDir: prep.nativesDir,
        gameDir,
        assetsDir,
        assetIndex,
        account,
        memory: mem,
        jvmArgs: jvm,
        width: w,
        height: h
      })
    } else {
      const mainClass = prep.fabricProfile ? fabric.mainClass(prep.fabricProfile) : 'net.minecraft.client.main.Main'
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
        height: h
      })
    }

    logLine(`>> تشغيل: ${prep.javaBin}`)
    logLine(`>> instance: ${key}`)
    gameMissing.delete(key)

    const child = launchLib.launch({ javaBin: prep.javaBin, args, cwd: gameDir })
    child.stdout.on('data', (d) => pushLog(key, d))
    child.stderr.on('data', (d) => pushLog(key, d))
    child.on('error', (err) => logLine('خطأ تشغيل: ' + err.message))
    child.on('exit', (code) => {
      const rec = gameMissing.get(key)
      runningGames.delete(key)
      logLine(`اللعبة انتهت برمز الخروج ${code}`)
      const inst = cfg.getInstance(key)
      if (inst) cfg.setInstance(key, { ...inst, status: code === 0 ? 'stopped' : 'crashed' })
      if (code !== 0 && rec && rec.missing.size && !rec.autoStarted) {
        rec.autoStarted = true
        runMissingFix(key)
      }
    })

    runningGames.set(key, { key, versionId: instance.versionId, loader: instance.loader, pid: child.pid, startedAt: new Date() })
    cfg.setInstance(key, { ...cfg.getInstance(key), ...instance, status: 'running' })
    return { pid: child.pid, instanceId: key }
  })

  res.json({ jobId: job.id, instanceId: key })
})

app.post('/api/stop', (req, res) => {
  const { key } = req.body || {}
  const targets = key ? [runningGames.get(key)].filter(Boolean) : Array.from(runningGames.values())
  if (!targets.length) return res.json({ ok: true, already: true })
  for (const g of targets) {
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

app.get('/api/jobs', (req, res) => {
  res.json(Object.values(jobs))
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
  const { source, id, version, loader, instanceId, forceUrl, forceFile, forceVersionId, fileId, slug, title, type } = req.body
  if (!id || !instanceId) return res.status(400).json({ error: 'id و instanceId مطلوبان' })
  const job = createJob('mods', type && type !== 'mod' ? 'تثبيت محتوى' : 'تثبيت مود')
  runJob(job, async () => {
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
        title: title || ''
      },
      (v) => setJob(job, { label: `تحميل ${v.filename}` })
    )
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
  mods.remove(instanceId, type || 'mod', file)
  res.json({ ok: true })
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

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'internal error' })
})

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`
  console.log(`OmniLauncher running at ${url}`)
  if (process.pkg && process.argv.indexOf('--no-open') === -1) {
    const opener = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open ' + url : 'xdg-open ' + url
    setTimeout(() => {
      require('child_process').exec(opener)
    }, 1200)
  }
})
