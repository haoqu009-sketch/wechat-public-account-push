import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { jobFrom, pageData, planDigest, chinaDate } from '../core.mjs';
import { commonConditions } from '../conditions.mjs';
import { evaluateOfficialJob, verifyJobs, officialReferences, matchOfficialRows } from '../verification.mjs';
import { createPublicReport } from '../public-report.mjs';
import { validatePublicReport } from '../site-server.mjs';
import { resolveProfile } from '../profile.mjs';

const today = chinaDate(), checkedAt = new Date().toISOString();
const source = { id: 'original', name: '甲医院', url: 'https://hospital.example/jobs', allowedHosts: ['hospital.example'], province: '黑龙江', sourceKind: 'official-employer' };
const platform = { id: 'discovery', name: '发现平台', url: 'https://platform.example/list', allowedHosts: ['platform.example'], sourceKind: 'aggregator', type: 'discovery' };
const config = { profile: { graduationYear: 2027, degree: '硕士', specialty: '医学影像学', residencyCompleted: true, physicianQualification: true, preferredProvince: '黑龙江' }, sources: [source, platform], maxPhysicians: 5, maxTechnicians: 2, maxReminders: 3, reminderDays: 3, lookbackDays: 90, verification: { enabled: true } };
const row = '岗位名称：放射科医师；专业要求：医学影像学；学历要求：硕士研究生以上；其他要求：完成住院医师规范化培训者优先';
const page = { title: '甲医院2027年应届生招聘公告', text: '一、招聘对象：2027年度应届毕业生（不包括2026年毕业生）。二、岗位要求详见岗位表。自本公告发布之日起接受报名，各岗位招满即止。', url: source.url, published: today };
const make = (text = row, document = page) => jobFrom(text, document, source, config.profile, 1);
const html = `<html><h1>${page.title}</h1><article>发布时间：${today}<p>${page.text}</p><table><tr><th>岗位名称</th><th>专业要求</th><th>学历要求</th><th>其他要求</th></tr><tr><td>放射科医师</td><td>医学影像学</td><td>硕士研究生以上</td><td>完成住院医师规范化培训者优先</td></tr></table></article></html>`;
const response = (url, content) => ({ url, type: 'text/html', bytes: Buffer.from(content) });
const clue = () => ({ ...make(), id: 'cached-id', fingerprint: 'preserved-fingerprint', deliveryVersion: 'preserved-version', title: '放射科医师', role: 'clue', sourceKind: 'aggregator', organization: '甲医院', sourceName: platform.name, url: 'https://platform.example/notice/1' });

test('真实玉泉形态：公告统一2027年度应届生传递到硕士岗位，招满即止有独立证据', () => {
  const job = make(), result = evaluateOfficialJob(job, page, config.profile, today, { checkedAt });
  assert.equal(job.qualificationEvidence.graduationYear, 2027);
  assert.ok(!job.requirements.includes('是否接受2027届待确认'));
  assert.equal(result.state, 'matched');
  assert.equal(result.evidence.find(item => item.field === 'cohort').locator, '公告统一条件');
  assert.match(result.evidence.find(item => item.field === 'application').quote, /招满即止/);
  assert.match(result.evidence.find(item => item.field === 'residency').value, /优先/);
});

test('岗位例外优先；博士专用届别、另一岗位的条件和裸年份标题不能成为全局许可', () => {
  assert.ok(make(row + '；届别：不接受2027届').excluded);
  const other = make(row, { ...page, title: '2027年社会招聘公告', text: '招聘对象：2027年毕业生博士。二、招聘岗位。' });
  assert.equal(other.qualificationEvidence.graduationYear, null);
  const parsed = pageData('<body><h1>2027年招聘公告</h1><article>招聘岗位如下，具体条件请看岗位表。<table><tr><th>岗位</th><th>学历</th><th>条件</th></tr><tr><td>科研岗</td><td>博士</td><td>2027届</td></tr><tr><td>放射科医师</td><td>硕士</td><td>无其他说明</td></tr></table></article></body>', source.url, source);
  assert.equal(make(row, parsed).qualificationEvidence.graduationYear, null);
  assert.equal(make(row, { ...page, title: '2027年招聘公告', text: '岗位条件见表' }).qualificationEvidence.graduationYear, null);
});

