import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverCards, parseDiscoveredNotice, rotatingNotices, robotsAllowed, collectDiscovery } from '../discovery.mjs';
import { cachedDownload } from '../source-cache.mjs';
import { download } from '../collector.mjs';
import { jobFrom, rankJobs, planDigest } from '../core.mjs';
import { createPublicReport } from '../public-report.mjs';
import { validatePublicReport } from '../site-server.mjs';

const source = { id: 'wide', name: '测试聚合平台', provider: 'gaocai', url: 'https://platform.example/hotword/imaging', allowedHosts: ['platform.example'], province: '全国' };
const config = { profile: { graduationYear: 2027, preferredProvince: '黑龙江' }, lookbackDays: 90, maxPhysicians: 5, maxTechnicians: 2, maxReminders: 3, reminderDays: 3, sources: [source] };
const today = '2026-10-20';
const card = (title = '放射科医师', button = '申请职位', path = '/announcement/detail/100.html') => `<li><div class="job-detail"><a class="job-name" href="/job/detail/1.html">${title}</a><div class="job-info">黑龙江-哈尔滨 | 硕士研究生 | 招1人</div><a class="job-announcement" href="${path}">测试医院2027年招聘公告</a></div><a class="job-button">${button}</a><a class="company-name">测试医院</a></li>`;
const notice = '<html><h1>测试医院2027年招聘公告</h1><div class="announcement-content">发布时间：2026-10-19。招聘岗位：放射科医师。要求：硕士及以上，2027届毕业生，已取得执业医师资格。报名截止日期：2026年11月20日。招聘具体要求及人数以正式官方原始岗位表为准。</div></html>';

test('聚合列表仅发现影像临床线索，跳过已下线/科研/跨域/搜索接口', () => {
  const result = discoverCards(card() + card('放射科技师', '已下线') + card('医学影像科研岗') + card('医学影像医师', '申请职位', 'https://private.example/announcement/detail/2.html') + card('放射科医师', '申请职位', '/job?keyword=影像'), source);
  assert.equal(result.length, 1);
  assert.equal(result[0].organization, '测试医院');
  assert.equal(result[0].province, '黑龙江');
  assert.match(result[0].url, /announcement\/detail\/100/);
});

test('平台内容无论医师字样多明确，都只能进线索，不进入晨报正式岗位', () => {
  const jobs = parseDiscoveredNotice(notice, 'https://platform.example/announcement/detail/100.html', discoverCards(card(), source), source, config, today);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].role, 'clue');
  assert.equal(rankJobs(jobs, config, today)[0].role, 'clue');
  assert.equal(planDigest(jobs, { sent: {}, reminded: {} }, config, today).physicians.length, 0);
  const pub = createPublicReport({ jobs: jobs.map(job => ({ ...job, collectedAt: today, secret: 'PRIVATE_SENTINEL' })), digest: { today, physicians: [], technicians: [], reminders: [] }, coverage: [{ name: source.name, ok: true, articles: 1, warnings: [] }], config, generatedAt: '2026-10-20T01:00:00.000Z' });
  assert.equal(pub.jobs.length, 0); assert.equal(pub.summary.activeCount, 0);
  assert.equal(pub.leads.length, 1); assert.equal(pub.leads[0].isNew, false);
  assert.doesNotMatch(pub.leads[0].qualityReasons.join('；'), /已解析官方具体岗位行/);
  assert.doesNotMatch(JSON.stringify(pub), /PRIVATE_SENTINEL/);
  assert.doesNotThrow(() => validatePublicReport(pub));
  assert.throws(() => validatePublicReport({ ...pub, leads: [{ ...pub.leads[0], role: 'physician' }] }));
  const legacy = { ...pub }; delete legacy.leads;
  assert.doesNotThrow(() => validatePublicReport(legacy));
});

test('医院简介里的CT设备不被当作招聘岗位，旧公告不伪装成今日', () => {
  const md = { ...source, provider: 'jobmd' };
  const intro = '<html><h1>测试医院2027年招聘</h1><article>发布单位测试医院工作地点黑龙江。岗位需求见附件，资格条件与报名办法由招聘单位公告为准。医院简介：本院拥有CT、放射科、医学影像科等设备和科室。</article></html>';
  assert.deepEqual(parseDiscoveredNotice(intro, 'https://platform.example/jobnotice/1', [{ announcement: '招聘', organization: '' }], md, config, today), []);
  assert.deepEqual(parseDiscoveredNotice(notice.replace('2026-10-19', '2025-10-19'), 'https://platform.example/announcement/detail/100.html', discoverCards(card(), source), source, config, today), []);
});

