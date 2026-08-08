const fs = require('fs')
const path = require('path')
const cfg = require('./config')
const mods = require('./mods')

function pushIds(raw, out) {
  for (const part of String(raw || '').split(/[\s,;]+/)) {
    const clean = part.replace(/^["'`(@]/, '').split('@')[0].trim()
    if (/^[a-zA-Z0-9_.-]+$/.test(clean) && !/\d+\.\d+/.test(clean) && clean.length > 1 && clean.length < 64) out.push(clean)
  }
}

function extractMissing(line) {
  const l = String(line || '')
  const missing = []
  const conflicts = []
  const missingWords = /missing|unsupported|could not find/i.test(l)

  if (missingWords) {
    for (const m of l.matchAll(/Could not find a module named ['"`]?([a-zA-Z0-9_.-]+)/gi)) pushIds(m[1], missing)
    if (/Mod ID:\s*['"`]?[a-zA-Z0-9_.-]+/i.test(l)) {
      for (const m of l.matchAll(/Mod ID:\s*['"`]?([a-zA-Z0-9_.-]+)/gi)) pushIds(m[1], missing)
    }
    for (const m of l.matchAll(/missing dependency:\s*['"`]?([a-zA-Z0-9_.-]+)/gi)) pushIds(m[1], missing)
    for (const m of l.matchAll(/Missing dependencies:\s*\[?([^\]\n]+)/gi)) pushIds(m[1], missing)
    for (const m of l.matchAll(/unsupported mandatory dependencies?\s*:?\s*([^\]\n]+)/gi)) pushIds(m[1], missing)
    if (/\brequires\b/i.test(l)) {
      for (const m of l.matchAll(/requires (?:mod |module )?['"`]?([a-zA-Z0-9_.-]+)/gi)) pushIds(m[1], missing)
    }
  }

  for (const m of l.matchAll(/Conflicting mods:\s*\[?([^\]\n]+)/gi)) pushIds(m[1], conflicts)
  for (const m of l.matchAll(/conflicts with (?:mod )?['"`]?([a-zA-Z0-9_.-]+)/gi)) pushIds(m[1], conflicts)

  return { missing: [...new Set(missing)], conflicts: [...new Set(conflicts)] }
}

function isInstalled(instanceId, id) {
  const q = String(id).toLowerCase()
  const metaFile = path.join(cfg.paths().game, instanceId, 'mods', 'installed-mods.json')
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || []
    if (meta.some((m) => (m.slug || '').toLowerCase() === q || String(m.projectId || '').toLowerCase() === q)) return true
  } catch (e) {}
  return mods.listInstalled(instanceId).some((f) => f.file.toLowerCase().includes(q))
}

async function curseFind(query, { version, loader }) {
  const res = await mods.search({ source: 'curseforge', query, version, loader, limit: 20, page: 1 })
  const q = String(query).toLowerCase()
  return (res.items || []).find((it) => it.slug && it.slug.toLowerCase() === q) || (res.items || [])[0] || null
}

async function resolveMissing({ instanceId, version, loader, ids, onVersion }) {
  const results = []
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (isInstalled(instanceId, id)) {
      results.push({ id, status: 'already' })
      continue
    }
    try {
      const r = await mods.install({ source: 'modrinth', id, version, loader, instanceId, slug: id, title: id, type: 'mod' }, onVersion)
      results.push({ id, status: 'installed', file: r.file, dependencies: r.dependencies })
    } catch (e1) {
      try {
        const found = await curseFind(id, { version, loader })
        if (!found) throw new Error(e1.message)
        const r = await mods.install({ source: 'curseforge', id: found.id, version, loader, instanceId, slug: found.slug, title: id, type: 'mod' }, onVersion)
        results.push({ id, status: 'installed', file: r.file, dependencies: r.dependencies })
      } catch (e2) {
        results.push({ id, status: 'failed', error: e2.message })
      }
    }
  }
  return results
}

module.exports = { extractMissing, resolveMissing }
