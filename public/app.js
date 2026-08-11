const state = {
  versions: [],
  latest: {},
  instances: {},
  accounts: [],
  config: {},
  java: { installed: [], available: { lts: [], all: [] } },
  jobs: {},
  game: { running: false, games: [], instanceId: null },
  logOffset: 0,
  loader: '',
  fabricLoaders: [],
  forgeVersions: { recommended: null, latest: null },
  activeJobId: null,
  installVersionId: '',
  installLoader: '',
  mods: { results: [], installed: [], source: 'all', searching: false, page: 1, type: 'mod', showInstalled: false, showPack: false, showManual: true },
  skins: { items: [], page: 1, query: '', loading: false, favorites: [], favOnly: false },
  data: { instance: '', screenshots: [], backups: [] },
  servers: { instance: '', items: [], loaded: false },
  controls: { auto: false, target: '', active: '', profiles: [], running: [] }
}

const $ = (id) => document.getElementById(id)

let playUI = { running: false, busy: false, anyRunning: false }

function loaderName(l) {
  return l === 'fabric' ? t('loader.fabric') : l === 'forge' ? t('loader.forge') : l === 'neoforge' ? t('loader.neoforge') : l === 'quilt' ? t('loader.quilt') : l ? l : t('loader.vanilla')
}

function statusLabel(st) {
  if (!st) return ''
  const known = ['installed', 'installing', 'preparing', 'running', 'stopped', 'crashed']
  return known.includes(st) ? t('inst.st.' + st) : st
}

function toast(msg, type = '', duration = 3000) {
  const el = $('toast')
  el.textContent = msg
  el.className = 'toast show ' + type
  clearTimeout(el._t)
  el._t = setTimeout(() => (el.className = 'toast'), duration)
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...opts
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ? tServer(data.error) : t('err.connection'))
  return data
}

function switchTab(name) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name))
  if (name === 'mods') modsTabOpen()
  if (name === 'skins') skinsTabOpen()
  if (name === 'data') dataTabOpen()
  if (name === 'servers') serversTabOpen()
}

function setPlayButton(running, busy, anyRunning) {
  playUI = { running, busy, anyRunning }
  const btn = $('playBtn')
  if (running) {
    btn.disabled = true
    $('playBtnText').textContent = t('home.running')
    $('stopBtn').hidden = false
  } else if (busy) {
    btn.disabled = true
    $('playBtnText').textContent = t('home.busy')
    $('stopBtn').hidden = !anyRunning
  } else {
    btn.disabled = false
    $('playBtnText').textContent = t('home.play')
    $('stopBtn').hidden = !anyRunning
  }
}

function fmtBytes(received, total) {
  if (!total) return ''
  const pct = Math.round((received / total) * 100)
  return pct + '%'
}

function renderAll() {
  if (!state.instances || !state.accounts || !state.config) return
  populateLangSelect()
  renderInstanceSelect()
  renderAccounts()
  renderVersionsTab()
  renderSettings()
  renderInstancesManage()
  populateSkinAccountSelect()
  renderModsTypeUI()
  renderModsInstalled()
  populateDataInstanceSelect()
}

function populateLangSelect() {
  const sel = $('langSetting')
  if (!sel) return
  const cur = getLang()
  if (sel.dataset.built === cur) return
  sel.innerHTML = ''
  for (const code of LANG_LIST) {
    const opt = new Option(LANGS[code].name, code)
    opt.selected = code === cur
    sel.appendChild(opt)
  }
  sel.dataset.built = cur
}

async function loadInitial() {
  try {
    const [manifest, instances, accountsRes, config, options] = await Promise.all([
      api('/api/manifest'),
      api('/api/instances'),
      api('/api/accounts'),
      api('/api/config'),
      api('/api/options')
    ])
    state.versions = manifest.versions
    state.latest = manifest.latest || {}
    state.instances = instances
    state.accounts = accountsRes.accounts
    state.config = config
    state.controls = options
    applyLang(config.lang || 'en')
  } catch (e) {
    toast(e.message, 'error')
  }
}

function renderInstancesManage() {
  const list = $('instanceManageList')
  list.innerHTML = ''
  const keys = Object.keys(state.instances || {})
  if (!keys.length) {
    list.innerHTML = '<div class="vrow muted">' + t('inst.none') + '</div>'
    return
  }
  for (const key of keys) {
    const inst = state.instances[key]
    const div = document.createElement('div')
    div.className = 'vrow'
    div.innerHTML = `
      <div class="v-info">
        <div class="v-name">${escapeHtml(key)}${packTagHtml(inst)}</div>
        <div class="v-sub">${loaderName(inst.loader)} ${inst.loaderVersion || ''} · ${t('inst.status', { status: statusLabel(inst.status) })}</div>
      </div>
      <div class="row">
        <button class="btn" data-reinstall="${key}" ${inst.status === 'installing' || inst.status === 'preparing' ? 'disabled' : ''}><i class="fa-solid fa-rotate"></i> ${t('inst.reinstall')}</button>
        <button class="icon-btn danger" data-del="${key}" title="${t('inst.deleteTitle')}"><i class="fa-solid fa-trash"></i></button>
      </div>`
    div.querySelector('[data-reinstall]').addEventListener('click', async (e) => {
      const b = e.currentTarget
      b.disabled = true
      b.textContent = t('common.loading')
      try {
        const inst = state.instances[key]
        const res = await api('/api/instances/reinstall', { method: 'POST', body: JSON.stringify({ key }) })
        state.activeJobId = res.jobId
        toast(t('inst.reinstalling', { key }))
      } catch (err) {
        b.disabled = false
        b.innerHTML = '<i class="fa-solid fa-rotate"></i> ' + t('inst.reinstall')
        toast(err.message, 'error')
      }
    })
    div.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(t('inst.deleteConfirm', { key }))) return
      try {
        await api('/api/instances/delete', { method: 'POST', body: JSON.stringify({ key }) })
        toast(t('inst.deleted', { key }), 'success')
        await refreshInstances()
      } catch (err) {
        toast(err.message, 'error')
      }
    })
    list.appendChild(div)
  }
}

function isInstalled(versionId, loader) {
  const key = loader ? `${versionId}-${loader}` : versionId
  return !!state.instances[key]
}

function isInstalledAny(versionId) {
  return isInstalled(versionId, '') || isInstalled(versionId, 'fabric') || isInstalled(versionId, 'forge') || isInstalled(versionId, 'neoforge') || isInstalled(versionId, 'quilt')
}

function renderInstanceSelect() {
  const sel = $('instanceSelect')
  sel.innerHTML = ''
  const keys = Object.keys(state.instances || {}).filter((k) => {
    const st = state.instances[k]
    return st && st.status !== 'installing' && st.status !== 'preparing'
  })
  const sortSemver = (a, b) => {
    const na = String(a).split('-')[0].split('.').map(Number)
    const nb = String(b).split('-')[0].split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const da = na[i] || 0
      const db = nb[i] || 0
      if (da !== db) return db - da
    }
    return String(b).localeCompare(String(a))
  }
  keys.sort(sortSemver)
  const cur = sel.value
  if (!keys.length) {
    sel.appendChild(new Option(t('home.noInstSelect'), ''))
  } else {
    for (const k of keys) {
      const inst = state.instances[k]
      const pks = packsOf(inst)
      const packTag = pks.length ? ` · ${pks.length > 1 ? pks[0].name + ' +' + (pks.length - 1) : pks[0].name}` : ''
      sel.appendChild(new Option(`${k} — ${loaderName(inst.loader)}${packTag}`, k))
    }
    if (cur && keys.includes(cur)) sel.value = cur
    else sel.value = keys[0]
  }
  onInstanceChange()
}

function onInstanceChange() {
  const key = selectedInstanceKey()
  const inst = state.instances[key]
  if (!inst) {
    $('instanceDetail').textContent = ''
    $('heroSub').textContent = t('home.noInstHero')
    return
  }
  state.loader = inst.loader || ''
  updateHeroSub(key)
  const pks = packsOf(inst)
  const packTxt = pks.length ? ' · ' + (pks.length > 1 ? pks[0].name + ' +' + (pks.length - 1) : pks[0].name) : ''
  $('instanceDetail').textContent = `${loaderName(inst.loader)} ${inst.loaderVersion || ''}${packTxt}${inst.status && inst.status !== 'installed' ? ' · ' + statusLabel(inst.status) : ''}`
}

function updateHeroSub(key) {
  const inst = state.instances[key]
  const sub = $('heroSub')
  if (!inst) {
    sub.textContent = t('home.noInstHero')
    return
  }
  sub.textContent = t('home.readySub', { version: inst.versionId, loader: inst.loader ? ' (' + loaderName(inst.loader) + ')' : '' })
}

async function loadFabricLoaders(mc) {
  const sel = $('installLoaderVersionSelect')
  $('installLoaderVersionLabel').innerHTML = '<i class="fa-solid fa-bolt"></i> ' + t('install.fabricVersion')
  try {
    const loaders = await api('/api/fabric/loaders/' + encodeURIComponent(mc))
    state.fabricLoaders = loaders
    if (!loaders.length) throw new Error(t('install.fabricNotCompat'))
    sel.innerHTML = ''
    for (const l of loaders.slice(0, 12)) {
      sel.appendChild(new Option((l.stable ? '⭐ ' : '') + l.version, l.version))
    }
    $('installLoaderVersionField').hidden = false
  } catch (e) {
    state.fabricLoaders = []
    $('installLoaderVersionField').hidden = true
    if (![t('install.fabricNotCompat'), t('install.forgeNotCompat'), t('install.neoforgeNotCompat'), t('install.quiltNotCompat')].includes(e.message)) toast(e.message, 'error')
  }
}

async function loadForgeVersions(mc) {
  const sel = $('installLoaderVersionSelect')
  $('installLoaderVersionLabel').innerHTML = '<i class="fa-solid fa-fire-flame-curved"></i> ' + t('install.forgeVersion')
  try {
    const info = await api('/api/forge/versions/' + encodeURIComponent(mc))
    state.forgeVersions = info
    const opts = []
    if (info.recommended) opts.push('⭐ ' + t('install.recommended', { v: info.recommended }))
    if (info.latest && info.latest !== info.recommended) opts.push(t('install.latest', { v: info.latest }))
    if (!opts.length) throw new Error(t('install.forgeNotCompat'))
    sel.innerHTML = ''
    for (const o of opts) {
      const parts = o.split(': ')
      const ver = parts.length > 1 ? parts[1] : o
      sel.appendChild(new Option(o, ver))
    }
    $('installLoaderVersionField').hidden = false
  } catch (e) {
    state.forgeVersions = { recommended: null, latest: null }
    $('installLoaderVersionField').hidden = true
    if (![t('install.fabricNotCompat'), t('install.forgeNotCompat'), t('install.neoforgeNotCompat'), t('install.quiltNotCompat')].includes(e.message)) toast(e.message, 'error')
  }
}

function openInstallModal(versionId) {
  state.installVersionId = versionId
  $('installModalTitle').innerHTML = '<i class="fa-solid fa-boxes-stacked"></i> ' + t('install.title', { version: '<span class="ltr">' + versionId + '</span>' })
  $('installModal').hidden = false
  installSetLoader('')
}

