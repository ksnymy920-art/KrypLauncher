const { request } = require('./download')

const MCLO = 'https://api.mclo.gs/1/log'

async function upload(text) {
  const body = 'content=' + encodeURIComponent(String(text || '').slice(0, 400000))
  const res = await request(MCLO, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (res.statusCode >= 400) {
    res.resume()
    throw new Error('mclo.gs HTTP ' + res.statusCode)
  }
  let data = ''
  for await (const chunk of res) data += chunk
  let j = {}
  try {
    j = JSON.parse(data)
  } catch (e) {
    throw new Error('mclo.gs استجابة غير صالحة')
  }
  if (j.success && j.url) return j.url
  throw new Error(j.message || 'فشل رفع اللوجات')
}

module.exports = { upload }
