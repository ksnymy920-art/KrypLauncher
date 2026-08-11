const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const cfg = require('./config')
const { getText, downloadWithRetry } = require('./download')
const forge = require('./forge')

const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/'
const NEOFORGE_FORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/forge/'

function isOldGroup(mc) {
  return String(mc) === '1.20.1'
}

function parseVersions(xml) {
  const out = []
  const re = /<version>([^<]+)<\/version>/g
  let m
  while ((m = re.exec(xml))) out.push(m[1])
  return out
}

function byVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da - db
  }
  return 0
}

async function versions(mc) {
  const xml = await getText((isOldGroup(mc) ? NEOFORGE_FORGE_MAVEN : NEOFORGE_MAVEN) + 'maven-metadata.xml')
  const all = parseVersions(xml)
  let list
  if (isOldGroup(mc)) {
    list = all.filter((v) => v.startsWith(`${mc}-47.`)).map((v) => v.slice(mc.length + 1))
  } else {
    const prefix = String(mc).replace(/^1\./, '') + '.'
    list = all.filter((v) => v.startsWith(prefix))
  }
  const stable = list.filter((v) => !/(\.|-)(beta|alpha|pr|pre)/i.test(v))
  const sorted = list.slice().sort(byVersion)
  const sortedStable = stable.slice().sort(byVersion)
  return {
    mc,
    recommended: sortedStable.length ? sortedStable[sortedStable.length - 1] : null,
    latest: sorted.length ? sorted[sorted.length - 1] : null
  }
}

function installerUrl(mc, neo) {
  if (isOldGroup(mc)) return `${NEOFORGE_FORGE_MAVEN}${mc}-${neo}/forge-${mc}-${neo}-installer.jar`
  return `${NEOFORGE_MAVEN}${neo}/neoforge-${neo}-installer.jar`
}

function runInstaller(javaBin, installerJar, dataDir, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaBin, ['-jar', installerJar, '--installClient', dataDir], {
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
      else reject(new Error('فشل تثبيت نيو فورج (code ' + code + '): ' + out.slice(-600)))
    })
  })
}

function candidateJson(mc) {
  const dir = cfg.paths().versions
  if (!fs.existsSync(dir)) return null
  const ids = fs.readdirSync(dir).filter((d) => {
    if (d.startsWith(mc + '-')) return /-\d/.test(d)
    if (d.startsWith('neoforge-') || d.startsWith('forge-')) return /-\d/.test(d)
    return false
  })
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

function findInstalled(mc, neo) {
  const jsons = candidateJson(mc)
  if (!jsons) return null
  const exact = jsons.find((j) => {
    const id = j.json.id || j.id
    return id === `${mc}-${neo}` || id === `${mc}-neoforge-${neo}` || id === `${mc}-forge-${neo}` || id === `neoforge-${neo}` || id === `forge-${neo}`
  })
  if (exact) return exact
  return jsons.sort((a, b) => (fs.statSync(b.file).mtimeMs || 0) - (fs.statSync(a.file).mtimeMs || 0))[0]
}

async function ensureInstalled(mc, neo, javaBin, onOutput) {
  const P = cfg.paths()
  let result = findInstalled(mc, neo)
  const ok = (r) => r && (forge.needsClientJar(r.json) ? !!forge.findClientJar(mc, neo) : true)
  if (!ok(result)) {
    const installer = path.join(P.tmp, `neoforge-${neo}-installer.jar`)
    if (!fs.existsSync(installer)) {
      await downloadWithRetry([installerUrl(mc, neo)], installer, {
        onProgress: (received, total) => onOutput && onOutput(`تحميل مثبت نيو فورج ${received}/${total}`),
        tries: 5
      })
    }

    const profilesFile = path.join(P.data, 'launcher_profiles.json')
    if (!fs.existsSync(profilesFile)) {
      fs.writeFileSync(profilesFile, JSON.stringify({
        clientToken: crypto.randomUUID ? crypto.randomUUID() : '',
        selectedProfileName: 'minecraft',
        profiles: { minecraft: { name: 'minecraft', lastVersionId: mc } }
      }, null, 2))
      if (onOutput) onOutput('تم إنشاء launcher_profiles.json')
    }

    for (let attempt = 0; attempt < 2 && !ok(result); attempt++) {
      await runInstaller(javaBin, installer, P.data, onOutput)
      result = findInstalled(mc, neo)
    }
  }

  if (!result) throw new Error('نيو فورج ثبت بس الملفات ما طلعت')
  if (forge.needsClientJar(result.json) && !forge.findClientJar(mc, neo)) {
    throw new Error('ملفات نيو فورج المولدة ناقصة (client jar غير موجود) — أعد تثبيت نيو فورج')
  }
  return result.json
}

module.exports = { versions, installerUrl, ensureInstalled, findInstalled }
