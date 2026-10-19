import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { safeUrl, classifyLink, datesIn, extractDeadline, pageData, jobFrom, rankJobs, planDigest, markDelivered, renderMarkdown, wechatData, publicationDateFromText } from '../core.mjs';
import { spreadsheetRows, collectSource, download } from '../collector.mjs';
import { readWechatConfig, sendDigest, getAccessToken, recipientKey } from '../wechat.mjs';
import ExcelJS from 'exceljs';
const config = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url)));
const source = { name: '测试医院', province: '黑龙江', url: 'https://hospital.example/', isListing: true };
const page = { url: 'https://hospital.example/job/1', title: '2027届招聘公告', published: '2026-10-01', text: '报名时间：2026年10月1日至2026年10月31日。' };
const row = '岗位代码：1001；岗位名称：放射科医师；学历：硕士；专业：影像医学与核医学；条件：2027届、规培合格、CT方向';
const makeJob = (text = row) => jobFrom(text, page, source, config.profile, 1);
const empty = () => ({ sent: {}, reminded: {} });

test('仅允许显式配置的HTTPS域名，移除跟踪参数，阻止跨域及带凭据地址', () => {
  assert.equal(safeUrl('/job?utm_source=a&id=1#x', source.url, ['hospital.example']), 'https://hospital.example/job?id=1');
  for (const url of ['http://hospital.example/', 'https://evil.example/', 'https://user:pass@hospital.example/', 'https://hospital.example:8080/', 'javascript:alert(1)']) assert.equal(safeUrl(url, source.url, ['hospital.example']), null);
});

test('只提取明确报名日期，不把毕业时间当截止；拒绝无效日期', () => {
  assert.equal(extractDeadline('2027年6月取得毕业证，2027年7月入职', 2026), null);
  assert.equal(extractDeadline(page.text, 2026), '2026-10-31');
  assert.deepEqual(datesIn('2026年2月30日', 2026), []);
});

test('实际公告中报名与时间标签间留白仍识别截止，不误取毕业或考试日期', () => {
  const notice = '毕业时间：2027年6月30日。（二）报名 1.网上报名 时间：2026年9月21日--2026年10月14日16:00时；2.现场确认时间：2026年10月20日；考试时间：2026年10月25日。';
  assert.equal(extractDeadline(notice, 2026), '2026-10-14');
  assert.equal(extractDeadline('网上报名\n时间：2026年9月21日--2026年10月14日16:00时；', 2026), '2026-10-14');
  for (const text of ['毕业时间：2027年6月30日。', '考试时间：2026年10月25日。', '现场确认时间：2026年10月20日。', '报名须知：考试时间为2026年10月25日。']) {
    assert.equal(extractDeadline(text, 2026), null);
  }
  const announcement = { ...page, published: '2026-09-21', text: notice };
  const job = jobFrom(row, announcement, source, config.profile, 1);
  assert.equal(job.deadline, '2026-10-14');
  assert.equal(planDigest([job], empty(), config, '2026-10-19').physicians.length, 0);
});

test('工作人员考试的通知属于招聘后续流程，新的招聘公告仍保留', () => {
  assert.equal(classifyLink({ title: '哈尔滨医科大学2027年公开招聘（一）工作人员考试的通知' }), null);
  assert.equal(classifyLink({ title: '哈尔滨医科大学2027年公开招聘（一）工作人员考试通知' }), null);
  assert.equal(classifyLink({ title: '哈尔滨医科大学2027年公开招聘（一）工作人员公告' }), 'article');
});

test('表格按岗位筛选，其他岗位的博士要求不污染硕士岗位', () => {
  const html = `<html><h1>2027届招聘</h1><article>发布日期：2026-10-01<table><tr><th>岗位名称</th><th>学历</th><th>专业</th><th>条件</th></tr><tr><td>放射科医师</td><td>硕士</td><td>医学影像学</td><td>2027届</td></tr><tr><td>科研岗</td><td>博士</td><td>生物学</td><td>不限</td></tr></table>报名截止：2026年10月31日。</article></html>`;
  const parsed = pageData(html, page.url, source);
  assert.equal(parsed.rows.length, 1);
  const job = jobFrom(parsed.rows[0], parsed, source, config.profile, 1);
  assert.equal(job.excluded, null);
  assert.equal(job.status, 'priority');
  assert.equal(job.deadline, '2026-10-31');
});

test('影像医师/技师分类，博士和明确不符届别排除，未知资格保留待核实', () => {
  assert.equal(makeJob().role, 'physician');
  assert.equal(makeJob(row.replace('放射科医师', '放射科技师')).role, 'technician');
  assert.ok(makeJob(row.replace('硕士', '博士')).excluded);
  assert.ok(makeJob(row.replace('2027届', '2026届')).excluded);
  const clue = jobFrom('医院招聘多个专业，包括医学影像学、博士研究生', page, source, config.profile);
  assert.equal(clue.excluded, null);
  assert.equal(clue.status, 'review');
  assert.match(clue.requirements.join(''), /具体岗位条件/);
});

test('同一岗位条件更新保持ID，指纹发生变化；去重后再推实质更新', () => {
  const job = makeJob(), changed = makeJob(`${row}；待遇：面议`);
  assert.equal(job.id, changed.id);
  assert.notEqual(job.fingerprint, changed.fingerprint);
  const state = { sent: { [job.id]: { fingerprint: job.fingerprint } }, reminded: {} };
  assert.equal(planDigest([job], state, config, '2026-10-10').physicians.length, 0);
  assert.equal(planDigest([changed], state, config, '2026-10-10').physicians.length, 1);
});

test('医师上限、黑龙江优先，已截止不发，候补单列', () => {
  const jobs = Array.from({ length: 8 }, (_, i) => ({ ...makeJob(), id: String(i), province: i === 7 ? '黑龙江' : '北京' }));
  jobs.push({ ...makeJob(row.replace('放射科医师', '放射科技师')), id: 'tech' }, { ...makeJob(), id: 'expired', deadline: '2026-10-01' });
  const digest = planDigest(jobs, empty(), config, '2026-10-10');
  assert.equal(digest.physicians.length, 5);
  assert.equal(digest.physicians[0].id, '7');
  assert.equal(digest.technicians.length, 1);
  assert.ok(!digest.physicians.some(job => job.id === 'expired'));
});

