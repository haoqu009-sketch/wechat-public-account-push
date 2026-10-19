import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectSource } from '../collector.mjs';
import { collectPumchSource } from '../pumch.mjs';

const config = { lookbackDays: 90, profile: { graduationYear: 2027 } };
const source = { name: '测试医院', province: '黑龙江', url: 'https://hospital.example/recruit/', isListing: true, allowedHosts: ['hospital.example'] };
const articleUrl = 'https://hospital.example/jobs/2027';
const noPause = async () => {};
const article = (published, deadline = '') => `<html><h1>2027届影像医师招聘公告</h1><article>${published ? `发布日期：${published}。` : ''}${deadline ? `报名截止日期：${deadline}。` : ''}<table><tr><th>岗位名称</th><th>学历</th><th>条件</th></tr><tr><td>放射科医师</td><td>硕士</td><td>2027届</td></tr></table></article></html>`;
const collectHtml = async (html, options = {}) => {
  const requested = [];
  const request = async (url, hosts) => {
    requested.push(url);
    assert.deepEqual(hosts, source.allowedHosts);
    assert.ok([source.url, articleUrl].includes(url));
    return { bytes: Buffer.from(url === source.url ? `<html><a href="${articleUrl}">2027届影像医师招聘公告</a></html>` : html), url, type: 'text/html;charset=utf-8' };
  };
  return { ...await collectSource(source, config, '2026-10-19', { request, pause: noPause, ...options }), requested };
};

test('新增九个官方招聘栏目有准确HTTPS主机，大学转发不冒充吉林雇主', async () => {
  const saved = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
  const ids = ['qmu', 'hlj-hospital', 'hlj-infectious', 'lnpatcm', 'jlu-medical', 'tsinghua-yuquan', 'china-japan-friendship', 'tianjin-first-center', 'shandong-provincial'];
  assert.equal(new Set(saved.sources.map(item => item.id)).size, saved.sources.length);
  for (const id of ids) {
    const item = saved.sources.find(candidate => candidate.id === id);
    assert.ok(item, id);
    assert.equal(new URL(item.url).protocol, 'https:');
    assert.equal(item.isListing, true);
    assert.ok(item.verifyName);
    assert.ok(item.allowedHosts.includes(new URL(item.url).hostname));
    assert.ok(item.allowedHosts.every(host => !host.includes('*') && !host.includes(':') && !host.includes('/')));
  }
  const forwarded = saved.sources.find(item => item.id === 'jlu-medical');
  assert.equal(forwarded.isRepost, true);
  assert.equal(forwarded.sourceKind, 'university-repost');
  assert.equal(forwarded.province, '全国');
  assert.equal(forwarded.publisherProvince, '吉林');
  assert.match(forwarded.name, /高校官方转发/);
  assert.deepEqual(saved.sources.find(item => item.id === 'hlj-hospital').allowedHosts, ['www.hljsyy.org.cn', 'omo-oss-file110.thefastfile.com']);
});

test('旧公告超过90天但明确报名未截止，仍读取岗位且不伪造新发布日期', async () => {
  const result = await collectHtml(article('2026年07月16日', '2026年12月20日'));
  assert.equal(result.coverage.ok, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].published, '2026-07-16');
  assert.equal(result.jobs[0].deadline, '2026-12-20');
  assert.deepEqual(result.observedPages, [articleUrl]);
});

test('旧公告只有岗位单独列出的有效截止时也不丢弃其他岗位级证据', async () => {
  const html = article('2026年07月16日', '2026年08月20日').replace('<td>2027届</td>', '<td>2027届；报名截止日期：2026年12月20日</td>');
  const result = await collectHtml(html);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].deadline, '2026-12-20');
});

test('旧公告已截止或只有长期招聘字样，不能绕过发布时间过滤', async () => {
  for (const html of [article('2026年07月16日', '2026年10月18日'), article('2026年07月16日').replace('</article>', '长期招聘，招满即止。</article>')]) {
    const result = await collectHtml(html);
    assert.equal(result.coverage.ok, true);
    assert.equal(result.coverage.articles, 1);
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.observedPages, [articleUrl]);
  }
});

