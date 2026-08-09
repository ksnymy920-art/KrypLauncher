const fs = require('fs')
const path = require('path')
const https = require('https')
const { request, getJSON, download } = require('./download')
const AdmZip = require('adm-zip')
const cfg = require('./config')

const SKINDEX = 'https://www.minecraftskins.com'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

function createUrl(value) {
  return String(value || '')
    .replace(/[^a-z0-9_]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

let lastRequestAt = 0

function throttled() {
  const minGap = 400
  const wait = Math.max(0, lastRequestAt + minGap - Date.now())
  if (wait > 0) return new Promise((r) => setTimeout(r, wait))
  return Promise.resolve()
}

function getResponse(url, headers) {
  return new Promise((resolve, reject) => {
    const run = (target, redirects) => {
      const req = https.get(target, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          if (redirects >= 5) return reject(new Error('HTTP too many redirects'))
          return run(new URL(res.headers.location, target).toString(), redirects + 1)
        }
        resolve(res)
      })
      req.on('error', reject)
    }
    run(url, 0)
  })
}

function browserHeaders(referer) {
  return {
    'user-agent': BROWSER_UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'upgrade-insecure-requests': '1',
    ...(referer ? { referer } : {})
  }
}

async function fetchText(url) {
  await throttled()
  const headers = browserHeaders(SKINDEX + '/')
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt + Math.random() * 500))
    try {
      const res = await getResponse(url, headers)
      if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode >= 500) {
        res.resume()
        lastErr = new Error(`HTTP ${res.statusCode} (قد يكون الموقع حظّر الطلبات السريعة)`)
        continue
      }
      if (res.statusCode >= 400) {
        res.resume()
        throw new Error(`HTTP ${res.statusCode}`)
      }
      let body = ''
      res.on('data', (c) => (body += c))
      await new Promise((resolve) => res.on('end', resolve))
      return body
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('HTTP failed')
}