test('岗位学历与相应学位关联，不把博士学位限制覆盖，也不把模糊学历认作符合', () => {
  const allowed = make('岗位名称：放射科医师；学历要求：硕士研究生及以上；学位要求：取得与报名学历相对应的学位；专业：医学影像学');
  assert.equal(allowed.qualificationEvidence.masters, true);
  assert.ok(make('岗位名称：放射科医师；学历要求：硕士研究生及以上；学位要求：博士学位；专业：医学影像学').excluded);
  assert.equal(make(row.replace('硕士研究生以上', '详见公告')).qualificationEvidence.masters, false);
});

test('统一学历仅继承明确聘用条件，报名材料中的学位或别的岗位不算学历要求', () => {
  const document = { ...page, title: '招聘公告', commonText: '二、聘用条件：1.遵守法律。2.硕士及以上学历并取得相应学位。三、待遇按照医院政策执行。' };
  assert.equal(make('岗位名称：放射科医师；专业：医学影像学；条件：2027届', document).qualificationEvidence.masters, true);
  assert.equal(commonConditions({ text: '报名材料：硕士学位证书、身份证复印件', title: '招聘' }, config.profile).degree, '');
});

test('黑龙江人才周真实条款：招聘条件中带学历层级的应届届别与倒装取证期限可继承', () => {
  const document = { ...page, title: '2026年度人才周公开招聘公告', commonText:
    '拟面向2027年应届毕业生公开招聘工作人员。一、单位简介。二、招聘计划。三、招聘条件：（五）应聘人员须为2027年应届硕士研究生及以上学历毕业生，毕业证、学位证和岗位要求各类证书须于2027年8月31日前取得。（六）年龄38周岁以下。四、招聘程序。报名时间：2026年9月15日至2026年10月26日。' };
  const job = make(row, document), result = evaluateOfficialJob(job, document, config.profile, '2026-10-20');
  assert.equal(job.qualificationEvidence.graduationYear, 2027);
  assert.equal(commonConditions(document, config.profile).certificateDeadline.date, '2027-08-31');
  assert.match(result.evidence.find(item => item.field === 'cohort').quote, /须为2027年应届硕士/);
  assert.equal(result.evidence.find(item => item.field === 'cohort').url, document.url);
  assert.ok(!result.issues.some(item => /2027届是否可报/.test(item)));
});

test('学历插入届别仍保留否定、博士专用、行级旧届别及统一条件冲突的边界', () => {
  const document = text => ({ ...page, title: '2027年度公开招聘公告', commonText: text });
  for (const rule of ['应聘人员须为2026年应届硕士研究生毕业生', '应聘人员不接受2027年应届硕士研究生毕业生', '应聘人员须为2027年应届博士研究生毕业生', '部分岗位面向2027年应届硕士研究生毕业生']) {
    assert.equal(make(row, document(`三、招聘条件：${rule}。四、报名办法。`)).qualificationEvidence.graduationYear, null, rule);
  }
  const allowed = document('三、招聘条件：应聘人员须为2027年应届硕士研究生及以上学历毕业生。四、报名办法。');
  assert.equal(make(row + '；届别：2026届', allowed).qualificationEvidence.graduationYear, null);
  assert.equal(make(row, document('拟面向2027年应届毕业生招聘。一、招聘条件：应聘人员须为2026年应届硕士研究生毕业生。二、报名办法。')).qualificationEvidence.graduationYear, null);
});

test('冗长站点导航不遮住届别证据；材料免交条款不冒充届别许可', () => {
  const document = { ...page, title: '2026年度人才周公告', commonText: '医院导航 '.repeat(240) + '拟面向2027年应届毕业生招聘。一、招聘计划。' };
  const job = make(row, document);
  assert.equal(job.qualificationEvidence.graduationYear, 2027);
  assert.match(job.commonEvidence.cohort.quote, /2027年应届毕业生/);
  const noPermission = { ...document, commonText: '各岗位要求见表，没有统一届别说明。' };
  const exempt = make(row + '；其他条件：具有执业医师资格证书（2025年至2027年应届毕业生无需提供）。', noPermission);
  assert.equal(exempt.qualificationEvidence.graduationYear, null);
});

