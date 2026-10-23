// Keep the lifestyle workflow independent of all recruitment dependencies.
async function request(url, fetcher) {
  let response
  try {
    response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000) })
  } catch { throw new Error('微信接口网络请求失败（受保护请求地址已隐藏）') }
  if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`)
  let result
  try { result = await response.json() } catch { throw new Error('微信接口返回非 JSON 响应') }
  if (!result || typeof result !== 'object') throw new Error('微信接口响应格式异常')
  if (result.errcode) throw new Error(`微信接口错误码 ${Number(result.errcode)}，未发送消息`)
  return result
}

async function getAccessToken(config, fetcher = fetch) {
  const query = new URLSearchParams({ grant_type: 'client_credential', appid: config.APP_ID, secret: config.APP_SECRET })
  const result = await request(`https://api.weixin.qq.com/cgi-bin/token?${query}`, fetcher)
  if (!result.access_token) throw new Error('微信接口未返回 access_token')
  return result.access_token
}

async function listTemplates(token, fetcher = fetch) {
  const result = await request(`https://api.weixin.qq.com/cgi-bin/template/get_all_private_template?access_token=${encodeURIComponent(token)}`, fetcher)
  if (!Array.isArray(result.template_list)) throw new Error('微信接口未返回可用模板列表')
  return result.template_list
}

module.exports = { getAccessToken, listTemplates }
