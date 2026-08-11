const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const AdmZip = require('adm-zip')
const { spawn } = require('child_process')
const cfg = require('./config')
const mojang = require('./mojang')
const { getJSON, getText, downloadWithRetry } = require('./download')

const PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/'
const BOOTSTRAP_MAIN = 'cpw.mods.bootstraplauncher.BootstrapLauncher'
const MODLAUNCHER_MAIN = 'cpw.mods.modlauncher.Launcher'

let mavenVersionsCache = null
let mavenVersionsAt = 0

async function getMavenVersions() {
  const now = Date.now()
  if (mavenVersionsCache && now - mavenVersionsAt < 600000) return mavenVersionsCache
  try {
    const xml = await getText(MAVEN + 'maven-metadata.xml')
    const out = []
    const re = /<version>([^<]+)<\/version>/g
    let m
    while ((m = re.exec(xml))) out.push(m[1])
    mavenVersionsCache = out
    mavenVersionsAt = now
  } catch (e) {
    mavenVersionsCache = mavenVersionsCache || []
  }
  return mavenVersionsCache
}

async function resolveMavenVersion(mc, forge) {
  const base = `${mc}-${forge}`
  const vs = await getMavenVersions()
  if (!vs.length) return base
  if (vs.includes(base)) return base
  const prefixed = vs.filter((v) => v.startsWith(base + '-'))
  if (prefixed.length) return prefixed.find((v) => v === base + '-' + mc) || prefixed[0]
  return base
}

function needsClientJar(json) {
  const m = json && json.mainClass
  if (!m) return false
  const s = String(m).toLowerCase()
  return s.includes('bootstrap') || s.includes('modlauncher')
}

function findClientJar(mc, forge) {
  const P = cfg.paths()
  const rel = [`net/minecraftforge/forge/${mc}-${forge}`, `net/neoforged/forge/${mc}-${forge}`]
  for (const dir of rel) {
    let entries = []
    try {
      entries = fs.readdirSync(path.join(P.libraries, dir))
    } catch (e) {
      continue
    }
    for (const f of entries) {
      if (f.endsWith('-client.jar')) return path.join(P.libraries, dir, f)
    }
  }
  return null
}

async function versions(mc) {
  const data = await getJSON(PROMOS)
  const promos = data.promos || {}
  return {
    mc,
    recommended: promos[mc + '-recommended'] || null,
    latest: promos[mc + '-latest'] || promos[mc + '-recommended'] || null
  }
}

async function installerUrl(mc, forge) {
  const exact = await resolveMavenVersion(mc, forge)
  return `${MAVEN}${exact}/forge-${exact}-installer.jar`
}

function runInstaller(javaBin, installerJar, dataDir, onOutput, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaBin, ['-jar', installerJar, ...(extraArgs || [])], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const onData = (d) => {
      const s = d.toString()
      out += s
      if (onOutput) onOutput(s)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error('فشل تثبيت فورج (code ' + code + '): ' + out.slice(-600)))
    })
  })
}

function runInstallerGui(javaBin, installerJar, dataDir, onOutput) {
  const home = path.join(cfg.paths().tmp, `oldforge-home-${Date.now()}`)
  return new Promise((resolve, reject) => {
    const child = spawn(javaBin, ['-Duser.home=' + home, '-jar', installerJar], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APPDATA: path.dirname(home) }
    })
    let out = ''
    const onData = (d) => {
      const s = d.toString()
      out += s
      if (onOutput) onOutput(s)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('أُغلقت نافذة المثبّت قبل إكمال التثبيت (code ' + code + ')'))
      try {
        const mcDir = path.join(home, '.minecraft')
        const src = path.join(mcDir, 'versions')
        const srcLibs = path.join(mcDir, 'libraries')
        const dstVersions = path.join(dataDir, 'versions')
        const dstLibs = path.join(dataDir, 'libraries')
        if (fs.existsSync(src)) {
          fs.mkdirSync(dstVersions, { recursive: true })
          for (const e of fs.readdirSync(src)) {
            const from = path.join(src, e)
            const to = path.join(dstVersions, e)
            fs.rmSync(to, { recursive: true, force: true })
            fs.renameSync(from, to)
          }
        }
        if (fs.existsSync(srcLibs)) {
          fs.mkdirSync(dstLibs, { recursive: true })
          fs.cpSync(srcLibs, dstLibs, { recursive: true, force: true })
        }
        fs.rmSync(mcDir, { recursive: true, force: true })
        resolve(out)
      } catch (e) {
        reject(new Error('فشل نقل ملفات فورج المثبّتة: ' + e.message))
      }
    })
  })
}