test('明确硕士届别与CT具体岗位优先，其他影像方向明确标示，未知线索降序', () => {
  const today = '2026-10-19';
  const ct = { ...makeJob(), id: 'ct', province: '北京' };
  const generic = { ...makeJob(row.replace('、CT方向', '')), id: 'generic' };
  const ultrasound = { ...makeJob(row.replace('放射科医师', '超声科医师').replace('CT方向', '超声方向')), id: 'ultrasound' };
  const clue = { ...jobFrom('医学影像学招聘，具体岗位请见附件。', page, source, config.profile), id: 'unknown' };
  const technician = { ...makeJob(row.replace('放射科医师', '放射科技师')), id: 'technician' };
  const expired = { ...ct, id: 'expired', deadline: '2026-10-18' };
  const ranked = rankJobs([clue, technician, generic, ultrasound, ct, expired], config, today);
  assert.equal(ranked[0].id, 'ct');
  assert.equal(ranked.at(-1).id, 'unknown');
  assert.ok(ranked.findIndex(job => job.id === 'technician') < ranked.findIndex(job => job.id === 'unknown'));
  assert.ok(ranked.findIndex(job => job.id === 'generic') < ranked.findIndex(job => job.id === 'unknown'));
  assert.equal(ranked.find(job => job.id === 'unknown').status, 'review');
  assert.equal(ranked.find(job => job.id === 'ultrasound').focusMatch, 'other');
  assert.match(ranked.find(job => job.id === 'ultrasound').directionLabel, /超声.*非CT/);
  assert.ok(!ranked.some(job => job.id === 'expired'));
  assert.match(ranked[0].qualityReasons.join('；'), /硕士.*2027届.*具体岗位明确涉及CT/);
  assert.match(ranked[0].priorityLabel, /CT岗位/);
});

test('多岗位公告的博士、届别与CT信息不会污染另一行，专业不限不放过错误届别', () => {
  const mixed = { ...page, title: '2027届综合招聘公告', text: 'CT岗位仅招博士，2026届岗位另有安排。其他影像岗位以各行条件为准。' };
  const masters = jobFrom(row.replace('、CT方向', ''), mixed, source, config.profile, 1);
  const unknown = jobFrom('岗位代码：CT2027；岗位名称：影像科医师；学历：待定；条件：应届毕业生', mixed, source, config.profile, 2);
  const wrongYear = jobFrom(row.replace('2027届', '2026届').replace('影像医学与核医学', '不限'), mixed, source, config.profile, 3);
  assert.equal(masters.excluded, null);
  assert.equal(masters.focusMatch, 'unknown');
  assert.equal(masters.qualificationEvidence.masters, true);
  assert.equal(unknown.focusMatch, 'unknown');
  assert.equal(unknown.status, 'review');
  assert.equal(unknown.qualificationEvidence.graduationYear, null);
  assert.equal(wrongYear.excluded, '届别不符');
  assert.equal(makeJob(row.replace('硕士', '博士（不接受硕士）')).excluded, '该岗位仅列博士学历');
  assert.equal(makeJob(row.replace('2027届', '2027年毕业生')).qualificationEvidence.graduationYear, 2027);
  assert.equal(makeJob(row.replace('2027届', '不接受2027届')).excluded, '届别不符');
  assert.equal(makeJob(row.replace('放射科医师', '放射科护士')), null);
});

test('同一岗位规范URL及跨渠道去重，联合公告不同医院同码岗位不合并', () => {
  const a = { ...page, url: 'https://hospital.example/job?id=1&lang=zh&utm_source=one#content' };
  const b = { ...page, url: 'https://hospital.example/job?lang=zh&id=1&from=two' };
  const first = jobFrom(`招聘单位：甲医院；${row}`, a, source, config.profile, 1);
  const duplicate = jobFrom(`招聘单位：甲医院；${row}`, b, { ...source, name: '大学官方转发' }, config.profile, 1);
  const anotherHospital = jobFrom(`招聘单位：乙医院；${row}`, b, source, config.profile, 2);
  assert.equal(first.id, duplicate.id);
  assert.notEqual(first.id, anotherHospital.id);
  const digest = planDigest([first, duplicate, anotherHospital], empty(), config, '2026-10-19');
  assert.equal(digest.activeCount, 2);
  assert.deepEqual(new Set(digest.physicians.map(job => job.organization)), new Set(['甲医院', '乙医院']));
  const missingFields = jobFrom(`招聘单位：甲医院；${row.replace('学历：硕士', '学历：待核实')}`, a, source, config.profile, 1);
  assert.equal(missingFields.id, first.id);
  assert.equal(rankJobs([first, missingFields], config, '2026-10-19')[0].qualificationEvidence.masters, true);
});

test('单位归属和URL规范化升级不会让相同指纹的旧记录无故重发', () => {
  const job = jobFrom(`招聘单位：甲医院；${row}`, page, source, config.profile, 1);
  assert.equal(job.legacyIds.length, 1);
  const previous = { sent: { [job.legacyIds[0]]: { fingerprint: job.fingerprint } }, reminded: {} };
  assert.equal(planDigest([job], previous, config, '2026-10-19').physicians.length, 0);
  assert.equal(planDigest([job], previous, config, '2026-10-29').reminders.length, 1);
  previous.reminded[job.legacyIds[0]] = job.deadline;
  assert.equal(planDigest([job], previous, config, '2026-10-29').reminders.length, 0);
  previous.sent[job.legacyIds[0]].fingerprint = 'different-hospital-or-condition';
  assert.equal(planDigest([job], previous, config, '2026-10-19').physicians.length, 1);
});

test('旧版本误分类后留下的已发公告线索，不能再次触发临床岗位截止提醒', () => {
  const clue = jobFrom('医学影像学招聘，报名截止时间：2026年10月31日。具体岗位请见附件。', page, source, config.profile);
  assert.equal(clue.role, 'clue');
  const previous = { sent: { [clue.id]: { fingerprint: clue.fingerprint } }, reminded: {} };
  const digest = planDigest([clue], previous, config, '2026-10-29');
  assert.equal(digest.activeCount, 0);
  assert.equal(digest.reminders.length, 0);
});