async function loadNeoForgeVersions(mc) {
  const sel = $('installLoaderVersionSelect')
  $('installLoaderVersionLabel').innerHTML = '<i class="fa-solid fa-fire"></i> ' + t('install.neoforgeVersion')
  try {
    const info = await api('/api/neoforge/versions/' + encodeURIComponent(mc))
    const opts = []
    if (info.recommended) opts.push('⭐ ' + t('install.recommended', { v: info.recommended }))
    if (info.latest && info.latest !== info.recommended) opts.push(t('install.latest', { v: info.latest }))
    if (!opts.length) throw new Error(t('install.neoforgeNotCompat'))
    sel.innerHTML = ''
    for (const o of opts) {
      const parts = o.split(': ')
      const ver = parts.length > 1 ? parts[1] : o
      sel.appendChild(new Option(o, ver))
    }
    $('installLoaderVersionField').hidden = false
  } catch (e) {
    $('installLoaderVersionField').hidden = true
    if (![t('install.fabricNotCompat'), t('install.forgeNotCompat'), t('install.neoforgeNotCompat'), t('install.quiltNotCompat')].includes(e.message)) toast(e.message, 'error')
  }
}

async function loadQuiltLoaders(mc) {
  const sel = $('installLoaderVersionSelect')
  $('installLoaderVersionLabel').innerHTML = '<i class="fa-solid fa-quilt"></i> ' + t('install.quiltVersion')
  try {
    const loaders = await api('/api/quilt/loaders/' + encodeURIComponent(mc))
    if (!loaders.length) throw new Error(t('install.quiltNotCompat'))
    sel.innerHTML = ''
    for (const l of loaders.slice(0, 12)) {
      sel.appendChild(new Option((l.stable ? '⭐ ' : '') + l.version, l.version))
    }
    $('installLoaderVersionField').hidden = false
  } catch (e) {
    $('installLoaderVersionField').hidden = true
    if (![t('install.fabricNotCompat'), t('install.forgeNotCompat'), t('install.neoforgeNotCompat'), t('install.quiltNotCompat')].includes(e.message)) toast(e.message, 'error')
  }
}

function installSetLoader(name) {
  state.installLoader = name
  document.querySelectorAll('#installLoaderSeg button').forEach((b) => b.classList.toggle('active', b.dataset.loader === name))
  if (name === 'fabric' || name === 'forge' || name === 'neoforge' || name === 'quilt') {
    if (state.installVersionId) {
      if (name === 'fabric') loadFabricLoaders(state.installVersionId)
      else if (name === 'forge') loadForgeVersions(state.installVersionId)
      else if (name === 'neoforge') loadNeoForgeVersions(state.installVersionId)
      else loadQuiltLoaders(state.installVersionId)
    }
  } else {
    $('installLoaderVersionField').hidden = true
  }
}

async function confirmInstall() {
  const versionId = state.installVersionId
  if (!versionId) return
  const loader = state.installLoader || ''
  let loaderVersion = ''
  if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge' || loader === 'quilt') {
    loaderVersion = $('installLoaderVersionSelect').value
    if (!loaderVersion || loaderVersion === 'undefined' || loaderVersion === 'null') return toast(t('mods.chooseLoaderVersion'), 'error')
  }
  const btn = $('installConfirmBtn')
  btn.disabled = true
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + t('home.busy')
  try {
    const res = await api('/api/install', { method: 'POST', body: JSON.stringify({ versionId, loader, loaderVersion }) })
    state.activeJobId = res.jobId
    $('installModal').hidden = true
    toast(t('install.installing', { version: versionId, loader: loader ? ' (' + loaderName(loader) + ')' : '' }))
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fa-solid fa-download"></i> ' + t('common.install')
  }
}

function selectedInstanceKey() {
  const sel = $('instanceSelect')
  if (!sel || !sel.value) return null
  return sel.value
}

async function play() {
  const key = selectedInstanceKey()
  if (!key) return toast(t('home.noInstance'), 'error')
  const inst = state.instances[key]
  if (!inst) return toast(t('home.notFound'), 'error')
  const versionId = inst.versionId
  const loader = inst.loader || ''
  const loaderVersion = inst.loaderVersion || ''
  const games = state.game.games || []
  if (games.some((g) => g.key === key)) return toast(t('home.alreadyRunning'), 'error')
  if (games.some((g) => g.versionId === versionId)) return toast(t('home.alreadyVersion'), 'error')
  if (loader && games.some((g) => g.loader === loader)) return toast(t('home.alreadyLoader'), 'error')
  const accountId = $('accountSelect').value
  if (!accountId) return toast(t('home.needAccount'), 'error')

  try {
    const res = await api('/api/play', {
      method: 'POST',
      body: JSON.stringify({ versionId, loader, loaderVersion, accountId })
    })
    state.activeJobId = res.jobId
    setPlayButton(false, true, !!state.game.running)
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function stopGame() {
  try {
    await api('/api/stop', { method: 'POST' })
  } catch (e) {
    toast(e.message, 'error')
  }
}

function renderAccounts() {
  const sel = $('accountSelect')
  sel.innerHTML = ''
  if (!state.accounts.length) {
    sel.appendChild(new Option(t('accounts.noAcc'), ''))
  } else {
    for (const a of state.accounts) {
      const label = (a.premium ? '🟦 ' : '🟩 ') + a.name + (a.premium ? ' ' + t('accounts.premiumTag') : ' ' + t('accounts.offlineTag'))
      sel.appendChild(new Option(label, a.id))
    }
  }
  renderAccountList()
}

function renderAccountList() {
  const list = $('accountList')
  list.innerHTML = ''
  if (!state.accounts.length) {
    list.innerHTML = '<div class="vrow muted">' + t('accounts.none') + '</div>'
    return
  }
  for (const a of state.accounts) {
    const div = document.createElement('div')
    div.className = 'arecord'
    div.innerHTML = `
      <div class="avatar">${(a.name || '?')[0].toUpperCase()}</div>
      <div class="a-info">
        <div class="a-name">${escapeHtml(a.name)}</div>
        <div class="a-sub">${a.premium ? t('accounts.subPremium') : t('accounts.subOffline')}</div>
        ${a.type === 'microsoft' && a.hasProfile === false ? '<div class="a-warn">⚠ ' + t('accounts.noProfile') + '</div>' : ''}
      </div>
      <button class="icon-btn" data-del="${a.id}" title="${t('common.delete')}"><i class="fa-solid fa-trash"></i></button>`
    list.appendChild(div)
  }
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api('/api/accounts/' + b.dataset.del, { method: 'DELETE' })
      await loadInitial()
    })
  })
}

function populateSkinAccountSelect() {
  const sel = $('skinAccountSelect')
  const cur = sel.value || $('accountSelect').value
  sel.innerHTML = ''
  if (!state.accounts.length) {
    sel.appendChild(new Option(t('accounts.none'), ''))
    return
  }
  for (const a of state.accounts) {
    const label = (a.premium ? '🟦 ' : '🟩 ') + a.name + (a.premium ? ' ' + t('accounts.premiumTag') : ' ' + t('accounts.offlineTag'))
    sel.appendChild(new Option(label, a.id))
  }
  if (cur && state.accounts.some((a) => a.id === cur)) sel.value = cur
  else sel.value = state.accounts[0].id
  renderSkinsCurrent()
}

function renderSkinsCurrent() {
  const box = $('skinsCurrentBox')
  const account = state.accounts.find((a) => a.id === $('skinAccountSelect').value)
  const skin = account && account.skin
  if (!skin) {
    box.hidden = true
    return
  }
  box.hidden = false
  const prev = $('skinsCurrentPreview')
  prev.innerHTML = skin.preview ? `<img src="${skin.preview}" alt="">` : '<i class="fa-solid fa-shirt"></i>'
  let badge = skin.uploaded ? ' · ' + t('skins.badgeUploaded') : skin.local ? ' · ' + t('skins.badgeLocal') : ''
  if (skin.elyUploaded) badge += ' · Ely.by ✓'
  $('skinsCurrentInfo').innerHTML = `${escapeHtml(skin.name || '')} · ${skin.variant === 'slim' ? 'Slim' : 'Classic'}${badge}`
}

async function skinsTabOpen() {
  populateSkinAccountSelect()
  try {
    const r = await api('/api/skins/favorites')
    state.skins.favorites = r.favorites || []
  } catch (e) {}
  if (state.skins.favOnly) renderFavView()
  else if (!state.skins.items.length) await loadSkins(1)
}

async function loadSkins(page) {
  if (state.skins.loading) return
  if (state.skins.favOnly) {
    state.skins.favOnly = false
    const fbtn = $('skinFavBtn')
    if (fbtn) fbtn.classList.remove('active')
  }
  state.skins.loading = true
  $('skinsList').innerHTML = '<div class="vrow muted">' + t('skins.loading') + '</div>'
  $('skinNextPage').disabled = true
  $('skinPrevPage').disabled = page <= 1
  try {
    const q = $('skinSearch').value.trim()
    const r = await api('/api/skins?' + new URLSearchParams({ q, page }))
    state.skins.items = r.items || []
    state.skins.page = r.page
    state.skins.query = q
    $('skinPageInfo').textContent = t('common.page', { n: r.page })
    $('skinNextPage').disabled = !r.hasMore
    renderSkins()
    if (!state.skins.items.length) $('skinsList').innerHTML = '<div class="vrow muted">' + t('skins.noResults') + '</div>'
  } catch (e) {
    $('skinsList').innerHTML = '<div class="vrow muted">' + t('skins.failLoad', { msg: escapeHtml(e.message) }) + '</div>' +
      '<div class="vrow"><button class="btn" id="skinRetryBtn"><i class="fa-solid fa-rotate"></i> ' + t('common.retry') + '</button></div>'
    const retry = $('skinRetryBtn')
    if (retry) retry.addEventListener('click', () => loadSkins(page))
  } finally {
    state.skins.loading = false
  }
}

function renderSkins() {
  const list = $('skinsList')
  list.innerHTML = ''
  for (const s of state.skins.items) {
    const fav = state.skins.favorites.some((f) => String(f.id) === String(s.id))
    const div = document.createElement('div')
    div.className = 'skin-card'
    div.innerHTML = `
      <div class="skin-card-preview"><img src="${s.preview}" alt="" loading="lazy"></div>
      <div class="skin-card-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
      <div class="skin-card-meta">
        <span class="tag ${s.variant === 'slim' ? 'slim' : 'classic'}">${s.variant === 'slim' ? 'Slim' : 'Classic'}</span>
        <span class="muted small">${escapeHtml(s.author)}</span>
        <button class="icon-btn skin-fav ${fav ? 'fav' : ''}" data-skin-fav="${s.id}" title="${fav ? t('skins.removeFav') : t('skins.addFav')}"><i class="fa-solid fa-star"></i></button>
      </div>
      <button class="btn" data-skin-choose="${s.id}"><i class="fa-solid fa-shirt"></i> ${t('skins.choose')}</button>`
    div.querySelector('[data-skin-choose]').addEventListener('click', () => chooseSkin(s))
    div.querySelector('[data-skin-fav]').addEventListener('click', () => toggleSkinFav(s.id))
    list.appendChild(div)
  }
}

async function toggleSkinFav(id) {
  const s = state.skins.items.find((x) => String(x.id) === String(id)) || state.skins.favorites.find((x) => String(x.id) === String(id))
  if (!s) return
  try {
    const r = await api('/api/skins/favorites/toggle', { method: 'POST', body: JSON.stringify({ skin: s }) })
    state.skins.favorites = r.favorites || []
    const added = state.skins.favorites.some((f) => String(f.id) === String(id))
    if (state.skins.favOnly) renderFavView()
    else renderSkins()
    toast(added ? t('skins.addedFav') : t('skins.removedFav'), added ? 'success' : '')
  } catch (e) {
    toast(e.message, 'error')
  }
}

