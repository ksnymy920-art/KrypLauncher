const fs = require('fs')
const path = require('path')
const cfg = require('./config')
const { getJSON, download, pool } = require('./download')

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
  const classId = type === 'world' ? 17 : type === 'shader' || type === 'resourcepack' ? 12 : type === 'modpack' ? 4471 : 6
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
    if (type === 'modpack') return res
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

function contentDirRead(instanceId, type) {
  const t = type || 'mod'
  const sub = t === 'shader' ? 'shaderpacks' : t === 'resourcepack' ? 'resourcepacks' : t === 'world' ? 'saves' : 'mods'
  return path.join(cfg.paths().game, instanceId, sub)
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
    metaAdd(opts.instanceId, [{
      file: path.basename(target),
      projectId: opts.id,
      slug: opts.slug || '',
      title: opts.title || v.name || '',
      source: opts.source || 'modrinth',
      versionNumber: v.version_number || '',
      dependency: false,
      icon: opts.icon || ''
    }])
    return { file: path.basename(target), name: v.name, version_number: v.version_number || '', size: v.size || 0, dependencies: 0 }
  }

  const dest = path.join(contentDir(opts.instanceId, type), safeContentName(v.filename, type))
  await download(v.url, dest, { onProgress: opts.onProgress })

  if (type !== 'mod') {
    metaAdd(opts.instanceId, [{
      file: path.basename(dest),
      projectId: opts.id,
      slug: opts.slug || '',
      title: opts.title || v.name || '',
      source: opts.source || 'modrinth',
      versionNumber: v.version_number || '',
      icon: opts.icon || ''
    }])
    return { file: path.basename(dest), name: v.name, version_number: v.version_number || '', size: v.size || 0, dependencies: 0 }
  }

  const installed = [{
    file: path.basename(dest),
    projectId: opts.id,
    slug: opts.slug || '',
    title: opts.title || v.name || '',
    source: opts.source || 'modrinth',
    versionNumber: v.version_number || '',
    dependency: false,
    icon: opts.icon || ''
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
  if (t === 'modpack') return []
  const dir = contentDirRead(instanceId, t)
  if (!fs.existsSync(dir)) return []
  if (t === 'world') {
    const meta = loadMeta(instanceId)
    const byFile = new Map(meta.map((m) => [m.file.toLowerCase(), m]))
    try {
      return fs.readdirSync(dir)
        .filter((f) => fs.statSync(path.join(dir, f)).isDirectory())
        .map((f) => {
          const st = fs.statSync(path.join(dir, f))
          const m = byFile.get(f.toLowerCase())
          return {
            file: f,
            size: st.size,
            modified: st.mtime,
            isDir: true,
            icon: (m && m.icon) || '',
            title: (m && m.title) || ''
          }
        })
        .sort((a, b) => a.file.localeCompare(b.file))
    } catch (e) {
      return []
    }
  }
  const exts = t === 'mod' ? ['.jar'] : ['.zip']
  const meta = loadMeta(instanceId)
  const byFile = new Map(meta.map((m) => [m.file.toLowerCase(), m]))
  try {
    return fs.readdirSync(dir)
      .filter((f) => exts.some((x) => f.toLowerCase().endsWith(x)))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        const m = byFile.get(f.toLowerCase())
        return {
          file: f,
          size: st.size,
          modified: st.mtime,
          icon: (m && m.icon) || '',
          title: (m && m.title) || ''
        }
      })
      .sort((a, b) => a.file.localeCompare(b.file))
  } catch (e) {
    return []
  }
}

function makeWritableRecursive(p) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch (e) {
    return
  }
  if (st.isDirectory()) {
    let items = []
    try {
      items = fs.readdirSync(p)
    } catch (e) {}
    for (const it of items) makeWritableRecursive(path.join(p, it))
  }
  try {
    fs.chmodSync(p, 0o666)
  } catch (e) {}
}

function rmForce(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 })
    return
  } catch (e) {}
  makeWritableRecursive(target)
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 })
}

function remove(instanceId, type, fileName) {
  const t = type || 'mod'
  const dest = path.join(contentDir(instanceId, t), path.basename(fileName))
  if (fs.existsSync(dest)) rmForce(dest)
  metaRemove(instanceId, path.basename(fileName))
}

function openFolder(instanceId, type) {
  const dir = contentDir(instanceId, type || 'mod')
  require('child_process').exec(process.platform === 'win32' ? `explorer "${dir}"` : `open "${dir}"`)
  return dir
}

function openModsFolder(instanceId) {
  return openFolder(instanceId, 'mod')
}

function modrinthProjectIdFromUrl(url) {
  const m = /\/(?:data|project)\/([A-Za-z0-9_-]+)(?:\/versions)?\//.exec(String(url || ''))
  return m ? m[1] : null
}

