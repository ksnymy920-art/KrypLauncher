const fs = require('fs')
const path = require('path')

function profilePath(dataDir, id) {
  return path.join(dataDir, 'controls', id + '.txt')
}

function saveProfile(gameDir, dataDir, id) {
  const src = path.join(gameDir, 'options.txt')
  if (!fs.existsSync(src)) return false
  const dst = profilePath(dataDir, id)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  return true
}

function applyProfile(gameDir, dataDir, id) {
  const src = profilePath(dataDir, id)
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(gameDir, { recursive: true })
  fs.copyFileSync(src, path.join(gameDir, 'options.txt'))
  return true
}

function deleteProfile(dataDir, id) {
  const file = profilePath(dataDir, id)
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file) } catch (e) {}
  }
}

module.exports = { profilePath, saveProfile, applyProfile, deleteProfile }