async function fetchBuffer(url) {
  await throttled()
  const headers = browserHeaders(SKINDEX + '/')
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt + Math.random() * 500))
    try {
      const res = await getResponse(url, headers)
      if (res.statusCode === 403 || res.statusCode === 429 || res.statusCode >= 500) {
        res.resume()
        lastErr = new Error(`HTTP ${res.statusCode} (قد يكون الموقع حظّر الطلبات السريعة)`)
        continue
      }
      if (res.statusCode >= 400) {
        res.resume()
        throw new Error(`HTTP ${res.statusCode}`)
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      await new Promise((resolve) => res.on('end', resolve))
      return Buffer.concat(chunks)
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('HTTP failed')
}

function parseCards(html) {
  const items = []
  const blocks = html.split('<div class="skin" data-role="skin-wrapper"').slice(1)
  for (const block of blocks) {
    const chunk = block.split('<div class="skin" data-role="skin-wrapper"')[0]
    const idm = chunk.match(/data-id="(\d+)"/)
    if (!idm) continue
    const id = idm[1]
    const preset = chunk.match(/data-preset="([34])"/)
    const title = chunk.match(/<span class="title\d+">([^<]+)<\/span>/)
    const author = chunk.match(/author-name">([^<]+)</)
    const img = chunk.match(/<img src="([^"]*preview-skins[^"]*)"/)
    if (!img) continue
    const preview = img[1].startsWith('http') ? img[1] : SKINDEX + img[1]
    const skinUrl = preview.replace('/preview-skins/', '/skins/').replace(/[?&]v\d+$/, '')
    items.push({
      id,
      name: title ? title[1].trim() : 'بدون اسم',
      author: author ? author[1].trim() : '',
      variant: preset && preset[1] === '3' ? 'slim' : 'classic',
      preview,
      skinUrl
    })
  }
  return items
}

const listCache = new Map()

async function list({ query = '', page = 1 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const slug = createUrl(query)
  const key = `${slug || '_'}|${p}`
  if (listCache.has(key)) return listCache.get(key)
  const url = slug ? `${SKINDEX}/search/skin/${slug}/${p}/` : `${SKINDEX}/latest/${p}/`
  const html = await fetchText(url)
  const items = parseCards(html)
  const nextRe = slug ? new RegExp(`href="/search/skin/${slug.replace(/-/g, '\\-')}/${p + 1}/"`) : new RegExp(`href="/latest/${p + 1}/"`)
  const result = { items, page: p, hasMore: nextRe.test(html) }
  listCache.set(key, result)
  const t = setTimeout(() => listCache.delete(key), 5 * 60 * 1000)
  if (t.unref) t.unref()
  return result
}

function multipart(fields, fileBuffer, filename) {
  const boundary = '----OmniLauncher' + Date.now() + Math.random().toString(16).slice(2)
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`))
  parts.push(fileBuffer)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return { boundary, body: Buffer.concat(parts) }
}

async function uploadToMojang(account, variant, pngBuffer) {
  const { boundary, body } = multipart({ variant }, pngBuffer, 'skin.png')
  const res = await request('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${account.accessToken}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': body.length
    },
    body
  })
  let text = ''
  for await (const c of res) text += c
  if (res.statusCode >= 400) {
    let msg = text
    try { msg = JSON.parse(text).errorMessage || JSON.parse(text).error || text } catch (e) {}
    const err = new Error(String(msg))
    err.status = res.statusCode
    throw err
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    return {}
  }
}

function skinPngPath(accountId) {
  return path.join(cfg.paths().data, 'skins', `${accountId}.png`)
}

function favoritesFile() {
  return path.join(cfg.paths().data, 'favorites.json')
}

function loadFavorites() {
  try {
    return JSON.parse(fs.readFileSync(favoritesFile(), 'utf8')) || []
  } catch (e) {
    return []
  }
}

function saveFavorites(arr) {
  try {
    fs.mkdirSync(path.dirname(favoritesFile()), { recursive: true })
    fs.writeFileSync(favoritesFile(), JSON.stringify(arr, null, 2))
  } catch (e) {}
}

function toggleFavorite(skin) {
  const arr = loadFavorites()
  const i = arr.findIndex((f) => String(f.id) === String(skin.id))
  if (i >= 0) {
    arr.splice(i, 1)
  } else {
    arr.push({
      id: skin.id,
      name: skin.name,
      author: skin.author,
      variant: skin.variant,
      preview: skin.preview,
      skinUrl: skin.skinUrl
    })
  }
  saveFavorites(arr)
  return arr
}

const FORMATS = [
  { v: [1, 6, 1], fmt: 1 },
  { v: [1, 9, 0], fmt: 2 },
  { v: [1, 11, 0], fmt: 3 },
  { v: [1, 13, 0], fmt: 4 },
  { v: [1, 15, 0], fmt: 5 },
  { v: [1, 16, 2], fmt: 6 },
  { v: [1, 17, 0], fmt: 7 },
  { v: [1, 18, 0], fmt: 8 },
  { v: [1, 19, 0], fmt: 9 },
  { v: [1, 19, 3], fmt: 12 },
  { v: [1, 19, 4], fmt: 13 },
  { v: [1, 20, 0], fmt: 15 },
  { v: [1, 20, 2], fmt: 18 },
  { v: [1, 20, 3], fmt: 22 },
  { v: [1, 20, 5], fmt: 32 },
  { v: [1, 21, 0], fmt: 34 },
  { v: [1, 21, 2], fmt: 42 },
  { v: [1, 21, 4], fmt: 46 },
  { v: [1, 21, 5], fmt: 55 },
  { v: [1, 21, 6], fmt: 63 },
  { v: [1, 21, 7], fmt: 64 },
  { v: [1, 21, 9], fmt: 69 },
  { v: [1, 21, 11], fmt: 75 },
  { v: [26, 1, 0], fmt: 84 },
  { v: [26, 2, 0], fmt: 88 },
  { v: [26, 3, 0], fmt: 94 }
]

function versionTuple(versionId) {
  const m = String(versionId || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])]
}

function packFormatFor(versionId) {
  const t = versionTuple(versionId)
  if (!t) return null
  let fmt = null
  for (const row of FORMATS) {
    const r = row.v
    if (t[0] > r[0] || (t[0] === r[0] && (t[1] > r[1] || (t[1] === r[1] && t[2] >= r[2])))) fmt = row.fmt
  }
  return fmt
}

function packMetaFor(versionId) {
  const fmt = packFormatFor(versionId)
  if (fmt === null || fmt < 65) {
    return JSON.stringify({ pack: { pack_format: fmt === null ? 15 : fmt, description: 'OmniLauncher Skin' } })
  }
  return JSON.stringify({ pack: { min_format: fmt, max_format: 999, description: 'OmniLauncher Skin' } })
}

function installOfflineSkin(gameDir, pngBuffer, versionId) {
  const rpDir = path.join(gameDir, 'resourcepacks')
  fs.mkdirSync(rpDir, { recursive: true })
  const zip = new AdmZip()
  zip.addFile('pack.mcmeta', Buffer.from(packMetaFor(versionId)))
  const defaults = ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri']
  const targets = []
  for (const n of defaults) {
    targets.push(`assets/minecraft/textures/entity/player/wide/${n}.png`)
    targets.push(`assets/minecraft/textures/entity/player/slim/${n}.png`)
  }
  targets.push('assets/minecraft/textures/entity/player/steve.png')
  targets.push('assets/minecraft/textures/entity/player/alex.png')
  for (const t of targets) zip.addFile(t, pngBuffer)
  const zipFile = path.join(rpDir, 'OmniLauncherSkin.zip')
  zip.writeZip(zipFile)

  const optFile = path.join(gameDir, 'options.txt')
  const lines = {}
  if (fs.existsSync(optFile)) {
    for (const line of fs.readFileSync(optFile, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0) lines[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  const packName = 'file/OmniLauncherSkin.zip'
  for (const key of ['resourcePacks', 'incompatibleResourcePacks']) {
    let arr = []
    try { arr = JSON.parse(lines[key] || '[]') } catch (e) {}
    if (!arr.includes(packName)) arr = [packName, ...arr]
    lines[key] = JSON.stringify(arr)
  }
  fs.writeFileSync(optFile, Object.entries(lines).map(([k, v]) => `${k}:${v}`).join('\n') + '\n')
  return zipFile
}

function customSkinLoaderSkinFile(gameDir, username) {
  return path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins', `${username}.png`)
}

function removeOfflineSkinPack(gameDir) {
  const zipFile = path.join(gameDir, 'resourcepacks', 'OmniLauncherSkin.zip')
  try { fs.unlinkSync(zipFile) } catch (e) {}
  const optFile = path.join(gameDir, 'options.txt')
  if (!fs.existsSync(optFile)) return
  const lines = {}
  for (const line of fs.readFileSync(optFile, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) lines[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  let changed = false
  for (const key of ['resourcePacks', 'incompatibleResourcePacks']) {
    let arr = []
    try { arr = JSON.parse(lines[key] || '[]') } catch (e) {}
    const next = arr.filter((x) => x !== 'file/OmniLauncherSkin.zip')
    if (next.length !== arr.length) {
      lines[key] = JSON.stringify(next)
      changed = true
    }
  }
  if (changed) fs.writeFileSync(optFile, Object.entries(lines).map(([k, v]) => `${k}:${v}`).join('\n') + '\n')
}

async function ensureCustomSkinLoader(gameDir, versionId) {
  const modsDir = path.join(gameDir, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const existing = fs.readdirSync(modsDir).find((f) => f.toLowerCase().startsWith('customskinloader') && f.toLowerCase().endsWith('.jar'))
  if (existing) return path.join(modsDir, existing)
  const list = await getJSON('https://api.modrinth.com/v2/project/idMHQ4n2/version')
  const pick = list.find((v) => v.version_type === 'release' && v.game_versions.includes(String(versionId)) && v.loaders.includes('fabric'))
  if (!pick || !pick.files || !pick.files[0]) throw new Error(`لا يوجد إصدار CustomSkinLoader لـ ${versionId}`)
  const dest = path.join(modsDir, `CustomSkinLoader-${pick.version_number}.jar`)
  await download(pick.files[0].url, dest)
  return dest
}

function installOfflineSkinLocal(gameDir, pngBuffer, username) {
  const file = customSkinLoaderSkinFile(gameDir, username)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, pngBuffer)
  const cache = path.join(gameDir, 'CustomSkinLoader', 'caches')
  try { fs.rmSync(cache, { recursive: true, force: true }) } catch (e) {}
  return file
}

function removeAutoCustomSkinLoader(gameDir) {
  const modsDir = path.join(gameDir, 'mods')
  try {
    for (const f of fs.readdirSync(modsDir)) {
      const low = String(f).toLowerCase()
      if (low.startsWith('customskinloader') && low.endsWith('.jar')) {
        try { fs.unlinkSync(path.join(modsDir, f)) } catch (e) {}
      }
    }
  } catch (e) {}
  try { fs.rmSync(path.join(gameDir, 'CustomSkinLoader'), { recursive: true, force: true }) } catch (e) {}
}

const ELY_ROOT = 'https://authserver.ely.by/api/authlib-injector'
const ELY_API = 'https://authserver.ely.by'
const ELY_SITE = 'https://ely.by'
const ELY_OAUTH_CLIENT = 'ely'
const ELY_REDIRECT = 'https://ely.by/authorization/oauth'

function parseSetCookie(raw) {
  const parts = String(raw).split(';')
  const m = parts[0].match(/^\s*([^=]+)=([\s\S]*)$/)
  if (!m) return null
  const cookie = { name: m[1].trim(), value: m[2].trim(), domain: '', expires: null }
  for (const p of parts.slice(1)) {
    const t = p.trim()
    const [k, ...rest] = t.split('=')
    const lk = k.toLowerCase()
    if (lk === 'domain') cookie.domain = rest.join('=').trim().replace(/^\./, '')
    if (lk === 'expires') cookie.expires = Date.parse(rest.join('=').trim())
  }
  return cookie
}

function makeCookieJar() {
  const cookies = new Map()
  return {
    setFrom(res, url) {
      const host = new URL(url).hostname
      let list = []
      try { list = res.headers.getSetCookie ? res.headers.getSetCookie() : [] } catch (e) { list = [] }
      if (!list.length && res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')]
      for (const raw of list) {
        const c = parseSetCookie(raw)
        if (!c) continue
        if (!c.domain) c.domain = host
        cookies.set(c.name, c)
      }
    },
    headerFor(url) {
      const host = new URL(url).hostname
      const parts = []
      for (const c of cookies.values()) {
        if (c.expires && c.expires < Date.now()) continue
        if (host === c.domain || host.endsWith('.' + c.domain)) parts.push(`${c.name}=${c.value}`)
      }
      return parts.join('; ')
    }
  }
}

async function elybyRequest(url, { method = 'GET', headers = {}, body, retries = 2 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': BROWSER_UA, 'accept': 'application/json', ...headers },
        body,
        redirect: 'manual'
      })
      if (res.status === 401 || res.status === 429 || res.status >= 500) {
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      return res
    } catch (e) {
      lastErr = e
      if (e.status === 401 || e.status === 429 || (e.status || 0) >= 500) {
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

async function elybyUpload({ email, password, pngBuffer }) {
  const jar = makeCookieJar()
  const follow = async (url) => {
    let cur = url
    for (let i = 0; i < 7; i++) {
      const res = await elybyRequest(cur, { headers: { cookie: jar.headerFor(cur) } })
      jar.setFrom(res, cur)
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return res
        cur = new URL(loc, cur).toString()
        continue
      }
      return res
    }
    throw new Error('كثرة التحويلات أثناء تسجيل دخول Ely.by')
  }

  const r0 = await elybyRequest(`${ELY_SITE}/authorization/login`, { headers: { cookie: '' } })
  jar.setFrom(r0, `${ELY_SITE}/authorization/login`)
  const state = (r0.headers.get('location') || '').match(/state=([a-f0-9]+)/)
  if (!state) throw new Error('تعذر بدء جلسة Ely.by')
  const stateVal = state[1]

  const loginRes = await elybyRequest(`${ELY_API}/api/authentication/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: String(email).trim(), password: String(password), rememberMe: false })
  })
  const loginData = await loginRes.json().catch(() => ({}))
  if (!loginData.access_token) {
    const errors = loginData.errors || {}
    const keys = Object.keys(errors)
    if (keys.length) throw new Error(`بيانات Ely.by غير صحيحة: ${keys.map((k) => errors[k]).join('، ')}`)
    throw new Error('فشل تسجيل دخول Ely.by')
  }

  const q = new URLSearchParams({
    client_id: ELY_OAUTH_CLIENT,
    response_type: 'code',
    redirect_uri: ELY_REDIRECT,
    scope: 'account_info account_email',
    state: stateVal
  })
  const completeRes = await elybyRequest(`${ELY_API}/api/oauth2/v1/complete?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${loginData.access_token}` },
    body: 'accept=1'
  })
  const complete = await completeRes.json().catch(() => ({}))
  if (!complete.redirectUri) throw new Error('تعذر استكمال تسجيل دخول Ely.by')

  await follow(complete.redirectUri)

  let user = null
  let addHtml = ''
  for (let i = 0; i < 3; i++) {
    const page = await follow(`${ELY_SITE}/skins/add`)
    addHtml = await page.text().catch(() => '')
    const cu = addHtml.match(/currentUser\s*[:=]\s*(\{.*?\})\s*[,;]/)
    try { user = cu ? JSON.parse(cu[1]) : null } catch (e) { user = null }
    if (user && user.status !== 'guest') break
    await new Promise((r) => setTimeout(r, 800))
  }
  if (!user || user.status === 'guest') throw new Error('تعذر تأكيد جلسة Ely.by — أعد المحاولة')

  if (user.group === 0 || addHtml.includes('activation-page')) {
    const actRes = await elybyRequest(`${ELY_SITE}/user/activateAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.headerFor(`${ELY_SITE}/user/activateAccount`) },
      body: 'acceptTerms=1&lang=en'
    })
    jar.setFrom(actRes, `${ELY_SITE}/user/activateAccount`)
  }

  const boundary = '----OmniLauncher' + Date.now() + Math.random().toString(16).slice(2)
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`),
    pngBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  const upRes = await elybyRequest(`${ELY_SITE}/skins/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: jar.headerFor(`${ELY_SITE}/skins/upload`) },
    body
  })
  const up = await upRes.json().catch(() => ({}))
  if (!up.url) throw new Error(up.text || 'فشل رفع السكن على Ely.by')

  const skinId = String(up.url).match(/\/s(\d+)\//)
  if (skinId) {
    const wearRes = await elybyRequest(`${ELY_SITE}/skins/wear`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.headerFor(`${ELY_SITE}/skins/wear`) },
      body: `skinId=${skinId[1]}`
    })
    await wearRes.text().catch(() => '')
  }

  return {
    name: user.nickname || '',
    id: user.id || 0,
    texturesUrl: `https://skinsystem.ely.by/textures/${user.nickname || ''}`
  }
}