test('吉林真实在读排除句式及带排版空格的取证年份仍保留明确冲突', () => {
  const document = { ...page, title: '2026年社会招聘公告', commonText: '在读的非2026年毕业生（2027年1月1日后取得毕业证、学位证的考生不视为2026年毕业生），不得用已取得的学历、学位报考。应聘人员毕业证、学位证应于202 6年12月31日前取得。' };
  const result = evaluateOfficialJob(make(row, document), document, config.profile, today);
  assert.equal(result.state, 'mismatch'); assert.match(result.issues.join('；'), /在读非2026届/);
  assert.equal(commonConditions(document, config.profile).certificateDeadline.date, '2026-12-31');
});

test('大兴安岭真实引进对象及可在日期区间报名：确认已知届别日期，保留真实额外条件', () => {
  const text = '二、引进对象和条件（一）引进对象 引进对象为2025年、2026年、2027年本科及以上毕业生。具体条件为国家统一招生的普通高校毕业生离校时和在择业期内未落实工作单位，其户口、档案、组织关系仍保留在原毕业学校。2027年毕业生应于2027年7月31日前取得报考岗位要求的相应学历、学位及职业资格证书等。三、引进程序和方法（二）报名及网上资格审查 报名采取网上报名方式进行，考生可在2026年9月15日9:00至10月26日17:00登录招聘网站进行报名，逾期不再受理报名事宜。';
  const document = { ...page, title: '2026年度人才周引才活动公告', text, commonText: text };
  const job = make(row, document), result = evaluateOfficialJob(job, document, config.profile, '2026-10-20');
  assert.equal(job.qualificationEvidence.graduationYear, 2027);
  assert.equal(job.deadline, '2026-10-26');
  assert.equal(commonConditions(document, config.profile).certificateDeadline.date, '2027-07-31');
  assert.ok(!result.issues.some(issue => /2027届是否可报|未取得明确报名/.test(issue)));
  assert.ok(result.evidence.some(proof => proof.field === 'additionalEligibility' && /未落实工作单位/.test(proof.quote)));
  assert.match(result.issues.join('；'), /档案关系/);
});

test('专业名称不能凭影像近义猜符合，也不能用本科匹配冒充研究生专业匹配', () => {
  for (const specialty of ['影像医学与核医学', '本科：医学影像学研究生：影像医学与核医学']) {
    const job = make(row.replace('医学影像学', specialty));
    const result = evaluateOfficialJob(job, page, config.profile, today);
    assert.equal(result.state, 'partial'); assert.match(result.issues.join('；'), /研究生专业/);
  }
});

test('已毕业要求与2027届冲突给出具体证据，不把应往届误解为未毕业也能报', () => {
  const document = { ...page, title: '2026年招聘公告', text: '招聘对象：普通高等院校2026年应届毕业生和社会人员。报考人员须于2026年10月15日前取得相应毕业证书、学位证书。' };
  const result = evaluateOfficialJob(make(row, document), document, config.profile, today);
  assert.equal(result.state, 'mismatch');
  assert.match(result.summary, /2026-10-15/);
  assert.match(result.evidence.find(item => item.field === 'graduationDeadline').quote, /须于/);
});

test('年龄、执业注册、工作年限不从个人已有资格证或规培推定满足', () => {
  const document = { ...page, commonText: page.text + '年龄要求：35周岁以下。' };
  const job = make(row + '；其他条件：需医师执业证；工作经历：三年工作经验；专业代码：105123；培养方式：全日制专硕', document);
  const result = evaluateOfficialJob(job, document, config.profile, today);
  assert.equal(result.state, 'partial');
  assert.match(result.issues.join('；'), /执业注册/);
  assert.match(result.issues.join('；'), /年龄/);
  assert.match(result.issues.join('；'), /工作年限/);
  assert.match(result.issues.join('；'), /学位类型/);
});

test('字段证据、岗位类别与多行对应关系：同分不猜，重复同一行可去重', () => {
  const original = make(), candidates = [make(), { ...make(), conditionExcerpt: row + '；岗位代码：另一个' }];
  assert.equal(matchOfficialRows(original, candidates).job, null);
  assert.ok(matchOfficialRows(original, [make(), make()]).job);
  assert.equal(matchOfficialRows({ ...original, positionCode: '1' }, [{ ...make(), positionCode: '2' }]).job, null);
  assert.equal(matchOfficialRows({ ...original, employerExplicit: '乙医院' }, [{ ...make(), employerExplicit: '甲医院' }]).job, null);
  assert.equal(matchOfficialRows({ ...original, title: '超声科医师' }, [make()]).job, null);
});

