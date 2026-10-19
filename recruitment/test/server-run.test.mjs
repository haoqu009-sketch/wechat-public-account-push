import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serverRun } from '../server-run.mjs';
import { run as actualRun, atomicJson } from '../run.mjs';
import { jobFrom, chinaDate } from '../core.mjs';
import { recipientKey } from '../wechat.mjs';

const day = chinaDate();
const reportId = 'a'.repeat(24), base = 'https://jobs.example.com';
const localTime = (time = '07:40') => new Date(`${day}T${time}:00+08:00`);
const published = () => ({ published: true, reportId, reportUrl: `${base}/?report=${reportId}` });
const temp = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'server-run-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await atomicJson(path.join(dir, 'state.json'), { version: 1, jobs: {}, recipients: {} });
  return dir;
};
const envFor = dir => ({
  RECRUITMENT_STATE_DIR: dir, RECRUITMENT_PUBLIC_BASE_URL: base, RECRUITMENT_SITE_SYNC_TOKEN: 'not-real-only-for-tests-sync-token-32-chars', RECRUITMENT_SENDER_OWNER: 'server',
  ALL_CONFIG: JSON.stringify({ APP_ID: 'not-real', APP_SECRET: 'private-test-secret', USER_INFO: [{ id: 'first', wechatTemplateId: 'template' }, { id: 'second', wechatTemplateId: 'template' }] }),
});
const silent = { log: () => {}, now: () => localTime() };
const missingMarker = async dir => assert.rejects(fs.stat(path.join(dir, 'server-control.json')), { code: 'ENOENT' });
const snapshotFiles = async dir => (await fs.readdir(path.join(dir, 'backups'))).filter(name => /^state-\d{8}T\d{9}Z-[a-f0-9-]{36}\.json$/.test(name));

test('refresh和daily在run前拒绝缺失或损坏state，不创建空去重状态或备份', async t => {
  const dir = await temp(t), env = envFor(dir), stateFile = path.join(dir, 'state.json');
  const invalid = [null, '{bad-json', JSON.stringify({ version: 2, jobs: {}, recipients: {} }), JSON.stringify({ version: 1, jobs: [], recipients: {} }), JSON.stringify({ version: 1, jobs: {}, recipients: { unexpected: { sent: {} } } })];
  for (const content of invalid) {
    if (content === null) await fs.unlink(stateFile);
    else await fs.writeFile(stateFile, content);
    for (const mode of ['refresh', 'daily']) {
      await assert.rejects(serverRun(mode, env, { ...silent,
        run: async () => assert.fail('无有效原状态不能进入run'),
        publishWeb: async () => assert.fail('无有效原状态不能发布'),
      }), /服务器招聘任务未完成/);
    }
    await assert.rejects(fs.stat(path.join(dir, 'backups')), { code: 'ENOENT' });
  }
});

test('任务前完整原字节备份到私有固定目录，不修改pending或写入公开reports', async t => {
  const dir = await temp(t), env = envFor(dir);
  const raw = ' \n{\n  "version": 1, "jobs": {}, "recipients": {"private-recipient": {"sent": {"old": {"fingerprint":"kept"}}, "reminded": {}}}\n}\n';
  await fs.writeFile(path.join(dir, 'state.json'), raw);
  await fs.writeFile(path.join(dir, 'pending.json'), 'never-change-pending');
  await serverRun('refresh', env, { ...silent, run: async () => {}, publishWeb: async () => published() });
  const files = await snapshotFiles(dir);
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(path.join(dir, 'backups', files[0]), 'utf8'), raw);
  assert.equal(await fs.readFile(path.join(dir, 'pending.json'), 'utf8'), 'never-change-pending');
  await assert.rejects(fs.stat(path.join(dir, 'reports')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(dir, 'backups'))).some(name => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(dir, 'backups'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dir, 'backups', files[0]))).mode & 0o777, 0o600);
  }
});

