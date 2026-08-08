const fs = require('fs')
const path = require('path')
const cfg = require('./config')
const { getJSON, download } = require('./download')

const MODRINTH = 'https://api.modrinth.com/v2'
const CURSE_PROXY = 'https://api.curse.tools/v1'
const CURSE_OFFICIAL = 'https://api.curseforge.com/v1'

const CURSE_LOADERS = { vanilla: 0, forge: 1, fabric: 4, quilt: 5, neoforge: 6 }

function curseKey() {
  return (cfg.load().settings.curseforgeKey || '').trim()
}

function curseBase() {
  return curseKey() ? CURSE_OFFICIAL : CURSE_PROXY
}

async function curseRequest(path, qs) {
  const key = curseKey()
  const headers = key ? { 'x-api-key': key } : {}
  return getJSON(`${curseBase()}/${path}?${qs.join('&')}`, { headers })
}

async function searchModrinth({ query, version, loader, limit = 20, page = 1, type = 'mod' }) {
  const facets = [`["project_type:${type}"]`]
  if (version) facets.push(`["versions:${version}"]`)
  if (loader && loader !== 'vanilla') facets.push(`["categories:${loader}"]`)
  const offset = Math.max(0, (page - 1) * limit)
  const url = `${MODRINTH}/search?limit=${limit}&offset=${offset}&query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent('[' + facets.join(',') + ']')}`
  const data = await getJSON(url)
  return {
    source: 'modrinth',
    page,
    total: data.total_hits || 0,
    hasMore: page * limit < (data.total_hits || 0),
    items: (data.hits || []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description || '',
      icon: h.icon_url || '',
      downloads: h.downloads || 0,
      follows: h.follows || 0,
      loaders: (h.categories || []).filter((c) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
      author: h.author || '',
      source: 'modrinth'
    }))
  }
}

function familyOf(version) {
  const m = /^(\d+\.\d+)/.exec(String(version || '').trim())
  return m ? m[1] : ''
}

function familyMatch(list, target) {
  const fam = familyOf(target)
  if (!fam) return list || []
  return (list || []).filter((v) => (v.game_versions || []).some((g) => String(g) === fam || String(g).startsWith(fam + '.')))
}

async function modrinthVersions(projectId, { version, loader }) {
  const qs = []
  if (version) qs.push(`game_versions=${encodeURIComponent(JSON.stringify([version]))}`)
  if (loader && loader !== 'vanilla') qs.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`)
  const url = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version` + (qs.length ? '?' + qs.join('&') : '')
  let list = await getJSON(url)
  if (!list || !list.length) {
    const qs2 = []
    if (loader && loader !== 'vanilla') qs2.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`)
    const url2 = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version` + (qs2.length ? '?' + qs2.join('&') : '')
    const all = await getJSON(url2)
    list = version ? familyMatch(all, version) : (all || [])
  }
  const fam = familyOf(version)
  return (list || [])
    .sort((a, b) => {
      const aRoot = fam && (a.game_versions || []).some((g) => String(g) === fam)
      const bRoot = fam && (b.game_versions || []).some((g) => String(g) === fam)
      if (aRoot !== bRoot) return aRoot ? -1 : 1
      return new Date(b.date_published) - new Date(a.date_published)
    })
    .map((v) => {
      const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0] || null
      return {
        id: v.id,
        name: v.name,
        version_number: v.version_number,
        game_versions: v.game_versions || [],
        loaders: v.loaders || [],
        url: f ? f.url : '',
        filename: f ? f.filename : '',
        size: f ? f.size : 0,
        date: v.date_published,
        dependencies: v.dependencies || []
      }
    })
}

async function searchCurse({ query, version, loader, limit = 20, page = 1, type = 'mod' }) {
  const classId = type === 'world' ? 17 : type === 'shader' || type === 'resourcepack' ? 12 : 6
  const build = (v) => {
    const qs = ['gameId=432', `classId=${classId}`, `pageSize=${Math.min(limit, 50)}`, `index=${Math.max(0, page - 1)}`, 'sortField=6', 'sortOrder=desc']
    if (v) qs.push(`gameVersion=${encodeURIComponent(v)}`)
    const lt = CURSE_LOADERS[loader]
    if (lt && type === 'mod') qs.push(`modLoaderType=${lt}`)
    if (query) qs.push(`searchFilter=${encodeURIComponent(query)}`)
    return qs
  }
  let data = await curseRequest('mods/search', build(version))
  let total = data.pagination ? data.pagination.totalCount : (data.data || []).length
  if (version && total < 8) {
    const d2 = await curseRequest('mods/search', build(''))
    data = d2
    total = d2.pagination ? d2.pagination.totalCount : (d2.data || []).length
  }
  return {
    source: 'curseforge',
    page,
    total,
    hasMore: page * limit < total,
    items: (data.data || []).map((m) => ({
      id: String(m.id),
      slug: m.slug,
      title: m.name,
      description: m.summary || '',
      icon: (m.logo && m.logo.url) || '',
      downloads: m.downloadCount || m.totalDownloads || 0,
      follows: 0,
      loaders: [],
      author: '',
      source: 'curseforge'
    }))
  }
}

