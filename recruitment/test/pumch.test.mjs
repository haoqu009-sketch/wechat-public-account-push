import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPumchSource } from '../pumch.mjs';
import { planDigest, renderMarkdown } from '../core.mjs';

const source = { name: '北京协和医院', province: '北京', url: 'https://jobs.pumch.cn/', allowedHosts: ['jobs.pumch.cn'], maxApiPages: 1 };
const config = { lookbackDays: 90, profile: { graduationYear: 2027 }, maxPhysicians: 5, maxTechnicians: 2, maxReminders: 3, reminderDays: 3 };
const notice = { jobId: 'public-notice', jobName: '2027年毕业生招聘', require: '<p>本公告包含多个科室，某科研岗位仅招博士；各岗位条件以岗位表为准。</p>', upTime: '2026-10-15', timeEnd: '2026-10-30' };
const position = { positionId: 'ct-master', jobPosition: '医师', department: '放射科', specialtyNorm: '医学影像学', educationNorm: '硕士', otherNorm: '2027届，规培完成', number: 1 };
const requestFor = (rows, positions, overrides = {}) => async (address, hosts) => {
  assert.deepEqual(hosts, source.allowedHosts);
  const url = new URL(address);
  let payload;
  if (url.pathname.endsWith('/list')) {
    assert.equal(url.searchParams.get('pageSize'), '10');
    payload = { code: 200, total: rows.length, rows, ...overrides.list };
  } else {
    assert.equal(url.pathname, '/prod-api/api/v1/job/getJobInfo');
    assert.equal(url.searchParams.get('jobId'), notice.jobId);
    assert.equal(url.searchParams.get('type'), '');
    payload = { code: 200, data: { thrJobinfo: { ...notice, ...overrides.notice }, thrJobpositionList: positions }, ...overrides.detail };
  }
  return { bytes: Buffer.from(JSON.stringify(payload)), url: address, type: 'application/json' };
};
const options = request => ({ request, pause: async () => {} });

test('真实岗位单独筛选，保留公开详情路由和API发布日期截止日期', async () => {
  const positions = [position, { ...position, positionId: 'nurse', department: '护理部', jobPosition: '护士', specialtyNorm: '护理学' }];
  const result = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], positions)));
  assert.equal(result.coverage.ok, true);
  assert.equal(result.jobs.length, 1);
  const job = result.jobs[0];
  assert.equal(job.title, '放射科｜医师｜医学影像学');
  assert.equal(job.degreeRequirement, '硕士');
  assert.equal(job.excluded, null);
  assert.equal(job.url, 'https://jobs.pumch.cn/page/search-detail?jobId=public-notice');
  assert.equal(job.published, '2026-10-15');
  assert.equal(job.deadline, '2026-10-30');
  assert.equal(job.announcementTitle, notice.jobName);
  assert.match(job.announcementText, /某科研岗位仅招博士/);
  const report = renderMarkdown(planDigest(result.jobs, { sent: {}, reminded: {} }, config, '2026-10-19'), [result.coverage]);
  assert.match(report, /所属公告：2027年毕业生招聘/);
  assert.match(report, /公告正文摘录（非完整原文）：.*某科研岗位仅招博士/);
  assert.ok(job.requirements.includes('另需核对整篇公告中的统一报名资格与届别限制'));
  assert.deepEqual(result.observedPages, [job.url]);
});

test('不透明学历代码保留待核对，不擅自标为硕士或博士', async () => {
  const result = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [{ ...position, educationNorm: '4B6B3060-C858-48FF-9432-9C98F0DA00AE' }])));
  assert.equal(result.jobs[0].degreeRequirement, '');
  assert.match(result.jobs[0].requirements.join('；'), /学历字段为代码/);
  assert.equal(result.jobs[0].status, 'review');
});

test('博士专用和已截止岗位仍由统一摘要计划排除', async () => {
  const result = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [position, { ...position, positionId: 'doctor', educationNorm: '博士' }], { notice: { timeEnd: '2026-10-18' } })));
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs.find(job => job.degreeRequirement === '博士').excluded, '该岗位仅列博士学历');
  const digest = planDigest(result.jobs, { sent: {}, reminded: {} }, config, '2026-10-19');
  assert.equal(digest.activeCount, 0);
});

test('JSON/业务状态/列表或详情结构异常不能算来源检查成功', async () => {
  const cases = [
    async () => ({ bytes: Buffer.from('<html>error</html>') }),
    requestFor([notice], [position], { list: { code: 401 } }),
    requestFor([notice], [position], { list: { rows: {} } }),
    requestFor([notice], [position], { detail: { data: { thrJobinfo: notice } } }),
  ];
  for (const request of cases) {
    const result = await collectPumchSource(source, config, '2026-10-19', options(request));
    assert.equal(result.coverage.ok, false);
    assert.ok(result.coverage.error);
    assert.deepEqual(result.observedPages, []);
  }
});

test('有界分页必须明示历史未完全覆盖', async () => {
  const result = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [position], { list: { total: 717 } })));
  assert.equal(result.coverage.ok, true);
  assert.match(result.coverage.warnings.join('；'), /717篇.*未覆盖全部历史/);
});

test('API截止日期变更进入指纹；无效日期不伪造为有效日期', async () => {
  const first = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [position])));
  const changed = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [position], { notice: { timeEnd: '2026-11-01' } })));
  assert.equal(first.jobs[0].id, changed.jobs[0].id);
  assert.notEqual(first.jobs[0].fingerprint, changed.jobs[0].fingerprint);
  const invalid = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [position], { notice: { timeEnd: '2026-02-31' } })));
  assert.equal(invalid.jobs[0].deadline, null);
});

test('岗位明确截止日期优先，未单列截止的另一岗位使用公告统一截止', async () => {
  const positions = [
    { ...position, otherNorm: '2027届；报名截止日期：2026年10月25日' },
    { ...position, positionId: 'ct-master-2' },
  ];
  const result = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], positions)));
  assert.equal(result.coverage.ok, true);
  assert.deepEqual(result.jobs.map(job => job.deadline), ['2026-10-25', '2026-10-30']);
});

test('没有岗位单独截止或API统一截止时，回退到公告正文的明确报名截止', async () => {
  const result = await collectPumchSource(source, config, '2026-10-19', options(requestFor([notice], [position], {
    notice: { timeEnd: null, require: '<p>统一报名截止时间：2026年10月29日。</p>' },
  })));
  assert.equal(result.jobs[0].deadline, '2026-10-29');
});
