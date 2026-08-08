const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const OWNER = 'ksnymy920-art'
const REPO = 'OmniLauncher'
const APP_EXE = 'OmniLauncher.exe'

function parseVersion(v) {
  const s = String(v || '').replace(/^v/i, '').trim()
  const nums = s.split('.').slice(0, 3).map((p) => {
    const n = parseInt(p, 10)
    return isNaN(n) ? 0 : n
  })
  while (nums.length < 3) nums.push(0)
  return nums
}

function cmpVersions(a, b) {
  const A = parseVersion(a)
  const B = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] - B[i]
  }
  return 0
}

function httpGet(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'OmniLauncher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume()
          resolve(httpGet(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
          return
        }
        resolve(res)
      })
      .on('error', reject)
  })
}

async function getLatestInfo() {
  try {
    const res = await httpGet(`https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`, 4)
    if (res.statusCode !== 200) {
      res.resume()
      throw new Error('no latest.yml')
    }
    let data = ''
    res.on('data', (c) => (data += c))
    await new Promise((resolve, reject) => {
      res.on('end', resolve)
      res.on('error', reject)
    })
    const verMatch = data.match(/^version:\s*(\S+)/m)
    const pathMatch = data.match(/^path:\s*(\S+)/m)
    if (!verMatch) throw new Error('bad latest.yml')
    const file = pathMatch ? pathMatch[1] : APP_EXE
    return {
      version: verMatch[1],
      url: `https://github.com/${OWNER}/${REPO}/releases/latest/download/${file}`
    }
  } catch (e) {
    const res = await httpGet(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, 4)
    if (res.statusCode !== 200) {
      res.resume()
      throw e
    }
    let data = ''
    res.on('data', (c) => (data += c))
    await new Promise((resolve, reject) => {
      res.on('end', resolve)
      res.on('error', reject)
    })
    const j = JSON.parse(data)
    const asset = (j.assets || []).find((a) => a.name === APP_EXE)
    if (!asset) throw new Error('asset not found')
    return {
      version: String(j.tag_name || '').replace(/^v/i, ''),
      url: asset.browser_download_url
    }
  }
}

function checkUpdate(send) {
  return getLatestInfo().then((info) => {
    if (cmpVersions(info.version, require('electron').app.getVersion()) > 0) {
      send({ status: 'available', version: info.version, url: info.url })
    } else {
      send({ status: 'not-available' })
    }
    return info
  })
}

function downloadUpdate(info, send) {
  return new Promise((resolve, reject) => {
    const dest = path.join(os.tmpdir(), `${APP_EXE}.new-${Date.now()}`)
    const out = fs.createWriteStream(dest)
    let total = 0
    let received = 0
    httpGet(info.url, 4)
      .then((res) => {
        if (res.statusCode !== 200) {
          res.resume()
          out.destroy()
          fs.unlink(dest, () => {})
          return reject(new Error('HTTP ' + res.statusCode))
        }
        total = parseInt(res.headers['content-length'] || '0', 10)
        res.on('data', (c) => {
          received += c.length
          if (total > 0) send({ status: 'downloading', pct: Math.round((received / total) * 100) })
        })
        res.pipe(out)
        out.on('finish', () => {
          if (received > 0) send({ status: 'downloading', pct: 100 })
          resolve(dest)
        })
        out.on('error', reject)
        res.on('error', reject)
      })
      .catch((e) => {
        out.destroy()
        fs.unlink(dest, () => {})
        reject(e)
      })
  })
}

function installUpdate(downloadedPath) {
  const { app } = require('electron')
  const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  const script = path.join(os.tmpdir(), `omni-update-${Date.now()}.ps1`)
  const content =
    '$src = ' + JSON.stringify(downloadedPath) + '\r\n' +
    '$dst = ' + JSON.stringify(target) + '\r\n' +
    '$sw = [System.Diagnostics.Stopwatch]::StartNew()\r\n' +
    'while ($true) {\r\n' +
    '  try { Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop; break } catch {}\r\n' +
    '  if ($sw.Elapsed.TotalSeconds -gt 90) { exit 1 }\r\n' +
    '  Start-Sleep -Milliseconds 700\r\n' +
    '}\r\n' +
    'Start-Process -FilePath $dst\r\n' +
    'Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue\r\n'
  fs.writeFileSync(script, '\uFEFF' + content, 'utf8')
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
    detached: true,
    stdio: 'ignore'
  })
  p.unref()
  app.quit()
}

module.exports = { checkUpdate, downloadUpdate, installUpdate, cmpVersions, parseVersion }
