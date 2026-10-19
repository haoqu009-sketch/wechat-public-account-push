import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncHandler, createSyncServer, validatePublicReport } from '../site-server.mjs';
import { createPublicReport } from '../public-report.mjs';

const TOKEN = 'test-only-token-with-more-than-32-characters';
const config = { profile: { graduationYear: 2027, preferredProvince: '黑龙江' }, sources: [{ id: 'hospital', name: '测试医院', province: '黑龙江', url: 'https://hospital.example/' }] };
const report = (generatedAt = '2026-10-19T01:00:00.000Z') => createPublicReport({
  jobs: [], digest: { today: '2026-10-19', physicians: [], technicians: [], reminders: [] },
  coverage: [{ name: '测试医院', ok: true, articles: 1, warnings: [] }], config, generatedAt,
});
const start = async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-site-test-'));
  const dataDir = path.join(directory, 'dedicated-data');
  const logs = [];
  const server = createSyncServer({ token: TOKEN, dataDir, logger: line => logs.push(line) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const post = (payload, headers = {}, pathname = '/api/sync') => fetch(`${address}${pathname}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { address, dataDir, directory, logs, post };
};

test('配置必须提供至少32字符token与专用绝对目录，导入不会监听', () => {
  for (const token of [undefined, '', 'short', ` ${TOKEN}`]) assert.throws(() => createSyncHandler({ token, dataDir: path.resolve('site-data') }), /SYNC_TOKEN_REQUIRED/);
  for (const dataDir of [undefined, '', 'relative/data', path.parse(process.cwd()).root]) assert.throws(() => createSyncHandler({ token: TOKEN, dataDir }), /SYNC_DATA_DIRECTORY_REQUIRED/);
  const server = createSyncServer({ token: TOKEN, dataDir: path.resolve('site-data') });
  assert.equal(server.listening, false);
});

test('真实公共导出契约可同步，快照与latest完整一致，数据只落在指定目录', async t => {
  const service = await start(t), data = report();
  const response = await service.post(data);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reportId: data.reportId, ok: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(service.dataDir, 'public.json'), 'utf8')), data);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(service.dataDir, `${data.reportId}.json`), 'utf8')), data);
  assert.deepEqual((await fs.readdir(service.dataDir)).sort(), [`${data.reportId}.json`, 'public.json'].sort());
  assert.deepEqual(await fs.readdir(service.directory), ['dedicated-data']);
  assert.deepEqual(service.logs, []);
});

test('无认证、非法方法和任意文件读取均拒绝，不创建数据目录', async t => {
  const service = await start(t), data = report();
  assert.equal((await service.post(data, { Authorization: '' })).status, 401);
  assert.equal((await service.post(data, { Authorization: `Bearer wrong-${TOKEN}` })).status, 401);
  const method = await fetch(`${service.address}/api/sync`);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  for (const pathname of ['/data/public.json', '/public.json', '/api/sync?token=private', '/api/other']) {
    assert.equal((await fetch(`${service.address}${pathname}`)).status, 404);
  }
  await assert.rejects(fs.stat(service.dataDir), { code: 'ENOENT' });
  assert.deepEqual(service.logs, []);
});

test('敏感或未知字段、坏日期和计数、URL凭据被拒绝，错误不回显输入', async t => {
  const service = await start(t);
  const cases = [
    data => { data.state = { token: TOKEN }; },
    data => { data.recipients = ['private-openid']; },
    data => { data.summary.token = TOKEN; },
    data => { data.sources[0].secret = TOKEN; },
    data => { data.reportId = '../outside-private'; },
    data => { data.reportId = [data.reportId]; },
    data => { data.generatedAt = 'invalid-date'; },
    data => { data.generatedAt = '2026-10-18T01:00:00.000Z'; },
    data => { data.reportDate = '2026-02-31'; },
    data => { data.summary.activeCount = 1; },
    data => { data.sources[0].url = 'https://username:private@hospital.example/'; },
    data => { data.sources[0].url = 'https://hospital.example/?access_token=private'; },
    data => { data.sources[0].url = 'http://hospital.example/'; },
  ];
  for (const mutate of cases) {
    const data = report(); mutate(data);
    const response = await service.post(data);
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.doesNotMatch(body, /private|openid|username|test-only/);
    assert.deepEqual(JSON.parse(body), { ok: false, error: 'INVALID_SCHEMA' });
  }
  await assert.rejects(fs.stat(service.dataDir), { code: 'ENOENT' });
  assert.deepEqual(service.logs, []);
});

test('非JSON、损坏JSON与超过2MB的正文拒绝', async t => {
  const service = await start(t);
  assert.equal((await service.post(report(), { 'Content-Type': 'text/plain' })).status, 415);
  const broken = await service.post('{"secret":"private"');
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { ok: false, error: 'INVALID_JSON' });
  const oversized = await service.post('x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
  await assert.rejects(fs.stat(service.dataDir), { code: 'ENOENT' });
});

test('无Content-Length的分块请求同样受到2MB硬限制', async t => {
  const service = await start(t);
  const result = await new Promise((resolve, reject) => {
    const request = http.request(`${service.address}/api/sync`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('error', reject);
    for (let index = 0; index < 9; index++) request.write(Buffer.alloc(256 * 1024, 120));
    request.end();
  });
  assert.equal(result.status, 413);
  assert.deepEqual(JSON.parse(result.body), { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  await assert.rejects(fs.stat(service.dataDir), { code: 'ENOENT' });
});

test('同ID同内容语义幂等、同ID改内容冲突，旧时间不覆盖latest', async t => {
  const service = await start(t), first = report(), second = report('2026-10-19T02:00:00.000Z');
  assert.equal((await service.post(first)).status, 200);
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal((await service.post(reordered)).status, 200);
  const changed = structuredClone(first);
  changed.sources[0].articles = 2;
  assert.equal((await service.post(changed)).status, 409);
  assert.equal((await service.post(second)).status, 200);
  assert.equal((await service.post(first)).status, 200); // Retry an old successful delivery without moving latest backwards.
  const olderUnseen = report('2026-10-19T00:00:00.000Z');
  assert.equal((await service.post(olderUnseen)).status, 409);
  assert.equal(JSON.parse(await fs.readFile(path.join(service.dataDir, 'public.json'), 'utf8')).reportId, second.reportId);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(service.dataDir, `${first.reportId}.json`), 'utf8')), first);
  await assert.rejects(fs.stat(path.join(service.dataDir, `${olderUnseen.reportId}.json`)), { code: 'ENOENT' });
});

test('并发入队后最新时间胜出，同一时间不同报告不替换已发布数据', async t => {
  const service = await start(t);
  const items = ['04', '02', '03', '01'].map(hour => report(`2026-10-19T${hour}:00:00.000Z`));
  const responses = await Promise.all(items.map(item => service.post(item)));
  assert.ok(responses.every(response => [200, 409].includes(response.status)));
  const latest = JSON.parse(await fs.readFile(path.join(service.dataDir, 'public.json'), 'utf8'));
  assert.equal(latest.reportId, items[0].reportId);
  const collision = structuredClone(items[0]);
  collision.reportId = 'f'.repeat(24);
  collision.sources[0].articles = 2;
  assert.equal((await service.post(collision)).status, 409);
  assert.equal(JSON.parse(await fs.readFile(path.join(service.dataDir, 'public.json'), 'utf8')).reportId, items[0].reportId);
  assert.ok((await fs.readdir(service.dataDir)).every(name => /^(?:[a-f0-9]{24}|public)\.json$/.test(name)));
});

test('存储失败仅返回安全错误；损坏latest不会被静默覆盖', async t => {
  const service = await start(t), data = report();
  await fs.mkdir(service.dataDir);
  await fs.writeFile(path.join(service.dataDir, 'public.json'), '{"token":"private"');
  const response = await service.post(data);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'STORAGE_UNAVAILABLE' });
  assert.equal(await fs.readFile(path.join(service.dataDir, 'public.json'), 'utf8'), '{"token":"private"');
  assert.deepEqual(service.logs, ['Recruitment site sync storage/request failure.']);
  assert.doesNotMatch(service.logs.join(''), /private|test-only|token/i);
});

test('岗位字段严格白名单及URL验证覆盖真实非空岗位导出', () => {
  const data = report();
  data.jobs = [{
    id: 'job', title: 'CT医师', organization: '测试医院', sourceName: '测试医院', province: '黑龙江', role: 'physician', status: 'review',
    priorityLabel: '待核实线索', focusMatch: 'ct', directionLabel: 'CT方向', qualityReasons: ['具体岗位明确涉及CT'], degreeRequirement: '硕士',
    specialtyRequirement: '医学影像学', headcount: '1', conditionExcerpt: '', announcementTitle: '', announcementText: '', matches: ['CT'], requirements: ['届别待核对'],
    structured: true, url: 'https://hospital.example/job?id=1', published: '2026-10-18', deadline: null, collectedAt: '2026-10-19', sourceHealthy: true, stale: false, isNew: true, isReminder: false,
  }];
  data.summary.activeCount = data.summary.newCount = data.summary.physicianCount = 1;
  assert.equal(validatePublicReport(data), data);
  for (const mutation of [job => { job.openId = 'private'; }, job => { job.url = 'https://u:private@hospital.example/'; }, job => { job.url = 'https://hospital.example/?token=private'; }]) {
    const changed = structuredClone(data); mutation(changed.jobs[0]);
    assert.throws(() => validatePublicReport(changed), error => error.status === 400 && error.code === 'INVALID_SCHEMA');
  }
});
