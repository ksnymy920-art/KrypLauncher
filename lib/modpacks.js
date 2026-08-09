const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const cfg = require('./config')
const { getJSON, download, downloadWithFallback, pool, sha1File } = require('./download')
const mods = require('./mods')

const MODRINTH = 'https://api.modrinth.com/v2'
const CURSE_PROXY = 'https://api.curse.tools/v1'
const CURSE_OFFICIAL = 'https://api.curseforge.com/v1'

function curseKey() {
  return (cfg.load().settings.curseforgeKey || '').trim()
}

function curseBase() {
  return curseKey() ? CURSE_OFFICIAL : CURSE_PROXY
}

async function curseRequest(apiPath, qs) {
  const headers = curseKey() ? { 'x-api-key': curseKey() } : {}
  return getJSON(`${curseBase()}/${apiPath}?${qs.join('&')}`, { headers })
}

function familyOf(version) {
  const m = /^(\d+\.\d+)/.exec(String(version || '').trim())
  return m ? m[1] : ''
}

async function resolveModrinth({ id, versionId, fallbackVersion, fallbackLoader }) {
  let v = null
  if (versionId) {
    v = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}/version/${encodeURIComponent(versionId)}`)
  } else {
    const qs = []
    if (fallbackVersion) qs.push(`game_versions=${encodeURIComponent(JSON.stringify([fallbackVersion]))}`)
    if (fallbackLoader && fallbackLoader !== 'vanilla') qs.push(`loaders=${encodeURIComponent(JSON.stringify([fallbackLoader]))}`)
    let list = []
    try {
      list = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}/version` + (qs.length ? '?' + qs.join('&') : ''))
    } catch (e) {}
    if (!list.length && fallbackVersion) {
      const fam = familyOf(fallbackVersion)
      try {
        const all = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}/version`)
        list = fam ? (all || []).filter((x) => (x.game_versions || []).some((g) => String(g) === fam || String(g).startsWith(fam + '.'))) : []
      } catch (e) {}
    }
    v = (list || [])[0]
  }
  if (!v) throw new Error('ما فيه نسخة للمودباك')
  const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0]
  if (!f || !f.url) throw new Error('ما فيه ملف تحميل للمودباك')
  let title = ''
  try {
    const p = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}`)
    title = p.title || ''
  } catch (e) {}
  return {
    source: 'modrinth',
    name: title || v.name || '',
    versionId: v.id,
    versionNumber: v.version_number || '',
    downloadUrl: f.url,
    filename: f.filename || 'pack.mrpack',
    gameVersions: v.game_versions || []
  }
}

async function curseDownloadUrl(id, fileId) {
  try {
    const r = await curseRequest(`mods/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/download-url`, [])
    if (r.data && typeof r.data === 'string' && r.data.startsWith('http')) return r.data
  } catch (e) {}
  return ''
}