function renderFavView() {
  const btn = $('skinFavBtn')
  btn.classList.add('active')
  state.skins.items = [...state.skins.favorites]
  renderSkins()
  $('skinPrevPage').disabled = true
  $('skinNextPage').disabled = true
  $('skinPageInfo').textContent = t('skins.favCount', { n: state.skins.favorites.length })
  if (!state.skins.favorites.length) {
    $('skinsList').innerHTML = '<div class="vrow muted">' + t('skins.noFavs') + '</div>'
  }
}

function toggleFavOnly() {
  state.skins.favOnly = !state.skins.favOnly
  const btn = $('skinFavBtn')
  if (state.skins.favOnly) {
    btn.classList.add('active')
    renderFavView()
  } else {
    btn.classList.remove('active')
    if (state.skins.query) loadSkins(state.skins.page)
    else loadSkins(1)
  }
}

async function chooseSkin(s) {
  const accountId = $('skinAccountSelect').value
  if (!accountId) return toast(t('skins.needAccountFirst'), 'error')
  const btn = document.querySelector(`[data-skin-choose="${s.id}"]`)
  if (btn) {
    btn.disabled = true
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + t('common.loading')
  }
  try {
    const r = await api('/api/skins/apply', {
      method: 'POST',
      body: JSON.stringify({ accountId, skinUrl: s.skinUrl, variant: s.variant, name: s.name, preview: s.preview })
    })
    toast(r.uploaded ? t('skins.uploadedOfficial') : t('skins.appliedLocal'), 'success')
    const accountsRes = await api('/api/accounts')
    state.accounts = accountsRes.accounts
    renderAccounts()
    renderSkinsCurrent()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.innerHTML = '<i class="fa-solid fa-shirt"></i> ' + t('skins.choose')
    }
  }
}

async function removeCurrentSkin() {
  const accountId = $('skinAccountSelect').value
  if (!accountId) return
  try {
    await api('/api/skins/remove', { method: 'POST', body: JSON.stringify({ accountId }) })
    const accountsRes = await api('/api/accounts')
    state.accounts = accountsRes.accounts
    renderAccounts()
    renderSkinsCurrent()
    toast(t('skins.removed'), 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function uploadToElyby() {
  const accountId = $('skinAccountSelect').value
  if (!accountId) return toast(t('skins.needAccountFirst'), 'error')
  const btn = $('skinsElyBtn')
  btn.disabled = true
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + t('common.loading')
  try {
    const r = await api('/api/skins/ely-upload', { method: 'POST', body: JSON.stringify({ accountId }) })
    toast(t('skins.uploadedEly', { name: r.name || '' }), 'success')
    renderSkinsCurrent()
    const account = state.accounts.find((a) => a.id === accountId)
    if (account && r.name && account.name.toLowerCase() !== r.name.toLowerCase()) {
      toast(t('skins.elyWarn', { elyName: r.name, mcName: account.name }), 'error', 8000)
      window.open('https://account.ely.by/profile/username', '_blank')
    } else if (r.texturesUrl) {
      toast(t('skins.skinLink', { url: r.texturesUrl }), 'success', 5000)
    }
  } catch (e) {
    toast(t('skins.uploadFail', { msg: e.message }), 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> ' + t('skins.uploadEly')
  }
}

async function testElyby() {
  const email = $('elybyEmailSetting').value.trim()
  const password = $('elybyPasswordSetting').value
  if (!email || !password) return toast(t('settings.enterEly'), 'error')
  const btn = $('testElyby')
  btn.disabled = true
  try {
    const r = await api('/api/skins/elyby-test', { method: 'POST', body: JSON.stringify({ email, password }) })
    await saveSettings()
    $('elybyStatus').textContent = t('settings.connected', { name: r.name })
    toast(t('settings.elyConnected', { name: r.name }), 'success')
  } catch (e) {
    $('elybyStatus').textContent = '✗ ' + e.message
    toast(t('settings.connectFail', { msg: e.message }), 'error')
  } finally {
    btn.disabled = false
  }
}

function populateDataInstanceSelect() {
  const sel = $('dataInstanceSelect')
  if (!sel) return
  const keys = Object.keys(state.instances || {}).filter((k) => state.instances[k] && state.instances[k].status !== 'installing')
  const cur = state.data.instance || (typeof selectedInstanceKey === 'function' ? selectedInstanceKey() : '')
  sel.innerHTML = ''
  if (!keys.length) {
    sel.appendChild(new Option(t('versions.noInst'), ''))
  } else {
    for (const k of keys) sel.appendChild(new Option(`${k} — ${loaderName(state.instances[k].loader)}`, k))
    if (cur && keys.includes(cur)) sel.value = cur
    else sel.value = keys[0]
  }
  state.data.instance = sel.value
}

function dataInstance() {
  const sel = $('dataInstanceSelect')
  return sel ? sel.value : ''
}

async function dataTabOpen() {
  populateDataInstanceSelect()
  await Promise.all([loadScreenshots(), loadBackups(), loadOptions()])
}

async function loadScreenshots() {
  const key = dataInstance()
  if (!key) {
    state.data.screenshots = []
    renderScreenshots()
    return
  }
  try {
    const r = await api('/api/screenshots?instance=' + encodeURIComponent(key))
    state.data.screenshots = r.items || []
  } catch (e) {
    state.data.screenshots = []
  }
  renderScreenshots()
}

function renderScreenshots() {
  const box = $('shotsList')
  if (!box) return
  const items = state.data.screenshots
  if (!items.length) {
    box.innerHTML = '<div class="vrow muted">' + t('data.noShots') + '</div>'
    return
  }
  box.innerHTML = ''
  for (const s of items) {
    const src = '/api/screenshots/file?instance=' + encodeURIComponent(state.data.instance) + '&name=' + encodeURIComponent(s.file)
    const div = document.createElement('div')
    div.className = 'shot-card'
    div.innerHTML = `
      <img src="${src}" alt="${escapeHtml(s.file)}" loading="lazy">
      <div class="shot-meta">
        <div class="shot-name" title="${escapeHtml(s.file)}">${escapeHtml(s.file)}</div>
        <div class="shot-sub">${(s.size / 1048576).toFixed(2)} MB · ${new Date(s.modified).toLocaleString()}</div>
      </div>
      <button class="icon-btn danger shot-del" title="${t('common.delete')}"><i class="fa-solid fa-trash"></i></button>`
    div.querySelector('.shot-del').addEventListener('click', async () => {
      if (!confirm(t('data.deleteShot', { file: s.file }))) return
      try {
        await api('/api/screenshots/delete', { method: 'POST', body: JSON.stringify({ instance: state.data.instance, name: s.file }) })
        toast(t('data.deletedShot', { file: s.file }), 'success')
        await loadScreenshots()
      } catch (e) {
        toast(e.message, 'error')
      }
    })
    box.appendChild(div)
  }
}

async function loadBackups() {
  const key = dataInstance()
  if (!key) {
    state.data.backups = []
    renderBackups()
    return
  }
  try {
    const r = await api('/api/backups?instance=' + encodeURIComponent(key))
    state.data.backups = r.items || []
  } catch (e) {
    state.data.backups = []
  }
  renderBackups()
}

function renderBackups() {
  const box = $('backupList')
  if (!box) return
  const items = state.data.backups
  if (!items.length) {
    box.innerHTML = '<div class="vrow muted">' + t('data.noBackups') + '</div>'
    return
  }
  box.innerHTML = ''
  for (const b of items) {
    const div = document.createElement('div')
    div.className = 'vrow'
    div.innerHTML = `
      <div class="v-info">
        <div class="v-name">${escapeHtml(b.file)}</div>
        <div class="v-sub">${(b.size / 1048576).toFixed(1)} MB · ${new Date(b.modified).toLocaleString()}</div>
      </div>
      <div class="row">
        <button class="btn backup-restore"><i class="fa-solid fa-rotate-left"></i> ${t('data.restore')}</button>
        <button class="icon-btn danger backup-del" title="${t('common.delete')}"><i class="fa-solid fa-trash"></i></button>
      </div>`
    div.querySelector('.backup-restore').addEventListener('click', async (e) => {
      if (!confirm(t('data.restoreConfirm', { file: b.file }))) return
      const btn = e.currentTarget
      btn.disabled = true
      try {
        const res = await api('/api/backups/restore', { method: 'POST', body: JSON.stringify({ instance: state.data.instance, file: b.file }) })
        state.activeJobId = res.jobId
        toast(t('data.restoring', { file: b.file }))
      } catch (err) {
        btn.disabled = false
        toast(err.message, 'error')
      }
    })
    div.querySelector('.backup-del').addEventListener('click', async () => {
      if (!confirm(t('data.deleteBackup', { file: b.file }))) return
      try {
        await api('/api/backups/delete', { method: 'POST', body: JSON.stringify({ instance: state.data.instance, file: b.file }) })
        toast(t('data.deletedBackup', { file: b.file }), 'success')
        await loadBackups()
      } catch (e) {
        toast(e.message, 'error')
      }
    })
    box.appendChild(div)
  }
}

async function createBackup() {
  const key = dataInstance()
  if (!key) return toast(t('versions.noInst'), 'error')
  const btn = $('backupCreateBtn')
  btn.disabled = true
  try {
    const res = await api('/api/backups', { method: 'POST', body: JSON.stringify({ instance: key }) })
    state.activeJobId = res.jobId
    toast(t('data.backingUp', { key }))
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    btn.disabled = false
  }
}

async function openShots() {
  const key = dataInstance()
  if (!key) return toast(t('versions.noInst'), 'error')
  try {
    await api('/api/screenshots/open', { method: 'POST', body: JSON.stringify({ instance: key }) })
  } catch (e) {
    toast(e.message, 'error')
  }
}

function serversInstance() {
  return selectedInstanceKey() || ''
}

async function serversTabOpen() {
  await loadServers()
}

async function loadServers() {
  const key = serversInstance()
  if (!key) {
    state.servers.items = []
    renderServers()
    return
  }
  try {
    const r = await api('/api/servers?instance=' + encodeURIComponent(key))
    state.servers.items = r.servers || []
    state.servers.rev = r.rev || 0
  } catch (e) {
    state.servers.items = []
  }
  state.servers.loaded = true
  renderServers()
}

function serverIconSrc(s) {
  if (s.icon || s.ip) return '/api/servers/icon?host=' + encodeURIComponent(s.ip) + '&port=' + encodeURIComponent(s.port) + '&instance=' + encodeURIComponent(serversInstance()) + '&v=' + Math.random().toString(36).slice(2)
  return ''
}

function renderServers() {
  const box = $('serversList')
  if (!box) return
  const key = serversInstance()
  const items = state.servers.items
  if (!key) {
    box.innerHTML = '<div class="vrow muted">' + t('versions.noInst') + '</div>'
    return
  }
  if (!items.length) {
    box.innerHTML = '<div class="vrow muted">' + t('servers.none') + '</div>'
    return
  }
  box.innerHTML = ''
  for (const s of items) {
    const div = document.createElement('div')
    div.className = 'srow'
    const plays = s.plays ? s.plays + '×' : ''
    const last = s.lastPlayed ? new Date(s.lastPlayed).toLocaleDateString() : ''
    const sub = []
    if (s.name !== s.ip) sub.push(escapeHtml(s.ip) + (s.port !== 25565 ? ':' + s.port : ''))
    else if (s.port !== 25565) sub.push(':' + s.port)
    if (plays) sub.push(t('servers.plays', { n: s.plays }))
    if (last) sub.push(last)
    div.innerHTML = `
      <div class="srv-icon">
        <img src="${serverIconSrc(s)}" alt="" onerror="this.style.display='none'"><span class="srv-fallback">${escapeHtml((s.name || '?')[0].toUpperCase())}</span>
      </div>
      <div class="v-info">
        <div class="v-name">${escapeHtml(s.name || s.ip)}</div>
        <div class="v-sub">${sub.join(' · ')}</div>
        <div class="srv-version">
          <div class="select-wrap"><select class="srv-version-select" data-srv="${escapeHtml(s.ip)}" data-srvport="${s.port}"></select></div>
        </div>
      </div>
      <div class="row">
        <button class="btn srv-play" data-srv="${escapeHtml(s.ip)}" data-srvport="${s.port}"><i class="fa-solid fa-play"></i> <span data-i18n="servers.play">Play</span></button>
        ${s.inDat
          ? '<span class="srv-saved" title="' + t('servers.inDatTitle') + '"><i class="fa-solid fa-circle-check"></i> ' + t('servers.savedInDat') + '</span>'
          : '<button class="ghost-btn srv-save" data-srv="' + escapeHtml(s.ip) + '" data-srvport="' + s.port + '"><i class="fa-solid fa-bookmark"></i> <span data-i18n="servers.saveInDat">Save in Minecraft</span></button>'}
        <button class="icon-btn danger srv-del" data-srv="${escapeHtml(s.ip)}" title="${t('common.delete')}"><i class="fa-solid fa-trash"></i></button>
      </div>`
    box.appendChild(div)
    const sel = div.querySelector('.srv-version-select')
    fillServerVersionSelect(sel, s)
    sel.addEventListener('change', async () => {
      const parts = sel.value.split('|')
      const versionId = parts[0] || ''
      const loader = parts[1] || ''
      const loaderVersion = parts[2] || ''
      try {
        await api('/api/servers/version', { method: 'POST', body: JSON.stringify({ ip: s.ip, versionId, loader, loaderVersion }) })
        s.versionId = versionId
        s.loader = loader
        s.loaderVersion = loaderVersion
        toast(t('servers.versionSaved'), 'success')
      } catch (e) {
        toast(e.message, 'error')
      }
    })
    div.querySelector('.srv-play').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      try {
        await playOnServer(s)
      } catch (err) {
        toast(err.message, 'error')
      } finally {
        btn.disabled = false
      }
    })
    const saveBtn = div.querySelector('.srv-save')
    if (saveBtn) {
      saveBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        try {
          await api('/api/servers/add', { method: 'POST', body: JSON.stringify({ instance: serversInstance(), name: s.name, ip: s.ip, port: s.port }) })
          toast(t('servers.savedInDat'), 'success')
          await loadServers()
        } catch (err) {
          toast(err.message, 'error')
          btn.disabled = false
        }
      })
    }
    div.querySelector('.srv-del').addEventListener('click', async () => {
      if (!confirm(t('servers.deleteConfirm', { name: s.name || s.ip }))) return
      try {
        await api('/api/servers/remove', { method: 'POST', body: JSON.stringify({ instance: serversInstance(), ip: s.ip }) })
        toast(t('servers.deleted', { name: s.name || s.ip }), 'success')
        await loadServers()
      } catch (e) {
        toast(e.message, 'error')
      }
    })
  }
}