test('未识别发布日期仍保留null与告警，不借新来源伪造为当天公告', async () => {
  const result = await collectHtml(article(null, '2026年12月20日'));
  assert.equal(result.jobs[0].published, null);
  assert.match(result.coverage.warnings.join('；'), /未识别发布日期/);
});

test('来源附件403保留缺口，不降级HTTP、不换域名或UA重试', async () => {
  const attachment = 'https://hospital.example/jobs.xlsx';
  const requested = [];
  const request = async url => {
    requested.push(url);
    if (url === attachment) throw new Error('HTTP 403');
    return { bytes: Buffer.from(url === source.url ? `<html><a href="${articleUrl}">2027届招聘公告</a></html>` : article('2026年10月18日').replace('2027届影像医师招聘公告', '2027届工作人员招聘公告').replace(/<table>[\s\S]*?<\/table>/, `<a href="${attachment}">招聘计划.xlsx</a>`)), url, type: 'text/html' };
  };
  const result = await collectSource(source, config, '2026-10-19', { request, pause: noPause });
  assert.equal(requested.filter(url => url === attachment).length, 1);
  assert.equal(result.jobs.length, 0);
  assert.match(result.coverage.warnings.join('；'), /岗位表附件未完成：HTTP 403/);
  assert.deepEqual(result.observedPages, []);
});

test('协和列表的明确未来截止允许旧公告进详情，过去/无效截止仍跳过', async () => {
  const apiSource = { name: '北京协和医院', province: '北京', url: 'https://jobs.pumch.cn/', allowedHosts: ['jobs.pumch.cn'], maxApiPages: 1 };
  for (const [deadline, expected] of [['2026-12-20', 1], ['2026-10-18', 0], [null, 0], ['2026-02-31', 0]]) {
    const notice = { jobId: 'old-open-notice', jobName: '2027年毕业生招聘', upTime: '2026-07-16', timeEnd: deadline, require: '<p>各岗位条件以岗位表为准。</p>' };
    let details = 0;
    const request = async address => {
      const url = new URL(address);
      let payload;
      if (url.pathname.endsWith('/list')) payload = { code: 200, total: 1, rows: [notice] };
      else {
        details++;
        payload = { code: 200, data: { thrJobinfo: notice, thrJobpositionList: [{ positionId: 'ct-2027', jobPosition: '医师', department: '放射科', specialtyNorm: '医学影像学', educationNorm: '硕士', otherNorm: '2027届', number: 1 }] } };
      }
      return { bytes: Buffer.from(JSON.stringify(payload)), url: address, type: 'application/json' };
    };
    const result = await collectPumchSource(apiSource, config, '2026-10-19', { request, pause: noPause });
    assert.equal(result.coverage.ok, true);
    assert.equal(details, expected);
    assert.equal(result.jobs.length, expected);
    if (expected) {
      assert.equal(result.jobs[0].published, '2026-07-16');
      assert.equal(result.jobs[0].deadline, deadline);
    }
  }
});

test('新增来源仍受四目录和十二篇公告上限约束', async () => {
  let indexes = 0, articles = 0;
  const request = async url => {
    const isArticle = url.includes('/article/');
    if (isArticle) articles++; else indexes++;
    const html = isArticle ? article('2026年10月18日') : `<html>${Array.from({ length: 20 }, (_, i) => `<a href="/article/${i}">2027届第${i}批招聘公告</a>`).join('')}${Array.from({ length: 10 }, (_, i) => `<a href="/listing/${i}">人才招聘</a>`).join('')}</html>`;
    return { bytes: Buffer.from(html), url, type: 'text/html' };
  };
  const result = await collectSource(source, config, '2026-10-19', { request, pause: noPause });
  assert.equal(result.coverage.ok, true);
  assert.equal(indexes, 4);
  assert.equal(articles, 12);
});