test('截止提醒窗口只提醒一次；不同接收人独立记录，失败者不受已成功者影响', () => {
  const job = makeJob();
  const original = { version: 1, jobs: {}, recipients: {} };
  const digest = planDigest([job], empty(), config, '2026-10-10');
  const state = markDelivered(original, digest, 'recipient1', '2026-10-10');
  assert.equal(original.recipients.recipient1, undefined);
  assert.equal(planDigest([job], state.recipients.recipient1, config, '2026-10-27').reminders.length, 0);
  const reminder = planDigest([job], state.recipients.recipient1, config, '2026-10-28');
  assert.equal(reminder.reminders.length, 1);
  const delivered = markDelivered(state, reminder, 'recipient1', '2026-10-28');
  assert.equal(planDigest([job], delivered.recipients.recipient1, config, '2026-10-29').reminders.length, 0);
  assert.equal(planDigest([job], empty(), config, '2026-10-29').physicians.length, 1);
});

test('XLSX岗位表提取具体影像岗位', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('招聘');
  sheet.addRows([['岗位名称', '学历', '专业', '条件'], ['放射科医师', '硕士', '医学影像学', '2027届'], ['实验室', '博士', '生物', '不限']]);
  const rows = await spreadsheetRows(await book.xlsx.writeBuffer());
  assert.equal(rows.length, 1);
  assert.match(rows[0], /学历：硕士/);
});

test('采集流程发现公告、读取表格；来源故障不冒充无岗位', async () => {
  const pages = new Map([
    [source.url, '<html><body><a href="/job/1">2027届招聘公告</a></body></html>'],
    [page.url, '<html><h1>2027届招聘公告</h1><article>发布日期：2026-10-01。<table><tr><th>岗位</th><th>学历</th><th>条件</th></tr><tr><td>放射科医师</td><td>硕士</td><td>2027届</td></tr></table></article></html>'],
  ]);
  const request = async url => ({ bytes: Buffer.from(pages.get(url)), url, type: 'text/html;charset=utf-8' });
  const success = await collectSource(source, config, '2026-10-10', { request, pause: async () => {} });
  assert.equal(success.coverage.ok, true);
  assert.equal(success.jobs.length, 1);
  assert.equal(success.jobs[0].status, 'priority');
  const failure = await collectSource(source, config, '2026-10-10', { request: async () => { throw new Error('HTTP 403'); } });
  assert.equal(failure.coverage.ok, false);
  assert.match(failure.coverage.error, /403/);
});

test('招聘公告栏目优先识别为目录，继续读取其中具体公告', async () => {
  assert.equal(classifyLink({ title: '招聘公告' }), 'index');
  assert.equal(classifyLink({ title: '2027届影像医师招聘公告' }), 'article');
  assert.equal(classifyLink({ title: '2027届招聘拟聘公示' }), null);
  const listing = 'https://hospital.example/recruitment/';
  const home = { ...source, isListing: false, verifyName: '测试医院' };
  const pages = new Map([
    [home.url, '<html><title>测试医院</title><body><a href="/recruitment/">招聘公告</a></body></html>'],
    [listing, '<html><body><a href="/job/1">2027届影像医师招聘公告</a></body></html>'],
    [page.url, '<html><h1>2027届影像医师招聘公告</h1><article>发布日期：2026-10-01。<table><tr><th>岗位</th><th>学历</th><th>条件</th></tr><tr><td>放射科医师</td><td>硕士</td><td>2027届</td></tr></table></article></html>'],
  ]);
  const requested = [];
  const request = async url => {
    requested.push(url);
    assert.ok(pages.has(url), `未配置的测试页面：${url}`);
    return { bytes: Buffer.from(pages.get(url)), url, type: 'text/html;charset=utf-8' };
  };
  const result = await collectSource(home, config, '2026-10-10', { request, pause: async () => {} });
  assert.deepEqual(requested, [home.url, listing, page.url]);
  assert.equal(result.coverage.ok, true);
  assert.equal(result.coverage.articles, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].url, page.url);
  assert.equal(result.jobs[0].status, 'priority');
});

test('官方download.jsp附件按锚文本识别XLSX并采集岗位，跨域附件仍被拒绝', async () => {
  const university = { name: '哈尔滨医科大学', province: '黑龙江', url: 'https://hr.hrbmu.edu.cn/recruitment/', isListing: true, allowedHosts: ['hr.hrbmu.edu.cn'] };
  const articleUrl = 'https://hr.hrbmu.edu.cn/info/1117/1737.htm';
  const attachmentPath = '/system/_content/download.jsp?urltype=news.DownloadAttachUrl&owner=1711051748&wbfileid=17826929';
  const attachmentUrl = new URL(attachmentPath, university.url).href;
  const article = `<html><h1>哈尔滨医科大学2027年毕业生招聘公告</h1><article>发布日期：2026-10-01。<a href="${attachmentPath}">附件1：哈尔滨医科大学2027年毕业生需求情况表.xlsx</a><a href="https://other.example/download.jsp">未知来源.xlsx</a><a href="http://hr.hrbmu.edu.cn/download.jsp">不安全下载.xlsx</a></article></html>`;
  const parsed = pageData(article, articleUrl, university);
  assert.deepEqual(parsed.attachments.map(item => [item.url, item.format]), [[attachmentUrl, 'xlsx']]);
  const book = new ExcelJS.Workbook();
  book.addWorksheet('需求表').addRows([
    ['岗位代码', '岗位名称', '学历', '专业', '条件'],
    ['CT2027', '放射科医师', '硕士', '影像医学与核医学', '2027届，CT方向'],
  ]);
  const workbook = Buffer.from(await book.xlsx.writeBuffer());
  const responses = new Map([
    [university.url, { bytes: Buffer.from(`<html><body><a href="${articleUrl}">哈尔滨医科大学2027年毕业生招聘公告</a></body></html>`), type: 'text/html;charset=utf-8' }],
    [articleUrl, { bytes: Buffer.from(article), type: 'text/html;charset=utf-8' }],
    [attachmentUrl, { bytes: workbook, type: 'application/octet-stream' }],
  ]);
  const requested = [];
  const request = async (url, hosts) => {
    requested.push(url);
    assert.deepEqual(hosts, university.allowedHosts);
    assert.ok(responses.has(url), `未配置的测试页面：${url}`);
    return { ...responses.get(url), url };
  };
  const result = await collectSource(university, config, '2026-10-10', { request, pause: async () => {} });
  assert.deepEqual(requested, [university.url, articleUrl, attachmentUrl]);
  assert.equal(result.coverage.ok, true);
  assert.deepEqual(result.coverage.warnings, []);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].title, '放射科医师');
  assert.equal(result.jobs[0].status, 'priority');
  assert.equal(result.jobs[0].url, articleUrl);
});

