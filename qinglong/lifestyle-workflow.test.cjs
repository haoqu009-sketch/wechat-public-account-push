const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflowDirectory = path.resolve(__dirname, '../.github/workflows')
const read = name => fs.readFileSync(path.join(workflowDirectory, name), 'utf8').replace(/\r\n/g, '\n')
const main = read('lifestyle-push.yml')
const audit = fs.existsSync(path.join(workflowDirectory, 'lifestyle-schedule-audit.yml')) ? read('lifestyle-schedule-audit.yml') : null

function topSection(source, name) {
  const lines = source.split('\n'), start = lines.findIndex(line => line.startsWith(`${name}:`))
  if (start < 0) return ''
  let end = start + 1
  while (end < lines.length && !/^[A-Za-z0-9_-]+:/.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

function jobs(source) {
  const result = new Map(), lines = topSection(source, 'jobs').split('\n')
  for (let index = 1; index < lines.length; index++) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[index])
    if (!match) continue
    let end = index + 1
    while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++
    result.set(match[1], lines.slice(index, end).join('\n'))
    index = end - 1
  }
  return result
}

function condition(job) {
  const lines = job.split('\n'), start = lines.findIndex(line => /^    if:/.test(line))
  if (start < 0) return ''
  const pieces = [lines[start].slice(lines[start].indexOf(':') + 1).replace(/^\s*>-?\s*$/, '')]
  for (let index = start + 1; index < lines.length && !/^    [A-Za-z0-9_-]+:/.test(lines[index]); index++) {
    const line = lines[index].trim()
    if (line && !line.startsWith('#')) pieces.push(line)
  }
  return pieces.join(' ').trim().replace(/\s+/g, ' ')
}