async function curseVersions(modId, { version, loader }) {
  const qs = ['pageSize=50']
  if (version) qs.push(`gameVersion=${encodeURIComponent(version)}`)
  const lt = CURSE_LOADERS[loader]
  if (lt) qs.push(`modLoaderType=${lt}`)
  let data = await curseRequest(`mods/${encodeURIComponent(modId)}/files`, qs)
  let files = (data.data || [])
  if (!files.length && version) {
    const qs2 = ['pageSize=50']
    if (lt) qs2.push(`modLoaderType=${lt}`)
    const d2 = await curseRequest(`mods/${encodeURIComponent(modId)}/files`, qs2)
    files = familyMatch(d2.data, version)
  }
  return files
    .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
    .map((f) => ({
      id: String(f.id),
      fileId: String(f.id),
      name: f.displayName || f.fileName,
      version_number: f.fileName,
      game_versions: f.gameVersions || [],
      loaders: [],
      url: f.downloadUrl || '',
      filename: f.fileName,
      size: f.fileLength || 0,
      date: f.fileDate
    }))
}

function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\(\[].*?[\)\]]/g, ' ')
    .replace(/(?:\d+\.)+\d+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fabric|forge|neoforge|quilt|for|minecraft|mc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function mergeSources(modrinthItems, curseItems) {
  const byKey = new Map()
  const itemKeys = new Map()
  const keysFor = (item) => {
    const keys = new Set()
    if (item.slug) keys.add('slug:' + String(item.slug).toLowerCase().replace(/[^a-z0-9]/g, ''))
    const nt = normTitle(item.title)
    if (nt.length >= 3) keys.add('title:' + nt)
    if (!keys.size) keys.add('id:' + String(item.id))
    return keys
  }
  const put = (item) => {
    const keys = keysFor(item)
    let existing = null
    for (const k of keys) if (byKey.has(k)) { existing = byKey.get(k); break }
    if (existing) {
      if (item.source === 'modrinth' && existing.source !== 'modrinth') {
        const oldKeys = itemKeys.get(existing) || []
        for (const k of oldKeys) if (byKey.get(k) === existing) byKey.delete(k)
        for (const k of keys) byKey.set(k, item)
        itemKeys.set(item, keys)
        itemKeys.delete(existing)
      }
      return
    }
    for (const k of keys) byKey.set(k, item)
    itemKeys.set(item, keys)
  }
  for (const it of curseItems) put(it)
  for (const it of modrinthItems) put(it)
  return [...new Set(byKey.values())]
}

async function fetchSourcePool(fetch, target, pageSize) {
  const pages = Math.max(1, Math.ceil(target / pageSize))
  const settled = await Promise.allSettled(Array.from({ length: pages }, (_, i) => fetch({ page: i + 1 })))
  return settled.reduce((acc, s) => (s.status === 'fulfilled' ? acc.concat(s.value.items || []) : acc), [])
}

async function search(opts) {
  let res
  const type = opts.type || 'mod'
  if (type === 'world') {
    res = await searchCurse({ ...opts, type })
  } else if (opts.source === 'all') {
    const pool = 400
    const settled = await Promise.allSettled([
      fetchSourcePool((p) => searchModrinth({ ...opts, ...p, limit: 100 }), pool, 100),
      fetchSourcePool((p) => searchCurse({ ...opts, ...p, limit: 50 }), pool, 50)
    ])
    const srcs = settled.map((s) => (s.status === 'fulfilled' ? { items: s.value } : { items: [], failed: s.reason }))
    if (srcs[0].items.length + srcs[1].items.length === 0) throw (srcs[0].failed || srcs[1].failed || new Error('search failed'))
    const all = mergeSources(srcs[0].items, srcs[1].items)
    all.sort((x, y) => (y.downloads || 0) - (x.downloads || 0))
    const page = Math.max(1, opts.page || 1)
    const limit = Math.max(1, opts.limit || 20)
    const start = (page - 1) * limit
    res = { source: 'all', page, total: all.length, hasMore: start + limit < all.length, items: all.slice(start, start + limit) }
  } else {
    res = opts.source === 'curseforge' ? await searchCurse(opts) : await searchModrinth(opts)
  }
  try {
    const instanceId = opts.instance || opts.instanceId || ''
    const meta = loadMeta(instanceId)
    const files = listInstalled(instanceId, type).map((f) => f.file.toLowerCase())
    for (const item of res.items) {
      const key = item.id || item.slug || ''
      item.installed = meta.some((m) => (m.projectId && m.projectId === key) || (item.slug && m.slug === item.slug)) ||
        files.some((f) => item.slug && f.includes(item.slug.toLowerCase()))
    }
  } catch (e) {}
  return res
}

async function versions(opts) {
  const type = opts.type || 'mod'
  const o = { ...opts }
  if (type !== 'mod') o.loader = ''
  if (o.source === 'curseforge') return curseVersions(o.id, o)
  return modrinthVersions(o.id, o)
}

function contentDir(instanceId, type) {
  const t = type || 'mod'
  const sub = t === 'shader' ? 'shaderpacks' : t === 'resourcepack' ? 'resourcepacks' : t === 'world' ? 'saves' : 'mods'
  const dir = path.join(cfg.paths().game, instanceId, sub)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function modsDir(instanceId) {
  return contentDir(instanceId, 'mod')
}

function safeFileName(name) {
  const base = path.basename(String(name || 'mod.jar')).replace(/[\\/:*?"<>|]/g, '_')
  return base.toLowerCase().endsWith('.jar') ? base : base + '.jar'
}

function safeContentName(name, type) {
  const base = path.basename(String(name || 'content.zip')).replace(/[\\/:*?"<>|]/g, '_')
  if (type === 'mod') return base.toLowerCase().endsWith('.jar') ? base : base + '.jar'
  const ext = path.extname(base).toLowerCase()
  if (['.zip', '.jar'].includes(ext)) return base
  return base + '.zip'
}

function extractWorld(zipFile, savesDir, zipName) {
  const AdmZip = require('adm-zip')
  const work = path.join(cfg.paths().tmp, 'world-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(work, { recursive: true })
  try {
    new AdmZip(zipFile).extractAllTo(work, true)
    let src = null
    const walk = (dir, depth) => {
      if (src || depth > 4) return
      for (const e of fs.readdirSync(dir)) {
        const p = path.join(dir, e)
        if (fs.statSync(p).isDirectory()) {
          if (fs.existsSync(path.join(p, 'level.dat'))) {
            src = p
            return
          }
          walk(p, depth + 1)
        }
      }
    }
    walk(work, 0)
    if (!src) throw new Error('الملف المضغوط لا يحتوي على عالم صالح')
    let base = path.basename(src)
    if (!base || base.length < 2) {
      base = path.basename(String(zipName || 'World'), path.extname(String(zipName || ''))).replace(/[\\/:*?"<>|]/g, '_').trim() || 'World'
    }
    let target = path.join(savesDir, base)
    let i = 1
    while (fs.existsSync(target)) target = path.join(savesDir, `${base} - ${i++}`)
    fs.renameSync(src, target)
    return target
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

function installedMetaFile(instanceId) {
  return path.join(modsDir(instanceId), 'installed-mods.json')
}

function loadMeta(instanceId) {
  if (!instanceId) return []
  try {
    return JSON.parse(fs.readFileSync(installedMetaFile(instanceId), 'utf8')) || []
  } catch (e) {
    return []
  }
}

function saveMeta(instanceId, arr) {
  try {
    fs.writeFileSync(installedMetaFile(instanceId), JSON.stringify(arr, null, 2))
  } catch (e) {}
}

function metaAdd(instanceId, entries) {
  const arr = loadMeta(instanceId)
  for (const e of entries) {
    if (!arr.some((m) => m.file === e.file)) arr.push(e)
  }
  saveMeta(instanceId, arr)
}

function metaRemove(instanceId, fileName) {
  saveMeta(instanceId, loadMeta(instanceId).filter((m) => m.file !== fileName))
}

async function modrinthDepsFor(projectId, versionId) {
  const v = await getJSON(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version/${encodeURIComponent(versionId)}`)
  return (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id)
}

async function curseDepsFor(modId, fileId) {
  const data = await curseRequest(`mods/${encodeURIComponent(modId)}/files/${encodeURIComponent(fileId)}`)
  return ((data.data && data.data.dependencies) || []).filter((d) => d.relationType === 1)
}

async function downloadDeps(opts, v, installed, seen, count, onVersion) {
  const curse = (opts.source || 'modrinth') === 'curseforge'
  let deps = []
  if (curse) {
    if (v.fileId) deps = await curseDepsFor(opts.id, v.fileId)
  } else {
    if (v.id) deps = await modrinthDepsFor(opts.id, v.id)
  }
  for (const d of deps) {
    const pid = curse ? String(d.modId) : d.project_id
    if (!pid || seen.has(pid)) continue
    seen.add(pid)
    const list = curse
      ? await curseVersions(pid, { version: opts.version, loader: opts.loader })
      : await modrinthVersions(pid, { version: opts.version, loader: opts.loader })
    const dep = (list || [])[0]
    if (!dep || !dep.url) continue
    const dest = path.join(modsDir(opts.instanceId), safeFileName(dep.filename))
    if (fs.existsSync(dest)) continue
    if (onVersion) onVersion(dep)
    await download(dep.url, dest, {})
    installed.push({
      file: path.basename(dest),
      projectId: pid,
      slug: '',
      title: dep.name || dep.version_number || '',
      source: curse ? 'curseforge' : 'modrinth',
      versionNumber: dep.version_number || '',
      dependency: true
    })
    count.n++
    await downloadDeps({ ...opts, id: pid, source: curse ? 'curseforge' : 'modrinth' }, dep, installed, seen, count, onVersion)
  }
  return count
}

async function install(opts, onVersion) {
  const type = opts.type || 'mod'
  let v = null
  if (opts.forceUrl) {
    v = { url: opts.forceUrl, filename: opts.forceFile || 'mod.jar', name: opts.forceFile || 'mod', version_number: '', size: 0 }
    if (opts.forceVersionId) v.id = opts.forceVersionId
    if (opts.fileId) v.fileId = opts.fileId
  } else {
    const list = await versions(opts)
    v = (list || [])[0]
  }
  if (!v || !v.url) throw new Error('ما فيه إصدار متوافق مع نسختك')
  if (onVersion) onVersion(v)

  if (type === 'world') {
    const tmpFile = path.join(cfg.paths().tmp, 'world-' + Date.now() + '-' + path.basename(String(v.filename || 'world.zip')))
    await download(v.url, tmpFile, { onProgress: opts.onProgress })
    const target = extractWorld(tmpFile, contentDir(opts.instanceId, 'world'), v.filename)
    try { fs.unlinkSync(tmpFile) } catch (e) {}
    return { file: path.basename(target), name: v.name, version_number: v.version_number || '', size: v.size || 0, dependencies: 0 }
  }

  const dest = path.join(contentDir(opts.instanceId, type), safeContentName(v.filename, type))
  await download(v.url, dest, { onProgress: opts.onProgress })

  if (type !== 'mod') {
    return { file: path.basename(dest), name: v.name, version_number: v.version_number || '', size: v.size || 0, dependencies: 0 }
  }

  const installed = [{
    file: path.basename(dest),
    projectId: opts.id,
    slug: opts.slug || '',
    title: opts.title || v.name || '',
    source: opts.source || 'modrinth',
    versionNumber: v.version_number || '',
    dependency: false
  }]

  let dependencies = 0
  try {
    const count = await downloadDeps(opts, v, installed, new Set([opts.id]), { n: 0 }, onVersion)
    dependencies = count.n
  } catch (e) {}
  metaAdd(opts.instanceId, installed)

  return { file: path.basename(dest), name: v.name, version_number: v.version_number, size: v.size, dependencies }
}

function listInstalled(instanceId, type) {
  if (!instanceId) return []
  const t = type || 'mod'
  const dir = contentDir(instanceId, t)
  if (t === 'world') {
    try {
      return fs.readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isDirectory())
        .map((f) => {
          const st = fs.statSync(path.join(dir, f))
          return { file: f, size: st.size, modified: st.mtime, isDir: true }
        })
        .sort((a, b) => a.file.localeCompare(b.file))
    } catch (e) {
      return []
    }
  }
  const exts = t === 'mod' ? ['.jar'] : ['.zip']
  try {
    return fs.readdirSync(dir)
      .filter((f) => exts.some((x) => f.toLowerCase().endsWith(x)))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        return { file: f, size: st.size, modified: st.mtime }
      })
      .sort((a, b) => a.file.localeCompare(b.file))
  } catch (e) {
    return []
  }
}

function remove(instanceId, type, fileName) {
  const t = type || 'mod'
  const dest = path.join(contentDir(instanceId, t), path.basename(fileName))
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
  if (t === 'mod') metaRemove(instanceId, path.basename(fileName))
}

function openFolder(instanceId, type) {
  const dir = contentDir(instanceId, type || 'mod')
  require('child_process').exec(process.platform === 'win32' ? `explorer "${dir}"` : `open "${dir}"`)
  return dir
}

function openModsFolder(instanceId) {
  return openFolder(instanceId, 'mod')
}

module.exports = { search, versions, install, listInstalled, remove, openModsFolder, openFolder, contentDir }