test('下载验证页会明确报告而不覆盖旧岗位', async () => {
  const attachmentUrl = 'https://hospital.example/download.xlsx';
  const html = deadline => `<html><h1>2027届招聘公告</h1><article>发布日期：2026-10-01。网上报名 时间：2026年10月1日--${deadline}；<a href="${attachmentUrl}">岗位表.xlsx</a></article></html>`;
  const requested = [];
  const deadline = '2026年10月30日';
  const request = async url => {
    requested.push(url);
    const text = url === source.url ? `<html><a href="${page.url}">2027届招聘公告</a></html>`
      : url === page.url ? html(deadline)
        : '<html><title>附件下载</title><body>请输入验证码</body></html>';
    return { bytes: Buffer.from(text), url, type: 'text/html;charset=utf-8' };
  };
  const active = await collectSource(source, config, '2026-10-19', { request, pause: async () => {} });
  assert.equal(requested.at(-1), attachmentUrl);
  assert.equal(active.jobs.length, 0);
  assert.deepEqual(active.observedPages, []);
  assert.ok(active.coverage.warnings.some(warning => /下载验证页/.test(warning)));
});

test('受限下载明确接收JSON，兼容官网公开接口的内容协商', async () => {
  const result = await download(source.url, ['hospital.example'], async (url, options) => {
    assert.match(options.headers.Accept, /application\/json/);
    return Response.json({ code: 200 });
  });
  assert.deepEqual(JSON.parse(result.bytes.toString('utf8')), { code: 200 });
});

test('公开GET首次暂时超时后仅重试一次即可恢复，保留UA及JSON协商', async () => {
  let calls = 0;
  const result = await download(source.url, ['hospital.example'], async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['User-Agent'], 'MedicalImagingRecruitmentDigest/1.0');
    assert.match(options.headers.Accept, /application\/json/);
    if (calls === 1) throw Object.assign(new Error('secret-url https://hospital.example/?token=private'), { name: 'TimeoutError' });
    return Response.json({ code: 200 });
  });
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(result.bytes.toString('utf8')), { code: 200 });
});

test('暂时性网络错误连续失败两次即停止，安全错误不含URL或token', async () => {
  let calls = 0;
  await assert.rejects(download(source.url, ['hospital.example'], async () => {
    calls++;
    throw Object.assign(new Error('https://hospital.example/?token=private'), { cause: { code: 'ETIMEDOUT' } });
  }), error => {
    assert.equal(error.message, '来源连接失败（ETIMEDOUT）');
    assert.doesNotMatch(error.message, /hospital|https|private|token/);
    return true;
  });
  assert.equal(calls, 2);
});

test('403/404/406属于HTTP错误，不触发网络重试', async () => {
  for (const status of [403, 404, 406]) {
    let calls = 0;
    await assert.rejects(download(source.url, ['hospital.example'], async () => {
      calls++;
      return new Response('Forbidden', { status });
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test('响应流连接重置可有界恢复，TLS错误不会触发重试', async () => {
  let calls = 0;
  const result = await download(source.url, ['hospital.example'], async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error('https://hospital.example/private'), { code: 'UND_ERR_SOCKET' }));
    } }));
    return new Response('restored');
  });
  assert.equal(calls, 2);
  assert.equal(result.bytes.toString('utf8'), 'restored');
  let tlsCalls = 0;
  await assert.rejects(download(source.url, ['hospital.example'], async () => {
    tlsCalls++;
    throw Object.assign(new Error('certificate failure'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  }), /ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.equal(tlsCalls, 1);
});

test('重定向不能跳出来源白名单，限制响应大小', async () => {
  await assert.rejects(download(source.url, ['hospital.example'], async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })), /未配置/);
  await assert.rejects(download(source.url, ['hospital.example'], async () => new Response('12345'), 3), /大小/);
});

test('报告保留官方链接及失败来源，微信字段受限，包含提醒', () => {
  const digest = planDigest([makeJob()], empty(), config, '2026-10-10');
  const coverage = [{ name: '正常来源', ok: true, articles: 1 }, { name: '故障来源', ok: false, error: 'HTTP 403' }];
  const report = renderMarkdown(digest, coverage);
  assert.match(report, /https:\/\/hospital.example\/job\/1/);
  assert.match(report, /检查失败/);
  assert.match(report, /优先理由：.*硕士/);
  assert.match(report, /<details>\n<summary>查看岗位原文及公告摘录<\/summary>/);
  assert.match(report, /<summary>展开来源检查与异常详情<\/summary>/);
  assert.ok(report.indexOf('[官方公告]') < report.indexOf('岗位原文摘录：'));
  const data = wechatData(digest, coverage);
  for (const [field, limit] of Object.entries({ a: 18, b: 18, l: 18, n2: 18, q1: 60, q2: 180, m1: 60, m2: 40 })) assert.ok(Array.from(data[field].value).length <= limit);
});