test('来源追溯只接受已批准HTTPS原文域名，不能跟随任意外部网站或凭据链接', () => {
  const authorities = [{ hosts: ['hospital.example'], original: true }];
  const urls = officialReferences('<body><a href="https://hospital.example/jobs">来源原文</a><a href="https://evil.example/">来源</a><a href="http://hospital.example/x">公告</a><a href="https://user:pass@hospital.example/x">来源</a><a href="https://127.0.0.1/x">来源</a></body>', platform.url, authorities);
  assert.deepEqual(urls, [source.url]);
});

test('聚合线索自动追溯原文，定位岗位并升级证据；已发ID和指纹保持不变', async () => {
  const calls = [], original = clue();
  const results = await verifyJobs([original], config, today, { checkedAt, request: async url => { calls.push(url); return response(url, url.includes('platform') ? '<body><a href="https://hospital.example/jobs">来源原文</a></body>' : html); } });
  const result = results[0];
  assert.deepEqual(calls, [original.url, source.url]);
  assert.equal(result.verification.state, 'matched');
  assert.equal(result.role, 'physician'); assert.equal(result.url, source.url);
  assert.equal(result.id, original.id); assert.equal(result.fingerprint, original.fingerprint);
  assert.equal(planDigest(results, { sent: { [original.id]: { fingerprint: original.fingerprint } }, reminded: {} }, config, today).physicians.length, 0);
});

test('同一医院主机同时列在全国转载目录和医院官网时，仍采用原始雇主身份核验', async () => {
  const settings = { ...config, sources: [{ ...source, id: 'publisher', name: '官方转发平台', sourceKind: 'official-publisher', isRepost: true }, source, platform] };
  const [result] = await verifyJobs([make()], settings, today, { request: async url => response(url, html) });
  assert.equal(result.verification.state, 'matched'); assert.equal(result.isRepost, false);
});

test('配置过的来源定位仍需检查单位和公告年份，不能把别家或去年公告变成核验证据', async () => {
  const original = clue(), settings = { ...config, verification: { references: [{ from: original.url, url: source.url }] } };
  for (const wrong of [html.replaceAll('甲医院', '乙医院'), html.replaceAll('2027', '2026')]) {
    const [result] = await verifyJobs([original], settings, today, { request: async url => response(url, wrong) });
    assert.equal(result.verification.state, 'blocked');
    assert.match(result.verification.issues.join('；'), /不一致/);
  }
});

test('HTTP403后停止同主机后续请求；不能用昨天的已核验证据冒充今天成功', async () => {
  let requests = 0;
  const first = { ...clue(), verification: { state: 'matched', evidence: [{ quote: 'yesterday' }] } }, second = { ...clue(), id: 'second', url: 'https://platform.example/notice/2' };
  const results = await verifyJobs([first, second], config, today, { request: async () => { requests++; throw new Error('HTTP 403'); } });
  assert.equal(requests, 1);
  assert.equal(results[0].verification.state, 'blocked'); assert.equal(results[0].verification.evidence.length, 0);
  assert.equal(planDigest(results, { sent: {}, reminded: {} }, config, today).physicians.length, 0);
});

test('真正的Excel附件按岗位行核验，同一公告的多个线索共享下载', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('岗位表');
  sheet.addRows([['岗位名称', '专业要求', '学历要求'], ['放射科医师', '医学影像学', '硕士']]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer()), original = clue(), calls = [];
  const configWithReference = { ...config, verification: { references: [{ from: original.url, url: source.url }] } };
  const results = await verifyJobs([original, { ...original, id: 'another' }], configWithReference, today, { request: async url => {
    calls.push(url); return url.endsWith('xlsx') ? { bytes, url, type: 'application/octet-stream' } : response(url, `<body><h1>${page.title}</h1><article>${page.text}<a href="/jobs.xlsx">附件1：招聘岗位表.xlsx</a></article></body>`);
  } });
  assert.equal(calls.length, 2); assert.equal(results[0].verification.state, 'matched');
  assert.equal(results[1].verification.state, 'matched');
  assert.ok(results[0].verification.evidence.some(item => item.url.endsWith('.xlsx')));
});