function extractOldForge(installerJar, dataDir, onOutput) {
  let zip
  try {
    zip = new AdmZip(installerJar)
  } catch (e) {
    return null
  }
  const profEntry = zip.getEntry('install_profile.json')
  if (!profEntry) return null
  let profile
  try {
    profile = JSON.parse(profEntry.getData().toString('utf8'))
  } catch (e) {
    return null
  }
  const install = profile.install
  const versionInfo = profile.versionInfo
  if (!install || !install.filePath || !versionInfo || !versionInfo.id) return null
  const univEntry = zip.getEntry(install.filePath)
  if (!univEntry) return null
  const id = versionInfo.id
  const versionsDir = path.join(dataDir, 'versions', id)
  fs.mkdirSync(versionsDir, { recursive: true })
  fs.writeFileSync(path.join(versionsDir, id + '.json'), JSON.stringify(versionInfo, null, 2))
  let mavenDir = null
  if (install.path && String(install.path).includes(':')) {
    mavenDir = String(install.path).split(':').map((s, i) => (i === 0 ? s.replace(/\./g, '/') : s)).join('/')
  }
  if (!mavenDir) {
    const first = (versionInfo.libraries || []).find((l) => l.name && l.name.startsWith('net.minecraftforge:forge'))
    if (first && first.name) mavenDir = first.name.split(':').map((s, i) => (i === 0 ? s.replace(/\./g, '/') : s)).join('/')
  }
  if (mavenDir) {
    const dest = path.join(dataDir, 'libraries', mavenDir + '/' + install.filePath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, univEntry.getData())
    const coord = String(install.path || '')
    const parts = coord.split(':')
    if (parts.length >= 3) {
      const artifactName = `${parts[1]}-${parts[2]}${parts[3] ? '-' + parts[3] : ''}.jar`
      if (install.filePath !== artifactName) {
        const dest2 = path.join(dataDir, 'libraries', mavenDir + '/' + artifactName)
        fs.writeFileSync(dest2, univEntry.getData())
      }
    }
    if (onOutput) onOutput('استخرجت ملف فورج من المثبت مباشرة (بدون تشغيله)')
  }
  return { id, json: versionInfo }
}

const FML_LIBS = [
  { name: 'argo-2.25.jar', sha1: 'bb672829fde76cb163004752b86b0484bd0a7f4b', urls: ['https://repo1.maven.org/maven2/net/sourceforge/argo/argo/2.25/argo-2.25.jar', 'http://web.archive.org/web/20120906033317id_/http://files.minecraftforge.net/fmllibs/argo-2.25.jar'] },
  { name: 'guava-12.0.1.jar', sha1: 'b8e78b9af7bf45900e14c6f958486b6ca682195f', urls: ['https://repo1.maven.org/maven2/com/google/guava/guava/12.0.1/guava-12.0.1.jar'] },
  { name: 'asm-all-4.0.jar', sha1: '98308890597acb64047f7e896638e0d98753ae82', urls: ['http://web.archive.org/web/20120906033424id_/http://files.minecraftforge.net/fmllibs/asm-all-4.0.jar', 'https://repo1.maven.org/maven2/org/ow2/asm/asm-all/4.0/asm-all-4.0.jar'] },
  { name: 'bcprov-jdk15on-147.jar', sha1: 'b6f5d9926b0afbde9f4dbe3db88c5247be7794bb', urls: ['https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk15on/1.47/bcprov-jdk15on-1.47.jar', 'http://web.archive.org/web/0id_/http://files.minecraftforge.net/fmllibs/bcprov-jdk15on-147.jar'] }
]

function parseClassUtf8s(buf) {
  if (buf.length < 10 || buf.readUInt32BE(0) !== 0xcafebabe) return null
  const cpCount = buf.readUInt16BE(8)
  const utf8s = ['']
  let pos = 10
  const read = (n) => { const v = buf.slice(pos, pos + n); pos += n; return v }
  const u2 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v }
  const u4 = () => { const v = buf.readUInt32BE(pos); pos += 4; return v }
  for (let i = 1; i < cpCount; i++) {
    const tag = buf[pos++]
    if (tag === 1) {
      const len = u2()
      utf8s.push(read(len).toString('utf8'))
      continue
    }
    utf8s.push('')
    if (tag === 5 || tag === 6) {
      pos += 8
      i++
      continue
    }
    const sizes = { 3: 4, 4: 4, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2 }
    if (!(tag in sizes)) return null
    pos += sizes[tag]
  }
  return { utf8s, pos, cpCount }
}

