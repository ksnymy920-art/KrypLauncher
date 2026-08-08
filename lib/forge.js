const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const cfg = require('./config')
const { getJSON, download } = require('./download')

const PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/'

async function versions(mc) {
  const data = await getJSON(PROMOS)
  const promos = data.promos || {}
  return {
    mc,
    recommended: promos[mc + '-recommended'] || null,
    latest: promos[mc + '-latest'] || promos[mc + '-recommended'] || null
  }
}

function installerUrl(mc, forge) {
  return `${MAVEN}${mc}-${forge}/forge-${mc}-${forge}-installer.jar`
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
      else reject(new Error('فشل تثبيت فورج (code ' + code + '): ' + out.slice(-600)))
    })
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
  const exact = jsons.find((j) => j.json.id === `${mc}-forge-${forge}` || j.id === `${mc}-forge-${forge}`)
  if (exact) return exact
  return jsons.sort((a, b) => (fs.statSync(b.file).mtimeMs || 0) - (fs.statSync(a.file).mtimeMs || 0))[0]
}

async function ensureInstalled(mc, forge, javaBin, onOutput) {
  const P = cfg.paths()
  const existing = findInstalled(mc, forge)
  if (existing) return existing.json

  const installer = path.join(P.tmp, `forge-${mc}-${forge}-installer.jar`)
  if (!fs.existsSync(installer)) {
    await download(installerUrl(mc, forge), installer, {
      onProgress: (received, total) => onOutput && onOutput(`تحميل مثبت فورج ${received}/${total}`)
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

  await runInstaller(javaBin, installer, P.data, onOutput)

  const result = findInstalled(mc, forge)
  if (!result) throw new Error('فورج ثبت بس الملفات ما طلعت')
  return result.json
}

module.exports = { versions, installerUrl, ensureInstalled, findInstalled }
