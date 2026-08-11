const fs = require('fs')
const os = require('os')
const path = require('path')

function detectDataDir() {
  let dir = null
  if (process.versions && process.versions.electron) {
    try {
      const { app } = require('electron')
      dir = app.getPath('userData')
    } catch (e) {}
  }
  if (!dir && process.env.APPDATA) dir = path.join(process.env.APPDATA, 'OmniLauncher')
  if (!dir && process.env.LOCALAPPDATA) dir = path.join(process.env.LOCALAPPDATA, 'OmniLauncher')
  if (!dir && os.homedir) dir = path.join(os.homedir(), 'OmniLauncherData')
  if (!dir) dir = path.join(__dirname, '..', 'data')
  migrateLegacy(dir)
  return dir
}

function migrateLegacy(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'config.json'))) return
    let legacy = null
    if (process.env.PORTABLE_EXECUTABLE_DIR) legacy = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
    else if (process.pkg) legacy = path.join(path.dirname(process.execPath), 'data')
    else legacy = path.join(__dirname, '..', 'data')
    if (!legacy || path.resolve(legacy) === path.resolve(dir) || !fs.existsSync(path.join(legacy, 'config.json'))) return
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    try {
      fs.renameSync(legacy, dir)
    } catch (e2) {
      fs.cpSync(legacy, dir, { recursive: true })
    }
  } catch (e) {}
}

let DATA_DIR = detectDataDir()

let cache = null

function paths() {
  return {
    data: DATA_DIR,
    java: path.join(DATA_DIR, 'java'),
    versions: path.join(DATA_DIR, 'versions'),
    libraries: path.join(DATA_DIR, 'libraries'),
    assets: path.join(DATA_DIR, 'assets'),
    natives: path.join(DATA_DIR, 'natives'),
    game: path.join(DATA_DIR, 'game'),
    tmp: path.join(DATA_DIR, 'tmp')
  }
}

function defaults() {
  return {
    accounts: [],
    settings: {
      memory: 2048,
      lang: 'en',
      java: 'auto',
      jvmArgs: '',
      width: 0,
      height: 0,
      clientId: 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb',
      curseforgeKey: '',
      elybyEmail: '',
      elybyPassword: '',
      elybyUuid: '',
      elybyName: ''
    },
    controls: {
      auto: false,
      target: '',
      active: '',
      profiles: []
    },
    instances: {}
  }
}

function load() {
  if (cache) return cache
  const file = path.join(DATA_DIR, 'config.json')
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      cache = Object.assign(defaults(), raw)
      cache.settings = Object.assign(defaults().settings, raw.settings || {})
      cache.controls = Object.assign({ auto: false, target: '', active: '', profiles: [] }, raw.controls || {})
      cache.accounts = raw.accounts || []
      cache.instances = raw.instances || {}
    } catch (e) {
      cache = defaults()
    }
  } else {
    cache = defaults()
  }
  return cache
}

function save() {
  const c = load()
  try {
    const file = path.join(DATA_DIR, 'config.json')
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(c, null, 2))
  } catch (e) {}
}

function instanceKey(versionId, loader) {
  return loader ? `${versionId}-${loader}` : versionId
}

function getInstance(key) {
  return load().instances[key] || null
}

function setInstance(key, value) {
  load().instances[key] = value
  save()
}

function getAccount(id) {
  return load().accounts.find((a) => a.id === id) || null
}

module.exports = { paths, load, save, instanceKey, getInstance, setInstance, getAccount }