async function resolveCurse({ id, fileId, forceUrl, forceFile }) {
  let file = null
  if (fileId) {
    const data = await curseRequest(`mods/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, [])
    file = data.data || null
  }
  if (!file) {
    const data = await curseRequest(`mods/${encodeURIComponent(id)}/files`, ['pageSize=50', 'sortField=2', 'sortOrder=desc'])
    file = (data.data || [])[0] || null
  }
  if (!file) throw new Error('ما فيه ملف للمودباك')
  let url = forceUrl || file.downloadUrl || ''
  if (!url) url = await curseDownloadUrl(id, file.id)
  if (!url) throw new Error('رابط تحميل المودباك غير متاح')
  return {
    source: 'curseforge',
    name: file.displayName || file.fileName || '',
    versionId: String(file.id),
    versionNumber: '',
    downloadUrl: url,
    filename: forceFile || file.fileName || 'pack.zip'
  }
}

async function resolvePack(opts) {
  if (opts.source === 'curseforge') return resolveCurse(opts)
  return resolveModrinth(opts)
}

function parseManifest(zip) {
  const index = zip.getEntry('modrinth.index.json')
  if (index) {
    let j = {}
    try {
      j = JSON.parse(index.getData('utf8'))
    } catch (e) {
      throw new Error('modrinth.index.json تالف')
    }
    const deps = j.dependencies || {}
    const loader = deps['quilt-loader'] ? 'quilt' : deps['fabric-loader'] ? 'fabric' : deps.neoforge ? 'neoforge' : deps.forge ? 'forge' : ''
    const loaderVersion = deps['quilt-loader'] || deps['fabric-loader'] || deps.neoforge || deps.forge || ''
    return {
      format: 'mrpack',
      name: j.name || '',
      mc: deps.minecraft || '',
      loader,
      loaderVersion,
      downloads: (j.files || []).map((f) => ({
        path: String(f.path || '').replace(/\\/g, '/'),
        urls: (f.downloads || []).filter((u) => typeof u === 'string' && u.startsWith('http')),
        hashes: f.hashes || {}
      })).filter((f) => f.path && f.urls.length)
    }
  }
  const mf = zip.getEntry('manifest.json')
  if (mf) {
    let j = {}
    try {
      j = JSON.parse(mf.getData('utf8'))
    } catch (e) {
      throw new Error('manifest.json تالف')
    }
    const mc = (j.minecraft && j.minecraft.version) || ''
    const ml = j.modLoader || {}
    const map = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge', quilt: 'quilt' }
    const loader = map[String(ml.id || '').toLowerCase()] || ''
    return {
      format: 'curse',
      name: j.name || '',
      mc,
      loader,
      loaderVersion: ml.version || '',
      downloads: [],
      files: (j.files || []).map((f) => ({
        path: String(f.path || '').replace(/\\/g, '/'),
        projectId: f.projectID,
        fileId: f.fileID
      })).filter((f) => f.path)
    }
  }
  throw new Error('المودباك غير مدعوم — لا يوجد manifest.json أو modrinth.index.json')
}

function safePath(base, rel) {
  const target = path.normalize(path.join(base, rel))
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

function applyEntries(zip, gameDir, format, onLabel) {
  const skipRoot = new Set(['manifest.json', 'modlist.html', 'modrinth.index.json', 'clientmanifest.json'])
  let count = 0
  const rels = []
  for (const entry of zip.getEntries()) {
    const raw = String(entry.entryName).replace(/\\/g, '/')
    if (entry.isDirectory || raw.startsWith('__MACOSX/')) continue
    let rel = null
    if (format === 'mrpack') {
      if (raw.startsWith('overrides/')) rel = raw.slice('overrides/'.length)
      else if (raw.startsWith('client-overrides/')) rel = raw.slice('client-overrides/'.length)
      else if (raw.startsWith('mods/')) rel = raw
      else continue
    } else {
      const top = raw.split('/')[0]
      if (skipRoot.has(top) || top.startsWith('.') || raw.includes('..')) continue
      rel = raw
    }
    if (!rel || rel.startsWith('.') || rel.includes('..')) continue
    const target = safePath(gameDir, rel)
    if (!target) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.getData())
    rels.push(rel)
    count++
  }
  if (onLabel) onLabel(`نسخ ملفات المودباك (${count})`)
  return { count, rels }
}

async function downloadPackFiles(downloads, gameDir, onProgress) {
  const pending = []
  for (const f of downloads) {
    const target = safePath(gameDir, f.path)
    if (!target) continue
    if (!fs.existsSync(target)) pending.push({ target, urls: f.urls, sha1: String((f.hashes && f.hashes.sha1) || '').toLowerCase() })
  }
  if (pending.some((p) => p.sha1)) {
    const modsDir = path.join(gameDir, 'mods')
    const existingJars = []
    try {
      if (fs.existsSync(modsDir)) {
        for (const n of fs.readdirSync(modsDir)) {
          if (!String(n).toLowerCase().endsWith('.jar')) continue
          const full = path.join(modsDir, n)
          const norm = path.normalize(full).toLowerCase()
          if (!pending.some((p) => path.normalize(p.target).toLowerCase() === norm)) existingJars.push(full)
        }
      }
    } catch (e) {}
    const hashCache = new Map()
    for (const p of pending) {
      if (!p.sha1) continue
      for (const existing of existingJars) {
        let h = hashCache.get(existing)
        if (h === undefined) {
          h = (await sha1File(existing)) || ''
          hashCache.set(existing, h)
        }
        if (h && h === p.sha1) {
          try { fs.unlinkSync(existing) } catch (e) {}
          const i = existingJars.indexOf(existing)
          if (i >= 0) existingJars.splice(i, 1)
          break
        }
      }
    }
  }
  let done = 0
  let failed = 0
  const total = pending.length
  await pool(pending, 8, async ({ target, urls }) => {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await downloadWithFallback(urls, target)
    } catch (e) {
      failed++
    }
    done++
    if (onProgress) onProgress(done, total)
  })
  return { total, downloaded: total - failed, failed }
}

async function installPack(opts, helpers) {
  let info
  let tmpFile
  if (opts.source === 'local' && opts.forceFile) {
    if (!fs.existsSync(opts.forceFile)) throw new Error('ملف المودباك غير موجود')
    info = {
      source: 'local',
      name: opts.title || path.basename(opts.forceFile).replace(/\.(zip|mrpack)$/i, ''),
      filename: path.basename(opts.forceFile),
      versionId: ''
    }
    tmpFile = opts.forceFile
  } else {
    info = await resolvePack(opts)
    if (helpers.onLabel) helpers.onLabel(`تنزيل المودباك: ${info.name}`)
    tmpFile = path.join(cfg.paths().tmp, `pack-${Date.now()}-${path.basename(String(info.filename || 'pack.zip')).replace(/[\\/:*?"<>|]/g, '_')}`)
    await download(info.downloadUrl, tmpFile, { onProgress: (r, t) => helpers.onProgress && helpers.onProgress(r, t) })
  }
  const zip = new AdmZip(tmpFile)
  const meta = parseManifest(zip)
  const mc = meta.mc || opts.fallbackVersion || ''
  const loader = meta.loader || opts.fallbackLoader || ''
  if (!mc) throw new Error('المودباك لا يحدد نسخة ماينكرافت — اختر النسخة واللودر من الأعلى')
  if (meta.loaderVersion && !['fabric', 'forge', 'neoforge', 'quilt'].includes(loader)) {
    throw new Error(`المودباك يتطلب لودر غير مدعوم: ${meta.loaderVersion}`)
  }

  if (helpers.onLabel) helpers.onLabel(`تجهيز نسخة ${mc} (${loader || 'فانيلا'})`)
  const instanceId = await helpers.ensureInstance(mc, loader, meta.loaderVersion || opts.fallbackLoaderVersion || '')
  const gameDir = path.join(cfg.paths().game, instanceId)
  fs.mkdirSync(gameDir, { recursive: true })

  const applied = applyEntries(zip, gameDir, meta.format, helpers.onLabel)
  const copied = applied.count
  const packRels = applied.rels
  let dlResult = { total: 0, downloaded: 0, failed: 0 }
  if (meta.downloads.length) {
    dlResult = await downloadPackFiles(meta.downloads, gameDir, helpers.onProgress)
    for (const d of meta.downloads) packRels.push(String(d.path || '').replace(/\\/g, '/'))
  }
  const CONTENT_PREFIXES = ['mods/', 'shaderpacks/', 'resourcepacks/', 'saves/']
  const modFiles = []
  const modSeen = new Set()
  const pushContent = (p) => {
    if (!p || !CONTENT_PREFIXES.some((x) => String(p).toLowerCase().startsWith(x))) return
    const low = String(p).toLowerCase()
    if (modSeen.has(low)) return
    modSeen.add(low)
    modFiles.push({ path: p })
  }
  for (const d of meta.downloads) pushContent(d.path)
  for (const f of (meta.files || [])) pushContent(f.path)
  for (const rel of packRels) pushContent(rel)
  if (modFiles.length) {
    mods.enrichPackMods(instanceId, modFiles)
      .catch(() => {})
      .then(() => mods.enrichPackIcons(instanceId, modFiles))
      .catch(() => {})
  }
  try { if (opts.source !== 'local') fs.unlinkSync(tmpFile) } catch (e) {}

  const inst = cfg.getInstance(instanceId)
  if (inst) {
    const entry = {
      name: meta.name || info.name || opts.title || opts.slug || '',
      source: info.source,
      id: opts.id || '',
      versionId: info.versionId || '',
      local: opts.source === 'local',
      icon: opts.icon || '',
      files: [...new Set(packRels.filter(Boolean))]
    }
    const packs = Array.isArray(inst.packs)
      ? inst.packs.filter((p) => !(p && p.id && p.id === entry.id && p.source === entry.source))
      : (inst.pack ? [inst.pack] : [])
    packs.push(entry)
    cfg.setInstance(instanceId, { ...inst, pack: undefined, packs })
  }
  return {
    instanceId,
    mc,
    loader,
    files: copied,
    mods: dlResult.downloaded,
    failed: dlResult.failed,
    name: meta.name || info.name || opts.title || opts.slug || ''
  }
}

module.exports = { resolvePack, installPack, parseManifest }