test('复用原有ALL_CONFIG、接收人覆盖及新增模板ID，不要求天行密钥', () => {
  const env = { ALL_CONFIG: JSON.stringify({ APP_ID: 'test-id', APP_SECRET: 'not-real', USER_INFO: [{ id: 'old', wechatTemplateId: 'old-template' }] }), USER_OPENID: 'current', ADDITIONAL_USER_OPENIDS: '["extra", "current"]', RECRUITMENT_TEMPLATE_ID: 'new-template' };
  const settings = readWechatConfig(env);
  assert.equal(settings.users.length, 2);
  assert.equal(settings.users[0].openId, 'current');
  assert.equal(settings.users[1].templateId, 'new-template');
  assert.notEqual(recipientKey(settings.users[0]), 'current');
  assert.throws(() => readWechatConfig({}), /配置不完整/);
});

test('微信明确接受才算发送成功，网络错误不能泄露token或密钥', async () => {
  const digest = planDigest([makeJob()], empty(), config, '2026-10-10');
  const user = { openId: 'not-real', templateId: 'not-real' };
  let payload;
  const success = await sendDigest(user, digest, [], 'secret-token', 'https://github.com/example/repo', async (url, options) => {
    payload = JSON.parse(options.body);
    return Response.json({ errcode: 0, msgid: '123' });
  });
  assert.equal(success.accepted, true);
  assert.equal(payload.url, 'https://github.com/example/repo');
  assert.equal(payload.data.a.value, '2026-10-10');
  await assert.rejects(sendDigest(user, digest, [], 'secret-token', 'https://github.com/example/repo', async () => Response.json({ errcode: 40003, errmsg: 'invalid openid' })), /40003/);
  await assert.rejects(sendDigest(user, digest, [], 'secret-token', 'https://github.com/example/repo', async () => { throw new Error('secret-token'); }), error => !error.message.includes('secret-token'));
  await assert.rejects(getAccessToken({ appId: 'a', appSecret: 'secret' }, async () => Response.json({})), /access_token/);
});

test('合并单元格保留岗位列对应关系，人数和资格原文写入报告', () => {
  const html = '<html><h1>2027届招聘</h1><article>发布日期：2026-10-01。<table><tr><th>招聘单位</th><th>岗位名称</th><th>学历</th><th>专业</th><th>人数</th></tr><tr><td rowspan="2">甲医院</td><td>放射科医师</td><td>硕士</td><td>医学影像学</td><td>2</td></tr><tr><td>放射科技师</td><td>本科</td><td>医学影像技术</td><td>1</td></tr></table></article></html>';
  const parsed = pageData(html, page.url, source);
  assert.equal(parsed.rows.length, 2);
  const physician = jobFrom(parsed.rows[0], parsed, source, config.profile, 1);
  const technician = jobFrom(parsed.rows[1], parsed, source, config.profile, 2);
  assert.equal(physician.organization, '甲医院');
  assert.equal(physician.headcount, '2');
  assert.equal(technician.role, 'technician');
  assert.equal(technician.degreeRequirement, '本科');
  const digest = planDigest([physician, technician], empty(), config, '2026-10-10');
  assert.match(renderMarkdown(digest, []), /岗位原文摘录/);
});

test('影像专业的非临床科研和教师岗位不当作影像医师推送', () => {
  assert.equal(makeJob(row.replace('放射科医师', '影像科研助理')), null);
  assert.equal(makeJob(row.replace('放射科医师', '影像教师')), null);
});

test('来源页面名称不匹配时停止采集，避免将其他学校或医院冒认为目标来源', async () => {
  const result = await collectSource({ ...source, verifyName: '测试医院' }, config, '2026-10-10', {
    request: async url => ({ bytes: Buffer.from('<html><title>另一所学校</title><body>人才招聘</body></html>'), url, type: 'text/html' }), pause: async () => {},
  });
  assert.equal(result.coverage.ok, false);
  assert.match(result.coverage.error, /名称未通过核验/);
});

test('学历和学位约束分别核验，宽学历不能覆盖博士学位或未知条件', () => {
  for (const requirement of ['学历：本科及以上；学位：博士', '学历：博士；学位：硕士及以上', '学历：硕士；学位：博士学位']) {
    const job = makeJob(row.replace('学历：硕士', requirement));
    assert.equal(job.qualificationEvidence.masters, false);
    assert.equal(job.excluded, '该岗位仅列博士学历');
    assert.equal(job.status, 'review');
  }
  for (const requirement of ['学历：研究生；学位：硕士及以上', '学历：本科及以上；学位：学士及以上', '学历学位：硕士及以上']) {
    assert.equal(makeJob(row.replace('学历：硕士', requirement)).qualificationEvidence.masters, true);
  }
  const unknown = makeJob(row.replace('学历：硕士', '学历：待核实；学位：硕士'));
  assert.equal(unknown.qualificationEvidence.masters, false);
  assert.equal(unknown.status, 'review');
  const doctoralCondition = makeJob(row.replace('学历：硕士', '学历：本科及以上').replace('2027届、规培合格、CT方向', '2027届，仅限博士'));
  assert.equal(doctoralCondition.qualificationEvidence.masters, false);
  assert.equal(doctoralCondition.excluded, '该岗位仅列博士学历');
});

test('不接收、不面向、届别除外等明确否定不被后文的2027届转为正证据', () => {
  for (const condition of ['不接收2027届；2027届博士另行安排', '不面向2027年应届毕业生', '2027届毕业生不得报名', '除2027届外的毕业生', '不含2027届', '暂不接受2027届']) {
    const job = makeJob(row.replace('2027届、规培合格、CT方向', condition));
    assert.equal(job.excluded, '届别不符', condition);
    assert.equal(job.qualificationEvidence.graduationYear, null, condition);
    assert.equal(job.status, 'review', condition);
  }
  const ambiguous = makeJob(row.replace('2027届、规培合格、CT方向', '2027届博士、2026届硕士，规培合格'));
  assert.equal(ambiguous.qualificationEvidence.graduationYear, null);
  assert.equal(ambiguous.status, 'review');
});

