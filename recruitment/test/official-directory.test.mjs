import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryNotices, selectDirectoryNotices } from '../official-directory.mjs';
import { collectSource } from '../collector.mjs';
import { readFile } from 'node:fs/promises';

const source = { name: '全市官方目录', type: 'official-directory', url: 'https://city.example/notices', entryUrls: ['https://city.example/health'], allowedHosts: ['city.example'], isListing: true };
const config = { profile: { graduationYear: 2027, degree: '硕士' }, lookbackDays: 90 };
const reply = (url, text) => ({ url, bytes: Buffer.from(text), type: 'text/html' });
const article = '<body><h1>2027年度医学影像医师招聘公告</h1><article>发布日期：2026年10月19日。招聘对象：2027届。<table><tr><th>单位名称</th><th>岗位名称</th><th>学历</th><th>专业</th></tr><tr><td>全市新发现医院</td><td>放射科医师</td><td>硕士</td><td>医学影像学</td></tr></table></article></body>';

test('区域目录发现校园引才，不把笔试面试、报名指引、附件或任意外链作为新公告', () => {
  const labels = ['2026年度人才周校园引才活动公告', '2027年医院招聘公告', '2027年医院招聘进入面试人员公告', '2027年招聘笔试公告', '2027年招聘报名操作指导', '2027年招聘会通知'];
  const html = labels.map((title, i) => `<a href="/${i}">${title}</a>`).join('')
    + '<a href="https://evil.example/">2027年招聘公告</a><a href="/jobs.xlsx">2027年招聘岗位表</a>';
  assert.deepEqual(directoryNotices(html, source.url, source.allowedHosts).map(item => item.url), ['https://city.example/0', 'https://city.example/1']);
});

test('相关度优先与轮转并存，不因固定前12篇长期遗漏其他单位；每轮仍最多12篇', () => {
  const all = Array.from({ length: 32 }, (_, i) => ({ url: `https://city.example/${i}`, title: `${i === 31 ? '2027年医院医学影像' : '2026年事业单位'}招聘公告${i}` }));
  const seen = new Set();
  for (let round = 0; round < 8; round++) {
    const selected = selectDirectoryNotices(all, '2026-10-20', round * 14_400_000);
    assert.equal(selected.length, 12); assert.equal(selected[0].url, all[31].url);
    selected.forEach(item => seen.add(item.url));
  }
  assert.equal(seen.size, 32);
});

test('多个官方目录入口共享robots与相同公告，新增雇主直接走原生岗位行解析', async () => {
  const calls = [];
  const result = await collectSource(source, config, '2026-10-20', { pause: async () => {}, request: async url => {
    calls.push(url);
    return reply(url, url.endsWith('robots.txt') ? 'User-agent: *\nDisallow: /private/' : url.endsWith('/job') ? article : '<html><a href="/job">2027年度医学影像医师招聘公告</a><a href="http://city.example/insecure">2027年招聘公告</a></html>');
  } });
  assert.equal(result.coverage.ok, true);
  assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].employerExplicit, '全市新发现医院');
  assert.equal(calls.filter(url => url.endsWith('robots.txt')).length, 1);
  assert.equal(calls.filter(url => url.endsWith('/job')).length, 1);
  assert.ok(!calls.some(url => url.startsWith('http:')));
});

test('新目录遵守robots，403不重试同主机，返回失败不等于没有岗位', async () => {
  for (const mode of ['robots', '403']) {
    const calls = [];
    const result = await collectSource(source, config, '2026-10-20', { pause: async () => {}, request: async url => {
      calls.push(url);
      if (url.endsWith('robots.txt')) return reply(url, mode === 'robots' ? 'User-agent: *\nDisallow: /' : '');
      throw new Error('HTTP 403');
    } });
    assert.equal(result.coverage.ok, false); assert.equal(result.jobs.length, 0);
    assert.ok(calls.length <= 2);
    assert.match(result.coverage.error, mode === 'robots' ? /robots/ : /403/);
  }
});

test('单入口故障不会掩盖同源其他已批准入口，保留明确覆盖告警', async () => {
  const result = await collectSource(source, config, '2026-10-20', { pause: async () => {}, request: async url => {
    if (url === source.url) throw new Error('HTTP 502');
    return reply(url, url.endsWith('robots.txt') ? '' : url.endsWith('/job') ? article : '<html><a href="/job">2027年度医学影像医师招聘公告</a></html>');
  } });
  assert.equal(result.coverage.ok, true); assert.equal(result.jobs.length, 1);
  assert.match(result.coverage.warnings.join('；'), /目录入口读取失败.*502/);
});

test('新增区域是原始官方发布目录，不将高校转载或聚合平台一并提升信任', async () => {
  const saved = JSON.parse(await readFile(new URL('../config.json', import.meta.url)));
  const directories = saved.sources.filter(item => item.type === 'official-directory');
  assert.equal(directories.length, 7);
  for (const item of directories) {
    assert.ok(item.isListing && item.verifyName);
    for (const url of [item.url, ...(item.entryUrls || [])]) {
      assert.equal(new URL(url).protocol, 'https:');
      assert.ok(item.allowedHosts.includes(new URL(url).hostname));
    }
  }
  assert.equal(saved.sources.find(item => item.id === 'jlu-medical').isRepost, true);
  assert.equal(saved.sources.find(item => item.id === 'national-health-recruitment').isRepost, true);
});
