import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = relative => fs.readFile(new URL(relative, import.meta.url), 'utf8');
const units = Object.fromEntries(await Promise.all(['refresh', 'daily', 'verify'].map(async mode => [mode, await read(`../deploy/recruitment-collector-${mode}.service`)])));
const refreshTimer = await read('../deploy/recruitment-collector-refresh.timer');
const dailyTimer = await read('../deploy/recruitment-collector-daily.timer');
const workflow = await read('../../.github/workflows/qinglong-push.yml');
const bootstrap = await read('../../.github/workflows/recruitment-server-bootstrap.yml');

function directive(source, key) {
  return source.split(/\r?\n/).filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1));
}

// Deliberately inspect one named job at a time: other jobs legitimately need
// Secrets or write permissions, so whole-document forbidden-word checks lie.
function jobSection(source, jobName) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${jobName}:`);
  assert.ok(start >= 0, `缺少工作流任务 ${jobName}`);
  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

function jobCondition(job) {
  const lines = job.split('\n');
  const start = lines.findIndex(line => /^    if:/.test(line));
  assert.ok(start >= 0, '任务必须在最外层检查运行条件');
  const expression = [lines[start].slice(lines[start].indexOf(':') + 1).replace(/^\s*>-?\s*$/, '')];
  for (let index = start + 1; index < lines.length && !/^    [A-Za-z0-9_-]+:/.test(lines[index]); index++) {
    const line = lines[index].trim();
    if (line && !line.startsWith('#')) expression.push(line);
  }
  return expression.join(' ').trim().replace(/\s+/g, ' ');
}

function topSection(source, name) {
  const lines = source.split(/\r?\n/), start = lines.findIndex(line => line === `${name}:`);
  assert.ok(start >= 0, `缺少顶层 ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z0-9_-]+:/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

test('服务器三种模式共用同一非阻塞锁、固定只读代码和专用可写状态', () => {
  const prefix = '/usr/bin/flock --nonblock --conflict-exit-code 75 /var/lib/recruitment-collector/job.lock /opt/recruitment-reader/runtime/node/bin/node /opt/recruitment-collector/current/recruitment/server-run.mjs';
  for (const [mode, unit] of Object.entries(units)) {
    assert.deepEqual(directive(unit, 'Type'), ['oneshot']);
    assert.deepEqual(directive(unit, 'User'), ['recruitment-collector']);
    assert.deepEqual(directive(unit, 'Group'), ['recruitment-collector']);
    assert.deepEqual(directive(unit, 'ExecStart'), [`${prefix} ${mode}`]);
    assert.deepEqual(directive(unit, 'WorkingDirectory'), ['/opt/recruitment-collector/current']);
    assert.deepEqual(directive(unit, 'ReadWritePaths'), ['/var/lib/recruitment-collector/state /var/lib/recruitment-collector/job.lock']);
    assert.ok(directive(unit, 'Environment').includes('RECRUITMENT_STATE_DIR=/var/lib/recruitment-collector/state'));
    assert.ok(directive(unit, 'Environment').includes('TZ=Asia/Shanghai'));
    assert.deepEqual(directive(unit, 'SuccessExitStatus'), ['75']);
    assert.deepEqual(directive(unit, 'Restart'), []);
    assert.deepEqual(directive(unit, 'TimeoutStartSec'), [mode === 'verify' ? '5min' : '20min']);
  }
});

test('服务保护与资源限制保持独立，refresh不读取微信环境文件', () => {
  for (const unit of Object.values(units)) {
    for (const [key, value] of Object.entries({
      ProtectSystem: 'strict', ProtectHome: 'true', NoNewPrivileges: 'true', PrivateTmp: 'true',
      ProtectKernelTunables: 'true', ProtectKernelModules: 'true', ProtectControlGroups: 'true',
      RestrictSUIDSGID: 'true', CapabilityBoundingSet: '', UMask: '0077',
      MemoryHigh: '384M', MemoryMax: '512M', CPUQuota: '50%', TasksMax: '64',
      StandardOutput: 'journal', StandardError: 'journal',
    })) assert.deepEqual(directive(unit, key), [value], `${key}保护契约变化`);
  }
  assert.deepEqual(directive(units.refresh, 'EnvironmentFile'), ['/etc/recruitment-collector/site.env']);
  assert.deepEqual(directive(units.daily, 'EnvironmentFile'), ['/etc/recruitment-collector/collector.env']);
  assert.deepEqual(directive(units.verify, 'EnvironmentFile'), ['/etc/recruitment-collector/collector.env']);
});