async function readBody(res) {
  let text = ''
  for await (const c of res) text += c
  return text
}

function elybyError(res, text) {
  let msg = text
  try { msg = JSON.parse(text).errorMessage || JSON.parse(text).error || text } catch (e) {}
  const err = new Error(String(msg))
  err.status = res.statusCode
  return err
}

async function elybyAuthenticate(email, password) {
  const body = JSON.stringify({
    username: String(email).trim(),
    password: String(password),
    clientToken: require('crypto').randomUUID(),
    requestUser: true,
    agent: { name: 'Minecraft', version: 1 }
  })
  const res = await request(`${ELY_ROOT}/authserver/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body: Buffer.from(body)
  })
  const text = await readBody(res)
  let data = null
  try { data = JSON.parse(text) } catch (e) {}
  if (res.statusCode >= 400 || !data || !data.accessToken) throw elybyError(res, text)
  return data
}

module.exports = {
  list,
  uploadToMojang,
  fetchBuffer,
  skinPngPath,
  loadFavorites,
  saveFavorites,
  toggleFavorite,
  installOfflineSkin,
  installOfflineSkinLocal,
  ensureCustomSkinLoader,
  removeOfflineSkinPack,
  removeAutoCustomSkinLoader,
  createUrl,
  packFormatFor,
  elybyAuthenticate,
  elybyUpload
}
