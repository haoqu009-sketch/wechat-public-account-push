const limits = Object.freeze({ a: 18, b: 18, l: 18, n2: 18, q1: 60, q2: 180, m1: 60, m2: 40 })
const fields = Object.freeze(Object.keys(limits))

function validateTemplate(template) {
  if (!template || typeof template.content !== 'string') throw new Error('旧版生活模板不存在，未发送消息')
  if (/招聘|岗位|候补/.test(`${template.title || ''}\n${template.content}`)) {
    throw new Error('配置指向招聘模板，拒绝用招聘标签发送生活日报')
  }
  const found = []
  const rest = template.content.replace(/\{\{([\s\S]*?)\}\}/g, (_, variable) => {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)\.DATA$/.exec(variable.trim())?.[1]
    if (!fields.includes(key)) throw new Error('生活模板包含不支持的变量')
    found.push(key)
    return ''
  })
  if (rest.includes('{{') || rest.includes('}}')) throw new Error('生活模板变量括号不完整')
  if (fields.some(key => !found.includes(key))) throw new Error('生活模板缺少每日一句、诗词或纪念日字段')
  if (found.length !== fields.length) throw new Error('生活模板字段存在重复，请勿重复挤占展示空间')
  if (template.content.includes('\uFFFD')) throw new Error('生活模板包含损坏字符，请先修复模板')
}

function validateData(data, original) {
  for (const key of fields) {
    const value = data[key]?.value
    if (typeof value !== 'string' || !value.trim() || Array.from(value).length > limits[key]) {
      throw new Error(`生活日报字段 ${key} 为空或超过已验证长度，未发送消息`)
    }
  }
  if (!original.weather?.value || !original.min_temperature?.value || !original.max_temperature?.value) {
    throw new Error('当前天气未能获取，拒绝把空壳日报作为正常内容发送')
  }
  if (!/^\d+$/.test(String(original.love_day?.value || '')) || !original.anniversary_festival?.value) {
    throw new Error('相伴或周年纪念日配置不完整，未发送消息')
  }
  if (/生日/.test(data.n2.value)) throw new Error('纪念日误选为生日，未发送消息')
  for (const [key, source] of [['q1', 'chinese_note'], ['q2', 'english_note']]) {
    const text = String(original[source]?.value || '').replace(/\s+/g, ' ').trim()
    if (!text || data[key].value !== text) throw new Error('每日一句未完整保留，未发送消息')
  }
  if (!data.m2.value.startsWith('—— ')) throw new Error('诗词出处字段不完整，未发送消息')
  return Object.fromEntries(fields.map(key => [key, Array.from(data[key].value).length]))
}

module.exports = { validateTemplate, validateData, fields }
