import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { safeUrl, datesIn, extractDeadline, pageData, jobFrom, planDigest, markDelivered, renderMarkdown, wechatData } from '../core.mjs';
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
  jobs.push({ ...makeJob(), id: 'tech', role: 'technician' }, { ...makeJob(), id: 'expired', deadline: '2026-10-01' });
  const digest = planDigest(jobs, empty(), config, '2026-10-10');
  assert.equal(digest.physicians.length, 5);
  assert.equal(digest.physicians[0].id, '7');
  assert.equal(digest.technicians.length, 1);
  assert.ok(!digest.physicians.some(job => job.id === 'expired'));
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