function fillServerVersionSelect(sel, s) {
  const keys = Object.keys(state.instances || {}).filter((k) => state.instances[k] && state.instances[k].status !== 'installing')
  const cur = s.versionId ? (s.versionId + (s.loader ? '|' + s.loader : '')) : ''
  sel.innerHTML = ''
  if (!keys.length) {
    sel.appendChild(new Option(t('versions.noInst'), ''))
    return
  }
  sel.appendChild(new Option(t('servers.auto'), ''))
  for (const k of keys) {
    const inst = state.instances[k]
    const val = inst.versionId + (inst.loader ? '|' + inst.loader : '') + (inst.loaderVersion ? '|' + inst.loaderVersion : '')
    const opt = new Option(k + ' — ' + loaderName(inst.loader), val)
    if (cur && val.startsWith(cur)) opt.selected = true
    sel.appendChild(opt)
  }
}

async function playOnServer(s) {
  const key = serversInstance()
  if (!key) return toast(t('home.noInstance'), 'error')
  const inst = state.instances[key]
  if (!inst) return toast(t('home.notFound'), 'error')
  let versionId = inst.versionId
  let loader = inst.loader || ''
  let loaderVersion = inst.loaderVersion || ''
  if (s.versionId) {
    versionId = s.versionId
    loader = s.loader || ''
    loaderVersion = s.loaderVersion || ''
  }
  const accountId = $('accountSelect').value
  if (!accountId) return toast(t('home.needAccount'), 'error')
  const address = s.ip + (s.port !== 25565 ? ':' + s.port : '')
  const res = await api('/api/play', {
    method: 'POST',
    body: JSON.stringify({ versionId, loader, loaderVersion, accountId, server: address })
  })
  state.activeJobId = res.jobId
  setPlayButton(false, true, !!state.game.running)
  toast(t('servers.launching', { name: s.name || s.ip }), 'success')
}

async function addServerFromForm() {
  const name = $('addServerName').value.trim()
  const ip = $('addServerIp').value.trim()
  const key = serversInstance()
  if (!key) return toast(t('versions.noInst'), 'error')
  if (!ip) return toast(t('servers.needAddress'), 'error')
  try {
    await api('/api/servers/track', { method: 'POST', body: JSON.stringify({ name, ip }) })
    $('addServerName').value = ''
    $('addServerIp').value = ''
    $('addServerModal').hidden = true
    toast(t('servers.added'), 'success')
    await loadServers()
  } catch (e) {
    toast(e.message, 'error')
  }
}

function alreadyAddedIp(host) {
  const items = state.servers.items || []
  return items.some((s) => s.ip === host)
}

let browseQuery = ''
let browsePage = 1
let browseTotalPages = 1
let browseHasNext = false

async function openServerBrowse() {
  $('browseServerModal').hidden = false
  $('browseServerSearch').value = ''
  browseQuery = ''
  browsePage = 1
  await renderBrowseServers()
}

async function renderBrowseServers() {
  const box = $('browseServerList')
  const pagesBox = $('browseServerPages')
  if (!box) return
  box.innerHTML = '<div class="vrow muted">' + t('servers.loading') + '</div>'
  if (pagesBox) pagesBox.innerHTML = ''
  try {
    const r = await api('/api/servers/browse?q=' + encodeURIComponent(browseQuery) + '&page=' + browsePage)
    const list = r.servers || []
    browseTotalPages = r.totalPages || 1
    browseHasNext = !!r.hasNext
    if (!list.length) {
      box.innerHTML = '<div class="vrow muted">' + t('servers.browseNone') + '</div>'
      renderBrowsePages(pagesBox)
      return
    }
    box.innerHTML = ''
    for (const srv of list) {
      const host = (srv.address || '').split(':')[0]
      const port = parseInt((srv.address || '').split(':')[1] || '25565', 10) || 25565
      const div = document.createElement('div')
      div.className = 'brow'
      const added = alreadyAddedIp(host)
      const iconSrc = '/api/icons?host=' + encodeURIComponent(host) + '&port=' + port + '&v=' + Math.random().toString(36).slice(2)
      div.innerHTML = `
        <div class="srv-icon">
          <img src="${iconSrc}" alt="" onerror="this.style.display='none'"><span class="srv-fallback">${escapeHtml((srv.name || '?')[0].toUpperCase())}</span>
        </div>
        <div class="brow-info">
          <div class="brow-name">${escapeHtml(srv.name)}</div>
          <div class="brow-addr">${escapeHtml(srv.address)}</div>
        </div>
        <button class="btn brow-add" data-host="${escapeHtml(host)}" ${added ? 'disabled' : ''}>${added ? t('common.installed') : t('servers.browseAdd')}</button>`
      box.appendChild(div)
      const btn = div.querySelector('.brow-add')
      if (btn && !btn.disabled) {
        btn.addEventListener('click', async () => {
          btn.disabled = true
          try {
            await api('/api/servers/track', { method: 'POST', body: JSON.stringify({ name: srv.name, ip: srv.address }) })
            btn.textContent = t('common.installed')
            toast(t('servers.added'), 'success')
            await loadServers()
          } catch (e) {
            toast(e.message, 'error')
            btn.disabled = false
          }
        })
      }
    }
    renderBrowsePages(pagesBox)
  } catch (e) {
    box.innerHTML = '<div class="vrow muted">' + escapeHtml(e.message) + '</div>'
  }
}

function renderBrowsePages(pagesBox) {
  if (!pagesBox) return
  pagesBox.innerHTML = ''
  const total = browseTotalPages
  const cur = browsePage
  const makeBtn = (label, p, cls, disabled) => {
    const b = document.createElement('button')
    b.className = 'browse-page-btn' + (cls ? ' ' + cls : '')
    b.textContent = label
    b.disabled = !!disabled
    if (!disabled) b.addEventListener('click', () => {
      if (p === browsePage) return
      browsePage = p
      renderBrowseServers()
    })
    pagesBox.appendChild(b)
  }
  const addEllipsis = () => {
    const e = document.createElement('span')
    e.className = 'browse-dots'
    e.textContent = '...'
    pagesBox.appendChild(e)
  }
  makeBtn('\u2039', cur - 1, '', cur <= 1)
  let start = Math.max(1, cur - 2)
  let end = Math.min(total, start + 4)
  start = Math.max(1, end - 4)
  if (start > 1) {
    makeBtn('1', 1)
    if (start > 2) addEllipsis()
  }
  for (let p = start; p <= end; p++) makeBtn(String(p), p, p === cur ? 'active' : '')
  if (end < total) {
    if (end < total - 1) addEllipsis()
    makeBtn(String(total), total)
  }
  if (cur < total || browseHasNext) makeBtn('\u203A', cur + 1)
}

function escapeHtml(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

function renderVersionsTab() {
  const list = $('versionList')
  const cmpVer = (x, y) => {
    const nx = x.split('-')[0].split('.').map(Number)
    const ny = y.split('-')[0].split('.').map(Number)
    for (let i = 0; i < 4; i++) {
      const dx = nx[i] || 0
      const dy = ny[i] || 0
      if (dx !== dy) return dy - dx
    }
    return y.localeCompare(x)
  }
  const releases = state.versions.filter((v) => v.type === 'release').sort((a, b) => cmpVer(a.id, b.id))
  const snapshots = state.versions.filter((v) => v.type === 'snapshot').sort((a, b) => cmpVer(a.id, b.id))

  list.innerHTML = ''
  const groups = [
    [t('versions.stable'), releases],
    [t('versions.snapshot'), snapshots]
  ]
  for (const [label, arr] of groups) {
    const h = document.createElement('div')
    h.className = 'muted'
    h.style.marginTop = '14px'
    h.style.fontWeight = '700'
    h.textContent = label
    list.appendChild(h)
    for (const v of arr) {
      const inst = isInstalledAny(v.id)
      const div = document.createElement('div')
      div.className = 'vrow'
      div.dataset.vid = v.id
      div.innerHTML = `
        <div class="v-info">
          <div class="v-name">${v.id} <span class="tag ${v.type}">${v.type}</span> ${inst ? '<span class="tag installed">' + t('versions.installedTag') + '</span>' : ''}</div>
          <div class="v-sub"><span>${(v.releaseTime || '').slice(0, 10)}</span></div>
        </div>
        <div class="row">
          <button class="btn" data-install="${v.id}">${inst ? '✓ ' + t('versions.installedTag') : t('common.install')}</button>
        </div>`
      list.appendChild(div)
    }
  }
  list.querySelectorAll('[data-install]').forEach((b) => {
    b.addEventListener('click', () => openInstallModal(b.dataset.install))
  })
}

function renderSettings() {
  const c = state.config
  $('memSetting').value = Math.max(1, Math.round((c.memory || 2048) / 1024))
  $('memSettingVal').textContent = $('memSetting').value + ' GB'
  $('elybyEmailSetting').value = c.elybyEmail || ''
  $('elybyPasswordSetting').value = c.elybyPassword || ''
  const elyStatus = $('elybyStatus')
  if (c.elybyName && c.elybyUuid) elyStatus.textContent = t('settings.linked', { name: c.elybyName })
  else if (c.elybyEmail) elyStatus.textContent = t('settings.notTested')
  else elyStatus.textContent = ''
}

function sortInstanceKeys(keys) {
  const sortSemver = (a, b) => {
    const na = String(a).split('-')[0].split('.').map(Number)
    const nb = String(b).split('-')[0].split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const da = na[i] || 0
      const db = nb[i] || 0
      if (da !== db) return db - da
    }
    return String(b).localeCompare(String(a))
  }
  return [...keys].sort(sortSemver)
}