const aliasPair = (overrides = {}) => {
  const text = `招聘单位：甲医院；${row}`;
  const officialPage = { ...page, url: 'https://hospital.example/recruit/2027/notice-1.html', title: '甲医院2027届第一批招聘公告' };
  const repostPage = { ...page, url: 'https://university.example/portal/recruit/details?id=forwarded-2027', title: '转发：甲医院2027届第一批招聘公告' };
  const officialSource = { ...source, name: '甲医院', sourceKind: 'official-employer' };
  const repostSource = { ...source, name: '大学就业网（高校官方转发）', province: '全国', sourceKind: 'university-repost', isRepost: true };
  return {
    official: jobFrom(overrides.officialText || text, { ...officialPage, ...overrides.officialPage }, officialSource, config.profile, 1),
    repost: jobFrom(overrides.repostText || text, { ...repostPage, ...overrides.repostPage }, repostSource, config.profile, 1),
  };
};

test('不同域名的官方与高校转发同岗仅在完整强证据下归并，优先保留直接雇主且原ID不变', () => {
  const { official, repost } = aliasPair();
  assert.notEqual(official.id, repost.id);
  assert.notEqual(official.fingerprint, repost.fingerprint);
  const ranked = rankJobs([repost, official], config, '2026-10-19');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, official.id);
  assert.equal(ranked[0].url, official.url);
  assert.equal(ranked[0].province, '黑龙江');
  assert.ok(ranked[0].crossSourceAliases.some(alias => alias.id === repost.id && alias.fingerprint === repost.fingerprint));
  assert.equal(rankJobs(ranked, config, '2026-10-19').length, 1);
});

test('同码不同单位、不同轮次、不同年度或不同明确截止均不得跨源合并', () => {
  const cases = [
    { repostText: `招聘单位：乙医院；${row}` },
    { repostPage: { title: '甲医院2027届第二批招聘公告' } },
    { repostPage: { title: '甲医院2026年第一批招聘2027届毕业生公告' } },
    { repostPage: { text: '报名截止日期：2026年11月1日。' } },
    { repostText: `招聘单位：甲医院；${row.replace('放射科医师', 'CT医师')}` },
    { repostText: `招聘单位：甲医院；${row.replace('影像医学与核医学', '医学影像学')}` },
  ];
  for (const item of cases) {
    const { official, repost } = aliasPair(item);
    assert.equal(rankJobs([official, repost], config, '2026-10-19').length, 2, JSON.stringify(item));
  }
});

test('缺显式用人单位、岗位码、届别或截止的线索以及旧state不猜跨源别名', () => {
  const cases = [
    { officialText: row, repostText: row },
    { officialText: `招聘单位：甲医院；${row.replace('岗位代码：1001；', '')}`, repostText: `招聘单位：甲医院；${row.replace('岗位代码：1001；', '')}` },
    { officialText: `招聘单位：甲医院；${row.replace('2027届', '应往届')}`, repostText: `招聘单位：甲医院；${row.replace('2027届', '应往届')}` },
    { officialPage: { text: '' }, repostPage: { text: '' } },
  ];
  for (const item of cases) {
    const { official, repost } = aliasPair(item);
    assert.equal(rankJobs([official, repost], config, '2026-10-19').length, 2);
  }
  const { official, repost } = aliasPair();
  const legacy = { ...repost }; delete legacy.employerExplicit;
  assert.equal(rankJobs([official, legacy], config, '2026-10-19').length, 2);
});

test('仅转发alias或其旧ID已有同版本发送记录时，不因官方链接优先而重发', () => {
  const { official, repost } = aliasPair();
  for (const id of [repost.id, ...repost.legacyIds]) {
    const previous = { sent: { [id]: { fingerprint: repost.fingerprint } }, reminded: {} };
    assert.equal(planDigest([official, repost], previous, config, '2026-10-19').physicians.length, 0);
  }
});

test('官方条件变化必须可重发，不能被旧转发相同岗位的旧fingerprint抑制', () => {
  const before = aliasPair();
  const after = aliasPair({ officialText: `招聘单位：甲医院；${row}；工作经历：需要一年相关工作经历` });
  assert.equal(before.official.id, after.official.id);
  assert.notEqual(before.official.deliveryVersion, after.official.deliveryVersion);
  const previous = { sent: { [before.official.id]: { fingerprint: before.official.fingerprint }, [before.repost.id]: { fingerprint: before.repost.fingerprint } }, reminded: {} };
  const digest = planDigest([after.official, after.repost], previous, config, '2026-10-19');
  assert.equal(digest.physicians.length, 1);
  assert.equal(digest.physicians[0].id, after.official.id);
  assert.match(digest.physicians[0].conditionExcerpt, /一年相关工作经历/);
});

test('跨源归并不拼接资格，官方未核实学历仍为待核实而不借用转发的硕士证据', () => {
  const { official, repost } = aliasPair({ officialText: `招聘单位：甲医院；${row.replace('学历：硕士', '学历：待核实')}` });
  const ranked = rankJobs([repost, official], config, '2026-10-19');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, official.id);
  assert.equal(ranked[0].qualificationEvidence.masters, false);
  assert.equal(ranked[0].status, 'review');
});

test('跨alias截止提醒只一次，标记发送保留各原指纹并兼容仅剩转发的后续运行', () => {
  const { official, repost } = aliasPair();
  const previous = { sent: { [repost.id]: { fingerprint: repost.fingerprint } }, reminded: {} };
  const reminder = planDigest([official, repost], previous, config, '2026-10-29');
  assert.equal(reminder.reminders.length, 1);
  const original = { version: 1, jobs: {}, recipients: { person: previous } };
  const reminded = markDelivered(original, reminder, 'person', '2026-10-29');
  assert.equal(reminded.recipients.person.reminded[official.id], official.deadline);
  assert.equal(reminded.recipients.person.reminded[repost.id], repost.deadline);
  assert.equal(planDigest([repost], reminded.recipients.person, config, '2026-10-30').reminders.length, 0);
  assert.deepEqual(original.recipients.person.reminded, {});
  const first = planDigest([official, repost], empty(), config, '2026-10-19');
  const delivered = markDelivered({ version: 1, jobs: {}, recipients: {} }, first, 'person', '2026-10-19');
  assert.equal(delivered.recipients.person.sent[official.id].fingerprint, official.fingerprint);
  assert.equal(delivered.recipients.person.sent[repost.id].fingerprint, repost.fingerprint);
  assert.equal(planDigest([repost], delivered.recipients.person, config, '2026-10-20').physicians.length, 0);
});