function crons(source) {
  return [...topSection(source, 'on').matchAll(/^\s*- cron:\s*(['"])([^'"]+)\1\s*$/gm)].map(match => match[2])
}

function group(source) {
  return /^  group:\s*(.+)$/m.exec(topSection(source, 'concurrency'))?.[1]?.trim()
}

function assertReadOnlyObservation(job, inheritedPermissions) {
  assert.ok(/^    permissions:\s*\{\}\s*$/m.test(job) || /^permissions:\s*\{\}\s*$/m.test(inheritedPermissions), '观测任务必须声明空权限或继承空权限')
  assert.doesNotMatch(job, /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|PRIVATE_KEY|contents:\s*write/)
  assert.doesNotMatch(job, /uses:\s*actions\/checkout@|\bgit\s+clone\b/i)
  assert.doesNotMatch(job, /--send(?:\s|$)|sendWeChatTemplate|sendTemplateMessage|message\/template\/send|api\.weixin\.qq\.com/)
  assert.doesNotMatch(job, /\b(?:curl|wget|npm|npx|node|python|ssh|scp)\s+/)
  assert.match(job, /date -u \+%Y-%m-%d/)
  assert.match(job, /\b20\d{2}-\d{2}-\d{2}\b/, '临时观测必须有完整日期门禁，避免次年误跑')
  assert.match(job, /SCHEDULE_(?:OBSERVATION|AUDIT)/)
}

const mainJobs = jobs(main)
const production = mainJobs.get('lifestyle')
const dailyCrons = crons(main).filter(cron => /^17 21 \* \* (?:\*|0-6)$/.test(cron))

test('手动运行默认不发送，只有显式send_now或正式定时才选择发送模式', () => {
  const events = topSection(main, 'on')
  assert.match(events, /^  workflow_dispatch:/m)
  const lines = events.split('\n'), start = lines.indexOf('      send_now:')
  assert.ok(start >= 0)
  let end = start + 1
  while (end < lines.length && (!lines[end].trim() || /^ {7,}/.test(lines[end]))) end++
  const input = lines.slice(start, end).join('\n')
  assert.match(input, /^        type: boolean$/m)
  assert.match(input, /^        default: false$/m)
  assert.ok(production, '必须保留生活日报任务')
  assert.match(production, /SEND_LIFESTYLE: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.send_now \}\}/)
  assert.match(production, /if \[ "\$SEND_LIFESTYLE" = "true" \]; then\s+node qinglong\/lifestyle-runner\.cjs --send\s+else\s+node qinglong\/lifestyle-runner\.cjs --validate-only\s+fi/)
  assert.equal((production.match(/lifestyle-runner\.cjs --send\b/g) || []).length, 1)
})

test('唯一正式每日cron保留UTC21:17，即次日北京时间05:17', () => {
  assert.equal(dailyCrons.length, 1)
  assert.equal((21 * 60 + 17 + 8 * 60) % (24 * 60), 5 * 60 + 17)
  const fields = dailyCrons[0].split(' ')
  assert.deepEqual(fields.slice(0, 4), ['17', '21', '*', '*'])
  assert.ok(['*', '0-6'].includes(fields[4]))
})

test('生活任务只接受明确正式cron和开启标志，临时观测绝不进入发送任务', () => {
  assert.equal(dailyCrons.length, 1)
  const expected = `github.event_name == 'workflow_dispatch' || (github.event_name == 'schedule' && github.event.schedule == '${dailyCrons[0]}' && vars.LIFESTYLE_PUSH_ENABLED == 'true')`
  assert.equal(condition(production), expected)
  for (const cron of crons(main).filter(value => !dailyCrons.includes(value))) {
    assert.ok(!condition(production).includes(`github.event.schedule == '${cron}'`))
    assert.ok([...mainJobs.entries()].some(([name, job]) => name !== 'lifestyle' && condition(job).includes(`github.event.schedule == '${cron}'`)), '每个临时cron必须对应只读观测任务')
  }
})

test('主工作流所有观测任务均空权限、无Secrets、无checkout且不调用发送或网络工具', () => {
  assert.doesNotMatch(main.slice(0, main.indexOf('\njobs:')), /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/, '不能给只读观测继承全局凭据')
  for (const [name, job] of mainJobs) {
    if (name === 'lifestyle') continue
    assertReadOnlyObservation(job, topSection(main, 'permissions'))
    assert.match(condition(job), /^github\.event_name == 'schedule' && github\.event\.schedule == '[^']+'$/)
  }
})

test('两个观测工作流的并发组互相隔离；清理后允许独立观测文件不存在', () => {
  assert.equal(group(main), 'lifestyle-wechat-push')
  assert.match(topSection(main, 'concurrency'), /^  cancel-in-progress: false$/m)
  if (!audit) return
  assert.ok(group(audit), '独立审计必须声明并发组')
  assert.notEqual(group(audit), group(main))
  assert.match(topSection(audit, 'concurrency'), /^  cancel-in-progress: false$/m)
})

test('独立审计若仍存在，只运行有完整日期门禁的无密钥日志任务', () => {
  if (!audit) return
  assert.match(topSection(audit, 'permissions'), /^permissions:\s*\{\}\s*$/m)
  assert.doesNotMatch(audit, /secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|PRIVATE_KEY/)
  const auditJobs = jobs(audit)
  assert.ok(auditJobs.size > 0)
  for (const job of auditJobs.values()) assertReadOnlyObservation(job, topSection(audit, 'permissions'))
  for (const cron of crons(audit)) {
    const fields = cron.split(/\s+/)
    assert.equal(fields.length, 5)
    assert.match(fields[0], /^\d+(?:,\d+)*$/)
    assert.ok(fields[0].split(',').every(minute => Number(minute) >= 0 && Number(minute) < 60))
    assert.match(fields[1], /^\d{1,2}$/)
    assert.match(fields[2], /^\d{1,2}$/)
    assert.match(fields[3], /^\d{1,2}$/)
    assert.equal(fields[4], '*')
  }
})