function fmlLibsFromJar(jarPath) {
  const zip = new AdmZip(jarPath)
  const entry = zip.getEntry('cpw/mods/fml/relauncher/CoreFMLLibraries.class')
  if (!entry) return null
  const buf = entry.getData()
  const parsed = parseClassUtf8s(buf)
  if (!parsed) return null
  const { utf8s } = parsed
  let pos = parsed.pos
  const u2 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v }
  const u4 = () => { const v = buf.readUInt32BE(pos); pos += 4; return v }
  u2(); u2(); u2()
  const ifCount = u2()
  pos += ifCount * 2
  const fieldCount = u2()
  for (let i = 0; i < fieldCount; i++) {
    u2(); u2(); u2()
    const ac = u2()
    for (let j = 0; j < ac; j++) { u2(); pos += u4() }
  }
  const methodCount = u2()
  let ldcStrings = null
  for (let i = 0; i < methodCount; i++) {
    u2(); const nameIdx = u2(); u2()
    const ac = u2()
    const attrs = []
    for (let j = 0; j < ac; j++) {
      const aName = u2(); const len = u4()
      attrs.push({ name: utf8s[aName], data: buf.slice(pos, pos + len) })
      pos += len
    }
    if (utf8s[nameIdx] === 'getRootURL') {
      const code = attrs.find((a) => a.name === 'Code')
      if (code) ldcStrings = extractLdcStrings(code.data, utf8s)
    }
  }
  if (!ldcStrings) return null
  const jars = ldcStrings.filter((s) => /\.jar$/.test(s))
  const hexes = ldcStrings.filter((s) => /^[0-9a-f]{40}$/.test(s))
  if (!jars.length || jars.length !== hexes.length) return null
  return jars.map((name, i) => ({ name, sha1: hexes[i] }))
}

function extractLdcStrings(code, utf8s) {
  let p = 0
  const u2 = () => { const v = code.readUInt16BE(p); p += 2; return v }
  const u4 = () => { const v = code.readUInt32BE(p); p += 4; return v }
  u2(); u2()
  const codeLen = u4()
  const bytes = code.slice(p, p + codeLen)
  const strings = []
  let i = 0
  while (i < bytes.length) {
    const op = bytes[i++]
    if (op === 0x12) {
      strings.push(utf8s[bytes[i++]])
    } else if (op === 0x13) {
      strings.push(utf8s[bytes.readUInt16BE(i)])
      i += 2
    } else if (op === 0xaa || op === 0xab) {
      return strings
    } else {
      const n = OP_LEN[op] == null ? 0 : OP_LEN[op]
      i += n
    }
  }
  return strings
}

const OP_LEN = [
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,2,1,2,2,1,1,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  2,2,2,2,2,2,2,2,2,2,0,0,0,0,0,0,
  0,0,2,2,2,2,2,2,2,2,2,4,2,2,0,0,
  0,0,2,2,0,0,0,0,2,4,2,2,4,4,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,
  2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2
]