function contentKeyOfPath(p) {
  const norm = String(p || '').replace(/\\/g, '/')
  const lower = norm.toLowerCase()
  if (lower.startsWith('mods/') || lower.startsWith('shaderpacks/') || lower.startsWith('resourcepacks/')) return path.basename(norm)
  if (lower.startsWith('saves/')) return norm.split('/')[1] || ''
  return ''
}

function packContentType(p) {
  const lower = String(p || '').replace(/\\/g, '/').toLowerCase()
  if (lower.startsWith('shaderpacks/')) return 'shader'
  if (lower.startsWith('resourcepacks/')) return 'resourcepack'
  if (lower.startsWith('saves/')) return 'world'
  return 'mod'
}

function localIconPath(instanceId, file) {
  const safe = String(instanceId + '-' + file).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(cfg.paths().data, 'icons', safe + '.png')
}

function extractLocalIcon(instanceId, type, file) {
  const dir = contentDirRead(instanceId, type)
  const full = path.join(dir, file)
  if (!fs.existsSync(full)) return ''
  try {
    let buf = null
    if (type === 'world') {
      const icon = path.join(full, 'icon.png')
      if (fs.existsSync(icon)) buf = fs.readFileSync(icon)
    } else {
      const AdmZip = require('adm-zip')
      const zip = new AdmZip(full)
      const entries = zip.getEntries().filter((e) => !e.isDirectory)
      const pref = type === 'shader' ? ['preview', 'screenshot'] : ['pack']
      let pick = null
      for (const p of pref) {
        pick = entries.find((e) => e.entryName.toLowerCase().includes(p) && /\.(png|jpe?g)$/i.test(e.entryName))
        if (pick) break
      }
      if (!pick) pick = entries.find((e) => /\.png$/i.test(e.entryName))
      if (pick) buf = pick.getData()
    }
    if (!buf) return ''
    const out = localIconPath(instanceId, file)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, buf)
    return '/api/icon?instance=' + encodeURIComponent(instanceId) + '&file=' + encodeURIComponent(file)
  } catch (e) {
    return ''
  }
}

async function enrichPackIcons(instanceId, modFiles) {
  if (!instanceId || !Array.isArray(modFiles) || !modFiles.length) return
  const meta = loadMeta(instanceId)
  let changed = false
  for (const f of modFiles) {
    const key = contentKeyOfPath(f.path)
    if (!key) continue
    let m = meta.find((x) => String(x.file).toLowerCase() === key.toLowerCase())
    if (!m) {
      m = { file: key, projectId: String(f.projectId || ''), slug: '', title: key, source: f.projectId ? 'curseforge' : '', versionNumber: '', dependency: false, icon: '' }
      meta.push(m)
      changed = true
    }
    if (!m.icon) {
      const icon = extractLocalIcon(instanceId, packContentType(f.path), m.file)
      if (icon) {
        m.icon = icon
        changed = true
      }
    }
    if (!m.title) {
      m.title = key
      changed = true
    }
  }
  if (changed) saveMeta(instanceId, meta)
}

async function modrinthProjectMeta(id) {
  try {
    const j = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}`)
    return { title: j.title || '', slug: j.slug || '', icon: j.icon_url || '' }
  } catch (e) {
    return null
  }
}

async function curseProjectMeta(id) {
  try {
    const j = await curseRequest('mods/' + encodeURIComponent(id), [])
    const d = (j && j.data) || {}
    return { title: d.name || '', slug: d.slug || '', icon: (d.logo && d.logo.url) || '' }
  } catch (e) {
    return null
  }
}

async function enrichPackMods(instanceId, modFiles) {
  if (!instanceId || !Array.isArray(modFiles) || !modFiles.length) return
  const seen = new Map()
  await pool(modFiles, 6, async (f) => {
    const key = contentKeyOfPath(f.path)
    if (!key || seen.has(key.toLowerCase())) return
    let meta = null
    let source = 'curseforge'
    let projectId = ''
    if (f.projectId) {
      projectId = String(f.projectId)
      meta = await curseProjectMeta(f.projectId)
    }
    if (!meta) {
      let pid = null
      if (Array.isArray(f.urls)) {
        for (const u of f.urls) {
          pid = modrinthProjectIdFromUrl(u)
          if (pid) break
        }
      }
      if (pid) {
        meta = await modrinthProjectMeta(pid)
        projectId = pid
        source = 'modrinth'
      }
    }
    if (meta && (meta.title || meta.icon)) {
      seen.set(key, {
        file: key,
        projectId,
        slug: meta.slug || '',
        title: meta.title || key,
        source,
        versionNumber: '',
        dependency: false,
        icon: meta.icon || ''
      })
    }
  })
  if (seen.size) metaAdd(instanceId, [...seen.values()])
}

module.exports = { search, versions, install, listInstalled, remove, rmForce, openModsFolder, openFolder, contentDir, enrichPackMods, enrichPackIcons, packContentType }