test('旧state的历史错误资格正证据不会在来源暂不可用时继续当作已匹配岗位', () => {
  const stale = { ...makeJob(), qualificationEvidence: { masters: true, graduationYear: 2027 }, excluded: null };
  const doctoral = { ...stale, degreeRequirement: '本科及以上；博士' };
  const denied = { ...stale, conditionExcerpt: '岗位名称：CT医师；学历：硕士；条件：不接收2027届；2027届博士另行安排' };
  assert.deepEqual(rankJobs([doctoral, denied], config, '2026-10-19'), []);
  const unknown = { ...stale, degreeRequirement: '待核实' };
  assert.equal(rankJobs([unknown], config, '2026-10-19')[0].status, 'review');
});

test('真实实报中的科研岗、导师研究方向及导航栏目不会生成医师岗位', () => {
  const fixtures = [
    '招聘单位：齐齐哈尔医学院精神卫生学院；科室名称：精神卫生研究所；岗位类型：科研岗；招聘 人数：3；招聘条件：博士研究生；招聘条件：博士；招聘条件：临床医学、影像医学与核医学；招聘条件：英语四级及以上',
    '导师：马羽；专业要求：临床医学、中医、中西医结合、生物医学工程（具有磁共振研究基础优先）；研究方向：2.神经调控技术临床应用与机制研究；招聘人数：若干；招聘人数：若干',
  ];
  for (const text of fixtures) assert.equal(jobFrom(text, page, source, config.profile, 1), null);
  for (const title of ['新闻中心', '院务公开']) {
    assert.equal(jobFrom('导航包含放射影像科和医院介绍', { ...page, title }, source, config.profile), null);
  }
  const stale = { ...makeJob(), title: '新闻中心', announcementTitle: '', conditionExcerpt: '', structured: false };
  assert.deepEqual(rankJobs([stale], config, '2026-10-19'), []);
  const cachedResearch = { ...makeJob(), title: '医学影像研究方向', conditionExcerpt: fixtures[0] };
  assert.deepEqual(rankJobs([cachedResearch], config, '2026-10-19'), []);
});

test('真实手术室放射师归技师，不因要求医师资格证升级为CT医师', () => {
  const text = '部门岗位：手术室放射师；引进名额：1；专业要求：医学影像学、放射影像学；学历要求：本科及以上；其他要求：具有临床执业医师资格证；年工资收入：10-20万元';
  const job = jobFrom(text, page, source, config.profile, 1);
  assert.equal(job.role, 'technician');
  assert.match(job.conditionExcerpt, /临床执业医师资格证/);
  assert.equal(job.focusMatch, 'unknown');
  const stale = { ...job, role: 'physician' };
  const digest = planDigest([stale], empty(), config, '2026-10-19');
  assert.equal(digest.physicians.length, 0);
  assert.equal(digest.technicians.length, 1);
});

test('只有影像专业而职业不明的卫生专业技术人员只为线索，不进入医生或技师通知', () => {
  const text = '学历等级：研究生专业；专业名称：影像医学与核医学；职位名称：卫生专业技术人员；招聘人数：1';
  const job = jobFrom(text, page, source, config.profile, 1);
  assert.equal(job.role, 'clue');
  assert.equal(job.status, 'review');
  assert.match(job.requirements.join('；'), /职业类型未确认/);
  const digest = planDigest([job], empty(), config, '2026-10-19');
  assert.equal(digest.physicians.length, 0);
  assert.equal(digest.technicians.length, 0);
  assert.equal(digest.activeCount, 0);
});

test('医疗岗有影像科室与执业医师要求时保留临床证据；重复条件字段不被覆盖', () => {
  const text = '招聘单位：齐齐哈尔医学院附属第一医院；科室名称：影像科A；岗位名称：医疗岗；招聘人数：1；招聘条件：本科及以上；招聘条件：学士及以上；招聘条件：医学影像学；备注：具有执业医师资格证书、住院医师规范化培训合格证书';
  const job = jobFrom(text, page, source, config.profile, 1);
  assert.equal(job.role, 'physician');
  assert.match(job.degreeRequirement, /本科及以上；学士及以上/);
  assert.equal(job.qualificationEvidence.masters, true);
  assert.equal(job.status, 'review');
  assert.equal(job.excluded, null);
});

test('岗位行要求字段明确博士学历学位时排除，包括旧缓存漏解析的要求字段', () => {
  const text = '序号：22；科室：放射科；岗位：医生；要求：1.博士研究生学历、博士学位、影像医学与核医学专业1人；拟招聘人数：2';
  const job = jobFrom(text, page, source, config.profile, 1);
  assert.equal(job.excluded, '该岗位仅列博士学历');
  assert.deepEqual(rankJobs([{ ...job, excluded: null, degreeRequirement: '', qualificationEvidence: { masters: false, graduationYear: null } }], config, '2026-10-19'), []);
});

test('未知日期的明显旧CMS路径仅保守排除，不把URL日期编成发布日期；有效截止可保留', () => {
  const oldPage = { ...page, url: 'https://www.qmu.edu.cn/2025/0926/c5423a195562/page.htm', published: null, text: '' };
  const old = jobFrom(row, oldPage, source, config.profile, 1);
  assert.equal(old.published, null);
  assert.match(old.excluded, /URL日期明显过旧/);
  const stillOpen = jobFrom(row, { ...oldPage, text: '报名截止日期：2026年12月20日。' }, source, config.profile, 1);
  assert.equal(stillOpen.published, null);
  assert.equal(stillOpen.excluded, null);
  assert.equal(stillOpen.status, 'review');
});

test('保留原公告标题与正文限长摘录并隐藏凭据形状，发布时间有明确CMS标签才读取', () => {
  const original = { ...page, title: '测试医院2027届第一批公开招聘公告', text: `报名截止日期：2026年10月31日。API_KEY=private-token ${'正文'.repeat(800)}` };
  const job = jobFrom(row, original, source, config.profile, 1);
  assert.equal(job.announcementTitle, original.title);
  assert.notEqual(job.announcementTitle, job.title);
  assert.ok(job.announcementText.length <= 1200);
  assert.doesNotMatch(job.announcementText, /private-token/);
  const parsed = pageData('<html><h1>2027届招聘公告</h1><div class="Article_PublishDate">2026-10-17</div><article>影像医师招聘，相关岗位信息及具体报名条件详见公告。足够长的正式正文，不能使用页脚时间作为发布时间。</article></html>', page.url, source);
  assert.equal(parsed.published, '2026-10-17');
});