function sha1File(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

async function ensureFmlLibs(gameDir, jarPath, onOutput) {
  const P = cfg.paths()
  const cacheDir = path.join(P.libraries, 'fml-bootstrap')
  fs.mkdirSync(cacheDir, { recursive: true })
  const libDir = path.join(gameDir, 'lib')
  fs.mkdirSync(libDir, { recursive: true })
  let libs = null
  try {
    if (jarPath && fs.existsSync(jarPath)) libs = fmlLibsFromJar(jarPath)
  } catch (e) {}
  const list = libs && libs.length ? libs : FML_LIBS
  let done = 0
  for (const lib of list) {
    const urls = FML_LIBS.find((k) => k.name === lib.name)
      ? FML_LIBS.find((k) => k.name === lib.name).urls
      : [`http://web.archive.org/web/0id_/http://files.minecraftforge.net/fmllibs/${lib.name}`]
    const cached = path.join(cacheDir, lib.name)
    if (!fs.existsSync(cached) || sha1File(cached) !== lib.sha1) {
      await downloadWithRetry(urls, cached, { sha1: lib.sha1, tries: 4 })
    }
    const dest = path.join(libDir, lib.name)
    if (!fs.existsSync(dest) || sha1File(dest) !== lib.sha1) fs.copyFileSync(cached, dest)
    done++
    if (onOutput) onOutput(`جهّزت مكتبات FML القديمة (${done}/${list.length})`)
  }
}

async function installLegacyUniversal(mc, forge, resolved, onOutput) {
  const P = cfg.paths()
  const url = `${MAVEN}${resolved}/forge-${resolved}-universal.zip`
  const alt = url.replace('maven.minecraftforge.net', 'files.minecraftforge.net/maven')
  const zipFile = path.join(P.tmp, `forge-${mc}-${forge}-legacy-universal.zip`)
  await downloadWithRetry([url, alt], zipFile, {
    onProgress: (r, t) => onOutput && onOutput(`تحميل حزمة فورج ${mc} الكاملة ${r}/${t}`),
    tries: 5
  })
  const base = await mojang.getVersionJson(mc)
  const id = `${mc}-forge-${forge}`
  const libPath = `net/minecraftforge/forge/${resolved}/forge-${resolved}.jar`
  const libDest = path.join(P.libraries, libPath)
  fs.mkdirSync(path.dirname(libDest), { recursive: true })
  const client = base.downloads && base.downloads.client
  if (client && client.url) {
    const clientFile = path.join(P.tmp, `legacy-client-${mc}.jar`)
    await downloadWithRetry([client.url], clientFile, { sha1: client.sha1 })
    if (onOutput) onOutput('دمج كلاينت فانيلا داخل حزمة فورج...')
    const out = new AdmZip()
    const seen = new Map()
    for (const e of new AdmZip(clientFile).getEntries()) {
      if (!e.isDirectory) seen.set(e.entryName, e.getData())
    }
    for (const e of new AdmZip(zipFile).getEntries()) {
      if (!e.isDirectory) seen.set(e.entryName, e.getData())
    }
    for (const [name, data] of seen) out.addFile(name, data)
    fs.writeFileSync(libDest, out.toBuffer())
  } else {
    fs.copyFileSync(zipFile, libDest)
  }
  const json = {
    id,
    inheritsFrom: mc,
    fmlLegacy: true,
    type: 'release',
    mainClass: 'net.minecraft.client.Minecraft',
    minecraftArguments: base.minecraftArguments || '${auth_player_name} ${auth_session} --gameDir ${game_directory} --assetsDir ${game_assets}',
    downloads: base.downloads,
    assetIndex: base.assetIndex,
    assets: base.assets,
    arguments: { jvm: ['-Djava.library.path=${natives_directory}'] },
    libraries: (base.libraries || []).concat([{
      name: `net.minecraftforge:forge:${resolved}`,
      downloads: { artifact: { path: libPath } }
    }])
  }
  const dir = path.join(P.versions, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(json, null, 2))
  if (onOutput) onOutput(`ثبّتت فورج ${id} من الحزمة الكاملة (universal) مباشرة`)
  return json
}

function runInstallerSmart(javaBin, installerJar, dataDir, onOutput) {
  return runInstaller(javaBin, installerJar, dataDir, onOutput, ['--installClient', dataDir]).catch(async (err) => {
    if (!/unrecognized|not a recognized option/i.test(String(err.message))) throw err
    if (onOutput) onOutput('هذا الإصدار من فورج قديم — ستفتح نافذة المثبّت، اضغط Install ثم انتظر ثم أغلقها')
    await runInstallerGui(javaBin, installerJar, dataDir, onOutput)
  })
}

function candidateJson(mc) {
  const dir = cfg.paths().versions
  if (!fs.existsSync(dir)) return null
  const ids = fs.readdirSync(dir).filter((d) => d.startsWith(mc + '-forge'))
  if (!ids.length) return null
  const jsons = []
  for (const id of ids) {
    const file = path.join(dir, id, id + '.json')
    if (fs.existsSync(file)) {
      try {
        jsons.push({ id, file, json: JSON.parse(fs.readFileSync(file, 'utf8')) })
      } catch (e) {}
    }
  }
  if (!jsons.length) return null
  return jsons
}

function findInstalled(mc, forge) {
  const jsons = candidateJson(mc)
  if (!jsons) return null
  const ids = [`${mc}-forge-${forge}`, `${mc}-forge${mc}-${forge}`, `${mc}-forge${mc}-${forge}-${mc}`, `${mc}-forge-${forge}-${mc}`, `${mc}-forge${forge}`, `${mc}-forge${forge}-${mc}`]
  const exact = jsons.find((j) => ids.includes(j.json.id || j.id))
  if (exact) return exact
  return jsons.sort((a, b) => (fs.statSync(b.file).mtimeMs || 0) - (fs.statSync(a.file).mtimeMs || 0))[0]
}

function isOldUniversalMc(mc) {
  const p = String(mc).split('.').map((n) => parseInt(n, 10))
  const a = p[0] || 0
  const b = p[1] || 0
  const c = p[2] || 0
  if (a < 1) return true
  if (a === 1 && b < 5) return true
  if (a === 1 && b === 5) return c < 2
  return false
}

async function ensureInstalled(mc, forge, javaBin, onOutput) {
  const P = cfg.paths()
  let result = findInstalled(mc, forge)
  const forgeLibMissing = (r) => {
    if (!r) return true
    const lib = (r.json.libraries || []).find((l) => l && String(l.name).startsWith('net.minecraftforge:forge:'))
    if (!lib) return false
    const parts = lib.name.split(':')
    const [g, a, v, ...rest] = parts
    const lp = `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${rest[0] ? '-' + rest[0] : ''}.jar`
    return !fs.existsSync(path.join(P.libraries, lp))
  }
  const ok = (r) => {
    if (!r) return false
    const base = needsClientJar(r.json) ? !!findClientJar(mc, forge) : r.json.jar && r.json.jar !== mc ? fs.existsSync(path.join(P.versions, r.json.jar, r.json.jar + '.jar')) : true
    return !!base && !forgeLibMissing(r)
  }
  if (!ok(result)) {
    const installer = path.join(P.tmp, `forge-${mc}-${forge}-installer.jar`)
    if (isOldUniversalMc(mc)) {
      const resolved = await resolveMavenVersion(mc, forge)
      try {
        await installLegacyUniversal(mc, forge, resolved, onOutput)
        if (onOutput) onOutput('ثبّتت فورج من الحزمة الكاملة (لا يوجد مثبّت لهذا الإصدار القديم)')
      } catch (e) {
        if (!/HTTP 404/.test(String(e.message))) throw e
      }
      result = findInstalled(mc, forge)
    }
    if (!ok(result) && !fs.existsSync(installer)) {
      const url = await installerUrl(mc, forge)
      try {
        await downloadWithRetry([url], installer, {
          onProgress: (received, total) => onOutput && onOutput(`تحميل مثبت فورج ${received}/${total}`),
          tries: 5
        })
      } catch (e) {
        if (/HTTP 404/.test(String(e.message))) {
          const resolved = await resolveMavenVersion(mc, forge)
          let legacy = null
          try {
            legacy = await installLegacyUniversal(mc, forge, resolved, onOutput)
          } catch (e2) {
            if (!/HTTP 404/.test(String(e2.message))) throw e2
          }
          if (legacy) {
            if (onOutput) onOutput('لا يوجد مثبّت لهذا الإصدار — ثبّتت فورج من الحزمة الكاملة مباشرة')
            result = findInstalled(mc, forge)
          } else {
            throw new Error(`نسخة فورج ${forge} غير متاحة للتحميل من خوادم فورج — جرب نسخة فورج أخرى`)
          }
        } else {
          throw e
        }
      }
    }
    if (!ok(result)) {
      const profilesFile = path.join(P.data, 'launcher_profiles.json')
      if (!fs.existsSync(profilesFile)) {
        fs.writeFileSync(profilesFile, JSON.stringify({
          clientToken: crypto.randomUUID ? crypto.randomUUID() : '',
          selectedProfileName: 'minecraft',
          profiles: { minecraft: { name: 'minecraft', lastVersionId: mc } }
        }, null, 2))
        if (onOutput) onOutput('تم إنشاء launcher_profiles.json')
      }

      const extracted = extractOldForge(installer, P.data, onOutput)
      if (extracted) {
        if (onOutput) onOutput('تم تثبيت فورج (استخراج مباشر من المثبت)')
        result = findInstalled(mc, forge)
      }

      for (let attempt = 0; attempt < 2 && !ok(result); attempt++) {
        await runInstallerSmart(javaBin, installer, P.data, onOutput)
        result = findInstalled(mc, forge)
      }
    }
  }

  if (!result) throw new Error('فورج ثبت بس الملفات ما طلعت')
  if (needsClientJar(result.json) && !findClientJar(mc, forge)) {
    throw new Error('ملفات فورج المولدة ناقصة (client jar غير موجود) — أعد تثبيت فورج')
  }
  if (result.json.jar && result.json.jar !== mc && !fs.existsSync(path.join(P.versions, result.json.jar, result.json.jar + '.jar'))) {
    throw new Error('ملف فورج المولّد ناقص — أعد تثبيت فورج')
  }
  return result.json
}

module.exports = { versions, installerUrl, ensureInstalled, findInstalled, findClientJar, needsClientJar, ensureFmlLibs, installLegacyUniversal }
