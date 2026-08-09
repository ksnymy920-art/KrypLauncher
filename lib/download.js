const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { URL } = require('url')
const { pipeline } = require('stream')
const { promisify } = require('util')

const pipelineAsync = promisify(pipeline)
const UA = 'OmniLauncher/1.0'

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, {
      method: options.method || 'GET',
      headers: { 'user-agent': UA, ...(options.headers || {}) }
    }, resolve)
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function getJSON(url, options = {}) {
  const res = await request(url, options)
  if (res.statusCode >= 400) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode} for ${url}`)
  }
  let body = ''
  for await (const chunk of res) body += chunk
  return JSON.parse(body)
}

async function getText(url, options = {}) {
  const res = await request(url, options)
  if (res.statusCode >= 400) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode} for ${url}`)
  }
  let body = ''
  for await (const chunk of res) body += chunk
  return body
}

function download(url, dest, { onProgress, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const run = (target, redirects) => {
      const u = new URL(target)
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(target, { headers: { 'user-agent': UA } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          if (redirects >= 6) return reject(new Error('too many redirects'))
          return run(new URL(res.headers.location, target).toString(), redirects + 1)
        }
        if (res.statusCode >= 400) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${target}`))
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        const tmp = dest + '.part'
        const ws = fs.createWriteStream(tmp)
        res.on('data', (chunk) => {
          received += chunk.length
          if (onProgress && total) onProgress(received, total)
        })
        pipelineAsync(res, ws)
          .then(() => {
            fs.renameSync(tmp, dest)
            resolve(dest)
          })
          .catch((err) => {
            try { fs.unlinkSync(tmp) } catch (e) {}
            reject(err)
          })
      })
      req.on('error', reject)
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
    }
    run(url, 0)
  })
}

async function downloadWithFallback(urls, dest, onProgress) {
  let lastErr = null
  for (const u of urls) {
    try {
      await download(u, dest, { onProgress })
      return dest
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error(`failed to download ${dest}`)
}

async function pool(items, concurrency, fn) {
  const queue = items.slice()
  const n = Math.max(1, Math.min(concurrency || 8, queue.length))
  const workers = []
  for (let i = 0; i < n; i++) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift()
        await fn(item)
      }
    })())
  }
  await Promise.all(workers)
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) return resolve(null)
    const crypto = require('crypto')
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

module.exports = { request, getJSON, getText, download, downloadWithFallback, pool, sha1File }