test('备份只保留最近30份自有快照，不删除备份目录其他文件', async t => {
  const dir = await temp(t), env = envFor(dir), backupDir = path.join(dir, 'backups');
  await fs.mkdir(backupDir);
  await fs.writeFile(path.join(backupDir, 'notes.json'), 'keep-user-file');
  for (let index = 0; index < 35; index++) {
    await atomicJson(path.join(dir, 'state.json'), { version: 1, jobs: { [`job${index}`]: { id: `job${index}` } }, recipients: {} });
    await serverRun('refresh', env, { ...silent, now: () => new Date(localTime().getTime() + index * 1000), run: async () => {}, publishWeb: async () => published() });
  }
  const files = await snapshotFiles(dir);
  assert.equal(files.length, 30);
  const retained = await Promise.all(files.map(async name => Number(Object.keys(JSON.parse(await fs.readFile(path.join(backupDir, name), 'utf8')).jobs)[0].slice(3))));
  assert.deepEqual(retained.sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => index + 5));
  assert.equal(await fs.readFile(path.join(backupDir, 'notes.json'), 'utf8'), 'keep-user-file');
});

test('采集后发送前再次拒绝损坏状态；发送后损坏状态不替换既有有效备份', async t => {
  for (const corruptAt of ['--collect-only', '--send-only']) {
    const dir = await temp(t), env = envFor(dir), stateFile = path.join(dir, 'state.json'), calls = [];
    const original = await fs.readFile(stateFile, 'utf8');
    await assert.rejects(serverRun('daily', env, { ...silent,
      run: async args => {
        calls.push(args[0]);
        if (args[0] === corruptAt) {
          await fs.writeFile(stateFile, '{corrupt-private-state');
          if (corruptAt === '--send-only') throw new Error('private-send-failure');
        }
      }, publishWeb: async () => published(),
    }), /服务器招聘任务未完成/);
    assert.deepEqual(calls, corruptAt === '--collect-only' ? ['--collect-only'] : ['--collect-only', '--send-only']);
    const files = await snapshotFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(await fs.readFile(path.join(dir, 'backups', files[0]), 'utf8'), original);
    await missingMarker(dir);
  }
});

test('拒绝符号链接备份目录，不沿链接写出state目录', async t => {
  const dir = await temp(t), env = envFor(dir), backupDir = path.join(dir, 'backups');
  await assert.rejects(serverRun('refresh', env, { ...silent,
    fs: { ...fs, lstat: async file => file === backupDir ? { isDirectory: () => true, isSymbolicLink: () => true } : fs.lstat(file) },
    run: async () => assert.fail('不安全备份目录不能进入run'), publishWeb: async () => assert.fail('不安全备份目录不能发布'),
  }), /服务器招聘任务未完成/);
  assert.deepEqual(await fs.readdir(backupDir), []);
});

test('refresh只调用持久化采集与公开发布，无微信配置也不发送或覆盖pending', async t => {
  const dir = await temp(t), env = envFor(dir), calls = [];
  delete env.ALL_CONFIG;
  const recipients = { [recipientKey({ openId: 'first' })]: { sent: { kept: { fingerprint: 'old' } }, reminded: { kept: '2026-10-31' } } };
  await atomicJson(path.join(dir, 'state.json'), { version: 1, jobs: {}, recipients });
  await fs.writeFile(path.join(dir, 'pending.json'), 'keep-existing-morning-plan');
  const result = await serverRun('refresh', env, { ...silent,
    run: async (args, scoped) => {
      calls.push(args);
      assert.deepEqual(args, ['--refresh-only']);
      assert.equal(scoped.ALL_CONFIG, undefined);
      const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
      state.jobs.new = { id: 'new' };
      await atomicJson(path.join(dir, 'state.json'), state);
    },
    publishWeb: async () => { calls.push('publish'); return published(); },
  });
  assert.equal(result.refreshed, true);
  assert.deepEqual(calls, [['--refresh-only'], 'publish']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).recipients, recipients);
  assert.equal(await fs.readFile(path.join(dir, 'pending.json'), 'utf8'), 'keep-existing-morning-plan');
  await missingMarker(dir);
});

