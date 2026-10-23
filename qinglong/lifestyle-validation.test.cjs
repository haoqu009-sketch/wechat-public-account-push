const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateTemplate, validateData, fields } = require('./lifestyle-validation.cjs')
const content = fields.map(key => `{{${key}.DATA}}`).join('\n')
test('accepts the original eight-field lifestyle template', () => {
  assert.doesNotThrow(() => validateTemplate({ title: '每日小报', content }))
})
for (const [name, template] of Object.entries({
  recruitment: { title: '医学影像招聘日报', content },
  missing: { content: '{{a.DATA}}' },
  duplicate: { content: content + '\n{{q1.DATA}}' },
  unknown: { content: content + '\n{{tip.DATA}}' },
  broken: { content: content + '\n{{' },
  corrupt: { content: content + '\uFFFD' },
})) test(`rejects ${name} template`, () => assert.throws(() => validateTemplate(template)))
const original = {
  weather: {value:'晴'}, min_temperature:{value:'0'}, max_temperature:{value:'10'},
  love_day:{value:'1000'}, anniversary_festival:{value:'周年纪念日还有10天'},
  chinese_note:{value:'为重要的事留时间。'}, english_note:{value:'Make time for what matters.'},
}
const data = Object.fromEntries(fields.map(key => [key, {value:'完整内容'}]))
Object.assign(data, {n2:original.anniversary_festival, q1:original.chinese_note, q2:original.english_note, m2:{value:'—— 王维《山居秋暝》'}})
test('accepts complete content without cutting bilingual text', () => assert.equal(validateData(data, original).q2, 27))
test('rejects empty weather', () => assert.throws(() => validateData(data, {...original, weather:undefined})))
test('rejects missing anniversary', () => assert.throws(() => validateData(data, {...original, anniversary_festival:undefined})))
test('rejects birthday substitution', () => assert.throws(() => validateData({...data,n2:{value:'生日还有10天'}},original)))
test('rejects truncated English', () => assert.throws(() => validateData({...data,q2:{value:'Make time...'}},original)))
test('rejects overlong field', () => assert.throws(() => validateData({...data,q1:{value:'长'.repeat(61)}},original)))