test('缺少内部指纹的公共投影不因undefined相等而被空发送历史误判为已发', () => {
  const projected = { ...makeJob() }; delete projected.fingerprint;
  assert.equal(planDigest([projected], empty(), config, '2026-10-19').physicians.length, 1);
});

test('玉泉真实DOM优先正文article_title，不让左侧人才招聘h1或无效meta吞掉标题日期', () => {
  const title = '清华大学玉泉医院（清华大学中西医结合医院）2027年应届生招聘公告';
  const html = `<html><head><title>${title} 人才招聘 - 清华大学玉泉医院</title><meta property="og:title" content="人才招聘"><meta name="PubDate" content="人才招聘"></head><body><h1 class="leftNavTitle" title="菜单">人才招聘</h1><h2 class="title_header">校园招聘</h2><h1 class="article_title ds"><font>${title}</font></h1><span class="time">发布时间：2026-10-17</span><article><p>2027年度应届毕业生招聘，请核对具体条件。</p><table><tr><th>招聘岗位</th><th>招聘科室</th><th>学历要求</th><th>其他要求</th></tr><tr><td>医师岗位</td><td>医技医辅系统各科室（如放射影像科、检验科、病理科等）</td><td>硕士研究生以上</td><td>规培完成优先</td></tr></table></article></body></html>`;
  const parsed = pageData(html, 'https://www.yuquanhosp.cn/Html/News/Articles/1850.html', source);
  assert.equal(parsed.title, title);
  assert.equal(parsed.published, '2026-10-17');
  const job = jobFrom(parsed.rows[0], parsed, source, config.profile, 1);
  assert.equal(job.role, 'physician');
  assert.equal(job.announcementTitle, title);
  assert.equal(job.excluded, null);
});

test('全页仍为通用栏目标题时，明确结构化临床行可保留，但导航与导师表仍不能生成岗位', () => {
  const generic = { ...page, title: '人才招聘' };
  const physician = jobFrom('招聘岗位：医师岗位；招聘科室：放射影像科；学历要求：硕士研究生以上', generic, source, config.profile, 1);
  assert.equal(physician.role, 'physician');
  assert.equal(physician.excluded, null);
  assert.equal(jobFrom('专业要求：生物医学工程、磁共振；导师：马羽；研究方向：神经调控机制', generic, source, config.profile, 1), null);
  assert.equal(jobFrom('导航里的医学影像专业和医院介绍', generic, source, config.profile), null);
});

test('高校官方转发仅从严格医院招聘标题展示雇主，不将其变成岗位行显式单位或猜省份', () => {
  const publisher = { ...source, name: '吉林大学就业网（高校官方转发）', province: '全国', isRepost: true, sourceKind: 'university-repost' };
  const fixtures = [
    ['山西省运城市中心医院招聘简章（吉林大学专场宣讲会）', '山西省运城市中心医院'],
    ['【暖心送岗】广州医科大学附属第一医院2026年度人才招聘简章', '广州医科大学附属第一医院'],
    ['清华大学第一附属医院2026年校园招聘', '清华大学第一附属医院'],
  ];
  for (const [title, expected] of fixtures) {
    const job = jobFrom(row, { ...page, title }, publisher, config.profile, 1);
    assert.equal(job.organization, expected);
    assert.equal(job.employerExplicit, '');
    assert.equal(job.province, '全国');
    assert.equal(job.sourceName, publisher.name);
  }
  for (const title of ['关于甲医院和乙医院招聘汇总', '平台汇总甲医院2027年招聘', '高校医院招聘信息', '2027年多家医院招聘信息']) {
    const job = jobFrom(row, { ...page, title }, publisher, config.profile, 1);
    assert.equal(job.organization, `${publisher.name}发布（单位见公告）`, title);
  }
  assert.equal(jobFrom(row, { ...page, title: fixtures[0][0] }, source, config.profile, 1).organization, source.name);
});

test('吉林就业网明确英文发布时间按实际日期解析，不把宣讲时间或文章年份猜成发布日期', () => {
  const examples = [
    ['发布时间：Dec 11, 2025 11:57:11 AM 点击量：', '2025-12-11'],
    ['发布时间：Jan 12, 2026 2:14:39 PM 点击量：', '2026-01-12'],
    ['发布时间：Nov 25, 2025 9:45:12 AM 点击量：', '2025-11-25'],
    ['Published on October 17, 2026', '2026-10-17'],
  ];
  for (const [text, expected] of examples) {
    assert.equal(publicationDateFromText(text), expected);
    const parsed = pageData(`<html><h1>医院2027年招聘公告</h1><article>${text}<p>相关专业包括医学影像学。报名条件与岗位要求详见本公告正文，日期按官网实际发布时间核对。</p></article></html>`, page.url, source);
    assert.equal(parsed.published, expected);
  }
  assert.equal(publicationDateFromText('招聘时间：Dec 11, 2025 11:57:11 AM'), null);
  assert.equal(publicationDateFromText('发布时间：Feb 30, 2026'), null);
});

test('玉泉已观察到的article_cont/zoom容器用于正文，不将导航截成公告摘录', () => {
  const html = '<html><body><div class="article_left">首页菜单 医院介绍 医学影像导航 并非招聘内容</div><h1 class="article_title">2027年应届生招聘公告</h1><span>发布时间：2026-10-17</span><div id="zoom" class="article_cont">根据事业单位公开招聘规定，拟公开招聘事业编制工作人员。一、申报条件：2027年度应届毕业生，具体岗位的学历、专业、规培及其他条件均以本篇正式招聘公告为准。</div></body></html>';
  const parsed = pageData(html, page.url, source);
  assert.match(parsed.text, /^根据事业单位公开招聘规定/);
  assert.doesNotMatch(parsed.text, /首页菜单|医学影像导航/);
});
