const fs = require('fs')
const path = require('path')

function detectDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
  if (process.pkg) return path.join(path.dirname(process.execPath), 'data')
  if (process.versions && process.versions.electron) {
    try {
      const { app } = require('electron')
      return app.getPath('userData')
    } catch (e) {}
  }
  return path.join(__dirname, '..', 'data')
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
    if (fs.existsSync(file)) {
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
      c.accounts = disk.accounts || c.accounts
      c.settings = Object.assign(c.settings, disk.settings)
      c.instances = Object.assign(disk.instances || {}, c.instances)
    }
  } catch (e) {}
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(c, null, 2))
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
