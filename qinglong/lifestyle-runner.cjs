// Default is strictly read-only: no message API call unless --send is explicit.
const { validateTemplate, validateData } = require('./lifestyle-validation.cjs')
const { getAccessToken, listTemplates } = require('./lifestyle-wechat.cjs')

async function quietly(task) {
  const previous = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = () => {}
  try { return await task() } finally { Object.assign(console, previous) }
}

async function main() {
  if (process.argv.slice(2).some(arg => !['--send', '--validate-only'].includes(arg))) throw new Error('不支持的运行参数')
  if (process.argv.includes('--send') && process.argv.includes('--validate-only')) throw new Error('发送和只读校验不能同时选择')
  let config
  try { config = JSON.parse(process.env.ALL_CONFIG || '') } catch { throw new Error('ALL_CONFIG 缺失或不是有效 JSON，受保护内容未记录') }
  if (!config.APP_ID || !config.APP_SECRET || !config.TEMPLATE_CONFIG?.length || !config.USER_INFO?.length) {
    throw new Error('旧版生活日报配置不完整，未发送消息')
  }
  const legacy = await quietly(() => require('./qinglong-push.js'))
  const users = legacy.ALL_CONFIG.USER_INFO
  if (users.some(user => !user.id || !user.wechatTemplateId)) throw new Error('接收人或旧版模板 ID 不完整')
  if (new Set(users.map(user => user.id)).size !== users.length) throw new Error('接收人存在重复，未发送消息')
  const token = await getAccessToken(config)
  const templates = await listTemplates(token)
  for (const id of new Set(users.map(user => user.wechatTemplateId))) {
    validateTemplate(templates.find(template => template.template_id === id))
  }
  const prepared = []
  for (const [index, user] of users.entries()) {
    const original = await quietly(() => legacy.dataAggregationService.getAggregatedData(user))
    const data = legacy.buildWechatSafeTemplateData(original)
    const lengths = validateData(data, original)
    prepared.push({ user, original })
    console.log(`接收人${index + 1}：旧版生活模板8字段齐全，天气、周年纪念日、中英句、诗词出处已生成；字段长度 ${JSON.stringify(lengths)}`)
  }
  if (!process.argv.includes('--send')) {
    console.log(`只读恢复校验成功：接收人${users.length}位，未调用消息发送接口，未更改任何 Secret。`)
    return
  }
  let failures = 0
  for (const [index, item] of prepared.entries()) {
    try {
      await quietly(() => legacy.pushService.sendWeChatTemplate(item.user, item.original, token))
      console.log(`微信接口已接受接收人${index + 1}的生活日报。`)
    } catch { failures++; console.error(`接收人${index + 1}发送未完成；本次不自动重试，避免重复。`) }
  }
  if (failures) throw new Error('部分生活日报未能发送，请检查本次运行，不要直接重复发送全部用户')
}

main().catch(error => {
  // Only explicitly authored validation messages are logged; never dump error objects or request URLs.
  const message = String(error?.message || '')
  console.error(/^(ALL_CONFIG |旧版|配置指向招聘模板|接收人|微信|生活|当前天气|相伴|纪念日|每日一句|诗词|部分生活|不支持|发送和)/.test(message)
    && !/https?:\/\//.test(message) ? message : '生活日报校验失败；受保护输出已隐藏，未继续发送。')
  process.exitCode = 1
})
