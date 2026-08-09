const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const cfg = require('./config')

function safeKey(instanceId) {
  return String(instanceId || 'default').replace(/[\\/:*?"<>|]/g, '_')
}

function backupsDir(instanceId) {
  const dir = path.join(cfg.paths().data, 'backups', safeKey(instanceId))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function list(instanceId) {
  const dir = backupsDir(instanceId)
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.zip'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        return { file: f, size: st.size, modified: st.mtime }
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
  } catch (e) {
    return []
  }
}

function create(instanceId, gameDir) {
  if (!fs.existsSync(gameDir)) throw new Error('مجلد اللعبة غير موجود — شغّل النسخة مرة قبل النسخ')
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`
  const dest = path.join(backupsDir(instanceId), name)
  const zip = new AdmZip()
  zip.addLocalFolder(gameDir)
  zip.writeZip(dest)
  return { file: name, dest, size: fs.statSync(dest).size }
}

function restore(instanceId, fileName, gameDir) {
  const zipFile = path.join(backupsDir(instanceId), path.basename(String(fileName || '')))
  if (!fs.existsSync(zipFile)) throw new Error('النسخة الاحتياطية غير موجودة')
  fs.mkdirSync(gameDir, { recursive: true })
  new AdmZip(zipFile).extractAllTo(gameDir, true)
  return { file: path.basename(fileName) }
}

function remove(instanceId, fileName) {
  const zipFile = path.join(backupsDir(instanceId), path.basename(String(fileName || '')))
  if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile)
}

module.exports = { list, create, restore, remove, backupsDir }
