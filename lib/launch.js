const path = require('path')
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const cfg = require('./config')

function offlineUuid(name) {
  const bytes = Buffer.from('OfflinePlayer:' + name, 'utf8')
  const md5 = createHash('md5').update(bytes).digest()
  md5[6] = (md5[6] & 0x0f) | 0x30
  md5[8] = (md5[8] & 0x3f) | 0x80
  const hex = md5.toString('hex')
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}

function supportsQuickPlay(versionId) {
  const v = String(versionId || '')
  const m = /^(\d+)\.(\d+)/.exec(v)
  if (m) {
    const major = parseInt(m[1], 10)
    const minor = parseInt(m[2], 10)
    return major > 1 || (major === 1 && minor >= 20)
  }
  const s = /^(\d{2})w/.exec(v)
  if (s) return parseInt(s[1], 10) >= 23
  return false
}

function joinArgs(versionId, server, serverPort) {
  if (supportsQuickPlay(versionId)) {
    return ['--quickPlayMultiplayer', server + (serverPort && serverPort !== 25565 ? ':' + serverPort : '')]
  }
  return ['--server', server, '--port', String(serverPort || 25565)]
}

function buildCommand({ javaBin, memory, jvmArgs, nativesDir, classpath, mainClass, versionJson, gameDir, assetsDir, assetIndex, account, width, height, server, serverPort }) {
  const args = []
  if (memory) {
    args.push(`-Xmx${memory}M`)
    args.push(`-Xms${Math.min(Math.max(memory, 256), 1024)}M`)
  }
  if (jvmArgs) {
    for (const part of jvmArgs.split(/\s+/)) {
      if (part.trim()) args.push(part.trim())
    }
  }
  args.push(`-Djava.library.path=${nativesDir}`)
  args.push('-cp', classpath)
  args.push(mainClass)
  args.push('--username', account.name)
  args.push('--version', versionJson.id)
  args.push('--gameDir', gameDir)
  args.push('--assetsDir', assetsDir)
  if (assetIndex) args.push('--assetIndex', assetIndex)
  if (account.uuid) args.push('--uuid', account.uuid)
  args.push('--accessToken', account.accessToken || '0')
  args.push('--userType', account.premium ? 'msa' : 'legacy')
  args.push('--versionType', versionJson.type || 'release')
  if (width && height) {
    args.push('--width', String(width))
    args.push('--height', String(height))
  }
  if (server) {
    args.push(...joinArgs(versionJson && versionJson.id, server, serverPort))
  }
  return args
}

function buildClasspath(artifactPaths) {
  return artifactPaths.join(path.delimiter)
}