test('保留高优先公告，余下公告按四小时轮换而不是一直取固定前12篇', () => {
  const cards = Array.from({ length: 40 }, (_, index) => ({ url: `https://platform.example/announcement/detail/${100 + index}.html`, announcement: index < 3 ? '2027招聘' : '2026招聘', title: '放射科医师', province: '全国', degree: '硕士' }));
  const first = rotatingNotices(cards, { maximum: 16, cycle: 1 }), second = rotatingNotices(cards, { maximum: 16, cycle: 2 });
  assert.equal(first.length, 16); assert.equal(new Set(first).size, 16);
  assert.deepEqual(first.slice(0, 8), second.slice(0, 8));
  assert.notDeepEqual(first.slice(8), second.slice(8));
});

test('robots禁止的查询/后台不请求，公开栏目及公告详情允许', async () => {
  const robots = 'User-agent: *\nDisallow: /job*?*\nDisallow: /admin/\n';
  assert.equal(robotsAllowed(robots, 'https://platform.example/job?keyword=CT'), false);
  assert.equal(robotsAllowed(robots, 'https://platform.example/admin/x'), false);
  assert.equal(robotsAllowed(robots, 'https://platform.example/announcement/detail/100.html'), true);
  const requests = [];
  const result = await collectDiscovery(source, config, today, { robotsText: 'User-agent: *\nDisallow: /', pause: async () => {}, request: async url => { requests.push(url); throw new Error(); } });
  assert.equal(result.coverage.ok, false); assert.deepEqual(requests, []);
});

test('发现来源部分栏目403不会冒充完整覆盖，但可保留成功公告线索', async () => {
  const request = async url => {
    if (url.endsWith('/restricted')) throw new Error('HTTP 403');
    return { bytes: Buffer.from(url.includes('/announcement/') ? notice : card()), type: 'text/html', url };
  };
  const result = await collectDiscovery({ ...source, entryUrls: [source.url, 'https://platform.example/restricted'] }, config, today, { request, robotsText: '', pause: async () => {} });
  assert.equal(result.coverage.ok, true); assert.equal(result.jobs.length, 1);
  assert.match(result.coverage.warnings.join('；'), /403\/429.*停止/);
});

test('平台403后停止后续栏目，不通过密集请求、换域或换身份碰运气', async () => {
  const requests = [];
  const result = await collectDiscovery({ ...source, entryUrls: [source.url, 'https://platform.example/second'] }, config, today, { robotsText: '', pause: async () => {}, request: async url => { requests.push(url); throw new Error('HTTP 403'); } });
  assert.equal(result.coverage.ok, false); assert.equal(requests.length, 1);
});

test('HTTP条件缓存允许304复用，但403失败绝不冒充缓存成功', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-http-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const fetcher = async (_, options) => {
    calls++;
    if (calls === 1) return new Response('public-notice', { headers: { etag: '"v1"', 'content-type': 'text/html' } });
    assert.equal(options.headers['If-None-Match'], '"v1"');
    return new Response(null, { status: calls === 2 ? 304 : 403 });
  };
  const request = cachedDownload(dir, download, fetcher);
  assert.equal((await request('https://hospital.example/job', ['hospital.example'])).bytes.toString(), 'public-notice');
  assert.equal((await request('https://hospital.example/job', ['hospital.example'])).bytes.toString(), 'public-notice');
  await assert.rejects(request('https://hospital.example/job', ['hospital.example']), /HTTP 403/);
});

test('届别区间/职业写法/多批次截止不再机械误筛，未知职业仍保留线索', () => {
  const page = { title: '医院2027招聘', url: 'https://platform.example/notice', published: today, text: '' };
  const official = { ...source, sourceKind: 'official-employer' };
  const row = '岗位名称：专技岗位；科室：放射科；专业：放射影像学；学历：硕士；条件：具有执业医师资格，2026届及以后毕业生';
  const job = jobFrom(row, page, official, config.profile, 1);
  assert.equal(job.excluded, null); assert.equal(job.role, 'physician');
  assert.equal(job.qualificationEvidence.graduationYear, 2027);
  const unknown = jobFrom(row.replace('具有执业医师资格，', ''), page, official, config.profile, 1);
  assert.equal(unknown.role, 'clue');
  const batch = jobFrom(row, { ...page, text: '第一批报名截止：2026年8月31日。第二批报名截止：2026年10月31日。' }, official, config.profile, 1);
  assert.equal(batch.deadline, null); assert.match(batch.requirements.join('；'), /多批次/);
});

test('没有岗位代码时不同科室不再覆盖，旧ID保留兼容记录', () => {
  const page = { title: '医院2027招聘', url: 'https://platform.example/notice', published: today, text: '' };
  const row = '招聘单位：测试医院；岗位名称：医疗岗；专业：医学影像学；学历：硕士；条件：执业医师资格';
  const one = jobFrom(`${row}；科室名称：CT室`, page, source, config.profile, 1);
  const two = jobFrom(`${row}；科室名称：MR室`, page, source, config.profile, 2);
  assert.notEqual(one.id, two.id);
  assert.ok(one.legacyIds.length > 0);
});