test('真实refresh无需微信配置，保存岗位而不改变接收人或pending，仍保留下一次晨报候选', async t => {
  for (const hasPending of [false, true]) {
    const dir = await temp(t), env = envFor(dir), wechatConfig = env.ALL_CONFIG;
    delete env.ALL_CONFIG;
    const recipients = { [recipientKey({ openId: 'first' })]: { sent: { previouslyDelivered: { fingerprint: 'old' } }, reminded: { previousReminder: '2026-10-31' } } };
    await atomicJson(path.join(dir, 'state.json'), { version: 1, jobs: {}, recipients });
    if (hasPending) await fs.writeFile(path.join(dir, 'pending.json'), 'preserve-existing-pending');
    const job = jobFrom('岗位代码：CT1；岗位名称：放射科医师；学历：硕士；专业：医学影像学；条件：2027届，CT方向', {
      title: '2027届招聘公告', url: 'https://hospital.example/job/1', text: '', published: day,
    }, { name: '测试医院', province: '黑龙江' }, { graduationYear: 2027, preferredProvince: '黑龙江' }, 1);
    assert.ok(job);
    const runServices = {
      collect: async () => ({ jobs: [job], coverage: [{ name: '测试医院', ok: true, articles: 1, warnings: [] }], observedPages: [job.url] }),
      getAccessToken: async () => assert.fail('refresh不能读取微信token'),
      sendDigest: async () => assert.fail('refresh不能发送消息'),
    };
    const result = await serverRun('refresh', env, { ...silent, run: actualRun, runServices,
      publishWeb: async () => {
        const report = JSON.parse(await fs.readFile(path.join(dir, 'reports/public.json'), 'utf8'));
        assert.equal(report.schemaVersion, 1);
        return published();
      },
    });
    assert.equal(result.refreshed, true);
    const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(state.jobs[job.id].collectedAt, day);
    assert.deepEqual(state.recipients, recipients);
    if (hasPending) assert.equal(await fs.readFile(path.join(dir, 'pending.json'), 'utf8'), 'preserve-existing-pending');
    else await assert.rejects(fs.stat(path.join(dir, 'pending.json')), { code: 'ENOENT' });
    await missingMarker(dir);
    // A subsequent real morning collection still sees the unsent job for each user.
    await actualRun(['--collect-only'], { ...env, ALL_CONFIG: wechatConfig }, runServices);
    const pending = JSON.parse(await fs.readFile(path.join(dir, 'pending.json'), 'utf8'));
    for (const openId of ['first', 'second']) {
      assert.ok(pending.digests[recipientKey({ openId })].physicians.some(candidate => candidate.id === job.id));
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).recipients, recipients);
  }
});

test('daily必须先重新采集再成功公开回读才允许发送；无GitHub回退', async t => {
  const dir = await temp(t), env = { ...envFor(dir), GITHUB_REPOSITORY: 'private/repo', GITHUB_TOKEN: 'private', GITHUB_OUTPUT: 'private-output' }, order = [];
  const result = await serverRun('daily', env, { ...silent,
    run: async (args, scoped) => {
      order.push(args[0]);
      for (const key of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_OUTPUT']) assert.equal(scoped[key], undefined);
      if (args[0] === '--send-only') assert.equal(scoped.RECRUITMENT_REPORT_URL, `${base}/?report=${reportId}`);
    },
    publishWeb: async scoped => { order.push('publish-verified'); assert.equal(scoped.GITHUB_REPOSITORY, undefined); return published(); },
  });
  assert.deepEqual(order, ['--collect-only', 'publish-verified', '--send-only']);
  assert.equal(result.complete, true);
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'server-control.json'), 'utf8'));
  assert.equal(marker.dailyDate, day);
  assert.equal(marker.reportId, reportId);
  const next = await serverRun('daily', env, { ...silent, run: async () => assert.fail('已完成晨报不能再次采集发送'), publishWeb: async () => assert.fail('已完成不能重复发布') });
  assert.equal(next.skipped, 'daily-already-complete');
});

