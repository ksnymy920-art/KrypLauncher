const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const { URL } = require('url')
const { pipeline } = require('stream')
const { promisify } = require('util')

const pipelineAsync = promisify(pipeline)
const UA = 'KrypLauncher/1.0'

let cancelFlag = false

function resetCancel() {
  cancelFlag = false
}

function cancelAll() {
  cancelFlag = true
}

function isCancelled() {
  return cancelFlag
}

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
    const tmp = dest + '.part'
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const run = (target, redirects) => {
      let start = 0
      try {
        if (fs.existsSync(tmp)) start = fs.statSync(tmp).size
      } catch (e) {}
      const u = new URL(target)
      const mod = u.protocol === 'https:' ? https : http
      const headers = { 'user-agent': UA }
      if (start > 0) headers['range'] = `bytes=${start}-`
      const req = mod.get(target, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          if (redirects >= 6) return reject(new Error('too many redirects'))
          return run(new URL(res.headers.location, target).toString(), redirects + 1)
        }
        if (res.statusCode === 416) {
          res.resume()
          try { fs.renameSync(tmp, dest) } catch (e) {}
          return resolve(dest)
        }
        if (res.statusCode >= 400) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${target}`))
        }
        const resumed = res.statusCode === 206 && start > 0
        if (res.statusCode === 200 && start > 0) start = 0
        const total = start + parseInt(res.headers['content-length'] || '0', 10)
        let received = start
        const ws = fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' })
        res.on('data', (chunk) => {
          received += chunk.length
          if (onProgress && total) onProgress(received, total)
          if (cancelFlag) {
            try { ws.destroy() } catch (e) {}
            try { req.destroy() } catch (e) {}
            reject(new Error('cancelled'))
          }
        })
        pipelineAsync(res, ws)
          .then(() => {
            fs.renameSync(tmp, dest)
            resolve(dest)
          })
          .catch((err) => {
            if (err && err.message !== 'cancelled') {
              try { fs.unlinkSync(tmp) } catch (e) {}
            }
            reject(err && err.message === 'cancelled' ? new Error('cancelled') : err)
          })
      })
      req.on('error', (err) => {
        if (err && err.message === 'cancelled') return reject(new Error('cancelled'))
        reject(err)
      })
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timeout')))
    }
    run(url, 0)
  })
}

async function downloadWithFallback(urls, dest, onProgress, opts = {}) {
  let lastErr = null
  for (const u of urls) {
    if (cancelFlag) throw new Error('cancelled')
    try {
      await download(u, dest, { onProgress, timeout: opts.timeout })
      return dest
    } catch (err) {
      lastErr = err
      if (err && err.message === 'cancelled') throw err
    }
  }
  throw lastErr || new Error(`failed to download ${dest}`)
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) return resolve(null)
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function downloadWithRetry(urls, dest, { onProgress, sha1, tries = 3, timeout = 20000 } = {}) {
  let lastErr = null
  for (let attempt = 0; attempt < tries; attempt++) {
    if (cancelFlag) throw new Error('cancelled')
    try {
      await downloadWithFallback(urls, dest, onProgress, { timeout })
      if (sha1) {
        const actual = await sha1File(dest)
        if (actual !== sha1) {
          try { fs.unlinkSync(dest) } catch (e) {}
          try { fs.unlinkSync(dest + '.part') } catch (e) {}
          throw new Error('sha1 mismatch')
        }
      }
      return dest
    } catch (err) {
      lastErr = err
      if (err && err.message === 'cancelled') throw err
      if (attempt < tries - 1) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
      }
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

module.exports = { request, getJSON, getText, download, downloadWithFallback, downloadWithRetry, pool, sha1File, resetCancel, cancelAll, isCancelled }
