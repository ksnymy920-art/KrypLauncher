const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const cfg = require('./config')

class W {
  constructor() {
    this.chunks = []
  }
  u8(v) {
    this.chunks.push(Buffer.from([v & 0xff]))
  }
  u16(v) {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(v & 0xffff)
    this.chunks.push(b)
  }
  u32(v) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v >>> 0)
    this.chunks.push(b)
  }
  str(s) {
    const b = Buffer.from(String(s == null ? '' : s), 'utf8')
    this.u16(b.length)
    this.chunks.push(b)
  }
  end() {
    return Buffer.concat(this.chunks)
  }
}

function readString(buf, off) {
  const len = buf.readUInt16BE(off.pos)
  off.pos += 2
  const s = buf.slice(off.pos, off.pos + len).toString('utf8')
  off.pos += len
  return s
}

function readPayload(buf, off, type) {
  switch (type) {
    case 1: { const v = buf.readInt8(off.pos); off.pos += 1; return v }
    case 2: { const v = buf.readInt16BE(off.pos); off.pos += 2; return v }
    case 3: { const v = buf.readInt32BE(off.pos); off.pos += 4; return v }
    case 4: { const v = buf.readBigInt64BE(off.pos); off.pos += 8; return v }
    case 5: { const v = buf.readFloatBE(off.pos); off.pos += 4; return v }
    case 6: { const v = buf.readDoubleBE(off.pos); off.pos += 8; return v }
    case 7: {
      const len = buf.readInt32BE(off.pos); off.pos += 4
      const v = buf.slice(off.pos, off.pos + len); off.pos += len
      return v
    }
    case 8: return readString(buf, off)
    case 9: {
      const elemType = buf.readUInt8(off.pos); off.pos += 1
      const len = buf.readInt32BE(off.pos); off.pos += 4
      const items = []
      for (let i = 0; i < len; i++) items.push(readPayload(buf, off, elemType))
      return { elemType, items }
    }
    case 10: {
      const fields = {}
      while (true) {
        const t = buf.readUInt8(off.pos); off.pos += 1
        if (t === 0) break
        const name = readString(buf, off)
        fields[name] = readPayload(buf, off, t)
      }
      return fields
    }
    case 11: {
      const len = buf.readInt32BE(off.pos); off.pos += 4
      const arr = []
      for (let i = 0; i < len; i++) { arr.push(buf.readInt32BE(off.pos)); off.pos += 4 }
      return arr
    }
    case 12: {
      const len = buf.readInt32BE(off.pos); off.pos += 4
      const arr = []
      for (let i = 0; i < len; i++) { arr.push(buf.readBigInt64BE(off.pos)); off.pos += 8 }
      return arr
    }
    default: throw new Error('Unknown NBT type ' + type)
  }
}

function readNbt(buf) {
  const off = { pos: 0 }
  const rootType = buf.readUInt8(off.pos); off.pos += 1
  const rootName = readString(buf, off)
  const value = readPayload(buf, off, rootType)
  return { type: rootType, name: rootName, value }
}

function parseServers(tree) {
  const root = tree && tree.value
  if (!root || typeof root !== 'object') return []
  const list = root.servers
  if (!list || list.elemType !== 10 || !Array.isArray(list.items)) return []
  return list.items.map((fields) => ({
    name: typeof fields.name === 'string' ? fields.name : '',
    ip: typeof fields.ip === 'string' ? fields.ip : '',
    icon: typeof fields.icon === 'string' ? fields.icon : '',
    hidden: fields.hidden === undefined ? 0 : Number(fields.hidden),
    acceptsTextures: fields.acceptTextures === undefined ? (fields.acceptsTextures === undefined ? 0 : Number(fields.acceptsTextures)) : Number(fields.acceptTextures),
    hideAddress: fields.hideAddress === undefined ? 0 : Number(fields.hideAddress)
  }))
}

function serversDatPath(gameDir) {
  return path.join(gameDir, 'servers.dat')
}

function readServersDat(gameDir) {
  const file = serversDatPath(gameDir)
  if (!fs.existsSync(file)) return []
  try {
    const raw = fs.readFileSync(file)
    let bytes = raw
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      bytes = zlib.gunzipSync(raw)
    }
    return parseServers(readNbt(bytes))
  } catch (e) {
    return []
  }
}

function writeServersDat(gameDir, entries) {
  const w = new W()
  w.u8(10); w.u16(0)
  w.u8(9); w.str('servers')
  w.u8(10); w.u32(entries.length)
  for (const e of entries) {
    w.u8(8); w.str('name'); w.str(e.name)
    w.u8(8); w.str('ip'); w.str(e.ip)
    if (e.icon) { w.u8(8); w.str('icon'); w.str(e.icon) }
    w.u8(1); w.str('hidden'); w.u8(e.hidden ? 1 : 0)
    w.u8(0)
  }
  w.u8(0)
  fs.mkdirSync(gameDir, { recursive: true })
  fs.writeFileSync(serversDatPath(gameDir), w.end())
  rev++
}

function parseAddress(addr) {
  const s = String(addr || '').trim()
  if (!s) return null
  const m6 = s.match(/^\[(.+)\]:(\d{1,5})$/)
  if (m6) return { host: '[' + m6[1] + ']', port: parseInt(m6[2], 10) }
  const m = s.match(/^(.+):(\d{1,5})$/)
  if (m && /^\d+$/.test(m[2])) return { host: m[1], port: parseInt(m[2], 10) }
  return { host: s, port: 25565 }
}

function keyOf(addr) {
  const p = parseAddress(addr)
  return p ? p.host + ':' + p.port : String(addr || '').trim()
}