test('发布失败、回退旧地址或错误reportId时daily绝不调用发送', async t => {
  const dir = await temp(t), env = envFor(dir);
  for (const outcome of [
    { published: false, reportUrl: 'https://github.com/private/repo' },
    { ...published(), reportUrl: 'https://other.example/?report=private' },
    { ...published(), reportId: '../private' },
  ]) {
    const calls = [];
    await assert.rejects(serverRun('daily', env, { ...silent, run: async args => { calls.push(args[0]); }, publishWeb: async () => outcome }), /服务器招聘任务未完成/);
    assert.deepEqual(calls, ['--collect-only']);
    await missingMarker(dir);
  }
});

test('所有者开关、默认07:30-09:30窗口与采集跨窗阻止意外补发', async t => {
  const dir = await temp(t), env = envFor(dir), never = async () => assert.fail('不允许进入采集或发送');
  await assert.rejects(serverRun('daily', { ...env, RECRUITMENT_SENDER_OWNER: 'github' }, { ...silent, run: never }), /服务器招聘任务未完成/);
  for (const time of ['00:01', '07:29', '09:31', '23:59']) {
    const result = await serverRun('daily', env, { ...silent, now: () => localTime(time), run: never });
    assert.equal(result.skipped, 'outside-daily-window');
  }
  const times = [localTime('09:29'), localTime('09:31')], calls = [];
  const crossed = await serverRun('daily', env, { ...silent, now: () => times.shift(), run: async args => { calls.push(args[0]); }, publishWeb: async () => published() });
  assert.equal(crossed.skipped, 'daily-window-ended');
  assert.deepEqual(calls, ['--collect-only']);
  await missingMarker(dir);
  for (const value of ['-1', '121', 'NaN']) await assert.rejects(serverRun('daily', { ...env, RECRUITMENT_DAILY_CATCHUP_MINUTES: value }, { ...silent, run: never }), /服务器招聘任务未完成/);
});

test('verify读取去重状态和模板，允许新增收件人空状态，不发送不写入', async t => {
  const dir = await temp(t), env = envFor(dir), firstKey = recipientKey({ openId: 'first' });
  const state = { version: 1, jobs: {}, recipients: { [firstKey]: { sent: {}, reminded: {} } } };
  await atomicJson(path.join(dir, 'state.json'), state);
  const before = await fs.readFile(path.join(dir, 'state.json'), 'utf8'), calls = [];
  const result = await serverRun('verify', env, { ...silent,
    run: async () => assert.fail('verify不采集/发送'), publishWeb: async () => assert.fail('verify不发布'),
    getAccessToken: async settings => { calls.push('token-read'); assert.equal(settings.users.length, 2); return 'not-real-token'; },
    validateTemplates: async (settings, token) => { calls.push('template-read'); assert.equal(token, 'not-real-token'); return { templateCount: 1, recipientCount: settings.users.length }; },
  });
  assert.equal(result.verified, true);
  assert.equal(result.recipientCount, 2);
  assert.equal(result.stateRecipientCount, 1);
  assert.deepEqual(calls, ['token-read', 'template-read']);
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), before);
  await missingMarker(dir);
});

test('verify遇损坏状态、迁移多余接收人或模板数量异常时固定安全失败', async t => {
  const dir = await temp(t), env = envFor(dir), logs = [];
  const services = { ...silent, log: line => logs.push(line), getAccessToken: async () => 'private', validateTemplates: async () => ({ templateCount: 1, recipientCount: 2 }) };
  await fs.writeFile(path.join(dir, 'state.json'), '{"secret":"private"');
  await assert.rejects(serverRun('verify', env, services), error => /服务器招聘任务未完成/.test(error.message) && !/private/.test(error.message));
  await atomicJson(path.join(dir, 'state.json'), { version: 1, jobs: {}, recipients: { unexpected: { sent: {}, reminded: {} } } });
  await assert.rejects(serverRun('verify', env, services), /服务器招聘任务未完成/);
  await atomicJson(path.join(dir, 'state.json'), { version: 1, jobs: {}, recipients: {} });
  await assert.rejects(serverRun('verify', env, { ...services, validateTemplates: async () => ({ templateCount: 1, recipientCount: 99 }) }), /服务器招聘任务未完成/);
  assert.deepEqual(logs, []);
});