test('未知域名定位不请求，PDF文字未重建表格不升级为确认岗位', async () => {
  const original = clue(), calls = [];
  const configWithReference = { ...config, verification: { references: [{ from: original.url, url: source.url }] } };
  const [result] = await verifyJobs([original], configWithReference, today, { pdfText: async () => ['放射科医师 硕士 2027届'], request: async url => {
    calls.push(url); return response(url, url.endsWith('.pdf') ? '%PDF-1.7' : `<body><h1>${page.title}</h1><article>${page.text}<a href="/岗位表.pdf">岗位计划表.pdf</a></article></body>`);
  } });
  assert.equal(result.verification.state, 'blocked'); assert.match(result.verification.issues.join('；'), /PDF.*列关系/);
  assert.equal(result.role, 'clue');
});

test('公共报告保留明确不匹配与阻塞审计记录，不让其进入医师统计或推送', async () => {
  const document = { ...page, title: '2026年招聘公告', text: '报考人员须于2026年10月15日前取得相应毕业证书。' };
  const job = { ...make(row, document), id: 'mismatch', collectedAt: today };
  job.verification = evaluateOfficialJob(job, document, config.profile, today, { checkedAt });
  const digest = planDigest([job], { sent: {}, reminded: {} }, config, today);
  assert.equal(digest.physicians.length, 0);
  const report = createPublicReport({ jobs: [job], digest, coverage: [{ name: source.name, ok: true, articles: 1, warnings: [] }], config, generatedAt: checkedAt });
  assert.equal(report.jobs.length, 0); assert.equal(report.leads.length, 1);
  assert.equal(report.leads[0].verification.state, 'mismatch'); assert.equal(report.leads[0].isNew, false);
  assert.doesNotThrow(() => validatePublicReport(report));
});

test('核验证据公共契约严格白名单，缺证据不能伪装matched，旧快照兼容', () => {
  const job = make(); job.verification = evaluateOfficialJob(job, page, config.profile, today, { checkedAt });
  const report = createPublicReport({ jobs: [job], digest: { today, physicians: [], technicians: [], reminders: [] }, coverage: [{ name: source.name, ok: true, articles: 1, warnings: [] }], config, generatedAt: checkedAt });
  assert.doesNotThrow(() => validatePublicReport(report));
  const bad = structuredClone(report); bad.jobs[0].verification.evidence[0].secret = 'not-public';
  assert.throws(() => validatePublicReport(bad));
  const unsupported = structuredClone(report); unsupported.jobs[0].verification.evidence = [];
  assert.throws(() => validatePublicReport(unsupported));
  const legacy = structuredClone(report); delete legacy.jobs[0].verification;
  assert.doesNotThrow(() => validatePublicReport(legacy));
});

test('报名日期与资格审查截止分开，数字间排版空格不使报名日期丢失', () => {
  const text = '三、报名操作流程。应聘人员可于2026年9月15日9:00至10月2 6日17:00期间登录报名平台进行报名，逾期不再补报。招聘单位于2026年9月15日至10月27日期间进行报名资格审查。';
  const job = make(row, { ...page, text });
  assert.equal(job.deadline, '2026-10-26');
  const result = evaluateOfficialJob(job, { ...page, text }, config.profile, today);
  assert.ok(result.evidence.some(item => item.field === 'application' && item.value.includes('2026-10-26')));
});

test('原文排除在读非2026届的公告直接判为不匹配，不误用规培应届待遇解释', () => {
  const document = { ...page, title: '2026年高层次人才招聘公告', text: '有下列情形不得应聘：现役军人，普通高校在读非2026届毕业生。规培合格当年可按应届待遇。' };
  assert.equal(evaluateOfficialJob(make(row, document), document, config.profile, today).state, 'mismatch');
});

test('高校转载先追溯已定位官方URL，不因转载已能解析就提前停止', async () => {
  const university = { ...source, id: 'u', name: '高校就业网', url: 'https://university.example/notice', allowedHosts: ['university.example'], isRepost: true, sourceKind: 'university-repost' };
  const job = { ...clue(), sourceName: university.name, sourceKind: 'university-repost', url: university.url };
  const settings = { ...config, sources: [...config.sources, university], verification: { references: [{ from: job.url, url: source.url }] } };
  const calls = [];
  const [result] = await verifyJobs([job], settings, today, { request: async url => { calls.push(url); return response(url, html); } });
  assert.equal(result.verification.state, 'matched'); assert.deepEqual(calls, [source.url]);
});