test('北京时间定时器保留日间刷新和三次有界日报机会，补跑无随机延迟', () => {
  assert.deepEqual(directive(refreshTimer, 'OnCalendar'), ['*-*-* 03,09,13,17,21:17:00 Asia/Shanghai']);
  assert.deepEqual(directive(dailyTimer, 'OnCalendar'), [
    '*-*-* 07:30:00 Asia/Shanghai', '*-*-* 08:00:00 Asia/Shanghai', '*-*-* 08:30:00 Asia/Shanghai',
  ]);
  for (const [timer, name] of [[refreshTimer, 'refresh'], [dailyTimer, 'daily']]) {
    assert.deepEqual(directive(timer, 'Persistent'), ['true']);
    assert.deepEqual(directive(timer, 'AccuracySec'), ['30s']);
    assert.deepEqual(directive(timer, 'RandomizedDelaySec'), ['0']);
    assert.deepEqual(directive(timer, 'Unit'), [`recruitment-collector-${name}.service`]);
    assert.deepEqual(directive(timer, 'WantedBy'), ['timers.target']);
  }
});

test('服务器拥有发送权时GitHub正式及手动发送任务均受任务级所有权门禁', () => {
  for (const name of ['daily-digest', 'test-wechat']) {
    const condition = jobCondition(jobSection(workflow, name));
    assert.match(condition, /^vars\.RECRUITMENT_SENDER_OWNER != 'server' &&/);
  }
});

test('服务器所有权诊断任务仅限无密钥只读采集，不发布、不发送也不带写令牌', () => {
  const job = jobSection(workflow, 'server-diagnostic'), condition = jobCondition(job);
  assert.match(condition, /^vars\.RECRUITMENT_SENDER_OWNER == 'server' &&/);
  for (const guard of ['inputs.dry_run', '!inputs.test_wechat', '!inputs.daily_preview', '!inputs.publish_web_preview']) assert.ok(condition.includes(guard));
  assert.match(job, /^    permissions:\n      contents: read$/m);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /run: node recruitment\/run\.mjs --dry-run\s*$/m);
  assert.doesNotMatch(job, /secrets\.|github\.token|GITHUB_TOKEN:|GH_TOKEN:|contents:\s*write/);
  assert.doesNotMatch(job, /github-state\.mjs|publish-web\.mjs|check-wechat\.mjs|--send-only|--collect-only|--send-test|--send-daily-preview/);
});

test('凭据桥仅手动、固定仓库和master、有显式armed与匹配指纹门禁', () => {
  const events = [...topSection(bootstrap, 'on').matchAll(/^  ([A-Za-z0-9_-]+):/gm)].map(match => match[1]);
  assert.deepEqual(events, ['workflow_dispatch']);
  assert.match(topSection(bootstrap, 'permissions'), /contents: read/);
  const job = jobSection(bootstrap, 'seal'), condition = jobCondition(job);
  for (const guard of [
    "github.repository == 'haoqu009-sketch/wechat-public-account-push'",
    "github.ref == 'refs/heads/master'",
    "vars.RECRUITMENT_BOOTSTRAP_ARMED == 'true'",
    'vars.RECRUITMENT_BOOTSTRAP_FINGERPRINT == inputs.fingerprint',
    "vars.RECRUITMENT_SENDER_OWNER != 'server'",
  ]) assert.ok(condition.includes(guard), `缺少凭据桥保护 ${guard}`);
  assert.match(job, /env\.GITHUB_REF !== 'refs\/heads\/master'/);
  assert.match(job, /env\.GITHUB_REPOSITORY !== 'haoqu009-sketch\/wechat-public-account-push'/);
  assert.match(job, /fingerprint: env\.BOOTSTRAP_FINGERPRINT/);
  assert.match(job, /persist-credentials: false/);
  assert.doesNotMatch(job, /PRIVATE_KEY:|BEGIN (?:RSA )?PRIVATE KEY|contents:\s*write/);
});

test('凭据桥只上传单个密文文件且保留1天，不打印或上传原始配置', () => {
  const job = jobSection(bootstrap, 'seal');
  const upload = job.slice(job.indexOf('      - uses: actions/upload-artifact@'));
  assert.ok(upload.length < job.length && upload.length > 0, '必须使用独立密文artifact上传步骤');
  assert.match(upload, /^          path: encrypted-bootstrap\/envelope\.json$/m);
  assert.match(upload, /^          retention-days: 1$/m);
  assert.match(upload, /^          if-no-files-found: error$/m);
  assert.match(job, /sealCredentials\(readWechatConfig\(env\), publicPem/);
  assert.match(job, /JSON\.stringify\(envelope\)/);
  assert.doesNotMatch(job, /JSON\.stringify\((?:env|process\.env|config)\)|console\.(?:log|error)\((?:env|process\.env|config|envelope|publicPem)/);
  assert.doesNotMatch(job, /--send-only|--send-test|--send-daily-preview|github-state\.mjs|publish-web\.mjs/);
  assert.doesNotMatch(upload, /if:\s*always\(\)|\.env|state\.json|\*\*/);
});