test('底层异常与路径或凭据不会透传到入口错误或日志', async t => {
  const dir = await temp(t), env = envFor(dir), logs = [];
  await assert.rejects(serverRun('refresh', env, { ...silent, log: line => logs.push(line), run: async () => { throw new Error('private-test-secret https://example/?token=private'); } }), error => !/private|https|token/.test(error.message));
  assert.deepEqual(logs, []);
  await assert.rejects(serverRun('refresh', { ...env, RECRUITMENT_PUBLIC_BASE_URL: 'http://example.com' }, silent), /服务器招聘任务未完成/);
  await assert.rejects(serverRun('unknown', env, silent), /服务器招聘任务未完成/);
});

test('进程内队列串行化；并发daily在成功marker后不再进入run', async t => {
  const dir = await temp(t), env = envFor(dir), calls = [];
  const services = { ...silent, run: async args => { calls.push(args[0]); await new Promise(resolve => setTimeout(resolve, 5)); }, publishWeb: async () => published() };
  const results = await Promise.all([serverRun('daily', env, services), serverRun('daily', env, services)]);
  assert.equal(results.filter(result => result.complete).length, 1);
  assert.equal(results.filter(result => result.skipped === 'daily-already-complete').length, 1);
  assert.deepEqual(calls, ['--collect-only', '--send-only']);
});

test('使用真实run完成部分失败及重试，仅重试失败接收人且全成功后写每日marker', async t => {
  const dir = await temp(t), env = envFor(dir), calls = [];
  const profile = { graduationYear: 2027, preferredProvince: '黑龙江' };
  const job = jobFrom('岗位代码：CT1；岗位名称：放射科医师；学历：硕士；专业：医学影像学；条件：2027届，CT方向', {
    title: '2027届招聘公告', url: 'https://hospital.example/job/1', text: '', published: day,
  }, { name: '测试医院', province: '黑龙江' }, profile, 1);
  let failSecond = true;
  const services = { ...silent, run: actualRun, publishWeb: async () => published(), runServices: {
    collect: async () => ({ jobs: [job], coverage: [{ name: '测试医院', ok: true, articles: 1, warnings: [] }], observedPages: [job.url] }),
    getAccessToken: async () => 'not-real-token',
    sendDigest: async user => { calls.push(user.openId); if (user.openId === 'second' && failSecond) throw new Error('simulated-safe-error'); },
  } };
  await assert.rejects(serverRun('daily', env, services), /服务器招聘任务未完成/);
  await missingMarker(dir);
  const afterFailure = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.ok(afterFailure.recipients[recipientKey({ openId: 'first' })].sent[job.id]);
  assert.equal(afterFailure.recipients[recipientKey({ openId: 'second' })], undefined);
  const afterFailureBackups = await Promise.all((await snapshotFiles(dir)).map(async name => JSON.parse(await fs.readFile(path.join(dir, 'backups', name), 'utf8'))));
  assert.equal(afterFailureBackups.length, 2);
  assert.ok(afterFailureBackups.some(snapshot => snapshot.recipients[recipientKey({ openId: 'first' })]?.sent[job.id] && !snapshot.recipients[recipientKey({ openId: 'second' })]));
  failSecond = false;
  await serverRun('daily', env, services);
  assert.deepEqual(calls, ['first', 'second', 'second']);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'server-control.json'), 'utf8')).dailyDate, day);
  const successBackups = await Promise.all((await snapshotFiles(dir)).map(async name => JSON.parse(await fs.readFile(path.join(dir, 'backups', name), 'utf8'))));
  assert.equal(successBackups.length, 4);
  assert.ok(successBackups.some(snapshot => snapshot.recipients[recipientKey({ openId: 'first' })]?.sent[job.id] && snapshot.recipients[recipientKey({ openId: 'second' })]?.sent[job.id]));
});