function displayIp(addr) {
  const p = parseAddress(addr)
  if (!p) return String(addr || '')
  return p.port === 25565 ? p.host : p.host + ':' + p.port
}

function addServerToDat(gameDir, { name, ip, port, icon }) {
  const entries = readServersDat(gameDir)
  const p = parseAddress(ip)
  const host = p ? p.host : String(ip || '').trim()
  const prt = port || (p ? p.port : 25565)
  const fullIp = prt === 25565 ? host : host + ':' + prt
  const found = entries.some((e) => {
    const ep = parseAddress(e.ip)
    return (ep ? ep.host : e.ip) === host && (ep ? ep.port : 25565) === prt
  })
  if (!found) {
    entries.push({ name: name || host, ip: fullIp, icon: icon || '', acceptsTextures: 1, hideAddress: 1 })
    writeServersDat(gameDir, entries)
  }
  return fullIp
}

function removeFromDat(gameDir, ip) {
  const entries = readServersDat(gameDir)
  const tp = parseAddress(ip)
  const targetHost = tp ? tp.host : String(ip || '').trim()
  const targetPort = tp ? tp.port : 25565
  const next = entries.filter((e) => {
    const ep = parseAddress(e.ip)
    const host = ep ? ep.host : String(e.ip || '').trim()
    const prt = ep ? ep.port : 25565
    return !(host === targetHost && prt === targetPort)
  })
  if (next.length !== entries.length) writeServersDat(gameDir, next)
}

function statsFile() {
  return path.join(cfg.paths().data, 'serverstats.json')
}

let rev = 0

function getRev() {
  return rev
}

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(statsFile(), 'utf8'))
  } catch (e) {
    return {}
  }
}

function saveStats(stats) {
  fs.mkdirSync(cfg.paths().data, { recursive: true })
  fs.writeFileSync(statsFile(), JSON.stringify(stats, null, 2))
  rev++
}

function writeStatsFile(stats) {
  fs.mkdirSync(cfg.paths().data, { recursive: true })
  fs.writeFileSync(statsFile(), JSON.stringify(stats, null, 2))
}

function trackPlay(addr, opts = {}) {
  const key = keyOf(addr)
  if (!key) return null
  const stats = loadStats()
  const rec = stats[key] || {}
  rec.plays = (rec.plays || 0) + 1
  rec.lastPlayed = Date.now()
  if (opts.name) rec.name = opts.name
  if (!rec.name) rec.name = opts.name || (parseAddress(addr) || {}).host || key
  stats[key] = rec
  saveStats(stats)
  return key
}

function ensureServer(addr, opts = {}) {
  const key = keyOf(addr)
  if (!key) return null
  const stats = loadStats()
  const rec = stats[key] || {}
  if (opts.name) rec.name = opts.name
  if (!rec.name) rec.name = opts.name || (parseAddress(addr) || {}).host || key
  stats[key] = rec
  saveStats(stats)
  return key
}

function setIcon(addr, base64) {
  const key = keyOf(addr)
  if (!key || !base64) return
  const stats = loadStats()
  const rec = stats[key] || {}
  rec.icon = base64
  stats[key] = rec
  writeStatsFile(stats)
}

function setServerVersion(addr, v) {
  const key = keyOf(addr)
  if (!key) return
  const stats = loadStats()
  const rec = stats[key] || {}
  if (v.versionId) rec.versionId = v.versionId
  if (v.loader !== undefined) rec.loader = v.loader
  if (v.loaderVersion !== undefined) rec.loaderVersion = v.loaderVersion
  stats[key] = rec
  saveStats(stats)
}

function removeServer(addr) {
  const key = keyOf(addr)
  if (!key) return
  const stats = loadStats()
  delete stats[key]
  saveStats(stats)
}

function listServers(gameDir) {
  const dat = readServersDat(gameDir)
  const stats = loadStats()
  const map = {}
  for (const d of dat) {
    const key = keyOf(d.ip)
    if (!key) continue
    const p = parseAddress(d.ip)
    map[key] = {
      name: d.name || displayIp(d.ip),
      ip: p ? p.host : d.ip,
      port: p ? p.port : 25565,
      icon: d.icon || '',
      inDat: true,
      plays: 0,
      lastPlayed: null,
      versionId: '',
      loader: '',
      loaderVersion: ''
    }
  }
  for (const key of Object.keys(stats)) {
    const st = stats[key]
    const p = parseAddress(key)
    if (!map[key]) {
      map[key] = {
        name: st.name || key,
        ip: p ? p.host : key,
        port: p ? p.port : 25565,
        icon: st.icon || '',
        inDat: false,
        plays: 0,
        lastPlayed: null,
        versionId: '',
        loader: '',
        loaderVersion: ''
      }
    }
    Object.assign(map[key], {
      name: st.name || map[key].name,
      icon: st.icon || map[key].icon,
      plays: st.plays || 0,
      lastPlayed: st.lastPlayed || null,
      versionId: st.versionId || '',
      loader: st.loader || '',
      loaderVersion: st.loaderVersion || ''
    })
  }
  const arr = Object.values(map)
  arr.sort((a, b) => (b.plays - a.plays) || ((b.lastPlayed || 0) - (a.lastPlayed || 0)))
  return arr
}

module.exports = {
  readServersDat,
  writeServersDat,
  addServerToDat,
  removeFromDat,
  parseAddress,
  keyOf,
  displayIp,
  loadStats,
  saveStats,
  trackPlay,
  ensureServer,
  setIcon,
  setServerVersion,
  removeServer,
  listServers,
  getRev
}