test('个人学硕与出生年份只走保护配置：专硕硬限制不符合，远离年龄边界可确认上限', () => {
  const profile = resolveProfile(config.profile, '{"degreeType":"学硕","birthYear":2000}');
  const document = { ...page, commonText: page.text + '年龄要求：35周岁以下。' };
  const job = make(row.replace('硕士研究生以上', '专业学位硕士'), document);
  const result = evaluateOfficialJob(job, document, profile, today);
  assert.equal(result.state, 'mismatch');
  assert.match(result.issues.join('；'), /学位类型.*不符/);
  assert.match(result.evidence.find(item => item.field === 'age').value, /符合/);
  assert.ok(!JSON.stringify(result).includes('2000'));
  assert.throws(() => resolveProfile(config.profile, '{"birthYear":100}'));
  assert.throws(() => resolveProfile(config.profile, '{"degreeType":"<script>"}'));
  assert.throws(() => resolveProfile(config.profile, '{"api_key":"private"}'));
});

test('接近年龄上限且只有出生年份时不强行判合格；专业理论考核不是规培专业方向限制', () => {
  const year = Number(today.slice(0, 4));
  const document = { ...page, commonText: page.text + '年龄要求：35周岁以下。' };
  const job = make(row.replace('完成住院医师规范化培训者优先', '具有住院医师规范化培训合格证书或专业理论考核合格成绩单'), document);
  const result = evaluateOfficialJob(job, document, { ...config.profile, birthYear: year - 35 }, today);
  assert.match(result.issues.join('；'), /完整生日/);
  assert.ok(!result.issues.some(issue => /规培要求涉及专业方向/.test(issue)));
});

test('18周岁以上是年龄下限，不能当成上限误排除正常成年人', () => {
  const document = { ...page, commonText: page.text + '年龄应为18周岁以上，研究生一般不超过43周岁。' };
  const result = evaluateOfficialJob(make(row, document), document, { ...config.profile, birthYear: 2000 }, today);
  assert.notEqual(result.state, 'mismatch');
  assert.match(result.evidence.find(item => item.field === 'age').value, /符合/);
  const inclusive = { ...page, commonText: page.text + '年龄一般为18周岁（含）以上、38周岁（含）以下。' };
  assert.match(evaluateOfficialJob(make(row, inclusive), inclusive, { ...config.profile, birthYear: 2000 }, today).evidence.find(item => item.field === 'age').value, /符合/);
});

test('真实赤峰形态：行内学历学位取得期限优先核对，不能只看宽口径应往届', () => {
  const document = { ...page, text: '凡符合条件的应往届毕业生可报名，报名时间：2026年9月16日至11月16日。' };
  const job = make(row + '；其他条件：报考人员学历、学位、医师资格证、住院医师规范化培训合格证取得时间截至2026年8月31日。', document);
  const result = evaluateOfficialJob(job, document, config.profile, today);
  assert.equal(result.state, 'mismatch'); assert.match(result.summary, /2026-08-31/);
  assert.match(result.evidence.find(item => item.field === 'graduationDeadline').locator, /岗位表/);
});

test('年龄放宽条款不替代基础年龄，公告统一年龄证据链接必须指向正文而非岗位附件', () => {
  const document = { ...page, commonText: '一般为18周岁（含）以上、38周岁（含）以下。专业技术岗位年龄放宽条件：博士研究生或高级职称可放宽至45周岁。' };
  const job = { ...make(row, document), evidenceUrl: 'https://hospital.example/jobs.xlsx' };
  const result = evaluateOfficialJob(job, document, { ...config.profile, birthYear: 2000 }, today);
  const proof = result.evidence.find(item => item.field === 'age');
  assert.match(proof.value, /符合/); assert.ok(!proof.quote.includes('放宽')); assert.equal(proof.url, document.url);
  assert.ok(!result.issues.some(issue => /生日/.test(issue)));
});

test('本科层级岗位不能仅因硕士尚未毕业就直接判不匹配，需核对既有学历和在读限制', () => {
  const document = { ...page, title: '招聘公告', text: '报考人员须于2026年10月15日前取得相应毕业证书。' };
  const job = make(row.replace('硕士研究生以上', '本科及以上'), document);
  const result = evaluateOfficialJob(job, document, config.profile, today);
  assert.equal(result.state, 'partial');
  assert.match(result.issues.join('；'), /已取得的本科/);
});