function launch({ javaBin, args, cwd }) {
  return spawn(javaBin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
}

function replaceTokens(items, ctx) {
  const out = []
  const arr = Array.isArray(items) ? items : String(items || '').split(/\s+/)
  for (const item of arr) {
    let s = String(item)
    for (const [k, v] of Object.entries(ctx)) {
      s = s.split('${' + k + '}').join(String(v))
      s = s.split('{' + k + '}').join(String(v))
    }
    if (s.trim()) out.push(s.trim())
  }
  return out
}

function matchesRules(rules) {
  const p = {
    osName: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux',
    osArch: process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64'
  }
  let allow = false
  for (const rule of rules) {
    let match = true
    if (rule.os) {
      if (rule.os.name && rule.os.name !== p.osName) match = false
      if (match && rule.os.arch && rule.os.arch !== p.osArch) match = false
      if (match && rule.os.version) match = false
    }
    if (rule.features) match = false
    if (match) allow = rule.action === 'allow'
  }
  return allow
}

function expandArguments(items, ctx) {
  const out = []
  for (const item of items || []) {
    if (typeof item === 'string') {
      const s = replaceTokens([item], ctx)[0]
      if (s) out.push(s)
    } else if (item && typeof item === 'object') {
      if (item.rules && !matchesRules(item.rules)) continue
      const values = Array.isArray(item.value) ? item.value : [item.value]
      for (const v of values) {
        const s = replaceTokens([String(v)], ctx)[0]
        if (s) out.push(s)
      }
    }
  }
  return out
}

function buildForgeArgs({ forgeJson, baseJson, classpath, mainClass, nativesDir, gameDir, assetsDir, assetIndex, gameAssets, account, memory, jvmArgs, width, height, server, serverPort }) {
  const ctx = {
    auth_player_name: account.name,
    auth_session: account.accessToken ? `token:${account.accessToken}:${account.uuid || ''}` : `token:0:${account.uuid || ''}`,
    version_name: forgeJson.id,
    game_directory: gameDir,
    assets_root: assetsDir,
    game_assets: gameAssets || assetsDir,
    assets_index_name: assetIndex || '',
    auth_uuid: account.uuid || '',
    auth_access_token: account.accessToken || '0',
    user_type: account.premium ? 'msa' : 'legacy',
    version_type: forgeJson.type || 'release',
    natives_directory: nativesDir,
    launcher_name: 'KrypLauncher',
    launcher_version: '1.0',
    clientid: (require('./config').load().settings.clientId) || 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb',
    auth_xuid: account.xuid || '',
    classpath,
    classpath_separator: path.delimiter,
    library_directory: require('./config').paths().libraries
  }

  const args = []
  if (forgeJson && forgeJson.fmlLegacy) {
    args.push(`-Dminecraft.applet.TargetDirectory=${gameDir}`)
  }
  args.push('-Dfml.earlyprogresswindow=false')
  args.push('-Dneoforge.earlydisplay.window=false')
  args.push('-DlibraryDirectory=' + require('./config').paths().libraries)
  if (memory) {
    args.push(`-Xmx${memory}M`)
    args.push(`-Xms${Math.min(Math.max(memory, 256), 1024)}M`)
  }
  if (jvmArgs) {
    for (const part of jvmArgs.split(/\s+/)) {
      if (part.trim()) args.push(part.trim())
    }
  }

  const jvm = []
  const game = []
  const baseArgs = (baseJson && baseJson.arguments) || {}
  const forgeArgs = (forgeJson && forgeJson.arguments) || {}
  if (baseArgs.jvm) jvm.push(...expandArguments(baseArgs.jvm, ctx))
  if (forgeArgs.jvm) jvm.push(...expandArguments(forgeArgs.jvm, ctx))
  if (baseArgs.game) game.push(...expandArguments(baseArgs.game, ctx))
  if (forgeArgs.game) game.push(...expandArguments(forgeArgs.game, ctx))
  if (!baseArgs.jvm && !forgeArgs.jvm && !jvm.length) jvm.push(`-Djava.library.path=${nativesDir}`)

  const cleanJvm = jvm.filter((a) => a !== '-cp' && a !== classpath)
  args.push(...cleanJvm)
  args.push('-cp', classpath)
  args.push(mainClass)

  if (game.length) {
    args.push(...game)
  } else if (forgeJson && forgeJson.minecraftArguments) {
    args.push(...replaceTokens(forgeJson.minecraftArguments, ctx))
  } else {
    args.push('--username', ctx.auth_player_name)
    args.push('--version', ctx.version_name)
    args.push('--gameDir', ctx.game_directory)
    args.push('--assetsDir', ctx.assets_root)
    if (ctx.assets_index_name) args.push('--assetIndex', ctx.assets_index_name)
    if (ctx.auth_uuid) args.push('--uuid', ctx.auth_uuid)
    args.push('--accessToken', ctx.auth_access_token)
    args.push('--userType', ctx.user_type)
    args.push('--versionType', ctx.version_type)
  }

  if (width && height) {
    args.push('--width', String(width))
    args.push('--height', String(height))
  }
  if (server) {
    args.push(...joinArgs((baseJson && baseJson.id) || (forgeJson && forgeJson.id), server, serverPort))
  }
  return args
}

module.exports = { offlineUuid, buildCommand, buildForgeArgs, buildClasspath, launch }
