const { request } = require('./download')
const { randomUUID } = require('crypto')

const DEFAULT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb'
const SCOPE = 'XboxLive.SignIn XboxLive.offline_access'

function encodeForm(obj) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(obj)) body.append(k, v)
  return body.toString()
}

async function postForm(url, body, headers = {}) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: encodeForm(body)
  })
  return parse(res)
}

async function postJSON(url, body, headers = {}) {
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  return parse(res)
}

async function getAuth(url, token) {
  const res = await request(url, { headers: { authorization: `Bearer ${token}` } })
  return parse(res)
}

async function parse(res) {
  let body = ''
  for await (const chunk of res) body += chunk
  const data = body ? JSON.parse(body) : {}
  if (res.statusCode >= 400) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.statusCode}`)
    err.status = res.statusCode
    err.body = data
    throw err
  }
  return data
}

async function deviceCode(clientId) {
  return postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    client_id: clientId,
    scope: SCOPE
  })
}

async function pollToken(clientId, deviceCodeValue) {
  return postForm('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCodeValue
  })
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return {}
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch (e) {
    return {}
  }
}

async function xbl(accessToken) {
  const data = await postJSON('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + accessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  })
  const xui = data.DisplayClaims.xui[0] || {}
  const claims = decodeJwtPayload(data.Token)
  const gtg = xui.gtg || xui.Gamertag || xui.gamertag || claims.gtg || claims.ugt || claims.Gamertag || claims.gamertag || ''
  return {
    token: data.Token,
    uhs: xui.uhs || claims.uhs || '',
    xid: xui.xid || claims.xid || '',
    gtg
  }
}

async function xboxProfileName(xblToken, xid) {
  if (!xblToken || !xid) return ''
  const xs = await postJSON('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'http://xboxlive.com',
    TokenType: 'JWT'
  })
  const paths = [
    `https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag`,
    `https://profile.xboxlive.com/users/xuid(${encodeURIComponent(xid)})/profile/settings?settings=Gamertag`
  ]
  for (const url of paths) {
    try {
      const res = await request(url, {
        headers: {
          authorization: `Bearer ${xs.Token}`,
          'x-xbl-contract-version': '2',
          accept: 'application/json',
          'user-agent': 'OmniLauncher/1.0'
        }
      })
      const data = await parse(res)
      const settings = data.profileUsers && data.profileUsers[0] && data.profileUsers[0].settings
      if (Array.isArray(settings) && settings[0] && settings[0].value) return settings[0].value
    } catch (e) {}
  }
  return ''
}

async function xsts(xblToken) {
  const data = await postJSON('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  })
  return data.Token
}

async function minecraftLogin(uhs, xstsToken) {
  const data = await postJSON('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`
  })
  return data.access_token
}

async function minecraftProfile(minecraftToken) {
  return getAuth('https://api.minecraftservices.com/minecraft/profile', minecraftToken)
}

function resolveClientId(clientId) {
  if (!clientId) return DEFAULT_CLIENT_ID
  const c = String(clientId).trim()
  return !c || c === 'minecraft-launcher' ? DEFAULT_CLIENT_ID : c
}

async function start(clientId) {
  return deviceCode(resolveClientId(clientId))
}

async function complete(clientId, dc, onProgress) {
  clientId = resolveClientId(clientId)
  const expiresAt = Date.now() + (dc.expires_in || 900) * 1000
  let msToken = null
  while (Date.now() < expiresAt) {
    try {
      const tok = await pollToken(clientId, dc.device_code)
      msToken = tok.access_token
      break
    } catch (err) {
      if (err.body && err.body.error === 'authorization_pending') {
        onProgress && onProgress('بانتظار التأكيد...')
        await new Promise((r) => setTimeout(r, Math.max(dc.interval || 5, 3) * 1000))
        continue
      }
      if (err.body && err.body.error === 'authorization_declined') throw new Error('تم رفض تسجيل الدخول')
      if (err.body && err.body.error === 'expired_token') throw new Error('انتهت صلاحية رمز التسجيل')
      throw err
    }
  }
  if (!msToken) throw new Error('انتهى الوقت - حاول مرة ثانية')

  onProgress && onProgress('تسجيل دخول Xbox...')
  const x = await xbl(msToken)
  onProgress && onProgress('مصادقة Xbox Live...')
  const xs = await xsts(x.token)
  const minecraftToken = await minecraftLogin(x.uhs, xs)
  onProgress && onProgress('جلب الحساب...')

  let prof = null
  for (let i = 0; i < 3 && !prof; i++) {
    try {
      prof = await minecraftProfile(minecraftToken)
    } catch (e) {
      if (i < 2) await new Promise((r) => setTimeout(r, 1500))
    }
  }

  let name = (prof && prof.name) || x.gtg || ''
  if (!name) {
    try {
      name = await xboxProfileName(x.token, x.xid)
    } catch (e) {}
  }

  const mcClaims = decodeJwtPayload(minecraftToken)
  return {
    id: randomUUID(),
    name: name || 'Microsoft-Account',
    uuid: prof && prof.id ? prof.id : randomUUID(),
    type: 'microsoft',
    accessToken: minecraftToken,
    clientId,
    premium: true,
    hasProfile: !!prof,
    xuid: x.xid || mcClaims.xuid || ''
  }
}

module.exports = { start, complete, DEFAULT_CLIENT_ID }