function renderOptionsUI() {
  const c = state.controls || { auto: false, target: '', active: '', profiles: [] }
  const sel = $('dataInstanceSelect')
  const n = (c.profiles || []).length
  $('optionsSourceInfo').textContent = n ? `محفوظ ${n} نسخة إعدادات` : ''
  $('optionsProfilesArea').hidden = n === 0
  if (n === 0) return

  const tsel = $('optionsTargetSel')
  if (!tsel.dataset.built || tsel.dataset.built !== String(n)) {
    tsel.innerHTML = ''
    tsel.appendChild(new Option('كل الإصدارات', ''))
    const keys = sortInstanceKeys(Object.keys(state.instances || {}).filter((k) => {
      const st = state.instances[k]
      return st && st.status !== 'installing' && st.status !== 'preparing'
    }))
    for (const k of keys) tsel.appendChild(new Option(k, k))
    tsel.dataset.built = String(n)
  }
  if (c.target && [...tsel.options].some((o) => o.value === c.target)) tsel.value = c.target
  else tsel.value = ''

  const auto = !!c.auto
  $('optionsAutoChk').checked = auto
  $('optionsAutoLbl').textContent = 'تطبيق تلقائي'
  renderOptionsProfiles()
}

function renderOptionsProfiles() {
  const c = state.controls || { auto: false, target: '', active: '', profiles: [] }
  const box = $('optionsProfilesList')
  if (!box) return
  box.innerHTML = ''
  for (const p of c.profiles || []) {
    const div = document.createElement('div')
    div.className = 'vrow'
    div.innerHTML = `
      <div class="v-info">
        <div class="v-name">${escapeHtml(p.name)}${p.id === c.active ? ' <span class="tag">تلقائي</span>' : ''}</div>
        <div class="v-sub">من ${escapeHtml(p.source)}</div>
      </div>
      <div class="row">
        <button class="ghost-btn" data-apply="${escapeHtml(p.id)}" title="طبّق هذا الإعداد على النسخة المختارة"><i class="fa-solid fa-keyboard"></i> طبّق</button>
        <button class="ghost-btn" data-active="${escapeHtml(p.id)}" title="اجعله الإعداد التلقائي" style="color:${p.id === c.active ? 'var(--green2)' : ''}"><i class="fa-solid ${p.id === c.active ? 'fa-star' : 'fa-star-o'}"></i></button>
        <button class="icon-btn danger" data-del="${escapeHtml(p.id)}" title="حذف هذا الإعداد"><i class="fa-solid fa-trash"></i></button>
      </div>`
    div.querySelector('[data-apply]').addEventListener('click', () => optionsApply(p.id))
    div.querySelector('[data-active]').addEventListener('click', () => optionsSetActive(p.id))
    div.querySelector('[data-del]').addEventListener('click', () => optionsDelete(p.id))
    box.appendChild(div)
  }
}

async function loadOptions() {
  try {
    state.controls = await api('/api/options')
  } catch (e) {}
  renderOptionsUI()
}

