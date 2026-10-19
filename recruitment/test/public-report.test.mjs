import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicReport } from '../public-report.mjs';
import { chinaDate, jobFrom } from '../core.mjs';
import { run, atomicJson, loadState } from '../run.mjs';
import { sync } from '../github-state.mjs';
import { recipientKey } from '../wechat.mjs';

const today = '2026-10-19';
const generatedAt = '2026-10-19T01:00:00.000Z';
const source = { id: 'hospital', name: '测试医院', province: '黑龙江', url: 'https://hospital.example/jobs', allowedHosts: ['hospital.example'] };
const config = {
  profile: { graduationYear: 2027, degree: '硕士', specialty: '医学影像学', focus: 'CT', preferredProvince: '黑龙江' },
  maxPhysicians: 1, maxTechnicians: 1, maxReminders: 1, reminderDays: 3, lookbackDays: 90, sources: [source],
};
const coverage = [{ name: source.name, ok: true, articles: 1, warnings: [] }];
const base = () => ({
  ...jobFrom('岗位代码：CT1；岗位名称：放射科医师；学历：硕士；专业：医学影像学；条件：2027届、CT方向',
    { title: '2027届招聘', url: 'https://hospital.example/job/1', published: today, text: '' }, source, config.profile, 1),
  collectedAt: today, deadline: '2026-11-01',
});
const digest = (jobs = []) => ({ today, physicians: jobs, technicians: [], reminders: [] });
const report = (overrides = {}) => createPublicReport({ jobs: [base()], digest: digest([base()]), coverage, config, generatedAt, ...overrides });
const temporary = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'public-recruitment-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const shift = (value, days) => new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

test('公共报告采用显式白名单，不包含收件人、密钥、内部指纹、去重记录或任意诊断正文', () => {
  const secret = 'PRIVATE_SENTINEL_NOT_PUBLIC';
  const result = report({
    jobs: [{ ...base(), openId: secret, token: secret, secret, fingerprint: secret, legacyIds: [secret], recipients: { [secret]: {} }, pending: secret, unlistedField: secret }],
    digest: { ...digest([base()]), recipients: secret, token: secret, state: secret },
    config: { ...config, APP_SECRET: secret, sources: [{ ...source, apiKey: secret }] },
    coverage: [{ ...coverage[0], error: secret, token: secret, warnings: [`unrecognized ${secret}`] }],
  });
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'reportId', 'reportDate', 'generatedAt', 'summary', 'jobs', 'sources']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  for (const key of ['fingerprint', 'legacyIds', 'qualificationEvidence', 'openId', 'token', 'secret', 'recipients', 'pending', 'unlistedField']) assert.equal(Object.hasOwn(result.jobs[0], key), false);
  assert.equal(result.jobs[0].focusMatch, 'ct');
  assert.match(result.jobs[0].priorityLabel, /CT/);
  assert.match(result.jobs[0].qualityReasons.join('；'), /CT/);
});

test('网页保留已发送岗位及完整在招列表，不受日报通知上限影响', () => {
  const jobs = Array.from({ length: 7 }, (_, index) => ({ ...base(), id: `job-${index}`, url: `https://hospital.example/job/${index}` }));
  const result = report({ jobs, digest: digest() });
  assert.equal(result.jobs.length, 7);
  assert.equal(result.summary.activeCount, 7);
  assert.equal(result.summary.newCount, 0);
  assert.ok(result.jobs.every(job => job.isNew === false));
});

test('排除已截止或明确不符合岗位，截止未知保留并标明局限', () => {
  const result = report({ jobs: [
    { ...base(), id: 'active-today', deadline: today },
    { ...base(), id: 'expired', deadline: '2026-10-18' },
    { ...base(), id: 'excluded', excluded: '博士学历' },
    { ...base(), id: 'unknown-deadline', deadline: null },
  ] });
  assert.deepEqual(new Set(result.jobs.map(job => job.id)), new Set(['active-today', 'unknown-deadline']));
  assert.match(result.summary.limitations.join('；'), /未识别明确截止日期.*不能据此确认仍可报名/);
});

test('官方地址必须为配置域名的HTTPS且不含用户名密码或敏感查询参数', () => {
  const bad = ['http://hospital.example/job', 'https://user:password@hospital.example/job', 'https://evil.example/job', 'https://hospital.example:8443/job', 'https://hospital.example/job?access_token=private'];
  const jobs = [base(), ...bad.map((url, index) => ({ ...base(), id: `bad-${index}`, url }))];
  const result = report({ jobs });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].url, 'https://hospital.example/job/1');
  assert.doesNotMatch(JSON.stringify(result), /password|evil\.example|access_token/);
});

test('来源断连时缓存岗位保留并标旧，来源恢复但非当日观察仍标旧', () => {
  const result = report({ coverage: [{ name: source.name, ok: false, articles: 0, error: 'PRIVATE_UPSTREAM_URL' }] });
  assert.equal(result.jobs[0].sourceHealthy, false);
  assert.equal(result.jobs[0].stale, true);
  assert.match(result.summary.limitations.join('；'), /覆盖不完整.*此前采集记录/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_UPSTREAM_URL/);
  const older = report({ jobs: [{ ...base(), collectedAt: '2026-10-18' }] });
  assert.equal(older.jobs[0].sourceHealthy, true);
  assert.equal(older.jobs[0].stale, true);
  assert.equal(report().jobs[0].stale, false);
});

test('报告标识可核对本次数据，拒绝日期过期或无效生成时间', () => {
  const first = report();
  assert.equal(first.reportId, report().reportId);
  assert.match(first.reportId, /^[a-f0-9]{24}$/);
  assert.notEqual(first.reportId, report({ generatedAt: '2026-10-19T01:01:00.000Z' }).reportId);
  assert.throws(() => report({ digest: { ...digest(), today: '2026-10-18' } }), /当天采集日期/);
  assert.throws(() => report({ generatedAt: 'invalid-time' }), /生成时间无效/);
});

test('采集保留发布时间超过90天但未截止的长期岗位，清理超过90天未观察缓存并生成脱敏网页数据', async t => {
  const directory = await temporary(t), now = chinaDate();
  const environment = {
    RECRUITMENT_STATE_DIR: directory, RECRUITMENT_CONFIG: path.join(directory, 'config.json'),
    ALL_CONFIG: JSON.stringify({ APP_ID: 'not-real', APP_SECRET: 'not-real', USER_INFO: [{ id: 'private-recipient', wechatTemplateId: 'private-template' }] }),
  };
  await fs.writeFile(environment.RECRUITMENT_CONFIG, JSON.stringify(config));
  const long = { ...base(), id: 'long-open', published: shift(now, -150), collectedAt: shift(now, -1), deadline: shift(now, 30) };
  const abandoned = { ...long, id: 'old-cache', collectedAt: shift(now, -91) };
  const unknown = { ...long, id: 'old-unknown', deadline: null };
  const key = recipientKey({ openId: 'private-recipient' });
  const original = { version: 1, jobs: { [long.id]: long, [abandoned.id]: abandoned, [unknown.id]: unknown }, recipients: { [key]: { sent: { [long.id]: { fingerprint: long.fingerprint } }, reminded: {} } } };
  await atomicJson(path.join(directory, 'state.json'), original);
  await run(['--collect-only'], environment, { collect: async () => ({ jobs: [], coverage, observedPages: [] }) });
  const saved = await loadState(path.join(directory, 'state.json'));
  assert.deepEqual(Object.keys(saved.jobs), ['long-open']);
  assert.deepEqual(saved.recipients, original.recipients);
  const visible = JSON.parse(await fs.readFile(path.join(directory, 'reports/public.json'), 'utf8'));
  assert.equal(visible.summary.newCount, 0);
  assert.equal(visible.summary.activeCount, 1);
  assert.equal(visible.jobs[0].id, 'long-open');
  assert.equal(visible.jobs[0].stale, true);
  assert.doesNotMatch(JSON.stringify(visible), /private-recipient|private-template|fingerprint|recipients/);
});

test('状态发布白名单包含公共JSON但不包含pending或任意文件', async t => {
  const directory = await temporary(t);
  const environment = { RECRUITMENT_STATE_DIR: directory, GITHUB_REPOSITORY: 'example/repo', GH_TOKEN: 'not-real' };
  let publishedPaths;
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname.replace('/repos/example/repo', '');
    const body = options.body ? JSON.parse(options.body) : null;
    if (route === '/git/ref/heads/recruitment-state') return new Response('', { status: 404 });
    if (route === '') return Response.json({ full_name: 'example/repo' });
    if (route === '/git/trees') { publishedPaths = body.tree.map(file => file.path); return Response.json({ sha: 'new-tree' }); }
    if (route === '/git/commits') return Response.json({ sha: 'new-commit' });
    if (route === '/git/refs') return Response.json({});
    throw new Error('Unexpected GitHub request');
  };
  await sync('restore', environment, fetcher);
  await fs.mkdir(path.join(directory, 'reports'));
  await fs.writeFile(path.join(directory, 'reports/public.json'), JSON.stringify(report()));
  await fs.writeFile(path.join(directory, 'reports/pending.json'), '{}');
  await fs.writeFile(path.join(directory, 'reports/unlisted.json'), '{}');
  await sync('publish', environment, fetcher);
  assert.deepEqual(publishedPaths, ['state.json', 'reports/public.json']);
});

test('公共报告独立构建也排除明确过旧且无有效截止的岗位，不依赖run预清理', () => {
  const result = report({ jobs: [
    { ...base(), id: 'old-no-deadline', published: '2026-01-12', deadline: null },
    { ...base(), id: 'old-expired', published: '2025-12-11', deadline: '2026-10-18' },
    { ...base(), id: 'long-open', published: '2026-07-16', deadline: '2026-12-20' },
    { ...base(), id: 'recent', published: '2026-10-17', deadline: null },
  ] });
  assert.deepEqual(new Set(result.jobs.map(job => job.id)), new Set(['long-open', 'recent']));
});

test('缺失published但真实原文摘录含明确英文发布时间时恢复日期并拦历史线索', () => {
  const result = report({ jobs: [
    { ...base(), id: 'old-repost', published: null, deadline: null, announcementText: '清华大学第一附属医院2026年校园招聘 发布时间：Nov 25, 2025 9:45:12 AM 点击量：' },
    { ...base(), id: 'current-repost', published: null, deadline: null, announcementText: '招聘详情 发布时间：Oct 17, 2026 9:45:12 AM 点击量：' },
    { ...base(), id: 'unknown', published: null, deadline: null, announcementText: '医院2027届招聘，宣讲时间：Nov 25, 2025' },
  ] });
  assert.deepEqual(new Set(result.jobs.map(job => job.id)), new Set(['current-repost', 'unknown']));
  assert.equal(result.jobs.find(job => job.id === 'current-repost').published, '2026-10-17');
  assert.equal(result.jobs.find(job => job.id === 'unknown').published, null);
});