async function optionsSave() {
  const key = dataInstance()
  if (!key) return toast('حدد النسخة أولًا', 'error')
  const btn = $('optionsSaveBtn')
  btn.disabled = true
  try {
    state.controls = await api('/api/options/save', { method: 'POST', body: JSON.stringify({ key }) })
    renderOptionsUI()
    toast('تم حفظ إعدادات التحكم من «' + key + '»', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
  btn.disabled = false
}

async function optionsDelete(id) {
  if (!confirm('حذف هذا الإعداد؟')) return
  try {
    state.controls = await api('/api/options/delete', { method: 'POST', body: JSON.stringify({ id }) })
    renderOptionsUI()
    toast('تم حذف الإعداد', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function optionsApply(id) {
  const target = $('optionsTargetSel').value
  try {
    const r = await api('/api/options/apply', { method: 'POST', body: JSON.stringify({ id, target }) })
    toast('تم تطبيق «' + r.profile + '» على ' + (r.targets.length === 1 ? r.targets[0] : r.targets.length + ' نسخ'), 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function optionsSetActive(id) {
  try {
    state.controls = await api('/api/options/config', { method: 'POST', body: JSON.stringify({ active: id }) })
    renderOptionsUI()
    toast('صار هذا الإعداد التلقائي', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function optionsSetTarget() {
  const target = $('optionsTargetSel').value
  try {
    state.controls = await api('/api/options/config', { method: 'POST', body: JSON.stringify({ target }) })
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function optionsSetAuto(on) {
  try {
    state.controls = await api('/api/options/config', { method: 'POST', body: JSON.stringify({ auto: on }) })
    renderOptionsUI()
    toast(on ? 'تم تفعيل «تطبيق تلقائي» — أول ما تدخل نسخة يطبق إعدادك عليها' : 'تم إيقاف «تطبيق تلقائي»', 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function saveSettings() {
  const body = {
    memory: Math.round(Number($('memSetting').value)) * 1024,
    elybyEmail: $('elybyEmailSetting').value.trim(),
    elybyPassword: $('elybyPasswordSetting').value
  }
  if (state.config.lang) body.lang = state.config.lang
  try {
    state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(body) })
    toast(t('common.saved'), 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

function logLine(line, cls) {
  const box = $('console')
  const div = document.createElement('div')
  div.className = 'console-line ' + (cls || '')
  const t = new Date(line.t).toLocaleTimeString()
  div.innerHTML = `<span class="t">[${t}]</span>${escapeHtml(tConsoleLine(line.line))}`
  box.appendChild(div)
  while (box.childElementCount > 500) box.removeChild(box.firstChild)
  box.scrollTop = box.scrollHeight
}

function logClass(line) {
  const lw = String(line || '').toLowerCase()
  if (/fatal|severe|crash|crashed|exception|error|\berr:|فشل/.test(lw)) return 'err'
  if (/warn(ing)?/.test(lw)) return 'warn'
  if (/✓|done|success|successfully|finished|ready|launched|تم تنزيل|تم تحميل/.test(lw)) return 'ok'
  if (/info|loading|started|starting|loaded|staging|building|تجهيز/.test(lw)) return 'info'
  if (/^\s*at |^\s+\.\.\.\d+ more/.test(String(line))) return 'dim'
  return ''
}

async function tick() {
  let jobs = {}
  try {
    jobs = (await api('/api/jobs')).reduce((m, j) => ((m[j.id] = j), m), {})
  } catch (e) {}
  state.jobs = jobs

  const active = Object.values(jobs).filter((j) => !j.done)
  const playJob = state.activeJobId && jobs[state.activeJobId] ? jobs[state.activeJobId] : null
  const anyJob = active[0]

  if (anyJob) {
    $('playProgress').hidden = false
    $('playProgressLabel').textContent = tJobLabel(anyJob.label) + (anyJob.total ? ` (${anyJob.current}/${anyJob.total})` : '')
    const pct = anyJob.total ? Math.min(100, Math.round((anyJob.current / anyJob.total) * 100)) : 100
    $('playProgressFill').style.width = pct + '%'
    $('playProgressFill').style.animation = anyJob.total ? 'none' : 'indet 1.2s infinite'
    $('cancelJobBtn').hidden = false
    setPlayButton(false, true, !!state.game.running)
  } else {
    $('playProgress').hidden = true
    $('cancelJobBtn').hidden = true
  }

  if (playJob && playJob.done) {
    state.activeJobId = null
    if (playJob.error) {
      toast(playJob.error === 'cancelled' ? 'تم إيقاف التحميل' : t('home.playFailed', { msg: tServer(playJob.error) }), 'error')
    }
    if (playJob.type === 'mods') {
      if (!playJob.error) {
        const d = (playJob.data && playJob.data.dependencies) || 0
        toast(d ? t('mods.installedDeps', { n: d }) : t('mods.installedMod'), 'success')
      }
      refreshModsInstalled()
      runModsSearch()
    }
    if (playJob.type === 'modpack') {
      if (!playJob.error) {
        const d = playJob.data || {}
        toast(d.name ? t('mods.importedPack', { name: d.name, key: d.instanceId }) : t('mods.importedPackDone'), 'success')
      }
      await refreshModsInstalled()
    }
    if (playJob.type === 'modfix') {
      if (!playJob.error) {
        const d = playJob.data || []
        const ok = d.filter((x) => x.status === 'installed').length
        const fail = d.filter((x) => x.status === 'failed')
        toast(ok ? t('mods.autoFixed', { n: ok }) : t('mods.autoFixNone'), ok ? 'success' : 'error')
        if (fail.length) toast(t('mods.autoFixFail', { list: fail.map((x) => x.id).join(', ') }), 'error', 5000)
      }
      refreshModsInstalled()
    }
    if (playJob.type === 'ms-login') {
      if (!playJob.error) {
        toast(t('accounts.loggedIn'), 'success')
        const accountsRes = await api('/api/accounts')
        state.accounts = accountsRes.accounts
        renderAccounts()
      }
    }
    if (playJob.type === 'backup') {
      if (!playJob.error) {
        const d = playJob.data || {}
        toast(t('data.backupDone', { file: d.file || '' }), 'success')
      }
      await loadBackups()
    }
    if (playJob.type === 'backup-restore') {
      if (!playJob.error) {
        const d = playJob.data || {}
        toast(t('data.restoreDone', { file: d.file || '' }), 'success')
      }
    }
    await refreshInstances()
  }

  let game = state.game
  try {
    game = await api('/api/game')
  } catch (e) {}
  state.game = game
  const games = game.games || []
  const anyRunning = games.length > 0
  const selKey = selectedInstanceKey()
  const selfRunning = games.some((g) => g.key === selKey)

  if (anyRunning) {
    $('instanceBadge').hidden = false
    $('instanceBadge').textContent = games.length === 1
      ? t('home.playingOne', { key: games[0].key })
      : t('home.playingMany', { n: games.length, list: games.map((g) => g.key).join('، ') })
  } else {
    $('instanceBadge').hidden = true
  }
  setPlayButton(selfRunning, !!anyJob, anyRunning)

  const logRes = await api('/api/game/logs?offset=' + state.logOffset)
  if (logRes.logs && logRes.logs.length) {
    for (const l of logRes.logs) {
      logLine(l, logClass(l.line))
    }
    state.logOffset = logRes.logs[logRes.logs.length - 1].n + 1
  }

  if (anyRunning && document.getElementById('tab-servers').classList.contains('active')) {
    const sKey = serversInstance()
    if (sKey) {
      try {
        const r = await api('/api/servers?instance=' + encodeURIComponent(sKey))
        if ((r.rev || 0) !== (state.servers.rev || 0)) await loadServers()
      } catch (e) {}
    }
  }

  await renderMissingBanner()
}

let lastMissingKey = ''

async function renderMissingBanner() {
  const bar = $('missingBanner')
  if (!bar) return
  let data = null
  try {
    data = await api('/api/game/missing')
  } catch (e) {
    return
  }
  const rec = (data.items || []).find((x) => x.key === selectedInstanceKey())
  if (!rec || (!rec.missing.length && !rec.conflicts.length)) {
    bar.hidden = true
    lastMissingKey = ''
    return
  }
  const miss = rec.missing || []
  const conf = rec.conflicts || []
  const autoRunning = !!rec.autoStarted
  bar.hidden = false
  bar.innerHTML = ''
  const status = document.createElement('div')
  status.className = 'missing-msg'
  let txt = ''
  if (miss.length) txt += t('mods.missingDetected', { list: miss.join(', ') })
  if (conf.length) txt += (txt ? ' · ' : '') + t('mods.conflictDetected', { list: conf.join(', ') })
  if (autoRunning) txt += ' — ' + t('mods.autoFixing')
  status.textContent = txt
  bar.appendChild(status)
  if (miss.length && !autoRunning) {
    const btn = document.createElement('button')
    btn.className = 'btn missing-btn'
    btn.innerHTML = '<i class="fa-solid fa-download"></i> ' + t('mods.fixNow')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        const res = await api('/api/mods/fix-missing', { method: 'POST', body: JSON.stringify({ instanceId: rec.key }) })
        state.activeJobId = res.jobId
      } catch (e) {
        btn.disabled = false
        toast(e.message, 'error')
      }
    })
    bar.appendChild(btn)
  }
}

async function uploadLogs() {
  const btn = $('uploadLogsBtn')
  if (btn) btn.disabled = true
  try {
    const r = await api('/api/logs/upload', { method: 'POST' })
    window.open(r.url, '_blank')
    toast(t('home.logUploaded', { url: r.url }), 'success', 5000)
  } catch (e) {
    toast(t('home.logUploadFail', { msg: e.message }), 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

async function copyLogs() {
  const text = Array.from(document.querySelectorAll('#console .console-line')).map((d) => d.textContent).join('\n')
  if (!text.trim()) return
  try {
    await navigator.clipboard.writeText(text)
    toast(t('home.logCopied'), 'success')
  } catch (e) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      toast(t('home.logCopied'), 'success')
    } catch (e2) {
      toast(t('home.logCopyFail'), 'error')
    }
  }
}

async function refreshInstances() {
  try {
    state.instances = await api('/api/instances')
    renderInstanceSelect()
    renderVersionsTab()
    renderInstancesManage()
    populateDataInstanceSelect()
  } catch (e) {}
}

async function addOffline() {
  const name = $('offlineName').value.trim()
  if (!name) return toast(t('accounts.typeName'), 'error')
  try {
    await api('/api/accounts/offline', { method: 'POST', body: JSON.stringify({ name }) })
    $('offlineName').value = ''
    await loadInitial()
    toast(t('accounts.addedName', { name }), 'success')
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function msLogin() {
  try {
    const res = await api('/api/accounts/ms/start', { method: 'POST' })
    $('msBox').hidden = false
    $('msCode').textContent = res.userCode
    $('msLink').href = res.verificationUri || 'https://microsoft.com/link'
    $('msProgress').style.animation = 'indet 1.2s infinite'
    state.activeJobId = res.jobId
    window.open($('msLink').href, '_blank')
    toast(t('accounts.enterCode'))
  } catch (e) {
    toast(e.message, 'error')
  }
}

function modType() {
  const el = document.querySelector('#modTypeSeg button.active')
  return (el && el.dataset.type) || 'mod'
}

const MOD_TYPE_KEYS = {
  mod: { open: 'mods.openFolder', head: 'mods.installedHead', count: 'mods.installedCount', folder: 'mods' },
  shader: { open: 'mods.openShaders', head: 'mods.installedShaders', count: 'mods.installedCount', folder: 'shaderpacks' },
  resourcepack: { open: 'mods.openRes', head: 'mods.installedRes', count: 'mods.installedCount', folder: 'resourcepacks' },
  world: { open: 'mods.openWorlds', head: 'mods.installedWorlds', count: 'mods.installedCount', folder: 'saves' },
  modpack: { open: 'mods.openPacks', head: 'mods.installedPacks', count: 'mods.installedCount', folder: 'mods' }
}

function renderModsTypeUI() {
  const type = modType()
  const k = MOD_TYPE_KEYS[type] || MOD_TYPE_KEYS.mod
  const lbl = $('modsOpenLabel')
  const head = $('modsInstalledHead')
  if (lbl) lbl.textContent = t(k.open)
  if (head) head.textContent = t(k.head)
  const openBtn = $('modsOpenBtn')
  if (openBtn) openBtn.hidden = type === 'modpack'
  const versionField = $('modVersionField')
  if (versionField) versionField.style.display = type === 'modpack' ? '' : ''
  const loaderField = $('modLoaderField')
  if (loaderField) loaderField.style.display = type === 'mod' || type === 'modpack' ? '' : 'none'
  const packLocalBtn = $('modPackLocalBtn')
  if (packLocalBtn) packLocalBtn.hidden = type !== 'modpack'
  const packHint = $('modPackTargetHint')
  if (packHint) packHint.hidden = type !== 'modpack'
  const source = $('modSourceSelect')
  if (source) {
    const prev = source.value
    source.innerHTML = ''
    if (type === 'world' || type === 'modpack') {
      if (type === 'modpack') {
        source.appendChild(new Option(t('mods.allSources'), 'all'))
        source.appendChild(new Option('Modrinth', 'modrinth'))
        source.appendChild(new Option('CurseForge', 'curseforge'))
      } else {
        source.appendChild(new Option(t('mods.sourceOnly', { name: 'CurseForge' }), 'curseforge'))
      }
    } else {
      source.appendChild(new Option(t('mods.allSources'), 'all'))
      source.appendChild(new Option('Modrinth', 'modrinth'))
      source.appendChild(new Option('CurseForge', 'curseforge'))
    }
    if (Array.from(source.options).some((o) => o.value === prev)) source.value = prev
  }
  const instHead = $('modsInstalledHeadBox')
  if (instHead) instHead.style.display = ''
  const instList = $('modsInstalled')
  if (instList) instList.style.display = ''
}

function setModType(type) {
  document.querySelectorAll('#modTypeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.type === type))
  state.mods.type = type
  state.mods.showPack = false
  state.mods.showManual = true
  renderModsTypeUI()
  populateModVersionSelect()
  refreshModsInstalled()
  runModsSearch(1)
}

function modsInstanceKey() {
  const v = $('modVersionSelect').value
  const l = $('modLoaderSelect').value
  return v + (l ? '-' + l : '')
}

function syncHomeInstance() {
  const key = modsInstanceKey()
  const sel = $('instanceSelect')
  if (!sel || !key || !state.instances || !state.instances[key]) return
  if (Array.from(sel.options).some((o) => o.value === key)) {
    sel.value = key
    onInstanceChange()
  }
}

function modsFilter() {
  const type = modType()
  return {
    version: $('modVersionSelect').value,
    loader: type === 'mod' || type === 'modpack' ? $('modLoaderSelect').value : '',
    source: $('modSourceSelect').value,
    type
  }
}

function populateModVersionSelect() {
  const sel = $('modVersionSelect')
  const inst = state.instances[selectedInstanceKey()]
  const cur = sel.value || (inst && inst.versionId)
  sel.innerHTML = ''
  const ids = [...new Set(state.versions.filter((v) => isInstalledAny(v.id)).map((v) => v.id))]
  const sortSemver = (a, b) => {
    const na = a.split('.').map(Number)
    const nb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const da = na[i] || 0
      const db = nb[i] || 0
      if (da !== db) return db - da
    }
    return b.localeCompare(a)
  }
  ids.sort(sortSemver)
  sel.appendChild(new Option(t('mods.allVersions'), ''))
  for (const id of ids) sel.appendChild(new Option(id, id))
  if (cur && ids.includes(cur)) sel.value = cur
  else if (ids.length) sel.value = ids[0]
}

async function modsTabOpen() {
  await refreshInstances()
  populateModVersionSelect()
  if (state.loader === 'fabric' || state.loader === 'forge') $('modLoaderSelect').value = state.loader
  renderModsTypeUI()
  await refreshModsInstalled()
  runModsSearch()
}

async function refreshModsInstalled() {
  try {
    state.instances = await api('/api/instances')
    if (modType() === 'modpack') {
      renderInstalledPacks()
      return
    }
    const key = modsInstanceKey()
    const files = await api('/api/mods/installed?instance=' + encodeURIComponent(key) + '&type=' + encodeURIComponent(modType()))
    state.mods.installed = files
    const folder = (MOD_TYPE_KEYS[modType()] || MOD_TYPE_KEYS.mod).folder
    $('modsInstalledPath').textContent = key ? `data\\game\\${key}\\${folder}` : ''
    renderModsInstalled()
  } catch (e) {}
}

function packsOf(inst) {
  if (inst && Array.isArray(inst.packs) && inst.packs.length) return inst.packs
  if (inst && inst.pack) return [inst.pack]
  return []
}

function packTagHtml(inst) {
  const pks = packsOf(inst)
  if (!pks.length) return ''
  const label = pks.length > 1 ? (pks[0].name ? pks[0].name + ' +' + (pks.length - 1) : pks.length + ' packs') : (pks[0].name || '')
  return label ? ' <span class="tag pack">' + escapeHtml(label) + '</span>' : ''
}

function renderInstalledPacks() {
  const box = $('modsInstalled')
  const toggle = $('modsInstalledToggle')
  const showPacksBtn = $('modsShowPacksBtn')
  const showManualBtn = $('modsShowManualBtn')
  const instPath = $('modsInstalledPath')
  if (toggle) toggle.hidden = true
  if (showPacksBtn) showPacksBtn.hidden = true
  if (showManualBtn) showManualBtn.hidden = true
  if (instPath) instPath.textContent = ''
  const packs = []
  for (const [key, inst] of Object.entries(state.instances || {})) {
    for (const pack of packsOf(inst)) packs.push({ key, pack })
  }
  if (!packs.length) {
    box.innerHTML = '<div class="vrow muted">' + t('mods.noInstalledFor', { name: t('mods.typePack') }) + '</div>'
    return
  }
  box.innerHTML = ''
  for (const { key, pack } of packs) {
    const nFiles = Array.isArray(pack.files) ? pack.files.length : 0
    const div = document.createElement('div')
    div.className = 'mfile'
    div.innerHTML = `
      <div class="mfile-icon">${pack.icon ? '<img src="' + escapeHtml(pack.icon) + '" alt="" style="width:36px;height:36px;border-radius:8px;object-fit:cover">' : '<i class="fa-solid fa-box-archive"></i>'}</div>
      <div class="mfile-info">
        <div class="mfile-name">${escapeHtml(pack.name || key)}</div>
        <div class="mfile-sub">${escapeHtml(key)} · ${escapeHtml(pack.source || '')} ${nFiles ? '· ' + t('mods.packFiles', { n: nFiles }) : ''} <span class="tag installed">${t('mods.installedTag')}</span></div>
      </div>
      <button class="icon-btn" title="${t('mods.packRemoveTitle')}"><i class="fa-solid fa-trash"></i></button>`
    div.querySelector('.icon-btn').addEventListener('click', async () => {
      if (!confirm(t('mods.packRemoveConfirm', { name: pack.name || key, key }))) return
      try {
        const r = await api('/api/mods/pack-remove', { method: 'POST', body: JSON.stringify({ instanceId: key, packId: pack.id }) })
        toast(t('mods.packRemoved', { n: r.removed || 0 }), 'success')
        await refreshModsInstalled()
      } catch (e) {
        toast(e.message, 'error')
      }
    })
    box.appendChild(div)
  }
}

function renderModsInstalled() {
  const box = $('modsInstalled')
  const folder = (MOD_TYPE_KEYS[modType()] || MOD_TYPE_KEYS.mod).folder
  const key = modsInstanceKey()
  const inst = state.instances && state.instances[key]
  const packs = packsOf(inst)
  const filePack = new Map()
  for (const p of packs) {
    for (const f of (p && p.files || [])) {
      const k = String(f || '').replace(/\\/g, '/').toLowerCase()
      if (!filePack.has(k)) filePack.set(k, p.name || '')
    }
  }
  const all = state.mods.installed || []
  const isPackOf = (m) => !!filePack.get((folder + '/' + m.file).toLowerCase())
  const hasPack = all.some(isPackOf)
  const hasManual = all.some((m) => !isPackOf(m))
  const toggle = $('modsInstalledToggle')
  const toggleLabel = $('modsInstalledToggleLabel')
  const showPacksBtn = $('modsShowPacksBtn')
  const showManualBtn = $('modsShowManualBtn')
  const instPath = $('modsInstalledPath')
  if (toggle) toggle.hidden = false
  if (toggle) toggle.classList.toggle('active', !!state.mods.showInstalled)
  if (toggleLabel) toggleLabel.textContent = state.mods.showInstalled ? t('mods.hideInstalled') : t('mods.showInstalled')
  if (instPath) instPath.textContent = state.mods.showInstalled ? (key ? `data\\game\\${key}\\${folder}` : '') : ''
  if (showPacksBtn) showPacksBtn.hidden = !state.mods.showInstalled || !hasPack
  if (showManualBtn) showManualBtn.hidden = !state.mods.showInstalled || !hasManual
  if (showPacksBtn) showPacksBtn.classList.toggle('active', !!state.mods.showPack)
  if (showManualBtn) showManualBtn.classList.toggle('active', !!state.mods.showManual)
  if (!state.mods.showInstalled) {
    box.innerHTML = ''
    return
  }
  let list = all
  if (!state.mods.showPack && state.mods.showManual) list = all.filter((m) => !isPackOf(m))
  else if (state.mods.showPack && !state.mods.showManual) list = all.filter(isPackOf)
  else if (!state.mods.showPack && !state.mods.showManual) list = []
  if (!list.length) {
    const typeName = { mod: 'mods.typeMod', shader: 'mods.typeShader', resourcepack: 'mods.typeRes', world: 'mods.typeWorld' }[modType()] || 'mods.typeMod'
    box.innerHTML = '<div class="vrow muted">' + t('mods.noInstalledFor', { name: t(typeName) }) + '</div>'
    return
  }
  box.innerHTML = ''
  const total = list.reduce((s, m) => s + (m.size || 0), 0)
  const head = document.createElement('div')
  head.className = 'mods-installed-count muted'
  head.textContent = t('mods.installedCount', { n: list.length, size: (total / 1048576).toFixed(1) })
  box.appendChild(head)
  const isWorld = modType() === 'world'
  for (const m of list) {
    const fromPack = filePack.get((folder + '/' + m.file).toLowerCase()) || ''
    const div = document.createElement('div')
    div.className = 'mfile'
    div.innerHTML = `
      <div class="mfile-icon">${m.icon ? `<img src="${escapeHtml(m.icon)}" alt="" loading="lazy">` : `<i class="${isWorld ? 'fa-solid fa-earth-americas' : modType() === 'shader' ? 'fa-solid fa-wand-magic-sparkles' : modType() === 'resourcepack' ? 'fa-solid fa-palette' : 'fa-solid fa-cube'}"></i>`}</div>
      <div class="mfile-info">
        <div class="mfile-name">${escapeHtml(m.title || m.file)}</div>
        <div class="mfile-sub">${m.isDir ? t('mods.worldFolder') : (m.size / 1048576).toFixed(2) + ' MB'} · ${new Date(m.modified).toLocaleDateString()} ${fromPack ? '<span class="tag pack">' + t('mods.fromPack', { name: fromPack }) + '</span>' : '<span class="tag installed">' + t('mods.installedTag') + '</span>'}</div>
      </div>
      <button class="icon-btn" title="${t('mods.deleteMod')}"><i class="fa-solid fa-trash"></i></button>`
    div.querySelector('.icon-btn').addEventListener('click', async () => {
      try {
        await api('/api/mods/remove', { method: 'POST', body: JSON.stringify({ instanceId: modsInstanceKey(), file: m.file, type: modType() }) })
        toast(t('mods.deleted', { file: m.file }), 'success')
        await refreshModsInstalled()
      } catch (e) {
        toast(e.message, 'error')
      }
    })
    box.appendChild(div)
  }
}

function fmtCount(n) {
  if (!n) return '0'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

async function runModsSearch(page) {
  const f = modsFilter()
  if (state.mods.searching) return
  state.mods.searching = true
  $('modSearchBtn').disabled = true
  $('modsList').innerHTML = '<div class="vrow muted">' + t('mods.searching') + '</div>'
  const target = Math.max(1, Number(page) || 1)
  try {
    const r = await api('/api/mods/search?' + new URLSearchParams({
      q: $('modSearch').value.trim(),
      version: f.version,
      loader: f.loader,
      source: f.source,
      type: f.type,
      instance: modsInstanceKey(),
      limit: 20,
      page: target
    }))
    state.mods.results = r.items || []
    state.mods.page = r.page || target
    $('modsCount').textContent = t('mods.count', { shown: r.items.length, total: r.total || r.items.length })
    $('modsPageInfo').textContent = t('common.page', { n: state.mods.page })
    $('modsPrevPage').disabled = state.mods.page <= 1
    $('modsNextPage').disabled = !r.hasMore
    renderModsResults()
  } catch (e) {
    state.mods.results = []
    renderModsResults()
    toast(e.message, 'error')
  } finally {
    state.mods.searching = false
    $('modSearchBtn').disabled = false
  }
}

function renderModsResults() {
  const list = $('modsList')
  list.innerHTML = ''
  const items = state.mods.results
  if (!items.length) {
    list.innerHTML = '<div class="vrow muted">' + t('mods.noResults') + '</div>'
    return
  }
  for (const m of items) {
    const div = document.createElement('div')
    div.className = 'mod-card'
    div.dataset.id = m.id
    const inst = !!m.installed
    div.innerHTML = `
      <div class="mod-icon">${m.icon ? `<img src="${m.icon}" alt="">` : '<i class="fa-solid fa-cube"></i>'}</div>
      <div class="mod-body">
        <div class="mod-title-row">
          <div class="mod-title">${escapeHtml(m.title)}</div>
          <span class="mod-source ${m.source || state.mods.source}">${m.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}</span>
          ${inst ? '<span class="tag installed"><i class="fa-solid fa-circle-check"></i> ' + t('mods.installedTag') + '</span>' : ''}
        </div>
        <div class="mod-desc">${escapeHtml(m.description || '')}</div>
        <div class="mod-meta">
          <span><i class="fa-solid fa-download"></i> ${fmtCount(m.downloads)}</span>
          ${m.follows ? `<span><i class="fa-solid fa-heart"></i> ${fmtCount(m.follows)}</span>` : ''}
          ${m.loaders && m.loaders.length ? `<span>${m.loaders.map((l) => `<i class="fa-solid fa-bolt"></i> ${escapeHtml(l)}`).join(' ')}</span>` : ''}
        </div>
        <div class="mod-versions" hidden></div>
      </div>
      <div class="mod-actions">
        ${inst
          ? '<button class="btn" disabled><i class="fa-solid fa-circle-check"></i> ' + t('mods.installedTag') + '</button>'
          : `<button class="btn mod-dl" data-install="${m.id}"><i class="fa-solid fa-download"></i> ${t('common.install')}</button>`}
        <button class="ghost-btn mod-versions-btn" data-versions="${m.id}"><i class="fa-solid fa-list"></i> ${t('mods.versionsBtn')}</button>
      </div>`
    if (!inst) div.querySelector('[data-install]').addEventListener('click', () => (modType() === 'modpack' ? importModpack(m) : installMod(m.id)))
    div.querySelector('[data-versions]').addEventListener('click', (e) => toggleModVersions(m, e.currentTarget))
    list.appendChild(div)
  }
}

async function importModpack(m) {
  const btn = document.querySelector(`[data-install="${m.id}"]`)
  if (btn) {
    btn.disabled = true
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + t('common.loading')
  }
  try {
    const res = await api('/api/mods/install', {
      method: 'POST',
      body: JSON.stringify({ source: m.source || 'modrinth', id: m.id, instanceId: 'modpack', type: 'modpack', slug: m.slug, title: m.title, icon: m.icon || '', version: $('modVersionSelect').value, loader: $('modLoaderSelect').value })
    })
    state.activeJobId = res.jobId
    toast(t('mods.importingPack'))
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.innerHTML = '<i class="fa-solid fa-box-archive"></i> ' + t('common.install')
    }
  }
}

async function importLocalModpack() {
  const v = $('modVersionSelect').value
  const l = $('modLoaderSelect').value
  let filePath = null
  if (window.filePicker && typeof window.filePicker.pick === 'function') {
    try {
      filePath = await window.filePicker.pick()
    } catch (e) {}
    if (!filePath) return
  } else {
    const input = $('modPackFile')
    input.value = ''
    input.click()
    if (!input.files || !input.files.length) return
    const file = input.files[0]
    const bytes = await file.arrayBuffer()
    const res = await fetch('/api/mods/install-local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: file.name, version: v, loader: l, content: Array.from(new Uint8Array(bytes)) })
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ? tServer(data.error) : t('err.connection'))
    state.activeJobId = data.jobId
    toast(t('mods.importingPack'))
    return
  }
  const btn = $('modPackLocalBtn')
  btn.disabled = true
  try {
    const res = await api('/api/mods/install-local', {
      method: 'POST',
      body: JSON.stringify({ file: filePath, version: v, loader: l })
    })
    state.activeJobId = res.jobId
    toast(t('mods.importingPack'))
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    btn.disabled = false
  }
}

async function installMod(id) {
  const f = modsFilter()
  if (!f.version) return toast(t('mods.chooseVersion'), 'error')
  const key = modsInstanceKey()
  const m = state.mods.results.find((x) => String(x.id) === String(id))
  const src = (m && m.source) || f.source
  try {
    const res = await api('/api/mods/install', {
      method: 'POST',
      body: JSON.stringify({ source: src, id, version: f.version, loader: f.loader, instanceId: key, type: f.type, slug: m && m.slug, title: m && m.title, icon: m && m.icon })
    })
    state.activeJobId = res.jobId
    toast(t('mods.installingMod'))
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function toggleModVersions(m, btn) {
  const card = btn.closest('.mod-card')
  const box = card.querySelector('.mod-versions')
  if (!box.hidden) {
    box.hidden = true
    return
  }
  const f = modsFilter()
  const src = m.source || f.source
  box.hidden = false
  box.innerHTML = '<div class="vrow muted small">' + t('mods.loadingVersions') + '</div>'
  try {
    const list = await api('/api/mods/versions?' + new URLSearchParams({
      source: src, id: m.id, version: f.version, loader: f.loader, type: f.type
    }))
    if (!list.length) {
      box.innerHTML = '<div class="vrow muted small">' + t('mods.noCompat') + '</div>'
      return
    }
    box.innerHTML = ''
    for (const v of list.slice(0, 8)) {
      const row = document.createElement('div')
      row.className = 'vrow'
      row.style.padding = '10px 14px'
      row.innerHTML = `
        <div class="v-info">
          <div class="v-name" style="font-size:13px">${escapeHtml(v.name || v.version_number)}</div>
          <div class="v-sub">${(v.game_versions || []).slice(0, 4).join(', ')} ${v.loaders && v.loaders.length ? '· ' + v.loaders.join(', ') : ''}</div>
        </div>
        <button class="btn" style="padding:8px 14px;font-size:12.5px"><i class="fa-solid fa-download"></i> ${t('common.install')}</button>`
      row.querySelector('.btn').addEventListener('click', async (ev) => {
        ev.currentTarget.disabled = true
        try {
          const res = await api('/api/mods/install', {
            method: 'POST',
            body: JSON.stringify({
              source: src, id: m.id, version: f.version, loader: f.loader, instanceId: modsInstanceKey(), type: f.type,
              forceUrl: v.url, forceFile: v.filename, forceVersionId: v.id, fileId: v.fileId,
              slug: m.slug, title: m.title, icon: m.icon
            })
          })
          state.activeJobId = res.jobId
          toast(t('mods.installingMod'))
        } catch (e) {
          ev.currentTarget.disabled = false
          toast(e.message, 'error')
        }
      })
      box.appendChild(row)
    }
  } catch (e) {
    box.innerHTML = '<div class="vrow muted small">' + t('mods.failVersions', { msg: escapeHtml(e.message) }) + '</div>'
  }
}

function bind() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))

  $('instanceSelect').addEventListener('change', onInstanceChange)
  document.querySelectorAll('#installLoaderSeg button').forEach((b) => b.addEventListener('click', () => installSetLoader(b.dataset.loader)))
  $('installCancelBtn').addEventListener('click', () => ($('installModal').hidden = true))
  $('installModal').addEventListener('click', (e) => {
    if (e.target.id === 'installModal') $('installModal').hidden = true
  })
  $('installConfirmBtn').addEventListener('click', confirmInstall)

  $('playBtn').addEventListener('click', play)
  $('stopBtn').addEventListener('click', stopGame)
  $('cancelJobBtn').addEventListener('click', async () => {
    try {
      await api('/api/jobs/cancel', { method: 'POST' })
      toast('جاري إيقاف التحميل...')
    } catch (e) {
      toast(e.message, 'error')
    }
  })
  $('clearConsole').addEventListener('click', () => {
    $('console').innerHTML = ''
    api('/api/game/logs/clear', { method: 'POST' }).catch(() => {})
  })
  $('uploadLogsBtn').addEventListener('click', uploadLogs)
  $('copyLogsBtn').addEventListener('click', copyLogs)
  $('goToVersionsBtn').addEventListener('click', () => switchTab('versions'))
  $('manageInstancesBtn').addEventListener('click', () => switchTab('settings'))

  $('addOffline').addEventListener('click', addOffline)
  $('offlineName').addEventListener('keydown', (e) => e.key === 'Enter' && addOffline())
  $('msLoginBtn').addEventListener('click', msLogin)
  $('msCopyBtn').addEventListener('click', async () => {
    const code = $('msCode').textContent
    try {
      await navigator.clipboard.writeText(code)
      toast(t('accounts.copied'), 'success')
    } catch (e) {
      try {
        const ta = document.createElement('textarea')
        ta.value = code
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        toast(t('accounts.copied'), 'success')
      } catch (e2) {
        toast(t('accounts.copyFail'), 'error')
      }
    }
  })
  $('msLink').addEventListener('click', (e) => {
    e.preventDefault()
    window.open($('msLink').href, '_blank')
  })
  $('saveSettings').addEventListener('click', saveSettings)

  $('optionsSaveBtn').addEventListener('click', optionsSave)
  $('optionsAutoChk').addEventListener('change', (e) => optionsSetAuto(e.target.checked))
  $('optionsTargetSel').addEventListener('change', optionsSetTarget)

  $('langSetting').addEventListener('change', async (e) => {
    applyLang(e.target.value)
    await saveSettings()
  })

  $('memSetting').addEventListener('input', () => ($('memSettingVal').textContent = $('memSetting').value + ' GB'))
  $('refreshVersions').addEventListener('click', async () => {
    $('refreshVersions').disabled = true
    await loadInitial()
    $('refreshVersions').disabled = false
  })

  const offlineToggle = $('offlineModeToggle')
  offlineToggle.checked = state.config.offlineMode !== false
  offlineToggle.addEventListener('change', async () => {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ offlineMode: offlineToggle.checked }) })
  })

  const modSearchInput = $('modSearch')
  $('modSearchBtn').addEventListener('click', () => runModsSearch(1))
  modSearchInput.addEventListener('keydown', (e) => e.key === 'Enter' && runModsSearch(1))
  $('modSourceSelect').addEventListener('change', () => runModsSearch(1))
  $('modsPrevPage').addEventListener('click', () => runModsSearch(state.mods.page - 1))
  $('modsNextPage').addEventListener('click', () => runModsSearch(state.mods.page + 1))
  document.querySelectorAll('#modTypeSeg button').forEach((b) => b.addEventListener('click', () => setModType(b.dataset.type)))
  $('modUseMainBtn').addEventListener('click', () => {
    populateModVersionSelect()
    const inst = state.instances[selectedInstanceKey()]
    if (inst) {
      $('modVersionSelect').value = inst.versionId
      $('modLoaderSelect').value = inst.loader || ''
    } else {
      $('modLoaderSelect').value = ''
    }
    refreshModsInstalled()
    runModsSearch(1)
    toast(t('mods.appliedHome'), 'success')
  })
  $('modVersionSelect').addEventListener('change', () => { syncHomeInstance(); refreshModsInstalled() })
  $('modLoaderSelect').addEventListener('change', () => { syncHomeInstance(); refreshModsInstalled() })
  $('modsInstalledToggle').addEventListener('click', () => {
    state.mods.showInstalled = !state.mods.showInstalled
    renderModsInstalled()
  })
  $('modsShowPacksBtn').addEventListener('click', () => {
    state.mods.showPack = !state.mods.showPack
    renderModsInstalled()
  })
  $('modsShowManualBtn').addEventListener('click', () => {
    state.mods.showManual = !state.mods.showManual
    renderModsInstalled()
  })
  $('modsOpenBtn').addEventListener('click', async () => {
    try {
      await api('/api/mods/open', { method: 'POST', body: JSON.stringify({ instanceId: modsInstanceKey(), type: modType() }) })
    } catch (e) {
      toast(e.message, 'error')
    }
  })
  $('modsRefreshBtn').addEventListener('click', async () => {
    await refreshModsInstalled()
    runModsSearch()
  })
  $('modPackLocalBtn').addEventListener('click', importLocalModpack)
  $('modPackFile').addEventListener('change', importLocalModpack)

  $('skinSearchBtn').addEventListener('click', () => loadSkins(1))
  $('skinSearch').addEventListener('keydown', (e) => e.key === 'Enter' && loadSkins(1))
  $('skinLatestBtn').addEventListener('click', () => {
    $('skinSearch').value = ''
    loadSkins(1)
  })
  $('skinFavBtn').addEventListener('click', toggleFavOnly)
  $('skinPrevPage').addEventListener('click', () => loadSkins(Math.max(1, state.skins.page - 1)))
  $('skinNextPage').addEventListener('click', () => loadSkins(state.skins.page + 1))
  $('skinAccountSelect').addEventListener('change', renderSkinsCurrent)
  $('skinsRemoveBtn').addEventListener('click', removeCurrentSkin)
  $('skinsElyBtn').addEventListener('click', uploadToElyby)
  $('testElyby').addEventListener('click', testElyby)
  $('skinsUseMainBtn').addEventListener('click', () => {
    populateSkinAccountSelect()
    toast(t('skins.appliedHome'), 'success')
  })

  const dataInstSel = $('dataInstanceSelect')
  if (dataInstSel) {
    dataInstSel.addEventListener('change', async () => {
      state.data.instance = dataInstSel.value
      renderOptionsUI()
      await Promise.all([loadScreenshots(), loadBackups()])
    })
  }
  $('shotsRefreshBtn').addEventListener('click', loadScreenshots)
  $('shotsOpenBtn').addEventListener('click', openShots)
  $('backupCreateBtn').addEventListener('click', createBackup)

  $('serversRefreshBtn').addEventListener('click', loadServers)
  $('serversAddBtn').addEventListener('click', () => {
    $('addServerName').value = ''
    $('addServerIp').value = ''
    $('addServerModal').hidden = false
  })
  $('addServerCancelBtn').addEventListener('click', () => ($('addServerModal').hidden = true))
  $('addServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'addServerModal') $('addServerModal').hidden = true
  })
  $('addServerConfirmBtn').addEventListener('click', addServerFromForm)
  $('addServerIp').addEventListener('keydown', (e) => e.key === 'Enter' && addServerFromForm())

  $('serversBrowseBtn').addEventListener('click', openServerBrowse)
  $('browseServerCancelBtn').addEventListener('click', () => ($('browseServerModal').hidden = true))
  $('browseServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'browseServerModal') $('browseServerModal').hidden = true
  })
  let browseTimer = null
  $('browseServerSearch').addEventListener('input', (e) => {
    clearTimeout(browseTimer)
    const v = e.target.value
    browseTimer = setTimeout(() => {
      browseQuery = v
      browsePage = 1
      renderBrowseServers()
    }, 250)
  })
}

function setupUpdaterUI() {
  const bar = $('updateBar')
  const text = $('updateText')
  const btn = $('updateBtn')
  if (!bar || !text || !btn || !window.updater) return
  window.updater.on((data) => {
    if (data.status === 'available') {
      bar.hidden = false
      text.textContent = t('update.available', { version: data.version })
      btn.hidden = false
      btn.textContent = t('update.download')
      btn.onclick = () => window.updater.download()
    } else if (data.status === 'downloading') {
      bar.hidden = false
      text.textContent = t('update.downloading', { pct: data.pct })
      btn.hidden = true
    } else if (data.status === 'downloaded') {
      bar.hidden = false
      text.textContent = t('update.ready') + ' v' + data.version
      btn.hidden = false
      btn.textContent = t('update.install')
      btn.onclick = () => window.updater.install()
    } else if (data.status === 'error') {
      bar.hidden = true
    }
  })
}

async function init() {
  bind()
  await loadInitial()
  setPlayButton(false, false)
  const style = document.createElement('style')
  style.textContent = '@keyframes indet { 0% { width: 15%; } 50% { width: 65%; } 100% { width: 15%; } }'
  document.head.appendChild(style)
  setInterval(tick, 900)
  setupUpdaterUI()
}

init()
